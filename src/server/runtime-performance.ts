import { performance } from 'node:perf_hooks';

const DEFAULT_DURATION_BUCKETS_MS = Object.freeze([
  1,
  2,
  5,
  10,
  20,
  50,
  100,
  250,
  500,
  1_000,
  2_000,
  5_000,
  10_000,
  15_000,
  30_000,
  60_000,
]);

const DEFAULT_SAMPLE_INTERVAL_MS = 5_000;

export interface DurationStats {
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

export interface RuntimeMemoryStats {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
}

export interface RuntimePerformanceSnapshot<MetricName extends string> {
  monitoring: boolean;
  sampledAt: string;
  durations: Record<MetricName, DurationStats>;
  eventLoopDelay: DurationStats;
  memory: RuntimeMemoryStats;
}

interface IntervalHandle {
  unref(): unknown;
}

interface RuntimePerformanceDependencies {
  monotonicNow: () => number;
  wallClockNow: () => Date;
  memoryUsage: () => NodeJS.MemoryUsage;
  scheduleInterval: (callback: () => void, intervalMs: number) => IntervalHandle;
  clearScheduledInterval: (handle: IntervalHandle) => void;
}

export interface RuntimePerformanceOptions {
  sampleIntervalMs?: number;
  durationBucketsMs?: readonly number[];
  /** Injection point used by deterministic tests. Production callers should omit it. */
  dependencies?: Partial<RuntimePerformanceDependencies>;
}

function emptyDurationStats(): DurationStats {
  return {
    count: 0,
    p50Ms: null,
    p95Ms: null,
    maxMs: null,
  };
}

function validateBuckets(input: readonly number[]): number[] {
  if (input.length === 0) {
    throw new Error('durationBucketsMs must contain at least one upper bound');
  }

  const buckets = [...input];
  for (let index = 0; index < buckets.length; index += 1) {
    const value = buckets[index];
    if (!Number.isFinite(value) || value < 0) {
      throw new Error('durationBucketsMs must contain finite non-negative values');
    }
    if (index > 0 && value <= buckets[index - 1]) {
      throw new Error('durationBucketsMs must be strictly increasing');
    }
  }
  return buckets;
}

/**
 * Constant-memory duration histogram. Percentiles are returned as the upper
 * bound of the bucket containing the requested rank; the exact maximum is kept
 * separately. Values beyond the final bucket use the observed maximum.
 */
export class FixedDurationHistogram {
  private readonly bucketsMs: readonly number[];
  private readonly bucketCounts: Float64Array;
  private count = 0;
  private maximumMs: number | null = null;

  constructor(bucketsMs: readonly number[] = DEFAULT_DURATION_BUCKETS_MS) {
    this.bucketsMs = validateBuckets(bucketsMs);
    // The extra element is an overflow bucket, so observations are never lost.
    this.bucketCounts = new Float64Array(this.bucketsMs.length + 1);
  }

  observe(durationMs: number): boolean {
    if (!Number.isFinite(durationMs) || durationMs < 0) return false;

    let low = 0;
    let high = this.bucketsMs.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (durationMs <= this.bucketsMs[middle]) high = middle;
      else low = middle + 1;
    }

    this.bucketCounts[low] += 1;
    this.count += 1;
    this.maximumMs = this.maximumMs === null
      ? durationMs
      : Math.max(this.maximumMs, durationMs);
    return true;
  }

  snapshot(): DurationStats {
    if (this.count === 0 || this.maximumMs === null) return emptyDurationStats();
    return {
      count: this.count,
      p50Ms: this.percentile(0.5),
      p95Ms: this.percentile(0.95),
      maxMs: this.maximumMs,
    };
  }

  reset(): void {
    this.bucketCounts.fill(0);
    this.count = 0;
    this.maximumMs = null;
  }

  private percentile(fraction: number): number {
    const rank = Math.max(1, Math.ceil(this.count * fraction));
    let cumulative = 0;
    for (let index = 0; index < this.bucketCounts.length; index += 1) {
      cumulative += this.bucketCounts[index];
      if (cumulative < rank) continue;
      return index < this.bucketsMs.length
        ? this.bucketsMs[index]
        : (this.maximumMs ?? 0);
    }
    return this.maximumMs ?? 0;
  }
}

function toMemoryStats(memory: NodeJS.MemoryUsage): RuntimeMemoryStats {
  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
  };
}

/**
 * Lightweight process monitor plus a fixed-cardinality duration registry.
 * One unref'ed interval records event-loop scheduling delay and memory usage.
 */
export class RuntimePerformanceMonitor<MetricName extends string> {
  private readonly durationHistograms = new Map<MetricName, FixedDurationHistogram>();
  private readonly eventLoopDelay: FixedDurationHistogram;
  private readonly sampleIntervalMs: number;
  private readonly dependencies: RuntimePerformanceDependencies;
  private interval: IntervalHandle | null = null;
  private expectedTickAtMs: number | null = null;
  private memory: RuntimeMemoryStats;
  private sampledAt: Date;

  constructor(metricNames: readonly MetricName[], options: RuntimePerformanceOptions = {}) {
    const sampleIntervalMs = options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
    if (!Number.isFinite(sampleIntervalMs) || sampleIntervalMs <= 0) {
      throw new Error('sampleIntervalMs must be a finite positive number');
    }

    const durationBuckets = validateBuckets(
      options.durationBucketsMs ?? DEFAULT_DURATION_BUCKETS_MS,
    );
    const dependencies = options.dependencies ?? {};
    this.dependencies = {
      monotonicNow: dependencies.monotonicNow ?? (() => performance.now()),
      wallClockNow: dependencies.wallClockNow ?? (() => new Date()),
      memoryUsage: dependencies.memoryUsage ?? (() => process.memoryUsage()),
      scheduleInterval: dependencies.scheduleInterval
        ?? ((callback, intervalMs) => setInterval(callback, intervalMs)),
      clearScheduledInterval: dependencies.clearScheduledInterval
        ?? ((handle) => clearInterval(handle as NodeJS.Timeout)),
    };
    this.sampleIntervalMs = sampleIntervalMs;
    this.eventLoopDelay = new FixedDurationHistogram(durationBuckets);

    const uniqueNames = new Set(metricNames);
    if (uniqueNames.size !== metricNames.length) {
      throw new Error('duration metric names must be unique');
    }
    for (const name of metricNames) {
      this.durationHistograms.set(name, new FixedDurationHistogram(durationBuckets));
    }

    this.sampledAt = this.dependencies.wallClockNow();
    this.memory = toMemoryStats(this.dependencies.memoryUsage());
  }

  start(): void {
    if (this.interval) return;
    this.expectedTickAtMs = this.dependencies.monotonicNow() + this.sampleIntervalMs;
    const handle = this.dependencies.scheduleInterval(() => {
      this.captureRuntimeSample();
    }, this.sampleIntervalMs);
    handle.unref();
    this.interval = handle;
  }

  stop(): void {
    if (!this.interval) return;
    this.dependencies.clearScheduledInterval(this.interval);
    this.interval = null;
    this.expectedTickAtMs = null;
  }

  isRunning(): boolean {
    return this.interval !== null;
  }

  observeDuration(name: MetricName, durationMs: number): boolean {
    return this.durationHistograms.get(name)?.observe(durationMs) ?? false;
  }

  snapshot(): RuntimePerformanceSnapshot<MetricName> {
    this.captureMemorySample();
    const durations = {} as Record<MetricName, DurationStats>;
    for (const [name, histogram] of this.durationHistograms) {
      durations[name] = histogram.snapshot();
    }
    return {
      monitoring: this.isRunning(),
      sampledAt: this.sampledAt.toISOString(),
      durations,
      eventLoopDelay: this.eventLoopDelay.snapshot(),
      memory: { ...this.memory },
    };
  }

  resetDurations(): void {
    for (const histogram of this.durationHistograms.values()) histogram.reset();
    this.eventLoopDelay.reset();
  }

  private captureRuntimeSample(): void {
    const now = this.dependencies.monotonicNow();
    if (this.expectedTickAtMs !== null) {
      this.eventLoopDelay.observe(Math.max(0, now - this.expectedTickAtMs));
    }
    // Reset from the actual callback time so one long stall is counted once.
    this.expectedTickAtMs = now + this.sampleIntervalMs;
    this.captureMemorySample();
  }

  private captureMemorySample(): void {
    this.memory = toMemoryStats(this.dependencies.memoryUsage());
    this.sampledAt = this.dependencies.wallClockNow();
  }
}
