import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { LyricsPayload, TrackMetadata } from '../shared/contracts.js';
import { parseLrc, plainLyricsToLines } from '../shared/lrc.js';
import { lyricsLookupFingerprint, lyricsWorkFingerprint } from '../shared/track.js';
import {
  isExplicitInstrumentalTitle,
  scriptEquivalentTrackMetadata,
  trackScriptVariants,
} from './lyrics-metadata-alias.js';
import { projectAppleLyricsToSimplified } from './lyrics-script-preference.js';
import type {
  LyricsLibraryClient,
  LyricsLibraryExactWrite,
  LyricsLibraryQuarantineCompareInput,
  LyricsLibraryQuarantineCompareResult,
  LyricsLibraryResolveInput,
  LyricsLibraryResolveResult,
  LyricsLibraryWorkWrite,
} from './lyrics-repository.js';

const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;
// Four source artifacts are capped at 512 KiB before JSON encoding. Allow
// bounded headroom for escaped XML plus lease/proof metadata without applying
// this larger limit to serving-path RPCs.
const MAX_REPROJECTION_CLAIM_RESPONSE_BYTES = 6 * 1_024 * 1_024;
const WORK_FALLBACK_NOTICE = '未找到当前版本歌词，当前显示同一作品歌词（静态模式）。';

const resolveHitSchema = z.object({
  result_status: z.enum(['hit', 'miss', 'ambiguous']),
  match_kind: z.enum(['exact', 'work']).nullable().optional(),
  document_id: z.string().uuid().nullable().optional(),
  synced_lyrics: z.string().max(512_000).nullable().optional(),
  plain_lyrics: z.string().max(512_000).nullable().optional(),
  is_instrumental: z.boolean().optional().default(false),
  provider_name: z.string().max(128).nullable().optional(),
  provider_track_id: z.union([z.string(), z.number()]).nullable().optional(),
  selection_method: z.enum([
    'provider',
    'manual',
    'candidate',
    'legacy_import',
  ]).optional(),
  auto_scroll: z.boolean().optional().default(false),
  candidates: z.array(z.unknown()).max(50).optional(),
  candidate_count: z.number().int().nonnegative().max(1_000_000).optional(),
  raw_metadata: z.unknown().optional(),
  provider_route: z.string().max(128).nullable().optional(),
}).passthrough();
const resolveResponseSchema = resolveHitSchema.extend({
  provider_fallback: resolveHitSchema.nullable().optional(),
}).passthrough();

const rawMetadataSchema = z.object({
  title: z.string().max(2_048),
  artist: z.string().max(2_048),
  album: z.string().max(2_048).optional().default(''),
  duration_ms: z.number().nonnegative(),
  source: z.string().max(256).optional().default('Supabase'),
}).passthrough();

const quarantineComparisonKindSchema = z.object({
  candidate_count: z.number().int().nonnegative().max(1_000_000),
  comparisons: z.number().int().nonnegative().max(1_000_000),
  agreements: z.number().int().nonnegative().max(1_000_000),
  disagreements: z.number().int().nonnegative().max(1_000_000),
}).superRefine((value, context) => {
  if (
    value.comparisons > value.candidate_count ||
    value.agreements + value.disagreements !== value.comparisons
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Invalid quarantine comparison counters',
    });
  }
});

const quarantineComparisonResponseSchema = z.object({
  exact: quarantineComparisonKindSchema,
  work: quarantineComparisonKindSchema,
}).passthrough();

const appleBackfillEnqueueResponseSchema = z.object({
  job_id: z.string().uuid(),
  status: z.enum([
    'pending',
    'processing',
    'retry_wait',
    'completed',
    'dead_letter',
    'cancelled',
  ]),
  attempt_count: z.number().int().nonnegative().max(20),
  max_attempts: z.number().int().min(1).max(20),
}).passthrough();

const appleQueueMetricSchema = z.object({
  pending: z.number().int().nonnegative(),
  processing: z.number().int().nonnegative(),
  expired_processing: z.number().int().nonnegative(),
  oldest_pending_at: z.string().datetime({ offset: true }).nullable(),
  next_lease_expiry_at: z.string().datetime({ offset: true }).nullable(),
});
const appleQueueStatsResponseSchema = z.object({
  backfill: appleQueueMetricSchema.optional(),
  reprojection: appleQueueMetricSchema.optional(),
  'timeline-repair': appleQueueMetricSchema.optional(),
}).passthrough();

export interface AppleLyricsQueueMetric {
  pending: number;
  processing: number;
  expiredProcessing: number;
  oldestPendingAt: string | null;
  nextLeaseExpiryAt: string | null;
}

export type AppleLyricsQueueStats = Partial<Record<
  'backfill' | 'reprojection' | 'timeline-repair',
  AppleLyricsQueueMetric
>>;

const appleBackfillClaimResponseSchema = z.array(z.object({
  job_id: z.string().uuid(),
  lease_token: z.string().uuid(),
  attempt_count: z.number().int().min(1).max(20),
  max_attempts: z.number().int().min(1).max(20),
  exact_key: z.string().min(1).max(512),
  key_version: z.number().int().min(1).max(32_767),
  storefront: z.string().regex(/^[a-z]{2}$/),
  locale: z.string().min(1).max(35),
  provider_track_id: z.string().min(1).max(512).nullable().optional(),
  isrc: z.string().min(1).max(32).nullable().optional(),
  track_metadata: rawMetadataSchema,
})).max(10);

const appleBackfillCompleteResponseSchema = z.object({
  job_id: z.string().uuid(),
  status: z.literal('completed'),
  document_id: z.string().uuid(),
  revision_id: z.string().uuid(),
  artifact_id: z.string().uuid(),
  artifact_content_hash: z.string().regex(/^[0-9a-f]{64}$/),
  artifact_bytes: z.number().int().positive().max(512 * 1_024),
  storefront: z.string().regex(/^[a-z]{2}$/),
  effective_status: z.enum(['quarantine', 'active', 'rejected', 'superseded']),
  promotion_blocked: z.boolean(),
}).passthrough();

const appleReprojectionEnqueueResponseSchema = z.object({
  target_projection_version: z.literal('apple-ttml-line-model-v2'),
  enqueued: z.number().int().nonnegative().max(1_000_000),
  remaining: z.number().int().nonnegative().max(1_000_000),
}).passthrough();

const appleReprojectionSourceArtifactSchema = z.object({
  id: z.string().uuid(),
  revision_id: z.string().uuid(),
  provider_name: z.literal('apple'),
  provider_track_id: z.string().min(1).max(512),
  storefront: z.string().regex(/^[a-z]{2}$/),
  exact_key: z.string().min(1).max(512),
  key_version: z.number().int().min(1).max(32_767),
  locale: z.string().min(1).max(35),
  timing_mode: z.enum([
    'none',
    'line',
    'word',
    'syllable',
    'missing',
    'unsupported',
    'unknown',
  ]),
  recording_variant: z.string().min(1).max(128),
  projection_version: z.literal('apple-ttml-line-model-v1'),
  raw_ttml: z.string().min(1).max(512 * 1_024),
  content_hash: z.string().regex(/^[0-9a-f]{64}$/),
  byte_size: z.number().int().positive().max(512 * 1_024),
  fetched_at: z.string().datetime({ offset: true }),
});

const appleReprojectionIdentityProofSchema = z.object({
  proof_version: z.literal(1),
  evidence: z.array(z.string().min(1).max(128)).min(1).max(32),
  provider_name: z.literal('apple'),
  provider_track_id: z.string().min(1).max(512),
  exact_key: z.string().min(1).max(512),
  key_version: z.number().int().min(1).max(32_767),
});

const appleReprojectionClaimResponseSchema = z.array(z.object({
  job_id: z.string().uuid(),
  lease_token: z.string().uuid(),
  lease_expires_at: z.string().datetime({ offset: true }),
  attempt_count: z.number().int().min(1).max(20),
  max_attempts: z.number().int().min(1).max(20),
  target_projection_version: z.literal('apple-ttml-line-model-v2'),
  source_artifact: appleReprojectionSourceArtifactSchema,
  track_metadata: rawMetadataSchema,
  identity_proof: appleReprojectionIdentityProofSchema,
})).max(4);

const appleReprojectionCompleteResponseSchema = z.object({
  job_id: z.string().uuid(),
  status: z.literal('completed'),
  source_artifact_id: z.string().uuid(),
  document_id: z.string().uuid(),
  revision_id: z.string().uuid(),
  artifact_id: z.string().uuid(),
  target_projection_version: z.literal('apple-ttml-line-model-v2'),
  normalized_content_hash: z.string().regex(/^[0-9a-f]{64}$/),
  artifact_content_hash: z.string().regex(/^[0-9a-f]{64}$/),
  artifact_bytes: z.number().int().positive().max(512 * 1_024),
  effective_status: z.literal('quarantine'),
  serving_binding_unchanged: z.literal(true),
}).passthrough();

const appleTimelineRepairAnomalySchema = z.enum([
  'timestamp-duration-overrun',
  'collapsed-timeline-coverage',
]);

const appleTimelineRepairEnqueueResponseSchema = z.object({
  target_projection_version: z.literal('apple-ttml-line-model-v3'),
  enqueued: z.number().int().nonnegative().max(1_000_000),
  remaining: z.number().int().nonnegative().max(1_000_000),
}).passthrough();

const appleTimelineRepairClaimResponseSchema = z.array(z.object({
  job_id: z.string().uuid(),
  lease_token: z.string().uuid(),
  lease_expires_at: z.string().datetime({ offset: true }),
  attempt_count: z.number().int().min(1).max(20),
  max_attempts: z.number().int().min(1).max(20),
  target_projection_version: z.literal('apple-ttml-line-model-v3'),
  source_anomaly_code: appleTimelineRepairAnomalySchema,
  source_artifact: appleReprojectionSourceArtifactSchema.extend({
    projection_version: z.literal('apple-ttml-line-model-v2'),
  }),
  track_metadata: rawMetadataSchema,
  identity_proof: appleReprojectionIdentityProofSchema,
})).max(4);

const appleTimelineRepairCompleteResponseSchema =
  appleReprojectionCompleteResponseSchema.extend({
    target_projection_version: z.literal('apple-ttml-line-model-v3'),
  });

export interface SupabaseLyricsClientOptions {
  url: string;
  secretKey: string;
  libraryId: string;
  timeoutMs: number;
  writeTimeoutMs?: number;
  backfillTimeoutMs?: number;
  fetcher?: typeof fetch;
}

export interface SupabaseLyricsRequestOptions {
  signal?: AbortSignal;
}

interface SupabaseRpcOptions extends SupabaseLyricsRequestOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface AppleLyricsBackfillEnqueueInput {
  exactKey: string;
  keyVersion: number;
  storefront: string;
  locale: string;
  track: TrackMetadata;
  providerTrackId?: string;
  isrc?: string;
  priority?: number;
  maxAttempts?: number;
}

export interface ClaimedAppleLyricsBackfillJob {
  jobId: string;
  leaseToken: string;
  /** Number of attempts completed before the lease represented by this row. */
  attempts: number;
  maxAttempts: number;
  exactKey: string;
  keyVersion: number;
  storefront: string;
  locale: string;
  providerTrackId?: string;
  isrc?: string;
  track: TrackMetadata;
}

export interface CompleteAppleLyricsBackfillInput {
  jobId: string;
  leaseToken: string;
  providerTrackId: string;
  storefront: string;
  rawMetadata: Record<string, unknown>;
  payload: Record<string, unknown>;
  provenance: Record<string, unknown>;
  rawTtml: string;
  locale: string;
  timingMode: string;
  recordingVariant: string;
}

export interface ClaimedAppleLyricsReprojectionJob {
  jobId: string;
  leaseToken: string;
  leaseExpiresAt: string;
  attemptCount: number;
  maxAttempts: number;
  targetProjectionVersion: 'apple-ttml-line-model-v2';
  sourceArtifact: {
    id: string;
    revisionId: string;
    providerName: 'apple';
    providerTrackId: string;
    storefront: string;
    exactKey: string;
    keyVersion: number;
    locale: string;
    timingMode: z.infer<typeof appleReprojectionSourceArtifactSchema>['timing_mode'];
    recordingVariant: string;
    projectionVersion: 'apple-ttml-line-model-v1';
    rawTtml: string;
    contentHash: string;
    byteSize: number;
    fetchedAt: string;
  };
  track: TrackMetadata;
  identityProof: {
    proofVersion: 1;
    evidence: string[];
    providerName: 'apple';
    providerTrackId: string;
    exactKey: string;
    keyVersion: number;
  };
}

export interface CompleteAppleLyricsReprojectionInput {
  jobId: string;
  leaseToken: string;
  sourceArtifactId: string;
  sourceArtifactHash: string;
  sourceArtifactBytes: number;
  payload: Record<string, unknown>;
  provenance: Record<string, unknown>;
  timingMode: string;
}

export interface ClaimedAppleLyricsTimelineRepairJob {
  jobId: string;
  leaseToken: string;
  leaseExpiresAt: string;
  attemptCount: number;
  maxAttempts: number;
  targetProjectionVersion: 'apple-ttml-line-model-v3';
  sourceAnomalyCode: z.infer<typeof appleTimelineRepairAnomalySchema>;
  sourceArtifact: {
    id: string;
    revisionId: string;
    providerName: 'apple';
    providerTrackId: string;
    storefront: string;
    exactKey: string;
    keyVersion: number;
    locale: string;
    timingMode: z.infer<typeof appleReprojectionSourceArtifactSchema>['timing_mode'];
    recordingVariant: string;
    projectionVersion: 'apple-ttml-line-model-v2';
    rawTtml: string;
    contentHash: string;
    byteSize: number;
    fetchedAt: string;
  };
  track: TrackMetadata;
  identityProof: ClaimedAppleLyricsReprojectionJob['identityProof'];
}

export type CompleteAppleLyricsTimelineRepairInput =
  CompleteAppleLyricsReprojectionInput;

export class SupabaseLyricsClient implements LyricsLibraryClient {
  private readonly baseUrl: URL;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: SupabaseLyricsClientOptions) {
    this.baseUrl = new URL(options.url);
    if (!['http:', 'https:'].includes(this.baseUrl.protocol)) {
      throw new Error('SUPABASE_URL must use HTTP or HTTPS');
    }
    z.string().uuid().parse(options.libraryId);
    if (!options.secretKey) throw new Error('SUPABASE_SECRET_KEY is required');
    this.fetcher = options.fetcher ?? fetch;
  }

  async observeAppleLyricsQueue(
    options: SupabaseLyricsRequestOptions = {},
  ): Promise<AppleLyricsQueueStats> {
    const result = appleQueueStatsResponseSchema.parse(await this.rpc(
      'observe_apple_lyrics_queue',
      { p_library_id: this.options.libraryId },
      { timeoutMs: this.options.timeoutMs, ...options },
    ));
    const queues = ['backfill', 'reprojection', 'timeline-repair'] as const;
    return Object.fromEntries(
      queues.flatMap((queue) => {
        const metric = result[queue];
        return metric ? [[queue, {
          pending: metric.pending,
          processing: metric.processing,
          expiredProcessing: metric.expired_processing,
          oldestPendingAt: metric.oldest_pending_at,
          nextLeaseExpiryAt: metric.next_lease_expiry_at,
        }]] : [];
      }),
    ) as AppleLyricsQueueStats;
  }

  async resolve(input: LyricsLibraryResolveInput): Promise<LyricsLibraryResolveResult> {
    const deadlineMs = performance.now() + this.options.timeoutMs;
    const request = async (exactKey: string | null, workKey: string | null) => {
      const remainingMs = Math.floor(deadlineMs - performance.now());
      if (remainingMs < 1) throw new SupabaseRequestError('timeout');
      return resolveResponseSchema.parse(await this.rpc('resolve_lyrics', {
        p_library_id: this.options.libraryId,
        p_exact_key: exactKey,
        p_work_key: workKey,
        p_key_version: input.keyVersion,
      }, { timeoutMs: remainingMs }));
    };
    try {
      const result = await request(
        input.exactKey,
        input.allowWorkFallback ? input.workKey : null,
      );
      const provisionalInstrumental = isUnverifiedProviderInstrumental(input, result);
      if (result.result_status !== 'miss' && !provisionalInstrumental) {
        // The first request intentionally omits the Work capability when the
        // caller is checking only the current recording. A plain automatic
        // LRCLIB Exact can nevertheless be superseded by a validated Apple
        // synchronized duration alias. Probe that route once with the Work
        // key, but keep the already-valid Exact result if the optional probe
        // times out, fails validation, or finds no alias.
        if (
          !input.allowWorkFallback
          && input.workKey
          && shouldProbeSynchronizedAppleDurationAlias(result)
        ) {
          try {
            const alias = await request(input.exactKey, input.workKey);
            if (
              alias.result_status === 'hit'
              && alias.match_kind === 'work'
              && alias.provider_route === 'apple-duration-alias-synced-v1'
              && alias.auto_scroll
            ) {
              const resolvedAlias = resolvedLyricsResult(
                { ...input, allowWorkFallback: true },
                alias,
                input.exactKey,
                false,
              );
              if (
                resolvedAlias.state === 'hit'
                && resolvedAlias.providerRoute === 'apple-duration-alias-synced-v1'
                && resolvedAlias.payload.kind === 'synced'
              ) {
                return resolvedAlias;
              }
            }
          } catch {
            // The initial Exact hit remains authoritative when the optional
            // alias probe cannot complete within the shared timeout budget.
          }
        }
        return resolvedLyricsResult(input, result, input.exactKey, false);
      }

      // Preserve v1 fingerprints while bridging deterministic Simplified /
      // Traditional metadata aliases. Tesla also frequently reports whole-
      // second durations while Apple retains milliseconds, so probe only the
      // one adjacent v1 bucket that can still be within the verifier's 500ms
      // identity tolerance. Every probe shares this resolve's total timeout.
      for (const aliasKey of verifiedAppleExactAliasKeys(input)) {
        const alias = await request(aliasKey, null);
        if (alias.result_status !== 'hit') continue;
        const resolved = resolvedLyricsResult(input, alias, aliasKey, true);
        if (resolved.state === 'hit') return resolved;
      }

      // An unverified Exact instrumental can otherwise shadow a legitimate
      // work fallback inside the SQL resolver. Re-run without the Exact key so
      // Live/Acoustic static fallback semantics remain intact.
      if (provisionalInstrumental && input.allowWorkFallback && input.workKey) {
        const work = await request(null, input.workKey);
        if (work.result_status !== 'miss') {
          return resolvedLyricsResult(input, work, input.exactKey, false);
        }
      }
      return { state: 'miss' };
    } catch (error) {
      return { state: 'unavailable', reason: unavailableReason(error) };
    }
  }

  async compareQuarantined(
    input: LyricsLibraryQuarantineCompareInput,
  ): Promise<LyricsLibraryQuarantineCompareResult> {
    try {
      const raw = await this.rpc('compare_quarantined_lyrics', {
        p_library_id: this.options.libraryId,
        p_exact_key: input.exactKey,
        p_work_key: input.workKey,
        p_key_version: input.keyVersion,
        p_observed_before: input.observedBefore,
        p_expected_exact: input.expectedExact
          ? payloadContent(input.expectedExact)
          : null,
        p_expected_work: input.expectedWork
          ? staticPayloadContent(input.expectedWork)
          : null,
      });
      const result = quarantineComparisonResponseSchema.parse(raw);
      return {
        state: 'ok',
        exact: comparisonKindResult(result.exact),
        work: comparisonKindResult(result.work),
      };
    } catch (error) {
      return { state: 'unavailable', reason: unavailableReason(error) };
    }
  }

  async upsertExact(input: LyricsLibraryExactWrite): Promise<void> {
    if (input.cached.payload.fallbackKind !== undefined) return;
    const content = payloadContent(input.cached.payload);
    if (!content) return;
    if (
      input.sourceKind === 'automatic'
      && content.is_instrumental === true
      && !isExplicitInstrumentalTitle(input.track.title)
    ) return;
    if (
      input.sourceKind !== 'automatic' &&
      (!Number.isSafeInteger(input.selectionVersion) || input.selectionVersion <= 0)
    ) {
      throw new Error('Manual and candidate lyrics writes require a positive selectionVersion');
    }
    await this.rpc('upsert_lyrics_document', {
      p_library_id: this.options.libraryId,
      p_exact_key: input.exactKey,
      // Exact writes are deliberately unable to create a work binding. Only
      // a verified original recording may do that through upsertWork().
      p_work_key: null,
      p_key_version: input.keyVersion,
      p_raw_metadata: {
        title: input.track.title,
        artist: input.track.artist,
        album: input.track.album,
        duration_ms: input.track.durationMs,
        source: input.track.source,
      },
      p_payload: {
        ...content,
        duration_ms: Math.max(0, Math.round(input.track.durationMs)),
      },
      p_provenance: {
        provider_name: input.cached.payload.provider,
        provider_track_id:
          input.cached.payload.providerTrackId ?? input.cached.payload.providerId,
        lookup_strategy: input.cached.lookupStrategy,
        metadata_signature: input.cached.metadataSignature,
        body_format: 'display-reconstructed-v1',
        ...(input.sourceKind !== 'automatic'
          ? { selection_version: input.selectionVersion }
          : {}),
        ...(input.sourceKind === 'candidate'
          ? {
              // A user-confirmed candidate is a distinct trusted source. Do
              // not let a later quarantined provider refresh with the same
              // provider id replace the candidate document's current revision.
              idempotency_key: `candidate:v${input.keyVersion}:${input.exactKey}:${input.cached.payload.providerTrackId ?? input.cached.payload.providerId ?? 'unknown'}`,
            }
          : {}),
      },
      p_acquisition: input.sourceKind === 'automatic' ? 'provider' : input.sourceKind,
      p_requested_status: input.trust,
    }, { timeoutMs: this.options.writeTimeoutMs ?? this.options.timeoutMs });
  }

  async upsertWork(input: LyricsLibraryWorkWrite): Promise<void> {
    await this.rpc('upsert_lyrics_document', {
      p_library_id: this.options.libraryId,
      p_exact_key: null,
      p_work_key: input.workKey,
      p_key_version: input.keyVersion,
      p_raw_metadata: {
        title: input.cached.sourceTitle,
        artist: input.cached.sourceArtist,
        duration_ms: 0,
      },
      p_payload: {
        plain_lyrics: input.cached.plainText,
        is_instrumental: false,
        duration_ms: 0,
      },
      p_provenance: {
        provider_name: input.cached.provider,
        provider_track_id: input.cached.providerId,
        source_kind: 'work-cache',
        // A work fallback intentionally stores static text. Keep it in a
        // separate document so it cannot replace the synced revision used by
        // an exact binding with the same provider id.
        idempotency_key: `work:v${input.keyVersion}:${input.workKey}:${input.cached.providerId ?? 'unknown'}`,
      },
      p_acquisition: 'provider',
      p_requested_status: 'quarantine',
    }, { timeoutMs: this.options.writeTimeoutMs ?? this.options.timeoutMs });
  }

  async enqueueAppleLyricsBackfill(
    input: AppleLyricsBackfillEnqueueInput,
    options: SupabaseLyricsRequestOptions = {},
  ): Promise<{ status: z.infer<typeof appleBackfillEnqueueResponseSchema>['status'] }> {
    const result = appleBackfillEnqueueResponseSchema.parse(await this.rpc(
      'enqueue_apple_lyrics_backfill',
      {
        p_library_id: this.options.libraryId,
        p_exact_key: input.exactKey,
        p_key_version: input.keyVersion,
        p_storefront: input.storefront.toLowerCase(),
        p_locale: input.locale,
        p_track_metadata: {
          title: input.track.title,
          artist: input.track.artist,
          album: input.track.album,
          duration_ms: Math.max(0, Math.round(input.track.durationMs)),
          source: input.track.source,
        },
        p_provider_track_id: input.providerTrackId ?? null,
        p_isrc: input.isrc ?? null,
        p_priority: input.priority ?? 0,
        p_max_attempts: input.maxAttempts ?? 5,
      },
      {
        timeoutMs: this.options.writeTimeoutMs ?? this.options.timeoutMs,
        ...options,
      },
    ));
    return { status: result.status };
  }

  async claimAppleLyricsBackfill(input: {
    workerId: string;
    limit: number;
    leaseSeconds: number;
  }, options: SupabaseLyricsRequestOptions = {}): Promise<ClaimedAppleLyricsBackfillJob[]> {
    const claimed = appleBackfillClaimResponseSchema.parse(await this.rpc(
      'claim_apple_lyrics_backfill',
      {
        p_library_id: this.options.libraryId,
        p_worker_id: input.workerId,
        p_limit: input.limit,
        p_lease_seconds: input.leaseSeconds,
      },
      {
        timeoutMs: this.options.backfillTimeoutMs
          ?? this.options.writeTimeoutMs
          ?? this.options.timeoutMs,
        ...options,
      },
    ));
    return claimed.map((job) => ({
      jobId: job.job_id,
      leaseToken: job.lease_token,
      // The database increments attempt_count while claiming. The worker
      // contract counts only attempts completed before the current lease.
      attempts: Math.max(0, job.attempt_count - 1),
      maxAttempts: job.max_attempts,
      exactKey: job.exact_key,
      keyVersion: job.key_version,
      storefront: job.storefront,
      locale: job.locale,
      ...(job.provider_track_id ? { providerTrackId: job.provider_track_id } : {}),
      ...(job.isrc ? { isrc: job.isrc } : {}),
      track: {
        title: job.track_metadata.title,
        artist: job.track_metadata.artist,
        album: job.track_metadata.album,
        durationMs: job.track_metadata.duration_ms,
        source: job.track_metadata.source,
      },
    }));
  }

  async failAppleLyricsBackfill(input: {
    jobId: string;
    leaseToken: string;
    errorCode: string;
    retryable: boolean;
    retryAfterSeconds: number;
  }, options: SupabaseLyricsRequestOptions = {}): Promise<void> {
    await this.rpc(
      'fail_apple_lyrics_backfill',
      {
        p_job_id: input.jobId,
        p_lease_token: input.leaseToken,
        p_error_code: input.errorCode,
        p_retryable: input.retryable,
        p_retry_after_seconds: input.retryAfterSeconds,
      },
      {
        timeoutMs: this.options.backfillTimeoutMs
          ?? this.options.writeTimeoutMs
          ?? this.options.timeoutMs,
        ...options,
      },
    );
  }

  async completeAppleLyricsBackfill(
    input: CompleteAppleLyricsBackfillInput,
    options: SupabaseLyricsRequestOptions = {},
  ): Promise<void> {
    const result = appleBackfillCompleteResponseSchema.parse(await this.rpc(
      'complete_apple_lyrics_backfill_v3',
      {
        p_job_id: input.jobId,
        p_lease_token: input.leaseToken,
        p_provider_track_id: input.providerTrackId,
        p_storefront: input.storefront,
        p_raw_metadata: input.rawMetadata,
        p_payload: input.payload,
        p_provenance: input.provenance,
        p_raw_ttml: input.rawTtml,
        p_locale: input.locale,
        p_timing_mode: input.timingMode,
        p_recording_variant: input.recordingVariant,
      },
      {
        timeoutMs: this.options.backfillTimeoutMs
          ?? this.options.writeTimeoutMs
          ?? this.options.timeoutMs,
        ...options,
      },
    ));
    if (
      result.job_id !== input.jobId
      || result.storefront !== input.storefront
      || result.artifact_bytes !== Buffer.byteLength(input.rawTtml, 'utf8')
      || result.artifact_content_hash !== createHash('sha256')
        .update(input.rawTtml, 'utf8')
        .digest('hex')
    ) {
      throw new SupabaseRequestError('invalid-response');
    }
  }

  async enqueueAppleLyricsReprojection(
    limit = 1_000,
    options: SupabaseLyricsRequestOptions = {},
  ): Promise<{ enqueued: number; remaining: number }> {
    const result = appleReprojectionEnqueueResponseSchema.parse(await this.rpc(
      'enqueue_apple_lyrics_reprojection_v2',
      {
        p_library_id: this.options.libraryId,
        p_limit: limit,
      },
      {
        timeoutMs: this.options.backfillTimeoutMs
          ?? this.options.writeTimeoutMs
          ?? this.options.timeoutMs,
        ...options,
      },
    ));
    return {
      enqueued: result.enqueued,
      remaining: result.remaining,
    };
  }

  async claimAppleLyricsReprojection(input: {
    workerId: string;
    limit: number;
    leaseSeconds: number;
  }, options: SupabaseLyricsRequestOptions = {}): Promise<ClaimedAppleLyricsReprojectionJob[]> {
    const claimed = appleReprojectionClaimResponseSchema.parse(await this.rpc(
      'claim_apple_lyrics_reprojection_v2',
      {
        p_library_id: this.options.libraryId,
        p_worker_id: input.workerId,
        p_limit: input.limit,
        p_lease_seconds: input.leaseSeconds,
      },
      {
        timeoutMs: this.options.backfillTimeoutMs
          ?? this.options.writeTimeoutMs
          ?? this.options.timeoutMs,
        maxResponseBytes: MAX_REPROJECTION_CLAIM_RESPONSE_BYTES,
        ...options,
      },
    ));
    return claimed.map((job) => ({
      jobId: job.job_id,
      leaseToken: job.lease_token,
      leaseExpiresAt: job.lease_expires_at,
      attemptCount: job.attempt_count,
      maxAttempts: job.max_attempts,
      targetProjectionVersion: job.target_projection_version,
      sourceArtifact: {
        id: job.source_artifact.id,
        revisionId: job.source_artifact.revision_id,
        providerName: job.source_artifact.provider_name,
        providerTrackId: job.source_artifact.provider_track_id,
        storefront: job.source_artifact.storefront,
        exactKey: job.source_artifact.exact_key,
        keyVersion: job.source_artifact.key_version,
        locale: job.source_artifact.locale,
        timingMode: job.source_artifact.timing_mode,
        recordingVariant: job.source_artifact.recording_variant,
        projectionVersion: job.source_artifact.projection_version,
        rawTtml: job.source_artifact.raw_ttml,
        contentHash: job.source_artifact.content_hash,
        byteSize: job.source_artifact.byte_size,
        fetchedAt: job.source_artifact.fetched_at,
      },
      track: {
        title: job.track_metadata.title,
        artist: job.track_metadata.artist,
        album: job.track_metadata.album,
        durationMs: job.track_metadata.duration_ms,
        source: job.track_metadata.source,
      },
      identityProof: {
        proofVersion: job.identity_proof.proof_version,
        evidence: job.identity_proof.evidence,
        providerName: job.identity_proof.provider_name,
        providerTrackId: job.identity_proof.provider_track_id,
        exactKey: job.identity_proof.exact_key,
        keyVersion: job.identity_proof.key_version,
      },
    }));
  }

  async failAppleLyricsReprojection(input: {
    jobId: string;
    leaseToken: string;
    errorCode: string;
    retryable: boolean;
    retryAfterSeconds: number;
  }, options: SupabaseLyricsRequestOptions = {}): Promise<void> {
    await this.rpc(
      'fail_apple_lyrics_reprojection_v2',
      {
        p_job_id: input.jobId,
        p_lease_token: input.leaseToken,
        p_error_code: input.errorCode,
        p_retryable: input.retryable,
        p_retry_after_seconds: input.retryAfterSeconds,
      },
      {
        timeoutMs: this.options.backfillTimeoutMs
          ?? this.options.writeTimeoutMs
          ?? this.options.timeoutMs,
        ...options,
      },
    );
  }

  async completeAppleLyricsReprojection(
    input: CompleteAppleLyricsReprojectionInput,
    options: SupabaseLyricsRequestOptions = {},
  ): Promise<void> {
    const result = appleReprojectionCompleteResponseSchema.parse(await this.rpc(
      'complete_apple_lyrics_reprojection_v2',
      {
        p_job_id: input.jobId,
        p_lease_token: input.leaseToken,
        p_payload: input.payload,
        p_provenance: input.provenance,
        p_timing_mode: input.timingMode,
      },
      {
        timeoutMs: this.options.backfillTimeoutMs
          ?? this.options.writeTimeoutMs
          ?? this.options.timeoutMs,
        ...options,
      },
    ));
    if (
      result.job_id !== input.jobId
      || result.source_artifact_id !== input.sourceArtifactId
      || result.artifact_content_hash !== input.sourceArtifactHash
      || result.artifact_bytes !== input.sourceArtifactBytes
    ) {
      throw new SupabaseRequestError('invalid-response');
    }
  }

  async enqueueAppleLyricsTimelineRepair(
    limit = 1_000,
    options: SupabaseLyricsRequestOptions = {},
  ): Promise<{ enqueued: number; remaining: number }> {
    const result = appleTimelineRepairEnqueueResponseSchema.parse(await this.rpc(
      'enqueue_apple_lyrics_timeline_repair_v3',
      {
        p_library_id: this.options.libraryId,
        p_limit: limit,
      },
      {
        timeoutMs: this.options.backfillTimeoutMs
          ?? this.options.writeTimeoutMs
          ?? this.options.timeoutMs,
        ...options,
      },
    ));
    return {
      enqueued: result.enqueued,
      remaining: result.remaining,
    };
  }

  async claimAppleLyricsTimelineRepair(input: {
    workerId: string;
    limit: number;
    leaseSeconds: number;
  }, options: SupabaseLyricsRequestOptions = {}): Promise<ClaimedAppleLyricsTimelineRepairJob[]> {
    const claimed = appleTimelineRepairClaimResponseSchema.parse(await this.rpc(
      'claim_apple_lyrics_timeline_repair_v3',
      {
        p_library_id: this.options.libraryId,
        p_worker_id: input.workerId,
        p_limit: input.limit,
        p_lease_seconds: input.leaseSeconds,
      },
      {
        timeoutMs: this.options.backfillTimeoutMs
          ?? this.options.writeTimeoutMs
          ?? this.options.timeoutMs,
        maxResponseBytes: MAX_REPROJECTION_CLAIM_RESPONSE_BYTES,
        ...options,
      },
    ));
    return claimed.map((job) => ({
      jobId: job.job_id,
      leaseToken: job.lease_token,
      leaseExpiresAt: job.lease_expires_at,
      attemptCount: job.attempt_count,
      maxAttempts: job.max_attempts,
      targetProjectionVersion: job.target_projection_version,
      sourceAnomalyCode: job.source_anomaly_code,
      sourceArtifact: {
        id: job.source_artifact.id,
        revisionId: job.source_artifact.revision_id,
        providerName: job.source_artifact.provider_name,
        providerTrackId: job.source_artifact.provider_track_id,
        storefront: job.source_artifact.storefront,
        exactKey: job.source_artifact.exact_key,
        keyVersion: job.source_artifact.key_version,
        locale: job.source_artifact.locale,
        timingMode: job.source_artifact.timing_mode,
        recordingVariant: job.source_artifact.recording_variant,
        projectionVersion: job.source_artifact.projection_version,
        rawTtml: job.source_artifact.raw_ttml,
        contentHash: job.source_artifact.content_hash,
        byteSize: job.source_artifact.byte_size,
        fetchedAt: job.source_artifact.fetched_at,
      },
      track: {
        title: job.track_metadata.title,
        artist: job.track_metadata.artist,
        album: job.track_metadata.album,
        durationMs: job.track_metadata.duration_ms,
        source: job.track_metadata.source,
      },
      identityProof: {
        proofVersion: job.identity_proof.proof_version,
        evidence: job.identity_proof.evidence,
        providerName: job.identity_proof.provider_name,
        providerTrackId: job.identity_proof.provider_track_id,
        exactKey: job.identity_proof.exact_key,
        keyVersion: job.identity_proof.key_version,
      },
    }));
  }

  async failAppleLyricsTimelineRepair(input: {
    jobId: string;
    leaseToken: string;
    errorCode: string;
    retryable: boolean;
    retryAfterSeconds: number;
  }, options: SupabaseLyricsRequestOptions = {}): Promise<void> {
    await this.rpc(
      'fail_apple_lyrics_timeline_repair_v3',
      {
        p_job_id: input.jobId,
        p_lease_token: input.leaseToken,
        p_error_code: input.errorCode,
        p_retryable: input.retryable,
        p_retry_after_seconds: input.retryAfterSeconds,
      },
      {
        timeoutMs: this.options.backfillTimeoutMs
          ?? this.options.writeTimeoutMs
          ?? this.options.timeoutMs,
        ...options,
      },
    );
  }

  async completeAppleLyricsTimelineRepair(
    input: CompleteAppleLyricsTimelineRepairInput,
    options: SupabaseLyricsRequestOptions = {},
  ): Promise<void> {
    const result = appleTimelineRepairCompleteResponseSchema.parse(await this.rpc(
      'complete_apple_lyrics_timeline_repair_v3',
      {
        p_job_id: input.jobId,
        p_lease_token: input.leaseToken,
        p_payload: input.payload,
        p_provenance: input.provenance,
        p_timing_mode: input.timingMode,
      },
      {
        timeoutMs: this.options.backfillTimeoutMs
          ?? this.options.writeTimeoutMs
          ?? this.options.timeoutMs,
        ...options,
      },
    ));
    if (
      result.job_id !== input.jobId
      || result.source_artifact_id !== input.sourceArtifactId
      || result.artifact_content_hash !== input.sourceArtifactHash
      || result.artifact_bytes !== input.sourceArtifactBytes
    ) {
      throw new SupabaseRequestError('invalid-response');
    }
  }

  private async rpc(
    name: string,
    body: Record<string, unknown>,
    options: SupabaseRpcOptions = {},
  ): Promise<unknown> {
    const url = new URL(`/rest/v1/rpc/${name}`, this.baseUrl);
    const timeoutSignal = AbortSignal.timeout(
      options.timeoutMs ?? this.options.timeoutMs,
    );
    const requestSignal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    const maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
    let response: Response;
    try {
      options.signal?.throwIfAborted();
      response = await this.fetcher(url, {
        method: 'POST',
        // Never forward the service key to a redirected origin.
        redirect: 'error',
        headers: {
          apikey: this.options.secretKey,
          // Local Supabase and older hosted projects still expose the legacy
          // JWT service-role key. PostgREST derives its role from Authorization
          // for those keys. New sb_secret_* keys are opaque and authenticate
          // through apikey only.
          ...(isLegacyJwtKey(this.options.secretKey)
            ? { Authorization: `Bearer ${this.options.secretKey}` }
            : {}),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: requestSignal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw abortReason(options.signal);
      if (timeoutSignal.aborted || isTimeout(error)) {
        throw new SupabaseRequestError('timeout');
      }
      throw new SupabaseRequestError('network');
    }
    if (options.signal?.aborted) {
      cancelBody(response, abortReason(options.signal));
      throw abortReason(options.signal);
    }
    if (timeoutSignal.aborted) {
      cancelBody(response, timeoutSignal.reason);
      throw new SupabaseRequestError('timeout');
    }
    if (!response.ok) {
      cancelBody(response, new Error('Supabase RPC response rejected'));
      if (response.status === 401 || response.status === 403) {
        throw new SupabaseRequestError('auth');
      }
      if (response.status === 408) throw new SupabaseRequestError('timeout');
      if (response.status === 429 || response.status >= 500) {
        throw new SupabaseRequestError('server');
      }
      throw new SupabaseRequestError('invalid-response');
    }
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
      cancelBody(response, new Error('Supabase RPC response exceeded its byte limit'));
      throw new SupabaseRequestError('invalid-response');
    }
    let text: string;
    try {
      text = await readLimitedText(response, maxResponseBytes, requestSignal);
    } catch (error) {
      if (options.signal?.aborted) throw abortReason(options.signal);
      if (timeoutSignal.aborted) throw new SupabaseRequestError('timeout');
      if (error instanceof SupabaseRequestError) throw error;
      if (isTimeout(error)) throw new SupabaseRequestError('timeout');
      throw new SupabaseRequestError('network');
    }
    if (options.signal?.aborted) throw abortReason(options.signal);
    if (timeoutSignal.aborted) throw new SupabaseRequestError('timeout');
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new SupabaseRequestError('invalid-response');
    }
  }
}

function isLegacyJwtKey(value: string): boolean {
  const segments = value.split('.');
  return segments.length === 3 && segments.every(Boolean);
}

async function readLimitedText(
  response: Response,
  limit: number,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) {
    cancelBody(response, abortReason(signal));
    throw abortReason(signal);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let onAbort: (() => void) | undefined;
  const aborted = signal
    ? new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          reject(abortReason(signal));
          cancelReader(reader, abortReason(signal));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      })
    : undefined;
  try {
    while (true) {
      signal?.throwIfAborted();
      const pendingRead = reader.read();
      // If abort wins the race, keep a rejection handler on the underlying read
      // even when a non-standard stream ignores reader.cancel().
      void pendingRead.catch(() => undefined);
      const { done, value } = aborted
        ? await Promise.race([pendingRead, aborted])
        : await pendingRead;
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        cancelReader(reader, new Error('Supabase RPC response exceeded its byte limit'));
        throw new SupabaseRequestError('invalid-response');
      }
      chunks.push(value);
    }
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
  signal?.throwIfAborted();
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: unknown,
): void {
  // Cancellation is advisory. Never let a broken/custom stream's cancel
  // promise become the operation that outlives the worker cleanup grace.
  void reader.cancel(reason).catch(() => undefined);
}

function cancelBody(response: Response, reason: unknown): void {
  if (!response.body || response.body.locked) return;
  void response.body.cancel(reason).catch(() => undefined);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Operation aborted', 'AbortError');
}

type ResolveHit = z.infer<typeof resolveHitSchema>;
type ResolveResponse = z.infer<typeof resolveResponseSchema>;

function verifiedAppleExactAliasKeys(input: LyricsLibraryResolveInput): string[] {
  const durationMs = input.track.durationMs;
  if (lyricsLookupFingerprint(input.track) !== input.exactKey) return [];

  const keys = new Set<string>();
  if (
    Number.isSafeInteger(durationMs)
    && durationMs > 0
    && durationMs % 1_000 === 0
  ) {
    const bucketCenterMs = Math.round(durationMs / 2_000) * 2_000;
    const candidates = [bucketCenterMs - 2_000, bucketCenterMs + 2_000];
    for (const candidateMs of candidates) {
      if (candidateMs < 0) continue;
      const boundaryMs = (bucketCenterMs + candidateMs) / 2;
      if (Math.abs(durationMs - boundaryMs) > 500) continue;
      for (const variant of trackScriptVariants({
        ...input.track,
        durationMs: candidateMs,
      })) {
        const key = lyricsLookupFingerprint(variant);
        if (key !== input.exactKey) keys.add(key);
      }
    }
  }

  for (const variant of trackScriptVariants(input.track)) {
    const key = lyricsLookupFingerprint(variant);
    if (key !== input.exactKey) keys.add(key);
  }
  return [...keys];
}

function isUnverifiedProviderInstrumental(
  input: LyricsLibraryResolveInput,
  result: ResolveResponse,
): boolean {
  return result.result_status === 'hit'
    && result.match_kind === 'exact'
    && result.is_instrumental
    && result.selection_method === 'provider'
    && result.provider_name?.trim().toLowerCase() === 'lrclib'
    && !isExplicitInstrumentalTitle(input.track.title);
}

function shouldProbeSynchronizedAppleDurationAlias(result: ResolveResponse): boolean {
  return result.result_status === 'hit'
    && result.match_kind === 'exact'
    && result.provider_name?.trim().toLowerCase() === 'lrclib'
    && result.selection_method === 'provider'
    && !result.is_instrumental
    && !result.auto_scroll
    && resultPayload(result)?.kind === 'plain';
}

function resolvedLyricsResult(
  input: LyricsLibraryResolveInput,
  result: ResolveResponse,
  queriedExactKey: string,
  durationAlias: boolean,
): LyricsLibraryResolveResult {
  if (result.result_status === 'miss') return { state: 'miss' };
  if (result.result_status === 'ambiguous') {
    return {
      state: 'ambiguous',
      candidateCount: result.candidate_count ?? result.candidates?.length ?? 0,
    };
  }
  if (!result.match_kind || !result.document_id) {
    return { state: 'unavailable', reason: 'invalid-response' };
  }
  if (!hitMetadataMatches(input, result, queriedExactKey, durationAlias)) {
    return { state: 'unavailable', reason: 'invalid-response' };
  }
  // Apple remains the preferred source when its validated route wins. Script
  // projection happens after resolution so LRCLIB stays a true source fallback
  // instead of replacing higher-quality Apple timing merely for orthography.
  const selected = result;
  const rawPayload = resultPayload(selected);
  const payload = rawPayload ? projectAppleLyricsToSimplified(rawPayload) : null;
  if (!payload) return { state: 'unavailable', reason: 'invalid-response' };
  return {
    state: 'hit',
    matchKind: selected.match_kind!,
    payload,
    documentId: selected.document_id!,
    ...(selected.selection_method
      ? { selectionMethod: selected.selection_method }
      : {}),
    ...(selected.provider_route
      ? { providerRoute: selected.provider_route }
      : {}),
  };
}

function hitMetadataMatches(
  input: LyricsLibraryResolveInput,
  result: ResolveHit,
  queriedExactKey = input.exactKey,
  durationAlias = false,
): boolean {
  if (!result.match_kind) return false;
  if (result.match_kind === 'work' && !input.allowWorkFallback) return false;
  const parsed = rawMetadataSchema.safeParse(result.raw_metadata);
  if (!parsed.success) return false;
  const track = {
    title: parsed.data.title,
    artist: parsed.data.artist,
    album: parsed.data.album,
    durationMs: parsed.data.duration_ms,
    source: parsed.data.source,
  };
  if (result.match_kind === 'work') {
    if (result.provider_route === 'apple-duration-alias-synced-v1') {
      const requestedFamily = v1ExactDurationFamily(input.exactKey);
      const sourceExactKey = lyricsLookupFingerprint(track);
      return !durationAlias
        && input.keyVersion === 1
        && result.provider_name?.trim().toLowerCase() === 'apple'
        && result.selection_method === 'provider'
        && !result.is_instrumental
        && result.auto_scroll
        && result.synced_lyrics != null
        && requestedFamily !== null
        && requestedFamily === v1ExactDurationFamily(sourceExactKey)
        && lyricsLookupFingerprint(input.track) === input.exactKey
        && lyricsWorkFingerprint(track) === input.workKey;
    }
    if (result.provider_route === 'apple-duration-alias-static-v1') {
      const requestedFamily = v1ExactDurationFamily(input.exactKey);
      const sourceExactKey = lyricsLookupFingerprint(track);
      return !durationAlias
        && input.keyVersion === 1
        && result.provider_name?.trim().toLowerCase() === 'apple'
        && result.selection_method === 'provider'
        && !result.is_instrumental
        && !result.auto_scroll
        && result.synced_lyrics == null
        && requestedFamily !== null
        && requestedFamily === v1ExactDurationFamily(sourceExactKey)
        && lyricsLookupFingerprint(input.track) === input.exactKey
        && lyricsWorkFingerprint(track) === input.workKey;
    }
    return !durationAlias && lyricsWorkFingerprint(track) === input.workKey;
  }
  if (!durationAlias) return lyricsLookupFingerprint(track) === queriedExactKey;

  return result.provider_name?.trim().toLowerCase() === 'apple'
    && result.provider_route === 'apple-primary-v1'
    && result.selection_method === 'provider'
    && !result.is_instrumental
    && Math.abs(track.durationMs - input.track.durationMs) <= 500
    && scriptEquivalentTrackMetadata(input.track, track)
    && trackScriptVariants(track).some((variant) =>
      lyricsLookupFingerprint(variant) === queriedExactKey);
}

function v1ExactDurationFamily(exactKey: string): string | null {
  const value = exactKey.trim();
  if (!value || value.length > 512) return null;
  const parts = value.split('::');
  if (
    parts.length === 4
    && parts[0]
    && parts[1]
    && /^\d{1,10}$/.test(parts[2]!)
  ) {
    return `${parts[0]}::${parts[1]}::${parts[3]}`;
  }
  if (
    parts.length === 5
    && parts[0]
    && parts[1]
    && /^\d{1,10}$/.test(parts[2]!)
    && /^v=[a-z0-9][a-z0-9 ,_-]{0,127}$/.test(parts[3]!)
  ) {
    return `${parts[0]}::${parts[1]}::${parts[3]}::${parts[4]}`;
  }
  return null;
}

function resultPayload(result: ResolveHit): LyricsPayload | null {
  const provider = normalizedProvider(result.provider_name);
  const rawProviderId = result.provider_track_id;
  const numericProviderId = rawProviderId === null || rawProviderId === undefined || rawProviderId === ''
    ? Number.NaN
    : Number(rawProviderId);
  const providerId = provider === 'lrclib'
    && Number.isSafeInteger(numericProviderId)
    && numericProviderId >= 0
    ? numericProviderId
    : undefined;
  const providerTrackId =
    provider !== 'apple'
      || rawProviderId === null
      || rawProviderId === undefined
      || String(rawProviderId).trim() === ''
      ? undefined
      : String(rawProviderId);
  if (result.is_instrumental) {
    return {
      kind: 'plain',
      lines: [],
      plainText: '这是一首纯音乐',
      provider,
      ...(providerId === undefined ? {} : { providerId }),
      ...(providerTrackId === undefined ? {} : { providerTrackId }),
      notice: '个人歌词库将这首曲目标记为纯音乐。',
    };
  }
  const isSyncedDurationAlias = result.provider_route === 'apple-duration-alias-synced-v1';
  if (
    result.synced_lyrics
    && result.auto_scroll
    && (result.match_kind !== 'work' || isSyncedDurationAlias)
  ) {
    const lines = parseLrc(result.synced_lyrics).lines;
    if (lines.length > 0) {
      return {
        kind: 'synced',
        lines,
        provider,
        ...(providerId === undefined ? {} : { providerId }),
        ...(providerTrackId === undefined ? {} : { providerTrackId }),
      };
    }
  }
  const plainText = result.plain_lyrics?.trim() || syncedAsPlain(result.synced_lyrics);
  if (!plainText) return null;
  return {
    kind: 'plain',
    lines: plainLyricsToLines(plainText),
    plainText,
    provider,
    ...(providerId === undefined ? {} : { providerId }),
    ...(providerTrackId === undefined ? {} : { providerTrackId }),
    ...(result.match_kind === 'work'
      ? { notice: WORK_FALLBACK_NOTICE, fallbackKind: 'work-cache' as const }
      : { notice: '正在使用个人歌词库中的静态歌词。' }),
  };
}

function normalizedProvider(value: string | null | undefined): LyricsPayload['provider'] {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'lrclib') return 'lrclib';
  if (normalized === 'apple') return 'apple';
  if (normalized === 'manual') return 'manual';
  return null;
}

function syncedAsPlain(value: string | null | undefined): string {
  if (!value) return '';
  return parseLrc(value).lines.map((line) => line.text).filter(Boolean).join('\n');
}

function payloadContent(payload: LyricsPayload): Record<string, unknown> | null {
  if (payload.kind !== 'synced' && payload.kind !== 'plain') return null;
  if (payload.lines.length === 0 && payload.plainText === '这是一首纯音乐') {
    return { is_instrumental: true };
  }
  const plainLyrics = payload.plainText?.trim()
    || payload.lines.map((line) => line.text).filter(Boolean).join('\n');
  const syncedLyrics = payload.kind === 'synced' ? serializeDisplayLrc(payload) : undefined;
  if (!plainLyrics && !syncedLyrics) return null;
  return {
    ...(syncedLyrics ? { synced_lyrics: syncedLyrics } : {}),
    ...(plainLyrics ? { plain_lyrics: plainLyrics } : {}),
    is_instrumental: false,
  };
}

function staticPayloadContent(payload: LyricsPayload): Record<string, unknown> | null {
  if (payload.kind !== 'synced' && payload.kind !== 'plain') return null;
  if (payload.lines.length === 0 && payload.plainText === '这是一首纯音乐') {
    return { is_instrumental: true };
  }
  // Work bindings are written from the normalized display lines. Compare the
  // same static representation so CRLF, blank lines, and surrounding spaces
  // in a provider's raw plain text do not create false disagreements.
  const plainLyrics = payload.lines.map((line) => line.text).filter(Boolean).join('\n')
    || payload.plainText?.trim();
  if (!plainLyrics) return null;
  return {
    plain_lyrics: plainLyrics,
    is_instrumental: false,
  };
}

function comparisonKindResult(
  value: z.infer<typeof quarantineComparisonKindSchema>,
): Extract<LyricsLibraryQuarantineCompareResult, { state: 'ok' }>['exact'] {
  return {
    candidateCount: value.candidate_count,
    comparisons: value.comparisons,
    agreements: value.agreements,
    disagreements: value.disagreements,
  };
}

function serializeDisplayLrc(payload: LyricsPayload): string {
  return payload.lines.map((line) => {
    const totalCentiseconds = Math.max(0, Math.round(line.startMs / 10));
    const minutes = Math.floor(totalCentiseconds / 6_000);
    const seconds = Math.floor((totalCentiseconds % 6_000) / 100);
    const centiseconds = totalCentiseconds % 100;
    return `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}]${line.text}`;
  }).join('\n');
}

export function serializeDisplayLrcMilliseconds(payload: LyricsPayload): string {
  return payload.lines.map((line) => {
    const totalMilliseconds = Math.max(0, Math.round(line.startMs));
    const minutes = Math.floor(totalMilliseconds / 60_000);
    const seconds = Math.floor((totalMilliseconds % 60_000) / 1_000);
    const milliseconds = totalMilliseconds % 1_000;
    return `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}]${line.text}`;
  }).join('\n');
}

class SupabaseRequestError extends Error {
  constructor(readonly reason: Exclude<LyricsLibraryResolveResult, { state: 'hit' | 'miss' | 'ambiguous' }>['reason']) {
    super(`Supabase lyrics request failed: ${reason}`);
    this.name = 'SupabaseRequestError';
  }
}

function unavailableReason(error: unknown): Extract<LyricsLibraryResolveResult, { state: 'unavailable' }>['reason'] {
  return error instanceof SupabaseRequestError ? error.reason : 'invalid-response';
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (
    error.name === 'AbortError' ||
    error.name === 'TimeoutError' ||
    /timeout/i.test(error.message)
  );
}
