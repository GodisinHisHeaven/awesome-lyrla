export interface MediaClock {
  baseElapsedMs: number;
  baseTimeMs: number;
  correctionMs: number;
  correctionDurationMs: number;
  running: boolean;
}

const FORWARD_SEEK_THRESHOLD_MS = 350;
const BACKWARD_SEEK_THRESHOLD_MS = 1_000;
const CORRECTION_WINDOW_MS = 1_000;
const MIN_PLAYBACK_RATE = 0.8;

export function createMediaClock(elapsedMs: number, running: boolean, nowMs: number): MediaClock {
  return {
    baseElapsedMs: elapsedMs,
    baseTimeMs: nowMs,
    correctionMs: 0,
    correctionDurationMs: CORRECTION_WINDOW_MS,
    running,
  };
}

export function sampleMediaClock(clock: MediaClock, nowMs: number): number {
  if (!clock.running) return clock.baseElapsedMs;
  const advancedMs = Math.max(0, nowMs - clock.baseTimeMs);
  const correctionProgress = Math.min(1, advancedMs / clock.correctionDurationMs);
  return clock.baseElapsedMs + advancedMs + clock.correctionMs * correctionProgress;
}

export function rebaseMediaClock(
  clock: MediaClock,
  reportedElapsedMs: number,
  running: boolean,
  nowMs: number,
): MediaClock {
  const predictedElapsedMs = sampleMediaClock(clock, nowMs);
  const driftMs = reportedElapsedMs - predictedElapsedMs;
  if (
    clock.running !== running ||
    !running ||
    driftMs > FORWARD_SEEK_THRESHOLD_MS ||
    driftMs < -BACKWARD_SEEK_THRESHOLD_MS
  ) {
    return createMediaClock(reportedElapsedMs, running, nowMs);
  }
  return {
    baseElapsedMs: predictedElapsedMs,
    baseTimeMs: nowMs,
    correctionMs: driftMs,
    // Slow down to absorb small backward reports without reversing the visual
    // clock. A larger correction needs a longer window to keep the rate >= 0.8.
    correctionDurationMs: Math.max(CORRECTION_WINDOW_MS, -driftMs / (1 - MIN_PLAYBACK_RATE)),
    running,
  };
}

export function wallDelayForMediaDelta(
  clock: MediaClock,
  nowMs: number,
  mediaDeltaMs: number,
): number {
  const mediaDelta = Math.max(0, mediaDeltaMs);
  if (!clock.running || clock.correctionMs === 0) return mediaDelta;
  const advancedMs = Math.max(0, nowMs - clock.baseTimeMs);
  const correctionWallMs = Math.max(0, clock.correctionDurationMs - advancedMs);
  if (correctionWallMs === 0) return mediaDelta;
  const correctionRate = 1 + clock.correctionMs / clock.correctionDurationMs;
  const correctedMediaCapacityMs = correctionWallMs * correctionRate;
  if (mediaDelta <= correctedMediaCapacityMs) return mediaDelta / correctionRate;
  return correctionWallMs + mediaDelta - correctedMediaCapacityMs;
}
