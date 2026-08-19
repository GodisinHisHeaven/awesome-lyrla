import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AppleLyricsReprojectionWorker } from './apple-lyrics-reprojection.js';
import type {
  ClaimedAppleLyricsReprojectionJob,
  SupabaseLyricsClient,
} from './supabase-lyrics-client.js';

const TTML = [
  '<tt xmlns="http://www.w3.org/ns/ttml"',
  ' xmlns:apple="http://music.apple.com/lyric-ttml-internal"',
  ' apple:timing="Line">',
  '<body><div>',
  '<p begin="1.25">First retained line</p>',
  '<p begin="3">Second retained line</p>',
  '</div></body></tt>',
].join('');

function claimedJob(overrides: Partial<ClaimedAppleLyricsReprojectionJob> = {}):
ClaimedAppleLyricsReprojectionJob {
  const hash = createHash('sha256').update(TTML).digest('hex');
  return {
    jobId: '11111111-1111-4111-8111-111111111111',
    leaseToken: '22222222-2222-4222-8222-222222222222',
    leaseExpiresAt: '2026-07-18T18:00:00+00:00',
    attemptCount: 1,
    maxAttempts: 5,
    targetProjectionVersion: 'apple-ttml-line-model-v2',
    sourceArtifact: {
      id: '33333333-3333-4333-8333-333333333333',
      revisionId: '44444444-4444-4444-8444-444444444444',
      providerName: 'apple',
      providerTrackId: '1450330685',
      storefront: 'cn',
      exactKey: 'exact-v1',
      keyVersion: 1,
      locale: 'zh-Hans-CN',
      timingMode: 'line',
      recordingVariant: 'original',
      projectionVersion: 'apple-ttml-line-model-v1',
      rawTtml: TTML,
      contentHash: hash,
      byteSize: Buffer.byteLength(TTML),
      fetchedAt: '2026-07-18T12:00:00+00:00',
    },
    track: {
      title: 'Retained Song',
      artist: 'Existing Artist',
      album: 'Existing Album',
      durationMs: 180_000,
      source: 'Apple Music',
    },
    identityProof: {
      proofVersion: 1,
      evidence: ['catalog-id', 'catalog-metadata-v1'],
      providerName: 'apple',
      providerTrackId: '1450330685',
      exactKey: 'exact-v1',
      keyVersion: 1,
    },
    ...overrides,
  };
}

function mockClient(job: ClaimedAppleLyricsReprojectionJob) {
  return {
    enqueueAppleLyricsReprojection: vi.fn<
      SupabaseLyricsClient['enqueueAppleLyricsReprojection']
    >(async () => ({
      enqueued: 1,
      remaining: 0,
    })),
    claimAppleLyricsReprojection: vi.fn<
      SupabaseLyricsClient['claimAppleLyricsReprojection']
    >(async () => [job]),
    completeAppleLyricsReprojection: vi.fn<
      SupabaseLyricsClient['completeAppleLyricsReprojection']
    >(async () => undefined),
    failAppleLyricsReprojection: vi.fn<
      SupabaseLyricsClient['failAppleLyricsReprojection']
    >(async () => undefined),
  };
}

describe('AppleLyricsReprojectionWorker', () => {
  it('rejects concurrency above the single durable worker slot', () => {
    expect(() => new AppleLyricsReprojectionWorker(
      mockClient(claimedJob()) as unknown as SupabaseLyricsClient,
      { workerId: 'reproject-v2-test', leaseSeconds: 300, concurrency: 2 },
    )).toThrow('concurrency must be between 1 and 1');
  });

  it('projects strict bare seconds from retained TTML and never calls an Apple source', async () => {
    const job = claimedJob();
    const client = mockClient(job);
    const worker = new AppleLyricsReprojectionWorker(
      client as unknown as SupabaseLyricsClient,
      {
        workerId: 'reproject-v2-test',
        leaseSeconds: 300,
      },
    );

    await expect(worker.runOnce()).resolves.toEqual([{
      state: 'succeeded',
      jobId: job.jobId,
      artifactSha256: job.sourceArtifact.contentHash,
    }]);
    expect(client.completeAppleLyricsReprojection).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: job.jobId,
        sourceArtifactId: job.sourceArtifact.id,
        sourceArtifactHash: job.sourceArtifact.contentHash,
        sourceArtifactBytes: job.sourceArtifact.byteSize,
        timingMode: 'line',
        payload: expect.objectContaining({
          synced_lyrics:
            '[00:01.250]First retained line\n[00:03.000]Second retained line',
          plain_lyrics: 'First retained line\nSecond retained line',
          duration_ms: 180_000,
        }),
        provenance: expect.objectContaining({
          body_format: 'apple-ttml-line-projection-v2-ms',
          source_artifact_id: job.sourceArtifact.id,
          source_projection_version: 'apple-ttml-line-model-v1',
          projection_version: 'apple-ttml-line-model-v2',
        }),
      }),
    );
    expect(client.failAppleLyricsReprojection).not.toHaveBeenCalled();
    expect(client.enqueueAppleLyricsReprojection).toHaveBeenCalledWith(10_000);
    expect(client.claimAppleLyricsReprojection).toHaveBeenCalledWith({
      workerId: 'reproject-v2-test',
      limit: 1,
      leaseSeconds: 300,
    });
    expect(JSON.stringify(client.completeAppleLyricsReprojection.mock.calls))
      .not.toContain('media-user-token');
  });

  it('forwards the operation signal through enqueue, claim, and completion', async () => {
    const job = claimedJob();
    const client = mockClient(job);
    const controller = new AbortController();
    const worker = new AppleLyricsReprojectionWorker(
      client as unknown as SupabaseLyricsClient,
      { workerId: 'reproject-v2-test', leaseSeconds: 300, concurrency: 1 },
    );

    await expect(worker.runOnce({ signal: controller.signal })).resolves.toHaveLength(1);

    expect(client.enqueueAppleLyricsReprojection).toHaveBeenCalledWith(
      10_000,
      { signal: controller.signal },
    );
    expect(client.claimAppleLyricsReprojection).toHaveBeenCalledWith(
      expect.any(Object),
      { signal: controller.signal },
    );
    expect(client.completeAppleLyricsReprojection).toHaveBeenCalledWith(
      expect.any(Object),
      { signal: controller.signal },
    );
  });

  it('aborts a claim that has not returned without fabricating a lease failure', async () => {
    const job = claimedJob();
    const client = mockClient(job);
    const controller = new AbortController();
    client.enqueueAppleLyricsReprojection.mockResolvedValueOnce({
      enqueued: 0,
      remaining: 0,
    });
    client.claimAppleLyricsReprojection.mockImplementationOnce(
      async (_input, options) => new Promise<ClaimedAppleLyricsReprojectionJob[]>((_, reject) => {
        options?.signal?.addEventListener(
          'abort',
          () => reject(options.signal?.reason),
          { once: true },
        );
      }),
    );
    const worker = new AppleLyricsReprojectionWorker(
      client as unknown as SupabaseLyricsClient,
      { workerId: 'reproject-v2-test', leaseSeconds: 300, concurrency: 1 },
    );

    const pending = worker.runOnce({ signal: controller.signal });
    controller.abort(new DOMException('deadline exceeded', 'TimeoutError'));

    await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(client.completeAppleLyricsReprojection).not.toHaveBeenCalled();
    expect(client.failAppleLyricsReprojection).not.toHaveBeenCalled();
  });

  it('fails closed before parsing when the retained artifact hash is inconsistent', async () => {
    const valid = claimedJob();
    const job = claimedJob({
      sourceArtifact: {
        ...valid.sourceArtifact,
        contentHash: 'f'.repeat(64),
      },
    });
    const client = mockClient(job);
    const worker = new AppleLyricsReprojectionWorker(
      client as unknown as SupabaseLyricsClient,
      {
        workerId: 'reproject-v2-test',
        leaseSeconds: 300,
        concurrency: 1,
      },
    );

    await expect(worker.runOnce()).resolves.toMatchObject([{
      state: 'permanently-failed',
      jobId: job.jobId,
      attempts: 1,
      failure: {
        stage: 'parse',
        code: 'source-artifact-integrity',
        retryable: false,
      },
    }]);
    expect(client.completeAppleLyricsReprojection).not.toHaveBeenCalled();
    expect(client.failAppleLyricsReprojection).toHaveBeenCalledWith(
      {
        jobId: job.jobId,
        leaseToken: job.leaseToken,
        errorCode: 'parse:source-artifact-integrity',
        retryable: false,
        retryAfterSeconds: 1,
      },
      { signal: expect.any(AbortSignal) },
    );
  });

  it('durably retries a transient Supabase completion failure', async () => {
    const job = claimedJob();
    const client = mockClient(job);
    client.completeAppleLyricsReprojection.mockRejectedValueOnce(
      new TypeError('temporary network failure'),
    );
    const worker = new AppleLyricsReprojectionWorker(
      client as unknown as SupabaseLyricsClient,
      {
        workerId: 'reproject-v2-test',
        leaseSeconds: 300,
        concurrency: 1,
        now: () => 1_000_000,
        random: () => 0.5,
      },
    );

    await expect(worker.runOnce()).resolves.toMatchObject([{
      state: 'retry-scheduled',
      jobId: job.jobId,
      attempts: 1,
      availableAtMs: 1_030_000,
      failure: {
        stage: 'persist',
        code: 'network',
        retryable: true,
      },
    }]);
    expect(client.failAppleLyricsReprojection).toHaveBeenCalledWith(
      {
        jobId: job.jobId,
        leaseToken: job.leaseToken,
        errorCode: 'persist:network',
        retryable: true,
        retryAfterSeconds: 30,
      },
      { signal: expect.any(AbortSignal) },
    );
  });

  it('aborts completion with the operation signal but finalizes with a fresh signal', async () => {
    const job = claimedJob();
    const client = mockClient(job);
    const controller = new AbortController();
    client.completeAppleLyricsReprojection.mockImplementationOnce(
      async (_input, options) => new Promise<void>((_resolve, reject) => {
        options?.signal?.addEventListener(
          'abort',
          () => reject(options.signal?.reason),
          { once: true },
        );
      }),
    );
    const worker = new AppleLyricsReprojectionWorker(
      client as unknown as SupabaseLyricsClient,
      {
        workerId: 'reproject-v2-test',
        leaseSeconds: 300,
        concurrency: 1,
        random: () => 0.5,
      },
    );

    const pending = worker.runOnce({ signal: controller.signal });
    await vi.waitFor(() => {
      expect(client.completeAppleLyricsReprojection).toHaveBeenCalledTimes(1);
    });
    controller.abort(new DOMException('deadline exceeded', 'TimeoutError'));

    await expect(pending).resolves.toMatchObject([{
      state: 'retry-scheduled',
      failure: { stage: 'persist', code: 'timeout', retryable: true },
    }]);
    expect(client.completeAppleLyricsReprojection.mock.calls[0]![1]).toEqual({
      signal: controller.signal,
    });
    const finalizationSignal = client.failAppleLyricsReprojection.mock.calls[0]![1]?.signal;
    expect(finalizationSignal).toBeInstanceOf(AbortSignal);
    expect(finalizationSignal).not.toBe(controller.signal);
    expect(finalizationSignal?.aborted).toBe(false);
  });

  it('retries without completing when the deadline expires during claim', async () => {
    const job = claimedJob();
    const client = mockClient(job);
    const controller = new AbortController();
    client.claimAppleLyricsReprojection.mockImplementationOnce(async () => {
      controller.abort(new DOMException('deadline exceeded', 'TimeoutError'));
      return [job];
    });
    const worker = new AppleLyricsReprojectionWorker(
      client as unknown as SupabaseLyricsClient,
      {
        workerId: 'reproject-v2-test',
        leaseSeconds: 300,
        concurrency: 1,
        now: () => 1_000_000,
        random: () => 0.5,
      },
    );

    await expect(worker.runOnce({ signal: controller.signal })).resolves.toMatchObject([{
      state: 'retry-scheduled',
      failure: {
        stage: 'job',
        code: 'worker-stopped',
        retryable: true,
      },
    }]);
    expect(client.failAppleLyricsReprojection).toHaveBeenCalledTimes(1);
    expect(client.completeAppleLyricsReprojection).not.toHaveBeenCalled();
    expect(client.claimAppleLyricsReprojection).toHaveBeenCalledWith(
      expect.any(Object),
      { signal: controller.signal },
    );
    const finalizationSignal = client.failAppleLyricsReprojection.mock.calls[0]![1]?.signal;
    expect(finalizationSignal).toBeInstanceOf(AbortSignal);
    expect(finalizationSignal).not.toBe(controller.signal);
    expect(finalizationSignal?.aborted).toBe(false);
  });
});
