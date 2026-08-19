import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ArtworkLookupFailureReason,
  ArtworkLookupStage,
  ArtworkPalette,
  LyricsPayload,
} from '../shared/contracts.js';
import { config } from './config.js';

export interface StoredTokenEnvelope {
  ciphertext: string;
  iv: string;
  authTag: string;
}

export interface CachedLyrics {
  payload: LyricsPayload;
  expiresAt: number;
  /**
   * Optional source-policy refresh deadline. The cached content remains usable
   * until `expiresAt`, while primary mode can revalidate which remote provider
   * should win on a shorter cadence.
   */
  revalidateAt?: number;
  lookupStrategy?: string;
  metadataSignature?: string;
}

export interface CachedWorkLyrics {
  schemaVersion: 1;
  plainText: string;
  provider: 'lrclib';
  providerId?: number;
  sourceTitle: string;
  sourceArtist: string;
  storedAt: number;
  expiresAt: number;
}

export type CachedArtworkFailureReason = Extract<
  ArtworkLookupFailureReason,
  | 'catalog-empty'
  | 'catalog-missing-artwork'
  | 'catalog-version-mismatch'
  | 'catalog-album-mismatch'
  | 'catalog-low-confidence'
  | 'no-reliable-match'
  | 'ambiguous-candidate'
>;

export interface CachedArtworkPalette {
  palette: ArtworkPalette | null;
  expiresAt: number;
  lookupStrategy?: string;
  failureReason?: CachedArtworkFailureReason;
  lookupStage?: ArtworkLookupStage;
}

export interface ManualLyricsOverride {
  lrc: string;
  updatedAt: number;
}

interface CandidateLyricsOverrideBase {
  schemaVersion: 1;
  candidateId: number;
  trackName: string;
  artistName: string;
  albumName: string;
  durationMs: number;
  updatedAt: number;
}

export type CandidateLyricsOverride = CandidateLyricsOverrideBase & (
  | { mode: 'synced'; lrc: string; plainText?: never }
  | { mode: 'plain'; plainText: string; lrc?: never }
);

export interface LyricsStoreEntries {
  manual?: ManualLyricsOverride;
  candidate?: CandidateLyricsOverride;
  cached?: CachedLyrics;
}

export interface PersistedState {
  version: 1;
  selectedVin: string | null;
  selectedVehicleName: string | null;
  teslaTokens: StoredTokenEnvelope | null;
  telemetryAccepted: boolean;
  telemetryConfiguredAt: number | null;
  telemetrySynced: boolean;
  lyricOffsets: Record<string, number>;
  lyricOverrides: Record<string, ManualLyricsOverride>;
  candidateLyricsOverrides: Record<string, CandidateLyricsOverride>;
  lyricsCache: Record<string, CachedLyrics>;
  workLyricsCache: Record<string, CachedWorkLyrics>;
  artworkPaletteCache: Record<string, CachedArtworkPalette>;
}

interface PersistedCompatibilityCache {
  version: 1;
  lyricsCache: Record<string, CachedLyrics>;
  workLyricsCache: Record<string, CachedWorkLyrics>;
  artworkPaletteCache: Record<string, CachedArtworkPalette>;
}

export interface StateStore {
  snapshot(): Readonly<PersistedState>;
  readSelectedVin(): string | null;
  readSelectedVehicleName(): string | null;
  readTeslaTokens(): StoredTokenEnvelope | null;
  readTelemetryStatus(): Pick<
    PersistedState,
    'telemetryAccepted' | 'telemetryConfiguredAt' | 'telemetrySynced'
  >;
  readLyricOffset(key: string): number;
  readLyricsEntries(key: string): LyricsStoreEntries;
  readWorkLyrics(key: string): CachedWorkLyrics | undefined;
  readArtworkPalette(key: string): CachedArtworkPalette | undefined;
  updateCachedLyrics(
    key: string,
    mutator: (current: CachedLyrics | undefined) => CachedLyrics | undefined,
    maxEntries: number,
    maxBytes?: number,
  ): Promise<void>;
  updateWorkLyrics(
    key: string,
    value: CachedWorkLyrics | undefined,
    maxEntries: number,
    maxBytes?: number,
  ): Promise<void>;
  updateArtworkPalette(
    key: string,
    value: CachedArtworkPalette | undefined,
    maxEntries: number,
  ): Promise<void>;
  update(mutator: (draft: PersistedState) => void): Promise<void>;
}

export const createInitialState = (): PersistedState => ({
  version: 1,
  selectedVin: config.tesla.allowedVin || null,
  selectedVehicleName: null,
  teslaTokens: null,
  telemetryAccepted: false,
  telemetryConfiguredAt: null,
  telemetrySynced: false,
  lyricOffsets: {},
  lyricOverrides: {},
  candidateLyricsOverrides: {},
  lyricsCache: {},
  workLyricsCache: {},
  artworkPaletteCache: {},
});

type CompatibilityCacheKind = 'exact' | 'work';

interface CompatibilityCacheIndexEntry {
  kind: CompatibilityCacheKind;
  key: string;
  bytes: number;
}

export class JsonStore implements StateStore {
  private state: PersistedState = createInitialState();
  private readonly filePath = path.join(config.dataDir, 'state.json');
  private readonly compatibilityFilePath = path.join(config.dataDir, 'compatibility-cache.json');
  private stateRevision = 0;
  private persistedRevision = 0;
  private persistWaiters: Array<{
    revision: number;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];
  private flushPromise?: Promise<void>;
  private compatibilityStateRevision = 0;
  private compatibilityPersistedRevision = 0;
  private compatibilityPersistWaiters: Array<{
    revision: number;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];
  private compatibilityFlushPromise?: Promise<void>;
  private compatibilityCacheBytes = 0;
  private readonly compatibilityCacheIndex = new Map<string, CompatibilityCacheIndexEntry>();

  async load(): Promise<void> {
    await mkdir(config.dataDir, { recursive: true });
    let parsed: Partial<PersistedState> = {};
    let stateFileExists = true;
    try {
      const raw = await readFile(this.filePath, 'utf8');
      parsed = JSON.parse(raw) as Partial<PersistedState>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      stateFileExists = false;
    }

    const compatibility = await this.readCompatibilityCache();
    const hasCacheEntries = (value: unknown): boolean => (
      Boolean(value)
      && typeof value === 'object'
      && Object.keys(value as object).length > 0
    );
    const legacyCachesPresent = hasCacheEntries(parsed.lyricsCache)
      || hasCacheEntries(parsed.workLyricsCache)
      || hasCacheEntries(parsed.artworkPaletteCache);
    this.state = {
      ...createInitialState(),
      ...parsed,
      telemetryAccepted: parsed.telemetryAccepted ?? false,
      telemetryConfiguredAt: parsed.telemetryConfiguredAt ?? null,
      telemetrySynced: parsed.telemetrySynced ?? false,
      lyricOffsets: parsed.lyricOffsets ?? {},
      lyricOverrides: parsed.lyricOverrides ?? {},
      candidateLyricsOverrides: parsed.candidateLyricsOverrides ?? {},
      lyricsCache: compatibility?.lyricsCache ?? parsed.lyricsCache ?? {},
      workLyricsCache: compatibility?.workLyricsCache ?? parsed.workLyricsCache ?? {},
      artworkPaletteCache: compatibility?.artworkPaletteCache ?? parsed.artworkPaletteCache ?? {},
    };
    this.rebuildCompatibilityCacheIndex();
    const cachesChanged = this.trimCompatibilityCaches(
      config.lyrics.legacyCacheMaxEntries,
      config.lyrics.legacyCacheMaxBytes,
    );
    if (!stateFileExists || legacyCachesPresent || cachesChanged) {
      await this.persist();
    }
    if (legacyCachesPresent || cachesChanged) {
      await this.persistCompatibilityCache();
    }
  }

  private async readCompatibilityCache(): Promise<Partial<PersistedCompatibilityCache> | undefined> {
    try {
      const raw = await readFile(this.compatibilityFilePath, 'utf8');
      return JSON.parse(raw) as Partial<PersistedCompatibilityCache>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private persistedState(): PersistedState {
    return {
      ...this.state,
      lyricsCache: {},
      workLyricsCache: {},
      artworkPaletteCache: {},
    };
  }

  private persistedCompatibilityCache(): PersistedCompatibilityCache {
    return {
      version: 1,
      lyricsCache: this.state.lyricsCache,
      workLyricsCache: this.state.workLyricsCache,
      artworkPaletteCache: this.state.artworkPaletteCache,
    };
  }

  private persistCompatibilityCache(): Promise<void> {
    const revision = ++this.compatibilityStateRevision;
    const persisted = new Promise<void>((resolve, reject) => {
      this.compatibilityPersistWaiters.push({ revision, resolve, reject });
    });
    this.ensureCompatibilityFlush();
    return persisted;
  }

  private ensureCompatibilityFlush(): void {
    if (this.compatibilityFlushPromise) return;
    this.compatibilityFlushPromise = this.flushCompatibilityLoop()
      .catch((error: unknown) => {
        const waiters = this.compatibilityPersistWaiters;
        this.compatibilityPersistWaiters = [];
        for (const waiter of waiters) waiter.reject(error);
      })
      .finally(() => {
        this.compatibilityFlushPromise = undefined;
        if (
          this.compatibilityPersistWaiters.length > 0
          && this.compatibilityPersistedRevision < this.compatibilityStateRevision
        ) {
          this.ensureCompatibilityFlush();
        }
      });
  }

  private async flushCompatibilityLoop(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    while (this.compatibilityPersistedRevision < this.compatibilityStateRevision) {
      const revision = this.compatibilityStateRevision;
      const serialized = `${JSON.stringify(this.persistedCompatibilityCache())}\n`;
      const temporary = `${this.compatibilityFilePath}.tmp`;
      await writeFile(temporary, serialized, { mode: 0o600 });
      await rename(temporary, this.compatibilityFilePath);
      this.compatibilityPersistedRevision = revision;
      const pending = this.compatibilityPersistWaiters;
      this.compatibilityPersistWaiters = [];
      for (const waiter of pending) {
        if (waiter.revision <= revision) waiter.resolve();
        else this.compatibilityPersistWaiters.push(waiter);
      }
      if (this.compatibilityPersistedRevision < this.compatibilityStateRevision) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }

  snapshot(): Readonly<PersistedState> {
    return structuredClone(this.state);
  }

  readSelectedVin(): string | null {
    return this.state.selectedVin;
  }

  readSelectedVehicleName(): string | null {
    return this.state.selectedVehicleName;
  }

  readTeslaTokens(): StoredTokenEnvelope | null {
    return this.state.teslaTokens ? structuredClone(this.state.teslaTokens) : null;
  }

  readTelemetryStatus(): Pick<
    PersistedState,
    'telemetryAccepted' | 'telemetryConfiguredAt' | 'telemetrySynced'
  > {
    return {
      telemetryAccepted: this.state.telemetryAccepted,
      telemetryConfiguredAt: this.state.telemetryConfiguredAt,
      telemetrySynced: this.state.telemetrySynced,
    };
  }

  readLyricOffset(key: string): number {
    return this.state.lyricOffsets[key] ?? 0;
  }

  /**
   * Reads only the entries needed for one track. Keeping this separate from
   * `snapshot()` prevents a growing lyrics corpus from being cloned on every
   * playback lookup.
   */
  readLyricsEntries(key: string): LyricsStoreEntries {
    const manual = this.state.lyricOverrides[key];
    const candidate = this.state.candidateLyricsOverrides[key];
    const cached = this.state.lyricsCache[key];
    return {
      ...(manual ? { manual: structuredClone(manual) } : {}),
      ...(candidate ? { candidate: structuredClone(candidate) } : {}),
      ...(cached ? { cached: structuredClone(cached) } : {}),
    };
  }

  readWorkLyrics(key: string): CachedWorkLyrics | undefined {
    const cached = this.state.workLyricsCache[key];
    return cached ? structuredClone(cached) : undefined;
  }

  readArtworkPalette(key: string): CachedArtworkPalette | undefined {
    const cached = this.state.artworkPaletteCache[key];
    return cached ? structuredClone(cached) : undefined;
  }

  /**
   * Automatic caches use narrow mutations so a single-track update does not
   * clone the complete state first. The on-disk JSON remains a compatibility
   * cache while Supabase is rolled out, and is strictly entry-bounded.
   */
  async updateCachedLyrics(
    key: string,
    mutator: (current: CachedLyrics | undefined) => CachedLyrics | undefined,
    maxEntries: number,
    maxBytes = config.lyrics.legacyCacheMaxBytes,
  ): Promise<void> {
    this.ensureCompatibilityCacheIndex();
    const current = this.state.lyricsCache[key];
    const next = mutator(current ? structuredClone(current) : undefined);
    if (next) {
      delete this.state.lyricsCache[key];
      this.state.lyricsCache[key] = structuredClone(next);
      this.touchCompatibilityCache('exact', key, next);
    } else {
      this.deleteCompatibilityCache('exact', key);
    }
    this.trimCompatibilityCaches(maxEntries, maxBytes);
    await this.persistCompatibilityCache();
  }

  async updateWorkLyrics(
    key: string,
    value: CachedWorkLyrics | undefined,
    maxEntries: number,
    maxBytes = config.lyrics.legacyCacheMaxBytes,
  ): Promise<void> {
    this.ensureCompatibilityCacheIndex();
    if (value) {
      delete this.state.workLyricsCache[key];
      this.state.workLyricsCache[key] = structuredClone(value);
      this.touchCompatibilityCache('work', key, value);
    } else {
      this.deleteCompatibilityCache('work', key);
    }
    this.trimCompatibilityCaches(maxEntries, maxBytes);
    await this.persistCompatibilityCache();
  }

  async updateArtworkPalette(
    key: string,
    value: CachedArtworkPalette | undefined,
    maxEntries: number,
  ): Promise<void> {
    if (value) {
      delete this.state.artworkPaletteCache[key];
      this.state.artworkPaletteCache[key] = structuredClone(value);
    } else {
      delete this.state.artworkPaletteCache[key];
    }
    pruneCacheRecord(this.state.artworkPaletteCache, maxEntries);
    await this.persistCompatibilityCache();
  }

  async update(mutator: (draft: PersistedState) => void): Promise<void> {
    const next = structuredClone(this.state);
    mutator(next);
    this.state = next;
    this.rebuildCompatibilityCacheIndex();
    this.trimCompatibilityCaches(
      config.lyrics.legacyCacheMaxEntries,
      config.lyrics.legacyCacheMaxBytes,
    );
    await Promise.all([this.persist(), this.persistCompatibilityCache()]);
  }

  private ensureCompatibilityCacheIndex(): void {
    const entryCount = Object.keys(this.state.lyricsCache).length
      + Object.keys(this.state.workLyricsCache).length;
    if (entryCount !== this.compatibilityCacheIndex.size) {
      this.rebuildCompatibilityCacheIndex();
    }
  }

  private rebuildCompatibilityCacheIndex(): void {
    this.compatibilityCacheIndex.clear();
    this.compatibilityCacheBytes = 0;
    const entries: Array<{
      kind: CompatibilityCacheKind;
      key: string;
      value: CachedLyrics | CachedWorkLyrics;
    }> = [
      ...Object.entries(this.state.lyricsCache).map(([key, value]) => ({
        kind: 'exact' as const,
        key,
        value,
      })),
      ...Object.entries(this.state.workLyricsCache).map(([key, value]) => ({
        kind: 'work' as const,
        key,
        value,
      })),
    ];
    // Expiry is a stable approximation of insertion age for the compatibility
    // cache because entries of each class use fixed TTLs.
    entries.sort((left, right) => left.value.expiresAt - right.value.expiresAt);
    for (const entry of entries) {
      this.touchCompatibilityCache(entry.kind, entry.key, entry.value);
    }
  }

  private touchCompatibilityCache(
    kind: CompatibilityCacheKind,
    key: string,
    value: CachedLyrics | CachedWorkLyrics,
  ): void {
    const indexKey = compatibilityCacheIndexKey(kind, key);
    const current = this.compatibilityCacheIndex.get(indexKey);
    if (current) {
      this.compatibilityCacheBytes -= current.bytes;
      this.compatibilityCacheIndex.delete(indexKey);
    }
    const bytes = compatibilityCacheEntryBytes(kind, key, value);
    this.compatibilityCacheIndex.set(indexKey, { kind, key, bytes });
    this.compatibilityCacheBytes += bytes;
  }

  private deleteCompatibilityCache(kind: CompatibilityCacheKind, key: string): boolean {
    const record = kind === 'exact' ? this.state.lyricsCache : this.state.workLyricsCache;
    const existed = Object.hasOwn(record, key);
    delete record[key];
    const indexKey = compatibilityCacheIndexKey(kind, key);
    const indexed = this.compatibilityCacheIndex.get(indexKey);
    if (indexed) {
      this.compatibilityCacheBytes -= indexed.bytes;
      this.compatibilityCacheIndex.delete(indexKey);
    }
    return existed || Boolean(indexed);
  }

  private trimCompatibilityCaches(maxEntries: number, maxBytes: number): boolean {
    let changed = false;
    const now = Date.now();
    for (const entry of [...this.compatibilityCacheIndex.values()]) {
      const record = entry.kind === 'exact'
        ? this.state.lyricsCache
        : this.state.workLyricsCache;
      const value = record[entry.key];
      if (!value || !Number.isFinite(value.expiresAt) || value.expiresAt <= now) {
        changed = this.deleteCompatibilityCache(entry.kind, entry.key) || changed;
      }
    }

    const entryLimit = Math.max(0, Math.trunc(maxEntries));
    const byteLimit = Math.max(0, Math.trunc(maxBytes));
    let exactCount = Object.keys(this.state.lyricsCache).length;
    let workCount = Object.keys(this.state.workLyricsCache).length;
    for (const entry of [...this.compatibilityCacheIndex.values()]) {
      const overKindLimit = entry.kind === 'exact'
        ? exactCount > entryLimit
        : workCount > entryLimit;
      if (!overKindLimit) continue;
      if (this.deleteCompatibilityCache(entry.kind, entry.key)) {
        changed = true;
        if (entry.kind === 'exact') exactCount -= 1;
        else workCount -= 1;
      }
    }

    while (this.compatibilityCacheBytes > byteLimit) {
      const oldest = this.compatibilityCacheIndex.values().next().value as
        | CompatibilityCacheIndexEntry
        | undefined;
      if (!oldest) break;
      changed = this.deleteCompatibilityCache(oldest.kind, oldest.key) || changed;
    }
    return changed;
  }

  private async persist(): Promise<void> {
    const revision = ++this.stateRevision;
    const persisted = new Promise<void>((resolve, reject) => {
      this.persistWaiters.push({ revision, resolve, reject });
    });
    this.ensureFlush();
    return persisted;
  }

  private ensureFlush(): void {
    if (this.flushPromise) return;
    this.flushPromise = this.flushLoop()
      .catch((error: unknown) => {
        const waiters = this.persistWaiters;
        this.persistWaiters = [];
        for (const waiter of waiters) waiter.reject(error);
      })
      .finally(() => {
        this.flushPromise = undefined;
        if (this.persistWaiters.length > 0 && this.persistedRevision < this.stateRevision) {
          this.ensureFlush();
        }
      });
  }

  private async flushLoop(): Promise<void> {
    // Let the lyrics result reach SSE/HTTP consumers before doing the remaining
    // compatibility JSON serialization, and coalesce bursts into one write.
    await new Promise<void>((resolve) => setImmediate(resolve));
    while (this.persistedRevision < this.stateRevision) {
      const revision = this.stateRevision;
      // The file is a bounded compatibility cache, not a hand-edited config.
      // Compact JSON materially reduces both serialization work and Fly volume IO.
      const serialized = `${JSON.stringify(this.persistedState())}\n`;
      const temporary = `${this.filePath}.tmp`;
      await writeFile(temporary, serialized, { mode: 0o600 });
      await rename(temporary, this.filePath);
      this.persistedRevision = revision;
      const pending = this.persistWaiters;
      this.persistWaiters = [];
      for (const waiter of pending) {
        if (waiter.revision <= revision) waiter.resolve();
        else this.persistWaiters.push(waiter);
      }
      if (this.persistedRevision < this.stateRevision) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }
}

function compatibilityCacheIndexKey(kind: CompatibilityCacheKind, key: string): string {
  return `${kind}:${key}`;
}

function compatibilityCacheEntryBytes(
  kind: CompatibilityCacheKind,
  key: string,
  value: CachedLyrics | CachedWorkLyrics,
): number {
  return Buffer.byteLength(compatibilityCacheIndexKey(kind, key), 'utf8')
    + Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function pruneCacheRecord<T extends { expiresAt: number }>(
  record: Record<string, T>,
  maxEntries: number,
): void {
  const now = Date.now();
  for (const [key, entry] of Object.entries(record)) {
    if (!Number.isFinite(entry.expiresAt) || entry.expiresAt <= now) delete record[key];
  }
  const limit = Math.max(0, Math.trunc(maxEntries));
  const retainedKeys = Object.keys(record);
  const excess = Math.max(0, retainedKeys.length - limit);
  for (let index = 0; index < excess; index += 1) {
    delete record[retainedKeys[index]!];
  }
}
