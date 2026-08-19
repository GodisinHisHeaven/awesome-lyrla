import type { LyricLine } from '../shared/contracts.js';

export const APPLE_TIMELINE_VALIDATION_VERSION =
  'apple-timeline-validation-v1' as const;
export const APPLE_TIMELINE_SPAN_REPAIR_METHOD =
  'word-span-line-start-v1' as const;

export type AppleLyricsTimelineAnomaly =
  | 'timestamp-duration-overrun'
  | 'collapsed-timeline-coverage';

const MAX_CREDIBLE_DURATION_MS = 24 * 60 * 60 * 1_000;
const SHORT_TRACK_DURATION_MS = 120_000;
const MIN_SHORT_TRACK_TOLERANCE_MS = 2_000;
const SHORT_TRACK_TOLERANCE_FRACTION = 0.25;
const MIN_SPARSE_COLLAPSE_LINES = 6;
const MIN_FRACTIONAL_COLLAPSE_LINES = 12;
const COLLAPSE_LINE_FRACTION = 0.8;
const MAX_COLLAPSE_WINDOW_MS = 2_000;
const COLLAPSE_DURATION_FRACTION = 0.02;

export function isCredibleAppleTimelineDuration(
  durationMs: number,
): boolean {
  return Number.isFinite(durationMs)
    && durationMs > 0
    && durationMs <= MAX_CREDIBLE_DURATION_MS;
}

/**
 * Mirrors the database Apple-primary hard timing gate. It deliberately
 * recognizes only structural corruption; null is not an audio-alignment
 * verdict.
 */
export function appleLyricsTimelineAnomaly(
  lines: readonly Pick<LyricLine, 'startMs'>[],
  durationMs: number,
): AppleLyricsTimelineAnomaly | null {
  if (
    !isCredibleAppleTimelineDuration(durationMs)
    || lines.length === 0
  ) return null;

  const starts = lines
    .map((line) => line.startMs)
    .filter((startMs) => Number.isFinite(startMs) && startMs >= 0)
    .sort((left, right) => left - right);
  if (starts.length !== lines.length) return null;

  const durationToleranceMs = durationMs < SHORT_TRACK_DURATION_MS
    ? Math.max(
        MIN_SHORT_TRACK_TOLERANCE_MS,
        Math.ceil(durationMs * SHORT_TRACK_TOLERANCE_FRACTION),
      )
    : Math.max(
        30_000,
        Math.min(120_000, Math.ceil(durationMs * 0.1)),
      );
  if (starts.at(-1)! > durationMs + durationToleranceMs) {
    return 'timestamp-duration-overrun';
  }

  if (
    starts.length < MIN_SPARSE_COLLAPSE_LINES
  ) return null;

  const collapseWindowMs = Math.min(
    MAX_COLLAPSE_WINDOW_MS,
    Math.floor(durationMs * COLLAPSE_DURATION_FRACTION),
  );
  // With a normal line count, an 80% sliding-window majority is strong
  // evidence of a unit/coverage collapse. Sparse songs have less statistical
  // evidence and can legitimately contain simultaneous vocal parts, so fail
  // closed there only when every one of 6–11 lines collapses.
  const requiredLines = starts.length >= MIN_FRACTIONAL_COLLAPSE_LINES
    ? Math.ceil(starts.length * COLLAPSE_LINE_FRACTION)
    : starts.length;
  let windowStart = 0;
  for (let windowEnd = 0; windowEnd < starts.length; windowEnd += 1) {
    while (
      starts[windowEnd]! - starts[windowStart]! > collapseWindowMs
    ) {
      windowStart += 1;
    }
    if (windowEnd - windowStart + 1 >= requiredLines) {
      return 'collapsed-timeline-coverage';
    }
  }

  return null;
}
