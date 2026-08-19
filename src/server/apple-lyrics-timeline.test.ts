import {
  appleLyricsTimelineAnomaly,
} from './apple-lyrics-timeline.js';

function lines(starts: readonly number[]) {
  return starts.map((startMs, index) => ({
    id: `line-${index}`,
    startMs,
    text: `Line ${index}`,
  }));
}

describe('appleLyricsTimelineAnomaly', () => {
  it('matches the duration-overrun tolerance and its inclusive boundary', () => {
    expect(appleLyricsTimelineAnomaly(
      lines([0, 198_000]),
      180_000,
    )).toBeNull();
    expect(appleLyricsTimelineAnomaly(
      lines([0, 210_000]),
      180_000,
    )).toBeNull();
    expect(appleLyricsTimelineAnomaly(
      lines([0, 210_001]),
      180_000,
    )).toBe('timestamp-duration-overrun');
  });

  it('does not let the long-track tolerance hide severe short-track overruns', () => {
    expect(appleLyricsTimelineAnomaly(
      lines([0, 12_500]),
      10_000,
    )).toBeNull();
    expect(appleLyricsTimelineAnomaly(
      lines([0, 12_501]),
      10_000,
    )).toBe('timestamp-duration-overrun');
  });

  it('rejects any two-second window containing at least 80 percent of 12 lines', () => {
    expect(appleLyricsTimelineAnomaly(
      lines([
        0, 150, 300, 450, 600, 750, 900, 1_050, 1_200, 1_350,
        60_000, 170_000,
      ]),
      180_000,
    )).toBe('collapsed-timeline-coverage');
  });

  it('does not reject a sub-80-percent cluster', () => {
    expect(appleLyricsTimelineAnomaly(
      lines([
        0, 150, 300, 450, 600, 750, 900, 1_050, 1_200,
        60_000, 120_000, 170_000,
      ]),
      180_000,
    )).toBeNull();
  });

  it('uses the duration-relative collapse window and one-minute boundary', () => {
    const tenAtBoundary = [
      0, 120, 240, 360, 480, 600, 720, 840, 960, 1_200,
      30_000, 59_000,
    ];
    expect(appleLyricsTimelineAnomaly(
      lines(tenAtBoundary),
      59_999,
    )).toBeNull();
    expect(appleLyricsTimelineAnomaly(
      lines(tenAtBoundary),
      60_000,
    )).toBe('collapsed-timeline-coverage');
  });

  it('rejects a fully collapsed sparse timeline without requiring a one-minute song', () => {
    expect(appleLyricsTimelineAnomaly(
      lines(Array.from({ length: 11 }, (_, index) => index * 100)),
      180_000,
    )).toBe('collapsed-timeline-coverage');
    expect(appleLyricsTimelineAnomaly(
      lines(Array.from({ length: 12 }, (_, index) => index * 50)),
      30_000,
    )).toBe('collapsed-timeline-coverage');
  });

  it('uses a conservative all-lines rule for sparse songs', () => {
    expect(appleLyricsTimelineAnomaly(
      lines([
        ...Array.from({ length: 10 }, (_, index) => index * 100),
        120_000,
      ]),
      180_000,
    )).toBeNull();
    expect(appleLyricsTimelineAnomaly(
      lines(Array.from({ length: 5 }, (_, index) => index * 100)),
      180_000,
    )).toBeNull();
  });

  it('does not infer timing quality from missing or non-credible duration metadata', () => {
    const collapsed = lines(Array.from({ length: 12 }, (_, index) => index * 100));
    expect(appleLyricsTimelineAnomaly(collapsed, 0)).toBeNull();
    expect(appleLyricsTimelineAnomaly(collapsed, Number.NaN)).toBeNull();
    expect(appleLyricsTimelineAnomaly(collapsed, 86_400_001)).toBeNull();
  });
});
