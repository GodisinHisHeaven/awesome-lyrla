import type { LyricLine } from '../shared/contracts.js';
import { activeLyricIndex } from '../shared/lrc.js';

export type LyricPhase =
  | 'preroll'
  | 'active'
  | 'handoff'
  | 'settle'
  | 'ended';

export interface LyricFrame {
  anchorIndex: number;
  anchorStartIndex: number;
  focusIndex: number | null;
  focusStartIndex: number | null;
  incomingIndex: number | null;
  incomingStartIndex: number | null;
  outgoingIndex: number | null;
  outgoingStartIndex: number | null;
  outgoingStartsFocused: boolean;
  phase: LyricPhase;
  phaseStartMs: number | null;
  phaseEndMs: number | null;
  activeStartMs: number | null;
  activeEndMs: number | null;
  focusImpactMs: number;
  nextEventMs: number | null;
}

export interface LyricMotionOptions {
  reducedMotion?: boolean;
}

interface LineLifecycle {
  activeEndMs: number;
  handoffStartMs: number | null;
  nextIndex: number | null;
  nextStartMs: number | null;
}

const lifecycleCache = new WeakMap<LyricLine[], Map<number, Map<number, LineLifecycle>>>();

const HANDOFF_MIN_MS = 220;
const HANDOFF_MAX_MS = 620;
const HANDOFF_TAIL_MS = 180;
const FOCUS_IMPACT_MAX_MS = 680;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function lyricGroupStart(lines: LyricLine[], index: number): number {
  if (index < 0 || index >= lines.length) return index;
  let start = index;
  while (start > 0 && lines[start - 1].startMs === lines[index].startMs) start -= 1;
  return start;
}

export function lyricGroupEnd(lines: LyricLine[], index: number): number {
  if (index < 0 || index >= lines.length) return index;
  let end = index;
  while (end + 1 < lines.length && lines[end + 1].startMs === lines[index].startMs) end += 1;
  return end;
}

export function lyricHandoffLeadMs(gapMs: number): number {
  if (gapMs <= 0) return 0;
  return Math.round(Math.min(
    HANDOFF_MAX_MS,
    Math.max(HANDOFF_MIN_MS, gapMs * 0.38),
    gapMs * 0.44,
  ));
}

export function lyricPhaseProgress(
  elapsedMs: number,
  startMs: number | null,
  endMs: number | null,
): number {
  if (startMs === null || endMs === null || endMs <= startMs) return 1;
  return clamp((elapsedMs - startMs) / (endMs - startMs), 0, 1);
}

function lifecycleFor(
  lines: LyricLine[],
  index: number,
  adjustedDurationMs: number,
): LineLifecycle {
  const current = lines[index];
  const candidate = lines[index + 1];
  const nextIndex = candidate ? lyricGroupEnd(lines, index + 1) : null;
  const next = nextIndex !== null && lines[nextIndex].startMs < adjustedDurationMs
    ? lines[nextIndex]
    : null;

  if (!next || nextIndex === null) {
    return {
      activeEndMs: adjustedDurationMs,
      handoffStartMs: null,
      nextIndex: null,
      nextStartMs: null,
    };
  }

  const gapMs = Math.max(0, next.startMs - current.startMs);
  const handoffStartMs = Math.max(
    current.startMs,
    next.startMs - lyricHandoffLeadMs(gapMs),
  );

  return {
    activeEndMs: handoffStartMs,
    handoffStartMs,
    nextIndex,
    nextStartMs: Math.min(next.startMs, adjustedDurationMs),
  };
}

function cachedLifecycleFor(
  lines: LyricLine[],
  index: number,
  adjustedDurationMs: number,
): LineLifecycle {
  let byDuration = lifecycleCache.get(lines);
  if (!byDuration) {
    byDuration = new Map();
    lifecycleCache.set(lines, byDuration);
  }
  let byIndex = byDuration.get(adjustedDurationMs);
  if (!byIndex) {
    byIndex = new Map();
    byDuration.set(adjustedDurationMs, byIndex);
  }
  const cached = byIndex.get(index);
  if (cached) return cached;
  const lifecycle = lifecycleFor(lines, index, adjustedDurationMs);
  byIndex.set(index, lifecycle);
  return lifecycle;
}

function focusImpactMs(activeStartMs: number, activeEndMs: number): number {
  return Math.round(Math.min(
    FOCUS_IMPACT_MAX_MS,
    Math.max(1, activeEndMs - activeStartMs),
  ));
}

function endedFrame(lines: LyricLine[], anchorIndex: number): LyricFrame {
  return {
    anchorIndex,
    anchorStartIndex: lyricGroupStart(lines, anchorIndex),
    focusIndex: null,
    focusStartIndex: null,
    incomingIndex: null,
    incomingStartIndex: null,
    outgoingIndex: null,
    outgoingStartIndex: null,
    outgoingStartsFocused: false,
    phase: 'ended',
    phaseStartMs: null,
    phaseEndMs: null,
    activeStartMs: null,
    activeEndMs: null,
    focusImpactMs: 0,
    nextEventMs: null,
  };
}

export function computeLyricFrame(
  lines: LyricLine[],
  elapsedMs: number,
  offsetMs = 0,
  durationMs = 0,
  options: LyricMotionOptions = {},
): LyricFrame {
  if (lines.length === 0) return endedFrame(lines, -1);

  const reducedMotion = options.reducedMotion === true;
  const lyricElapsed = elapsedMs + offsetMs;
  const adjustedDuration = durationMs > 0
    ? Math.max(0, durationMs + offsetMs)
    : Number.POSITIVE_INFINITY;
  const activeIndex = lyricElapsed < 0 ? -1 : activeLyricIndex(lines, lyricElapsed);
  if (durationMs > 0 && elapsedMs >= durationMs) {
    return endedFrame(lines, Math.max(0, activeIndex));
  }

  if (activeIndex < 0) {
    const firstIndex = lyricGroupEnd(lines, 0);
    if (lines[firstIndex].startMs >= adjustedDuration) {
      return endedFrame(lines, firstIndex);
    }
    const firstStartMs = Math.min(lines[firstIndex].startMs, adjustedDuration);
    const prerollStartMs = Math.max(
      0,
      firstStartMs - lyricHandoffLeadMs(Math.max(HANDOFF_MIN_MS, firstStartMs)),
    );
    const isIncoming = !reducedMotion && lyricElapsed >= prerollStartMs;
    const incomingIndex = isIncoming ? firstIndex : null;
    return {
      anchorIndex: firstIndex,
      anchorStartIndex: lyricGroupStart(lines, firstIndex),
      focusIndex: null,
      focusStartIndex: null,
      incomingIndex,
      incomingStartIndex: incomingIndex === null ? null : lyricGroupStart(lines, incomingIndex),
      outgoingIndex: null,
      outgoingStartIndex: null,
      outgoingStartsFocused: false,
      phase: 'preroll',
      phaseStartMs: isIncoming ? prerollStartMs : null,
      phaseEndMs: isIncoming ? firstStartMs : null,
      activeStartMs: null,
      activeEndMs: null,
      focusImpactMs: 0,
      nextEventMs: isIncoming ? firstStartMs : reducedMotion ? firstStartMs : prerollStartMs,
    };
  }

  const canonicalActiveIndex = lyricGroupEnd(lines, activeIndex);
  const activeStartIndex = lyricGroupStart(lines, canonicalActiveIndex);
  const lifecycle = cachedLifecycleFor(lines, canonicalActiveIndex, adjustedDuration);
  const activeStartMs = lines[canonicalActiveIndex].startMs;
  const effectiveActiveEndMs = reducedMotion && lifecycle.nextStartMs !== null
    ? lifecycle.nextStartMs
    : lifecycle.activeEndMs;
  const finiteActiveEndMs = Number.isFinite(effectiveActiveEndMs)
    ? effectiveActiveEndMs
    : null;
  const impactMs = focusImpactMs(activeStartMs, effectiveActiveEndMs);
  const previousIndex = activeStartIndex - 1;
  const settleEndMs = Math.min(
    activeStartMs + HANDOFF_TAIL_MS,
    effectiveActiveEndMs,
  );
  if (
    !reducedMotion
    && previousIndex >= 0
    && lyricElapsed < settleEndMs
  ) {
    return {
      anchorIndex: canonicalActiveIndex,
      anchorStartIndex: activeStartIndex,
      focusIndex: canonicalActiveIndex,
      focusStartIndex: activeStartIndex,
      incomingIndex: null,
      incomingStartIndex: null,
      outgoingIndex: previousIndex,
      outgoingStartIndex: lyricGroupStart(lines, previousIndex),
      outgoingStartsFocused: true,
      phase: 'settle',
      phaseStartMs: activeStartMs,
      phaseEndMs: settleEndMs,
      activeStartMs,
      activeEndMs: finiteActiveEndMs,
      focusImpactMs: impactMs,
      nextEventMs: settleEndMs,
    };
  }
  if (lyricElapsed < effectiveActiveEndMs) {
    return {
      anchorIndex: canonicalActiveIndex,
      anchorStartIndex: activeStartIndex,
      focusIndex: canonicalActiveIndex,
      focusStartIndex: activeStartIndex,
      incomingIndex: null,
      incomingStartIndex: null,
      outgoingIndex: null,
      outgoingStartIndex: null,
      outgoingStartsFocused: false,
      phase: 'active',
      phaseStartMs: activeStartMs,
      phaseEndMs: finiteActiveEndMs,
      activeStartMs,
      activeEndMs: finiteActiveEndMs,
      focusImpactMs: impactMs,
      nextEventMs: finiteActiveEndMs,
    };
  }

  if (
    lifecycle.handoffStartMs !== null
    && lifecycle.nextIndex !== null
    && lifecycle.nextStartMs !== null
    && lyricElapsed < lifecycle.nextStartMs
  ) {
    return {
      anchorIndex: lifecycle.nextIndex,
      anchorStartIndex: lyricGroupStart(lines, lifecycle.nextIndex),
      focusIndex: canonicalActiveIndex,
      focusStartIndex: activeStartIndex,
      incomingIndex: lifecycle.nextIndex,
      incomingStartIndex: lyricGroupStart(lines, lifecycle.nextIndex),
      outgoingIndex: canonicalActiveIndex,
      outgoingStartIndex: activeStartIndex,
      outgoingStartsFocused: lifecycle.activeEndMs === lifecycle.handoffStartMs,
      phase: 'handoff',
      phaseStartMs: lifecycle.handoffStartMs,
      phaseEndMs: lifecycle.nextStartMs,
      activeStartMs: null,
      activeEndMs: null,
      focusImpactMs: 0,
      nextEventMs: lifecycle.nextStartMs,
    };
  }

  return endedFrame(lines, canonicalActiveIndex);
}
