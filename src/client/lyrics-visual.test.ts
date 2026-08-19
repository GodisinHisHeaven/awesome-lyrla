import type { LyricLine } from '../shared/contracts.js';
import { computeLyricFrame } from './lyrics-motion.js';
import {
  depthVisual,
  lyricTrackProgress,
  lyricVisualNeedsAnimation,
  resolveLyricLineVisual,
} from './lyrics-visual.js';
import type { LyricLineVisual } from './lyrics-visual.js';

const lines: LyricLine[] = [
  { id: '0', startMs: 0, text: 'First line' },
  { id: '1', startMs: 5_000, text: 'Second line' },
];

function visualAt(lineIndex: number, elapsedMs: number, normalizedDistance = 0) {
  return resolveLyricLineVisual({
    frame: computeLyricFrame(lines, elapsedMs),
    lineIndex,
    lyricElapsedMs: elapsedMs,
    normalizedDistance,
    direction: lineIndex === 0 ? 'past' : 'future',
    reducedMotion: false,
  });
}

function expectVisualClose(actual: LyricLineVisual, expected: LyricLineVisual): void {
  for (const key of Object.keys(expected) as Array<keyof LyricLineVisual>) {
    expect(actual[key]).toBeCloseTo(expected[key], 12);
  }
}

describe('line-level lyric visuals', () => {
  it('uses one media-time progress value for the track handoff', () => {
    const frame = computeLyricFrame(lines, 4_380);

    expect(frame).toMatchObject({
      phase: 'handoff',
      phaseStartMs: 4_380,
      phaseEndMs: 5_000,
    });
    expect(lyricTrackProgress(frame, 4_380)).toBe(0);
    expect(lyricTrackProgress(frame, 4_690)).toBeCloseTo(0.875, 3);
    expect(lyricTrackProgress(frame, 5_000)).toBe(1);
  });

  it('settles an active line with a single short focus impact instead of looping', () => {
    const frame = computeLyricFrame(lines, 0);
    const start = visualAt(0, 0);
    const peak = visualAt(0, Math.round(frame.focusImpactMs * 0.24));
    const settled = visualAt(0, frame.focusImpactMs);

    expect(start).toMatchObject({ opacity: 0.72, scale: 0.992, translateYPx: 1.5 });
    expect(peak.opacity).toBeCloseTo(1, 3);
    expect(peak.scale).toBeCloseTo(1.006, 3);
    expect(peak.glowAlpha).toBeCloseTo(0.14, 3);
    expect(settled).toMatchObject({ opacity: 0.99, scale: 1, translateYPx: 0 });
    expect(lyricVisualNeedsAnimation(frame, frame.focusImpactMs - 1)).toBe(true);
    expect(lyricVisualNeedsAnimation(frame, frame.focusImpactMs)).toBe(false);
  });

  it('moves the track without dimming the outgoing line before the next timestamp', () => {
    const startMs = 4_380;
    const endMs = 5_000;
    const startFrame = computeLyricFrame(lines, startMs);
    const outgoingStart = resolveLyricLineVisual({
      frame: startFrame,
      lineIndex: 0,
      lyricElapsedMs: startMs,
      normalizedDistance: 0,
      direction: 'past',
      reducedMotion: false,
    });
    const outgoingMid = resolveLyricLineVisual({
      frame: startFrame,
      lineIndex: 0,
      lyricElapsedMs: (startMs + endMs) / 2,
      normalizedDistance: 0.15,
      direction: 'past',
      reducedMotion: false,
    });
    const outgoingEnd = resolveLyricLineVisual({
      frame: startFrame,
      lineIndex: 0,
      lyricElapsedMs: endMs - 1,
      normalizedDistance: 0.3,
      direction: 'past',
      reducedMotion: false,
    });
    const incomingStart = resolveLyricLineVisual({
      frame: startFrame,
      lineIndex: 1,
      lyricElapsedMs: startMs,
      normalizedDistance: 0.3,
      direction: 'future',
      reducedMotion: false,
    });
    const incomingEnd = resolveLyricLineVisual({
      frame: startFrame,
      lineIndex: 1,
      lyricElapsedMs: endMs,
      normalizedDistance: 0,
      direction: 'future',
      reducedMotion: false,
    });
    const landedFrame = computeLyricFrame(lines, endMs);
    const outgoingLanded = resolveLyricLineVisual({
      frame: landedFrame,
      lineIndex: 0,
      lyricElapsedMs: endMs,
      normalizedDistance: 0.3,
      direction: 'past',
      reducedMotion: false,
    });
    const incomingLanded = resolveLyricLineVisual({
      frame: landedFrame,
      lineIndex: 1,
      lyricElapsedMs: endMs,
      normalizedDistance: 0,
      direction: 'future',
      reducedMotion: false,
    });
    const outgoingTailEnd = resolveLyricLineVisual({
      frame: landedFrame,
      lineIndex: 0,
      lyricElapsedMs: endMs + 180,
      normalizedDistance: 0.3,
      direction: 'past',
      reducedMotion: false,
    });
    const settledFrame = computeLyricFrame(lines, endMs + 180);
    const outgoingSettled = resolveLyricLineVisual({
      frame: settledFrame,
      lineIndex: 0,
      lyricElapsedMs: endMs + 180,
      normalizedDistance: 0.3,
      direction: 'past',
      reducedMotion: false,
    });

    expect(startFrame.outgoingStartsFocused).toBe(true);
    expect(outgoingStart.opacity).toBeCloseTo(0.99, 3);
    expect(outgoingMid).toMatchObject({ opacity: 0.99, blurPx: 0, scale: 1 });
    expect(outgoingEnd).toMatchObject({ opacity: 0.99, blurPx: 0, scale: 1 });
    expect(incomingEnd).toMatchObject({ opacity: 0.72, scale: 0.992, translateYPx: 1.5 });
    expect(incomingStart.opacity).toBeLessThan(incomingEnd.opacity);
    expect(landedFrame.phase).toBe('settle');
    expectVisualClose(outgoingEnd, outgoingLanded);
    expectVisualClose(incomingEnd, incomingLanded);
    expectVisualClose(outgoingTailEnd, outgoingSettled);
  });

  it('keeps an outgoing line highlighted through a long-gap handoff', () => {
    const longGapLines: LyricLine[] = [
      { id: 'long-gap-0', startMs: 0, text: 'Hold through the quiet' },
      { id: 'long-gap-1', startMs: 10_000, text: 'Return' },
    ];
    const frame = computeLyricFrame(longGapLines, 9_380);
    const outgoing = resolveLyricLineVisual({
      frame,
      lineIndex: 0,
      lyricElapsedMs: 9_380,
      normalizedDistance: 0,
      direction: 'past',
      reducedMotion: false,
    });

    expect(frame.outgoingStartsFocused).toBe(true);
    expect(outgoing).toMatchObject({ opacity: 0.99, blurPx: 0, scale: 1 });
  });

  it('fades blur smoothly to none outside the visible depth range', () => {
    expect(depthVisual(0.5, 'future').blurPx).toBeGreaterThan(0);
    expect(depthVisual(0.54, 'future').blurPx).toBeLessThan(depthVisual(0.5, 'future').blurPx);
    expect(depthVisual(0.58, 'future').blurPx).toBe(0);
  });

  it('removes scale, blur, and glow in reduced-motion mode', () => {
    const frame = computeLyricFrame(lines, 0, 0, 10_000, { reducedMotion: true });
    const active = resolveLyricLineVisual({
      frame,
      lineIndex: 0,
      lyricElapsedMs: 0,
      normalizedDistance: 0,
      direction: 'past',
      reducedMotion: true,
    });
    const distant = depthVisual(0.2, 'future', true);

    expect(active).toMatchObject({ opacity: 0.99, blurPx: 0, scale: 1, glowAlpha: 0 });
    expect(distant.blurPx).toBe(0);
    expect(distant.scale).toBe(1);
    expect(distant.glowAlpha).toBe(0);
  });
});
