import type { LyricLine } from '../shared/contracts.js';
import {
  computeLyricFrame,
  lyricGroupEnd,
  lyricGroupStart,
  lyricHandoffLeadMs,
} from './lyrics-motion.js';

const lines: LyricLine[] = [
  { id: '0', startMs: 2_000, text: 'First line' },
  { id: '1', startMs: 7_000, text: 'Second line' },
  { id: '2', startMs: 20_000, text: 'Last line' },
];

describe('computeLyricFrame', () => {
  it('previews the first line with the same bounded handoff used between lines', () => {
    expect(computeLyricFrame(lines, 1_379)).toMatchObject({
      anchorIndex: 0,
      focusIndex: null,
      incomingIndex: null,
      phase: 'preroll',
      nextEventMs: 1_380,
    });
    expect(computeLyricFrame(lines, 1_380)).toMatchObject({
      anchorIndex: 0,
      incomingIndex: 0,
      phase: 'preroll',
      phaseStartMs: 1_380,
      phaseEndMs: 2_000,
      nextEventMs: 2_000,
    });
    expect(computeLyricFrame(lines, 2_000)).toMatchObject({
      anchorIndex: 0,
      focusIndex: 0,
      incomingIndex: null,
      phase: 'active',
      activeStartMs: 2_000,
      focusImpactMs: 680,
    });
  });

  it('uses the manual offset when selecting a line', () => {
    expect(computeLyricFrame(lines, 6_500, 500).focusIndex).toBe(1);
    expect(computeLyricFrame(lines, 7_250, -500).focusIndex).toBe(0);
  });

  it('honors a negative offset before a zero-timestamp first line', () => {
    const zeroStart: LyricLine[] = [
      { id: 'zero', startMs: 0, text: 'Wait for it' },
    ];

    expect(computeLyricFrame(zeroStart, 499, -500, 10_000)).toMatchObject({
      focusIndex: null,
      incomingIndex: null,
      phase: 'preroll',
      nextEventMs: 0,
    });
    expect(computeLyricFrame(zeroStart, 500, -500, 10_000)).toMatchObject({
      focusIndex: 0,
      phase: 'active',
    });
  });

  it('keeps the current line focused through an unlabeled long gap', () => {
    expect(computeLyricFrame(lines, 12_200)).toMatchObject({
      anchorIndex: 1,
      focusIndex: 1,
      phase: 'active',
      nextEventMs: 19_380,
    });
    expect(computeLyricFrame(lines, 19_379)).toMatchObject({
      anchorIndex: 1,
      focusIndex: 1,
      phase: 'active',
      nextEventMs: 19_380,
    });
  });

  it('coordinates outgoing, incoming, and track movement in one handoff window', () => {
    expect(computeLyricFrame(lines, 19_379).phase).toBe('active');
    expect(computeLyricFrame(lines, 19_380)).toMatchObject({
      anchorIndex: 2,
      focusIndex: 1,
      incomingIndex: 2,
      outgoingIndex: 1,
      phase: 'handoff',
      phaseStartMs: 19_380,
      phaseEndMs: 20_000,
      nextEventMs: 20_000,
    });
    expect(computeLyricFrame(lines, 20_000)).toMatchObject({
      anchorIndex: 2,
      focusIndex: 2,
      incomingIndex: null,
      outgoingIndex: 1,
      phase: 'settle',
      phaseEndMs: 20_180,
      nextEventMs: 20_180,
    });
    expect(computeLyricFrame(lines, 20_180).phase).toBe('active');
  });

  it('does not infer different focus endings from lyric length', () => {
    const shortText: LyricLine[] = [
      { id: 'short', startMs: 0, text: 'Ah' },
      { id: 'next', startMs: 10_000, text: 'Next' },
    ];
    const longText: LyricLine[] = [
      { id: 'long', startMs: 0, text: 'A much longer lyric line with many more words' },
      { id: 'next', startMs: 10_000, text: 'Next' },
    ];

    expect(computeLyricFrame(shortText, 8_000)).toMatchObject({
      focusIndex: 0,
      phase: 'active',
      nextEventMs: 9_380,
    });
    expect(computeLyricFrame(longText, 8_000)).toMatchObject({
      focusIndex: 0,
      phase: 'active',
      nextEventMs: 9_380,
    });
  });

  it('compresses very fast lyrics without overlapping adjacent handoffs', () => {
    const fastLines: LyricLine[] = [
      { id: 'fast-0', startMs: 0, text: 'Go' },
      { id: 'fast-1', startMs: 200, text: 'Right' },
      { id: 'fast-2', startMs: 400, text: 'Now' },
    ];

    expect(lyricHandoffLeadMs(200)).toBe(88);
    expect(computeLyricFrame(fastLines, 111)).toMatchObject({
      anchorIndex: 0,
      focusIndex: 0,
      phase: 'active',
      nextEventMs: 112,
    });
    expect(computeLyricFrame(fastLines, 112)).toMatchObject({
      anchorIndex: 1,
      incomingIndex: 1,
      outgoingIndex: 0,
      phase: 'handoff',
      phaseEndMs: 200,
    });
    expect(computeLyricFrame(fastLines, 200)).toMatchObject({
      anchorIndex: 1,
      focusIndex: 1,
      outgoingIndex: 0,
      phase: 'settle',
      focusImpactMs: 112,
      nextEventMs: 312,
    });
    expect(computeLyricFrame(fastLines, 312)).toMatchObject({
      anchorIndex: 2,
      incomingIndex: 2,
      outgoingIndex: 1,
      phase: 'handoff',
    });
  });

  it('keeps every line in an equal-timestamp group in the same focus lifecycle', () => {
    const grouped: LyricLine[] = [
      { id: 'group-0', startMs: 0, text: 'Lead in' },
      { id: 'group-1', startMs: 1_000, text: 'Backing line' },
      { id: 'group-2', startMs: 1_000, text: 'Main line' },
      { id: 'group-3', startMs: 2_000, text: 'After group' },
    ];

    expect(lyricGroupStart(grouped, 2)).toBe(1);
    expect(lyricGroupEnd(grouped, 1)).toBe(2);
    expect(computeLyricFrame(grouped, 620)).toMatchObject({
      anchorStartIndex: 1,
      anchorIndex: 2,
      incomingStartIndex: 1,
      incomingIndex: 2,
      outgoingStartIndex: 0,
      outgoingIndex: 0,
      phase: 'handoff',
    });
    expect(computeLyricFrame(grouped, 1_000)).toMatchObject({
      anchorStartIndex: 1,
      anchorIndex: 2,
      focusStartIndex: 1,
      focusIndex: 2,
      outgoingIndex: 0,
      phase: 'settle',
    });
  });

  it('snaps focus only at lyric timestamps when reduced motion is requested', () => {
    const shortLines: LyricLine[] = [
      { id: 'short-0', startMs: 0, text: 'First' },
      { id: 'short-1', startMs: 1_000, text: 'Second' },
    ];

    expect(computeLyricFrame(shortLines, 850).phase).toBe('handoff');
    expect(computeLyricFrame(shortLines, 850, 0, 10_000, { reducedMotion: true })).toMatchObject({
      anchorIndex: 0,
      focusIndex: 0,
      incomingIndex: null,
      phase: 'active',
      nextEventMs: 1_000,
    });
    expect(computeLyricFrame(shortLines, 1_000, 0, 10_000, { reducedMotion: true })).toMatchObject({
      anchorIndex: 1,
      focusIndex: 1,
      phase: 'active',
    });
  });

  it('keeps the last line focused until the track ends', () => {
    expect(computeLyricFrame(lines, 39_999, 0, 40_000)).toMatchObject({
      anchorIndex: 2,
      focusIndex: 2,
      phase: 'active',
      nextEventMs: 40_000,
    });
    expect(computeLyricFrame(lines, 40_000, 0, 40_000)).toMatchObject({
      anchorIndex: 2,
      focusIndex: null,
      phase: 'ended',
      nextEventMs: null,
    });
  });

  it('keeps the last line focused indefinitely when track duration is unknown', () => {
    expect(computeLyricFrame(lines, 120_000)).toMatchObject({
      anchorIndex: 2,
      focusIndex: 2,
      phase: 'active',
      phaseEndMs: null,
      activeEndMs: null,
      nextEventMs: null,
    });
  });

  it('keeps the last line focused before an earlier song ending', () => {
    expect(computeLyricFrame(lines, 22_999, 0, 23_000).phase).toBe('active');
    expect(computeLyricFrame(lines, 23_000, 0, 23_000).phase).toBe('ended');
  });

  it('keeps the song end reachable with either manual offset direction', () => {
    expect(computeLyricFrame(lines, 23_000, 500, 23_000)).toMatchObject({
      phase: 'ended',
      nextEventMs: null,
    });
    expect(computeLyricFrame(lines, 23_000, -500, 23_000)).toMatchObject({
      phase: 'ended',
      nextEventMs: null,
    });
  });

  it('does not schedule unreachable lyrics beyond the adjusted song end', () => {
    expect(computeLyricFrame(lines, 19_000, -500, 19_500)).toMatchObject({
      anchorIndex: 1,
      focusIndex: 1,
      phase: 'active',
      nextEventMs: 19_000,
    });
  });

  it('does not preview a first lyric that is beyond the song ending', () => {
    const lateLines: LyricLine[] = [
      { id: 'late', startMs: 12_000, text: 'Never reached' },
    ];

    expect(computeLyricFrame(lateLines, 9_800, 0, 10_000)).toMatchObject({
      anchorIndex: 0,
      focusIndex: null,
      incomingIndex: null,
      phase: 'ended',
      nextEventMs: null,
    });
  });

  it('handles an empty lyric set', () => {
    expect(computeLyricFrame([], 0)).toMatchObject({
      anchorIndex: -1,
      focusIndex: null,
      phase: 'ended',
      nextEventMs: null,
    });
  });
});
