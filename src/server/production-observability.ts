import type { LyricsPayload } from '../shared/contracts.js';
import { FixedDurationHistogram, type DurationStats } from './runtime-performance.js';

const DEFAULT_LOG_INTERVAL_MS = 60_000;
const MAX_LOG_EVENTS_PER_INTERVAL = 8;
const MAX_LOG_KEYS = 16;
const MAX_COUNTER_KEYS = 32;
const OTHER_COUNTER_KEY = '__other__';

type CounterMap = Record<string, number>;

function increment(map: CounterMap, key: string): void {
  const safeKey = key === '__proto__' || key === 'constructor' || key === 'prototype'
    ? OTHER_COUNTER_KEY
    : key;
  if (Object.prototype.hasOwnProperty.call(map, safeKey)) {
    map[safeKey] += 1;
    return;
  }
  const target = Object.keys(map).length < MAX_COUNTER_KEYS - 1
    ? safeKey
    : OTHER_COUNTER_KEY;
  map[target] = (map[target] ?? 0) + 1;
}

function cloneCounters(map: CounterMap): CounterMap {
  return { ...map };
}

export interface ProductionObservabilitySnapshot {
  lyrics: {
    requests: number;
    completed: number;
    failures: number;
    retryable: number;
    durations: DurationStats;
    sources: CounterMap;
    kinds: CounterMap;
    errors: CounterMap;
    versionTransitions: CounterMap;
    staleResults: CounterMap;
  };
  sse: {
    active: number;
    opened: number;
    closed: number;
    snapshots: number;
    heartbeatWrites: number;
    backpressureEvents: number;
    coalescedSnapshots: number;
    skippedHeartbeats: number;
    maxBufferedBytes: number;
    writeErrors: number;
    durations: DurationStats;
  };
  telemetry: {
    messages: number;
    routedMessages: number;
    unknownTopics: number;
    unroutedMessages: number;
    invalidPayloads: number;
    elapsedSamples: number;
    elapsedIntervals: DurationStats;
    connectivityChanges: number;
    lastMessageAt: string | null;
  };
  appleTimeline: {
    valid: number;
    repaired: number;
    rejected: number;
    notEvaluated: number;
    notApplicable: number;
    largestOverrunMs: number | null;
    anomalies: CounterMap;
  };
  enabled: boolean;
  logsEmitted: number;
  logsSuppressed: number;
  httpErrors: number;
}

export interface ProductionObservabilityOptions {
  now?: () => number;
  log?: (message: string) => void;
  logIntervalMs?: number;
}

/**
 * Process-local, fixed-cardinality production diagnostics. Counters are
 * intentionally kept in memory; logs are emitted only for actionable events
 * and are rate limited independently by event name.
 */
export class ProductionObservability {
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly logIntervalMs: number;
  private enabled = false;
  private readonly lyricsDuration = new FixedDurationHistogram();
  private readonly sseDuration = new FixedDurationHistogram();
  private readonly telemetryIntervals = new FixedDurationHistogram();
  private lyricsRequests = 0;
  private lyricsCompleted = 0;
  private lyricsFailures = 0;
  private lyricsRetryable = 0;
  private readonly lyricsSources: CounterMap = {};
  private readonly lyricsKinds: CounterMap = {};
  private readonly lyricsErrors: CounterMap = {};
  private readonly versionTransitions: CounterMap = {};
  private readonly staleResults: CounterMap = {};
  private sseActive = 0;
  private sseOpened = 0;
  private sseClosed = 0;
  private sseSnapshots = 0;
  private sseHeartbeatWrites = 0;
  private sseBackpressureEvents = 0;
  private sseCoalescedSnapshots = 0;
  private sseSkippedHeartbeats = 0;
  private sseMaxBufferedBytes = 0;
  private sseWriteErrors = 0;
  private telemetryMessages = 0;
  private telemetryRoutedMessages = 0;
  private telemetryUnknownTopics = 0;
  private telemetryUnroutedMessages = 0;
  private telemetryInvalidPayloads = 0;
  private telemetryElapsedSamples = 0;
  private telemetryConnectivityChanges = 0;
  private telemetryLastConnectivity: boolean | null = null;
  private telemetryLastMessageAtMs: number | null = null;
  private telemetryLastElapsedAtMs: number | null = null;
  private appleTimelineValid = 0;
  private appleTimelineRepaired = 0;
  private appleTimelineRejected = 0;
  private appleTimelineNotEvaluated = 0;
  private appleTimelineNotApplicable = 0;
  private appleTimelineLargestOverrunMs: number | null = null;
  private readonly appleTimelineAnomalies: CounterMap = {};
  private readonly lastLogs = new Map<string, number>();
  private logWindowStartedAtMs: number | null = null;
  private logWindowEmitted = 0;
  private logsEmitted = 0;
  private logsSuppressed = 0;
  private httpErrors = 0;

  constructor(options: ProductionObservabilityOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? ((message) => console.info(message));
    this.logIntervalMs = options.logIntervalMs ?? DEFAULT_LOG_INTERVAL_MS;
    if (!Number.isFinite(this.logIntervalMs) || this.logIntervalMs <= 0) {
      throw new Error('logIntervalMs must be a finite positive number');
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  observeLyricsStart(): void {
    this.lyricsRequests += 1;
  }

  observeLyricsResult(payload: LyricsPayload, durationMs: number): void {
    this.lyricsCompleted += 1;
    this.lyricsDuration.observe(durationMs);
    increment(this.lyricsKinds, payload.kind);
    const source = payload.fallbackKind === 'work-cache'
      ? 'work-fallback'
      : payload.fallbackKind === 'original-version'
        ? 'original-version-fallback'
        : payload.provider ?? 'none';
    increment(this.lyricsSources, source);
    if (payload.retryable) this.lyricsRetryable += 1;
    if (payload.kind === 'missing' || payload.retryable) {
      this.rateLimitedLog('lyrics_lookup_result', {
        event: 'lyrics_lookup_result',
        kind: payload.kind,
        source,
        retryable: Boolean(payload.retryable),
      });
    }
  }

  observeLyricsFailure(error: unknown, durationMs: number): void {
    this.lyricsFailures += 1;
    this.lyricsDuration.observe(durationMs);
    const errorName = error instanceof Error ? error.name : 'unknown';
    increment(this.lyricsErrors, errorName);
    this.rateLimitedLog('lyrics_lookup_failure', {
      event: 'lyrics_lookup_failure',
      error: errorName,
    });
  }

  observeHttpError(error: unknown): void {
    this.httpErrors += 1;
    this.rateLimitedLog('http_error', {
      event: 'http_error',
      error: error instanceof Error ? error.name : 'unknown',
    });
  }

  observeLyricsVersionTransition(
    action: string,
    currentSource?: string | null,
    refreshedSource?: string | null,
  ): void {
    increment(this.versionTransitions, action);
    if (currentSource !== undefined && refreshedSource !== undefined) {
      increment(
        this.versionTransitions,
        `${action}:${currentSource ?? 'none'}->${refreshedSource ?? 'none'}`,
      );
    }
  }

  logLyricsVersionTransition(payload: Record<string, unknown>): void {
    if (!this.enabled) {
      this.log(JSON.stringify(payload));
      return;
    }
    this.rateLimitedLog('lyrics_version_transition', payload);
  }

  observeStaleLyricsResult(reason: 'sequence' | 'fingerprint' | 'generation'): void {
    increment(this.staleResults, reason);
  }

  openSse(): void {
    this.sseActive += 1;
    this.sseOpened += 1;
  }

  closeSse(durationMs: number): void {
    this.sseActive = Math.max(0, this.sseActive - 1);
    this.sseClosed += 1;
    this.sseDuration.observe(durationMs);
  }

  observeSseSnapshot(): void {
    this.sseSnapshots += 1;
  }

  observeSseHeartbeat(): void {
    this.sseHeartbeatWrites += 1;
  }

  observeSseBackpressure(bufferedBytes: number): void {
    this.sseBackpressureEvents += 1;
    this.sseMaxBufferedBytes = Math.max(this.sseMaxBufferedBytes, bufferedBytes);
    this.rateLimitedLog('sse_backpressure', {
      event: 'sse_backpressure',
      bufferedBytes,
    });
  }

  observeSseSnapshotCoalesced(): void {
    this.sseCoalescedSnapshots += 1;
  }

  observeSseHeartbeatSkipped(): void {
    this.sseSkippedHeartbeats += 1;
  }

  observeSseWriteError(): void {
    this.sseWriteErrors += 1;
    this.rateLimitedLog('sse_write_error', { event: 'sse_write_error' });
  }

  observeTelemetryMessage(
    result: 'routed' | 'unknown-topic' | 'unrouted',
    field?: string,
  ): void {
    const nowMs = this.now();
    this.telemetryMessages += 1;
    this.telemetryLastMessageAtMs = nowMs;
    if (result === 'routed') {
      this.telemetryRoutedMessages += 1;
      if (field === 'MediaNowPlayingElapsed') {
        this.telemetryElapsedSamples += 1;
        if (this.telemetryLastElapsedAtMs !== null) {
          this.telemetryIntervals.observe(Math.max(0, nowMs - this.telemetryLastElapsedAtMs));
        }
        this.telemetryLastElapsedAtMs = nowMs;
      }
    } else if (result === 'unknown-topic') {
      this.telemetryUnknownTopics += 1;
      this.rateLimitedLog('telemetry_unknown_topic', { event: 'telemetry_unknown_topic' });
    } else {
      this.telemetryUnroutedMessages += 1;
      this.rateLimitedLog('telemetry_unrouted', { event: 'telemetry_unrouted' });
    }
  }

  observeTelemetryInvalidPayload(): void {
    this.telemetryInvalidPayloads += 1;
  }

  observeTelemetryConnectivityChange(connected: boolean): void {
    if (this.telemetryLastConnectivity !== null && this.telemetryLastConnectivity !== connected) {
      this.telemetryConnectivityChanges += 1;
    }
    this.telemetryLastConnectivity = connected;
  }

  observeAppleTimeline(
    outcome: 'valid' | 'repaired' | 'rejected' | 'not-evaluated' | 'not-applicable',
    anomaly: string | null,
    overrunMs = 0,
  ): void {
    if (outcome === 'valid') this.appleTimelineValid += 1;
    else if (outcome === 'repaired') this.appleTimelineRepaired += 1;
    else if (outcome === 'rejected') this.appleTimelineRejected += 1;
    else if (outcome === 'not-evaluated') this.appleTimelineNotEvaluated += 1;
    else this.appleTimelineNotApplicable += 1;
    if (Number.isFinite(overrunMs) && overrunMs > 0) {
      this.appleTimelineLargestOverrunMs = this.appleTimelineLargestOverrunMs === null
        ? overrunMs
        : Math.max(this.appleTimelineLargestOverrunMs, overrunMs);
    }
    if (anomaly) increment(this.appleTimelineAnomalies, anomaly);
  }

  snapshot(): ProductionObservabilitySnapshot {
    return {
      lyrics: {
        requests: this.lyricsRequests,
        completed: this.lyricsCompleted,
        failures: this.lyricsFailures,
        retryable: this.lyricsRetryable,
        durations: this.lyricsDuration.snapshot(),
        sources: cloneCounters(this.lyricsSources),
        kinds: cloneCounters(this.lyricsKinds),
        errors: cloneCounters(this.lyricsErrors),
        versionTransitions: cloneCounters(this.versionTransitions),
        staleResults: cloneCounters(this.staleResults),
      },
      sse: {
        active: this.sseActive,
        opened: this.sseOpened,
        closed: this.sseClosed,
        snapshots: this.sseSnapshots,
        heartbeatWrites: this.sseHeartbeatWrites,
        backpressureEvents: this.sseBackpressureEvents,
        coalescedSnapshots: this.sseCoalescedSnapshots,
        skippedHeartbeats: this.sseSkippedHeartbeats,
        maxBufferedBytes: this.sseMaxBufferedBytes,
        writeErrors: this.sseWriteErrors,
        durations: this.sseDuration.snapshot(),
      },
      telemetry: {
        messages: this.telemetryMessages,
        routedMessages: this.telemetryRoutedMessages,
        unknownTopics: this.telemetryUnknownTopics,
        unroutedMessages: this.telemetryUnroutedMessages,
        invalidPayloads: this.telemetryInvalidPayloads,
        elapsedSamples: this.telemetryElapsedSamples,
        elapsedIntervals: this.telemetryIntervals.snapshot(),
        connectivityChanges: this.telemetryConnectivityChanges,
        lastMessageAt: this.telemetryLastMessageAtMs === null
          ? null
          : new Date(this.telemetryLastMessageAtMs).toISOString(),
      },
      appleTimeline: {
        valid: this.appleTimelineValid,
        repaired: this.appleTimelineRepaired,
        rejected: this.appleTimelineRejected,
        notEvaluated: this.appleTimelineNotEvaluated,
        notApplicable: this.appleTimelineNotApplicable,
        largestOverrunMs: this.appleTimelineLargestOverrunMs,
        anomalies: cloneCounters(this.appleTimelineAnomalies),
      },
      enabled: this.enabled,
      logsEmitted: this.logsEmitted,
      logsSuppressed: this.logsSuppressed,
      httpErrors: this.httpErrors,
    };
  }

  private rateLimitedLog(key: string, payload: Record<string, unknown>): void {
    if (!this.enabled) return;
    const nowMs = this.now();
    if (
      this.logWindowStartedAtMs === null
      || nowMs - this.logWindowStartedAtMs >= this.logIntervalMs
    ) {
      this.logWindowStartedAtMs = nowMs;
      this.logWindowEmitted = 0;
    }
    if (this.logWindowEmitted >= MAX_LOG_EVENTS_PER_INTERVAL) {
      this.logsSuppressed += 1;
      return;
    }
    const last = this.lastLogs.get(key);
    if (last !== undefined && nowMs - last < this.logIntervalMs) {
      this.logsSuppressed += 1;
      return;
    }
    if (last === undefined && this.lastLogs.size >= MAX_LOG_KEYS) {
      this.logsSuppressed += 1;
      return;
    }
    this.lastLogs.set(key, nowMs);
    this.log(JSON.stringify(payload));
    this.logWindowEmitted += 1;
    this.logsEmitted += 1;
  }
}

export const productionObservability = new ProductionObservability();
