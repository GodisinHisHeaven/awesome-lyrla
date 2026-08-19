import {
  AppleLyricsBackfillError,
  type AppleLyricsBackfillFailure,
  type AppleLyricsBackfillJob,
  type AppleLyricsBackfillQueue,
  type AppleLyricsOperationOptions,
  type AppleLyricsBackfillSink,
  type AppleLyricsBackfillSinkInput,
  type AppleTtmlParser,
} from './apple-lyrics-backfill.js';
import {
  convertAppleTtmlToLyrics,
  convertAppleTtmlToLyricsV3,
  type AppleTtmlConversionResult,
} from './apple-lyrics-ttml.js';
import { metadataVersionSignature } from '../shared/track.js';
import {
  serializeDisplayLrcMilliseconds,
  SupabaseLyricsClient,
} from './supabase-lyrics-client.js';
import { productionObservability } from './production-observability.js';

const SAFE_LOCALE = /^[A-Za-z0-9][A-Za-z0-9-]{0,34}$/;

export const APPLE_TTML_SYNCED_BODY_FORMAT =
  'apple-ttml-line-projection-v2-ms';
export const APPLE_TTML_STATIC_BODY_FORMAT =
  'apple-ttml-static-projection-v2';
export const APPLE_TTML_V3_SYNCED_BODY_FORMAT =
  'apple-ttml-line-projection-v3-ms';
export const APPLE_TTML_V3_STATIC_BODY_FORMAT =
  'apple-ttml-static-projection-v3';

export class AppleTtmlProjectionParser
implements AppleTtmlParser<AppleTtmlConversionResult> {
  async parse(input: {
    ttml: string;
    signal?: AbortSignal;
  }): Promise<AppleTtmlConversionResult> {
    // Let already-ready HTTP work run before the bounded synchronous XML
    // projection. The source document is capped at 512 KiB by both worker and
    // database, so this never becomes an unbounded request-path pause.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (input.signal?.aborted) {
      throw new AppleLyricsBackfillError('apple-request-aborted', { retryable: true });
    }
    const parsed = convertAppleTtmlToLyrics(input.ttml);
    if (parsed.kind === 'invalid') {
      throw new AppleLyricsBackfillError('ttml-invalid', { retryable: false });
    }
    if (parsed.kind === 'missing') {
      throw new AppleLyricsBackfillError('ttml-no-lyrics', { retryable: false });
    }
    if (parsed.timelineValidation) {
      productionObservability.observeAppleTimeline(
        parsed.timelineValidation.outcome,
        parsed.timelineValidation.sourceAnomaly,
        0,
      );
    }
    return parsed;
  }
}

export class AppleTtmlProjectionParserV3
implements AppleTtmlParser<AppleTtmlConversionResult> {
  async parse(input: {
    ttml: string;
    durationMs?: number;
    track?: { durationMs: number };
    fetched?: { catalogTrack: { durationMs: number } };
    signal?: AbortSignal;
  }): Promise<AppleTtmlConversionResult> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (input.signal?.aborted) {
      throw new AppleLyricsBackfillError('apple-request-aborted', { retryable: true });
    }
    // Validate the TTML against Apple's catalog duration when available. The
    // duration in the playback event is a lookup-key input and can drift by
    // seconds or more; using it as a timeline boundary rejects healthy lyrics
    // before the player ever gets a chance to auto-scroll them. Explicit
    // durationMs remains an escape hatch for retained-artifact repair jobs.
    const durationMs = input.durationMs
      ?? input.fetched?.catalogTrack.durationMs
      ?? input.track?.durationMs
      ?? Number.NaN;
    const parsed = convertAppleTtmlToLyricsV3(input.ttml, { durationMs });
    if (parsed.kind === 'invalid') {
      throw new AppleLyricsBackfillError('ttml-invalid', { retryable: false });
    }
    if (parsed.kind === 'missing') {
      throw new AppleLyricsBackfillError('ttml-no-lyrics', { retryable: false });
    }
    if (parsed.timelineValidation) {
      productionObservability.observeAppleTimeline(
        parsed.timelineValidation.outcome,
        parsed.timelineValidation.sourceAnomaly,
        Number.isFinite(durationMs)
          ? Math.max(
              0,
              Math.max(...parsed.lines.map((line) => line.startMs), 0) - durationMs,
            )
          : 0,
      );
    }
    return parsed;
  }
}

/**
 * Maps the generic worker contract to the private Supabase queue RPCs.
 * The completion RPC atomically writes normalized lyrics, immutable TTML,
 * and the job acknowledgement, so a successful sink marks jobCompleted.
 */
export class SupabaseAppleLyricsBackfillStore
implements
  AppleLyricsBackfillQueue,
  AppleLyricsBackfillSink<AppleTtmlConversionResult> {
  constructor(
    private readonly client: SupabaseLyricsClient,
    private readonly options: {
      workerId: string;
      leaseSeconds: number;
      now?: () => number;
    },
  ) {}

  async lease(input: {
    limit: number;
    nowMs: number;
  }, options?: AppleLyricsOperationOptions): Promise<readonly AppleLyricsBackfillJob[]> {
    void input.nowMs;
    const claimInput = {
      workerId: this.options.workerId,
      limit: input.limit,
      leaseSeconds: this.options.leaseSeconds,
    };
    const jobs = options
      ? await this.client.claimAppleLyricsBackfill(claimInput, options)
      : await this.client.claimAppleLyricsBackfill(claimInput);
    return jobs.map((job) => ({
      id: job.jobId,
      leaseToken: job.leaseToken,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      exactKey: job.exactKey,
      keyVersion: job.keyVersion,
      track: job.track,
      storefront: job.storefront,
      locale: job.locale,
      ...(job.providerTrackId ? { providerTrackId: job.providerTrackId } : {}),
      ...(job.isrc ? { isrc: job.isrc } : {}),
    }));
  }

  async complete(_input: {
    jobId: string;
    leaseToken: string;
  }, _options?: AppleLyricsOperationOptions): Promise<void> {
    // persist() always uses complete_apple_lyrics_backfill, which includes
    // the acknowledgement in the same transaction.
  }

  async reschedule(input: {
    jobId: string;
    leaseToken: string;
    attempts: number;
    availableAtMs: number;
    failure: AppleLyricsBackfillFailure;
  }, options?: AppleLyricsOperationOptions): Promise<void> {
    void input.attempts;
    const now = this.options.now?.() ?? Date.now();
    const retryAfterSeconds = Math.max(
      1,
      Math.min(86_400, Math.ceil((input.availableAtMs - now) / 1_000)),
    );
    const failureInput = {
      jobId: input.jobId,
      leaseToken: input.leaseToken,
      errorCode: failureCode(input.failure),
      retryable: true,
      retryAfterSeconds,
    };
    if (options) await this.client.failAppleLyricsBackfill(failureInput, options);
    else await this.client.failAppleLyricsBackfill(failureInput);
  }

  async fail(input: {
    jobId: string;
    leaseToken: string;
    attempts: number;
    failure: AppleLyricsBackfillFailure;
  }, options?: AppleLyricsOperationOptions): Promise<void> {
    void input.attempts;
    const failureInput = {
      jobId: input.jobId,
      leaseToken: input.leaseToken,
      errorCode: failureCode(input.failure),
      retryable: false,
      retryAfterSeconds: 1,
    };
    if (options) await this.client.failAppleLyricsBackfill(failureInput, options);
    else await this.client.failAppleLyricsBackfill(failureInput);
  }

  async persist(
    input: AppleLyricsBackfillSinkInput<AppleTtmlConversionResult>,
    options?: AppleLyricsOperationOptions,
  ): Promise<{ jobCompleted: boolean }> {
    const timelineProvenance = appleTtmlTimelineProvenance(input.parsed);
    const payload = appleTtmlProjectionPayload({
      parsed: input.parsed,
      providerTrackId: input.exactIdentity.providerTrackId,
      durationMs: input.track.durationMs,
    });
    const usesCatalogTimelineDuration = input.parsed.kind === 'synced'
      && input.exactIdentity.evidence.includes(
        'catalog-metadata-duration-independent-v1',
      );
    const timelineDurationMs = input.timelineDurationMs
      ?? input.track.durationMs;
    if (
      usesCatalogTimelineDuration
      && (!Number.isSafeInteger(timelineDurationMs)
        || timelineDurationMs <= 0
        || timelineDurationMs > 24 * 60 * 60 * 1_000)
    ) {
      throw new AppleLyricsBackfillError('timeline-duration-invalid', {
        retryable: false,
      });
    }

    const completionInput = {
      jobId: input.jobId,
      leaseToken: input.leaseToken,
      providerTrackId: input.exactIdentity.providerTrackId,
      storefront: input.artifact.storefront,
      rawMetadata: {
        title: input.track.title,
        artist: input.track.artist,
        album: input.track.album,
        duration_ms: Math.max(0, Math.round(input.track.durationMs)),
        source: input.track.source,
      },
      payload,
      provenance: {
        lookup_strategy: 'apple-async-exact-v3',
        body_format: input.parsed.kind === 'synced'
          ? APPLE_TTML_V3_SYNCED_BODY_FORMAT
          : APPLE_TTML_V3_STATIC_BODY_FORMAT,
        ...timelineProvenance,
        ...(usesCatalogTimelineDuration
          ? { timeline_duration_ms: timelineDurationMs }
          : {}),
        exact_identity_proof_version: input.exactIdentity.proofVersion,
        exact_identity_evidence: [...input.exactIdentity.evidence],
        worker_idempotency_key: input.idempotencyKey,
        artifact_sha256: input.artifact.sha256,
        fetched_at: new Date(input.artifact.fetchedAtMs).toISOString(),
      },
      rawTtml: input.artifact.ttml,
      locale: safeLocale(input.artifact.language),
      timingMode: input.parsed.sourceTimingMode,
      recordingVariant: recordingVariant(input.track.title),
    };
    if (options) await this.client.completeAppleLyricsBackfill(completionInput, options);
    else await this.client.completeAppleLyricsBackfill(completionInput);
    return { jobCompleted: true };
  }
}

export function appleTtmlTimelineProvenance(
  parsed: AppleTtmlConversionResult,
): Record<string, unknown> {
  const validation = parsed.timelineValidation;
  if (!validation) {
    throw new AppleLyricsBackfillError('timeline-validation-missing', {
      retryable: false,
    });
  }
  const validSynced = parsed.kind === 'synced'
    && validation.outcome === 'valid'
    && validation.sourceAnomaly === null
    && validation.repairMethod === null;
  const repairedSynced = parsed.kind === 'synced'
    && validation.outcome === 'repaired'
    && validation.sourceAnomaly !== null
    && validation.sourceAnomaly !== 'unsupported-time-base'
    && validation.repairMethod === 'word-span-line-start-v1';
  const rejectedPlain = parsed.kind === 'plain'
    && validation.outcome === 'rejected'
    && validation.sourceAnomaly !== null
    && validation.repairMethod === null;
  const unevaluatedPlain = parsed.kind === 'plain'
    && (
      validation.outcome === 'not-evaluated'
      || validation.outcome === 'not-applicable'
    )
    && validation.sourceAnomaly === null
    && validation.repairMethod === null;
  if (
    !validSynced
    && !repairedSynced
    && !rejectedPlain
    && !unevaluatedPlain
  ) {
    throw new AppleLyricsBackfillError('timeline-validation-inconsistent', {
      retryable: false,
    });
  }
  return {
    timeline_validation_version: validation.version,
    timeline_validation_outcome: validation.outcome,
    timeline_source_anomaly: validation.sourceAnomaly,
    timeline_repair_method: validation.repairMethod,
    timeline_diagnostic_codes: [
      ...new Set(parsed.diagnostics.map((entry) => entry.code)),
    ],
  };
}

export function appleTtmlProjectionPayload(input: {
  parsed: AppleTtmlConversionResult;
  providerTrackId: string;
  durationMs: number;
}): Record<string, unknown> {
  const plainLyrics = input.parsed.plainText?.trim()
    || input.parsed.lines.map((line) => line.text).filter(Boolean).join('\n');
  if (!plainLyrics) {
    throw new AppleLyricsBackfillError('ttml-no-lyrics', { retryable: false });
  }
  const durationMs = Math.max(0, Math.round(input.durationMs));
  return input.parsed.kind === 'synced'
    ? {
        synced_lyrics: serializeDisplayLrcMilliseconds({
          kind: 'synced',
          lines: input.parsed.lines,
          plainText: plainLyrics,
          provider: 'apple',
          providerTrackId: input.providerTrackId,
        }),
        plain_lyrics: plainLyrics,
        is_instrumental: false,
        duration_ms: durationMs,
      }
    : {
        plain_lyrics: plainLyrics,
        is_instrumental: false,
        duration_ms: durationMs,
      };
}

function safeLocale(value: string | undefined): string {
  const locale = value?.trim() || 'und';
  return SAFE_LOCALE.test(locale) ? locale : 'und';
}

function recordingVariant(title: string): string {
  const signature = metadataVersionSignature(title);
  if (!signature) return 'original';
  return signature
    .split(',')
    .map((part) => part.trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))
    .filter(Boolean)
    .join(':')
    .slice(0, 128) || 'unknown';
}

function failureCode(failure: AppleLyricsBackfillFailure): string {
  return `${failure.stage}:${failure.code}`.slice(0, 128);
}
