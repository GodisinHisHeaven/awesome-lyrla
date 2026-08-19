import {
  FixedDurationHistogram,
  RuntimePerformanceMonitor,
} from './runtime-performance.js';

describe('FixedDurationHistogram', () => {
  it('returns bounded-bucket percentiles, exact count, and exact maximum', () => {
    const histogram = new FixedDurationHistogram([10, 50, 100]);

    for (const duration of [1, 5, 10, 11, 49, 50, 51, 99, 100, 175]) {
      expect(histogram.observe(duration)).toBe(true);
    }

    expect(histogram.snapshot()).toEqual({
      count: 10,
      p50Ms: 50,
      p95Ms: 175,
      maxMs: 175,
    });
  });

  it('ignores invalid observations and can reset without reallocating labels', () => {
    const histogram = new FixedDurationHistogram([10, 100]);

    expect(histogram.observe(Number.NaN)).toBe(false);
    expect(histogram.observe(Number.POSITIVE_INFINITY)).toBe(false);
    expect(histogram.observe(-1)).toBe(false);
    expect(histogram.snapshot()).toEqual({
      count: 0,
      p50Ms: null,
      p95Ms: null,
      maxMs: null,
    });

    histogram.observe(25);
    histogram.reset();
    expect(histogram.snapshot().count).toBe(0);
  });

  it('rejects invalid bucket definitions', () => {
    expect(() => new FixedDurationHistogram([])).toThrow(/at least one/);
    expect(() => new FixedDurationHistogram([10, 10])).toThrow(/strictly increasing/);
    expect(() => new FixedDurationHistogram([-1, 10])).toThrow(/non-negative/);
  });
});

describe('RuntimePerformanceMonitor', () => {
  function createHarness() {
    let monotonicMs = 100;
    let wallClockMs = Date.parse('2026-07-22T12:00:00.000Z');
    let scheduledCallback: (() => void) | null = null;
    const intervalHandle = { unref: vi.fn() };
    const clearScheduledInterval = vi.fn();
    const memoryUsage = vi.fn((): NodeJS.MemoryUsage => ({
      rss: 100,
      heapTotal: 80,
      heapUsed: 50,
      external: 20,
      arrayBuffers: 10,
    }));

    const monitor = new RuntimePerformanceMonitor(['paletteTotal', 'imageDownload'] as const, {
      sampleIntervalMs: 1_000,
      durationBucketsMs: [10, 100, 1_000, 10_000],
      dependencies: {
        monotonicNow: () => monotonicMs,
        wallClockNow: () => new Date(wallClockMs),
        memoryUsage,
        scheduleInterval: (callback) => {
          scheduledCallback = callback;
          return intervalHandle;
        },
        clearScheduledInterval,
      },
    });

    return {
      monitor,
      intervalHandle,
      clearScheduledInterval,
      memoryUsage,
      advanceTo(nextMonotonicMs: number, nextWallClockMs = wallClockMs) {
        monotonicMs = nextMonotonicMs;
        wallClockMs = nextWallClockMs;
      },
      tick() {
        if (!scheduledCallback) throw new Error('monitor has not been started');
        scheduledCallback();
      },
    };
  }

  it('uses an unref interval and records event-loop scheduling delay', () => {
    const harness = createHarness();

    harness.monitor.start();
    harness.monitor.start();
    expect(harness.intervalHandle.unref).toHaveBeenCalledTimes(1);
    expect(harness.monitor.isRunning()).toBe(true);

    harness.advanceTo(1_350, Date.parse('2026-07-22T12:00:01.250Z'));
    harness.tick();
    const snapshot = harness.monitor.snapshot();

    expect(snapshot.monitoring).toBe(true);
    expect(snapshot.eventLoopDelay).toEqual({
      count: 1,
      p50Ms: 1_000,
      p95Ms: 1_000,
      maxMs: 250,
    });
    expect(snapshot.memory).toEqual({
      rssBytes: 100,
      heapUsedBytes: 50,
      heapTotalBytes: 80,
      externalBytes: 20,
      arrayBuffersBytes: 10,
    });
    expect(snapshot.sampledAt).toBe('2026-07-22T12:00:01.250Z');
  });

  it('keeps duration labels fixed and ignores unknown runtime labels', () => {
    const harness = createHarness();

    expect(harness.monitor.observeDuration('paletteTotal', 25)).toBe(true);
    expect(harness.monitor.observeDuration('imageDownload', 5)).toBe(true);
    expect(
      harness.monitor.observeDuration('unknown' as 'paletteTotal', 5),
    ).toBe(false);

    expect(harness.monitor.snapshot().durations).toEqual({
      paletteTotal: { count: 1, p50Ms: 100, p95Ms: 100, maxMs: 25 },
      imageDownload: { count: 1, p50Ms: 10, p95Ms: 10, maxMs: 5 },
    });
  });

  it('stops idempotently and can restart with a fresh expected tick', () => {
    const harness = createHarness();

    harness.monitor.start();
    harness.monitor.stop();
    harness.monitor.stop();
    expect(harness.clearScheduledInterval).toHaveBeenCalledTimes(1);
    expect(harness.monitor.isRunning()).toBe(false);

    harness.advanceTo(5_000);
    harness.monitor.start();
    harness.advanceTo(6_010);
    harness.tick();
    expect(harness.monitor.snapshot().eventLoopDelay.maxMs).toBe(10);
  });

  it('validates its sampling interval and metric names', () => {
    expect(
      () => new RuntimePerformanceMonitor(['duplicate', 'duplicate']),
    ).toThrow(/unique/);
    expect(
      () => new RuntimePerformanceMonitor([], { sampleIntervalMs: 0 }),
    ).toThrow(/positive/);
  });
});
