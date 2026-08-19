import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AppleLyricsTimelineRepairWorker } from './apple-lyrics-timeline-repair.js';
import type {
  ClaimedAppleLyricsTimelineRepairJob,
  SupabaseLyricsClient,
} from './supabase-lyrics-client.js';

const TTML_PREFIX = [
  '<tt xmlns="http://www.w3.org/ns/ttml"',
  ' xmlns:apple="http://music.apple.com/lyric-ttml-internal"',
  ' apple:timing="Line"><body><div>',
].join('');
const TTML_SUFFIX = '</div></body></tt>';

function repairableTtml(): string {
  return TTML_PREFIX + Array.from({ length: 12 }, (_, index) => (
    `<p begin="${600_000 + index * 1_000}ms">`
    + `<span begin="${10_000 + index * 10_000}ms">Line ${index + 1}</span>`
    + '</p>'
  )).join('') + TTML_SUFFIX;
}

function claimedJob(
  rawTtml = repairableTtml(),
  overrides: Partial<ClaimedAppleLyricsTimelineRepairJob> = {},
): ClaimedAppleLyricsTimelineRepairJob {
  const hash = createHash('sha256').update(rawTtml).digest('hex');
  return {
    jobId: '11111111-1111-4111-8111-111111111111',
    leaseToken: '22222222-2222-4222-8222-222222222222',
    leaseExpiresAt: '2026-07-19T18:00:00+00:00',
    attemptCount: 1,
    maxAttempts: 5,
    targetProjectionVersion: 'apple-ttml-line-model-v3',
    sourceAnomalyCode: 'timestamp-duration-overrun',
    sourceArtifact: {
      id: '33333333-3333-4333-8333-333333333333',
      revisionId: '44444444-4444-4444-8444-444444444444',
      providerName: 'apple',
      providerTrackId: '1450330685',
      storefront: 'cn',
      exactKey: 'exact-v2-anomaly',
      keyVersion: 1,
      locale: 'zh-Hans-CN',
      timingMode: 'line',
      recordingVariant: 'original',
      projectionVersion: 'apple-ttml-line-model-v2',
      rawTtml,
      contentHash: hash,
      byteSize: Buffer.byteLength(rawTtml),
      fetchedAt: '2026-07-19T12:00:00+00:00',
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
      exactKey: 'exact-v2-anomaly',
      keyVersion: 1,
    },
    ...overrides,
  };
}

function mockClient(job: ClaimedAppleLyricsTimelineRepairJob) {
  return {
    enqueueAppleLyricsTimelineRepair: vi.fn<
      SupabaseLyricsClient['enqueueAppleLyricsTimelineRepair']
    >(async () => ({
      enqueued: 1,
      remaining: 0,
    })),
    claimAppleLyricsTimelineRepair: vi.fn<
      SupabaseLyricsClient['claimAppleLyricsTimelineRepair']
    >(async () => [job]),
    completeAppleLyricsTimelineRepair: vi.fn<
      SupabaseLyricsClient['completeAppleLyricsTimelineRepair']
    >(async () => undefined),
    failAppleLyricsTimelineRepair: vi.fn<
      SupabaseLyricsClient['failAppleLyricsTimelineRepair']
    >(async () => undefined),
  };
}

describe('AppleLyricsTimelineRepairWorker', () => {
  it('rejects concurrency above the single durable worker slot', () => {
    expect(() => new AppleLyricsTimelineRepairWorker(
      mockClient(claimedJob()) as unknown as SupabaseLyricsClient,
      { workerId: 'timeline-repair-v3-test', leaseSeconds: 300, concurrency: 2 },
    )).toThrow('concurrency must be between 1 and 1');
  });

  it('polls the durable queue without starting a corpus-wide enqueue scan', async () => {
    const job = claimedJob();
    const client = {
      enqueueAppleLyricsTimelineRepair: vi.fn(async () => {
        throw new Error('the hot poll path must not scan the full corpus');
      }),
      claimAppleLyricsTimelineRepair: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([job]),
      completeAppleLyricsTimelineRepair: vi.fn(async () => undefined),
      failAppleLyricsTimelineRepair: vi.fn(async () => undefined),
    };
    const worker = new AppleLyricsTimelineRepairWorker(
      client as unknown as SupabaseLyricsClient,
      {
        workerId: 'timeline-repair-v3-test',
        leaseSeconds: 300,
      },
    );

    await expect(worker.runOnce()).resolves.toEqual([]);
    await expect(worker.runOnce()).resolves.toEqual([{
      state: 'succeeded',
      jobId: job.jobId,
      artifactSha256: job.sourceArtifact.contentHash,
    }]);
    expect(client.enqueueAppleLyricsTimelineRepair).not.toHaveBeenCalled();
    expect(client.claimAppleLyricsTimelineRepair).toHaveBeenCalledTimes(2);
    expect(client.claimAppleLyricsTimelineRepair).toHaveBeenNthCalledWith(1, {
      workerId: 'timeline-repair-v3-test',
      limit: 1,
      leaseSeconds: 300,
    });
    expect(client.claimAppleLyricsTimelineRepair).toHaveBeenNthCalledWith(2, {
      workerId: 'timeline-repair-v3-test',
      limit: 1,
      leaseSeconds: 300,
    });
    expect(client.completeAppleLyricsTimelineRepair).toHaveBeenCalledTimes(1);
  });

  it('forwards the operation signal through claim and completion', async () => {
    const job = claimedJob();
    const client = mockClient(job);
    const controller = new AbortController();
    const worker = new AppleLyricsTimelineRepairWorker(
      client as unknown as SupabaseLyricsClient,
      { workerId: 'timeline-repair-v3-test', leaseSeconds: 300, concurrency: 1 },
    );

    await expect(worker.runOnce({ signal: controller.signal })).resolves.toHaveLength(1);

    expect(client.claimAppleLyricsTimelineRepair).toHaveBeenCalledWith(
      expect.any(Object),
      { signal: controller.signal },
    );
    expect(client.completeAppleLyricsTimelineRepair).toHaveBeenCalledWith(
      expect.any(Object),
      { signal: controller.signal },
    );
  });

  it('aborts a claim that has not returned without fabricating a lease failure', async () => {
    const job = claimedJob();
    const client = mockClient(job);
    const controller = new AbortController();
    client.claimAppleLyricsTimelineRepair.mockImplementationOnce(
      async (_input, options) => new Promise<ClaimedAppleLyricsTimelineRepairJob[]>((_, reject) => {
        options?.signal?.addEventListener(
          'abort',
          () => reject(options.signal?.reason),
          { once: true },
        );
      }),
    );
    const worker = new AppleLyricsTimelineRepairWorker(
      client as unknown as SupabaseLyricsClient,
      { workerId: 'timeline-repair-v3-test', leaseSeconds: 300, concurrency: 1 },
    );

    const pending = worker.runOnce({ signal: controller.signal });
    controller.abort(new DOMException('deadline exceeded', 'TimeoutError'));

    await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(client.completeAppleLyricsTimelineRepair).not.toHaveBeenCalled();
    expect(client.failAppleLyricsTimelineRepair).not.toHaveBeenCalled();
  });

  it('repairs retained v2 TTML without making an Apple request', async () => {
    const job = claimedJob();
    const client = mockClient(job);
    const worker = new AppleLyricsTimelineRepairWorker(
      client as unknown as SupabaseLyricsClient,
      {
        workerId: 'timeline-repair-v3-test',
        leaseSeconds: 300,
        concurrency: 1,
      },
    );

    await expect(worker.runOnce()).resolves.toEqual([{
      state: 'succeeded',
      jobId: job.jobId,
      artifactSha256: job.sourceArtifact.contentHash,
    }]);
    expect(client.completeAppleLyricsTimelineRepair).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: job.jobId,
        sourceArtifactId: job.sourceArtifact.id,
        payload: expect.objectContaining({
          synced_lyrics: expect.stringContaining('[00:10.000]Line 1'),
          duration_ms: 180_000,
        }),
        provenance: expect.objectContaining({
          body_format: 'apple-ttml-line-projection-v3-ms',
          projection_version: 'apple-ttml-line-model-v3',
          source_projection_version: 'apple-ttml-line-model-v2',
          timeline_validation_outcome: 'repaired',
          timeline_source_anomaly: 'timestamp-duration-overrun',
          timeline_repair_method: 'word-span-line-start-v1',
        }),
      }),
    );
    expect(client.failAppleLyricsTimelineRepair).not.toHaveBeenCalled();
  });

  it('permanently rejects an anomaly without complete independent span evidence', async () => {
    const rawTtml = TTML_PREFIX + Array.from({ length: 12 }, (_, index) => (
      `<p begin="${600_000 + index * 1_000}ms">Line ${index + 1}</p>`
    )).join('') + TTML_SUFFIX;
    const job = claimedJob(rawTtml);
    const client = mockClient(job);
    const worker = new AppleLyricsTimelineRepairWorker(
      client as unknown as SupabaseLyricsClient,
      {
        workerId: 'timeline-repair-v3-test',
        leaseSeconds: 300,
        concurrency: 1,
      },
    );

    await expect(worker.runOnce()).resolves.toMatchObject([{
      state: 'permanently-failed',
      jobId: job.jobId,
      failure: {
        stage: 'parse',
        code: 'timeline-unrepairable',
        retryable: false,
      },
    }]);
    expect(client.completeAppleLyricsTimelineRepair).not.toHaveBeenCalled();
    expect(client.failAppleLyricsTimelineRepair).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: job.jobId,
        errorCode: 'parse:timeline-unrepairable',
        retryable: false,
      }),
      { signal: expect.any(AbortSignal) },
    );
  });

  it('aborts completion with the operation signal but finalizes with a fresh signal', async () => {
    const job = claimedJob();
    const client = mockClient(job);
    const controller = new AbortController();
    client.completeAppleLyricsTimelineRepair.mockImplementationOnce(
      async (_input, options) => new Promise<void>((_resolve, reject) => {
        options?.signal?.addEventListener(
          'abort',
          () => reject(options.signal?.reason),
          { once: true },
        );
      }),
    );
    const worker = new AppleLyricsTimelineRepairWorker(
      client as unknown as SupabaseLyricsClient,
      {
        workerId: 'timeline-repair-v3-test',
        leaseSeconds: 300,
        concurrency: 1,
        random: () => 0.5,
      },
    );

    const pending = worker.runOnce({ signal: controller.signal });
    await vi.waitFor(() => {
      expect(client.completeAppleLyricsTimelineRepair).toHaveBeenCalledTimes(1);
    });
    controller.abort(new DOMException('deadline exceeded', 'TimeoutError'));

    await expect(pending).resolves.toMatchObject([{
      state: 'retry-scheduled',
      failure: { stage: 'persist', code: 'timeout', retryable: true },
    }]);
    expect(client.completeAppleLyricsTimelineRepair.mock.calls[0]![1]).toEqual({
      signal: controller.signal,
    });
    const finalizationSignal = client.failAppleLyricsTimelineRepair.mock.calls[0]![1]?.signal;
    expect(finalizationSignal).toBeInstanceOf(AbortSignal);
    expect(finalizationSignal).not.toBe(controller.signal);
    expect(finalizationSignal?.aborted).toBe(false);
  });

  it('rejects changed retained bytes before parsing or persistence', async () => {
    const job = claimedJob();
    job.sourceArtifact.rawTtml += ' ';
    const client = mockClient(job);
    const worker = new AppleLyricsTimelineRepairWorker(
      client as unknown as SupabaseLyricsClient,
      {
        workerId: 'timeline-repair-v3-test',
        leaseSeconds: 300,
        concurrency: 1,
      },
    );

    await expect(worker.runOnce()).resolves.toMatchObject([{
      state: 'permanently-failed',
      failure: {
        stage: 'parse',
        code: 'source-artifact-integrity',
      },
    }]);
    expect(client.completeAppleLyricsTimelineRepair).not.toHaveBeenCalled();
  });

  it('retries without completing when the deadline expires during claim', async () => {
    const job = claimedJob();
    const client = mockClient(job);
    const controller = new AbortController();
    client.claimAppleLyricsTimelineRepair.mockImplementationOnce(async () => {
      controller.abort(new DOMException('deadline exceeded', 'TimeoutError'));
      return [job];
    });
    const worker = new AppleLyricsTimelineRepairWorker(
      client as unknown as SupabaseLyricsClient,
      {
        workerId: 'timeline-repair-v3-test',
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
    expect(client.failAppleLyricsTimelineRepair).toHaveBeenCalledTimes(1);
    expect(client.completeAppleLyricsTimelineRepair).not.toHaveBeenCalled();
    expect(client.claimAppleLyricsTimelineRepair).toHaveBeenCalledWith(
      expect.any(Object),
      { signal: controller.signal },
    );
    const finalizationSignal = client.failAppleLyricsTimelineRepair.mock.calls[0]![1]?.signal;
    expect(finalizationSignal).toBeInstanceOf(AbortSignal);
    expect(finalizationSignal).not.toBe(controller.signal);
    expect(finalizationSignal?.aborted).toBe(false);
  });
});
