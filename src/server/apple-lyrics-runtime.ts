import { randomBytes } from 'node:crypto';
import { AppleLyricsBackfillWorker } from './apple-lyrics-backfill.js';
import {
  AppleLyricsBackfillRunner,
  AppleLyricsPollCoordinator,
  type AppleLyricsBackfillRunnerStats,
} from './apple-lyrics-backfill-runner.js';
import { AppleLyricsReprojectionWorker } from './apple-lyrics-reprojection.js';
import { AppleLyricsTimelineRepairWorker } from './apple-lyrics-timeline-repair.js';
import {
  AppleMusicLyricsExactIdentityVerifier,
  AppleMusicLyricsSource,
} from './apple-music-lyrics-source.js';
import { config } from './config.js';
import {
  AppleTtmlProjectionParserV3,
  SupabaseAppleLyricsBackfillStore,
} from './supabase-apple-lyrics-backfill.js';
import {
  SupabaseLyricsClient,
  type AppleLyricsQueueStats,
} from './supabase-lyrics-client.js';
import {
  productionObservability,
  type ProductionObservabilitySnapshot,
} from './production-observability.js';

export interface AppleLyricsRuntimeStats {
  appleLyricsBackfill: AppleLyricsBackfillRunnerStats | { enabled: false };
  appleLyricsReprojection: AppleLyricsBackfillRunnerStats | { enabled: false };
  appleLyricsTimelineRepair: AppleLyricsBackfillRunnerStats | { enabled: false };
  appleLyricsQueues?: AppleLyricsQueueObservabilityStats | { enabled: false };
  observability?: ProductionObservabilitySnapshot;
}

export interface AppleLyricsQueueObservabilityStats {
  enabled: true;
  polls: number;
  failures: number;
  lastPolledAt: string | null;
  queues: AppleLyricsQueueStats;
}

class AppleLyricsQueueObservability {
  private timer?: NodeJS.Timeout;
  private polls = 0;
  private failures = 0;
  private lastPolledAt: string | null = null;
  private queues: AppleLyricsQueueStats = {};

  constructor(private readonly client: SupabaseLyricsClient) {}

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, 60_000);
    this.timer.unref();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  stats(): AppleLyricsQueueObservabilityStats {
    return {
      enabled: true,
      polls: this.polls,
      failures: this.failures,
      lastPolledAt: this.lastPolledAt,
      queues: structuredClone(this.queues),
    };
  }

  private async poll(): Promise<void> {
    try {
      this.queues = await this.client.observeAppleLyricsQueue();
      this.polls += 1;
      this.lastPolledAt = new Date().toISOString();
    } catch {
      this.failures += 1;
    }
  }
}

export interface AppleLyricsRuntime {
  start(): void;
  close(): Promise<void>;
  stats(): AppleLyricsRuntimeStats;
}

export function createAppleLyricsRuntime(options: {
  onWedged?: (error: Error) => void;
} = {}): AppleLyricsRuntime {
  const coordinator = new AppleLyricsPollCoordinator();
  const queueClient = config.supabase.lyricsMode === 'off' ? undefined : supabaseClient();
  const queueObservability = queueClient
    ? new AppleLyricsQueueObservability(queueClient)
    : undefined;
  const runnerOptions = {
    coordinator,
    deadlineMs: config.appleLyrics.jobDeadlineMs,
    cleanupGraceMs: config.appleLyrics.cleanupGraceMs,
    ...(options.onWedged ? { onWedged: options.onWedged } : {}),
  };
  const backfill = createBackfillRunner(runnerOptions);
  const reprojection = createReprojectionRunner(runnerOptions);
  const timelineRepair = createTimelineRepairRunner(runnerOptions);
  let started = false;
  let closePromise: Promise<void> | undefined;

  return {
    start() {
      if (started || closePromise) return;
      started = true;
      backfill?.start();
      reprojection?.start();
      timelineRepair?.start();
      queueObservability?.start();
    },
    close() {
      if (closePromise) return closePromise;
      coordinator.stop(new Error('Apple lyrics runners stopped'));
      queueObservability?.close();
      closePromise = Promise.all([
        timelineRepair?.close(),
        reprojection?.close(),
        backfill?.close(),
      ]).then(() => undefined);
      return closePromise;
    },
    stats() {
      return {
        appleLyricsBackfill: backfill?.stats() ?? { enabled: false },
        appleLyricsReprojection: reprojection?.stats() ?? { enabled: false },
        appleLyricsTimelineRepair: timelineRepair?.stats() ?? { enabled: false },
        appleLyricsQueues: queueObservability?.stats() ?? { enabled: false },
        observability: productionObservability.snapshot(),
      };
    },
  };
}

type RunnerOptions = ConstructorParameters<typeof AppleLyricsBackfillRunner>[4];

function supabaseClient(): SupabaseLyricsClient {
  return new SupabaseLyricsClient({
    url: config.supabase.url,
    secretKey: config.supabase.secretKey,
    libraryId: config.supabase.libraryId,
    timeoutMs: config.supabase.requestTimeoutMs,
    writeTimeoutMs: config.supabase.writeTimeoutMs,
    // Large raw TTML writes are off the serving path and get the longer of
    // the normal write and Apple dependency budgets.
    backfillTimeoutMs: Math.max(
      config.supabase.writeTimeoutMs,
      config.appleLyrics.requestTimeoutMs,
    ),
  });
}

function workerId(prefix: string): string {
  return [
    prefix,
    config.revision.slice(0, 12),
    process.pid,
    randomBytes(4).toString('hex'),
  ].join('-');
}

function createBackfillRunner(options: RunnerOptions): AppleLyricsBackfillRunner | undefined {
  if (!config.appleLyrics.enabled) return undefined;

  const persistence = new SupabaseAppleLyricsBackfillStore(supabaseClient(), {
    workerId: workerId('awesome-lyrla'),
    leaseSeconds: config.appleLyrics.leaseSeconds,
  });
  const source = new AppleMusicLyricsSource({
    mediaUserToken: config.appleLyrics.mediaUserToken,
    requestTimeoutMs: config.appleLyrics.requestTimeoutMs,
    fallbackStorefronts: [
      config.appleMusic.storefront,
      ...config.appleMusic.fallbackStorefronts,
    ],
    ...(config.appleLyrics.webBearerToken
      ? { webBearerToken: config.appleLyrics.webBearerToken }
      : {}),
  });
  const worker = new AppleLyricsBackfillWorker({
    queue: persistence,
    fetcher: source,
    identityVerifier: new AppleMusicLyricsExactIdentityVerifier(),
    parser: new AppleTtmlProjectionParserV3(),
    sink: persistence,
  }, {
    concurrency: config.appleLyrics.concurrency,
    retryPolicy: { maxAttempts: config.appleLyrics.maxAttempts },
  });
  return new AppleLyricsBackfillRunner(
    worker,
    config.appleLyrics.pollIntervalMs,
    'Apple lyrics backfill',
    config.appleLyrics.pollIntervalMs,
    options,
  );
}

function createReprojectionRunner(options: RunnerOptions): AppleLyricsBackfillRunner | undefined {
  if (config.supabase.lyricsMode === 'off') return undefined;

  const worker = new AppleLyricsReprojectionWorker(supabaseClient(), {
    workerId: workerId('awesome-lyrla-reproject-v2'),
    leaseSeconds: config.appleLyrics.leaseSeconds,
    concurrency: config.appleLyrics.concurrency,
  });
  // Poll below the lease duration so a restart cannot leave an expired job
  // untouched for several minutes.
  return new AppleLyricsBackfillRunner(
    worker,
    1_000,
    'Apple lyrics reprojection',
    60_000,
    options,
  );
}

function createTimelineRepairRunner(options: RunnerOptions): AppleLyricsBackfillRunner | undefined {
  if (config.supabase.lyricsMode === 'off') return undefined;

  const worker = new AppleLyricsTimelineRepairWorker(supabaseClient(), {
    workerId: workerId('awesome-lyrla-timeline-repair-v3'),
    leaseSeconds: config.appleLyrics.leaseSeconds,
    concurrency: config.appleLyrics.concurrency,
  });
  return new AppleLyricsBackfillRunner(
    worker,
    1_000,
    'Apple lyrics timeline repair',
    60_000,
    options,
  );
}
