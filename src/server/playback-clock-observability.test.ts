import {
  PlaybackClockObservability,
} from './playback-clock-observability.js';

describe('PlaybackClockObservability', () => {
  it('keeps bounded counters and emits at most one aggregate log per interval', () => {
    let nowMs = 1_800_000_000_000;
    const logs: string[] = [];
    const telemetry = new PlaybackClockObservability({
      now: () => nowMs,
      log: (message) => logs.push(message),
      logIntervalMs: 1_000,
    });
    telemetry.setEnabled(true);

    telemetry.observeBackwardSample({
      deltaMs: -300,
      decision: 'accepted',
      playbackStatus: 'playing',
      trackGeneration: 1,
    });
    nowMs += 500;
    telemetry.observeBackwardSample({
      deltaMs: -400,
      decision: 'pending',
      playbackStatus: 'playing',
      trackGeneration: 1,
    });
    nowMs += 500;
    telemetry.observeBackwardSample({
      deltaMs: -500,
      decision: 'accepted',
      playbackStatus: 'playing',
      trackGeneration: 1,
    });

    expect(logs).toHaveLength(2);
    expect(JSON.parse(logs[0]!)).toMatchObject({
      event: 'playback_clock_backward_samples',
      windowSamples: 1,
      windowAcceptedSamples: 1,
      windowPendingSamples: 0,
      windowLargestBackwardMs: 300,
    });
    expect(JSON.parse(logs[1]!)).toMatchObject({
      windowSamples: 2,
      windowAcceptedSamples: 1,
      windowPendingSamples: 1,
      windowLargestBackwardMs: 500,
      latestDeltaMs: -500,
    });
    expect(telemetry.snapshot()).toMatchObject({
      enabled: true,
      backwardSamples: 3,
      acceptedBackwardSamples: 2,
      pendingBackwardSamples: 1,
      hardRebaseCandidates: 2,
      largestBackwardMs: 500,
      logsEmitted: 2,
      logsSuppressed: 1,
    });
  });

  it('still counts observations while logging is disabled', () => {
    const logs: string[] = [];
    const telemetry = new PlaybackClockObservability({ log: (message) => logs.push(message) });

    telemetry.observeBackwardSample({
      deltaMs: -600,
      decision: 'accepted',
      playbackStatus: 'paused',
      trackGeneration: 2,
    });

    expect(logs).toEqual([]);
    expect(telemetry.snapshot()).toMatchObject({
      enabled: false,
      backwardSamples: 1,
      acceptedBackwardSamples: 1,
      hardRebaseCandidates: 1,
      logsEmitted: 0,
      logsSuppressed: 0,
    });
  });
});
