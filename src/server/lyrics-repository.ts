import { createHash } from 'node:crypto';
import type { LyricsPayload, TrackMetadata } from '../shared/contracts.js';
import {
  lyricsLookupFingerprint,
  lyricsWorkFingerprint,
  metadataVersionMismatch,
} from '../shared/track.js';
import { BoundedLruCache, defaultByteEstimator } from './bounded-lru.js';
import { config, type SupabaseLyricsMode } from './config.js';
import { isExplicitInstrumentalTitle } from './lyrics-metadata-alias.js';
import { SupabaseLyricsClient } from './supabase-lyrics-client.js';
import type {
  CachedLyrics,
  CachedWorkLyrics,
  StateStore,
  LyricsStoreEntries,
} from './store.js';

export const LYRICS_FINGERPRINT_VERSION = 1;
export const PRIMARY_APPLE_EXACT_LOOKUP_STRATEGY = 'supabase-primary-apple-exact-v1';
export const PRIMARY_LRCLIB_EXACT_LOOKUP_STRATEGY = 'supabase-primary-lrclib-exact-v1';
export const PRIMARY_SELECTED_EXACT_LOOKUP_STRATEGY = 'supabase-selected-exact-v1';
export const PRIMARY_EXACT_REVALIDATE_MS = 5 * 60 * 1_000;
const REMOTE_WORK_CACHE_MS = 5 * 60 * 1_000;
const REMOTE_EXACT_CACHE_MS = 30 * 24 * 60 * 60 * 1_000;
const SHADOW_OBSERVATION_SAFETY_MS = 5_000;

const LYRICS_LIBRARY_UNAVAILABLE_REASONS = [
  'disabled',
  'timeout',
  'auth',
  'network',
  'invalid-response',
  'server',
] as const;
const LYRICS_LIBRARY_WRITE_FAILURE_REASONS = [
  ...LYRICS_LIBRARY_UNAVAILABLE_REASONS,
  'unknown',
] as const;

export type LyricsLibraryUnavailableReason =
  typeof LYRICS_LIBRARY_UNAVAILABLE_REASONS[number];
export type LyricsLibraryWriteFailureReason =
  typeof LYRICS_LIBRARY_WRITE_FAILURE_REASONS[number];
export type LyricsLibrarySelectionMethod =
  | 'provider'
  | 'manual'
  | 'candidate'
  | 'legacy_import';

type MemoryLyricsEntry =
  | { kind: 'exact'; value: CachedLyrics }
  | { kind: 'work'; value: CachedWorkLyrics };

export interface LyricsLibraryResolveInput {
  track: TrackMetadata;
  exactKey: string;
  workKey: string | null;
  keyVersion: number;
  allowWorkFallback: boolean;
}

export type LyricsLibraryResolveResult =
  | {
    state: 'hit';
    matchKind: 'exact' | 'work';
    payload: LyricsPayload;
    documentId: string;
    selectionMethod?: LyricsLibrarySelectionMethod;
    /** Identifies special serving routes such as the duration alias. */
    providerRoute?: string;
  }
  | { state: 'miss' }
  | { state: 'ambiguous'; candidateCount: number }
  | { state: 'unavailable'; reason: LyricsLibraryUnavailableReason };

export interface LyricsLibraryQuarantineCompareInput {
  track: TrackMetadata;
  exactKey: string;
  workKey: string | null;
  keyVersion: number;
  observedBefore: string;
  expectedExact?: LyricsPayload;
  expectedWork?: LyricsPayload;
}

export interface LyricsLibraryQuarantineCompareKindResult {
  candidateCount: number;
  comparisons: number;
  agreements: number;
  disagreements: number;
}

export type LyricsLibraryQuarantineCompareResult =
  | {
      state: 'ok';
      exact: LyricsLibraryQuarantineCompareKindResult;
      work: LyricsLibraryQuarantineCompareKindResult;
    }
  | { state: 'unavailable'; reason: LyricsLibraryUnavailableReason };

interface LyricsLibraryExactWriteBase {
  track: TrackMetadata;
  exactKey: string;
  keyVersion: number;
  cached: CachedLyrics;
}

export type LyricsLibraryExactWriteIntent =
  | { trust: 'active'; sourceKind: 'automatic'; selectionVersion?: never }
  | {
      trust: 'active';
      sourceKind: 'manual' | 'candidate';
      /** Monotonic version of the persisted local user selection. */
      selectionVersion: number;
    };

export type LyricsLibraryExactWrite = LyricsLibraryExactWriteBase & LyricsLibraryExactWriteIntent;

export interface LyricsLibraryWorkWrite {
  workKey: string;
  keyVersion: number;
  cached: CachedWorkLyrics;
}

export interface LyricsLibraryAppleBackfillEnqueue {
  exactKey: string;
  keyVersion: number;
  storefront: string;
  locale: string;
  track: TrackMetadata;
  priority?: number;
  maxAttempts?: number;
}

export type LyricsLibraryAppleBackfillStatus =
  | 'pending'
  | 'processing'
  | 'retry_wait'
  | 'completed'
  | 'dead_letter'
  | 'cancelled';

export interface LyricsLibraryAppleBackfillEnqueueResult {
  status: LyricsLibraryAppleBackfillStatus;
}

function isTerminalAppleBackfillStatus(
  status: LyricsLibraryAppleBackfillStatus,
): boolean {
  return status === 'completed' || status === 'dead_letter' || status === 'cancelled';
}

export interface LyricsLibraryClient {
  resolve(input: LyricsLibraryResolveInput): Promise<LyricsLibraryResolveResult>;
  compareQuarantined(
    input: LyricsLibraryQuarantineCompareInput,
  ): Promise<LyricsLibraryQuarantineCompareResult>;
  upsertExact(input: LyricsLibraryExactWrite): Promise<void>;
  upsertWork(input: LyricsLibraryWorkWrite): Promise<void>;
  enqueueAppleLyricsBackfill?(
    input: LyricsLibraryAppleBackfillEnqueue,
  ): Promise<LyricsLibraryAppleBackfillEnqueueResult | void>;
}

export interface LyricsRepositoryOptions {
  mode: SupabaseLyricsMode;
  memoryMaxEntries: number;
  memoryMaxBytes: number;
  legacyMaxEntries: number;
  legacyMaxBytes: number;
  remote?: LyricsLibraryClient;
  appleBackfill?: {
    enabled: boolean;
    storefront: string;
    locale: string;
    maxAttempts: number;
  };
}

export interface LyricsRepositoryStats {
  entries: number;
  estimatedBytes: number;
  mode: SupabaseLyricsMode;
  remoteRequests: number;
  remoteHits: number;
  remoteMisses: number;
  remoteAmbiguous: number;
  remoteUnavailable: number;
  remoteUnavailableByReason: Record<LyricsLibraryUnavailableReason, number>;
  remoteP95Ms: number | null;
  cacheReads: {
    exactMemoryHits: number;
    exactPersistentHits: number;
    exactMisses: number;
    workMemoryHits: number;
    workPersistentHits: number;
    workMisses: number;
  };
  lastRemoteState: LyricsLibraryResolveResult['state'] | null;
  lastRemoteReason: Extract<
    LyricsLibraryResolveResult,
    { state: 'unavailable' }
  >['reason'] | null;
  shadowComparisons: number;
  shadowAgreements: number;
  shadowDisagreements: number;
  remoteWrites: Record<'exact' | 'work', LyricsRepositoryWriteStats>;
  quarantineComparisons: Record<'exact' | 'work', LyricsRepositoryQuarantineStats>;
  appleBackfill: {
    enabled: boolean;
    pending: number;
    attempts: number;
    successes: number;
    failures: number;
  };
}

export interface LyricsRepositoryWriteStats {
  attempts: number;
  successes: number;
  failures: number;
  failureByReason: Record<LyricsLibraryWriteFailureReason, number>;
}

export interface LyricsRepositoryQuarantineStats {
  requests: number;
  candidates: number;
  comparisons: number;
  agreements: number;
  disagreements: number;
  unavailable: number;
  unavailableByReason: Record<LyricsLibraryUnavailableReason, number>;
}

function memoryKey(kind: MemoryLyricsEntry['kind'], key: string): string {
  return `${kind}:${key}`;
}

function cacheEstimate(value: MemoryLyricsEntry, key: string): number {
  return defaultByteEstimator(value) + new TextEncoder().encode(key).byteLength;
}

function unavailableReasonCounts(): Record<LyricsLibraryUnavailableReason, number> {
  return Object.fromEntries(
    LYRICS_LIBRARY_UNAVAILABLE_REASONS.map((reason) => [reason, 0]),
  ) as Record<LyricsLibraryUnavailableReason, number>;
}

function writeFailureReasonCounts(): Record<LyricsLibraryWriteFailureReason, number> {
  return Object.fromEntries(
    LYRICS_LIBRARY_WRITE_FAILURE_REASONS.map((reason) => [reason, 0]),
  ) as Record<LyricsLibraryWriteFailureReason, number>;
}

function writeStats(): LyricsRepositoryWriteStats {
  return {
    attempts: 0,
    successes: 0,
    failures: 0,
    failureByReason: writeFailureReasonCounts(),
  };
}

function quarantineStats(): LyricsRepositoryQuarantineStats {
  return {
    requests: 0,
    candidates: 0,
    comparisons: 0,
    agreements: 0,
    disagreements: 0,
    unavailable: 0,
    unavailableByReason: unavailableReasonCounts(),
  };
}

function cloneWriteStats(stats: LyricsRepositoryWriteStats): LyricsRepositoryWriteStats {
  return {
    ...stats,
    failureByReason: { ...stats.failureByReason },
  };
}

function cloneQuarantineStats(
  stats: LyricsRepositoryQuarantineStats,
): LyricsRepositoryQuarantineStats {
  return {
    ...stats,
    unavailableByReason: { ...stats.unavailableByReason },
  };
}

const APPLE_BACKFILL_RADIO_DURATION_MS = 18_000_000;
const APPLE_BACKFILL_MAX_DURATION_MS = 24 * 60 * 60 * 1_000;

/**
 * Read-through lyrics repository.
 *
 * The in-process LRU is always the serving L1. The local compatibility cache
 * is retained in a bounded sidecar file in off/shadow modes, while a
 * configured remote library is observed in shadow mode and becomes the
 * cold-read source in primary mode.
 */
export class LyricsRepository {
  private readonly memory: BoundedLruCache<string, MemoryLyricsEntry>;
  private readonly shadowObservations = new Map<string, Promise<LyricsLibraryResolveResult>>();
  private readonly shadowQuarantineObservations = new Map<string, Promise<void>>();
  private readonly pendingAppleBackfillEnqueues = new Set<string>();
  private readonly appleBackfillQueueStates = new Map<string, {
    status: LyricsLibraryAppleBackfillStatus;
    nextProbeAtMs: number;
  }>();
  private readonly remoteLatencySamples: number[] = [];
  private exactMemoryHits = 0;
  private exactPersistentHits = 0;
  private exactMisses = 0;
  private workMemoryHits = 0;
  private workPersistentHits = 0;
  private workMisses = 0;
  private remoteRequests = 0;
  private remoteHits = 0;
  private remoteMisses = 0;
  private remoteAmbiguous = 0;
  private remoteUnavailable = 0;
  private readonly remoteUnavailableByReason = unavailableReasonCounts();
  private lastRemoteState: LyricsLibraryResolveResult['state'] | null = null;
  private lastRemoteReason: Extract<
    LyricsLibraryResolveResult,
    { state: 'unavailable' }
  >['reason'] | null = null;
  private shadowComparisons = 0;
  private shadowAgreements = 0;
  private shadowDisagreements = 0;
  private readonly remoteWrites = {
    exact: writeStats(),
    work: writeStats(),
  } satisfies Record<'exact' | 'work', LyricsRepositoryWriteStats>;
  private readonly quarantineComparisons = {
    exact: quarantineStats(),
    work: quarantineStats(),
  } satisfies Record<'exact' | 'work', LyricsRepositoryQuarantineStats>;
  private appleBackfillAttempts = 0;
  private appleBackfillSuccesses = 0;
  private appleBackfillFailures = 0;

  constructor(
    private readonly store: StateStore,
    private readonly options: LyricsRepositoryOptions = {
      mode: config.supabase.lyricsMode,
      memoryMaxEntries: config.lyrics.memoryCacheMaxEntries,
      memoryMaxBytes: config.lyrics.memoryCacheMaxBytes,
      legacyMaxEntries: config.lyrics.legacyCacheMaxEntries,
      legacyMaxBytes: config.lyrics.legacyCacheMaxBytes,
    },
  ) {
    this.memory = new BoundedLruCache({
      maxEntries: options.memoryMaxEntries,
      maxBytes: options.memoryMaxBytes,
      estimateBytes: cacheEstimate,
    });
  }

  get mode(): SupabaseLyricsMode {
    return this.options.mode;
  }

  stats(): LyricsRepositoryStats {
    const sortedLatencies = [...this.remoteLatencySamples].sort((left, right) => left - right);
    const p95Index = Math.max(0, Math.ceil(sortedLatencies.length * 0.95) - 1);
    return {
      entries: this.memory.size,
      estimatedBytes: this.memory.estimatedBytes,
      mode: this.options.mode,
      remoteRequests: this.remoteRequests,
      remoteHits: this.remoteHits,
      remoteMisses: this.remoteMisses,
      remoteAmbiguous: this.remoteAmbiguous,
      remoteUnavailable: this.remoteUnavailable,
      remoteUnavailableByReason: { ...this.remoteUnavailableByReason },
      remoteP95Ms: sortedLatencies.length > 0 ? sortedLatencies[p95Index]! : null,
      cacheReads: {
        exactMemoryHits: this.exactMemoryHits,
        exactPersistentHits: this.exactPersistentHits,
        exactMisses: this.exactMisses,
        workMemoryHits: this.workMemoryHits,
        workPersistentHits: this.workPersistentHits,
        workMisses: this.workMisses,
      },
      lastRemoteState: this.lastRemoteState,
      lastRemoteReason: this.lastRemoteReason,
      shadowComparisons: this.shadowComparisons,
      shadowAgreements: this.shadowAgreements,
      shadowDisagreements: this.shadowDisagreements,
      remoteWrites: {
        exact: cloneWriteStats(this.remoteWrites.exact),
        work: cloneWriteStats(this.remoteWrites.work),
      },
      quarantineComparisons: {
        exact: cloneQuarantineStats(this.quarantineComparisons.exact),
        work: cloneQuarantineStats(this.quarantineComparisons.work),
      },
      appleBackfill: {
        enabled: Boolean(
          this.options.appleBackfill?.enabled
          && this.options.remote?.enqueueAppleLyricsBackfill,
        ),
        pending: this.pendingAppleBackfillEnqueues.size,
        attempts: this.appleBackfillAttempts,
        successes: this.appleBackfillSuccesses,
        failures: this.appleBackfillFailures,
      },
    };
  }

  enqueueAppleBackfill(track: TrackMetadata): number | null {
    const settings = this.options.appleBackfill;
    const enqueue = this.options.remote?.enqueueAppleLyricsBackfill?.bind(this.options.remote);
    if (!settings?.enabled || !enqueue) return null;
    const exactKey = lyricsLookupFingerprint(track);
    if (
      !exactKey
      || !track.title.trim()
      || !track.artist.trim()
      || !Number.isFinite(track.durationMs)
      || track.durationMs <= 0
      || track.durationMs > APPLE_BACKFILL_MAX_DURATION_MS
      || track.durationMs === APPLE_BACKFILL_RADIO_DURATION_MS
    ) return null;
    if (this.pendingAppleBackfillEnqueues.has(exactKey)) return 30_000;

    const known = this.appleBackfillQueueStates.get(exactKey);
    if (known && isTerminalAppleBackfillStatus(known.status)) {
      // Completed/quarantined rows may later be promoted by an operator. Poll
      // the read path occasionally, but never rewrite the terminal queue row.
      return 5 * 60_000;
    }
    const now = Date.now();
    if (known && known.nextProbeAtMs > now) {
      return Math.max(30_000, known.nextProbeAtMs - now);
    }

    this.pendingAppleBackfillEnqueues.add(exactKey);
    this.appleBackfillAttempts += 1;
    void enqueue({
      exactKey,
      keyVersion: LYRICS_FINGERPRINT_VERSION,
      storefront: settings.storefront,
      locale: settings.locale,
      track: structuredClone(track),
      maxAttempts: settings.maxAttempts,
    }).then((result) => {
      this.appleBackfillSuccesses += 1;
      if (result) {
        this.rememberAppleBackfillState(exactKey, result.status);
      }
    }).catch((error: unknown) => {
      this.appleBackfillFailures += 1;
      console.warn('Apple lyrics backfill enqueue failed:', safeErrorName(error));
    }).finally(() => {
      this.pendingAppleBackfillEnqueues.delete(exactKey);
    });
    return 30_000;
  }

  private rememberAppleBackfillState(
    exactKey: string,
    status: LyricsLibraryAppleBackfillStatus,
  ): void {
    this.appleBackfillQueueStates.delete(exactKey);
    this.appleBackfillQueueStates.set(exactKey, {
      status,
      nextProbeAtMs: Date.now() + 5 * 60_000,
    });
    while (this.appleBackfillQueueStates.size > 2_000) {
      const oldest = this.appleBackfillQueueStates.keys().next().value;
      if (oldest === undefined) break;
      this.appleBackfillQueueStates.delete(oldest);
    }
  }

  readTrack(key: string): LyricsStoreEntries {
    const persisted = this.store.readLyricsEntries(key);
    const memory = this.memory.get(memoryKey('exact', key));
    if (memory?.kind === 'exact') {
      this.exactMemoryHits += 1;
      return { ...persisted, cached: structuredClone(memory.value) };
    }
    if (persisted.cached) {
      this.exactPersistentHits += 1;
      this.memory.set(memoryKey('exact', key), {
        kind: 'exact',
        value: structuredClone(persisted.cached),
      });
    }
    else this.exactMisses += 1;
    return persisted;
  }

  readWork(key: string): CachedWorkLyrics | undefined {
    const memory = this.memory.get(memoryKey('work', key));
    if (memory?.kind === 'work') {
      this.workMemoryHits += 1;
      return structuredClone(memory.value);
    }
    const persisted = this.store.readWorkLyrics(key);
    if (persisted) {
      this.workPersistentHits += 1;
      this.memory.set(memoryKey('work', key), {
        kind: 'work',
        value: structuredClone(persisted),
      });
    }
    else this.workMisses += 1;
    return persisted;
  }

  async resolveRemote(
    track: TrackMetadata,
    allowWorkFallback: boolean,
  ): Promise<LyricsLibraryResolveResult> {
    if (!this.options.remote) return { state: 'unavailable', reason: 'disabled' };
    const startedAt = performance.now();
    let result: LyricsLibraryResolveResult;
    try {
      result = await this.options.remote.resolve({
        track,
        exactKey: lyricsLookupFingerprint(track),
        workKey: lyricsWorkFingerprint(track),
        keyVersion: LYRICS_FINGERPRINT_VERSION,
        allowWorkFallback,
      });
    } catch (error: unknown) {
      result = { state: 'unavailable', reason: unavailableReason(error) };
    }
    this.recordRemoteResult(result, performance.now() - startedAt);
    return result;
  }

  observeRemote(
    track: TrackMetadata,
    expected?: LyricsPayload | Promise<LyricsPayload>,
    observedBefore = shadowObservationCutoff(),
  ): void {
    if (this.options.mode !== 'shadow' || !this.options.remote) return;
    const key = lyricsLookupFingerprint(track);
    let observation = this.shadowObservations.get(key);
    if (!observation) {
      observation = this.resolveRemote(track, false).finally(() => {
        if (this.shadowObservations.get(key) === observation) {
          this.shadowObservations.delete(key);
        }
      });
      this.shadowObservations.set(key, observation);
    }
    const expectedPayload: Promise<LyricsPayload | undefined> = expected === undefined
      ? Promise.resolve<LyricsPayload | undefined>(undefined)
      : Promise.resolve(expected).catch(() => undefined);
    if (expected !== undefined) {
      void Promise.all([observation, expectedPayload]).then(([remote, served]) => {
        if (remote.state !== 'hit' || !served) return;
        this.shadowComparisons += 1;
        if (comparablePayload(remote.payload) === comparablePayload(served)) {
          this.shadowAgreements += 1;
        } else {
          this.shadowDisagreements += 1;
        }
      }).catch(() => undefined);
    }
    if (expected === undefined) return;
    void expectedPayload.then((served) => {
      if (served?.kind !== 'synced' && served?.kind !== 'plain') return;
      const comparisonKey = shadowComparisonKey(key, served);
      let comparison = this.shadowQuarantineObservations.get(comparisonKey);
      if (!comparison) {
        comparison = this.observeQuarantined(track, served, observedBefore).finally(() => {
          if (this.shadowQuarantineObservations.get(comparisonKey) === comparison) {
            this.shadowQuarantineObservations.delete(comparisonKey);
          }
        });
        this.shadowQuarantineObservations.set(comparisonKey, comparison);
      }
      return comparison;
    }).catch(() => undefined);
  }

  private async observeQuarantined(
    track: TrackMetadata,
    served: LyricsPayload,
    observedBefore: string,
  ): Promise<void> {
    if (this.options.mode !== 'shadow' || !this.options.remote) return;
    const exactKey = lyricsLookupFingerprint(track);
    const workKey = lyricsWorkFingerprint(track);
    this.quarantineComparisons.exact.requests += 1;
    if (workKey) this.quarantineComparisons.work.requests += 1;

    const comparable = served;
    const workFallback = Boolean(comparable?.fallbackKind);
    const originalLrclibWork = Boolean(
      comparable?.provider === 'lrclib' &&
      !metadataVersionMismatch('', track.title),
    );
    let result: LyricsLibraryQuarantineCompareResult;
    try {
      result = await this.options.remote.compareQuarantined({
        track,
        exactKey,
        workKey,
        keyVersion: LYRICS_FINGERPRINT_VERSION,
        observedBefore,
        ...(
          comparable && !workFallback
            ? { expectedExact: structuredClone(comparable) }
            : {}
        ),
        ...(
          comparable && workKey && (workFallback || originalLrclibWork)
            ? { expectedWork: structuredClone(comparable) }
            : {}
        ),
      });
    } catch (error) {
      result = { state: 'unavailable', reason: unavailableReason(error) };
    }

    if (result.state === 'unavailable') {
      this.recordQuarantineUnavailable('exact', result.reason);
      if (workKey) this.recordQuarantineUnavailable('work', result.reason);
      return;
    }
    this.recordQuarantineResult('exact', result.exact);
    if (workKey) this.recordQuarantineResult('work', result.work);
  }

  private recordQuarantineUnavailable(
    kind: 'exact' | 'work',
    reason: LyricsLibraryUnavailableReason,
  ): void {
    const stats = this.quarantineComparisons[kind];
    stats.unavailable += 1;
    stats.unavailableByReason[reason] += 1;
  }

  private recordQuarantineResult(
    kind: 'exact' | 'work',
    result: LyricsLibraryQuarantineCompareKindResult,
  ): void {
    const stats = this.quarantineComparisons[kind];
    const candidates = metricCount(result.candidateCount);
    const comparisons = metricCount(result.comparisons);
    const agreements = metricCount(result.agreements);
    const disagreements = metricCount(result.disagreements);
    stats.candidates += candidates;
    stats.comparisons += comparisons;
    stats.agreements += agreements;
    stats.disagreements += disagreements;
  }

  private recordRemoteResult(result: LyricsLibraryResolveResult, latencyMs: number): void {
    this.remoteRequests += 1;
    this.lastRemoteState = result.state;
    this.lastRemoteReason = result.state === 'unavailable' ? result.reason : null;
    if (result.state === 'hit') this.remoteHits += 1;
    else if (result.state === 'miss') this.remoteMisses += 1;
    else if (result.state === 'ambiguous') this.remoteAmbiguous += 1;
    else {
      this.remoteUnavailable += 1;
      this.remoteUnavailableByReason[result.reason] += 1;
    }
    this.remoteLatencySamples.push(Math.max(0, Math.round(latencyMs)));
    if (this.remoteLatencySamples.length > 100) this.remoteLatencySamples.shift();
  }

  rememberExact(
    track: TrackMetadata,
    key: string,
    cached: CachedLyrics,
    write: LyricsLibraryExactWriteIntent = {
      trust: 'active',
      sourceKind: 'automatic',
    },
  ): void {
    const existing = this.readTrack(key).cached;
    if (cached.payload.kind === 'missing' && existing && existing.payload.kind !== 'missing') return;

    this.memory.set(memoryKey('exact', key), {
      kind: 'exact',
      value: structuredClone(cached),
    });

    if (this.options.mode !== 'primary') {
      void this.store.updateCachedLyrics(key, (current) => (
        cached.payload.kind === 'missing' && current && current.payload.kind !== 'missing'
          ? current
          : cached
      ), this.options.legacyMaxEntries, this.options.legacyMaxBytes).catch((error: unknown) => {
        console.error('Lyrics compatibility cache persistence failed:', safeErrorName(error));
      });
    }

    this.syncExact(track, cached, write);
  }

  rememberRemoteHit(
    track: TrackMetadata,
    key: string,
    payload: LyricsPayload,
    matchKind: 'exact' | 'work',
    selectionMethod?: LyricsLibrarySelectionMethod,
  ): void {
    const now = Date.now();
    const selectedExact = matchKind === 'exact' && (
      selectionMethod === 'manual' || selectionMethod === 'candidate'
    );
    const primaryStrategy = matchKind === 'exact' && !selectedExact
      ? primaryExactLookupStrategy(payload)
      : null;
    const revalidateAt = primaryStrategy
      ? now + PRIMARY_EXACT_REVALIDATE_MS
      : undefined;
    this.memory.set(memoryKey('exact', key), {
      kind: 'exact',
      value: {
        payload: structuredClone(payload),
        lookupStrategy: matchKind === 'work'
          ? 'supabase-work-v1'
          : selectedExact
            ? PRIMARY_SELECTED_EXACT_LOOKUP_STRATEGY
            : primaryStrategy ?? 'supabase-v1',
        metadataSignature: lyricsLookupFingerprint(track),
        expiresAt: now + (
          matchKind === 'work'
            ? REMOTE_WORK_CACHE_MS
            : primaryStrategy === PRIMARY_APPLE_EXACT_LOOKUP_STRATEGY
              ? PRIMARY_EXACT_REVALIDATE_MS
              : REMOTE_EXACT_CACHE_MS
        ),
        ...(revalidateAt === undefined ? {} : { revalidateAt }),
      },
    });
  }

  syncExact(
    track: TrackMetadata,
    cached: CachedLyrics,
    write: LyricsLibraryExactWriteIntent,
  ): void {
    if (
      this.options.mode === 'off' ||
      !this.options.remote ||
      cached.payload.kind === 'missing' ||
      cached.payload.kind === 'loading' ||
      cached.payload.fallbackKind !== undefined ||
      (
        write.sourceKind === 'automatic' &&
        cached.payload.provider === 'lrclib' &&
        cached.payload.lines.length === 0 &&
        cached.payload.plainText?.trim() === '这是一首纯音乐' &&
        !isExplicitInstrumentalTitle(track.title)
      )
    ) return;
    const stats = this.remoteWrites.exact;
    stats.attempts += 1;
    void this.options.remote.upsertExact({
      track,
      exactKey: lyricsLookupFingerprint(track),
      keyVersion: LYRICS_FINGERPRINT_VERSION,
      cached: structuredClone(cached),
      ...write,
    }).then(() => {
      stats.successes += 1;
    }).catch((error: unknown) => {
      stats.failures += 1;
      stats.failureByReason[writeFailureReason(error)] += 1;
      console.warn('Supabase lyrics shadow write failed:', safeErrorName(error));
    });
  }

  evictExactMemory(key: string): void {
    this.memory.delete(memoryKey('exact', key));
  }

  forgetExact(key: string): void {
    this.evictExactMemory(key);
    void this.store.updateCachedLyrics(
      key,
      () => undefined,
      this.options.legacyMaxEntries,
      this.options.legacyMaxBytes,
    ).catch((error: unknown) => {
      console.error('Lyrics cache cleanup failed:', safeErrorName(error));
    });
  }

  rememberWork(key: string, cached: CachedWorkLyrics): void {
    this.memory.set(memoryKey('work', key), {
      kind: 'work',
      value: structuredClone(cached),
    });
    if (this.options.mode !== 'primary') {
      void this.store.updateWorkLyrics(
        key,
        cached,
        this.options.legacyMaxEntries,
        this.options.legacyMaxBytes,
      ).catch((error: unknown) => {
        console.error('Work lyrics compatibility cache persistence failed:', safeErrorName(error));
      });
    }
    if (this.options.mode !== 'off' && this.options.remote) {
      const stats = this.remoteWrites.work;
      stats.attempts += 1;
      void this.options.remote.upsertWork({
        workKey: key,
        keyVersion: LYRICS_FINGERPRINT_VERSION,
        cached: structuredClone(cached),
      }).then(() => {
        stats.successes += 1;
      }).catch((error: unknown) => {
        stats.failures += 1;
        stats.failureByReason[writeFailureReason(error)] += 1;
        console.warn('Supabase work lyrics shadow write failed:', safeErrorName(error));
      });
    }
  }

}

export function createLyricsRepository(store: StateStore): LyricsRepository {
  const remote = config.supabase.lyricsMode === 'off'
    ? undefined
    : new SupabaseLyricsClient({
      url: config.supabase.url,
      secretKey: config.supabase.secretKey,
      libraryId: config.supabase.libraryId,
      timeoutMs: lyricsLibraryRequestTimeout(
        config.supabase.lyricsMode,
        config.supabase.requestTimeoutMs,
        config.supabase.shadowRequestTimeoutMs,
      ),
      writeTimeoutMs: config.supabase.writeTimeoutMs,
    });
  return new LyricsRepository(store, {
    mode: config.supabase.lyricsMode,
    memoryMaxEntries: config.lyrics.memoryCacheMaxEntries,
    memoryMaxBytes: config.lyrics.memoryCacheMaxBytes,
    legacyMaxEntries: config.lyrics.legacyCacheMaxEntries,
    legacyMaxBytes: config.lyrics.legacyCacheMaxBytes,
    remote,
    appleBackfill: {
      enabled: config.appleLyrics.enabled,
      storefront: config.appleMusic.storefront,
      locale: config.appleLyrics.locale,
      maxAttempts: config.appleLyrics.maxAttempts,
    },
  });
}

export function shadowObservationCutoff(now = Date.now()): string {
  return new Date(now - SHADOW_OBSERVATION_SAFETY_MS).toISOString();
}

export function lyricsLibraryRequestTimeout(
  mode: SupabaseLyricsMode,
  primaryTimeoutMs: number,
  shadowTimeoutMs: number,
): number {
  return mode === 'shadow' ? shadowTimeoutMs : primaryTimeoutMs;
}

export function primaryExactLookupStrategy(payload: LyricsPayload): string | null {
  if (
    payload.fallbackKind !== undefined
    || (payload.kind !== 'synced' && payload.kind !== 'plain')
  ) return null;
  if (payload.provider === 'apple') return PRIMARY_APPLE_EXACT_LOOKUP_STRATEGY;
  if (payload.provider === 'lrclib') return PRIMARY_LRCLIB_EXACT_LOOKUP_STRATEGY;
  return null;
}

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown_error';
}

function metricCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function isUnavailableReason(value: unknown): value is LyricsLibraryUnavailableReason {
  return typeof value === 'string' && (
    LYRICS_LIBRARY_UNAVAILABLE_REASONS as readonly string[]
  ).includes(value);
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (
    error.name === 'AbortError' ||
    error.name === 'TimeoutError' ||
    /timeout/i.test(error.message)
  );
}

function unavailableReason(error: unknown): LyricsLibraryUnavailableReason {
  const reason = typeof error === 'object' && error !== null
    ? (error as { reason?: unknown }).reason
    : undefined;
  if (isUnavailableReason(reason)) return reason;
  if (isTimeoutError(error)) return 'timeout';
  return 'network';
}

function writeFailureReason(error: unknown): LyricsLibraryWriteFailureReason {
  const reason = typeof error === 'object' && error !== null
    ? (error as { reason?: unknown }).reason
    : undefined;
  if (isUnavailableReason(reason)) return reason;
  if (isTimeoutError(error)) return 'timeout';
  if (error instanceof TypeError) return 'network';
  return 'unknown';
}

function comparablePayload(payload: LyricsPayload): string {
  return JSON.stringify({
    kind: payload.kind,
    fallbackKind: payload.fallbackKind ?? null,
    plainText: payload.plainText ?? null,
    lines: payload.lines.map((line) => ({ startMs: line.startMs, text: line.text })),
  });
}

function shadowComparisonKey(exactKey: string, payload: LyricsPayload): string {
  const contentHash = createHash('sha256').update(comparablePayload(payload)).digest('hex');
  return `${exactKey}:${contentHash}`;
}
