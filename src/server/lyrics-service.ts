import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type {
  LyricsCandidate,
  LyricsCandidateMode,
  LyricsCandidateSet,
  LyricsPayload,
  TrackMetadata,
} from '../shared/contracts.js';
import { parseLrc, plainLyricsToLines } from '../shared/lrc.js';
import {
  metadataVersionMismatch,
  lyricsLookupFingerprint,
  lyricsSearchTitleVariants,
  lyricsWorkFingerprint,
  normalizeMetadata,
  staticLyricsFallbackBaseTitle,
  staticLyricsFallbackVersion,
  trackFingerprint,
} from '../shared/track.js';
import { AppleMusicCatalogService } from './apple-music-catalog.js';
import { config } from './config.js';
import { productionObservability } from './production-observability.js';
import {
  chineseLyricsScript,
  type ChineseLyricsScript,
  isExplicitInstrumentalTitle,
  scriptAwareMetadataSimilarity,
  scriptAwareTrackMatchScore,
  scriptEquivalentMetadata,
  trackScriptVariants,
} from './lyrics-metadata-alias.js';
import {
  displayedLyricsText as lyricsPayloadText,
  isSafeNativeSimplifiedPayload,
  projectAppleLyricsToSimplified,
} from './lyrics-script-preference.js';
import {
  createLyricsRepository,
  LyricsRepository,
  type LyricsLibraryResolveResult,
  PRIMARY_EXACT_REVALIDATE_MS,
  PRIMARY_SELECTED_EXACT_LOOKUP_STRATEGY,
  primaryExactLookupStrategy,
  shadowObservationCutoff,
} from './lyrics-repository.js';
import type {
  CachedWorkLyrics,
  CandidateLyricsOverride,
  StateStore,
} from './store.js';

const lrclibResultSchema = z.object({
  id: z.number().int().nonnegative(),
  trackName: z.string().max(2_048),
  artistName: z.string().max(2_048),
  albumName: z.string().max(2_048).optional().default(''),
  duration: z.number().nonnegative(),
  instrumental: z.boolean().optional().default(false),
  plainLyrics: z.string().max(512_000).nullable().optional(),
  syncedLyrics: z.string().max(512_000).nullable().optional(),
});
const lrclibResultsSchema = z.array(lrclibResultSchema).max(100);

type LrclibResult = z.infer<typeof lrclibResultSchema>;
interface TrackMetadataResolver {
  resolve(track: TrackMetadata): Promise<TrackMetadata | null>;
  isConfigured?(): boolean;
}
type LrclibAttempt =
  | {
      state: 'hit';
      payload: LyricsPayload;
      candidate: LrclibResult;
      retryable?: boolean;
      provisionalInstrumental?: boolean;
    }
  | { state: 'miss' }
  | { state: 'unavailable' }
  | { state: 'canceled' };
type RemoteLyricsHit = Extract<LyricsLibraryResolveResult, { state: 'hit' }>;
interface RankedLrclibCandidate {
  candidate: LrclibResult;
  payload: LyricsPayload;
  script: ChineseLyricsScript;
  score: number;
  reliable: boolean;
}
type LrclibRequestState = 'ok' | 'http-error' | 'timeout' | 'error' | 'canceled';
export interface LrclibTimingOptions {
  requestTimeoutMs?: number;
  lookupBudgetMs?: number;
}
export interface LyricsServiceLimits {
  maxCandidateSelections?: number;
  maxCandidateSelectionBytes?: number;
}
interface CandidateSelection {
  expiresAt: number;
  trackSignature: string;
  candidate: LrclibResult;
  estimatedBytes: number;
}
const POSITIVE_CACHE_MS = 30 * 24 * 60 * 60 * 1_000;
const NEGATIVE_CACHE_MS = 6 * 60 * 60 * 1_000;
const LRCLIB_INSTRUMENTAL_NOTICE = 'LRCLIB 将这首曲目标记为纯音乐。';
const PROVISIONAL_INSTRUMENTAL_NOTICE = 'LRCLIB 标记为纯音乐；未找到更可靠的文本歌词。';
export const LYRICS_LOOKUP_STRATEGY = 'lrclib-multi-v4-simplified-first';
export const LYRICS_EXACT_LOOKUP_STRATEGY = 'lrclib-exact-v1';
const ORIGINAL_VERSION_FALLBACK_NOTICE = '未找到当前版本歌词，当前显示原版静态歌词。';
const WORK_CACHE_FALLBACK_NOTICE = '未找到当前版本歌词，当前显示同一作品的本地静态歌词。';
const SIMPLIFIED_SEARCH_GRACE_MS = 500;
// Bound OpenCC/trigram comparisons even if several LRCLIB strategies each
// return their maximum candidate set.
const SIMPLIFIED_PROMOTION_WINDOW = 20;
const CANDIDATE_SESSION_MS = 10 * 60 * 1_000;
const MAX_CANDIDATE_SELECTIONS = 100;
const MAX_CANDIDATE_SELECTION_BYTES = 32 * 1_024 * 1_024;
const MAX_LRCLIB_RESPONSE_BYTES = 4 * 1_024 * 1_024;
const LRCLIB_SEARCH_CONCURRENCY = 4;

async function runBounded<T>(
  tasks: readonly (() => Promise<T>)[],
  concurrency: number,
): Promise<T[]> {
  if (tasks.length === 0) return [];
  const results = new Array<T>(tasks.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < tasks.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await tasks[index]!();
    }
  };
  const workerCount = Math.min(tasks.length, Math.max(1, Math.trunc(concurrency)));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export interface LyricsFindOptions {
  forceRefresh?: boolean;
  /** Bypass local caches while preserving the complete Primary -> LRCLIB source chain. */
  bypassLocalCache?: boolean;
  /** Restrict provider lookup to LRCLIB /api/get; used for conservative bulk imports. */
  exactOnly?: boolean;
}

class LookupSatisfiedError extends Error {
  override name = 'LookupSatisfiedError';
}

function isLookupSatisfied(value: unknown): boolean {
  return value instanceof LookupSatisfiedError || (
    Boolean(value) &&
    typeof value === 'object' &&
    (value as { name?: unknown }).name === 'LookupSatisfiedError'
  );
}

function isTimeout(value: unknown): boolean {
  return Boolean(value) && typeof value === 'object' && (
    (value as { name?: unknown }).name === 'TimeoutError'
  );
}

function requestState(error: unknown, signal: AbortSignal): LrclibRequestState {
  if (isLookupSatisfied(error) || isLookupSatisfied(signal.reason)) return 'canceled';
  if (isTimeout(error) || (signal.aborted && isTimeout(signal.reason))) return 'timeout';
  if (typeof (error as { status?: unknown })?.status === 'number') return 'http-error';
  return 'error';
}

function missingLyrics(): LyricsPayload {
  return { kind: 'missing', lines: [], provider: null };
}

function resultToPayload(result: LrclibResult): LyricsPayload {
  if (result.instrumental) {
    return {
      kind: 'plain',
      lines: [],
      plainText: '这是一首纯音乐',
      provider: 'lrclib',
      providerId: result.id,
      notice: LRCLIB_INSTRUMENTAL_NOTICE,
    };
  }
  if (result.syncedLyrics) {
    return {
      kind: 'synced',
      lines: parseLrc(result.syncedLyrics).lines,
      provider: 'lrclib',
      providerId: result.id,
    };
  }
  if (result.plainLyrics) {
    return {
      kind: 'plain',
      lines: plainLyricsToLines(result.plainLyrics),
      plainText: result.plainLyrics,
      provider: 'lrclib',
      providerId: result.id,
      notice: '找到了歌词，但没有逐行时间轴。',
    };
  }
  return { kind: 'missing', lines: [], provider: 'lrclib', providerId: result.id };
}

function isUnverifiedInstrumentalResult(track: TrackMetadata, result: LrclibResult): boolean {
  return result.instrumental && !isExplicitInstrumentalTitle(track.title);
}

function isUnverifiedInstrumentalPayload(track: TrackMetadata, payload: LyricsPayload): boolean {
  return payload.provider === 'lrclib'
    && payload.lines.length === 0
    && payload.notice === LRCLIB_INSTRUMENTAL_NOTICE
    && !isExplicitInstrumentalTitle(track.title);
}

function isProvisionalInstrumentalPayload(payload: LyricsPayload): boolean {
  return payload.provider === 'lrclib'
    && payload.lines.length === 0
    && payload.notice === PROVISIONAL_INSTRUMENTAL_NOTICE;
}

function scriptEquivalentWorkSource(
  track: Pick<TrackMetadata, 'title' | 'artist'>,
  source: Pick<TrackMetadata, 'title' | 'artist'>,
): boolean {
  const requestedTitle = staticLyricsFallbackBaseTitle(track.title)
    ?? lyricsSearchTitleVariants(track.title).at(-1)
    ?? track.title;
  const sourceTitle = staticLyricsFallbackBaseTitle(source.title)
    ?? lyricsSearchTitleVariants(source.title).at(-1)
    ?? source.title;
  return !metadataVersionMismatch(requestedTitle, sourceTitle)
    && scriptEquivalentMetadata(requestedTitle, sourceTitle)
    && scriptEquivalentMetadata(track.artist, source.artist);
}

function originalVersionStaticPayload(
  track: TrackMetadata,
  result: LrclibResult,
): LyricsPayload | null {
  const fallbackVersion = staticLyricsFallbackVersion(track.title);
  const baseTitle = staticLyricsFallbackBaseTitle(track.title);
  if (
    !fallbackVersion ||
    !baseTitle ||
    result.instrumental ||
    staticLyricsFallbackVersion(result.trackName) ||
    !scriptEquivalentMetadata(baseTitle, result.trackName) ||
    metadataVersionMismatch(baseTitle, result.trackName) ||
    !normalizeMetadata(track.artist) ||
    !scriptEquivalentMetadata(track.artist, result.artistName)
  ) return null;

  const texts = result.plainLyrics
    ? plainLyricsToLines(result.plainLyrics).map((line) => line.text)
    : result.syncedLyrics
      ? parseLrc(result.syncedLyrics).lines.map((line) => line.text)
      : [];
  const nonEmptyTexts = texts.filter(Boolean);
  if (nonEmptyTexts.length === 0) return null;

  const plainText = nonEmptyTexts.join('\n');
  return {
    kind: 'plain',
    lines: plainLyricsToLines(plainText),
    plainText,
    provider: 'lrclib',
    providerId: result.id,
    notice: fallbackVersion === 'live'
      ? '未找到现场版歌词，当前显示原版静态歌词。'
      : '未找到不插电版歌词，当前显示原版静态歌词。',
    fallbackKind: 'original-version',
  };
}

function isDerivedStaticFallback(payload: LyricsPayload): boolean {
  return Boolean(
    payload.fallbackKind ||
    payload.notice === '未找到现场版歌词，当前显示原版静态歌词。' ||
    payload.notice === '未找到不插电版歌词，当前显示原版静态歌词。',
  );
}

function isSafeSimplifiedVariant(
  track: TrackMetadata,
  incumbentResult: LrclibResult,
  incumbent: LyricsPayload,
  alternativeResult: LrclibResult,
  alternative: LyricsPayload,
): boolean {
  if (
    metadataVersionMismatch(track.title, alternativeResult.trackName)
    || metadataVersionMismatch(incumbentResult.trackName, alternativeResult.trackName)
    || !scriptEquivalentMetadata(incumbentResult.trackName, alternativeResult.trackName)
    || !scriptEquivalentMetadata(incumbentResult.artistName, alternativeResult.artistName)
  ) return false;

  const incumbentDuration = incumbentResult.duration;
  const alternativeDuration = alternativeResult.duration;
  if (incumbentDuration > 0 && alternativeDuration > 0) {
    if (Math.abs(incumbentDuration - alternativeDuration) > 2) return false;
  } else if (
    !incumbentResult.albumName
    || !alternativeResult.albumName
    || !scriptEquivalentMetadata(incumbentResult.albumName, alternativeResult.albumName)
  ) {
    return false;
  }

  return isSafeNativeSimplifiedPayload(
    incumbent,
    alternative,
    track.durationMs > 0
      ? track.durationMs
      : Math.round(alternativeResult.duration * 1_000),
  );
}

function promoteSafeSimplifiedVariants<T extends {
  candidate: LrclibResult;
  payload: LyricsPayload;
  script: ChineseLyricsScript;
}>(
  track: TrackMetadata,
  baseRanked: T[],
): T[] {
  const promoted = baseRanked.slice(0, SIMPLIFIED_PROMOTION_WINDOW);
  for (let index = 0; index < promoted.length; index += 1) {
    const incumbent = promoted[index]!;
    if (incumbent.script !== 'traditional' && incumbent.script !== 'mixed') continue;
    const alternativeIndex = promoted.findIndex((alternative, candidateIndex) =>
      candidateIndex > index
      && alternative.script === 'simplified'
      && isSafeSimplifiedVariant(
        track,
        incumbent.candidate,
        incumbent.payload,
        alternative.candidate,
        alternative.payload,
      ));
    if (alternativeIndex < 0) continue;
    const [alternative] = promoted.splice(alternativeIndex, 1);
    promoted.splice(index, 0, alternative!);
    index += 1;
  }
  return promoted.length === baseRanked.length
    ? promoted
    : [...promoted, ...baseRanked.slice(SIMPLIFIED_PROMOTION_WINDOW)];
}

function candidatePreview(result: LrclibResult): string[] {
  const lines = result.syncedLyrics
    ? parseLrc(result.syncedLyrics).lines
    : result.plainLyrics
      ? plainLyricsToLines(result.plainLyrics)
      : [];
  return lines.map((line) => line.text).filter(Boolean).slice(0, 3);
}

function serviceError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}

function selectedCandidatePayload(
  override: CandidateLyricsOverride | undefined,
): LyricsPayload | null {
  if (!override || override.schemaVersion !== 1) return null;
  if (override.mode === 'synced') {
    if (typeof override.lrc !== 'string' || override.lrc.length > 512_000) return null;
    const lines = parseLrc(override.lrc).lines;
    if (lines.length === 0) return null;
    return {
      kind: 'synced',
      lines,
      provider: 'lrclib',
      providerId: override.candidateId,
      notice: '正在使用你选择的同步歌词。',
    };
  }
  if (
    override.mode !== 'plain' ||
    typeof override.plainText !== 'string' ||
    !override.plainText.trim() ||
    override.plainText.length > 512_000
  ) return null;
  return {
    kind: 'plain',
    lines: plainLyricsToLines(override.plainText),
    plainText: override.plainText,
    provider: 'lrclib',
    providerId: override.candidateId,
    notice: '正在使用你选择的静态歌词。',
  };
}

async function fetchJson(
  url: URL,
  options: {
    timeoutMs: number;
    signal?: AbortSignal;
    observe?: (state: LrclibRequestState, elapsedMs: number) => void;
  },
): Promise<unknown> {
  const startedAt = performance.now();
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  try {
    const response = await fetch(url, {
      redirect: 'error',
      headers: { 'User-Agent': 'Awesome-Lyrla/0.1 (personal Tesla display)' },
      signal,
    });
    if (!response.ok) {
      const error = new Error(`LRCLIB request failed with ${response.status}`);
      Object.assign(error, { status: response.status });
      throw error;
    }
    // Unit tests and injected fetch adapters may provide the older minimal
    // Response-like contract. Native fetch always has Headers/body and therefore
    // always takes the streaming size-limited path below.
    let json: unknown;
    if (!response.headers || typeof response.headers.get !== 'function' || !response.body) {
      json = await response.json();
    } else {
      const declaredLength = Number(response.headers.get('content-length') ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_LRCLIB_RESPONSE_BYTES) {
        throw new Error('LRCLIB response exceeded the size limit');
      }
      const text = await readLimitedResponseText(response, MAX_LRCLIB_RESPONSE_BYTES);
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        throw new Error('LRCLIB returned invalid JSON');
      }
    }
    options.observe?.('ok', performance.now() - startedAt);
    return json;
  } catch (error) {
    options.observe?.(requestState(error, signal), performance.now() - startedAt);
    throw error;
  }
}

async function readLimitedResponseText(response: Response, limit: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error('LRCLIB response exceeded the size limit');
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

export class LyricsService {
  private readonly pendingLookups = new Map<string, Promise<LyricsPayload>>();
  private readonly lookupGenerations = new Map<string, number>();
  private readonly candidateSelections = new Map<string, CandidateSelection>();
  private readonly lrclibRequestTimeoutMs: number;
  private readonly lrclibLookupBudgetMs: number;
  private readonly lrclibLatencySamples: number[] = [];
  private lrclibRequests = 0;
  private lrclibSuccesses = 0;
  private lrclibHttpErrors = 0;
  private lrclibTimeouts = 0;
  private lrclibFailures = 0;
  private lrclibCanceled = 0;
  private lastLrclibState: LrclibRequestState | null = null;
  private candidateSelectionBytes = 0;
  private readonly maxCandidateSelections: number;
  private readonly maxCandidateSelectionBytes: number;
  private readonly repository: LyricsRepository;
  private nextLookupGeneration = 0;

  constructor(
    private readonly store: StateStore,
    private readonly appleMusic: TrackMetadataResolver = new AppleMusicCatalogService(),
    repository?: LyricsRepository,
    timing: LrclibTimingOptions = {},
    limits: LyricsServiceLimits = {},
  ) {
    this.repository = repository ?? createLyricsRepository(store);
    this.lrclibRequestTimeoutMs = Math.max(
      1,
      timing.requestTimeoutMs ?? config.lyrics.lrclibRequestTimeoutMs,
    );
    this.lrclibLookupBudgetMs = Math.max(
      this.lrclibRequestTimeoutMs,
      timing.lookupBudgetMs ?? config.lyrics.lrclibLookupBudgetMs,
    );
    this.maxCandidateSelections = Math.max(
      0,
      Math.trunc(limits.maxCandidateSelections ?? MAX_CANDIDATE_SELECTIONS),
    );
    this.maxCandidateSelectionBytes = Math.max(
      0,
      Math.trunc(limits.maxCandidateSelectionBytes ?? MAX_CANDIDATE_SELECTION_BYTES),
    );
  }

  async find(track: TrackMetadata, options: LyricsFindOptions = {}): Promise<LyricsPayload> {
    const key = trackFingerprint(track);
    const pendingKey = lyricsLookupFingerprint(track);
    const pending = this.pendingLookups.get(pendingKey);
    if (pending) return pending;

    const generation = ++this.nextLookupGeneration;
    const startedAt = performance.now();
    productionObservability.observeLyricsStart();
    this.lookupGenerations.set(key, generation);
    // Capture the cutoff before resolve() can enqueue a shadow write. The
    // comparison RPC then evaluates only candidates that predate this lookup,
    // avoiding tautological agreement with the row we just wrote.
    const observedBefore = this.repository.mode === 'shadow'
      ? shadowObservationCutoff()
      : undefined;
    const resolution = this.resolve(track, key, options, generation);
    if (observedBefore) this.repository.observeRemote(track, resolution, observedBefore);
    // Apply the Apple Simplified presentation policy at the public service
    // boundary as a final guard for payloads already in the compatibility cache.
    // Fresh remote Apple hits are projected earlier, before source selection.
    const lookup = resolution.then(
      (payload) => {
        const projected = projectAppleLyricsToSimplified(payload);
        productionObservability.observeLyricsResult(
          projected,
          performance.now() - startedAt,
        );
        return projected;
      },
      (error: unknown) => {
        productionObservability.observeLyricsFailure(
          error,
          performance.now() - startedAt,
        );
        throw error;
      },
    );
    this.pendingLookups.set(pendingKey, lookup);
    void lookup.finally(() => {
      if (this.pendingLookups.get(pendingKey) === lookup) this.pendingLookups.delete(pendingKey);
      if (this.lookupGenerations.get(key) === generation) this.lookupGenerations.delete(key);
    }).catch(() => undefined);
    return lookup;
  }

  /**
   * Records a stable now-playing observation without coupling Apple
   * supplementation to the foreground lyrics result. The repository enqueue
   * is fire-and-forget and applies the durable exact-key idempotency policy.
   */
  observePlayback(track: TrackMetadata): void {
    this.repository.enqueueAppleBackfill(track);
  }

  cacheStats() {
    const samples = [...this.lrclibLatencySamples].sort((left, right) => left - right);
    const p95Index = Math.max(0, Math.ceil(samples.length * 0.95) - 1);
    return {
      ...this.repository.stats(),
      lrclib: {
        requests: this.lrclibRequests,
        successes: this.lrclibSuccesses,
        httpErrors: this.lrclibHttpErrors,
        timeouts: this.lrclibTimeouts,
        failures: this.lrclibFailures,
        canceled: this.lrclibCanceled,
        p95Ms: samples.length > 0 ? samples[p95Index]! : null,
        lastState: this.lastLrclibState,
      },
    };
  }

  private requestJson(url: URL, signal?: AbortSignal): Promise<unknown> {
    return fetchJson(url, {
      timeoutMs: this.lrclibRequestTimeoutMs,
      signal,
      observe: (state, elapsedMs) => this.observeLrclibRequest(state, elapsedMs),
    });
  }

  private observeLrclibRequest(state: LrclibRequestState, elapsedMs: number): void {
    this.lrclibRequests += 1;
    this.lastLrclibState = state;
    if (state === 'ok') this.lrclibSuccesses += 1;
    else if (state === 'http-error') this.lrclibHttpErrors += 1;
    else if (state === 'timeout') this.lrclibTimeouts += 1;
    else if (state === 'canceled') this.lrclibCanceled += 1;
    else this.lrclibFailures += 1;
    this.lrclibLatencySamples.push(Math.max(0, Math.round(elapsedMs)));
    if (this.lrclibLatencySamples.length > 100) this.lrclibLatencySamples.shift();
  }

  async listCandidates(track: TrackMetadata): Promise<LyricsCandidateSet> {
    const trackSignature = lyricsLookupFingerprint(track);
    const lookupTrack = await this.enrichedTrack(track);
    const lookupTracks = trackScriptVariants(lookupTrack);
    const variants = [...new Set(lookupTracks.flatMap((candidate) =>
      lyricsSearchTitleVariants(candidate.title)))];
    const baseTitles = [...new Set(lookupTracks
      .map((candidate) => staticLyricsFallbackBaseTitle(candidate.title))
      .filter((value): value is string => Boolean(value)))];
    const urls = new Map<string, URL>();
    const addFielded = (title: string, artist?: string) => {
      const url = new URL('https://lrclib.net/api/search');
      url.searchParams.set('track_name', title);
      if (artist && normalizeMetadata(artist)) url.searchParams.set('artist_name', artist);
      urls.set(url.href, url);
    };
    for (const candidate of lookupTracks) {
      for (const title of lyricsSearchTitleVariants(candidate.title)) {
        addFielded(title, candidate.artist);
        addFielded(title);
      }
      const baseTitle = staticLyricsFallbackBaseTitle(candidate.title);
      if (baseTitle) addFielded(baseTitle, candidate.artist);
      const broad = new URL('https://lrclib.net/api/search');
      broad.searchParams.set(
        'q',
        [
          lyricsSearchTitleVariants(candidate.title).at(-1) ?? candidate.title,
          candidate.artist,
          candidate.album,
        ].filter(Boolean).join(' '),
      );
      urls.set(broad.href, broad);
    }

    const budgetSignal = AbortSignal.timeout(this.lrclibLookupBudgetMs);
    let successfulRequests = 0;
    const errors: unknown[] = [];
    const results = await runBounded(
      [...urls.values()].map((url) => async () => {
        try {
          const candidates = lrclibResultsSchema.parse(await this.requestJson(url, budgetSignal));
          successfulRequests += 1;
          return candidates;
        } catch (error) {
          errors.push(error);
          return [];
        }
      }),
      LRCLIB_SEARCH_CONCURRENCY,
    );
    if (successfulRequests === 0) {
      throw serviceError('歌词候选服务暂时不可用，请稍后重试', 503);
    }

    const byId = new Map<number, LrclibResult>();
    for (const candidate of results.flat()) byId.set(candidate.id, candidate);
    const matchingTitles = [...new Set([...variants, ...baseTitles])];
    const hasArtist = Boolean(normalizeMetadata(lookupTrack.artist));
    const baseRanked = [...byId.values()]
      .filter((candidate) =>
        !candidate.instrumental && Boolean(candidate.syncedLyrics || candidate.plainLyrics))
      .map((candidate) => {
        const titleSimilarity = Math.max(...matchingTitles.map((title) =>
          scriptAwareMetadataSimilarity(title, candidate.trackName)));
        const artistSimilarity = hasArtist
          ? scriptAwareMetadataSimilarity(lookupTrack.artist, candidate.artistName)
          : 1;
        const score = Math.max(...matchingTitles.map((title) => scriptAwareTrackMatchScore(
          { ...lookupTrack, title },
          candidate,
        )));
        const payload = resultToPayload(candidate);
        return {
          candidate,
          payload,
          script: chineseLyricsScript(lyricsPayloadText(payload) ?? ''),
          titleSimilarity,
          artistSimilarity,
          score,
        };
      })
      .filter(({ titleSimilarity, artistSimilarity }) =>
        titleSimilarity >= 0.55 && artistSimilarity >= (hasArtist ? 0.55 : 0))
      .sort((left, right) => right.score - left.score);
    const ranked = promoteSafeSimplifiedVariants(lookupTrack, baseRanked).slice(0, 5);
    if (ranked.length === 0 && errors.length > 0) {
      throw serviceError('歌词候选服务部分查询暂时不可用，请稍后重试', 503);
    }

    this.pruneCandidateSelections(Date.now());
    const candidates: LyricsCandidate[] = ranked.map(({ candidate, score }) => {
      let token: string;
      do token = randomBytes(16).toString('base64url');
      while (this.candidateSelections.has(token));
      const estimatedBytes = Buffer.byteLength(token, 'utf8')
        + Buffer.byteLength(trackSignature, 'utf8')
        + Buffer.byteLength(JSON.stringify(candidate), 'utf8');
      const storedSelection: CandidateSelection = {
        expiresAt: Date.now() + CANDIDATE_SESSION_MS,
        trackSignature,
        candidate,
        estimatedBytes,
      };
      this.candidateSelections.set(token, storedSelection);
      this.candidateSelectionBytes += estimatedBytes;
      return {
        token,
        trackName: candidate.trackName,
        artistName: candidate.artistName,
        albumName: candidate.albumName,
        durationMs: Math.max(0, Math.round(candidate.duration * 1_000)),
        hasSyncedLyrics: Boolean(candidate.syncedLyrics && parseLrc(candidate.syncedLyrics).lines.length),
        // A synced LRC can always be deliberately converted to static lyrics.
        hasPlainLyrics: Boolean(candidate.plainLyrics || candidate.syncedLyrics),
        versionMismatch: metadataVersionMismatch(lookupTrack.title, candidate.trackName),
        matchScore: Math.max(0, Math.min(100, Math.round(score * 100))),
        preview: candidatePreview(candidate),
      };
    });
    this.pruneCandidateSelections(Date.now());
    return { candidates };
  }

  async selectCandidate(
    track: TrackMetadata,
    token: string,
    mode: LyricsCandidateMode,
  ): Promise<LyricsPayload> {
    const key = trackFingerprint(track);
    const selection = this.candidateSelections.get(token);
    if (!selection || selection.expiresAt <= Date.now()) {
      this.deleteCandidateSelection(token);
      throw serviceError('候选歌词已过期，请重新搜索', 409);
    }
    if (selection.trackSignature !== lyricsLookupFingerprint(track)) {
      throw serviceError('歌曲信息已经变化，请重新读取候选歌词', 409);
    }
    const candidate = selection.candidate;

    let payload: LyricsPayload;
    let storedOverride: CandidateLyricsOverride;
    if (mode === 'synced') {
      if (!candidate.syncedLyrics) throw serviceError('这个候选没有同步时间轴', 400);
      if (candidate.syncedLyrics.length > 512_000) {
        throw serviceError('这个候选的同步歌词过长，无法保存', 400);
      }
      const lines = parseLrc(candidate.syncedLyrics).lines;
      if (lines.length === 0) throw serviceError('这个候选的时间轴无法识别', 400);
      payload = {
        kind: 'synced',
        lines,
        provider: 'lrclib',
        providerId: candidate.id,
        notice: '正在使用你选择的同步歌词。',
      };
      storedOverride = {
        schemaVersion: 1,
        mode: 'synced',
        candidateId: candidate.id,
        trackName: candidate.trackName,
        artistName: candidate.artistName,
        albumName: candidate.albumName,
        durationMs: Math.max(0, Math.round(candidate.duration * 1_000)),
        lrc: candidate.syncedLyrics,
        updatedAt: Date.now(),
      };
    } else {
      const plainText = candidate.plainLyrics
        || parseLrc(candidate.syncedLyrics ?? '').lines
          .map((line) => line.text)
          .filter(Boolean)
          .join('\n');
      if (!plainText.trim()) throw serviceError('这个候选没有可显示的歌词', 400);
      if (plainText.length > 512_000) {
        throw serviceError('这个候选的静态歌词过长，无法保存', 400);
      }
      payload = {
        kind: 'plain',
        lines: plainLyricsToLines(plainText),
        plainText,
        provider: 'lrclib',
        providerId: candidate.id,
        notice: '正在使用你选择的静态歌词。',
      };
      storedOverride = {
        schemaVersion: 1,
        mode: 'plain',
        candidateId: candidate.id,
        trackName: candidate.trackName,
        artistName: candidate.artistName,
        albumName: candidate.albumName,
        durationMs: Math.max(0, Math.round(candidate.duration * 1_000)),
        plainText,
        updatedAt: Date.now(),
      };
    }
    // Consume the opaque token before the first await so concurrent submissions
    // cannot use it to race two different modes into the same override slot.
    this.deleteCandidateSelection(token);
    this.invalidateLookup(track);
    let selectionVersion = storedOverride.updatedAt;
    await this.store.update((draft) => {
      selectionVersion = Math.max(
        Date.now(),
        (draft.lyricOverrides[key]?.updatedAt ?? -1) + 1,
        (draft.candidateLyricsOverrides[key]?.updatedAt ?? -1) + 1,
      );
      draft.candidateLyricsOverrides[key] = {
        ...storedOverride,
        updatedAt: selectionVersion,
      };
      delete draft.lyricOverrides[key];
      delete draft.lyricsCache[key];
      delete draft.lyricOffsets[key];
    });
    this.repository.evictExactMemory(key);
    this.repository.syncExact(track, {
      payload,
      lookupStrategy: LYRICS_LOOKUP_STRATEGY,
      metadataSignature: lyricsLookupFingerprint(track),
      expiresAt: Date.now() + POSITIVE_CACHE_MS,
    }, { trust: 'active', sourceKind: 'candidate', selectionVersion });
    return payload;
  }

  private invalidateLookup(track: TrackMetadata): void {
    this.lookupGenerations.delete(trackFingerprint(track));
    this.pendingLookups.delete(lyricsLookupFingerprint(track));
  }

  private deleteCandidateSelection(token: string): void {
    const selection = this.candidateSelections.get(token);
    if (!selection) return;
    this.candidateSelections.delete(token);
    this.candidateSelectionBytes = Math.max(
      0,
      this.candidateSelectionBytes - selection.estimatedBytes,
    );
  }

  private pruneCandidateSelections(now: number): void {
    for (const [token, selection] of this.candidateSelections) {
      if (selection.expiresAt <= now) this.deleteCandidateSelection(token);
    }
    while (
      this.candidateSelections.size > this.maxCandidateSelections ||
      this.candidateSelectionBytes > this.maxCandidateSelectionBytes
    ) {
      const oldestToken = this.candidateSelections.keys().next().value as string | undefined;
      if (!oldestToken) break;
      this.deleteCandidateSelection(oldestToken);
    }
  }

  private async resolve(
    track: TrackMetadata,
    key: string,
    options: LyricsFindOptions,
    generation: number,
  ): Promise<LyricsPayload> {
    const persisted = this.repository.readTrack(key);
    const manual = persisted.manual;
    if (manual) {
      const payload: LyricsPayload = {
        kind: 'synced',
        lines: parseLrc(manual.lrc).lines,
        provider: 'manual',
      };
      this.repository.syncExact(track, {
        payload,
        lookupStrategy: 'manual-v1',
        metadataSignature: lyricsLookupFingerprint(track),
        expiresAt: Date.now() + POSITIVE_CACHE_MS,
      }, {
        trust: 'active',
        sourceKind: 'manual',
        selectionVersion: manual.updatedAt,
      });
      return payload;
    }
    const selectedCandidate = selectedCandidatePayload(persisted.candidate);
    if (selectedCandidate) {
      this.repository.syncExact(track, {
        payload: selectedCandidate,
        lookupStrategy: 'candidate-v1',
        metadataSignature: lyricsLookupFingerprint(track),
        expiresAt: Date.now() + POSITIVE_CACHE_MS,
      }, {
        trust: 'active',
        sourceKind: 'candidate',
        selectionVersion: persisted.candidate!.updatedAt,
      });
      return selectedCandidate;
    }

    const cached = persisted.cached;
    const metadataSignature = lyricsLookupFingerprint(track);
    const now = Date.now();
    const expectedPrimaryStrategy = (
      this.repository.mode === 'primary'
      && cached
      && cached.lookupStrategy !== PRIMARY_SELECTED_EXACT_LOOKUP_STRATEGY
    )
      ? primaryExactLookupStrategy(cached.payload)
      : null;
    const shouldRefreshPrimaryPolicyEpoch = Boolean(
      cached
      && expectedPrimaryStrategy
      && (
        cached.lookupStrategy !== expectedPrimaryStrategy
        || !Number.isFinite(cached.revalidateAt)
      ),
    );
    const cacheFreshUntil = cached
      ? Math.min(cached.expiresAt, cached.revalidateAt ?? cached.expiresAt)
      : 0;
    const shouldRefreshLegacyMiss = Boolean(
      cached &&
      cached.payload.kind === 'missing' &&
      cached.lookupStrategy !== LYRICS_LOOKUP_STRATEGY,
    );
    const shouldRefreshMetadata = Boolean(
      cached &&
      cached.metadataSignature !== metadataSignature,
    );
    const shouldRefreshDerivedFallback = Boolean(
      cached &&
      isDerivedStaticFallback(cached.payload) &&
      cached.lookupStrategy !== 'supabase-work-v1',
    );
    const shouldRefreshUnverifiedInstrumental = Boolean(
      cached && isUnverifiedInstrumentalPayload(track, cached.payload),
    );
    const shouldRefreshSimplifiedPolicyEpoch = Boolean(
      cached
      && cached.payload.provider === 'lrclib'
      && cached.lookupStrategy?.startsWith('lrclib-multi-')
      && cached.lookupStrategy !== LYRICS_LOOKUP_STRATEGY
      && ['traditional', 'mixed'].includes(
        chineseLyricsScript(lyricsPayloadText(cached.payload) ?? ''),
      ),
    );
    const bypassLocalCache = Boolean(options.forceRefresh || options.bypassLocalCache);
    if (shouldRefreshUnverifiedInstrumental) this.repository.forgetExact(key);
    if (
      cached &&
      cacheFreshUntil > now &&
      !bypassLocalCache &&
      !shouldRefreshPrimaryPolicyEpoch &&
      !shouldRefreshLegacyMiss &&
      !shouldRefreshMetadata &&
      !shouldRefreshDerivedFallback &&
      !shouldRefreshUnverifiedInstrumental &&
      !shouldRefreshSimplifiedPolicyEpoch
    ) {
      if (cached.payload.kind === 'missing') {
        const workFallback = this.workCacheFallback([track], cached.payload.retryable);
        if (workFallback) return workFallback;
      } else {
        this.rememberCachedOriginalWorkLyrics(track, cached.payload);
      }
      return cached.payload;
    }
    if (
      cached &&
      cacheFreshUntil <= now &&
      cached.payload.kind !== 'missing' &&
      cached.payload.kind !== 'loading' &&
      cached.metadataSignature === metadataSignature &&
      !bypassLocalCache &&
      !shouldRefreshPrimaryPolicyEpoch &&
      !shouldRefreshDerivedFallback &&
      !shouldRefreshUnverifiedInstrumental &&
      !shouldRefreshSimplifiedPolicyEpoch
    ) {
      return {
        ...cached.payload,
        retryable: true,
        notice: cached.payload.notice ?? '正在显示本地缓存，稍后会在后台更新。',
      };
    }

    let remoteLibraryAvailable = this.repository.mode === 'primary';
    let remoteExactFallback: RemoteLyricsHit | null = null;
    if (this.repository.mode === 'primary' && !options.forceRefresh) {
      // Preserve the existing rule that a real Live/Acoustic match wins over
      // same-work static lyrics. The work binding is queried only after LRCLIB
      // has had a chance to find the requested recording.
      const remote = await this.repository.resolveRemote(track, false);
      const isSynchronizedAppleDurationAlias = remote.state === 'hit'
        && remote.matchKind === 'work'
        && remote.providerRoute === 'apple-duration-alias-synced-v1'
        && remote.payload.kind === 'synced';
      if (
        remote.state === 'hit'
        && (remote.matchKind === 'exact' || isSynchronizedAppleDurationAlias)
      ) {
        const remotePayload = projectAppleLyricsToSimplified(remote.payload);
        const humanSelection = remote.selectionMethod === 'manual'
          || remote.selectionMethod === 'candidate';
        const remoteScript = chineseLyricsScript(lyricsPayloadText(remotePayload) ?? '');
        if (
          humanSelection
          || (remoteScript !== 'traditional' && remoteScript !== 'mixed')
        ) {
          this.repository.rememberRemoteHit(
            track,
            key,
            remotePayload,
            remote.matchKind,
            remote.selectionMethod,
          );
          return remotePayload;
        }
        remoteExactFallback = { ...remote, payload: remotePayload };
      }
      remoteLibraryAvailable = remote.state !== 'unavailable';
    }

    const lookupBudgetSignal = AbortSignal.timeout(
      remoteExactFallback
        ? Math.min(this.lrclibLookupBudgetMs, SIMPLIFIED_SEARCH_GRACE_MS)
        : this.lrclibLookupBudgetMs,
    );
    let payload: LyricsPayload | undefined;
    let fallbackPayload: LyricsPayload | undefined;
    let providerLookupFailed = false;
    let lookupTrack = normalizeMetadata(track.artist)
      ? track
      : await this.enrichedTrack(track, lookupBudgetSignal);
    const applyAttempt = (attempt: LrclibAttempt): boolean => {
      if (attempt.state === 'unavailable') providerLookupFailed = true;
      if (attempt.state !== 'hit') return false;
      if (attempt.retryable) providerLookupFailed = true;
      if (attempt.payload.fallbackKind === 'original-version') {
        fallbackPayload ??= attempt.payload;
        return false;
      }
      payload = attempt.payload;
      return true;
    };

    const lookupProvider = async (candidate: TrackMetadata): Promise<LrclibAttempt> => {
      const attempt = options.exactOnly
        ? await this.exact(candidate, lookupBudgetSignal)
        : await this.lookupLrclib(candidate, lookupBudgetSignal);
      // exactOnly is used by conservative versioned-recording preloads. An
      // unverified instrumental is useful foreground fallback evidence, but
      // must not be counted as a successful exact lyrics import.
      return options.exactOnly
        && attempt.state === 'hit'
        && attempt.provisionalInstrumental
        ? { state: 'miss' }
        : attempt;
    };
    let resolved = applyAttempt(await lookupProvider(lookupTrack));
    if (!resolved && lookupTrack === track) {
      const enriched = await this.enrichedTrack(track, lookupBudgetSignal);
      if (enriched !== track) {
        lookupTrack = enriched;
        resolved = applyAttempt(await lookupProvider(lookupTrack));
      }
    } else if (!resolved && lookupTrack !== track) {
      // Apple metadata may be less useful than the raw telemetry. Reuse the
      // same outer budget when falling back so enrichment cannot reset it.
      resolved = applyAttempt(await lookupProvider(track));
    }
    payload ??= fallbackPayload ?? {
      ...missingLyrics(),
      notice: 'LRCLIB 暂时没有可靠匹配，可在设置页粘贴自己的 LRC。',
    };

    if (
      remoteExactFallback
      && !isSafeNativeSimplifiedPayload(
        remoteExactFallback.payload,
        payload,
        track.durationMs,
      )
    ) {
      this.repository.rememberRemoteHit(
        track,
        key,
        remoteExactFallback.payload,
        remoteExactFallback.matchKind,
        remoteExactFallback.selectionMethod,
      );
      return remoteExactFallback.payload;
    }

    if (
      shouldRefreshSimplifiedPolicyEpoch
      && cached
      && cached.payload.kind !== 'missing'
      && cached.payload.kind !== 'loading'
      && (
        payload.kind === 'missing'
        || Boolean(payload.fallbackKind)
        || isProvisionalInstrumentalPayload(payload)
      )
    ) {
      payload = {
        ...cached.payload,
        notice: cached.payload.notice ?? '未找到更可靠的简体版本，继续显示原缓存歌词。',
        ...(providerLookupFailed || payload.retryable ? { retryable: true } : {}),
      };
    }

    if (payload.fallbackKind === 'original-version' && providerLookupFailed) {
      payload = { ...payload, retryable: true };
    }

    if (payload.kind === 'missing' && providerLookupFailed) {
      payload = {
        ...payload,
        retryable: true,
        notice: '歌词服务部分查询暂时不可用，稍后会自动重试。',
      };
    }

    let responsePayload = payload;
    let cachePayload = payload;
    if (payload.fallbackKind === 'original-version') {
      cachePayload = {
        kind: 'missing',
        lines: [],
        provider: null,
        notice: ORIGINAL_VERSION_FALLBACK_NOTICE,
        ...(payload.retryable ? { retryable: true } : {}),
      };
    }
    if (
      cachePayload.kind === 'missing' &&
      this.repository.mode === 'primary' &&
      !remoteLibraryAvailable
    ) {
      // A definitive LRCLIB miss is not definitive for the combined lookup
      // while the primary library is unavailable. Keep it retryable and out
      // of both L1 and the compatibility cache so the next playback can retry
      // Supabase instead of being pinned to a false negative.
      cachePayload = { ...cachePayload, retryable: true };
      if (responsePayload.kind === 'missing') responsePayload = cachePayload;
    }
    if (cachePayload.kind === 'missing' && payload.fallbackKind !== 'original-version') {
      let workFallback = this.workCacheFallback(
        lookupTrack === track ? [track] : [lookupTrack, track],
        cachePayload.retryable,
      );
      if (
        !workFallback &&
        remoteLibraryAvailable &&
        this.repository.mode === 'primary'
      ) {
        const remoteWork = await this.repository.resolveRemote(track, true);
        if (remoteWork.state === 'hit' && remoteWork.matchKind === 'exact') {
          const remotePayload = projectAppleLyricsToSimplified(remoteWork.payload);
          this.repository.rememberRemoteHit(
            track,
            key,
            remotePayload,
            remoteWork.matchKind,
            remoteWork.selectionMethod,
          );
          return remotePayload;
        }
        if (
          remoteWork.state === 'hit'
          && remoteWork.matchKind === 'work'
          && (
            Boolean(staticLyricsFallbackVersion(track.title))
            || remoteWork.providerRoute === 'apple-duration-alias-synced-v1'
            || remoteWork.providerRoute === 'apple-duration-alias-static-v1'
          )
        ) {
          const remotePayload = projectAppleLyricsToSimplified(remoteWork.payload);
          workFallback = {
            ...remotePayload,
            ...(cachePayload.retryable ? { retryable: true } : {}),
          };
          this.repository.rememberRemoteHit(
            track,
            key,
            workFallback,
            remoteWork.matchKind,
            remoteWork.selectionMethod,
          );
        } else if (remoteWork.state === 'unavailable') {
          remoteLibraryAvailable = false;
          cachePayload = { ...cachePayload, retryable: true };
          if (responsePayload.kind === 'missing') responsePayload = cachePayload;
        }
      }
      if (workFallback) responsePayload = workFallback;
    }

    // Apple supplementation is a durable, best-effort background job. A new
    // enqueue must remain retryable in the foreground so the Player can
    // re-query after the worker has written the library row. The negative
    // cache still uses the enqueue refresh window, so this does not create an
    // unbounded request loop.
    const appleBackfillRefreshMs = cachePayload.kind === 'missing' && !cachePayload.retryable
      ? this.repository.enqueueAppleBackfill(track)
      : null;
    if (
      appleBackfillRefreshMs !== null
      && (responsePayload.kind === 'missing' || responsePayload.fallbackKind !== undefined)
    ) {
      responsePayload = {
        ...responsePayload,
        retryable: true,
        notice: responsePayload.notice ?? '正在等待歌词补充，稍后自动重试。',
      };
    }

    // Temporary service failures should not become durable "no lyrics" results.
    if (cachePayload.retryable) {
      if (this.lookupGenerations.get(key) !== generation) return responsePayload;
      if (cached?.payload.kind === 'missing') {
        this.repository.forgetExact(key);
      }
      return responsePayload;
    }

    // JsonStore applies the in-memory update synchronously. Do not hold the
    // player response behind serialization and an atomic disk rename. A newer
    // metadata lookup for the same track owns the cache slot.
    if (this.lookupGenerations.get(key) !== generation) return responsePayload;
    const cachedAt = Date.now();
    const primaryStrategy = this.repository.mode === 'primary'
      ? primaryExactLookupStrategy(cachePayload)
      : null;
    this.repository.rememberExact(track, key, {
      payload: cachePayload,
      lookupStrategy: primaryStrategy ?? LYRICS_LOOKUP_STRATEGY,
      metadataSignature,
      expiresAt: cachedAt + (
        cachePayload.kind === 'missing'
          ? (
              appleBackfillRefreshMs ?? NEGATIVE_CACHE_MS
            )
          : isProvisionalInstrumentalPayload(cachePayload)
            ? NEGATIVE_CACHE_MS
          : POSITIVE_CACHE_MS
      ),
      ...(primaryStrategy
        ? { revalidateAt: cachedAt + PRIMARY_EXACT_REVALIDATE_MS }
        : {}),
    });
    return responsePayload;
  }

  private workCacheFallback(
    tracks: TrackMetadata[],
    retryable?: boolean,
  ): LyricsPayload | null {
    for (const track of tracks) {
      if (!staticLyricsFallbackVersion(track.title)) continue;
      const key = lyricsWorkFingerprint(track);
      if (!key) continue;
      const cached: CachedWorkLyrics | undefined = this.repository.readWork(key);
      if (
        !cached ||
        cached.schemaVersion !== 1 ||
        !cached.plainText.trim() ||
        !Number.isFinite(cached.expiresAt) ||
        cached.expiresAt <= Date.now() ||
        !scriptEquivalentWorkSource(track, {
          title: cached.sourceTitle,
          artist: cached.sourceArtist,
        })
      ) continue;
      return {
        kind: 'plain',
        lines: plainLyricsToLines(cached.plainText),
        plainText: cached.plainText,
        provider: cached.provider,
        providerId: cached.providerId,
        notice: WORK_CACHE_FALLBACK_NOTICE,
        retryable,
        fallbackKind: 'work-cache',
      };
    }
    return null;
  }

  private rememberOriginalWorkLyrics(
    track: TrackMetadata,
    result: LrclibResult,
    payload: LyricsPayload,
  ): void {
    if (
      result.instrumental ||
      metadataVersionMismatch('', result.trackName) ||
      !scriptEquivalentMetadata(track.artist, result.artistName)
    ) return;
    const requestedKey = lyricsWorkFingerprint(track);
    const sourceTrack = {
      title: result.trackName,
      artist: result.artistName,
    };
    const plainText = lyricsPayloadText(payload);
    if (!requestedKey || !scriptEquivalentWorkSource(track, sourceTrack) || !plainText) return;
    const now = Date.now();
    this.repository.rememberWork(requestedKey, {
      schemaVersion: 1,
      plainText,
      provider: 'lrclib',
      providerId: result.id,
      sourceTitle: result.trackName,
      sourceArtist: result.artistName,
      storedAt: now,
      expiresAt: now + POSITIVE_CACHE_MS,
    });
  }

  private rememberCachedOriginalWorkLyrics(
    track: TrackMetadata,
    payload: LyricsPayload,
  ): void {
    if (
      payload.provider !== 'lrclib' ||
      isDerivedStaticFallback(payload) ||
      metadataVersionMismatch('', track.title)
    ) return;
    const key = lyricsWorkFingerprint(track);
    const plainText = lyricsPayloadText(payload);
    if (!key || !plainText) return;
    const existing = this.repository.readWork(key);
    if (
      existing?.schemaVersion === 1 &&
      existing.plainText.trim() &&
      existing.expiresAt > Date.now()
    ) return;
    const now = Date.now();
    this.repository.rememberWork(key, {
      schemaVersion: 1,
      plainText,
      provider: 'lrclib',
      providerId: payload.providerId,
      sourceTitle: track.title,
      sourceArtist: track.artist,
      storedAt: now,
      expiresAt: now + POSITIVE_CACHE_MS,
    });
  }

  private async lookupLrclib(
    track: TrackMetadata,
    outerSignal: AbortSignal,
  ): Promise<LrclibAttempt> {
    const searchController = new AbortController();
    const searchSignal = AbortSignal.any([outerSignal, searchController.signal]);
    const exactPromise = this.exact(track, outerSignal);
    const searchPromise = this.search(track, searchSignal).catch((error: unknown) => {
      if (isLookupSatisfied(error) || isLookupSatisfied(searchSignal.reason)) {
        return { state: 'canceled' } as LrclibAttempt;
      }
      console.error('LRCLIB search failed unexpectedly:', error);
      return { state: 'unavailable' } as LrclibAttempt;
    });

    // Search begins immediately. A Simplified or neutral exact hit remains
    // authoritative; a Traditional or mixed hit gets a short, bounded chance
    // to use a verified native Simplified transcription of the same recording.
    const exactAttempt = await exactPromise;
    if (exactAttempt.state === 'hit' && !exactAttempt.provisionalInstrumental) {
      const exactScript = chineseLyricsScript(
        lyricsPayloadText(exactAttempt.payload) ?? '',
      );
      if (exactScript !== 'traditional' && exactScript !== 'mixed') {
        searchController.abort(new LookupSatisfiedError('Exact lyrics resolved'));
        void searchPromise.then(() => undefined, () => undefined);
        this.rememberOriginalWorkLyrics(track, exactAttempt.candidate, exactAttempt.payload);
        return exactAttempt;
      }

      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const searchWithinGrace = await Promise.race([
        searchPromise.then((attempt) => ({ completed: true as const, attempt })),
        new Promise<{ completed: false }>((resolve) => {
          graceTimer = setTimeout(
            () => resolve({ completed: false }),
            SIMPLIFIED_SEARCH_GRACE_MS,
          );
        }),
      ]).finally(() => {
        if (graceTimer) clearTimeout(graceTimer);
      });
      if (!searchWithinGrace.completed) {
        searchController.abort(new LookupSatisfiedError('Simplified search grace elapsed'));
        void searchPromise.then(() => undefined, () => undefined);
      } else if (
        searchWithinGrace.attempt.state === 'hit'
        && isSafeSimplifiedVariant(
          track,
          exactAttempt.candidate,
          exactAttempt.payload,
          searchWithinGrace.attempt.candidate,
          searchWithinGrace.attempt.payload,
        )
      ) {
        this.rememberOriginalWorkLyrics(
          track,
          searchWithinGrace.attempt.candidate,
          searchWithinGrace.attempt.payload,
        );
        return searchWithinGrace.attempt;
      }
      this.rememberOriginalWorkLyrics(track, exactAttempt.candidate, exactAttempt.payload);
      return exactAttempt;
    }

    const searchAttempt = await searchPromise;
    if (searchAttempt.state === 'hit') {
      this.rememberOriginalWorkLyrics(track, searchAttempt.candidate, searchAttempt.payload);
      // A same-work static fallback is only definitive after exact has also
      // confirmed that the requested recording is absent. If exact timed out
      // or failed, show the useful fallback but keep the lookup retryable and
      // out of the negative cache.
      if (
        searchAttempt.payload.fallbackKind === 'original-version' &&
        exactAttempt.state !== 'miss'
      ) {
        return { ...searchAttempt, retryable: true };
      }
      return searchAttempt;
    }
    if (exactAttempt.state === 'hit' && exactAttempt.provisionalInstrumental) {
      return searchAttempt.state === 'miss'
        ? exactAttempt
        : {
            ...exactAttempt,
            payload: { ...exactAttempt.payload, retryable: true },
            retryable: true,
          };
    }
    if (exactAttempt.state === 'miss' && searchAttempt.state === 'miss') {
      return { state: 'miss' };
    }
    return { state: 'unavailable' };
  }

  private async exact(track: TrackMetadata, signal: AbortSignal): Promise<LrclibAttempt> {
    if (!normalizeMetadata(track.artist)) return { state: 'miss' };
    const exactUrl = new URL('https://lrclib.net/api/get');
    exactUrl.searchParams.set('track_name', track.title);
    exactUrl.searchParams.set('artist_name', track.artist);
    if (track.album) exactUrl.searchParams.set('album_name', track.album);
    if (track.durationMs > 0) {
      exactUrl.searchParams.set('duration', String(Math.round(track.durationMs / 1_000)));
    }
    try {
      const exact = lrclibResultSchema.parse(await this.requestJson(exactUrl, signal));
      if (metadataVersionMismatch(track.title, exact.trackName)) return { state: 'miss' };
      if (isUnverifiedInstrumentalResult(track, exact)) {
        return {
          state: 'hit',
          payload: {
            ...resultToPayload(exact),
            notice: PROVISIONAL_INSTRUMENTAL_NOTICE,
          },
          candidate: exact,
          provisionalInstrumental: true,
        };
      }
      const payload = resultToPayload(exact);
      return payload.kind === 'missing'
        || (!isExplicitInstrumentalTitle(track.title) && payload.lines.length === 0)
        ? { state: 'miss' }
        : { state: 'hit', payload, candidate: exact };
    } catch (error) {
      if (isLookupSatisfied(error) || isLookupSatisfied(signal.reason)) {
        return { state: 'canceled' };
      }
      if ((error as { status?: number }).status === 404) return { state: 'miss' };
      console.warn(
        'LRCLIB exact lookup failed, trying search:',
        error instanceof Error ? error.name : 'unknown_error',
      );
      return { state: 'unavailable' };
    }
  }

  private async enrichedTrack(
    track: TrackMetadata,
    lookupSignal?: AbortSignal,
  ): Promise<TrackMetadata> {
    if (lookupSignal?.aborted) return track;
    try {
      const resolution = this.appleMusic.resolve(track);
      let removeAbortListener: () => void = () => undefined;
      const enrichment = lookupSignal
        ? Promise.race([
          resolution,
          new Promise<null>((resolve) => {
            if (lookupSignal.aborted) {
              resolve(null);
              return;
            }
            const onAbort = () => resolve(null);
            lookupSignal.addEventListener('abort', onAbort, { once: true });
            removeAbortListener = () => lookupSignal.removeEventListener('abort', onAbort);
          }),
        ])
        : resolution;
      const enriched = await enrichment.finally(removeAbortListener);
      if (
        !enriched ||
        (
          enriched.title === track.title &&
          enriched.artist === track.artist &&
          enriched.album === track.album &&
          enriched.durationMs === track.durationMs
        )
      ) return track;
      return enriched;
    } catch (error) {
      console.warn(
        'Apple Music metadata enrichment skipped:',
        error instanceof Error ? error.message : 'unknown_error',
      );
      return track;
    }
  }

  private async search(track: TrackMetadata, signal: AbortSignal): Promise<LrclibAttempt> {
    const hasArtist = Boolean(normalizeMetadata(track.artist));
    const scriptTracks = trackScriptVariants(track);
    const titleVariants = [...new Set(scriptTracks.flatMap((candidate) =>
      lyricsSearchTitleVariants(candidate.title)))];
    const matchingTitles = [...new Set([
      ...titleVariants,
      ...scriptTracks.map((candidate) =>
        staticLyricsFallbackBaseTitle(candidate.title) ?? ''),
    ].filter(Boolean))];
    const candidatesById = new Map<number, LrclibResult>();
    const payloadsById = new Map<number, LyricsPayload>();
    const requestedUrls = new Set<string>();
    const errors: unknown[] = [];
    let candidateVersion = 0;
    let rankedVersion = -1;
    let rankedCache: RankedLrclibCandidate[] = [];

    const fieldedUrl = (title: string, artist?: string): URL => {
      const url = new URL('https://lrclib.net/api/search');
      url.searchParams.set('track_name', title);
      if (artist && normalizeMetadata(artist)) url.searchParams.set('artist_name', artist);
      return url;
    };
    const broadUrl = (title: string, identity: TrackMetadata = track): URL => {
      const url = new URL('https://lrclib.net/api/search');
      url.searchParams.set(
        'q',
        [title, identity.artist, identity.album].filter(Boolean).join(' '),
      );
      return url;
    };
    const request = async (url: URL): Promise<void> => {
      const key = url.href;
      if (requestedUrls.has(key)) return;
      requestedUrls.add(key);
      if (signal.aborted) {
        if (!isLookupSatisfied(signal.reason)) errors.push(signal.reason);
        return;
      }
      try {
        const candidates = lrclibResultsSchema.parse(await this.requestJson(url, signal));
        for (const candidate of candidates) {
          if (candidatesById.has(candidate.id)) continue;
          candidatesById.set(candidate.id, candidate);
          candidateVersion += 1;
        }
      } catch (error) {
        if (!isLookupSatisfied(error) && !isLookupSatisfied(signal.reason)) {
          errors.push(error);
        }
      }
    };
    const payloadFor = (candidate: LrclibResult): LyricsPayload => {
      const cached = payloadsById.get(candidate.id);
      if (cached) return cached;
      const payload = resultToPayload(candidate);
      payloadsById.set(candidate.id, payload);
      return payload;
    };
    const rankedCandidates = (): RankedLrclibCandidate[] => {
      if (rankedVersion === candidateVersion) return rankedCache;
      rankedCache = [...candidatesById.values()].map((candidate) => {
        const titleSimilarity = Math.max(...matchingTitles.map((title) =>
          scriptAwareMetadataSimilarity(title, candidate.trackName)));
        const artistSimilarity = hasArtist
          ? scriptAwareMetadataSimilarity(track.artist, candidate.artistName)
          : 0;
        const albumSimilarity = track.album && candidate.albumName
          ? scriptAwareMetadataSimilarity(track.album, candidate.albumName)
          : 0;
        const durationDifference = track.durationMs > 0
          ? Math.abs(track.durationMs / 1_000 - candidate.duration)
          : Number.POSITIVE_INFINITY;
        const hasSecondaryEvidence = durationDifference <= 12 || albumSimilarity >= 0.75;
        const payload = payloadFor(candidate);
        return {
          candidate,
          payload,
          script: chineseLyricsScript(lyricsPayloadText(payload) ?? ''),
          score: Math.max(...matchingTitles.map((title) => scriptAwareTrackMatchScore(
            { ...track, title },
            candidate,
          ))),
          reliable:
            !isUnverifiedInstrumentalResult(track, candidate) &&
            titleSimilarity >= (hasArtist ? 0.82 : 0.88) &&
            (!hasArtist || artistSimilarity >= 0.8) &&
            !metadataVersionMismatch(track.title, candidate.trackName) &&
            (hasArtist || hasSecondaryEvidence),
        };
      })
      .sort((left, right) => right.score - left.score);
      rankedVersion = candidateVersion;
      return rankedCache;
    };
    const reliablePayload = (): { candidate: LrclibResult; payload: LyricsPayload } | null => {
      const eligible = rankedCandidates().filter(({ reliable, score, payload }) =>
        reliable &&
        score >= (hasArtist ? 0.72 : 0.82) &&
        payload.kind !== 'missing' &&
        (
          isExplicitInstrumentalTitle(track.title)
          || payload.lines.length > 0
        ));
      const best = promoteSafeSimplifiedVariants(track, eligible)[0];
      return best ? { candidate: best.candidate, payload: best.payload } : null;
    };
    const returnReliable = (): LrclibAttempt | null => {
      const best = reliablePayload();
      if (!best) return null;
      return { state: 'hit', payload: best.payload, candidate: best.candidate };
    };
    const returnStaticFallback = (retryable = false): LrclibAttempt | null => {
      for (const { candidate } of promoteSafeSimplifiedVariants(
        track,
        rankedCandidates(),
      )) {
        const payload = originalVersionStaticPayload(track, candidate);
        if (!payload) continue;
        return {
          state: 'hit',
          payload,
          candidate,
          ...(retryable ? { retryable: true } : {}),
        };
      }
      return null;
    };
    const stopped = (): LrclibAttempt | null => {
      if (!signal.aborted) return null;
      if (isLookupSatisfied(signal.reason)) return { state: 'canceled' };
      return returnStaticFallback(true) ?? { state: 'unavailable' };
    };

    const fallbackBaseTitle = staticLyricsFallbackBaseTitle(track.title);
    await runBounded([
      () => request(fieldedUrl(track.title, hasArtist ? track.artist : undefined)),
      ...(fallbackBaseTitle
        ? [() => request(fieldedUrl(fallbackBaseTitle, hasArtist ? track.artist : undefined))]
        : []),
    ], LRCLIB_SEARCH_CONCURRENCY);
    const primary = returnReliable();
    const primaryScript = primary?.state === 'hit'
      ? chineseLyricsScript(lyricsPayloadText(primary.payload) ?? '')
      : null;
    if (
      primary?.state === 'hit'
      && primaryScript !== 'traditional'
      && primaryScript !== 'mixed'
    ) return primary;
    const primaryStopped = stopped();
    if (primaryStopped) {
      return primary?.state === 'hit'
        ? {
            ...primary,
            payload: { ...primary.payload, retryable: true },
            retryable: true,
          }
        : primaryStopped;
    }

    const cleanedTitle = titleVariants.at(-1) ?? track.title;
    await runBounded([
      ...scriptTracks.slice(1).flatMap((identity) => {
        const titles = lyricsSearchTitleVariants(identity.title);
        const cleaned = titles.at(-1) ?? identity.title;
        const baseTitle = staticLyricsFallbackBaseTitle(identity.title);
        return [
          () => request(fieldedUrl(identity.title, hasArtist ? identity.artist : undefined)),
          ...(baseTitle
            ? [() => request(fieldedUrl(baseTitle, hasArtist ? identity.artist : undefined))]
            : []),
          () => request(broadUrl(cleaned, identity)),
        ];
      }),
      ...titleVariants.slice(1, 3).map((title) =>
        () => request(fieldedUrl(title, hasArtist ? track.artist : undefined))),
      () => request(broadUrl(cleanedTitle)),
    ], LRCLIB_SEARCH_CONCURRENCY);
    const expanded = returnReliable();
    const expandedStopped = stopped();
    if (expanded?.state === 'hit') {
      return expandedStopped
        ? {
            ...expanded,
            payload: { ...expanded.payload, retryable: true },
            retryable: true,
          }
        : expanded;
    }
    if (expandedStopped) return expandedStopped;

    await runBounded([
      () => request(fieldedUrl(track.title)),
      () => request(fieldedUrl(cleanedTitle)),
    ], LRCLIB_SEARCH_CONCURRENCY);
    const titleOnly = returnReliable();
    const titleOnlyStopped = stopped();
    if (titleOnly?.state === 'hit') {
      return titleOnlyStopped
        ? {
            ...titleOnly,
            payload: { ...titleOnly.payload, retryable: true },
            retryable: true,
          }
        : titleOnly;
    }
    const staticFallback = returnStaticFallback(errors.length > 0);
    if (staticFallback) return staticFallback;
    const finalStopped = titleOnlyStopped ?? stopped();
    if (finalStopped) return finalStopped;

    if (errors.length > 0) {
      console.error('LRCLIB search strategies failed:', errors[0]);
      return { state: 'unavailable' };
    }
    return { state: 'miss' };
  }

  async setOffset(track: TrackMetadata, offsetMs: number): Promise<void> {
    const key = trackFingerprint(track);
    await this.store.update((draft) => {
      draft.lyricOffsets[key] = Math.max(-5_000, Math.min(5_000, Math.round(offsetMs / 100) * 100));
    });
  }

  getOffset(track: TrackMetadata): number {
    return this.store.readLyricOffset(trackFingerprint(track));
  }

  async setManualLrc(track: TrackMetadata, lrc: string): Promise<LyricsPayload> {
    const parsed = parseLrc(lrc);
    if (parsed.lines.length === 0) throw new Error('LRC 中没有可识别的时间标签');
    const key = trackFingerprint(track);
    this.invalidateLookup(track);
    let selectionVersion = Date.now();
    await this.store.update((draft) => {
      selectionVersion = Math.max(
        Date.now(),
        (draft.lyricOverrides[key]?.updatedAt ?? -1) + 1,
        (draft.candidateLyricsOverrides[key]?.updatedAt ?? -1) + 1,
      );
      draft.lyricOverrides[key] = { lrc, updatedAt: selectionVersion };
      delete draft.candidateLyricsOverrides[key];
      delete draft.lyricsCache[key];
    });
    const payload: LyricsPayload = { kind: 'synced', lines: parsed.lines, provider: 'manual' };
    this.repository.evictExactMemory(key);
    this.repository.syncExact(track, {
      payload,
      lookupStrategy: 'manual-v1',
      metadataSignature: lyricsLookupFingerprint(track),
      expiresAt: Date.now() + POSITIVE_CACHE_MS,
    }, { trust: 'active', sourceKind: 'manual', selectionVersion });
    return payload;
  }
}
