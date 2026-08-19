import { createHash } from 'node:crypto';
import type { TrackMetadata } from '../shared/contracts.js';

export const APPLE_TTML_MAX_BYTES = 512 * 1_024;
export const APPLE_LYRICS_BACKFILL_DEFAULT_CONCURRENCY = 1;
export const APPLE_LYRICS_BACKFILL_MAX_CONCURRENCY = 1;
export const APPLE_LYRICS_FINALIZATION_TIMEOUT_MS = 10_000;

export interface AppleLyricsOperationOptions {
  signal?: AbortSignal;
}

export type AppleLyricsBackfillStage =
  | 'job'
  | 'fetch'
  | 'identity'
  | 'parse'
  | 'persist';

/**
 * A queue lease, not a request-path command. `attempts` is the number of
 * processing attempts already completed before this lease.
 */
export interface AppleLyricsBackfillJob {
  id: string;
  leaseToken: string;
  attempts: number;
  /** Per-job durable attempt ceiling. The queue is authoritative when present. */
  maxAttempts?: number;
  exactKey: string;
  keyVersion: number;
  track: TrackMetadata;
  /** Optional durable claim hints; they never replace exact verification. */
  storefront?: string;
  locale?: string;
  providerTrackId?: string;
  isrc?: string;
}

export interface AppleLyricsBackfillFailure {
  stage: AppleLyricsBackfillStage;
  code: string;
  retryable: boolean;
  exhausted: boolean;
}

export interface AppleLyricsBackfillQueue {
  lease(input: {
    limit: number;
    nowMs: number;
  }, options?: AppleLyricsOperationOptions): Promise<readonly AppleLyricsBackfillJob[]>;
  complete(input: {
    jobId: string;
    leaseToken: string;
  }, options?: AppleLyricsOperationOptions): Promise<void>;
  reschedule(input: {
    jobId: string;
    leaseToken: string;
    attempts: number;
    availableAtMs: number;
    failure: AppleLyricsBackfillFailure;
  }, options?: AppleLyricsOperationOptions): Promise<void>;
  fail(input: {
    jobId: string;
    leaseToken: string;
    attempts: number;
    failure: AppleLyricsBackfillFailure;
  }, options?: AppleLyricsOperationOptions): Promise<void>;
}

/**
 * The fetcher owns Apple authentication outside this module. Credentials are
 * deliberately absent from both this input and the persisted artifact shape.
 */
export interface AppleLyricsFetcher {
  fetch(input: {
    job: AppleLyricsBackfillJob;
    signal?: AbortSignal;
  }): Promise<AppleFetchedLyrics>;
}

export interface AppleFetchedLyrics {
  /** The exact UTF-8 TTML response body. It must not be reserialized. */
  ttml: string;
  providerTrackId: string;
  storefront: string;
  catalogTrack: TrackMetadata;
  fetchedAtMs: number;
  contentType?: string;
  language?: string;
  timingMode?: string;
  isrc?: string;
}

export type AppleLyricsExactIdentityRejection =
  | 'mismatch'
  | 'ambiguous'
  | 'insufficient-evidence';

export interface AppleLyricsExactIdentityProof {
  proofVersion: 1;
  provider: 'apple';
  providerTrackId: string;
  exactKey: string;
  keyVersion: number;
  /**
   * Safe, non-secret evidence labels supplied by the verifier, for example
   * `catalog-id`, `isrc`, or `catalog-metadata-v1`.
   */
  evidence: readonly string[];
}

export type AppleLyricsExactIdentityResult =
  | {
      state: 'verified';
      proof: AppleLyricsExactIdentityProof;
    }
  | {
      state: 'rejected';
      reason: AppleLyricsExactIdentityRejection;
    };

/**
 * Implementations must fail closed: a work-level or fuzzy match is not an
 * exact proof. The worker independently binds the returned proof to the job
 * key/version and the fetched Apple catalog id before allowing persistence.
 */
export interface AppleLyricsExactIdentityVerifier {
  verify(input: {
    expected: {
      exactKey: string;
      keyVersion: number;
      track: TrackMetadata;
      storefront?: string;
      locale?: string;
      providerTrackId?: string;
      isrc?: string;
    };
    fetched: AppleFetchedLyrics;
    signal?: AbortSignal;
  }): Promise<AppleLyricsExactIdentityResult>;
}

export interface AppleTtmlParser<TParsed> {
  parse(input: {
    ttml: string;
    /** Duration and metadata persisted under the exact lookup key. */
    track: TrackMetadata;
    fetched: AppleFetchedLyrics;
    exactIdentity: AppleLyricsExactIdentityProof;
    signal?: AbortSignal;
  }): Promise<TParsed> | TParsed;
}

export interface AppleTtmlArtifact {
  /** Byte-for-byte source string returned by the fetcher. */
  ttml: string;
  sha256: string;
  byteLength: number;
  fetchedAtMs: number;
  contentType?: string;
  storefront: string;
  language?: string;
  timingMode?: string;
  isrc?: string;
}

export interface AppleLyricsBackfillSinkInput<TParsed> {
  idempotencyKey: string;
  jobId: string;
  leaseToken: string;
  track: TrackMetadata;
  exactKey: string;
  keyVersion: number;
  exactIdentity: AppleLyricsExactIdentityProof;
  /**
   * Duration used only for provider timeline validation. It may differ from
   * track.durationMs, which remains the durable lookup-key metadata.
   */
  timelineDurationMs?: number;
  artifact: AppleTtmlArtifact;
  parsed: TParsed;
}

export interface AppleLyricsBackfillSink<TParsed> {
  persist(
    input: AppleLyricsBackfillSinkInput<TParsed>,
    options?: { signal?: AbortSignal },
  ): Promise<void | { jobCompleted: boolean }>;
}

export interface AppleLyricsBackfillClock {
  now(): number;
}

export interface AppleLyricsBackfillRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

export interface ClassifiedAppleLyricsBackfillError {
  code: string;
  retryable: boolean;
  retryAfterMs?: number;
}

export type AppleLyricsBackfillErrorClassifier = (
  error: unknown,
  stage: AppleLyricsBackfillStage,
) => ClassifiedAppleLyricsBackfillError;

export interface AppleLyricsBackfillDependencies<TParsed> {
  queue: AppleLyricsBackfillQueue;
  fetcher: AppleLyricsFetcher;
  identityVerifier: AppleLyricsExactIdentityVerifier;
  parser: AppleTtmlParser<TParsed>;
  sink: AppleLyricsBackfillSink<TParsed>;
}

export interface AppleLyricsBackfillWorkerOptions {
  concurrency?: number;
  maxTtmlBytes?: number;
  finalizationTimeoutMs?: number;
  retryPolicy?: Partial<AppleLyricsBackfillRetryPolicy>;
  clock?: AppleLyricsBackfillClock;
  random?: () => number;
  classifyError?: AppleLyricsBackfillErrorClassifier;
}

export type AppleLyricsBackfillProcessResult =
  | {
      state: 'succeeded';
      jobId: string;
      artifactSha256: string;
    }
  | {
      state: 'retry-scheduled';
      jobId: string;
      attempts: number;
      availableAtMs: number;
      failure: AppleLyricsBackfillFailure;
    }
  | {
      state: 'permanently-failed';
      jobId: string;
      attempts: number;
      failure: AppleLyricsBackfillFailure;
    };

const DEFAULT_RETRY_POLICY: AppleLyricsBackfillRetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 30_000,
  maxDelayMs: 6 * 60 * 60 * 1_000,
  jitterRatio: 0.2,
};

const SYSTEM_CLOCK: AppleLyricsBackfillClock = {
  now: () => Date.now(),
};

function safeCode(value: string): string {
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)
    ? normalized
    : 'dependency-error';
}

function positiveFiniteInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonnegativeFiniteInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative safe integer`);
  }
  return value;
}

function retryPolicy(
  overrides: Partial<AppleLyricsBackfillRetryPolicy> = {},
): AppleLyricsBackfillRetryPolicy {
  const resolved = { ...DEFAULT_RETRY_POLICY, ...overrides };
  positiveFiniteInteger(resolved.maxAttempts, 'maxAttempts');
  positiveFiniteInteger(resolved.baseDelayMs, 'baseDelayMs');
  positiveFiniteInteger(resolved.maxDelayMs, 'maxDelayMs');
  if (resolved.maxDelayMs < resolved.baseDelayMs) {
    throw new Error('maxDelayMs must be greater than or equal to baseDelayMs');
  }
  if (
    !Number.isFinite(resolved.jitterRatio)
    || resolved.jitterRatio < 0
    || resolved.jitterRatio > 1
  ) {
    throw new Error('jitterRatio must be between 0 and 1');
  }
  return resolved;
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = 'status' in error
    ? (error as { status?: unknown }).status
    : (error as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' && Number.isInteger(status) ? status : undefined;
}

function statusFromMessage(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const match = error.message.match(/(?:^|[_ -])http[_ -]?(\d{3})(?:$|[_ -])/i);
  return match ? Number(match[1]) : undefined;
}

function retryableHttpStatus(status: number): boolean {
  return status === 408
    || status === 409
    || status === 425
    || status === 429
    || status >= 500;
}

/**
 * A dependency may throw this error to make retry semantics explicit without
 * exposing response bodies, headers, credentials, or other sensitive values.
 */
export class AppleLyricsBackfillError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    code: string,
    options: {
      retryable: boolean;
      retryAfterMs?: number;
      cause?: unknown;
    },
  ) {
    super(safeCode(code), options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppleLyricsBackfillError';
    this.code = safeCode(code);
    this.retryable = options.retryable;
    if (Number.isFinite(options.retryAfterMs) && options.retryAfterMs! >= 0) {
      this.retryAfterMs = Math.round(options.retryAfterMs!);
    }
  }
}

/**
 * Conservative default classification. Unknown fetch/persist failures are
 * retried because those stages are I/O; unknown identity/parser failures are
 * permanent because accepting uncertain content would violate exact trust.
 */
export function classifyAppleLyricsBackfillError(
  error: unknown,
  stage: AppleLyricsBackfillStage,
): ClassifiedAppleLyricsBackfillError {
  if (error instanceof AppleLyricsBackfillError) {
    return {
      code: safeCode(error.code),
      retryable: error.retryable,
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    };
  }

  if (
    error instanceof Error
    && (error.name === 'AbortError' || error.name === 'TimeoutError')
  ) {
    return { code: 'timeout', retryable: true };
  }
  if (error instanceof Error && /timeout/i.test(error.message)) {
    return { code: 'timeout', retryable: true };
  }

  const status = errorStatus(error) ?? statusFromMessage(error);
  if (status !== undefined && status >= 400 && status <= 599) {
    return {
      code: `http-${status}`,
      retryable: retryableHttpStatus(status),
    };
  }

  if (error instanceof TypeError && (stage === 'fetch' || stage === 'persist')) {
    return { code: 'network', retryable: true };
  }

  return {
    code: `${stage}-error`,
    retryable: stage === 'fetch' || stage === 'persist',
  };
}

/**
 * Computes durable queue delay after `failedAttempt` (one-based). No sleeping
 * occurs in this module.
 */
export function appleLyricsBackfillDelayMs(
  failedAttempt: number,
  policyInput: AppleLyricsBackfillRetryPolicy = DEFAULT_RETRY_POLICY,
  random: () => number = Math.random,
): number {
  positiveFiniteInteger(failedAttempt, 'failedAttempt');
  const policy = retryPolicy(policyInput);
  const exponent = Math.min(52, failedAttempt - 1);
  const withoutJitter = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * (2 ** exponent),
  );
  const randomValue = Math.max(0, Math.min(1, random()));
  const jitterMultiplier = 1 + ((randomValue * 2) - 1) * policy.jitterRatio;
  return Math.max(
    0,
    Math.min(policy.maxDelayMs, Math.round(withoutJitter * jitterMultiplier)),
  );
}

function validateJobReference(job: AppleLyricsBackfillJob): void {
  if (!job.id || job.id !== job.id.trim()) throw new Error('Queue returned an invalid job id');
  if (!job.leaseToken || job.leaseToken !== job.leaseToken.trim()) {
    throw new Error('Queue returned an invalid lease token');
  }
}

function validateJob(job: AppleLyricsBackfillJob): void {
  nonnegativeFiniteInteger(job.attempts, 'job.attempts');
  if (job.maxAttempts !== undefined) {
    positiveFiniteInteger(job.maxAttempts, 'job.maxAttempts');
  }
  positiveFiniteInteger(job.keyVersion, 'job.keyVersion');
  if (!job.exactKey || job.exactKey !== job.exactKey.trim() || job.exactKey.length > 512) {
    throw new AppleLyricsBackfillError('invalid-exact-key', { retryable: false });
  }
  if (
    typeof job.track.title !== 'string'
    || !job.track.title.trim()
    || typeof job.track.artist !== 'string'
    || typeof job.track.album !== 'string'
    || typeof job.track.source !== 'string'
    || !Number.isFinite(job.track.durationMs)
    || job.track.durationMs < 0
  ) {
    throw new AppleLyricsBackfillError('invalid-job-track', { retryable: false });
  }
  const hints = [job.storefront, job.locale, job.providerTrackId, job.isrc];
  if (hints.some((hint) =>
    hint !== undefined
    && (typeof hint !== 'string' || !hint || hint !== hint.trim() || hint.length > 256))) {
    throw new AppleLyricsBackfillError('invalid-job-hint', { retryable: false });
  }
}

function validateFetched(fetched: AppleFetchedLyrics, maxTtmlBytes: number): number {
  if (typeof fetched.ttml !== 'string' || !fetched.ttml.trim()) {
    throw new AppleLyricsBackfillError('empty-ttml', { retryable: false });
  }
  const byteLength = Buffer.byteLength(fetched.ttml, 'utf8');
  if (byteLength > maxTtmlBytes) {
    throw new AppleLyricsBackfillError('ttml-too-large', { retryable: false });
  }
  if (
    !fetched.providerTrackId
    || fetched.providerTrackId !== fetched.providerTrackId.trim()
    || !fetched.storefront
    || fetched.storefront !== fetched.storefront.trim()
    || !Number.isSafeInteger(fetched.fetchedAtMs)
    || fetched.fetchedAtMs < 0
  ) {
    throw new AppleLyricsBackfillError('invalid-fetch-result', { retryable: false });
  }
  return byteLength;
}

function verifiedProof(
  result: AppleLyricsExactIdentityResult,
  job: AppleLyricsBackfillJob,
  fetched: AppleFetchedLyrics,
): AppleLyricsExactIdentityProof {
  if (result.state === 'rejected') {
    throw new AppleLyricsBackfillError(`identity-${result.reason}`, { retryable: false });
  }
  const { proof } = result;
  const validEvidence = Array.isArray(proof.evidence)
    && proof.evidence.length > 0
    && proof.evidence.every((entry) =>
      typeof entry === 'string'
      && entry.length > 0
      && entry.length <= 64
      && entry === entry.trim());
  if (
    proof.proofVersion !== 1
    || proof.provider !== 'apple'
    || proof.exactKey !== job.exactKey
    || proof.keyVersion !== job.keyVersion
    || proof.providerTrackId !== fetched.providerTrackId
    || (
      job.providerTrackId !== undefined
      && proof.providerTrackId !== job.providerTrackId
    )
    || (job.isrc !== undefined && fetched.isrc !== job.isrc)
    || !validEvidence
  ) {
    throw new AppleLyricsBackfillError('invalid-exact-proof', { retryable: false });
  }
  return proof;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function idempotencyKey(
  job: AppleLyricsBackfillJob,
  proof: AppleLyricsExactIdentityProof,
  artifactSha256: string,
): string {
  const digest = createHash('sha256')
    .update(String(job.keyVersion))
    .update('\0')
    .update(job.exactKey)
    .update('\0')
    .update(proof.providerTrackId)
    .update('\0')
    .update(artifactSha256)
    .digest('hex');
  return `apple-ttml:v1:${digest}`;
}

/**
 * Explicitly driven background worker. Constructing it performs no work and
 * starts no timer; callers should invoke `runOnce` only from a worker/scheduler,
 * never await it from the lyrics request path.
 */
export class AppleLyricsBackfillWorker<TParsed> {
  private readonly concurrency: number;
  private readonly maxTtmlBytes: number;
  private readonly finalizationTimeoutMs: number;
  private readonly policy: AppleLyricsBackfillRetryPolicy;
  private readonly clock: AppleLyricsBackfillClock;
  private readonly random: () => number;
  private readonly classifyError: AppleLyricsBackfillErrorClassifier;

  constructor(
    private readonly dependencies: AppleLyricsBackfillDependencies<TParsed>,
    options: AppleLyricsBackfillWorkerOptions = {},
  ) {
    this.concurrency = options.concurrency
      ?? APPLE_LYRICS_BACKFILL_DEFAULT_CONCURRENCY;
    if (
      !Number.isSafeInteger(this.concurrency)
      || this.concurrency < 1
      || this.concurrency > APPLE_LYRICS_BACKFILL_MAX_CONCURRENCY
    ) {
      throw new Error(
        `concurrency must be between 1 and ${APPLE_LYRICS_BACKFILL_MAX_CONCURRENCY}`,
      );
    }
    this.maxTtmlBytes = options.maxTtmlBytes ?? APPLE_TTML_MAX_BYTES;
    if (
      !Number.isSafeInteger(this.maxTtmlBytes)
      || this.maxTtmlBytes < 1
      || this.maxTtmlBytes > APPLE_TTML_MAX_BYTES
    ) {
      throw new Error(`maxTtmlBytes must be between 1 and ${APPLE_TTML_MAX_BYTES}`);
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
    this.policy = retryPolicy(options.retryPolicy);
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.random = options.random ?? Math.random;
    this.classifyError = options.classifyError ?? classifyAppleLyricsBackfillError;
  }

  async runOnce(options: {
    signal?: AbortSignal;
  } = {}): Promise<AppleLyricsBackfillProcessResult[]> {
    options.signal?.throwIfAborted();
    const nowMs = this.now();
    const leaseInput = {
      limit: this.concurrency,
      nowMs,
    };
    const jobs = options.signal
      ? await this.dependencies.queue.lease(leaseInput, { signal: options.signal })
      : await this.dependencies.queue.lease(leaseInput);
    if (jobs.length > this.concurrency) {
      throw new Error('Queue returned more jobs than the requested lease limit');
    }
    return Promise.all(jobs.map((job) => this.processOne(job, options)));
  }

  async processOne(
    job: AppleLyricsBackfillJob,
    options: { signal?: AbortSignal } = {},
  ): Promise<AppleLyricsBackfillProcessResult> {
    validateJobReference(job);
    const maxAttempts = job.maxAttempts ?? this.policy.maxAttempts;
    const priorAttempts = Number.isSafeInteger(job.attempts) && job.attempts >= 0
      ? job.attempts
      : 0;
    if (priorAttempts >= maxAttempts) {
      return this.failPermanently(job, priorAttempts, {
        stage: 'job',
        code: 'attempts-exhausted',
        retryable: false,
        exhausted: true,
      }, this.finalizationOptions());
    }

    const attempt = priorAttempts + 1;
    let stage: AppleLyricsBackfillStage = 'job';
    try {
      if (options.signal?.aborted) {
        throw new AppleLyricsBackfillError('worker-stopped', { retryable: true });
      }
      validateJob(job);

      stage = 'fetch';
      const fetched = await this.dependencies.fetcher.fetch({
        job,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const byteLength = validateFetched(fetched, this.maxTtmlBytes);

      stage = 'identity';
      const identity = await this.dependencies.identityVerifier.verify({
        expected: {
          exactKey: job.exactKey,
          keyVersion: job.keyVersion,
          track: job.track,
          ...(job.storefront ? { storefront: job.storefront } : {}),
          ...(job.locale ? { locale: job.locale } : {}),
          ...(job.providerTrackId ? { providerTrackId: job.providerTrackId } : {}),
          ...(job.isrc ? { isrc: job.isrc } : {}),
        },
        fetched,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const proof = verifiedProof(identity, job, fetched);

      stage = 'parse';
      const parsed = await this.dependencies.parser.parse({
        ttml: fetched.ttml,
        track: job.track,
        fetched,
        exactIdentity: proof,
        ...(options.signal ? { signal: options.signal } : {}),
      });

      const artifactSha256 = sha256(fetched.ttml);
      const artifact: AppleTtmlArtifact = {
        ttml: fetched.ttml,
        sha256: artifactSha256,
        byteLength,
        fetchedAtMs: fetched.fetchedAtMs,
        storefront: fetched.storefront,
        ...(fetched.contentType ? { contentType: fetched.contentType } : {}),
        ...(fetched.language ? { language: fetched.language } : {}),
        ...(fetched.timingMode ? { timingMode: fetched.timingMode } : {}),
        ...(fetched.isrc ? { isrc: fetched.isrc } : {}),
      };

      stage = 'persist';
      const persisted = await this.dependencies.sink.persist({
        idempotencyKey: idempotencyKey(job, proof, artifactSha256),
        jobId: job.id,
        leaseToken: job.leaseToken,
        track: job.track,
        exactKey: job.exactKey,
        keyVersion: job.keyVersion,
        exactIdentity: proof,
        timelineDurationMs: fetched.catalogTrack.durationMs,
        artifact,
        parsed,
      }, options.signal ? { signal: options.signal } : undefined);

      if (persisted?.jobCompleted !== true) {
        const completeInput = {
          jobId: job.id,
          leaseToken: job.leaseToken,
        };
        if (options.signal) {
          await this.dependencies.queue.complete(completeInput, {
            signal: options.signal,
          });
        } else {
          await this.dependencies.queue.complete(completeInput);
        }
      }
      return {
        state: 'succeeded',
        jobId: job.id,
        artifactSha256,
      };
    } catch (error) {
      const classified = this.classifyError(error, stage);
      const code = safeCode(classified.code);
      if (!classified.retryable || attempt >= maxAttempts) {
        return this.failPermanently(job, attempt, {
          stage,
          code,
          retryable: false,
          exhausted: classified.retryable && attempt >= maxAttempts,
        }, this.finalizationOptions());
      }

      const exponentialDelay = appleLyricsBackfillDelayMs(
        attempt,
        this.policy,
        this.random,
      );
      const retryAfterMs = Number.isFinite(classified.retryAfterMs)
        ? Math.max(0, Math.round(classified.retryAfterMs!))
        : 0;
      const delayMs = Math.min(
        this.policy.maxDelayMs,
        Math.max(exponentialDelay, retryAfterMs),
      );
      const availableAtMs = this.now() + delayMs;
      const failure: AppleLyricsBackfillFailure = {
        stage,
        code,
        retryable: true,
        exhausted: false,
      };
      await this.dependencies.queue.reschedule({
        jobId: job.id,
        leaseToken: job.leaseToken,
        attempts: attempt,
        availableAtMs,
        failure,
      }, this.finalizationOptions());
      return {
        state: 'retry-scheduled',
        jobId: job.id,
        attempts: attempt,
        availableAtMs,
        failure,
      };
    }
  }

  private now(): number {
    const value = this.clock.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('clock.now() must return a nonnegative safe integer');
    }
    return value;
  }

  private async failPermanently(
    job: AppleLyricsBackfillJob,
    attempts: number,
    failure: AppleLyricsBackfillFailure,
    options: AppleLyricsOperationOptions,
  ): Promise<Extract<AppleLyricsBackfillProcessResult, { state: 'permanently-failed' }>> {
    await this.dependencies.queue.fail({
      jobId: job.id,
      leaseToken: job.leaseToken,
      attempts,
      failure,
    }, options);
    return {
      state: 'permanently-failed',
      jobId: job.id,
      attempts,
      failure,
    };
  }

  private finalizationOptions(): AppleLyricsOperationOptions {
    // The operation signal may already be aborted by the worker deadline. Lease
    // settlement must get its own short budget or the fail/reschedule RPC would
    // be cancelled before it can release the durable lease.
    return { signal: AbortSignal.timeout(this.finalizationTimeoutMs) };
  }
}
