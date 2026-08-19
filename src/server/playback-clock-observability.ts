export type PlaybackClockSampleDecision = 'accepted' | 'pending';

export interface PlaybackClockObservation {
  deltaMs: number;
  decision: PlaybackClockSampleDecision;
  playbackStatus: string;
  trackGeneration: number;
}

export interface PlaybackClockObservabilitySnapshot {
  enabled: boolean;
  backwardSamples: number;
  acceptedBackwardSamples: number;
  pendingBackwardSamples: number;
  hardRebaseCandidates: number;
  largestBackwardMs: number | null;
  logsEmitted: number;
  logsSuppressed: number;
  transitionRejectedSamples: number;
  lastObservedAt: string | null;
  lastLoggedAt: string | null;
}

export interface PlaybackClockObservabilityOptions {
  now?: () => number;
  log?: (message: string) => void;
  logIntervalMs?: number;
}

const BACKWARD_SAMPLE_LOG_THRESHOLD_MS = 250;
const CLIENT_HARD_REBASE_THRESHOLD_MS = 350;
const DEFAULT_LOG_INTERVAL_MS = 60_000;

/**
 * Constant-memory, process-wide playback clock diagnostics.
 *
 * Every qualifying backward sample updates counters, but production logging is
 * reduced to one aggregate event per interval. Track identity and lyric text
 * are deliberately excluded from both the counters and log payload.
 */
export class PlaybackClockObservability {
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly logIntervalMs: number;
  private enabled = false;
  private backwardSamples = 0;
  private acceptedBackwardSamples = 0;
  private pendingBackwardSamples = 0;
  private hardRebaseCandidates = 0;
  private largestBackwardMs: number | null = null;
  private logsEmitted = 0;
  private logsSuppressed = 0;
  private transitionRejectedSamples = 0;
  private lastObservedAtMs: number | null = null;
  private lastLoggedAtMs: number | null = null;
  private windowBackwardSamples = 0;
  private windowAcceptedBackwardSamples = 0;
  private windowPendingBackwardSamples = 0;
  private windowLargestBackwardMs: number | null = null;
  private windowLastDeltaMs: number | null = null;
  private windowLastDecision: PlaybackClockSampleDecision | null = null;

  constructor(options: PlaybackClockObservabilityOptions = {}) {
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

  observeTransitionRejected(): void {
    this.transitionRejectedSamples += 1;
  }

  observeBackwardSample(observation: PlaybackClockObservation): void {
    if (
      !Number.isFinite(observation.deltaMs)
      || observation.deltaMs > -BACKWARD_SAMPLE_LOG_THRESHOLD_MS
    ) return;

    const nowMs = this.now();
    const backwardMs = Math.round(Math.abs(observation.deltaMs));
    this.backwardSamples += 1;
    if (observation.decision === 'accepted') this.acceptedBackwardSamples += 1;
    else this.pendingBackwardSamples += 1;
    if (backwardMs >= CLIENT_HARD_REBASE_THRESHOLD_MS) this.hardRebaseCandidates += 1;
    this.largestBackwardMs = this.largestBackwardMs === null
      ? backwardMs
      : Math.max(this.largestBackwardMs, backwardMs);
    this.lastObservedAtMs = nowMs;

    this.windowBackwardSamples += 1;
    if (observation.decision === 'accepted') this.windowAcceptedBackwardSamples += 1;
    else this.windowPendingBackwardSamples += 1;
    this.windowLargestBackwardMs = this.windowLargestBackwardMs === null
      ? backwardMs
      : Math.max(this.windowLargestBackwardMs, backwardMs);
    this.windowLastDeltaMs = -backwardMs;
    this.windowLastDecision = observation.decision;

    if (!this.enabled) return;
    if (
      this.lastLoggedAtMs !== null
      && nowMs - this.lastLoggedAtMs < this.logIntervalMs
    ) {
      this.logsSuppressed += 1;
      return;
    }

    this.log(JSON.stringify({
      event: 'playback_clock_backward_samples',
      windowMs: this.logIntervalMs,
      windowSamples: this.windowBackwardSamples,
      windowAcceptedSamples: this.windowAcceptedBackwardSamples,
      windowPendingSamples: this.windowPendingBackwardSamples,
      windowLargestBackwardMs: this.windowLargestBackwardMs,
      latestDeltaMs: this.windowLastDeltaMs,
      latestDecision: this.windowLastDecision,
      trackGeneration: observation.trackGeneration,
      playbackStatus: observation.playbackStatus,
    }));
    this.logsEmitted += 1;
    this.lastLoggedAtMs = nowMs;
    this.windowBackwardSamples = 0;
    this.windowAcceptedBackwardSamples = 0;
    this.windowPendingBackwardSamples = 0;
    this.windowLargestBackwardMs = null;
    this.windowLastDeltaMs = null;
    this.windowLastDecision = null;
  }

  snapshot(): PlaybackClockObservabilitySnapshot {
    return {
      enabled: this.enabled,
      backwardSamples: this.backwardSamples,
      acceptedBackwardSamples: this.acceptedBackwardSamples,
      pendingBackwardSamples: this.pendingBackwardSamples,
      hardRebaseCandidates: this.hardRebaseCandidates,
      largestBackwardMs: this.largestBackwardMs,
      logsEmitted: this.logsEmitted,
      logsSuppressed: this.logsSuppressed,
      transitionRejectedSamples: this.transitionRejectedSamples,
      lastObservedAt: this.lastObservedAtMs === null
        ? null
        : new Date(this.lastObservedAtMs).toISOString(),
      lastLoggedAt: this.lastLoggedAtMs === null
        ? null
        : new Date(this.lastLoggedAtMs).toISOString(),
    };
  }
}

export const playbackClockObservability = new PlaybackClockObservability();
