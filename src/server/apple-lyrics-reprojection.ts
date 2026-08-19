import { createHash } from 'node:crypto';
import {
  AppleLyricsBackfillError,
  APPLE_LYRICS_FINALIZATION_TIMEOUT_MS,
  appleLyricsBackfillDelayMs,
  classifyAppleLyricsBackfillError,
  type AppleLyricsBackfillFailure,
  type AppleLyricsBackfillProcessResult,
  type AppleLyricsBackfillStage,
} from './apple-lyrics-backfill.js';
import {
  APPLE_TTML_STATIC_BODY_FORMAT,
  APPLE_TTML_SYNCED_BODY_FORMAT,
  AppleTtmlProjectionParser,
  appleTtmlProjectionPayload,
} from './supabase-apple-lyrics-backfill.js';
import {
  SupabaseLyricsClient,
  type ClaimedAppleLyricsReprojectionJob,
} from './supabase-lyrics-client.js';

export const APPLE_TTML_REPROJECTION_VERSION =
  'apple-ttml-line-model-v2' as const;
export const APPLE_TTML_REPROJECTION_DEFAULT_CONCURRENCY = 1;
export const APPLE_TTML_REPROJECTION_MAX_CONCURRENCY = 1;

/**
 * Rebuilds normalized lyrics exclusively from immutable TTML already retained
 * in Supabase. This worker has no Apple source dependency or Apple credential.
 */
export class AppleLyricsReprojectionWorker {
  private readonly parser = new AppleTtmlProjectionParser();
  private enqueueComplete = false;
  private readonly finalizationTimeoutMs: number;

  constructor(
    private readonly client: SupabaseLyricsClient,
    private readonly options: {
      workerId: string;
      leaseSeconds: number;
      concurrency?: number;
      finalizationTimeoutMs?: number;
      now?: () => number;
      random?: () => number;
    },
  ) {
    const concurrency = options.concurrency
      ?? APPLE_TTML_REPROJECTION_DEFAULT_CONCURRENCY;
    if (
      !Number.isSafeInteger(concurrency)
      || concurrency < 1
      || concurrency > APPLE_TTML_REPROJECTION_MAX_CONCURRENCY
    ) {
      throw new Error(
        `concurrency must be between 1 and ${APPLE_TTML_REPROJECTION_MAX_CONCURRENCY}`,
      );
    }
    if (
      !Number.isSafeInteger(options.leaseSeconds)
      || options.leaseSeconds < 30
      || options.leaseSeconds > 900
    ) {
      throw new Error('leaseSeconds must be between 30 and 900');
    }
    this.finalizationTimeoutMs = options.finalizationTimeoutMs
      ?? APPLE_LYRICS_FINALIZATION_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.finalizationTimeoutMs)
      || this.finalizationTimeoutMs < 100
      || this.finalizationTimeoutMs > 30_000
    ) {
      throw new Error('finalizationTimeoutMs must be between 100 and 30000');
    }
  }

  async runOnce(options: {
    signal?: AbortSignal;
  } = {}): Promise<AppleLyricsBackfillProcessResult[]> {
    options.signal?.throwIfAborted();
    if (!this.enqueueComplete) {
      const enqueue = options.signal
        ? await this.client.enqueueAppleLyricsReprojection(10_000, {
            signal: options.signal,
          })
        : await this.client.enqueueAppleLyricsReprojection(10_000);
      this.enqueueComplete = enqueue.remaining === 0;
    }
    options.signal?.throwIfAborted();
    const claimInput = {
      workerId: this.options.workerId,
      limit: this.options.concurrency
        ?? APPLE_TTML_REPROJECTION_DEFAULT_CONCURRENCY,
      leaseSeconds: this.options.leaseSeconds,
    };
    const jobs = options.signal
      ? await this.client.claimAppleLyricsReprojection(claimInput, {
          signal: options.signal,
        })
      : await this.client.claimAppleLyricsReprojection(claimInput);
    return Promise.all(jobs.map((job) => this.processOne(job, options)));
  }

  private async processOne(
    job: ClaimedAppleLyricsReprojectionJob,
    options: { signal?: AbortSignal },
  ): Promise<AppleLyricsBackfillProcessResult> {
    let stage: AppleLyricsBackfillStage = 'job';
    try {
      validateClaim(job);
      if (options.signal?.aborted) {
        throw new AppleLyricsBackfillError('worker-stopped', {
          retryable: true,
        });
      }

      stage = 'parse';
      validateSourceArtifact(job);
      const parsed = await this.parser.parse({
        ttml: job.sourceArtifact.rawTtml,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const payload = appleTtmlProjectionPayload({
        parsed,
        providerTrackId: job.sourceArtifact.providerTrackId,
        durationMs: job.track.durationMs,
      });

      stage = 'persist';
      const completionInput = {
        jobId: job.jobId,
        leaseToken: job.leaseToken,
        sourceArtifactId: job.sourceArtifact.id,
        sourceArtifactHash: job.sourceArtifact.contentHash,
        sourceArtifactBytes: job.sourceArtifact.byteSize,
        payload,
        provenance: {
          lookup_strategy: 'apple-retained-ttml-reprojection-v2',
          body_format: parsed.kind === 'synced'
            ? APPLE_TTML_SYNCED_BODY_FORMAT
            : APPLE_TTML_STATIC_BODY_FORMAT,
          exact_identity_proof_version: job.identityProof.proofVersion,
          exact_identity_evidence: [...job.identityProof.evidence],
          source_artifact_id: job.sourceArtifact.id,
          source_revision_id: job.sourceArtifact.revisionId,
          source_projection_version: job.sourceArtifact.projectionVersion,
          projection_version: job.targetProjectionVersion,
        },
        timingMode: parsed.sourceTimingMode,
      };
      if (options.signal) {
        await this.client.completeAppleLyricsReprojection(completionInput, {
          signal: options.signal,
        });
      } else {
        await this.client.completeAppleLyricsReprojection(completionInput);
      }
      return {
        state: 'succeeded',
        jobId: job.jobId,
        artifactSha256: job.sourceArtifact.contentHash,
      };
    } catch (error) {
      const classified = classifyAppleLyricsBackfillError(error, stage);
      const exhausted = job.attemptCount >= job.maxAttempts;
      const retryable = classified.retryable && !exhausted;
      const failure: AppleLyricsBackfillFailure = {
        stage,
        code: classified.code,
        retryable,
        exhausted: classified.retryable && exhausted,
      };
      const delayMs = retryable
        ? appleLyricsBackfillDelayMs(
            job.attemptCount,
            undefined,
            this.options.random ?? Math.random,
          )
        : 1_000;
      await this.client.failAppleLyricsReprojection({
        jobId: job.jobId,
        leaseToken: job.leaseToken,
        errorCode: `${stage}:${classified.code}`.slice(0, 128),
        retryable,
        retryAfterSeconds: Math.max(1, Math.ceil(delayMs / 1_000)),
      }, { signal: AbortSignal.timeout(this.finalizationTimeoutMs) });
      if (!retryable) {
        return {
          state: 'permanently-failed',
          jobId: job.jobId,
          attempts: job.attemptCount,
          failure,
        };
      }
      return {
        state: 'retry-scheduled',
        jobId: job.jobId,
        attempts: job.attemptCount,
        availableAtMs: (this.options.now?.() ?? Date.now()) + delayMs,
        failure,
      };
    }
  }
}

function validateClaim(job: ClaimedAppleLyricsReprojectionJob): void {
  if (
    job.targetProjectionVersion !== APPLE_TTML_REPROJECTION_VERSION
    || job.sourceArtifact.projectionVersion !== 'apple-ttml-line-model-v1'
  ) {
    throw new AppleLyricsBackfillError('invalid-projection-version', {
      retryable: false,
    });
  }
  if (
    job.identityProof.providerName !== 'apple'
    || job.sourceArtifact.providerName !== 'apple'
    || job.identityProof.providerTrackId !== job.sourceArtifact.providerTrackId
    || job.identityProof.exactKey !== job.sourceArtifact.exactKey
    || job.identityProof.keyVersion !== job.sourceArtifact.keyVersion
  ) {
    throw new AppleLyricsBackfillError('invalid-exact-identity-proof', {
      retryable: false,
    });
  }
}

function validateSourceArtifact(job: ClaimedAppleLyricsReprojectionJob): void {
  const byteSize = Buffer.byteLength(job.sourceArtifact.rawTtml, 'utf8');
  const contentHash = createHash('sha256')
    .update(job.sourceArtifact.rawTtml, 'utf8')
    .digest('hex');
  if (
    byteSize !== job.sourceArtifact.byteSize
    || contentHash !== job.sourceArtifact.contentHash
  ) {
    throw new AppleLyricsBackfillError('source-artifact-integrity', {
      retryable: false,
    });
  }
}
