import type { LyricFrame } from './lyrics-motion.js';
import { lyricPhaseProgress } from './lyrics-motion.js';

export interface LyricLineVisual {
  opacity: number;
  blurPx: number;
  scale: number;
  translateYPx: number;
  glowAlpha: number;
  glowRadiusPx: number;
}

export type LyricLineDirection = 'past' | 'future';

interface ResolveLyricLineVisualOptions {
  frame: LyricFrame;
  lineIndex: number;
  lyricElapsedMs: number;
  normalizedDistance: number;
  direction: LyricLineDirection;
  reducedMotion: boolean;
}

const ENTRY_START: LyricLineVisual = {
  opacity: 0.72,
  blurPx: 0.26,
  scale: 0.992,
  translateYPx: 1.5,
  glowAlpha: 0,
  glowRadiusPx: 0,
};

const ENTRY_PEAK: LyricLineVisual = {
  opacity: 1,
  blurPx: 0,
  scale: 1.006,
  translateYPx: -0.6,
  glowAlpha: 0.14,
  glowRadiusPx: 16,
};

const ACTIVE_SETTLED: LyricLineVisual = {
  opacity: 0.99,
  blurPx: 0,
  scale: 1,
  translateYPx: 0,
  glowAlpha: 0.02,
  glowRadiusPx: 7,
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function lerp(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}

function easeOutCubic(progress: number): number {
  return 1 - (1 - clamp01(progress)) ** 3;
}

function easeInOut(progress: number): number {
  const value = clamp01(progress);
  return value < 0.5
    ? 4 * value ** 3
    : 1 - (-2 * value + 2) ** 3 / 2;
}

function interpolateVisual(
  from: LyricLineVisual,
  to: LyricLineVisual,
  progress: number,
): LyricLineVisual {
  const value = clamp01(progress);
  return {
    opacity: lerp(from.opacity, to.opacity, value),
    blurPx: lerp(from.blurPx, to.blurPx, value),
    scale: lerp(from.scale, to.scale, value),
    translateYPx: lerp(from.translateYPx, to.translateYPx, value),
    glowAlpha: lerp(from.glowAlpha, to.glowAlpha, value),
    glowRadiusPx: lerp(from.glowRadiusPx, to.glowRadiusPx, value),
  };
}

function isInGroup(lineIndex: number, startIndex: number | null, endIndex: number | null): boolean {
  return startIndex !== null
    && endIndex !== null
    && lineIndex >= startIndex
    && lineIndex <= endIndex;
}

export function lyricTrackProgress(frame: LyricFrame, lyricElapsedMs: number): number {
  if (frame.phase !== 'handoff') return 1;
  return easeOutCubic(lyricPhaseProgress(lyricElapsedMs, frame.phaseStartMs, frame.phaseEndMs));
}

export function depthVisual(
  normalizedDistance: number,
  direction: LyricLineDirection,
  reducedMotion = false,
): LyricLineVisual {
  const distance = Math.max(0, normalizedDistance);
  const nearProgress = clamp01(distance / 0.5);
  const opacityNear = direction === 'future' ? 0.38 : 0.22;
  const opacityFar = direction === 'future' ? 0.065 : 0.05;
  const opacity = lerp(opacityNear, opacityFar, easeOutCubic(nearProgress));
  let blurPx = 0;
  if (!reducedMotion && distance < 0.58) {
    blurPx = distance <= 0.32
      ? lerp(0.18, 0.9, easeOutCubic(distance / 0.32))
      : lerp(0.9, 0, easeInOut((distance - 0.32) / 0.26));
  }
  return {
    opacity,
    blurPx,
    scale: reducedMotion ? 1 : lerp(0.99, 0.976, nearProgress),
    translateYPx: 0,
    glowAlpha: 0,
    glowRadiusPx: 0,
  };
}

function activeImpactVisual(frame: LyricFrame, lyricElapsedMs: number): LyricLineVisual {
  if (frame.activeStartMs === null || frame.focusImpactMs <= 0) return ACTIVE_SETTLED;
  const progress = clamp01((lyricElapsedMs - frame.activeStartMs) / frame.focusImpactMs);
  if (progress <= 0.24) {
    return interpolateVisual(ENTRY_START, ENTRY_PEAK, easeOutCubic(progress / 0.24));
  }
  return interpolateVisual(
    ENTRY_PEAK,
    ACTIVE_SETTLED,
    easeInOut((progress - 0.24) / 0.76),
  );
}

export function resolveLyricLineVisual({
  frame,
  lineIndex,
  lyricElapsedMs,
  normalizedDistance,
  direction,
  reducedMotion,
}: ResolveLyricLineVisualOptions): LyricLineVisual {
  const depth = depthVisual(normalizedDistance, direction, reducedMotion);
  const isFocused = isInGroup(lineIndex, frame.focusStartIndex, frame.focusIndex);
  const isIncoming = isInGroup(lineIndex, frame.incomingStartIndex, frame.incomingIndex);
  const isOutgoing = isInGroup(lineIndex, frame.outgoingStartIndex, frame.outgoingIndex);

  if (reducedMotion) {
    if (frame.phase === 'active' && isFocused) return { ...ACTIVE_SETTLED, glowAlpha: 0, glowRadiusPx: 0 };
    return depth;
  }

  if (frame.phase === 'active' && isFocused) {
    return activeImpactVisual(frame, lyricElapsedMs);
  }

  if (frame.phase === 'settle') {
    const progress = easeOutCubic(lyricPhaseProgress(
      lyricElapsedMs,
      frame.phaseStartMs,
      frame.phaseEndMs,
    ));
    if (isOutgoing) return interpolateVisual(ACTIVE_SETTLED, depth, progress);
    if (isFocused) return activeImpactVisual(frame, lyricElapsedMs);
  }

  if (frame.phase === 'handoff') {
    const progress = lyricTrackProgress(frame, lyricElapsedMs);
    if (isOutgoing) {
      if (!frame.outgoingStartsFocused) return depth;
      return ACTIVE_SETTLED;
    }
    if (isIncoming) {
      const delayedProgress = easeOutCubic(clamp01((progress - 0.46) / 0.54));
      return interpolateVisual(depth, ENTRY_START, delayedProgress);
    }
  }

  if (frame.phase === 'preroll' && isIncoming) {
    const progress = easeOutCubic(lyricPhaseProgress(
      lyricElapsedMs,
      frame.phaseStartMs,
      frame.phaseEndMs,
    ));
    return interpolateVisual(depth, ENTRY_START, progress);
  }

  return depth;
}

export function lyricVisualNeedsAnimation(frame: LyricFrame, lyricElapsedMs: number): boolean {
  if (frame.phase === 'handoff' || frame.phase === 'settle') return true;
  if (frame.phase === 'preroll') return frame.incomingIndex !== null;
  return frame.phase === 'active'
    && frame.activeStartMs !== null
    && lyricElapsedMs < frame.activeStartMs + frame.focusImpactMs;
}
