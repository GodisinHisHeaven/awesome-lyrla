import { createHash } from 'node:crypto';
import type { TrackMetadata } from '../shared/contracts.js';
import {
  APPLE_LYRICS_BACKFILL_DEFAULT_CONCURRENCY,
  AppleLyricsBackfillError,
  AppleLyricsBackfillWorker,
  appleLyricsBackfillDelayMs,
  classifyAppleLyricsBackfillError,
  type AppleFetchedLyrics,
  type AppleLyricsBackfillDependencies,
  type AppleLyricsBackfillJob,
  type AppleLyricsBackfillQueue,
  type AppleLyricsBackfillSinkInput,
  type AppleLyricsExactIdentityProof,
} from './apple-lyrics-backfill.js';

const TRACK: TrackMetadata = {
  title: 'Midnight Circuit',
  artist: 'Local Drive',
  album: 'After Dark',
  durationMs: 214_000,
  source: 'Apple Music',
};

const JOB: AppleLyricsBackfillJob = {
  id: 'job-1',
  leaseToken: 'lease-1',
  attempts: 0,
  exactKey: 'midnight circuit::local drive::214::after dark',
  keyVersion: 1,
  track: TRACK,
};

const TTML = '\uFEFF<tt xml:lang="en"><body><p begin="1.250s">  Stay  </p></body></tt>\n';

const FETCHED: AppleFetchedLyrics = {
  ttml: TTML,
  providerTrackId: 'apple-song-42',
  storefront: 'us',
  catalogTrack: TRACK,
  fetchedAtMs: 1_700_000_000_000,
  contentType: 'application/ttml+xml; charset=utf-8',
  language: 'en',
  timingMode: 'word',
  isrc: 'US-AAA-24-00001',
};

const PROOF: AppleLyricsExactIdentityProof = {
  proofVersion: 1,
  provider: 'apple',
  providerTrackId: FETCHED.providerTrackId,
  exactKey: JOB.exactKey,
  keyVersion: JOB.keyVersion,
  evidence: ['isrc', 'catalog-metadata-v1'],
};

type ParsedLyrics = {
  kind: 'synced';
  lines: Array<{ startMs: number; text: string }>;
};

const PARSED: ParsedLyrics = {
  kind: 'synced',
  lines: [{ startMs: 1_250, text: 'Stay' }],
};

function queueWith(jobs: readonly AppleLyricsBackfillJob[] = []) {
  return {
    lease: vi.fn<AppleLyricsBackfillQueue['lease']>(async () => jobs),
    complete: vi.fn<AppleLyricsBackfillQueue['complete']>(async () => undefined),
    reschedule: vi.fn<AppleLyricsBackfillQueue['reschedule']>(async () => undefined),
    fail: vi.fn<AppleLyricsBackfillQueue['fail']>(async () => undefined),
  } satisfies AppleLyricsBackfillQueue;
}

function harness(input: {
  jobs?: readonly AppleLyricsBackfillJob[];
  fetched?: AppleFetchedLyrics;
  attempts?: number;
} = {}) {
  const job = {
    ...JOB,
    ...(input.attempts === undefined ? {} : { attempts: input.attempts }),
  };
  const queue = queueWith(input.jobs ?? []);
  const fetcher = {
    fetch: vi.fn(async (_input: {
      job: AppleLyricsBackfillJob;
      signal?: AbortSignal;
    }) => input.fetched ?? FETCHED),
  };
  const identityVerifier = {
    verify: vi.fn(async () => ({ state: 'verified' as const, proof: PROOF })),
  };
  const parser = {
    parse: vi.fn(async () => PARSED),
  };
  const sink = {
    persist: vi.fn(
      async (
        _input: AppleLyricsBackfillSinkInput<ParsedLyrics>,
      ): Promise<void | { jobCompleted: boolean }> => undefined,
    ),
  };
  const dependencies: AppleLyricsBackfillDependencies<ParsedLyrics> = {
    queue,
    fetcher,
    identityVerifier,
    parser,
    sink,
  };
  return {
    job,
    queue,
    fetcher,
    identityVerifier,
    parser,
    sink,
    dependencies,
  };
}

describe('AppleLyricsBackfillWorker', () => {
  it('does no work until explicitly run and defaults to one leased task', async () => {
    const test = harness({ jobs: [JOB] });
    const worker = new AppleLyricsBackfillWorker(test.dependencies, {
      clock: { now: () => 1_700_000_001_000 },
    });

    expect(test.queue.lease).not.toHaveBeenCalled();
    expect(test.fetcher.fetch).not.toHaveBeenCalled();

    await expect(worker.runOnce()).resolves.toHaveLength(1);

    expect(APPLE_LYRICS_BACKFILL_DEFAULT_CONCURRENCY).toBe(1);
    expect(test.queue.lease).toHaveBeenCalledWith({
      limit: 1,
      nowMs: 1_700_000_001_000,
    });
  });

  it('does not lease work when the scheduler signal is already aborted', async () => {
    const test = harness({ jobs: [JOB] });
    const worker = new AppleLyricsBackfillWorker(test.dependencies);
    const controller = new AbortController();
    controller.abort(new DOMException('scheduler stopped', 'AbortError'));

    await expect(worker.runOnce({ signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(test.queue.lease).not.toHaveBeenCalled();
    expect(test.fetcher.fetch).not.toHaveBeenCalled();
  });

  it('forwards the live operation signal through claim, fetch, parse, persist, and completion', async () => {
    const test = harness({ jobs: [JOB] });
    const worker = new AppleLyricsBackfillWorker(test.dependencies);
    const controller = new AbortController();

    await expect(worker.runOnce({ signal: controller.signal })).resolves.toHaveLength(1);

    expect(test.queue.lease).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1 }),
      { signal: controller.signal },
    );
    expect(test.fetcher.fetch).toHaveBeenCalledWith(expect.objectContaining({
      job: JOB,
      signal: controller.signal,
    }));
    expect(test.identityVerifier.verify).toHaveBeenCalledWith(expect.objectContaining({
      signal: controller.signal,
    }));
    expect(test.parser.parse).toHaveBeenCalledWith(expect.objectContaining({
      signal: controller.signal,
    }));
    expect(test.sink.persist).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: JOB.id }),
      { signal: controller.signal },
    );
    expect(test.queue.complete).toHaveBeenCalledWith(
      { jobId: JOB.id, leaseToken: JOB.leaseToken },
      { signal: controller.signal },
    );
  });

  it('settles a lease when cancellation wins immediately after claim returns', async () => {
    const test = harness({ jobs: [JOB] });
    const controller = new AbortController();
    test.queue.lease.mockImplementationOnce(async () => {
      controller.abort(new DOMException('deadline exceeded', 'TimeoutError'));
      return [JOB];
    });
    const worker = new AppleLyricsBackfillWorker(test.dependencies, {
      clock: { now: () => 100_000 },
      random: () => 0.5,
    });

    await expect(worker.runOnce({ signal: controller.signal })).resolves.toMatchObject([{
      state: 'retry-scheduled',
      failure: { stage: 'job', code: 'worker-stopped', retryable: true },
    }]);
    expect(test.fetcher.fetch).not.toHaveBeenCalled();
    expect(test.queue.reschedule).toHaveBeenCalledTimes(1);
    const finalizationSignal = test.queue.reschedule.mock.calls[0]![1]?.signal;
    expect(finalizationSignal).not.toBe(controller.signal);
    expect(finalizationSignal?.aborted).toBe(false);
  });

  it('persists the untouched TTML and parsed projection only after exact proof', async () => {
    const test = harness();
    const worker = new AppleLyricsBackfillWorker(test.dependencies);
    const expectedSha256 = createHash('sha256').update(TTML, 'utf8').digest('hex');

    const result = await worker.processOne(test.job);

    expect(result).toEqual({
      state: 'succeeded',
      jobId: JOB.id,
      artifactSha256: expectedSha256,
    });
    expect(test.identityVerifier.verify).toHaveBeenCalledWith({
      expected: {
        exactKey: JOB.exactKey,
        keyVersion: JOB.keyVersion,
        track: TRACK,
      },
      fetched: FETCHED,
    });
    expect(test.parser.parse).toHaveBeenCalledWith({
      ttml: TTML,
      track: TRACK,
      fetched: FETCHED,
      exactIdentity: PROOF,
    });
    expect(test.sink.persist).toHaveBeenCalledTimes(1);
    const persisted = test.sink.persist.mock.calls[0]![0];
    expect(persisted.artifact).toEqual({
      ttml: TTML,
      sha256: expectedSha256,
      byteLength: Buffer.byteLength(TTML, 'utf8'),
      fetchedAtMs: FETCHED.fetchedAtMs,
      contentType: FETCHED.contentType,
      storefront: FETCHED.storefront,
      language: FETCHED.language,
      timingMode: FETCHED.timingMode,
      isrc: FETCHED.isrc,
    });
    expect(persisted.timelineDurationMs).toBe(FETCHED.catalogTrack.durationMs);
    expect(persisted.parsed).toBe(PARSED);
    expect(persisted.leaseToken).toBe(JOB.leaseToken);
    expect(persisted.idempotencyKey).toMatch(/^apple-ttml:v1:[0-9a-f]{64}$/);
    expect(test.queue.complete).toHaveBeenCalledWith({
      jobId: JOB.id,
      leaseToken: JOB.leaseToken,
    });
    expect(test.queue.reschedule).not.toHaveBeenCalled();
    expect(test.queue.fail).not.toHaveBeenCalled();
    expect(test.sink.persist.mock.invocationCallOrder[0]).toBeLessThan(
      test.queue.complete.mock.invocationCallOrder[0]!,
    );
  });

  it('does not acknowledge the queue twice when the sink atomically completes the job', async () => {
    const test = harness();
    test.sink.persist.mockResolvedValueOnce({ jobCompleted: true });
    const worker = new AppleLyricsBackfillWorker(test.dependencies);

    await expect(worker.processOne(test.job)).resolves.toMatchObject({
      state: 'succeeded',
      jobId: JOB.id,
    });

    expect(test.sink.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: JOB.id,
        leaseToken: JOB.leaseToken,
      }),
      undefined,
    );
    expect(test.queue.complete).not.toHaveBeenCalled();
    expect(test.queue.reschedule).not.toHaveBeenCalled();
    expect(test.queue.fail).not.toHaveBeenCalled();
  });

  it.each([
    ['mismatch' as const, 'identity-mismatch'],
    ['ambiguous' as const, 'identity-ambiguous'],
    ['insufficient-evidence' as const, 'identity-insufficient-evidence'],
  ])('permanently rejects %s identity results before parsing', async (reason, code) => {
    const test = harness();
    test.identityVerifier.verify.mockResolvedValueOnce({ state: 'rejected', reason } as never);
    const worker = new AppleLyricsBackfillWorker(test.dependencies);

    await expect(worker.processOne(test.job)).resolves.toMatchObject({
      state: 'permanently-failed',
      attempts: 1,
      failure: {
        stage: 'identity',
        code,
        retryable: false,
        exhausted: false,
      },
    });

    expect(test.parser.parse).not.toHaveBeenCalled();
    expect(test.sink.persist).not.toHaveBeenCalled();
    expect(test.queue.fail).toHaveBeenCalledTimes(1);
  });

  it('fails closed when a verifier proof is not bound to the requested exact key', async () => {
    const test = harness();
    test.identityVerifier.verify.mockResolvedValueOnce({
      state: 'verified',
      proof: { ...PROOF, exactKey: 'another-exact-key' },
    });
    const worker = new AppleLyricsBackfillWorker(test.dependencies);

    await expect(worker.processOne(test.job)).resolves.toMatchObject({
      state: 'permanently-failed',
      failure: {
        stage: 'identity',
        code: 'invalid-exact-proof',
        retryable: false,
      },
    });
    expect(test.parser.parse).not.toHaveBeenCalled();
    expect(test.sink.persist).not.toHaveBeenCalled();
  });

  it('forwards durable Apple identity hints without bypassing the verifier', async () => {
    const test = harness();
    const hintedJob: AppleLyricsBackfillJob = {
      ...JOB,
      storefront: 'us',
      locale: 'en-US',
      providerTrackId: FETCHED.providerTrackId,
      isrc: FETCHED.isrc,
    };
    const worker = new AppleLyricsBackfillWorker(test.dependencies);

    await expect(worker.processOne(hintedJob)).resolves.toMatchObject({
      state: 'succeeded',
    });

    expect(test.identityVerifier.verify).toHaveBeenCalledWith({
      expected: {
        exactKey: JOB.exactKey,
        keyVersion: JOB.keyVersion,
        track: TRACK,
        storefront: 'us',
        locale: 'en-US',
        providerTrackId: FETCHED.providerTrackId,
        isrc: FETCHED.isrc,
      },
      fetched: FETCHED,
    });
  });

  it('durably reschedules transient failures with exponential backoff and Retry-After', async () => {
    const test = harness({ attempts: 2 });
    test.fetcher.fetch.mockRejectedValueOnce(new AppleLyricsBackfillError(
      'apple-rate-limit',
      { retryable: true, retryAfterMs: 8_000 },
    ));
    const worker = new AppleLyricsBackfillWorker(test.dependencies, {
      clock: { now: () => 100_000 },
      random: () => 0.5,
      retryPolicy: {
        maxAttempts: 5,
        baseDelayMs: 1_000,
        maxDelayMs: 60_000,
        jitterRatio: 0.2,
      },
    });

    const result = await worker.processOne(test.job);

    expect(result).toEqual({
      state: 'retry-scheduled',
      jobId: JOB.id,
      attempts: 3,
      availableAtMs: 108_000,
      failure: {
        stage: 'fetch',
        code: 'apple-rate-limit',
        retryable: true,
        exhausted: false,
      },
    });
    expect(test.queue.reschedule).toHaveBeenCalledWith(
      {
        jobId: JOB.id,
        leaseToken: JOB.leaseToken,
        attempts: 3,
        availableAtMs: 108_000,
        failure: {
          stage: 'fetch',
          code: 'apple-rate-limit',
          retryable: true,
          exhausted: false,
        },
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(test.queue.fail).not.toHaveBeenCalled();
  });

  it('reschedules exactly once when a deadline aborts an active fetch', async () => {
    const test = harness();
    test.fetcher.fetch.mockImplementationOnce(
      ({ signal }: { signal?: AbortSignal }) => new Promise<AppleFetchedLyrics>(
        (_, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        },
      ),
    );
    const worker = new AppleLyricsBackfillWorker(test.dependencies, {
      clock: { now: () => 100_000 },
      random: () => 0.5,
    });
    const controller = new AbortController();

    const processing = worker.processOne(test.job, { signal: controller.signal });
    controller.abort(new DOMException('deadline exceeded', 'TimeoutError'));

    await expect(processing).resolves.toMatchObject({
      state: 'retry-scheduled',
      failure: {
        stage: 'fetch',
        code: 'timeout',
        retryable: true,
      },
    });
    expect(test.queue.reschedule).toHaveBeenCalledTimes(1);
    const finalizationSignal = test.queue.reschedule.mock.calls[0]![1]?.signal;
    expect(finalizationSignal).toBeInstanceOf(AbortSignal);
    expect(finalizationSignal).not.toBe(controller.signal);
    expect(finalizationSignal?.aborted).toBe(false);
    expect(test.queue.complete).not.toHaveBeenCalled();
    expect(test.queue.fail).not.toHaveBeenCalled();
    expect(test.sink.persist).not.toHaveBeenCalled();
  });

  it('bounds a stalled lease finalization independently of the operation signal', async () => {
    const test = harness();
    test.fetcher.fetch.mockRejectedValueOnce(new TypeError('network unavailable'));
    test.queue.reschedule.mockImplementationOnce(
      async (_input, options) => new Promise<void>((_resolve, reject) => {
        options?.signal?.addEventListener(
          'abort',
          () => reject(options.signal?.reason),
          { once: true },
        );
      }),
    );
    const worker = new AppleLyricsBackfillWorker(test.dependencies, {
      finalizationTimeoutMs: 100,
      clock: { now: () => 100_000 },
      random: () => 0.5,
    });

    const pending = worker.processOne(test.job);

    await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(test.queue.reschedule).toHaveBeenCalledTimes(1);
    expect(test.queue.reschedule.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('moves a retryable failure to permanent failure after the attempt budget', async () => {
    const test = harness({ attempts: 4 });
    test.fetcher.fetch.mockRejectedValueOnce(new AppleLyricsBackfillError(
      'apple-server',
      { retryable: true },
    ));
    const worker = new AppleLyricsBackfillWorker(test.dependencies, {
      retryPolicy: { maxAttempts: 5 },
    });

    await expect(worker.processOne(test.job)).resolves.toEqual({
      state: 'permanently-failed',
      jobId: JOB.id,
      attempts: 5,
      failure: {
        stage: 'fetch',
        code: 'apple-server',
        retryable: false,
        exhausted: true,
      },
    });
    expect(test.queue.reschedule).not.toHaveBeenCalled();
    expect(test.queue.fail).toHaveBeenCalledTimes(1);
  });

  it('uses the durable per-job attempt ceiling instead of the worker default', async () => {
    const test = harness({ attempts: 2 });
    test.fetcher.fetch.mockRejectedValueOnce(new AppleLyricsBackfillError(
      'apple-server',
      { retryable: true },
    ));
    const worker = new AppleLyricsBackfillWorker(test.dependencies, {
      retryPolicy: { maxAttempts: 5 },
    });

    await expect(worker.processOne({
      ...test.job,
      maxAttempts: 3,
    })).resolves.toMatchObject({
      state: 'permanently-failed',
      attempts: 3,
      failure: {
        code: 'apple-server',
        exhausted: true,
      },
    });
    expect(test.queue.reschedule).not.toHaveBeenCalled();
    expect(test.queue.fail).toHaveBeenCalledTimes(1);
  });

  it('permanently rejects oversized source TTML without parsing or persistence', async () => {
    const test = harness({
      fetched: {
        ...FETCHED,
        ttml: `<tt>${'界'.repeat(10)}</tt>`,
      },
    });
    const worker = new AppleLyricsBackfillWorker(test.dependencies, {
      maxTtmlBytes: 24,
    });

    await expect(worker.processOne(test.job)).resolves.toMatchObject({
      state: 'permanently-failed',
      failure: {
        stage: 'fetch',
        code: 'ttml-too-large',
        retryable: false,
      },
    });
    expect(test.identityVerifier.verify).not.toHaveBeenCalled();
    expect(test.parser.parse).not.toHaveBeenCalled();
    expect(test.sink.persist).not.toHaveBeenCalled();
  });

  it('caps explicit worker concurrency at a low value', () => {
    const test = harness();

    expect(() => new AppleLyricsBackfillWorker(test.dependencies, {
      concurrency: 2,
    })).toThrow('concurrency must be between 1 and 1');
  });
});

describe('Apple lyrics backfill retry classification', () => {
  it('classifies HTTP, network, and parser failures conservatively', () => {
    expect(classifyAppleLyricsBackfillError(
      Object.assign(new Error('upstream'), { status: 429 }),
      'fetch',
    )).toEqual({ code: 'http-429', retryable: true });
    expect(classifyAppleLyricsBackfillError(
      Object.assign(new Error('bad request'), { status: 404 }),
      'fetch',
    )).toEqual({ code: 'http-404', retryable: false });
    expect(classifyAppleLyricsBackfillError(
      new TypeError('socket disconnected with secret details'),
      'fetch',
    )).toEqual({ code: 'network', retryable: true });
    expect(classifyAppleLyricsBackfillError(
      Object.assign(new Error('Supabase lyrics request failed: timeout'), {
        name: 'SupabaseRequestError',
      }),
      'persist',
    )).toEqual({ code: 'timeout', retryable: true });
    expect(classifyAppleLyricsBackfillError(
      new Error('unsupported Apple timing dialect'),
      'parse',
    )).toEqual({ code: 'parse-error', retryable: false });
  });

  it('uses one-based exponential backoff with deterministic jitter injection', () => {
    const policy = {
      maxAttempts: 5,
      baseDelayMs: 1_000,
      maxDelayMs: 10_000,
      jitterRatio: 0.2,
    };

    expect(appleLyricsBackfillDelayMs(1, policy, () => 0.5)).toBe(1_000);
    expect(appleLyricsBackfillDelayMs(2, policy, () => 0.5)).toBe(2_000);
    expect(appleLyricsBackfillDelayMs(3, policy, () => 0.5)).toBe(4_000);
    expect(appleLyricsBackfillDelayMs(8, policy, () => 0.5)).toBe(10_000);
  });
});
