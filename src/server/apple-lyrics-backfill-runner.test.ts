import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type {
  AppleLyricsBackfillProcessResult,
  AppleLyricsBackfillWorker,
} from './apple-lyrics-backfill.js';
import {
  AppleLyricsBackfillRunner,
  AppleLyricsPollCoordinator,
} from './apple-lyrics-backfill-runner.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function workerWith(
  runOnce: (
    options: { signal?: AbortSignal },
  ) => Promise<AppleLyricsBackfillProcessResult[]>,
): AppleLyricsBackfillWorker<unknown> {
  return { runOnce } as unknown as AppleLyricsBackfillWorker<unknown>;
}

describe('AppleLyricsBackfillRunner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('polls immediately after start and never overlaps polls', async () => {
    const firstPoll = deferred<AppleLyricsBackfillProcessResult[]>();
    const runOnce = vi.fn(
      (
        _options: { signal?: AbortSignal },
      ): Promise<AppleLyricsBackfillProcessResult[]> => Promise.resolve([]),
    );
    runOnce.mockImplementationOnce(() => firstPoll.promise);
    const runner = new AppleLyricsBackfillRunner(workerWith(runOnce), 1_000);

    runner.start();
    runner.start();
    expect(runOnce).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(0);
    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(runner.stats()).toMatchObject({
      running: true,
      polls: 1,
      successfulPolls: 0,
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(runOnce).toHaveBeenCalledTimes(1);

    firstPoll.resolve([{
      state: 'succeeded',
      jobId: 'job-1',
      artifactSha256: 'a'.repeat(64),
    }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.stats()).toMatchObject({
      running: false,
      polls: 1,
      successfulPolls: 1,
      claimed: 1,
      succeeded: 1,
      consecutivePollFailures: 0,
      lastState: 'succeeded',
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(runOnce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(runOnce).toHaveBeenCalledTimes(2);

    await runner.close();
  });

  it('aborts active worker work and makes concurrent and repeated close calls wait safely', async () => {
    const abortObserved = deferred<void>();
    const cleanupAllowed = deferred<void>();
    let workerSignal: AbortSignal | undefined;
    const runOnce = vi.fn(
      (options: { signal?: AbortSignal }): Promise<AppleLyricsBackfillProcessResult[]> => {
        workerSignal = options.signal;
        return new Promise((resolve) => {
          options.signal?.addEventListener('abort', () => {
            abortObserved.resolve();
            void cleanupAllowed.promise.then(() => resolve([]));
          }, { once: true });
        });
      },
    );
    const runner = new AppleLyricsBackfillRunner(workerWith(runOnce), 1_000);

    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(workerSignal?.aborted).toBe(false);

    const firstClose = runner.close();
    const secondClose = runner.close();
    await abortObserved.promise;
    expect(workerSignal?.aborted).toBe(true);

    let secondCloseSettled = false;
    void secondClose.then(() => {
      secondCloseSettled = true;
    });
    await Promise.resolve();
    expect(secondCloseSettled).toBe(false);

    cleanupAllowed.resolve();
    await Promise.all([firstClose, secondClose]);
    await expect(runner.close()).resolves.toBeUndefined();
    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(runner.stats().running).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses cleanup grace immediately when shutdown work ignores cancellation', async () => {
    const abandoned = deferred<AppleLyricsBackfillProcessResult[]>();
    const runOnce = vi.fn(() => abandoned.promise);
    const runner = new AppleLyricsBackfillRunner(
      workerWith(runOnce),
      1_000,
      'shutdown-deadline',
      1_000,
      { deadlineMs: 210_000, cleanupGraceMs: 1_000 },
    );

    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    const closing = runner.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(closing).resolves.toBeUndefined();
    expect(runner.stats()).toMatchObject({
      deadlinesExceeded: 0,
      wedged: false,
    });
    expect(runOnce).toHaveBeenCalledTimes(1);

    abandoned.reject(new Error('late shutdown rejection'));
    await Promise.resolve();
  });

  it('keeps dependency error details and credentials out of public stats and logs', async () => {
    const secret = 'music-user-token-secret-value';
    const error = new Error(`request failed with ${secret}`);
    error.name = 'FetchError';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const runOnce = vi.fn(
      async (
        _options: { signal?: AbortSignal },
      ): Promise<AppleLyricsBackfillProcessResult[]> => {
        throw error;
      },
    );
    const runner = new AppleLyricsBackfillRunner(workerWith(runOnce), 1_000);

    runner.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(runner.stats()).toEqual({
      enabled: true,
      running: false,
      polls: 1,
      successfulPolls: 0,
      claimed: 0,
      succeeded: 0,
      retryScheduled: 0,
      permanentlyFailed: 0,
      pollFailures: 1,
      consecutivePollFailures: 1,
      lastState: 'poll-failed',
      lastSuccessfulPollAt: null,
      lastClaimedAt: null,
      lastSucceededAt: null,
      lastJobState: null,
      deadlinesExceeded: 0,
      lastDeadlineAt: null,
      wedged: false,
    });
    expect(JSON.stringify(runner.stats())).not.toContain(secret);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
    expect(warn).toHaveBeenCalledWith(
      'Apple lyrics backfill poll failed:',
      'FetchError',
    );

    await runner.close();
  });

  it('distinguishes empty polling liveness from a real successful job', async () => {
    vi.setSystemTime(new Date('2026-07-19T12:00:00.000Z'));
    const runOnce = vi.fn(
      async (
        _options: { signal?: AbortSignal },
      ): Promise<AppleLyricsBackfillProcessResult[]> => [],
    );
    runOnce
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        state: 'succeeded',
        jobId: 'job-1',
        artifactSha256: 'a'.repeat(64),
      }])
      .mockResolvedValueOnce([]);
    const runner = new AppleLyricsBackfillRunner(workerWith(runOnce), 1_000);

    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.stats()).toMatchObject({
      successfulPolls: 1,
      claimed: 0,
      succeeded: 0,
      lastState: 'idle',
      lastSuccessfulPollAt: '2026-07-19T12:00:00.000Z',
      lastClaimedAt: null,
      lastSucceededAt: null,
      lastJobState: null,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(runner.stats()).toMatchObject({
      successfulPolls: 2,
      claimed: 1,
      succeeded: 1,
      lastSuccessfulPollAt: '2026-07-19T12:00:01.000Z',
      lastClaimedAt: '2026-07-19T12:00:01.000Z',
      lastSucceededAt: '2026-07-19T12:00:01.000Z',
      lastJobState: 'succeeded',
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(runner.stats()).toMatchObject({
      successfulPolls: 3,
      claimed: 1,
      succeeded: 1,
      lastState: 'idle',
      lastSuccessfulPollAt: '2026-07-19T12:00:02.000Z',
      lastClaimedAt: '2026-07-19T12:00:01.000Z',
      lastSucceededAt: '2026-07-19T12:00:01.000Z',
      lastJobState: 'succeeded',
    });

    await runner.close();
  });

  it('resets consecutive poll failures after a successful recovery', async () => {
    const runOnce = vi.fn(
      async (
        _options: { signal?: AbortSignal },
      ): Promise<AppleLyricsBackfillProcessResult[]> => [],
    );
    runOnce.mockRejectedValueOnce(new Error('temporary Supabase failure'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const runner = new AppleLyricsBackfillRunner(workerWith(runOnce), 1_000);

    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.stats()).toMatchObject({
      polls: 1,
      successfulPolls: 0,
      pollFailures: 1,
      consecutivePollFailures: 1,
      lastState: 'poll-failed',
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(runner.stats()).toMatchObject({
      polls: 2,
      successfulPolls: 1,
      pollFailures: 1,
      consecutivePollFailures: 0,
      lastState: 'idle',
    });

    await runner.close();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('backs off empty specialized queues without slowing active draining', async () => {
    const runOnce = vi.fn(
      async (
        _options: { signal?: AbortSignal },
      ): Promise<AppleLyricsBackfillProcessResult[]> => [],
    );
    runOnce
      .mockResolvedValueOnce([{
        state: 'succeeded',
        jobId: 'job-1',
        artifactSha256: 'a'.repeat(64),
      }])
      .mockResolvedValueOnce([]);
    const runner = new AppleLyricsBackfillRunner(
      workerWith(runOnce),
      1_000,
      'reprojection',
      300_000,
    );

    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runOnce).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(runOnce).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(299_999);
    expect(runOnce).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(runOnce).toHaveBeenCalledTimes(3);

    await runner.close();
  });

  it('serializes different runners through one FIFO coordinator', async () => {
    const coordinator = new AppleLyricsPollCoordinator();
    const firstPoll = deferred<AppleLyricsBackfillProcessResult[]>();
    const executionOrder: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const firstRun = vi.fn(async () => {
      executionOrder.push('first');
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        return await firstPoll.promise;
      } finally {
        active -= 1;
      }
    });
    const secondRun = vi.fn(async () => {
      executionOrder.push('second');
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      active -= 1;
      return [];
    });
    const firstRunner = new AppleLyricsBackfillRunner(
      workerWith(firstRun),
      1_000,
      'first',
      1_000,
      { coordinator },
    );
    const secondRunner = new AppleLyricsBackfillRunner(
      workerWith(secondRun),
      1_000,
      'second',
      1_000,
      { coordinator },
    );

    firstRunner.start();
    secondRunner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(firstRun).toHaveBeenCalledTimes(1);
    expect(secondRun).not.toHaveBeenCalled();

    firstPoll.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(secondRun).toHaveBeenCalledTimes(1);
    expect(executionOrder).toEqual(['first', 'second']);
    expect(maximumActive).toBe(1);

    await Promise.all([firstRunner.close(), secondRunner.close()]);
  });

  it('rechecks cancellation after acquiring a coordinator permit', async () => {
    const coordinator = new AppleLyricsPollCoordinator();
    const controller = new AbortController();
    const operation = vi.fn(async () => []);

    const result = coordinator.runExclusive(controller.signal, operation);
    controller.abort(new DOMException('shutdown', 'AbortError'));

    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(operation).not.toHaveBeenCalled();
    await expect(coordinator.runExclusive(undefined, async () => ['released']))
      .resolves.toEqual(['released']);
  });

  it('lets a queued runner close without waiting for the active coordinator owner', async () => {
    const coordinator = new AppleLyricsPollCoordinator();
    const firstPoll = deferred<AppleLyricsBackfillProcessResult[]>();
    const firstRun = vi.fn(() => firstPoll.promise);
    const secondRun = vi.fn(async () => []);
    const firstRunner = new AppleLyricsBackfillRunner(
      workerWith(firstRun),
      1_000,
      'first',
      1_000,
      { coordinator },
    );
    const secondRunner = new AppleLyricsBackfillRunner(
      workerWith(secondRun),
      1_000,
      'second',
      1_000,
      { coordinator },
    );

    firstRunner.start();
    secondRunner.start();
    await vi.advanceTimersByTimeAsync(0);
    await expect(secondRunner.close()).resolves.toBeUndefined();
    expect(secondRun).not.toHaveBeenCalled();

    firstPoll.resolve([]);
    await firstRunner.close();
  });

  it('aborts at the soft deadline and does not overlap while cleanup is pending', async () => {
    const cleanup = deferred<void>();
    const runOnce = vi.fn(
      (options: { signal?: AbortSignal }): Promise<AppleLyricsBackfillProcessResult[]> =>
        new Promise((resolve) => {
          options.signal?.addEventListener('abort', () => {
            void cleanup.promise.then(() => resolve([{
              state: 'retry-scheduled',
              jobId: 'job-timeout',
              attempts: 1,
              availableAtMs: Date.now() + 1_000,
              failure: {
                stage: 'fetch',
                code: 'timeout',
                retryable: true,
                exhausted: false,
              },
            }]));
          }, { once: true });
        }),
    );
    const runner = new AppleLyricsBackfillRunner(
      workerWith(runOnce),
      1_000,
      'deadline-test',
      1_000,
      { deadlineMs: 1_000, cleanupGraceMs: 20_000 },
    );

    runner.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(runner.stats().deadlinesExceeded).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(runner.stats()).toMatchObject({
      running: true,
      deadlinesExceeded: 1,
      wedged: false,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runOnce).toHaveBeenCalledTimes(1);

    cleanup.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.stats()).toMatchObject({
      running: false,
      successfulPolls: 1,
      retryScheduled: 1,
      deadlinesExceeded: 1,
      wedged: false,
    });
    await runner.close();
  });

  it('stops every coordinated runner when work ignores deadline cancellation', async () => {
    const coordinator = new AppleLyricsPollCoordinator();
    const abandoned = deferred<AppleLyricsBackfillProcessResult[]>();
    const onWedged = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const firstRun = vi.fn(() => abandoned.promise);
    const secondRun = vi.fn(async () => []);
    const firstRunner = new AppleLyricsBackfillRunner(
      workerWith(firstRun),
      1_000,
      'wedged',
      1_000,
      {
        coordinator,
        deadlineMs: 1_000,
        cleanupGraceMs: 1_000,
        onWedged,
      },
    );
    const secondRunner = new AppleLyricsBackfillRunner(
      workerWith(secondRun),
      1_000,
      'queued',
      1_000,
      { coordinator, deadlineMs: 1_000, cleanupGraceMs: 1_000 },
    );

    firstRunner.start();
    secondRunner.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onWedged).toHaveBeenCalledTimes(1);
    expect(firstRunner.stats()).toMatchObject({
      deadlinesExceeded: 1,
      wedged: true,
      lastState: 'poll-wedged',
    });
    expect(secondRunner.stats()).toMatchObject({
      wedged: true,
      lastState: 'poll-wedged',
    });
    expect(secondRun).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(firstRun).toHaveBeenCalledTimes(1);
    expect(secondRun).not.toHaveBeenCalled();

    abandoned.reject(new Error('late rejection'));
    await Promise.resolve();
    await Promise.all([firstRunner.close(), secondRunner.close()]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('exponentially backs off repeated specialized-queue poll failures', async () => {
    const runOnce = vi.fn(async (): Promise<AppleLyricsBackfillProcessResult[]> => {
      throw new Error('dependency unavailable');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const runner = new AppleLyricsBackfillRunner(
      workerWith(runOnce),
      1_000,
      'reprojection',
      8_000,
    );

    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(runOnce).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(7_999);
    expect(runOnce).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(runOnce).toHaveBeenCalledTimes(5);
    expect(runner.stats()).toMatchObject({
      pollFailures: 5,
      consecutivePollFailures: 5,
      lastState: 'poll-failed',
    });

    await runner.close();
    expect(warn).toHaveBeenCalledTimes(5);
  });
});
