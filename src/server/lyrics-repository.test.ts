import type { LyricsPayload, TrackMetadata } from '../shared/contracts.js';
import { lyricsLookupFingerprint, lyricsWorkFingerprint } from '../shared/track.js';
import { defaultByteEstimator } from './bounded-lru.js';
import {
  lyricsLibraryRequestTimeout,
  LyricsRepository,
  PRIMARY_APPLE_EXACT_LOOKUP_STRATEGY,
  PRIMARY_EXACT_REVALIDATE_MS,
  PRIMARY_LRCLIB_EXACT_LOOKUP_STRATEGY,
  PRIMARY_SELECTED_EXACT_LOOKUP_STRATEGY,
  shadowObservationCutoff,
  type LyricsLibraryClient,
  type LyricsLibraryResolveInput,
  type LyricsLibraryResolveResult,
} from './lyrics-repository.js';
import type {
  CachedLyrics,
  CachedWorkLyrics,
  JsonStore,
  LyricsStoreEntries,
  PersistedState,
} from './store.js';

const TRACK: TrackMetadata = {
  title: 'Midnight Circuit',
  artist: 'Local Drive',
  album: 'After Dark',
  durationMs: 214_000,
  source: 'Apple Music',
};

const POSITIVE_PAYLOAD: LyricsPayload = {
  kind: 'synced',
  lines: [{ id: 'line-1', startMs: 1_000, text: 'Streetlights draw a silver line' }],
  provider: 'lrclib',
  providerId: 42,
};

const APPLE_PAYLOAD: LyricsPayload = {
  kind: 'synced',
  lines: [{ id: 'apple-line-1', startMs: 1_000, text: 'Apple catalog lyric' }],
  provider: 'apple',
  providerTrackId: 'apple-track-42',
};

const MISSING_PAYLOAD: LyricsPayload = {
  kind: 'missing',
  lines: [],
  provider: null,
};

function cachedLyrics(
  payload: LyricsPayload = POSITIVE_PAYLOAD,
  marker = 'default',
): CachedLyrics {
  return {
    payload: structuredClone(payload),
    lookupStrategy: `test-${marker}`,
    metadataSignature: lyricsLookupFingerprint(TRACK),
    expiresAt: Date.now() + 60_000,
  };
}

function workLyrics(marker = 'default'): CachedWorkLyrics {
  return {
    schemaVersion: 1,
    plainText: `Static work lyrics ${marker}`,
    provider: 'lrclib',
    providerId: 42,
    sourceTitle: TRACK.title,
    sourceArtist: TRACK.artist,
    storedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
}

function initialState(overrides: Partial<PersistedState> = {}): PersistedState {
  return {
    version: 1,
    selectedVin: null,
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
    ...overrides,
  };
}

function fakeStore(overrides: Partial<PersistedState> = {}) {
  const state = initialState(overrides);
  const snapshot = vi.fn(() => structuredClone(state));
  const readLyricsEntries = vi.fn((key: string): LyricsStoreEntries => {
    const manual = state.lyricOverrides[key];
    const candidate = state.candidateLyricsOverrides[key];
    const cached = state.lyricsCache[key];
    return {
      ...(manual ? { manual: structuredClone(manual) } : {}),
      ...(candidate ? { candidate: structuredClone(candidate) } : {}),
      ...(cached ? { cached: structuredClone(cached) } : {}),
    };
  });
  const readWorkLyrics = vi.fn((key: string) => {
    const cached = state.workLyricsCache[key];
    return cached ? structuredClone(cached) : undefined;
  });
  const updateCachedLyrics = vi.fn(async (
    key: string,
    mutator: (current: CachedLyrics | undefined) => CachedLyrics | undefined,
    _maxEntries: number,
  ) => {
    const current = state.lyricsCache[key];
    const next = mutator(current ? structuredClone(current) : undefined);
    if (next) state.lyricsCache[key] = structuredClone(next);
    else delete state.lyricsCache[key];
  });
  const updateWorkLyrics = vi.fn(async (
    key: string,
    value: CachedWorkLyrics | undefined,
    _maxEntries: number,
  ) => {
    if (value) state.workLyricsCache[key] = structuredClone(value);
    else delete state.workLyricsCache[key];
  });
  const update = vi.fn(async (mutator: (draft: PersistedState) => void) => {
    mutator(state);
  });

  const store = {
    snapshot,
    readLyricsEntries,
    readWorkLyrics,
    updateCachedLyrics,
    updateWorkLyrics,
    update,
  } as unknown as JsonStore;

  return {
    store,
    state,
    snapshot,
    readLyricsEntries,
    readWorkLyrics,
    updateCachedLyrics,
    updateWorkLyrics,
    update,
  };
}

function fakeRemote(
  result: LyricsLibraryResolveResult = { state: 'miss' },
) {
  const resolve = vi.fn(async (
    _input: LyricsLibraryResolveInput,
  ): Promise<LyricsLibraryResolveResult> => structuredClone(result));
  const compareQuarantined = vi.fn<LyricsLibraryClient['compareQuarantined']>(async () => ({
    state: 'ok',
    exact: { candidateCount: 0, comparisons: 0, agreements: 0, disagreements: 0 },
    work: { candidateCount: 0, comparisons: 0, agreements: 0, disagreements: 0 },
  }));
  const upsertExact = vi.fn(async (): Promise<void> => undefined);
  const upsertWork = vi.fn(async (): Promise<void> => undefined);
  const enqueueAppleLyricsBackfill = vi.fn<
    NonNullable<LyricsLibraryClient['enqueueAppleLyricsBackfill']>
  >(async () => undefined);
  const remote = {
    resolve,
    compareQuarantined,
    upsertExact,
    upsertWork,
    enqueueAppleLyricsBackfill,
  } satisfies LyricsLibraryClient;
  return {
    remote,
    resolve,
    compareQuarantined,
    upsertExact,
    upsertWork,
    enqueueAppleLyricsBackfill,
  };
}

function repository(
  store: JsonStore,
  options: Partial<ConstructorParameters<typeof LyricsRepository>[1]> = {},
): LyricsRepository {
  return new LyricsRepository(store, {
    mode: 'off',
    memoryMaxEntries: 300,
    memoryMaxBytes: 4 * 1_024 * 1_024,
    legacyMaxEntries: 300,
    legacyMaxBytes: 8 * 1_024 * 1_024,
    ...options,
  });
}

function exactMemoryBytes(key: string, cached: CachedLyrics): number {
  const memoryKey = `exact:${key}`;
  return defaultByteEstimator({ kind: 'exact', value: cached })
    + new TextEncoder().encode(memoryKey).byteLength;
}

describe('LyricsRepository', () => {
  it('keeps primary and shadow request timeout wiring separate', () => {
    expect(lyricsLibraryRequestTimeout('primary', 400, 800)).toBe(400);
    expect(lyricsLibraryRequestTimeout('shadow', 400, 800)).toBe(800);
  });

  it('uses a five-second safety window for pre-write shadow observations', () => {
    expect(shadowObservationCutoff(10_000)).toBe('1970-01-01T00:00:05.000Z');
  });

  it.each([
    {
      label: 'Apple exact',
      payload: APPLE_PAYLOAD,
      matchKind: 'exact' as const,
      strategy: PRIMARY_APPLE_EXACT_LOOKUP_STRATEGY,
      contentTtlMs: PRIMARY_EXACT_REVALIDATE_MS,
      revalidateTtlMs: PRIMARY_EXACT_REVALIDATE_MS,
    },
    {
      label: 'LRCLIB exact',
      payload: POSITIVE_PAYLOAD,
      matchKind: 'exact' as const,
      strategy: PRIMARY_LRCLIB_EXACT_LOOKUP_STRATEGY,
      contentTtlMs: 30 * 24 * 60 * 60 * 1_000,
      revalidateTtlMs: PRIMARY_EXACT_REVALIDATE_MS,
    },
    {
      label: 'work fallback',
      payload: POSITIVE_PAYLOAD,
      matchKind: 'work' as const,
      strategy: 'supabase-work-v1',
      contentTtlMs: 5 * 60 * 1_000,
      revalidateTtlMs: null,
    },
  ])(
    'bounds the $label remote cache policy without changing its content lifetime',
    ({ payload, matchKind, strategy, contentTtlMs, revalidateTtlMs }) => {
      const fake = fakeStore();
      const lyrics = repository(fake.store, { mode: 'primary' });
      const before = Date.now();

      lyrics.rememberRemoteHit(TRACK, 'track-key', payload, matchKind);

      const after = Date.now();
      const cached = lyrics.readTrack('track-key').cached;
      expect(cached?.lookupStrategy).toBe(strategy);
      expect(cached?.expiresAt).toBeGreaterThanOrEqual(before + contentTtlMs);
      expect(cached?.expiresAt).toBeLessThanOrEqual(after + contentTtlMs);
      if (revalidateTtlMs === null) {
        expect(cached?.revalidateAt).toBeUndefined();
      } else {
        expect(cached?.revalidateAt).toBeGreaterThanOrEqual(before + revalidateTtlMs);
        expect(cached?.revalidateAt).toBeLessThanOrEqual(after + revalidateTtlMs);
      }
    },
  );

  it('enqueues Apple supplementation when album metadata is unavailable', () => {
    const remote = fakeRemote();
    const lyrics = repository(fakeStore().store, {
      mode: 'primary',
      remote: remote.remote,
      appleBackfill: {
        enabled: true,
        storefront: 'us',
        locale: 'en-US',
        maxAttempts: 5,
      },
    });

    const track = { ...TRACK, album: '' };
    expect(lyrics.enqueueAppleBackfill(track)).toBe(30_000);
    expect(remote.enqueueAppleLyricsBackfill).toHaveBeenCalledWith(
      expect.objectContaining({ track }),
    );
  });

  it('keeps a user-selected remote exact hit outside automatic policy revalidation', () => {
    const fake = fakeStore();
    const lyrics = repository(fake.store, { mode: 'primary' });
    const before = Date.now();

    lyrics.rememberRemoteHit(
      TRACK,
      'track-key',
      POSITIVE_PAYLOAD,
      'exact',
      'candidate',
    );

    const after = Date.now();
    const cached = lyrics.readTrack('track-key').cached;
    expect(cached?.lookupStrategy).toBe(PRIMARY_SELECTED_EXACT_LOOKUP_STRATEGY);
    expect(cached?.revalidateAt).toBeUndefined();
    expect(cached?.expiresAt).toBeGreaterThanOrEqual(
      before + 30 * 24 * 60 * 60 * 1_000,
    );
    expect(cached?.expiresAt).toBeLessThanOrEqual(
      after + 30 * 24 * 60 * 60 * 1_000,
    );
  });

  it('uses narrow per-key getters without cloning the full state snapshot', () => {
    const exactKey = 'exact-key';
    const workKey = 'work-key';
    const exact = cachedLyrics();
    const work = workLyrics();
    const fake = fakeStore({
      lyricsCache: { [exactKey]: exact },
      workLyricsCache: { [workKey]: work },
    });
    fake.snapshot.mockImplementation(() => {
      throw new Error('full snapshot must not be read');
    });
    const lyrics = repository(fake.store);

    expect(lyrics.readTrack(exactKey).cached).toEqual(exact);
    expect(lyrics.readWork(workKey)).toEqual(work);

    expect(fake.readLyricsEntries).toHaveBeenCalledExactlyOnceWith(exactKey);
    expect(fake.readWorkLyrics).toHaveBeenCalledExactlyOnceWith(workKey);
    expect(fake.snapshot).not.toHaveBeenCalled();
  });

  it('serves cached lyrics from L1 while still consulting per-key manual and candidate state', () => {
    const key = 'track-key';
    const cached = cachedLyrics();
    const fake = fakeStore({ lyricsCache: { [key]: cached } });
    const lyrics = repository(fake.store);

    expect(lyrics.readTrack(key).cached).toEqual(cached);
    delete fake.state.lyricsCache[key];

    const second = lyrics.readTrack(key);
    expect(second.cached).toEqual(cached);
    expect(second.cached).not.toBe(cached);
    expect(fake.readLyricsEntries).toHaveBeenCalledTimes(2);
    expect(fake.snapshot).not.toHaveBeenCalled();
  });

  it('evicts the least-recent exact entry at the entry limit and reports L1 stats', () => {
    const fake = fakeStore();
    const lyrics = repository(fake.store, {
      mode: 'primary',
      memoryMaxEntries: 1,
      remote: undefined,
    });
    const first = cachedLyrics(POSITIVE_PAYLOAD, 'first');
    const second = cachedLyrics(POSITIVE_PAYLOAD, 'second');

    lyrics.rememberExact(TRACK, 'first-key', first);
    lyrics.rememberExact(TRACK, 'second-key', second);

    expect(lyrics.stats()).toMatchObject({
      entries: 1,
      estimatedBytes: exactMemoryBytes('second-key', second),
      mode: 'primary',
    });
    expect(lyrics.readTrack('first-key').cached).toBeUndefined();
    expect(lyrics.readTrack('second-key').cached).toEqual(second);
  });

  it('evicts old entries to honor the byte budget and reports estimated bytes', () => {
    const fake = fakeStore();
    const first = cachedLyrics({
      ...POSITIVE_PAYLOAD,
      lines: [{ id: 'first', startMs: 0, text: 'a'.repeat(120) }],
    }, 'first');
    const second = cachedLyrics({
      ...POSITIVE_PAYLOAD,
      lines: [{ id: 'second', startMs: 0, text: 'b'.repeat(160) }],
    }, 'second');
    const secondBytes = exactMemoryBytes('second-key', second);
    const lyrics = repository(fake.store, {
      mode: 'primary',
      memoryMaxEntries: 10,
      memoryMaxBytes: Math.max(exactMemoryBytes('first-key', first), secondBytes),
      remote: undefined,
    });

    lyrics.rememberExact(TRACK, 'first-key', first);
    lyrics.rememberExact(TRACK, 'second-key', second);

    expect(lyrics.readTrack('first-key').cached).toBeUndefined();
    expect(lyrics.readTrack('second-key').cached).toEqual(second);
    expect(lyrics.stats()).toMatchObject({
      entries: 1,
      estimatedBytes: secondBytes,
      mode: 'primary',
    });
  });

  it('keeps writing the bounded legacy cache in off mode and never writes remotely', () => {
    const fake = fakeStore();
    const remote = fakeRemote();
    const lyrics = repository(fake.store, {
      mode: 'off',
      legacyMaxEntries: 17,
      remote: remote.remote,
    });
    const cached = cachedLyrics();

    expect(lyrics.rememberExact(TRACK, 'track-key', cached)).toBeUndefined();

    expect(fake.updateCachedLyrics).toHaveBeenCalledWith(
      'track-key',
      expect.any(Function),
      17,
      8 * 1_024 * 1_024,
    );
    expect(fake.state.lyricsCache['track-key']).toEqual(cached);
    expect(remote.upsertExact).not.toHaveBeenCalled();
  });

  it('observes shadow reads and writes without waiting for either remote operation', async () => {
    let resolveRead: ((value: LyricsLibraryResolveResult) => void) | undefined;
    let resolveWrite: (() => void) | undefined;
    const readGate = new Promise<LyricsLibraryResolveResult>((resolve) => {
      resolveRead = resolve;
    });
    const writeGate = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    const remote = fakeRemote();
    remote.resolve.mockImplementation(async () => readGate);
    remote.upsertExact.mockImplementation(async () => writeGate);
    const fake = fakeStore();
    const lyrics = repository(fake.store, {
      mode: 'shadow',
      remote: remote.remote,
    });

    expect(lyrics.observeRemote(TRACK)).toBeUndefined();
    expect(remote.resolve).toHaveBeenCalledTimes(1);

    const cached = cachedLyrics();
    expect(lyrics.rememberExact(TRACK, 'track-key', cached)).toBeUndefined();
    expect(remote.upsertExact).toHaveBeenCalledTimes(1);
    expect(remote.upsertExact).toHaveBeenCalledExactlyOnceWith({
      track: TRACK,
      exactKey: lyricsLookupFingerprint(TRACK),
      keyVersion: 1,
      cached,
      trust: 'active',
      sourceKind: 'automatic',
    });
    expect(fake.state.lyricsCache['track-key']).toEqual(cached);
    expect(lyrics.stats().remoteWrites.exact).toMatchObject({
      attempts: 1,
      successes: 0,
      failures: 0,
    });

    resolveRead?.({ state: 'miss' });
    resolveWrite?.();
    await Promise.all([readGate, writeGate]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(lyrics.stats().remoteWrites.exact).toMatchObject({
      attempts: 1,
      successes: 1,
      failures: 0,
    });
    expect(remote.compareQuarantined).not.toHaveBeenCalled();
  });

  it('enqueues Apple supplementation asynchronously and deduplicates an in-flight exact key', async () => {
    let finish: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const remote = fakeRemote();
    remote.enqueueAppleLyricsBackfill.mockImplementation(async () => gate);
    const fake = fakeStore();
    const lyrics = repository(fake.store, {
      mode: 'primary',
      remote: remote.remote,
      appleBackfill: {
        enabled: true,
        storefront: 'us',
        locale: 'en-US',
        maxAttempts: 5,
      },
    });

    expect(lyrics.enqueueAppleBackfill(TRACK)).toBe(30_000);
    lyrics.enqueueAppleBackfill({ ...TRACK });

    expect(remote.enqueueAppleLyricsBackfill).toHaveBeenCalledExactlyOnceWith({
      exactKey: lyricsLookupFingerprint(TRACK),
      keyVersion: 1,
      storefront: 'us',
      locale: 'en-US',
      track: TRACK,
      maxAttempts: 5,
    });
    expect(lyrics.stats().appleBackfill).toEqual({
      enabled: true,
      pending: 1,
      attempts: 1,
      successes: 0,
      failures: 0,
    });

    finish?.();
    await gate;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(lyrics.stats().appleBackfill).toMatchObject({
      pending: 0,
      attempts: 1,
      successes: 1,
      failures: 0,
    });
  });

  it.each([
    ['blank title', { ...TRACK, title: ' ' }],
    ['blank artist', { ...TRACK, artist: ' ' }],
    ['zero duration', { ...TRACK, durationMs: 0 }],
    ['non-finite duration', { ...TRACK, durationMs: Number.NaN }],
    ['overlong duration', { ...TRACK, durationMs: 86_400_001 }],
    ['radio sentinel', { ...TRACK, durationMs: 18_000_000 }],
  ] satisfies Array<[string, TrackMetadata]>)(
    'does not enqueue an Apple job with %s',
    (_label, track) => {
      const remote = fakeRemote();
      const lyrics = repository(fakeStore().store, {
        mode: 'primary',
        remote: remote.remote,
        appleBackfill: {
          enabled: true,
          storefront: 'us',
          locale: 'en-US',
          maxAttempts: 5,
        },
      });

      expect(lyrics.enqueueAppleBackfill(track)).toBeNull();
      expect(remote.enqueueAppleLyricsBackfill).not.toHaveBeenCalled();
    },
  );

  it('keeps original, Live, and Acoustic playback jobs as distinct exact identities', () => {
    const remote = fakeRemote();
    const lyrics = repository(fakeStore().store, {
      mode: 'primary',
      remote: remote.remote,
      appleBackfill: {
        enabled: true,
        storefront: 'us',
        locale: 'en-US',
        maxAttempts: 5,
      },
    });
    const tracks = [
      TRACK,
      { ...TRACK, title: `${TRACK.title} (Live)` },
      { ...TRACK, title: `${TRACK.title} (Acoustic)` },
    ];

    for (const track of tracks) {
      expect(lyrics.enqueueAppleBackfill(track)).toBe(30_000);
    }

    expect(remote.enqueueAppleLyricsBackfill).toHaveBeenCalledTimes(3);
    expect(new Set(
      remote.enqueueAppleLyricsBackfill.mock.calls.map(([input]) => input.exactKey),
    ).size).toBe(3);
  });

  it('does not rewrite a known terminal Apple queue row on later refreshes', async () => {
    const remote = fakeRemote();
    remote.enqueueAppleLyricsBackfill.mockResolvedValueOnce({ status: 'completed' });
    const lyrics = repository(fakeStore().store, {
      mode: 'primary',
      remote: remote.remote,
      appleBackfill: {
        enabled: true,
        storefront: 'us',
        locale: 'en-US',
        maxAttempts: 5,
      },
    });

    expect(lyrics.enqueueAppleBackfill(TRACK)).toBe(30_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(lyrics.enqueueAppleBackfill(TRACK)).toBe(5 * 60_000);
    expect(remote.enqueueAppleLyricsBackfill).toHaveBeenCalledTimes(1);
  });

  it('does not create legacy automatic caches in primary mode', () => {
    const fake = fakeStore();
    const remote = fakeRemote();
    const lyrics = repository(fake.store, {
      mode: 'primary',
      remote: remote.remote,
    });

    lyrics.rememberExact(TRACK, 'track-key', cachedLyrics());
    lyrics.rememberWork('work-key', workLyrics());

    expect(fake.updateCachedLyrics).not.toHaveBeenCalled();
    expect(fake.updateWorkLyrics).not.toHaveBeenCalled();
    expect(fake.state.lyricsCache).toEqual({});
    expect(fake.state.workLyricsCache).toEqual({});
    expect(remote.upsertExact).toHaveBeenCalledTimes(1);
    expect(remote.upsertWork).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: 'hit',
      result: {
        state: 'hit',
        matchKind: 'exact',
        payload: POSITIVE_PAYLOAD,
        documentId: '00000000-0000-4000-8000-000000000042',
      } satisfies LyricsLibraryResolveResult,
    },
    { label: 'miss', result: { state: 'miss' } satisfies LyricsLibraryResolveResult },
    {
      label: 'unavailable',
      result: {
        state: 'unavailable',
        reason: 'timeout',
      } satisfies LyricsLibraryResolveResult,
    },
  ])('preserves the primary remote $label contract', async ({ result }) => {
    const fake = fakeStore();
    const remote = fakeRemote(result);
    const lyrics = repository(fake.store, {
      mode: 'primary',
      remote: remote.remote,
    });

    await expect(lyrics.resolveRemote(TRACK, true)).resolves.toEqual(result);
    expect(remote.resolve).toHaveBeenCalledExactlyOnceWith({
      track: TRACK,
      exactKey: lyricsLookupFingerprint(TRACK),
      workKey: lyricsWorkFingerprint(TRACK),
      keyVersion: 1,
      allowWorkFallback: true,
    });
  });

  it('records non-sensitive shadow latency/state and content agreement', async () => {
    const fake = fakeStore();
    const hit: LyricsLibraryResolveResult = {
      state: 'hit',
      matchKind: 'exact',
      payload: POSITIVE_PAYLOAD,
      documentId: '00000000-0000-4000-8000-000000000042',
    };
    const remote = fakeRemote(hit);
    const lyrics = repository(fake.store, { mode: 'shadow', remote: remote.remote });

    lyrics.observeRemote(TRACK, structuredClone(POSITIVE_PAYLOAD));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(lyrics.stats()).toMatchObject({
      remoteRequests: 1,
      remoteHits: 1,
      remoteUnavailable: 0,
      lastRemoteState: 'hit',
      lastRemoteReason: null,
      shadowComparisons: 1,
      shadowAgreements: 1,
      shadowDisagreements: 0,
    });
    expect(lyrics.stats().remoteP95Ms).toEqual(expect.any(Number));
  });

  it('compares quarantined exact/work candidates for an original LRCLIB result', async () => {
    const fake = fakeStore();
    const remote = fakeRemote({ state: 'miss' });
    remote.compareQuarantined.mockResolvedValueOnce({
      state: 'ok',
      exact: { candidateCount: 2, comparisons: 2, agreements: 1, disagreements: 1 },
      work: { candidateCount: 1, comparisons: 1, agreements: 1, disagreements: 0 },
    });
    const lyrics = repository(fake.store, { mode: 'shadow', remote: remote.remote });

    lyrics.observeRemote(TRACK, structuredClone(POSITIVE_PAYLOAD));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(remote.compareQuarantined).toHaveBeenCalledExactlyOnceWith({
      track: TRACK,
      exactKey: lyricsLookupFingerprint(TRACK),
      workKey: lyricsWorkFingerprint(TRACK),
      keyVersion: 1,
      observedBefore: expect.any(String),
      expectedExact: POSITIVE_PAYLOAD,
      expectedWork: POSITIVE_PAYLOAD,
    });
    expect(lyrics.stats()).toMatchObject({
      shadowComparisons: 0,
      shadowAgreements: 0,
      shadowDisagreements: 0,
      quarantineComparisons: {
        exact: {
          requests: 1,
          candidates: 2,
          comparisons: 2,
          agreements: 1,
          disagreements: 1,
          unavailable: 0,
        },
        work: {
          requests: 1,
          candidates: 1,
          comparisons: 1,
          agreements: 1,
          disagreements: 0,
          unavailable: 0,
        },
      },
    });
  });

  it('compares Live fallback as work-only and actual Live lyrics as exact-only', async () => {
    const liveTrack: TrackMetadata = {
      ...TRACK,
      title: 'Midnight Circuit (Live)',
      album: 'Live After Dark',
    };
    const fallback: LyricsPayload = {
      kind: 'plain',
      lines: [{ id: 'plain-0', startMs: 0, text: 'Studio lyric' }],
      plainText: 'Studio lyric',
      provider: 'lrclib',
      providerId: 88,
      fallbackKind: 'original-version',
      notice: '未找到现场版歌词，当前显示原版静态歌词。',
    };
    const remote = fakeRemote({ state: 'miss' });
    const lyrics = repository(fakeStore().store, { mode: 'shadow', remote: remote.remote });

    lyrics.observeRemote(liveTrack, fallback);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(remote.compareQuarantined).toHaveBeenNthCalledWith(1, {
      track: liveTrack,
      exactKey: lyricsLookupFingerprint(liveTrack),
      workKey: lyricsWorkFingerprint(liveTrack),
      keyVersion: 1,
      observedBefore: expect.any(String),
      expectedWork: fallback,
    });

    const actualLive = structuredClone(POSITIVE_PAYLOAD);
    lyrics.observeRemote({ ...liveTrack, durationMs: liveTrack.durationMs + 1_000 }, actualLive);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(remote.compareQuarantined).toHaveBeenNthCalledWith(2, {
      track: { ...liveTrack, durationMs: liveTrack.durationMs + 1_000 },
      exactKey: lyricsLookupFingerprint({
        ...liveTrack,
        durationMs: liveTrack.durationMs + 1_000,
      }),
      workKey: lyricsWorkFingerprint(liveTrack),
      keyVersion: 1,
      observedBefore: expect.any(String),
      expectedExact: actualLive,
    });
  });

  it('records fixed unavailable reasons for reads and quarantine comparisons', async () => {
    const remote = fakeRemote({ state: 'unavailable', reason: 'timeout' });
    remote.compareQuarantined.mockResolvedValueOnce({
      state: 'unavailable',
      reason: 'auth',
    });
    const lyrics = repository(fakeStore().store, { mode: 'shadow', remote: remote.remote });

    lyrics.observeRemote(TRACK, structuredClone(POSITIVE_PAYLOAD));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(lyrics.stats()).toMatchObject({
      remoteUnavailable: 1,
      remoteUnavailableByReason: {
        disabled: 0,
        timeout: 1,
        auth: 0,
        network: 0,
        'invalid-response': 0,
        server: 0,
      },
      quarantineComparisons: {
        exact: {
          unavailable: 1,
          unavailableByReason: { auth: 1 },
        },
        work: {
          unavailable: 1,
          unavailableByReason: { auth: 1 },
        },
      },
    });
  });

  it('deduplicates an in-flight quarantine comparison for the same exact key', async () => {
    let finishComparison: (() => void) | undefined;
    const comparisonGate = new Promise<void>((resolve) => {
      finishComparison = resolve;
    });
    const remote = fakeRemote({ state: 'miss' });
    remote.compareQuarantined.mockImplementation(async () => {
      await comparisonGate;
      return {
        state: 'ok',
        exact: { candidateCount: 0, comparisons: 0, agreements: 0, disagreements: 0 },
        work: { candidateCount: 0, comparisons: 0, agreements: 0, disagreements: 0 },
      };
    });
    const lyrics = repository(fakeStore().store, { mode: 'shadow', remote: remote.remote });

    lyrics.observeRemote(TRACK, structuredClone(POSITIVE_PAYLOAD));
    lyrics.observeRemote(TRACK, structuredClone(POSITIVE_PAYLOAD));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(remote.compareQuarantined).toHaveBeenCalledTimes(1);
    lyrics.observeRemote(TRACK, {
      ...structuredClone(POSITIVE_PAYLOAD),
      lines: [{ id: 'different', startMs: 1_000, text: 'A corrected line' }],
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(remote.compareQuarantined).toHaveBeenCalledTimes(2);

    finishComparison?.();
    await comparisonGate;
    await new Promise<void>((resolve) => setImmediate(resolve));

    lyrics.observeRemote(TRACK, structuredClone(POSITIVE_PAYLOAD));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(remote.compareQuarantined).toHaveBeenCalledTimes(3);
  });

  it('never invokes quarantine comparison in primary mode', async () => {
    const remote = fakeRemote({ state: 'miss' });
    const lyrics = repository(fakeStore().store, { mode: 'primary', remote: remote.remote });

    expect(lyrics.observeRemote(TRACK, structuredClone(POSITIVE_PAYLOAD))).toBeUndefined();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(remote.resolve).not.toHaveBeenCalled();
    expect(remote.compareQuarantined).not.toHaveBeenCalled();
  });

  it('records exact/work write outcomes without exposing error messages', async () => {
    const remote = fakeRemote();
    remote.upsertWork.mockRejectedValueOnce(Object.assign(
      new Error('sensitive upstream detail'),
      { reason: 'timeout' },
    ));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const lyrics = repository(fakeStore().store, { mode: 'shadow', remote: remote.remote });

    lyrics.syncExact(TRACK, cachedLyrics(), {
      trust: 'active',
      sourceKind: 'automatic',
    });
    lyrics.rememberWork('midnight circuit::local drive', workLyrics());
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(lyrics.stats().remoteWrites).toEqual({
      exact: {
        attempts: 1,
        successes: 1,
        failures: 0,
        failureByReason: {
          disabled: 0,
          timeout: 0,
          auth: 0,
          network: 0,
          'invalid-response': 0,
          server: 0,
          unknown: 0,
        },
      },
      work: {
        attempts: 1,
        successes: 0,
        failures: 1,
        failureByReason: {
          disabled: 0,
          timeout: 1,
          auth: 0,
          network: 0,
          'invalid-response': 0,
          server: 0,
          unknown: 0,
        },
      },
    });
    expect(JSON.stringify(lyrics.stats())).not.toContain('sensitive upstream detail');
    warning.mockRestore();
  });

  it('fails open and records an unexpected remote client rejection', async () => {
    const fake = fakeStore();
    const remote = fakeRemote();
    remote.resolve.mockRejectedValueOnce(new Error('socket reset'));
    const lyrics = repository(fake.store, { mode: 'primary', remote: remote.remote });

    await expect(lyrics.resolveRemote(TRACK, false)).resolves.toEqual({
      state: 'unavailable',
      reason: 'network',
    });
    expect(lyrics.stats()).toMatchObject({
      remoteRequests: 1,
      remoteUnavailable: 1,
      remoteUnavailableByReason: { network: 1 },
      lastRemoteState: 'unavailable',
      lastRemoteReason: 'network',
    });
  });

  it('preserves timeout classification when the remote client rejects', async () => {
    const remote = fakeRemote();
    const timeout = Object.assign(new Error('deadline exceeded'), {
      name: 'TimeoutError',
    });
    remote.resolve.mockRejectedValueOnce(timeout);
    const lyrics = repository(fakeStore().store, { mode: 'primary', remote: remote.remote });

    await expect(lyrics.resolveRemote(TRACK, false)).resolves.toEqual({
      state: 'unavailable',
      reason: 'timeout',
    });
    expect(lyrics.stats().remoteUnavailableByReason.timeout).toBe(1);
  });

  it('returns unavailable/disabled when no remote library is configured', async () => {
    const lyrics = repository(fakeStore().store, {
      mode: 'primary',
      remote: undefined,
    });

    await expect(lyrics.resolveRemote(TRACK, false)).resolves.toEqual({
      state: 'unavailable',
      reason: 'disabled',
    });
  });

  it('never lets a negative result overwrite a positive exact entry', () => {
    const fake = fakeStore();
    const lyrics = repository(fake.store, { mode: 'off' });
    const positive = cachedLyrics(POSITIVE_PAYLOAD, 'positive');
    const negative = cachedLyrics(MISSING_PAYLOAD, 'negative');

    lyrics.rememberExact(TRACK, 'track-key', positive);
    lyrics.rememberExact(TRACK, 'track-key', negative);

    expect(fake.updateCachedLyrics).toHaveBeenCalledTimes(1);
    expect(fake.state.lyricsCache['track-key']).toEqual(positive);
    expect(lyrics.readTrack('track-key').cached).toEqual(positive);
  });

  it.each([
    ['missing', MISSING_PAYLOAD],
    ['loading', { kind: 'loading', lines: [], provider: null } satisfies LyricsPayload],
    ['original-version fallback', {
      kind: 'plain',
      lines: [{ id: 'fallback', startMs: 0, text: 'Studio lyric' }],
      plainText: 'Studio lyric',
      provider: 'lrclib',
      fallbackKind: 'original-version',
    } satisfies LyricsPayload],
    ['work fallback', {
      kind: 'plain',
      lines: [{ id: 'work-fallback', startMs: 0, text: 'Cached work lyric' }],
      plainText: 'Cached work lyric',
      provider: 'lrclib',
      fallbackKind: 'work-cache',
    } satisfies LyricsPayload],
  ])('does not remotely promote a %s payload as an exact binding', (_label, payload) => {
    const remote = fakeRemote();
    const lyrics = repository(fakeStore().store, { mode: 'shadow', remote: remote.remote });

    lyrics.rememberExact(TRACK, 'track-key', cachedLyrics(payload));

    expect(remote.upsertExact).not.toHaveBeenCalled();
    expect(lyrics.stats().remoteWrites.exact.attempts).toBe(0);
  });

  it('reads work lyrics through L1 and persists/shadows newly remembered work entries', () => {
    const key = 'midnight circuit::local drive';
    const persisted = workLyrics('persisted');
    const fake = fakeStore({ workLyricsCache: { [key]: persisted } });
    const remote = fakeRemote();
    const lyrics = repository(fake.store, {
      mode: 'shadow',
      legacyMaxEntries: 23,
      remote: remote.remote,
    });

    expect(lyrics.readWork(key)).toEqual(persisted);
    delete fake.state.workLyricsCache[key];
    expect(lyrics.readWork(key)).toEqual(persisted);
    expect(fake.readWorkLyrics).toHaveBeenCalledTimes(1);

    const remembered = workLyrics('remembered');
    lyrics.rememberWork(key, remembered);

    expect(fake.updateWorkLyrics).toHaveBeenCalledWith(
      key,
      remembered,
      23,
      8 * 1_024 * 1_024,
    );
    expect(remote.upsertWork).toHaveBeenCalledExactlyOnceWith({
      workKey: key,
      keyVersion: 1,
      cached: remembered,
    });
    expect(lyrics.readWork(key)).toEqual(remembered);
  });

  it('syncs manual lyrics as an active exact binding', () => {
    const fake = fakeStore();
    const remote = fakeRemote();
    const lyrics = repository(fake.store, {
      mode: 'shadow',
      remote: remote.remote,
    });
    const manualPayload: LyricsPayload = {
      kind: 'synced',
      lines: [{ id: 'manual-1', startMs: 0, text: 'My corrected line' }],
      provider: 'manual',
    };
    const cached = cachedLyrics(manualPayload, 'manual');

    lyrics.syncExact(TRACK, cached, {
      trust: 'active',
      sourceKind: 'manual',
      selectionVersion: 123,
    });

    expect(remote.upsertExact).toHaveBeenCalledExactlyOnceWith({
      track: TRACK,
      exactKey: lyricsLookupFingerprint(TRACK),
      keyVersion: 1,
      cached,
      trust: 'active',
      sourceKind: 'manual',
      selectionVersion: 123,
    });
    expect(fake.updateCachedLyrics).not.toHaveBeenCalled();
  });

});
