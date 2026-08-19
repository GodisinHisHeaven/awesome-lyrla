import type { TrackMetadata } from '../shared/contracts.js';
import { lyricsLookupFingerprint } from '../shared/track.js';
import {
  AppleLyricsBackfillError,
  APPLE_TTML_MAX_BYTES,
  type AppleFetchedLyrics,
  type AppleLyricsBackfillJob,
  type AppleLyricsExactIdentityResult,
  type AppleLyricsExactIdentityVerifier,
  type AppleLyricsFetcher,
} from './apple-lyrics-backfill.js';
import {
  AppleMusicCatalogService,
  type AppleMusicCatalogMatch,
} from './apple-music-catalog.js';
import {
  scriptEquivalentTrackMetadata,
  trackScriptVariants,
} from './lyrics-metadata-alias.js';

const APPLE_MUSIC_WEB_ORIGIN = 'https://music.apple.com';
const APPLE_MUSIC_BROWSE_URL = `${APPLE_MUSIC_WEB_ORIGIN}/us/browse`;
const APPLE_MUSIC_AMP_ORIGIN = 'https://amp-api.music.apple.com';
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const MAX_REQUEST_TIMEOUT_MS = 30_000;
const APPLE_ACCOUNT_BODY_LIMIT = 1 * 1_024 * 1_024;
// music.apple.com serves compressed HTML that currently expands beyond 1 MiB.
const BROWSE_BODY_LIMIT = 4 * 1_024 * 1_024;
const ASSET_BODY_LIMIT = 12 * 1_024 * 1_024;
const CATALOG_BODY_LIMIT = 4 * 1_024 * 1_024;
const MAX_DISCOVERY_ASSETS = 8;
const MAX_JWT_CANDIDATES = 64;
const BEARER_SCAN_CHUNK_CHARS = 256 * 1_024;
const BEARER_SCAN_OVERLAP_CHARS = 16_384;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const APPLE_LYRICS_EXACT_KEY_VERSION = 1;
const APPLE_DURATION_SECOND_QUANTIZATION_TOLERANCE_MS = 500;
const MAX_PUBLIC_REDIRECTS = 3;
const MAX_FALLBACK_STOREFRONTS = 2;
const FOLLOWABLE_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface AppleMusicCatalogMatchResolver {
  resolveMatch(
    track: TrackMetadata,
    storefrontOverride?: string,
    options?: { signal?: AbortSignal; exhaustive?: boolean },
  ): Promise<AppleMusicCatalogMatch | null>;
}

export interface AppleMusicLyricsSourceSettings {
  /**
   * An Apple Music subscriber credential. It is used only as a request header
   * and is never included in return values, error messages, or error causes.
   */
  mediaUserToken: string;
  /**
   * Optional Apple Music web bearer. When omitted, a short-lived bearer is
   * discovered from the public web application and cached until its JWT expiry.
   */
  webBearerToken?: string;
  /**
   * Explicitly allowed Catalog storefronts to try after the subscriber
   * storefront and the job's durable storefront hint. Invalid, duplicate,
   * and excess values are ignored; arbitrary storefront probing is never used.
   */
  fallbackStorefronts?: readonly string[];
  requestTimeoutMs?: number;
  fetchImpl?: FetchLike;
  now?: () => number;
}

interface CachedBearer {
  token: string;
  expiresAtMs: number;
}

interface AppleAccountContext {
  storefront: string;
  locale: string;
}

interface AuthorizedRequestContext {
  refreshedDynamicBearer: boolean;
}

interface AppleRequestResult {
  response: Response;
  signal: AbortSignal;
  timeoutSignal: AbortSignal;
}

interface ParsedCatalogLyrics {
  ttml: string;
  timingMode: 'line-or-word' | 'syllable';
  providerTrackId: string;
  catalogTrack: TrackMetadata;
  isrc?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonemptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function safeSecret(value: string | undefined, code: string): string {
  if (
    typeof value !== 'string'
    || !value
    || value !== value.trim()
    || value.length > 16_384
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new AppleLyricsBackfillError(code, { retryable: false });
  }
  return value;
}

function normalizeIsrc(value: string): string {
  return value.trim().toLocaleUpperCase('en-US');
}

function catalogStorefronts(
  primary: string,
  configuredFallbacks: readonly string[] = [],
): string[] {
  const normalizedPrimary = primary.toLocaleLowerCase('en-US');
  const fallbacks = [...new Set(configuredFallbacks
    .map((storefront) => storefront.trim().toLocaleLowerCase('en-US'))
    .filter((storefront) =>
      /^[a-z]{2}$/.test(storefront)
      && storefront !== normalizedPrimary))]
    .slice(0, MAX_FALLBACK_STOREFRONTS);
  return [normalizedPrimary, ...fallbacks];
}

function retryAfterMs(response: Response, nowMs: number): number | undefined {
  const value = response.headers.get('retry-after')?.trim();
  if (!value) return undefined;
  if (/^\d{1,7}$/.test(value)) {
    return Math.min(24 * 60 * 60 * 1_000, Number(value) * 1_000);
  }
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.min(24 * 60 * 60 * 1_000, Math.max(0, dateMs - nowMs));
}

function httpError(response: Response, nowMs: number): AppleLyricsBackfillError {
  const status = response.status;
  if (status >= 300 && status < 400) {
    return new AppleLyricsBackfillError('apple-redirect-rejected', { retryable: false });
  }
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return new AppleLyricsBackfillError(`apple-http-${status}`, {
      retryable: true,
      ...(status === 429
        ? { retryAfterMs: retryAfterMs(response, nowMs) }
        : {}),
    });
  }
  return new AppleLyricsBackfillError(`apple-http-${status}`, { retryable: false });
}

function catalogDependencyError(error: unknown): AppleLyricsBackfillError {
  if (error instanceof AppleLyricsBackfillError) return error;
  const message = error instanceof Error ? error.message : '';
  const statusMatch = message.match(/(?:^|[_ -])http[_ -]?(\d{3})(?:$|[_ -])/i);
  const status = statusMatch ? Number(statusMatch[1]) : undefined;
  if (status !== undefined) {
    return new AppleLyricsBackfillError(`apple-catalog-http-${status}`, {
      retryable: status === 408 || status === 425 || status === 429 || status >= 500,
    });
  }
  return new AppleLyricsBackfillError('apple-catalog-unavailable', { retryable: true });
}

function responseContentLength(response: Response): number | undefined {
  const value = response.headers.get('content-length');
  if (!value || !/^\d+$/.test(value)) return undefined;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : undefined;
}

async function readLimitedUtf8(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) {
    cancelBody(response, abortReason(signal));
    throw abortReason(signal);
  }
  const declaredLength = responseContentLength(response);
  if (declaredLength !== undefined && declaredLength > maxBytes) {
    cancelBody(response, new Error('Apple response exceeded its byte limit'));
    throw new AppleLyricsBackfillError('apple-response-too-large', { retryable: false });
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
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
      void pendingRead.catch(() => undefined);
      const { done, value } = aborted
        ? await Promise.race([pendingRead, aborted])
        : await pendingRead;
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        cancelReader(reader, new Error('Apple response exceeded its byte limit'));
        throw new AppleLyricsBackfillError('apple-response-too-large', { retryable: false });
      }
      chunks.push(value);
    }
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
  signal?.throwIfAborted();

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new AppleLyricsBackfillError('apple-response-invalid-utf8', { retryable: true });
  }
}

async function readLimitedJson(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const body = await readLimitedUtf8(response, maxBytes, signal);
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new AppleLyricsBackfillError('apple-response-invalid-json', { retryable: true });
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Operation aborted', 'AbortError');
}

function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: unknown,
): void {
  void reader.cancel(reason).catch(() => undefined);
}

function cancelBody(response: Response, reason: unknown): void {
  if (!response.body || response.body.locked) return;
  void response.body.cancel(reason).catch(() => undefined);
}

function appleRequestError(
  error: unknown,
  callerSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
): AppleLyricsBackfillError {
  if (error instanceof AppleLyricsBackfillError) return error;
  if (callerSignal?.aborted) {
    return new AppleLyricsBackfillError('apple-request-aborted', { retryable: true });
  }
  if (timeoutSignal.aborted) {
    return new AppleLyricsBackfillError('apple-timeout', { retryable: true });
  }
  return new AppleLyricsBackfillError('apple-network', { retryable: true });
}

async function waitWithSignal<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function assetUrlsFromBrowse(html: string): URL[] {
  const urls: URL[] = [];
  const seen = new Set<string>();
  const scriptPattern = /<script\b[^>]*\bsrc\s*=\s*(["'])([^"']+)\1[^>]*>/gi;
  for (const match of html.matchAll(scriptPattern)) {
    if (urls.length >= MAX_DISCOVERY_ASSETS) break;
    let candidate: URL;
    try {
      candidate = new URL(match[2], APPLE_MUSIC_WEB_ORIGIN);
    } catch {
      continue;
    }
    if (
      candidate.origin !== APPLE_MUSIC_WEB_ORIGIN
      || candidate.protocol !== 'https:'
      || candidate.username
      || candidate.password
      || candidate.hash
      || !/^\/assets\/index[^/]*\.js$/i.test(candidate.pathname)
      || seen.has(candidate.href)
    ) {
      continue;
    }
    seen.add(candidate.href);
    urls.push(candidate);
  }
  return urls;
}

function jwtExpiryMs(token: string, nowMs: number): number | null {
  if (token.length > 16_384) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
    return null;
  }
  try {
    const header = record(JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')));
    const payload = record(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')));
    const algorithm = header?.alg;
    const expiresAtSeconds = payload?.exp;
    if (
      typeof algorithm !== 'string'
      || algorithm.toLocaleLowerCase('en-US') === 'none'
      || typeof expiresAtSeconds !== 'number'
      || !Number.isSafeInteger(expiresAtSeconds)
    ) {
      return null;
    }
    const expiresAtMs = expiresAtSeconds * 1_000;
    return expiresAtMs > nowMs + TOKEN_REFRESH_MARGIN_MS ? expiresAtMs : null;
  } catch {
    return null;
  }
}

async function bearerFromAsset(
  asset: string,
  nowMs: number,
  signal?: AbortSignal,
): Promise<CachedBearer | null> {
  const tokenPattern = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/g;
  let best: CachedBearer | null = null;
  let count = 0;
  const seen = new Set<string>();
  for (let offset = 0; offset < asset.length; offset += BEARER_SCAN_CHUNK_CHARS) {
    signal?.throwIfAborted();
    const end = Math.min(asset.length, offset + BEARER_SCAN_CHUNK_CHARS);
    const windowStart = Math.max(0, offset - BEARER_SCAN_OVERLAP_CHARS);
    const window = asset.slice(windowStart, end);
    tokenPattern.lastIndex = 0;
    for (const match of window.matchAll(tokenPattern)) {
      const token = match[0];
      const absoluteEnd = windowStart + (match.index ?? 0) + token.length;
      // A non-final chunk may contain only a prefix of the signature. Defer it
      // to the next overlapping window instead of accepting a truncated JWT.
      if (end < asset.length && absoluteEnd === end) continue;
      if (seen.has(token)) continue;
      seen.add(token);
      count += 1;
      if (count > MAX_JWT_CANDIDATES) return best;
      const expiresAtMs = jwtExpiryMs(token, nowMs);
      if (expiresAtMs !== null && (!best || expiresAtMs > best.expiresAtMs)) {
        best = { token, expiresAtMs };
      }
    }
    if (end < asset.length) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  return best;
}

function storefrontFromPayload(payload: unknown): AppleAccountContext {
  const root = record(payload);
  const data = root?.data;
  const item = Array.isArray(data) ? record(data[0]) : null;
  const attributes = record(item?.attributes);
  const storefront = nonemptyString(item?.id)?.toLocaleLowerCase('en-US') ?? '';
  const locale = nonemptyString(attributes?.defaultLanguageTag) ?? '';
  if (
    !/^[a-z]{2}$/.test(storefront)
    || locale.length > 64
    || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,4}$/.test(locale)
  ) {
    throw new AppleLyricsBackfillError('apple-storefront-invalid-response', {
      retryable: true,
    });
  }
  return { storefront, locale };
}

function relationshipTtml(
  relationships: Record<string, unknown>,
  name: 'lyrics' | 'syllable-lyrics',
): string | null {
  const relationship = record(relationships[name]);
  const data = relationship?.data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const resource = record(data[0]);
  const attributes = record(resource?.attributes);
  const value = attributes?.ttml;
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') {
    throw new AppleLyricsBackfillError('apple-lyrics-invalid-response', {
      retryable: true,
    });
  }
  return value;
}

function catalogLyricsFromPayload(
  payload: unknown,
  expectedProviderTrackId: string,
  source: string,
): ParsedCatalogLyrics {
  const root = record(payload);
  const data = root?.data;
  if (!Array.isArray(data) || data.length === 0) {
    throw new AppleLyricsBackfillError('apple-lyrics-unavailable', { retryable: false });
  }
  const song = data.map(record).find((item) => item?.id === expectedProviderTrackId);
  if (!song) {
    throw new AppleLyricsBackfillError('apple-catalog-id-mismatch', { retryable: false });
  }

  const attributes = record(song.attributes);
  const relationships = record(song.relationships);
  if (!attributes || !relationships) {
    throw new AppleLyricsBackfillError('apple-lyrics-invalid-response', { retryable: true });
  }

  const title = nonemptyString(attributes.name);
  const artist = nonemptyString(attributes.artistName);
  const album = nonemptyString(attributes.albumName);
  const durationMs = attributes.durationInMillis;
  if (
    !title
    || !artist
    || album === null
    || typeof durationMs !== 'number'
    || !Number.isSafeInteger(durationMs)
    || durationMs < 0
  ) {
    throw new AppleLyricsBackfillError('apple-catalog-metadata-invalid', {
      retryable: true,
    });
  }

  const lineOrWordTtml = relationshipTtml(relationships, 'lyrics');
  const syllableTtml = lineOrWordTtml === null
    ? relationshipTtml(relationships, 'syllable-lyrics')
    : null;
  const ttml = lineOrWordTtml ?? syllableTtml;
  if (ttml === null || !ttml.trim()) {
    throw new AppleLyricsBackfillError('apple-lyrics-unavailable', { retryable: false });
  }
  if (Buffer.byteLength(ttml, 'utf8') > APPLE_TTML_MAX_BYTES) {
    throw new AppleLyricsBackfillError('ttml-too-large', { retryable: false });
  }

  const isrcValue = attributes.isrc;
  if (isrcValue !== undefined && typeof isrcValue !== 'string') {
    throw new AppleLyricsBackfillError('apple-catalog-metadata-invalid', {
      retryable: true,
    });
  }

  return {
    ttml,
    timingMode: lineOrWordTtml === null ? 'syllable' : 'line-or-word',
    providerTrackId: expectedProviderTrackId,
    catalogTrack: {
      title,
      artist,
      album,
      durationMs,
      source,
    },
    ...(typeof isrcValue === 'string' && isrcValue.trim()
      ? { isrc: isrcValue.trim() }
      : {}),
  };
}

/**
 * Verifies content eligible for exact-key promotion. Title, artist, album, and
 * recording-version metadata are identity evidence; playback duration is not.
 * Apple catalog duration is the source-of-truth for the TTML timeline, while
 * the Tesla duration remains the durable lookup key. Fuzzy catalog matching is
 * useful for discovery but never promotion evidence.
 */
export class AppleMusicLyricsExactIdentityVerifier
implements AppleLyricsExactIdentityVerifier {
  async verify(input: {
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
  }): Promise<AppleLyricsExactIdentityResult> {
    if (input.signal?.aborted) {
      throw new AppleLyricsBackfillError('apple-request-aborted', { retryable: true });
    }
    if (input.expected.keyVersion !== APPLE_LYRICS_EXACT_KEY_VERSION) {
      return { state: 'rejected', reason: 'insufficient-evidence' };
    }
    if (lyricsLookupFingerprint(input.expected.track) !== input.expected.exactKey) {
      return { state: 'rejected', reason: 'mismatch' };
    }
    if (
      input.expected.providerTrackId !== undefined
      && input.expected.providerTrackId !== input.fetched.providerTrackId
    ) {
      return { state: 'rejected', reason: 'mismatch' };
    }
    if (input.expected.isrc !== undefined) {
      if (!input.fetched.isrc) {
        return { state: 'rejected', reason: 'insufficient-evidence' };
      }
      if (normalizeIsrc(input.expected.isrc) !== normalizeIsrc(input.fetched.isrc)) {
        return { state: 'rejected', reason: 'mismatch' };
      }
    }
    const fetchedFingerprint = lyricsLookupFingerprint(input.fetched.catalogTrack);
    const exactCatalogMetadata = fetchedFingerprint === input.expected.exactKey;
    const scriptEquivalentMetadata = scriptEquivalentTrackMetadata(
      input.expected.track,
      input.fetched.catalogTrack,
    );
    const scriptEquivalentExact = !exactCatalogMetadata
      && scriptEquivalentMetadata
      && trackScriptVariants(input.fetched.catalogTrack).some((variant) =>
        lyricsLookupFingerprint(variant) === input.expected.exactKey);
    const durationDifferenceMs = Math.abs(
      input.fetched.catalogTrack.durationMs - input.expected.track.durationMs,
    );
    const secondQuantizedDuration = (
      !exactCatalogMetadata
      && !scriptEquivalentExact
      && scriptEquivalentMetadata
      && Number.isSafeInteger(input.expected.track.durationMs)
      && input.expected.track.durationMs % 1_000 === 0
      && Number.isSafeInteger(input.fetched.catalogTrack.durationMs)
      && durationDifferenceMs <= APPLE_DURATION_SECOND_QUANTIZATION_TOLERANCE_MS
      && trackScriptVariants({
        ...input.fetched.catalogTrack,
        durationMs: input.expected.track.durationMs,
      }).some((variant) => lyricsLookupFingerprint(variant) === input.expected.exactKey)
    );
    // The catalog resolver has already selected a concrete Apple song id using
    // title/artist/album/version evidence. Once the fetched song reproduces
    // that metadata (including script-only differences), a different duration
    // is telemetry drift, not proof that the lyrics belong to another track.
    // Keep this separate from the bounded key alias so the evidence remains
    // explicit and timeline validation can independently decide auto-scroll.
    const durationIndependentCatalogMetadata = (
      !exactCatalogMetadata
      && !scriptEquivalentExact
      && !secondQuantizedDuration
      && scriptEquivalentMetadata
      && Boolean(input.fetched.providerTrackId)
    );
    if (
      !exactCatalogMetadata
      && !scriptEquivalentExact
      && !secondQuantizedDuration
      && !durationIndependentCatalogMetadata
    ) {
      return { state: 'rejected', reason: 'mismatch' };
    }

    const evidence = exactCatalogMetadata
      ? ['catalog-metadata-v1']
      : scriptEquivalentExact
        ? ['catalog-metadata-script-equivalent-v1']
        : secondQuantizedDuration
          ? [
              'catalog-metadata-nonduration-v1',
              'duration-second-quantized-500ms-v1',
              ...(lyricsLookupFingerprint({
                ...input.fetched.catalogTrack,
                durationMs: input.expected.track.durationMs,
              }) === input.expected.exactKey
                ? []
                : ['catalog-metadata-script-equivalent-v1']),
            ]
          : ['catalog-metadata-duration-independent-v1'];
    if (input.expected.providerTrackId !== undefined) evidence.push('catalog-id');
    if (input.expected.isrc !== undefined) evidence.push('isrc');
    return {
      state: 'verified',
      proof: {
        proofVersion: 1,
        provider: 'apple',
        providerTrackId: input.fetched.providerTrackId,
        exactKey: input.expected.exactKey,
        keyVersion: input.expected.keyVersion,
        evidence,
      },
    };
  }
}

/**
 * Apple Music subscriber TTML source for the asynchronous backfill worker.
 * Construction performs no I/O and starts no timers.
 */
export class AppleMusicLyricsSource implements AppleLyricsFetcher {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private discoveredBearer?: CachedBearer;
  private bearerDiscoveryInFlight?: Promise<CachedBearer>;
  private accountContext?: AppleAccountContext;

  constructor(
    private readonly settings: AppleMusicLyricsSourceSettings,
    private readonly catalog: AppleMusicCatalogMatchResolver = new AppleMusicCatalogService(),
  ) {
    this.fetchImpl = settings.fetchImpl ?? globalThis.fetch;
    this.now = settings.now ?? Date.now;
    const timeoutMs = settings.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(timeoutMs)
      || timeoutMs < 100
      || timeoutMs > MAX_REQUEST_TIMEOUT_MS
    ) {
      throw new Error(`requestTimeoutMs must be between 100 and ${MAX_REQUEST_TIMEOUT_MS}`);
    }
    this.timeoutMs = timeoutMs;
  }

  async fetch(input: {
    job: AppleLyricsBackfillJob;
    signal?: AbortSignal;
  }): Promise<AppleFetchedLyrics> {
    if (input.signal?.aborted) {
      throw new AppleLyricsBackfillError('apple-request-aborted', { retryable: true });
    }
    const mediaUserToken = safeSecret(
      this.settings.mediaUserToken,
      'apple-media-user-token-missing',
    );
    const requestContext: AuthorizedRequestContext = {
      refreshedDynamicBearer: false,
    };
    const account = await this.account(mediaUserToken, requestContext, input.signal);
    let unavailable = false;
    let claimHintFailure: AppleLyricsBackfillError | undefined;
    for (const storefront of catalogStorefronts(
      account.storefront,
      [
        ...(input.job.storefront ? [input.job.storefront] : []),
        ...(this.settings.fallbackStorefronts ?? []),
      ],
    )) {
      const match = await this.resolveCatalogMatch(
        input.job,
        storefront,
        input.signal,
      );
      if (!match) continue;
      try {
        this.verifyClaimHints(input.job, match);
      } catch (error) {
        if (!(error instanceof AppleLyricsBackfillError)) throw error;
        claimHintFailure ??= error;
        continue;
      }
      if (match.hasLyrics === false) {
        unavailable = true;
        continue;
      }
      try {
        return await this.fetchMatchedLyrics(
          input.job,
          match,
          storefront,
          account.locale,
          mediaUserToken,
          requestContext,
          input.signal,
        );
      } catch (error) {
        if (
          error instanceof AppleLyricsBackfillError
          && error.code === 'apple-lyrics-unavailable'
        ) {
          unavailable = true;
          continue;
        }
        throw error;
      }
    }
    if (claimHintFailure) throw claimHintFailure;
    if (unavailable) {
      throw new AppleLyricsBackfillError('apple-lyrics-unavailable', { retryable: false });
    }
    throw new AppleLyricsBackfillError('apple-catalog-match-not-found', {
      retryable: false,
    });
  }

  private async fetchMatchedLyrics(
    job: AppleLyricsBackfillJob,
    match: AppleMusicCatalogMatch,
    storefront: string,
    locale: string,
    mediaUserToken: string,
    requestContext: AuthorizedRequestContext,
    signal?: AbortSignal,
  ): Promise<AppleFetchedLyrics> {
    const url = new URL(
      `/v1/catalog/${storefront}/songs/${encodeURIComponent(match.providerTrackId)}`,
      APPLE_MUSIC_AMP_ORIGIN,
    );
    url.searchParams.set('include[songs]', 'albums,lyrics,syllable-lyrics');
    url.searchParams.set('l', locale);
    const request = await this.authorizedRequest(
      url,
      mediaUserToken,
      locale,
      requestContext,
      signal,
    );
    const response = request.response;
    const contentType = response.headers.get('content-type')?.trim() || undefined;
    const payload = await this.readJson(request, CATALOG_BODY_LIMIT, signal);
    const parsed = catalogLyricsFromPayload(
      payload,
      match.providerTrackId,
      job.track.source,
    );
    if (
      match.isrc
      && parsed.isrc
      && normalizeIsrc(match.isrc) !== normalizeIsrc(parsed.isrc)
    ) {
      throw new AppleLyricsBackfillError('apple-catalog-isrc-mismatch', {
        retryable: false,
      });
    }

    return {
      ttml: parsed.ttml,
      providerTrackId: parsed.providerTrackId,
      storefront,
      catalogTrack: parsed.catalogTrack,
      fetchedAtMs: Math.max(0, Math.round(this.now())),
      ...(contentType ? { contentType } : {}),
      language: locale,
      timingMode: parsed.timingMode,
      ...(parsed.isrc ?? match.isrc ? { isrc: parsed.isrc ?? match.isrc } : {}),
    };
  }

  private async resolveCatalogMatch(
    job: AppleLyricsBackfillJob,
    storefront: string,
    signal?: AbortSignal,
  ): Promise<AppleMusicCatalogMatch | null> {
    try {
      return signal
        ? await this.catalog.resolveMatch(job.track, storefront, {
          signal,
          exhaustive: true,
        })
        : await this.catalog.resolveMatch(job.track, storefront, {
          exhaustive: true,
        });
    } catch (error) {
      if (signal?.aborted) {
        throw new AppleLyricsBackfillError('apple-request-aborted', { retryable: true });
      }
      throw catalogDependencyError(error);
    }
  }

  private verifyClaimHints(
    job: AppleLyricsBackfillJob,
    match: AppleMusicCatalogMatch,
  ): void {
    if (
      job.providerTrackId !== undefined
      && job.providerTrackId !== match.providerTrackId
    ) {
      throw new AppleLyricsBackfillError('apple-provider-track-id-mismatch', {
        retryable: false,
      });
    }
    if (job.isrc !== undefined) {
      if (!match.isrc) {
        throw new AppleLyricsBackfillError('apple-isrc-insufficient-evidence', {
          retryable: false,
        });
      }
      if (normalizeIsrc(job.isrc) !== normalizeIsrc(match.isrc)) {
        throw new AppleLyricsBackfillError('apple-isrc-mismatch', { retryable: false });
      }
    }
  }

  private async account(
    mediaUserToken: string,
    context: AuthorizedRequestContext,
    signal?: AbortSignal,
  ): Promise<AppleAccountContext> {
    if (signal?.aborted) {
      throw new AppleLyricsBackfillError('apple-request-aborted', { retryable: true });
    }
    if (this.accountContext) return this.accountContext;
    const request = await this.authorizedRequest(
      new URL('/v1/me/storefront', APPLE_MUSIC_AMP_ORIGIN),
      mediaUserToken,
      'en-US',
      context,
      signal,
    );
    this.accountContext = storefrontFromPayload(
      await this.readJson(request, APPLE_ACCOUNT_BODY_LIMIT, signal),
    );
    return this.accountContext;
  }

  private async authorizedRequest(
    url: URL,
    mediaUserToken: string,
    locale: string,
    context: AuthorizedRequestContext,
    signal?: AbortSignal,
  ): Promise<AppleRequestResult> {
    let bearer = await this.bearer(signal);
    let request = await this.request(url, {
      headers: this.authorizedHeaders(bearer, mediaUserToken, locale),
      signal,
    });
    let response = request.response;
    if (
      (response.status === 401 || response.status === 403)
      && !this.settings.webBearerToken
      && !context.refreshedDynamicBearer
    ) {
      context.refreshedDynamicBearer = true;
      this.discoveredBearer = undefined;
      cancelBody(response, new Error('Refreshing rejected Apple bearer'));
      bearer = await this.bearer(signal, true);
      request = await this.request(url, {
        headers: this.authorizedHeaders(bearer, mediaUserToken, locale),
        signal,
      });
      response = request.response;
    }
    if (response.status === 401 || response.status === 403) {
      cancelBody(response, new Error('Apple authentication rejected'));
      throw new AppleLyricsBackfillError('apple-authentication-rejected', {
        retryable: false,
      });
    }
    if (!response.ok) {
      const error = httpError(response, this.now());
      cancelBody(response, error);
      throw error;
    }
    return request;
  }

  private authorizedHeaders(
    bearer: string,
    mediaUserToken: string,
    locale: string,
  ): Headers {
    return new Headers({
      Accept: 'application/json',
      'Accept-Language': `${locale},en;q=0.8`,
      Authorization: `Bearer ${bearer}`,
      Origin: APPLE_MUSIC_WEB_ORIGIN,
      Referer: `${APPLE_MUSIC_WEB_ORIGIN}/`,
      'User-Agent': 'Awesome-Lyrla/0.1 (asynchronous Apple lyrics backfill)',
      'media-user-token': mediaUserToken,
    });
  }

  private async bearer(signal?: AbortSignal, force = false): Promise<string> {
    if (signal?.aborted) {
      throw new AppleLyricsBackfillError('apple-request-aborted', { retryable: true });
    }
    if (this.settings.webBearerToken) {
      return safeSecret(this.settings.webBearerToken, 'apple-web-bearer-invalid');
    }
    if (
      !force
      && this.discoveredBearer
      && this.discoveredBearer.expiresAtMs > this.now() + TOKEN_REFRESH_MARGIN_MS
    ) {
      return this.discoveredBearer.token;
    }
    if (!force && this.bearerDiscoveryInFlight) {
      return (await waitWithSignal(this.bearerDiscoveryInFlight, signal)).token;
    }
    const discovery = this.discoverBearer(signal)
      .then((result) => {
        this.discoveredBearer = result;
        return result;
      })
      .finally(() => {
        if (this.bearerDiscoveryInFlight === discovery) {
          this.bearerDiscoveryInFlight = undefined;
        }
      });
    this.bearerDiscoveryInFlight = discovery;
    return (await discovery).token;
  }

  private async discoverBearer(signal?: AbortSignal): Promise<CachedBearer> {
    const browseRequest = await this.request(new URL(APPLE_MUSIC_BROWSE_URL), {
      signal,
      followPublicRedirects: true,
    });
    const browseResponse = browseRequest.response;
    if (!browseResponse.ok) {
      const error = httpError(browseResponse, this.now());
      cancelBody(browseResponse, error);
      throw error;
    }
    const assets = assetUrlsFromBrowse(
      await this.readText(browseRequest, BROWSE_BODY_LIMIT, signal),
    );
    if (assets.length === 0) {
      throw new AppleLyricsBackfillError('apple-bearer-asset-not-found', {
        retryable: true,
      });
    }

    for (const assetUrl of assets) {
      const assetRequest = await this.request(assetUrl, {
        signal,
        followPublicRedirects: true,
      });
      const assetResponse = assetRequest.response;
      if (!assetResponse.ok) {
        if (assetResponse.status === 429 || assetResponse.status >= 500) {
          const error = httpError(assetResponse, this.now());
          cancelBody(assetResponse, error);
          throw error;
        }
        cancelBody(assetResponse, new Error('Apple bearer asset request rejected'));
        continue;
      }
      const result = await bearerFromAsset(
        await this.readText(assetRequest, ASSET_BODY_LIMIT, signal),
        this.now(),
        signal,
      );
      if (result) return result;
    }
    throw new AppleLyricsBackfillError('apple-web-bearer-not-found', {
      retryable: true,
    });
  }

  private async request(
    url: URL,
    options: {
      headers?: Headers;
      signal?: AbortSignal;
      followPublicRedirects?: boolean;
    },
  ): Promise<AppleRequestResult> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    try {
      let requestUrl = url;
      for (let redirectCount = 0; ; redirectCount += 1) {
        const canFollowPublicRedirect = Boolean(
          options.followPublicRedirects
          && !options.headers,
        );
        const response = await this.fetchImpl(requestUrl, {
          method: 'GET',
          ...(options.headers ? { headers: options.headers } : {}),
          redirect: canFollowPublicRedirect ? 'manual' : 'error',
          signal: requestSignal,
        });
        if (requestSignal.aborted) {
          cancelBody(response, abortReason(requestSignal));
          throw abortReason(requestSignal);
        }
        if (response.status < 300 || response.status >= 400) {
          return { response, signal: requestSignal, timeoutSignal };
        }

        cancelBody(response, new Error('Apple redirect response discarded'));
        if (
          !canFollowPublicRedirect
          || !FOLLOWABLE_REDIRECT_STATUSES.has(response.status)
          || redirectCount >= MAX_PUBLIC_REDIRECTS
        ) {
          throw new AppleLyricsBackfillError('apple-redirect-rejected', {
            retryable: false,
          });
        }
        const location = response.headers.get('location');
        let nextUrl: URL;
        try {
          nextUrl = new URL(location ?? '', requestUrl);
        } catch {
          throw new AppleLyricsBackfillError('apple-redirect-rejected', {
            retryable: false,
          });
        }
        if (
          !location
          || requestUrl.origin !== APPLE_MUSIC_WEB_ORIGIN
          || nextUrl.origin !== APPLE_MUSIC_WEB_ORIGIN
          || nextUrl.protocol !== 'https:'
          || nextUrl.username
          || nextUrl.password
          || nextUrl.hash
        ) {
          throw new AppleLyricsBackfillError('apple-redirect-rejected', {
            retryable: false,
          });
        }
        requestUrl = nextUrl;
      }
    } catch (error) {
      throw appleRequestError(error, options.signal, timeoutSignal);
    }
  }

  private async readText(
    request: AppleRequestResult,
    maxBytes: number,
    callerSignal?: AbortSignal,
  ): Promise<string> {
    try {
      return await readLimitedUtf8(request.response, maxBytes, request.signal);
    } catch (error) {
      throw appleRequestError(error, callerSignal, request.timeoutSignal);
    }
  }

  private async readJson(
    request: AppleRequestResult,
    maxBytes: number,
    callerSignal?: AbortSignal,
  ): Promise<unknown> {
    try {
      return await readLimitedJson(request.response, maxBytes, request.signal);
    } catch (error) {
      throw appleRequestError(error, callerSignal, request.timeoutSignal);
    }
  }
}
