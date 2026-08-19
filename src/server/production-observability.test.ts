import { describe, expect, it } from 'vitest';
import type { LyricsPayload } from '../shared/contracts.js';
import { ProductionObservability } from './production-observability.js';

const synced: LyricsPayload = {
  kind: 'synced',
  lines: [{ id: '1', startMs: 0, text: 'line' }],
  provider: 'apple',
};

describe('ProductionObservability', () => {
  it('keeps fixed-cardinality lyrics, stream, telemetry, and timeline counters', () => {
    let nowMs = 1_800_000_000_000;
    const logs: string[] = [];
    const observability = new ProductionObservability({
      now: () => nowMs,
      log: (message) => logs.push(message),
      logIntervalMs: 1_000,
    });
    observability.setEnabled(true);

    observability.observeLyricsStart();
    observability.observeLyricsResult(synced, 120);
    observability.observeLyricsResult({
      kind: 'missing',
      lines: [],
      provider: null,
      retryable: true,
    }, 250);
    observability.observeLyricsVersionTransition('replaced');
    observability.observeStaleLyricsResult('generation');

    observability.openSse();
    observability.observeSseSnapshot();
    observability.observeSseHeartbeat();
    observability.observeSseBackpressure(8_192);
    observability.observeSseSnapshotCoalesced();
    observability.observeSseHeartbeatSkipped();
    observability.observeSseWriteError();
    observability.closeSse(400);

    observability.observeTelemetryMessage('routed', 'MediaNowPlayingElapsed');
    nowMs += 1_000;
    observability.observeTelemetryMessage('routed', 'MediaNowPlayingElapsed');
    observability.observeTelemetryMessage('unknown-topic');
    observability.observeTelemetryMessage('unrouted');
    observability.observeTelemetryConnectivityChange(true);
    observability.observeTelemetryConnectivityChange(false);

    observability.observeAppleTimeline('valid', null);
    observability.observeAppleTimeline('repaired', 'collapsed-timeline-coverage');
    observability.observeAppleTimeline('rejected', 'timestamp-duration-overrun', 12_000);

    expect(observability.snapshot()).toMatchObject({
      lyrics: {
        requests: 1,
        completed: 2,
        retryable: 1,
        sources: { apple: 1, none: 1 },
        kinds: { synced: 1, missing: 1 },
        versionTransitions: { replaced: 1 },
        staleResults: { generation: 1 },
      },
      sse: {
        active: 0,
        opened: 1,
        closed: 1,
        snapshots: 1,
        heartbeatWrites: 1,
        backpressureEvents: 1,
        coalescedSnapshots: 1,
        skippedHeartbeats: 1,
        maxBufferedBytes: 8_192,
        writeErrors: 1,
      },
      telemetry: {
        messages: 4,
        routedMessages: 2,
        unknownTopics: 1,
        unroutedMessages: 1,
        elapsedSamples: 2,
        connectivityChanges: 1,
      },
      appleTimeline: {
        valid: 1,
        repaired: 1,
        rejected: 1,
        largestOverrunMs: 12_000,
        anomalies: {
          'collapsed-timeline-coverage': 1,
          'timestamp-duration-overrun': 1,
        },
      },
    });
    expect(logs).toHaveLength(5);
  });

  it('does not emit logs when production logging is disabled', () => {
    const logs: string[] = [];
    const observability = new ProductionObservability({ log: (message) => logs.push(message) });
    observability.observeLyricsResult({ kind: 'missing', lines: [], provider: null }, 1);
    observability.observeTelemetryMessage('unknown-topic');
    observability.observeSseWriteError();
    expect(logs).toEqual([]);
  });

  it('bounds repeated diagnostics to one event per key and interval', () => {
    let nowMs = 1_800_000_000_000;
    const logs: string[] = [];
    const observability = new ProductionObservability({
      now: () => nowMs,
      log: (message) => logs.push(message),
      logIntervalMs: 1_000,
    });
    observability.setEnabled(true);

    observability.observeLyricsResult({
      kind: 'missing',
      lines: [],
      provider: null,
    }, 1);
    observability.observeLyricsResult({
      kind: 'missing',
      lines: [],
      provider: null,
    }, 1);
    observability.observeSseWriteError();
    observability.observeSseWriteError();

    expect(logs).toHaveLength(2);
    expect(observability.snapshot()).toMatchObject({
      logsEmitted: 2,
      logsSuppressed: 2,
    });

    nowMs += 1_000;
    observability.observeLyricsResult({
      kind: 'missing',
      lines: [],
      provider: null,
    }, 1);
    expect(logs).toHaveLength(3);
  });

  it('keeps error counter cardinality bounded for unexpected error names', () => {
    const observability = new ProductionObservability();
    for (let index = 0; index < 40; index += 1) {
      const error = new Error('test');
      error.name = `UnexpectedError${index}`;
      observability.observeLyricsFailure(error, 1);
    }
    const errors = observability.snapshot().lyrics.errors;
    expect(Object.keys(errors).length).toBeLessThanOrEqual(32);
    expect(errors.__other__).toBe(9);
  });
});
