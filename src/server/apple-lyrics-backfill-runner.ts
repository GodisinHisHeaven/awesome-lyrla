import type { AppleLyricsBackfillProcessResult } from './apple-lyrics-backfill.js';

export interface AppleLyricsPollWorker {
  runOnce(options?: {
    signal?: AbortSignal;
  }): Promise<AppleLyricsBackfillProcessResult[]>;
}

export interface AppleLyricsBackfillRunnerOptions {
  coordinator?: AppleLyricsPollCoordinator;
  deadlineMs?: number;
  cleanupGraceMs?: number;
  onWedged?: (error: Error) => void;
}

interface AppleLyricsPollWaiter {
  resolve: () => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * Process-wide FIFO gate for Apple background work. The gate is acquired
 * before a queue claim so a waiting worker never burns through its DB lease.
 */
export class AppleLyricsPollCoordinator {
  private active = false;
  private readonly waiters: AppleLyricsPollWaiter[] = [];
  private stoppedReason?: Error;

  async runExclusive<T>(
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    await this.acquire(signal);
    try {
      if (this.stoppedReason) throw this.stoppedReason;
      signal?.throwIfAborted();
      return await operation();
    } finally {
      this.release();
    }
  }

  stop(reason: Error): void {
    if (this.stoppedReason) return;
    this.stoppedReason = reason;
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      waiter.reject(reason);
    }
  }

  isStopped(): boolean {
    return this.stoppedReason !== undefined;
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (this.stoppedReason) return Promise.reject(this.stoppedReason);
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (!this.active) {
      this.active = true;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: AppleLyricsPollWaiter = { resolve, reject };
      if (signal) {
        waiter.signal = signal;
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(abortReason(signal));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    if (this.stoppedReason) {
      this.active = false;
      return;
    }
    const waiter = this.waiters.shift();
    if (!waiter) {
      this.active = false;
      return;
    }
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
    waiter.resolve();
  }
}

export interface AppleLyricsBackfillRunnerStats {
  enabled: true;
  running: boolean;
  polls: number;
  successfulPolls: number;
  claimed: number;
  succeeded: number;
  retryScheduled: number;
  permanentlyFailed: number;
  pollFailures: number;
  consecutivePollFailures: number;
  lastState:
    | AppleLyricsBackfillProcessResult['state']
    | 'idle'
    | 'poll-failed'
    | 'poll-wedged'
    | null;
  /** Most recent queue poll that completed without throwing, including an empty poll. */
  lastSuccessfulPollAt: string | null;
  /** Most recent poll that actually leased at least one job. */
  lastClaimedAt: string | null;
  /** Most recent poll containing at least one end-to-end successful job. */
  lastSucceededAt: string | null;
  /** Outcome of the last claimed job; empty polls deliberately do not overwrite it. */
  lastJobState: AppleLyricsBackfillProcessResult['state'] | null;
  deadlinesExceeded: number;
  lastDeadlineAt: string | null;
  wedged: boolean;
}

type PollOutcome =
  | {
      status: 'fulfilled';
      value: AppleLyricsBackfillProcessResult[];
    }
  | {
      status: 'rejected';
      reason: unknown;
    };

const DEADLINE_REACHED = Symbol('deadline-reached');
const CLEANUP_GRACE_EXPIRED = Symbol('cleanup-grace-expired');
const SHUTDOWN_REQUESTED = Symbol('shutdown-requested');

class AppleLyricsPollWedgedError extends Error {
  constructor(label: string) {
    super(`${label} did not stop after its deadline`);
    this.name = 'AppleLyricsPollWedgedError';
  }
}

export class AppleLyricsBackfillRunner {
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  private closePromise?: Promise<void>;
  private readonly abortController = new AbortController();
  private started = false;
  private closed = false;
  private polls = 0;
  private successfulPolls = 0;
  private claimed = 0;
  private succeeded = 0;
  private retryScheduled = 0;
  private permanentlyFailed = 0;
  private pollFailures = 0;
  private consecutivePollFailures = 0;
  private lastState: AppleLyricsBackfillRunnerStats['lastState'] = null;
  private lastSuccessfulPollAt: string | null = null;
  private lastClaimedAt: string | null = null;
  private lastSucceededAt: string | null = null;
  private lastJobState: AppleLyricsBackfillRunnerStats['lastJobState'] = null;
  private deadlinesExceeded = 0;
  private lastDeadlineAt: string | null = null;
  private wedged = false;
  private nextPollDelayMs: number;
  private readonly coordinator: AppleLyricsPollCoordinator;

  constructor(
    private readonly worker: AppleLyricsPollWorker,
    private readonly pollIntervalMs: number,
    private readonly logLabel = 'Apple lyrics backfill',
    private readonly idlePollIntervalMs = pollIntervalMs,
    private readonly options: AppleLyricsBackfillRunnerOptions = {},
  ) {
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1_000) {
      throw new Error('pollIntervalMs must be at least 1000');
    }
    if (
      !Number.isSafeInteger(idlePollIntervalMs)
      || idlePollIntervalMs < pollIntervalMs
    ) {
      throw new Error('idlePollIntervalMs must be at least pollIntervalMs');
    }
    if (
      options.deadlineMs !== undefined
      && (!Number.isSafeInteger(options.deadlineMs) || options.deadlineMs < 1_000)
    ) {
      throw new Error('deadlineMs must be at least 1000');
    }
    if (
      options.cleanupGraceMs !== undefined
      && (
        !Number.isSafeInteger(options.cleanupGraceMs)
        || options.cleanupGraceMs < 1_000
      )
    ) {
      throw new Error('cleanupGraceMs must be at least 1000');
    }
    this.nextPollDelayMs = pollIntervalMs;
    this.coordinator = options.coordinator ?? new AppleLyricsPollCoordinator();
  }

  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.schedule(0);
  }

  stats(): AppleLyricsBackfillRunnerStats {
    return {
      enabled: true,
      running: Boolean(this.inFlight),
      polls: this.polls,
      successfulPolls: this.successfulPolls,
      claimed: this.claimed,
      succeeded: this.succeeded,
      retryScheduled: this.retryScheduled,
      permanentlyFailed: this.permanentlyFailed,
      pollFailures: this.pollFailures,
      consecutivePollFailures: this.consecutivePollFailures,
      lastState: this.lastState,
      lastSuccessfulPollAt: this.lastSuccessfulPollAt,
      lastClaimedAt: this.lastClaimedAt,
      lastSucceededAt: this.lastSucceededAt,
      lastJobState: this.lastJobState,
      deadlinesExceeded: this.deadlinesExceeded,
      lastDeadlineAt: this.lastDeadlineAt,
      wedged: this.wedged,
    };
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.abortController.abort(new Error('Apple lyrics backfill runner stopped'));
    this.closePromise = this.inFlight?.catch(() => undefined) ?? Promise.resolve();
    return this.closePromise;
  }

  private schedule(delayMs: number): void {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.inFlight = this.poll().finally(() => {
        this.inFlight = undefined;
        if (!this.wedged) this.schedule(this.nextPollDelayMs);
      });
    }, delayMs);
    this.timer.unref();
  }

  private async poll(): Promise<void> {
    this.polls += 1;
    try {
      const results = await this.coordinator.runExclusive(
        this.abortController.signal,
        () => this.runOnceWithDeadline(),
      );
      const completedAt = new Date().toISOString();
      this.successfulPolls += 1;
      this.consecutivePollFailures = 0;
      this.lastSuccessfulPollAt = completedAt;
      this.claimed += results.length;
      if (results.length === 0) {
        this.lastState = 'idle';
        this.nextPollDelayMs = this.idlePollIntervalMs;
        return;
      }
      this.nextPollDelayMs = this.pollIntervalMs;
      this.lastClaimedAt = completedAt;
      for (const result of results) {
        this.lastState = result.state;
        this.lastJobState = result.state;
        if (result.state === 'succeeded') {
          this.succeeded += 1;
          this.lastSucceededAt = completedAt;
        }
        else if (result.state === 'retry-scheduled') this.retryScheduled += 1;
        else this.permanentlyFailed += 1;
      }
    } catch (error) {
      if (this.closed) return;
      this.pollFailures += 1;
      this.consecutivePollFailures += 1;
      if (error instanceof AppleLyricsPollWedgedError || this.coordinator.isStopped()) {
        this.wedged = true;
        this.lastState = 'poll-wedged';
      } else {
        this.lastState = 'poll-failed';
      }
      this.nextPollDelayMs = Math.min(
        this.idlePollIntervalMs,
        this.pollIntervalMs * (2 ** Math.min(
          20,
          this.consecutivePollFailures - 1,
        )),
      );
      console.warn(
        `${this.logLabel} poll failed:`,
        error instanceof Error ? error.name : 'unknown_error',
      );
    }
  }

  private async runOnceWithDeadline(): Promise<AppleLyricsBackfillProcessResult[]> {
    if (this.options.deadlineMs === undefined) {
      return this.worker.runOnce({ signal: this.abortController.signal });
    }

    const deadlineController = new AbortController();
    const signal = AbortSignal.any([
      this.abortController.signal,
      deadlineController.signal,
    ]);
    const outcome = Promise.resolve()
      .then(() => this.worker.runOnce({ signal }))
      .then<PollOutcome, PollOutcome>(
        (value) => ({ status: 'fulfilled', value }),
        (reason: unknown) => ({ status: 'rejected', reason }),
      );
    let shutdownListener: (() => void) | undefined;
    const shutdown = new Promise<typeof SHUTDOWN_REQUESTED>((resolve) => {
      if (this.abortController.signal.aborted) {
        resolve(SHUTDOWN_REQUESTED);
        return;
      }
      shutdownListener = () => resolve(SHUTDOWN_REQUESTED);
      this.abortController.signal.addEventListener('abort', shutdownListener, {
        once: true,
      });
    });
    let deadlineTimer: NodeJS.Timeout | undefined;
    const deadline = new Promise<typeof DEADLINE_REACHED>((resolve) => {
      deadlineTimer = setTimeout(() => resolve(DEADLINE_REACHED), this.options.deadlineMs);
      deadlineTimer.unref();
    });

    const first = await Promise.race([outcome, deadline, shutdown]);
    if (first !== DEADLINE_REACHED && first !== SHUTDOWN_REQUESTED) {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (shutdownListener) {
        this.abortController.signal.removeEventListener('abort', shutdownListener);
      }
      return unwrapOutcome(first);
    }

    if (shutdownListener) {
      this.abortController.signal.removeEventListener('abort', shutdownListener);
    }

    if (first === SHUTDOWN_REQUESTED) {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      const stopped = await waitForCleanup(
        outcome,
        this.options.cleanupGraceMs ?? 30_000,
      );
      if (stopped !== CLEANUP_GRACE_EXPIRED) return unwrapOutcome(stopped);
      const reason = errorReason(
        this.abortController.signal.reason,
        'Apple lyrics runner stopped during active work',
      );
      this.coordinator.stop(reason);
      throw reason;
    }

    this.deadlinesExceeded += 1;
    this.lastDeadlineAt = new Date().toISOString();
    deadlineController.abort(new DOMException(
      'Apple lyrics worker deadline exceeded',
      'TimeoutError',
    ));

    const cleaned = await waitForCleanup(
      outcome,
      this.options.cleanupGraceMs ?? 30_000,
    );
    if (cleaned !== CLEANUP_GRACE_EXPIRED) {
      return unwrapOutcome(cleaned);
    }

    const wedgedError = new AppleLyricsPollWedgedError(this.logLabel);
    this.wedged = true;
    this.lastState = 'poll-wedged';
    this.coordinator.stop(wedgedError);
    try {
      this.options.onWedged?.(wedgedError);
    } catch (error) {
      console.error(
        `${this.logLabel} wedge handler failed:`,
        error instanceof Error ? error.name : 'unknown_error',
      );
    }
    throw wedgedError;
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Operation aborted', 'AbortError');
}

function unwrapOutcome(outcome: PollOutcome): AppleLyricsBackfillProcessResult[] {
  if (outcome.status === 'rejected') throw outcome.reason;
  return outcome.value;
}

async function waitForCleanup(
  outcome: Promise<PollOutcome>,
  cleanupGraceMs: number,
): Promise<PollOutcome | typeof CLEANUP_GRACE_EXPIRED> {
  let cleanupTimer: NodeJS.Timeout | undefined;
  const cleanupGrace = new Promise<typeof CLEANUP_GRACE_EXPIRED>((resolve) => {
    cleanupTimer = setTimeout(
      () => resolve(CLEANUP_GRACE_EXPIRED),
      cleanupGraceMs,
    );
    cleanupTimer.unref();
  });
  const cleaned = await Promise.race([outcome, cleanupGrace]);
  if (cleaned !== CLEANUP_GRACE_EXPIRED && cleanupTimer) {
    clearTimeout(cleanupTimer);
  }
  return cleaned;
}

function errorReason(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(fallback);
}
