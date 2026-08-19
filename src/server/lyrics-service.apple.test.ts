import type { TrackMetadata } from '../shared/contracts.js';
import {
  lyricsLookupFingerprint,
  lyricsWorkFingerprint,
  trackFingerprint,
} from '../shared/track.js';
import type {
  CachedLyrics,
  CachedWorkLyrics,
  JsonStore,
  LyricsStoreEntries,
  PersistedState,
} from './store.js';
import { LyricsService } from './lyrics-service.js';

const TRACK: TrackMetadata = {
  title: 'Midnight Circuit',
  artist: '',
  album: 'After Dark',
  durationMs: 214_000,
  source: 'Apple Music',
};

function testStore(overrides: Partial<PersistedState> = {}): JsonStore {
  const state: PersistedState = {
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
  return {
    snapshot: () => structuredClone(state),
    readLyricOffset: (key: string) => state.lyricOffsets[key] ?? 0,
    readLyricsEntries: (key: string): LyricsStoreEntries => ({
      ...(state.lyricOverrides[key] ? { manual: structuredClone(state.lyricOverrides[key]) } : {}),
      ...(state.candidateLyricsOverrides[key]
        ? { candidate: structuredClone(state.candidateLyricsOverrides[key]) }
        : {}),
      ...(state.lyricsCache[key] ? { cached: structuredClone(state.lyricsCache[key]) } : {}),
    }),
    readWorkLyrics: (key: string): CachedWorkLyrics | undefined => (
      state.workLyricsCache[key] ? structuredClone(state.workLyricsCache[key]) : undefined
    ),
    readArtworkPalette: (key: string) => state.artworkPaletteCache[key],
    updateCachedLyrics: async (
      key: string,
      mutator: (current: CachedLyrics | undefined) => CachedLyrics | undefined,
    ) => {
      const next = mutator(state.lyricsCache[key]);
      if (next) state.lyricsCache[key] = structuredClone(next);
      else delete state.lyricsCache[key];
    },
    updateWorkLyrics: async (key: string, value: CachedWorkLyrics | undefined) => {
      if (value) state.workLyricsCache[key] = structuredClone(value);
      else delete state.workLyricsCache[key];
    },
    updateArtworkPalette: async (key: string, value: PersistedState['artworkPaletteCache'][string] | undefined) => {
      if (value) state.artworkPaletteCache[key] = structuredClone(value);
      else delete state.artworkPaletteCache[key];
    },
    update: async (mutator: (draft: PersistedState) => void) => mutator(state),
  } as unknown as JsonStore;
}

const LRCLIB_RESULT = {
  id: 42,
  trackName: 'Midnight Circuit',
  artistName: 'Local Drive',
  albumName: 'After Dark',
  duration: 214,
  instrumental: false,
  plainLyrics: 'Streetlights draw a silver line',
  syncedLyrics: '[00:00.00]Streetlights draw a silver line',
};

function lrclibExactResponse(): object {
  return {
    ok: true,
    status: 200,
    json: async () => LRCLIB_RESULT,
  };
}

function urlFrom(input: string | URL | Request): URL {
  return input instanceof URL
    ? input
    : new URL(typeof input === 'string' ? input : input.url);
}

function pendingUntilAbort(init: RequestInit | undefined): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const signal = init?.signal;
    const rejectWithReason = () => {
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    if (signal?.aborted) {
      rejectWithReason();
      return;
    }
    signal?.addEventListener('abort', rejectWithReason, { once: true });
  });
}

describe('LyricsService Apple Music enrichment', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses canonical Apple metadata for an enriched LRCLIB exact lookup', async () => {
    const appleMusic = {
      resolve: vi.fn(async () => ({ ...TRACK, artist: 'Local Drive' })),
    };
    const fetchMock = vi.fn(async (_input: string | URL | Request) => lrclibExactResponse());
    vi.stubGlobal('fetch', fetchMock);

    const result = await new LyricsService(testStore(), appleMusic).find(TRACK);

    expect(result.kind).toBe('synced');
    expect(result.provider).toBe('lrclib');
    expect(appleMusic.resolve).toHaveBeenCalledTimes(1);
    const requested = fetchMock.mock.calls[0]![0];
    const url = requested instanceof URL
      ? requested
      : new URL(typeof requested === 'string' ? requested : requested.url);
    expect(url.pathname).toBe('/api/get');
    expect(url.searchParams.get('artist_name')).toBe('Local Drive');
    expect(url.searchParams.get('album_name')).toBe('After Dark');
    expect(url.searchParams.get('duration')).toBe('214');
  });

  it('falls back to the original LRCLIB search when Apple Music fails', async () => {
    const appleMusic = {
      resolve: vi.fn(async () => Promise.reject(new Error('apple unavailable'))),
    };
    const fetchMock = vi.fn(async (_input: string | URL | Request) => ({
      ok: true,
      status: 200,
      json: async () => [LRCLIB_RESULT],
    }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await new LyricsService(testStore(), appleMusic).find(TRACK);

    expect(result.kind).toBe('synced');
    const requested = fetchMock.mock.calls[0]![0];
    const url = requested instanceof URL
      ? requested
      : new URL(typeof requested === 'string' ? requested : requested.url);
    expect(url.pathname).toBe('/api/search');
    expect(url.searchParams.has('artist_name')).toBe(false);
  });

  it('does not let an enriched artist make a weak-title LRCLIB candidate reliable', async () => {
    const appleMusic = {
      resolve: vi.fn(async () => ({ ...TRACK, artist: 'Local Drive' })),
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      if (url.pathname === '/api/get') return { ok: false, status: 404, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => [{
          ...LRCLIB_RESULT,
          trackName: 'Midnight Avenue',
        }],
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new LyricsService(testStore(), appleMusic).find(TRACK);

    expect(result.kind).toBe('missing');
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('rejects a different LRCLIB recording version after enrichment', async () => {
    const appleMusic = {
      resolve: vi.fn(async () => ({ ...TRACK, artist: 'Local Drive' })),
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      if (url.pathname === '/api/get') return { ok: false, status: 404, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => [{ ...LRCLIB_RESULT, trackName: 'Midnight Circuit (Live)' }],
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new LyricsService(testStore(), appleMusic).find(TRACK);

    expect(result.kind).toBe('missing');
  });

  it.each([
    ['Midnight Circuit (Live)', '现场版'],
    ['Midnight Circuit - Acoustic Version', '不插电版'],
    ['Midnight Circuit（不插电版）', '不插电版'],
    ['Midnight Circuit（不插電版）', '不插电版'],
  ])('falls back from %s to original static lyrics', async (title, noticeLabel) => {
    const track = { ...TRACK, title, artist: 'Local Drive' };
    const appleMusic = { resolve: vi.fn(async () => track) };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      if (url.pathname === '/api/get') return { ok: false, status: 404, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => [{
          ...LRCLIB_RESULT,
          plainLyrics: null,
          syncedLyrics: '[00:00.00]Oh\n[00:01.00]Oh',
        }],
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new LyricsService(testStore(), appleMusic).find(track);

    expect(result.kind).toBe('plain');
    expect(result.lines.map((line) => line.text)).toEqual([
      'Oh',
      'Oh',
    ]);
    expect(result.notice).toContain(noticeLabel);
    expect(result.providerId).toBe(42);
  });

  it.each([
    'Midnight Circuit（不插电版 Remix）',
    'Midnight Circuit（不插電版 Remaster）',
    'Midnight Circuit（不插电版 Instrumental）',
    'Midnight Circuit（不插电混音版）',
    'Midnight Circuit（不插電重製版）',
    'Midnight Circuit（不插电纯音乐版）',
  ])('does not fall back from unsafe acoustic variant %s', async (title) => {
    const track = { ...TRACK, title, artist: 'Local Drive' };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof URL ? input : new URL(
        typeof input === 'string' ? input : input.url,
      );
      if (url.pathname === '/api/get') {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => [LRCLIB_RESULT],
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new LyricsService(
      testStore(),
      { resolve: async () => track },
    ).find(track);

    expect(result.kind).toBe('missing');
    expect(result.fallbackKind).toBeUndefined();
  });

  it('prefers matching Live lyrics over an original-version fallback', async () => {
    const track = { ...TRACK, title: 'Midnight Circuit (Live)', artist: 'Local Drive' };
    const appleMusic = { resolve: vi.fn(async () => track) };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      if (url.pathname === '/api/get') return { ok: false, status: 404, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => [
          LRCLIB_RESULT,
          {
            ...LRCLIB_RESULT,
            id: 84,
            trackName: 'Midnight Circuit (Live)',
            albumName: 'Live at the Forum',
            duration: 216,
            syncedLyrics: '[00:00.00]Actual live lyrics',
          },
        ],
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new LyricsService(testStore(), appleMusic).find(track);

    expect(result.kind).toBe('synced');
    expect(result.providerId).toBe(84);
    expect(result.notice).toBeUndefined();
  });

  it.each([
    'Midnight Circuit (Live)',
    'Midnight Circuit - Acoustic Version',
  ])('waits for expanded real-version results before using the first-batch fallback for %s', async (
    title,
  ) => {
    const track = { ...TRACK, title, artist: 'Local Drive' };
    const realVersion = {
      ...LRCLIB_RESULT,
      id: 84,
      trackName: title,
      albumName: 'Live and Unplugged',
      syncedLyrics: '[00:00.00]Actual requested version',
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = urlFrom(input);
      if (url.pathname === '/api/get') {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      if (url.searchParams.has('q')) {
        return { ok: true, status: 200, json: async () => [realVersion] };
      }
      return {
        ok: true,
        status: 200,
        json: async () => url.searchParams.get('track_name') === 'Midnight Circuit'
          ? [LRCLIB_RESULT]
          : [],
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new LyricsService(
      testStore(),
      { resolve: async () => track },
    ).find(track);

    expect(result).toEqual(expect.objectContaining({
      kind: 'synced',
      providerId: realVersion.id,
    }));
    expect(result.fallbackKind).toBeUndefined();
    expect(fetchMock.mock.calls.some(([input]) => urlFrom(input).searchParams.has('q')))
      .toBe(true);
  });

  it.each([
    'Midnight Circuit (Live)',
    'Midnight Circuit - Acoustic Version',
  ])('keeps an original fallback for %s retryable when exact times out', async (title) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const track = { ...TRACK, title, artist: 'Local Drive' };
    const store = testStore();
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = urlFrom(input);
      if (url.pathname === '/api/get') return pendingUntilAbort(init);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => url.searchParams.get('track_name') === 'Midnight Circuit'
          ? [LRCLIB_RESULT]
          : [],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new LyricsService(
      store,
      { resolve: async () => track },
      undefined,
      { requestTimeoutMs: 30, lookupBudgetMs: 80 },
    ).find(track);

    expect(result).toEqual(expect.objectContaining({
      kind: 'plain',
      fallbackKind: 'original-version',
      retryable: true,
    }));
    expect(store.snapshot().lyricsCache).toEqual({});
  });

  it('retries with the base title when the versioned search has no original candidate', async () => {
    const track = { ...TRACK, title: 'Midnight Circuit (Live)', artist: 'Local Drive' };
    const appleMusic = { resolve: vi.fn(async () => track) };
    const searchedTitles: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      if (url.pathname === '/api/get') return { ok: false, status: 404, json: async () => ({}) };
      const searchedTitle = url.searchParams.get('track_name') ?? '';
      searchedTitles.push(searchedTitle);
      return {
        ok: true,
        status: 200,
        json: async () => searchedTitle === 'Midnight Circuit' ? [LRCLIB_RESULT] : [],
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new LyricsService(testStore(), appleMusic).find(track);

    expect(result.kind).toBe('plain');
    expect(searchedTitles).toContain('Midnight Circuit (Live)');
    expect(searchedTitles).toContain('Midnight Circuit');
  });

  it('does not use original static lyrics for unsupported versions or a different artist', async () => {
    const cases = [
      { title: 'Midnight Circuit (Remix)', candidateTitle: 'Midnight Circuit', artistName: 'Local Drive' },
      { title: 'Midnight Circuit (Live Remix)', candidateTitle: 'Midnight Circuit', artistName: 'Local Drive' },
      { title: 'Midnight Circuit (Live)', candidateTitle: 'Midnight Circuit', artistName: 'Another Artist' },
      { title: 'Midnight Circuit (Live)', candidateTitle: 'Midnight Circuit (Remastered)', artistName: 'Local Drive' },
      { title: 'Midnight Circuit (Live)', candidateTitle: 'Midnight Circuit', artistName: 'Local Drive', requestedArtist: '' },
    ];

    for (const testCase of cases) {
      const track = {
        ...TRACK,
        title: testCase.title,
        artist: testCase.requestedArtist ?? 'Local Drive',
      };
      const appleMusic = { resolve: vi.fn(async () => track) };
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
        if (url.pathname === '/api/get') return { ok: false, status: 404, json: async () => ({}) };
        return {
          ok: true,
          status: 200,
          json: async () => [{
            ...LRCLIB_RESULT,
            trackName: testCase.candidateTitle,
            artistName: testCase.artistName,
          }],
        };
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = await new LyricsService(testStore(), appleMusic).find(track);

      expect(result.kind).toBe('missing');
      vi.unstubAllGlobals();
    }
  });

  it('continues past a wrong-version LRCLIB candidate to a reliable recording', async () => {
    const appleMusic = {
      resolve: vi.fn(async () => ({ ...TRACK, artist: 'Local Drive' })),
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      if (url.pathname === '/api/get') return { ok: false, status: 404, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => [
          { ...LRCLIB_RESULT, id: 41, trackName: 'Midnight Circuit (Live)' },
          LRCLIB_RESULT,
        ],
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new LyricsService(testStore(), appleMusic).find(TRACK);

    expect(result.kind).toBe('synced');
    expect(result.providerId).toBe(42);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not amplify a non-404 LRCLIB exact failure through Apple Music', async () => {
    const track = { ...TRACK, artist: 'Local Drive' };
    const appleMusic = {
      resolve: vi.fn(async () => ({ ...track, album: 'Canonical Album' })),
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      if (url.pathname === '/api/get') return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => [LRCLIB_RESULT] };
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await new LyricsService(testStore(), appleMusic).find(track);

    expect(result.kind).toBe('synced');
    expect(appleMusic.resolve).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('continues to candidate search when enriched exact metadata has no lyrics', async () => {
    const appleMusic = {
      resolve: vi.fn(async () => ({ ...TRACK, artist: 'Local Drive' })),
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      if (url.pathname === '/api/get') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ...LRCLIB_RESULT, plainLyrics: null, syncedLyrics: null }),
        };
      }
      return { ok: true, status: 200, json: async () => [LRCLIB_RESULT] };
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new LyricsService(testStore(), appleMusic).find(TRACK);

    expect(result.kind).toBe('synced');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps manual LRC ahead of Apple Music and online lookups', async () => {
    const appleMusic = { resolve: vi.fn() };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const track = { ...TRACK, artist: 'Local Drive' };
    const store = testStore({
      lyricOverrides: {
        'midnight circuit::local drive::214': {
          lrc: '[00:00.00]Manual line',
          updatedAt: Date.now(),
        },
      },
    });

    const result = await new LyricsService(store, appleMusic).find(track);

    expect(result.provider).toBe('manual');
    expect(appleMusic.resolve).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.snapshot().workLyricsCache).toEqual({});
  });

  it('refreshes a legacy negative cache entry after the lookup strategy changes', async () => {
    const appleMusic = {
      isConfigured: () => true,
      resolve: vi.fn(async () => ({ ...TRACK, artist: 'Local Drive' })),
    };
    const fetchMock = vi.fn(async () => lrclibExactResponse());
    vi.stubGlobal('fetch', fetchMock);
    const key = trackFingerprint(TRACK);
    const store = testStore({
      lyricsCache: {
        [key]: {
          payload: { kind: 'missing', lines: [], provider: null },
          expiresAt: Date.now() + 60_000,
        },
      },
    });

    const result = await new LyricsService(store, appleMusic).find(TRACK);

    expect(result.kind).toBe('synced');
    expect(appleMusic.resolve).toHaveBeenCalledTimes(1);
    expect(store.snapshot().lyricsCache[key]?.lookupStrategy)
      .toBe('lrclib-multi-v4-simplified-first');
  });

  it('uses a work-level cache only after the Live lookup definitively misses', async () => {
    const original = { ...TRACK, artist: 'Local Drive' };
    const live = { ...original, title: 'Midnight Circuit (Live)' };
    const workKey = lyricsWorkFingerprint(original)!;
    const liveKey = trackFingerprint(live);
    const store = testStore({
      workLyricsCache: {
        [workKey]: {
          schemaVersion: 1,
          plainText: 'Cached original lyrics',
          provider: 'lrclib',
          providerId: 42,
          sourceTitle: original.title,
          sourceArtist: original.artist,
          storedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      },
    });
    const appleMusic = { resolve: vi.fn(async () => live) };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      if (url.pathname === '/api/get') return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => [] };
    });
    vi.stubGlobal('fetch', fetchMock);
    const service = new LyricsService(store, appleMusic);

    const first = await service.find(live);
    const callsAfterOnlineMiss = fetchMock.mock.calls.length;
    const second = await service.find(live);
    await service.find(live, { forceRefresh: true });

    expect(first).toEqual(expect.objectContaining({
      kind: 'plain',
      fallbackKind: 'work-cache',
      plainText: 'Cached original lyrics',
    }));
    expect(second.fallbackKind).toBe('work-cache');
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterOnlineMiss);
    expect(store.snapshot().lyricsCache[liveKey]).toEqual(expect.objectContaining({
      payload: expect.objectContaining({ kind: 'missing' }),
      metadataSignature: lyricsLookupFingerprint(live),
    }));
  });

  it('reuses lyrics learned from an original recording when a later Live lookup misses', async () => {
    const original = { ...TRACK, artist: 'Local Drive' };
    const live = { ...original, title: 'Midnight Circuit (Live)' };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      if (url.pathname === '/api/get') {
        return url.searchParams.get('track_name') === original.title
          ? lrclibExactResponse()
          : { ok: false, status: 404, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => [] };
    });
    vi.stubGlobal('fetch', fetchMock);
    const store = testStore();
    const service = new LyricsService(store, { resolve: async (track) => track });

    const originalResult = await service.find(original);
    const liveResult = await service.find(live);

    expect(originalResult.kind).toBe('synced');
    expect(liveResult).toEqual(expect.objectContaining({
      kind: 'plain',
      fallbackKind: 'work-cache',
      plainText: 'Streetlights draw a silver line',
    }));
  });

  it('still prefers online Live lyrics over an existing work-level cache', async () => {
    const original = { ...TRACK, artist: 'Local Drive' };
    const live = { ...original, title: 'Midnight Circuit (Live)' };
    const workKey = lyricsWorkFingerprint(original)!;
    const store = testStore({
      workLyricsCache: {
        [workKey]: {
          schemaVersion: 1,
          plainText: 'Cached original lyrics',
          provider: 'lrclib',
          sourceTitle: original.title,
          sourceArtist: original.artist,
          storedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      },
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ...LRCLIB_RESULT,
        id: 84,
        trackName: live.title,
        syncedLyrics: '[00:00.00]Actual Live lyrics',
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new LyricsService(store, { resolve: async () => live }).find(live);

    expect(result.kind).toBe('synced');
    expect(result.providerId).toBe(84);
    expect(result.fallbackKind).toBeUndefined();
  });

  it('shows work-level static lyrics while temporary failures remain retryable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const original = { ...TRACK, artist: 'Local Drive' };
    const live = { ...original, title: 'Midnight Circuit (Live)' };
    const workKey = lyricsWorkFingerprint(original)!;
    const store = testStore({
      workLyricsCache: {
        [workKey]: {
          schemaVersion: 1,
          plainText: 'Cached original lyrics',
          provider: 'lrclib',
          sourceTitle: original.title,
          sourceArtist: original.artist,
          storedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('temporary outage'))));

    const result = await new LyricsService(store, { resolve: async () => live }).find(live);

    expect(result).toEqual(expect.objectContaining({
      kind: 'plain',
      retryable: true,
      fallbackKind: 'work-cache',
    }));
    expect(store.snapshot().lyricsCache).toEqual({});
  });

  it('does not seed the work cache from a Remastered recording', async () => {
    const remastered = {
      ...TRACK,
      title: 'Midnight Circuit (Remastered)',
      artist: 'Local Drive',
    };
    const store = testStore();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ...LRCLIB_RESULT, trackName: remastered.title }),
    })));

    const result = await new LyricsService(store, { resolve: async () => remastered }).find(remastered);

    expect(result.kind).toBe('synced');
    expect(store.snapshot().workLyricsCache).toEqual({});
  });
});
