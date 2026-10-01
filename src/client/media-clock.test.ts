import {
  createMediaClock,
  rebaseMediaClock,
  sampleMediaClock,
  wallDelayForMediaDelta,
} from './media-clock.js';

describe('media clock correction', () => {
  it.each([1, 200, 350, 351, 400, 800, 1_000])(
    'absorbs a %i ms backward report without reversing or slowing below 0.8',
    (lagMs) => {
      const clock = rebaseMediaClock(createMediaClock(10_000, true, 0), 10_100 - lagMs, true, 100);
      expect(sampleMediaClock(clock, 100)).toBe(10_100);
      let previous = sampleMediaClock(clock, 100);
      for (let now = 110; now <= 6_100; now += 10) {
        const elapsed = sampleMediaClock(clock, now);
        expect(elapsed - previous).toBeGreaterThanOrEqual(8 - 1e-8);
        expect(elapsed - previous).toBeLessThanOrEqual(10 + 1e-8);
        previous = elapsed;
      }
      expect(sampleMediaClock(clock, 6_100)).toBeCloseTo(16_100 - lagMs);
    },
  );

  it('absorbs 400 ms in two seconds, then returns to normal speed', () => {
    const clock = rebaseMediaClock(createMediaClock(10_000, true, 0), 9_600, true, 0);
    expect(sampleMediaClock(clock, 1_000)).toBeCloseTo(10_800);
    expect(sampleMediaClock(clock, 2_000)).toBeCloseTo(11_600);
    expect(sampleMediaClock(clock, 3_000)).toBeCloseTo(12_600);
  });

  it('keeps progressing through repeated reports on the corrected trajectory', () => {
    let clock = createMediaClock(10_000, true, 0);
    for (let now = 0; now <= 8_000; now += 250) {
      const before = sampleMediaClock(clock, now);
      clock = rebaseMediaClock(clock, 9_200 + now, true, now);
      expect(sampleMediaClock(clock, now)).toBeCloseTo(before);
      expect(sampleMediaClock(clock, now + 250) - before).toBeGreaterThanOrEqual(200 - 1e-8);
    }
    expect(sampleMediaClock(clock, 9_000)).toBeCloseTo(18_200);
  });

  it.each([
    [0, 400, 500],
    [1_000, 400, 500],
    [1_000, 1_800, 2_000],
    [2_500, 500, 500],
  ])('schedules a media event from %i ms through the correction window', (now, delta, delay) => {
    const clock = rebaseMediaClock(createMediaClock(10_000, true, 0), 9_600, true, 0);
    expect(wallDelayForMediaDelta(clock, now, delta)).toBeCloseTo(delay);
    expect(sampleMediaClock(clock, now + delay) - sampleMediaClock(clock, now)).toBeCloseTo(delta);
  });

  it('immediately honors large backward seeks, including during correction', () => {
    const clock = rebaseMediaClock(createMediaClock(10_000, true, 0), 9_600, true, 0);
    const seek = rebaseMediaClock(clock, 9_799, true, 1_000);
    expect(sampleMediaClock(seek, 1_000)).toBe(9_799);
    expect(sampleMediaClock(seek, 2_000)).toBe(10_799);
  });

  it.each([350, 351, 850, 1_000, 1_001])('immediately restarts at zero after %i ms', (now) => {
    const restarted = rebaseMediaClock(createMediaClock(0, true, 0), 0, true, now);
    expect(sampleMediaClock(restarted, now)).toBe(0);
    expect(sampleMediaClock(restarted, now + 100)).toBe(100);
  });

  it('preserves forward correction and immediate forward seek behavior', () => {
    const clock = createMediaClock(10_000, true, 0);
    const smooth = rebaseMediaClock(clock, 10_350, true, 0);
    expect(sampleMediaClock(smooth, 0)).toBe(10_000);
    expect(sampleMediaClock(smooth, 1_000)).toBe(11_350);
    expect(sampleMediaClock(rebaseMediaClock(clock, 10_351, true, 0), 0)).toBe(10_351);
  });

  it('anchors pause and resume to the reported time and discards pending correction', () => {
    const clock = rebaseMediaClock(createMediaClock(10_000, true, 0), 9_600, true, 0);
    const paused = rebaseMediaClock(clock, 10_100, false, 500);
    expect(sampleMediaClock(paused, 3_000)).toBe(10_100);
    const resumed = rebaseMediaClock(paused, 10_200, true, 3_000);
    expect(sampleMediaClock(resumed, 3_000)).toBe(10_200);
    expect(sampleMediaClock(resumed, 4_000)).toBe(11_200);
  });
});
