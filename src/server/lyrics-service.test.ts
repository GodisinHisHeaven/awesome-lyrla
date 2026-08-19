import type { LyricsPayload, TrackMetadata } from '../shared/contracts.js';
import {
  lyricsLookupFingerprint,
  lyricsWorkFingerprint,
  trackFingerprint,
} from '../shared/track.js';
import {
  LyricsRepository,
  type LyricsLibraryClient,
} from './lyrics-repository.js';
import type { CachedLyrics, CachedWorkLyrics, LyricsStoreEntries, PersistedState } from './store.js';
import { LyricsService } from './lyrics-service.js';
import type { JsonStore } from './store.js';

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

const RESULT = {
  id: 42,
  trackName: 'Midnight Circuit',
  artistName: 'Local Drive',
  albumName: 'After Dark',
  duration: 214,
  instrumental: false,
  plainLyrics: 'Streetlights draw a silver line',
  syncedLyrics: '[00:00.00]Streetlights draw a silver line',
};

const CANDIDATE_TRACK: TrackMetadata = {
  title: 'Midnight Circuit',
  artist: 'Local Drive',
  album: 'After Dark',
  durationMs: 214_000,
  source: 'Apple Music',
};

describe('LyricsService offsets', () => {
  it('reads one offset without cloning the full store snapshot', () => {
    const key = trackFingerprint(CANDIDATE_TRACK);
    const store = testStore({ lyricOffsets: { [key]: 1_200 } });
    store.snapshot = vi.fn(() => {
      throw new Error('full snapshot should not be read');
    });

    expect(new LyricsService(store).getOffset(CANDIDATE_TRACK)).toBe(1_200);
    expect(store.snapshot).not.toHaveBeenCalled();
  });
});

const CANDIDATE_RESULT = {
  ...RESULT,
  plainLyrics: 'Plain line one\nPlain line two\nPlain line three\nPrivate plain line four',
  syncedLyrics: '[00:00.00]Synced line one\n[00:04.00]Synced line two',
};

function candidateFetch(result = CANDIDATE_RESULT) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => [result],
  }));
}

const SCALED_TIMING = {
  requestTimeoutMs: 80,
  lookupBudgetMs: 120,
} as const;

function urlFrom(input: string | URL | Request): URL {
  return input instanceof URL
    ? input
    : new URL(typeof input === 'string' ? input : input.url);
}

function jsonResponse(json: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
  };
}

function delayedResponse<T>(
  init: RequestInit | undefined,
  delayMs: number,
  value: T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const signal = init?.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    }, delayMs);
  });
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

async function candidateToken(
  service: LyricsService,
  track: TrackMetadata = CANDIDATE_TRACK,
): Promise<string> {
  const result = await service.listCandidates(track);
  expect(result.candidates).toHaveLength(1);
  return result.candidates[0]!.token;
}

describe('LyricsService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('searches and matches by title, album, and duration when artist is absent', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => [
        {
          id: 42,
          trackName: 'Midnight Circuit',
          artistName: 'Local Drive',
          albumName: 'After Dark',
          duration: 214,
          instrumental: false,
          plainLyrics: 'Streetlights draw a silver line',
          syncedLyrics: '[00:00.00]Streetlights draw a silver line',
        },
      ],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result: LyricsPayload = await new LyricsService(testStore()).find({
      title: 'Midnight Circuit',
      artist: '',
      album: 'After Dark',
      durationMs: 214_000,
      source: '',
    });

    expect(result.kind).toBe('synced');
    expect(result.provider).toBe('lrclib');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requested = fetchMock.mock.calls[0]![0];
    const requestedUrl = requested instanceof URL
      ? requested
      : new URL(typeof requested === 'string' ? requested : requested.url);
    expect(requestedUrl.pathname).toBe('/api/search');
    expect(requestedUrl.searchParams.get('track_name')).toBe('Midnight Circuit');
    expect(requestedUrl.searchParams.has('artist_name')).toBe(false);
  });

  it('bounds LRCLIB candidate search fanout', async () => {
    let activeRequests = 0;
    let peakRequests = 0;
    const fetchMock = vi.fn(async () => {
      activeRequests += 1;
      peakRequests = Math.max(peakRequests, activeRequests);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeRequests -= 1;
      return {
        ok: true,
        status: 200,
        json: async () => [RESULT],
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new LyricsService(
      testStore(),
      { resolve: async () => null },
    ).listCandidates({
      title: 'Midnight Circuit (Live) (feat. Nova) [Official Audio]',
      artist: 'Local Drive',
      album: 'After Dark',
      durationMs: 214_000,
      source: 'Apple Music',
    });

    expect(result.candidates.length).toBeGreaterThan(0);
    expect(peakRequests).toBeLessThanOrEqual(4);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(4);
  });

  it('coalesces concurrent lookups for the same track', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchMock = vi.fn(async () => {
      await gate;
      return {
        ok: true,
        status: 200,
        json: async () => [],
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    const service = new LyricsService(testStore(), { resolve: async () => null });
    const track = {
      title: 'Midnight Circuit',
      artist: '',
      album: 'After Dark',
      durationMs: 214_000,
      source: '',
    };

    const first = service.find(track);
    const second = service.find({ ...track });
    release?.();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not persist a temporary service failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () => Promise.reject(new Error('temporary outage')));
    vi.stubGlobal('fetch', fetchMock);
    const store = testStore();
    const track = {
      title: 'Midnight Circuit',
      artist: '',
      album: 'After Dark',
      durationMs: 214_000,
      source: '',
    };

    const result = await new LyricsService(store, { resolve: async () => null }).find(track);

    expect(result).toEqual(expect.objectContaining({ kind: 'missing', retryable: true }));
    expect(store.snapshot().lyricsCache).toEqual({});
  });

  it('accepts a response slower than the former search timeout but inside the new timeout', async () => {
    const store = testStore();
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
      delayedResponse(init, 35, jsonResponse([RESULT])));
    vi.stubGlobal('fetch', fetchMock);
    const service = new LyricsService(
      store,
      { resolve: async () => null },
      undefined,
      SCALED_TIMING,
    );

    const track: TrackMetadata = {
      ...CANDIDATE_TRACK,
      artist: '',
      source: '',
    };

    const result = await service.find(track);

    expect(result).toEqual(expect.objectContaining({
      kind: 'synced',
      providerId: RESULT.id,
    }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.snapshot().lyricsCache[trackFingerprint(track)]?.lookupStrategy)
      .toBe('lrclib-multi-v4-simplified-first');
  });

  it('keeps exact authoritative when parallel search finishes first and cancels search', async () => {
    const searchCandidate = {
      ...RESULT,
      id: 84,
      syncedLyrics: '[00:00.00]Search result',
    };
    let searchSignal: AbortSignal | null = null;
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = urlFrom(input);
      if (url.pathname === '/api/get') {
        return delayedResponse(init, 35, jsonResponse(RESULT));
      }
      searchSignal = init?.signal ?? null;
      return delayedResponse(init, 10, jsonResponse([searchCandidate]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const store = testStore();
    const service = new LyricsService(
      store,
      { resolve: async (track) => track },
      undefined,
      SCALED_TIMING,
    );

    const result = await service.find(CANDIDATE_TRACK);

    expect(result).toEqual(expect.objectContaining({
      kind: 'synced',
      providerId: RESULT.id,
    }));
    expect(searchSignal).not.toBeNull();
    expect(searchSignal!.aborted).toBe(true);
    expect(store.snapshot().workLyricsCache[lyricsWorkFingerprint(CANDIDATE_TRACK)!]?.providerId)
      .toBe(RESULT.id);
  });

  it('uses a safe native Simplified search result for a Traditional exact hit', async () => {
    const track: TrackMetadata = {
      title: '单车',
      artist: '陈奕迅',
      album: 'Shall We Dance? Shall We Talk!',
      durationMs: 209_000,
      source: 'Apple Music',
    };
    const traditional = {
      id: 14737395,
      trackName: '單車',
      artistName: '陳奕迅',
      albumName: track.album,
      duration: 208.627,
      instrumental: false,
      plainLyrics: '不要不要假設我知道\n一切一切也都是為我而做\n為何這麼偉大 如此感覺不到',
      syncedLyrics: [
        '[00:14.000]不要不要假設我知道',
        '[00:18.000]一切一切也都是為我而做',
        '[00:22.000]為何這麼偉大 如此感覺不到',
      ].join('\n'),
    };
    const simplified = {
      ...traditional,
      id: 14737396,
      trackName: track.title,
      artistName: track.artist,
      plainLyrics: '不要不要假设我知道\n一切一切也都是为我而做\n为何这么伟大 如此感觉不到',
      syncedLyrics: [
        '[00:14.000]不要不要假设我知道',
        '[00:18.000]一切一切也都是为我而做',
        '[00:22.000]为何这么伟大 如此感觉不到',
      ].join('\n'),
    };
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = urlFrom(input);
      return delayedResponse(
        init,
        url.pathname === '/api/get' ? 35 : 10,
        jsonResponse(url.pathname === '/api/get' ? traditional : [traditional, simplified]),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new LyricsService(
      testStore(),
      { resolve: async () => track },
      undefined,
      SCALED_TIMING,
    ).find(track);

    expect(result).toMatchObject({
      kind: 'synced',
      provider: 'lrclib',
      providerId: simplified.id,
    });
    expect(result.lines.map((line) => line.text)).toEqual([
      '不要不要假设我知道',
      '一切一切也都是为我而做',
      '为何这么伟大 如此感觉不到',
    ]);
  });

  it('continues searching when the exact result mixes Traditional and Simplified text', async () => {
    const track: TrackMetadata = {
      title: '单车',
      artist: '陈奕迅',
      album: 'Shall We Dance? Shall We Talk!',
      durationMs: 209_000,
      source: 'Apple Music',
    };
    const mixed = {
      id: 14737395,
      trackName: '單車',
      artistName: '陳奕迅',
      albumName: track.album,
      duration: 208.627,
      instrumental: false,
      plainLyrics: '不要不要假設我知道\n一切一切也都是为我而做\n为何这么伟大 如此感觉不到',
      syncedLyrics: [
        '[00:14.000]不要不要假設我知道',
        '[00:18.000]一切一切也都是为我而做',
        '[00:22.000]为何这么伟大 如此感觉不到',
      ].join('\n'),
    };
    const simplified = {
      ...mixed,
      id: 14737396,
      trackName: track.title,
      artistName: track.artist,
      plainLyrics: '不要不要假设我知道\n一切一切也都是为我而做\n为何这么伟大 如此感觉不到',
      syncedLyrics: [
        '[00:14.000]不要不要假设我知道',
        '[00:18.000]一切一切也都是为我而做',
        '[00:22.000]为何这么伟大 如此感觉不到',
      ].join('\n'),
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = urlFrom(input);
      return jsonResponse(url.pathname === '/api/get' ? mixed : [mixed, simplified]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new LyricsService(
      testStore(),
      { resolve: async () => track },
      undefined,
      SCALED_TIMING,
    ).find(track);

    expect(result).toMatchObject({ kind: 'synced', providerId: simplified.id });
    expect(result.lines.map((line) => line.text)).toEqual([
      '不要不要假设我知道',
      '一切一切也都是为我而做',
      '为何这么伟大 如此感觉不到',
    ]);
  });

  it('keeps a Traditional exact hit when the Simplified result is a different recording', async () => {
    const track: TrackMetadata = {
      title: '单车',
      artist: '陈奕迅',
      album: 'Shall We Dance? Shall We Talk!',
      durationMs: 209_000,
      source: 'Apple Music',
    };
    const traditional = {
      id: 14737395,
      trackName: '單車',
      artistName: '陳奕迅',
      albumName: track.album,
      duration: 208.627,
      instrumental: false,
      plainLyrics: '不要不要假設我知道\n一切一切也都是為我而做\n為何這麼偉大 如此感覺不到',
      syncedLyrics: '[00:14.000]不要不要假設我知道\n[00:18.000]一切一切也都是為我而做\n[00:22.000]為何這麼偉大 如此感覺不到',
    };
    const differentRecording = {
      ...traditional,
      id: 14737396,
      trackName: track.title,
      artistName: track.artist,
      duration: 215,
      plainLyrics: '不要不要假设我知道\n一切一切也都是为我而做\n为何这么伟大 如此感觉不到',
      syncedLyrics: '[00:14.000]不要不要假设我知道\n[00:18.000]一切一切也都是为我而做\n[00:22.000]为何这么伟大 如此感觉不到',
    };
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) =>
      jsonResponse(urlFrom(input).pathname === '/api/get'
        ? traditional
        : [traditional, differentRecording])));

    const result = await new LyricsService(
      testStore(),
      { resolve: async () => track },
    ).find(track);

    expect(result).toMatchObject({
      kind: 'synced',
      providerId: traditional.id,
    });
    expect(result.lines[0]?.text).toBe('不要不要假設我知道');
  });

  it('continues into script-alias strategies after a reliable Traditional search hit', async () => {
    const track: TrackMetadata = {
      title: '单车',
      artist: '陈奕迅',
      album: 'Shall We Dance? Shall We Talk!',
      durationMs: 209_000,
      source: 'Apple Music',
    };
    const traditional = {
      id: 14737395,
      trackName: '單車',
      artistName: '陳奕迅',
      albumName: track.album,
      duration: 208.627,
      instrumental: false,
      plainLyrics: '不要不要假設我知道\n一切一切也都是為我而做\n為何這麼偉大 如此感覺不到',
      syncedLyrics: '[00:14.000]不要不要假設我知道\n[00:18.000]一切一切也都是為我而做\n[00:22.000]為何這麼偉大 如此感覺不到',
    };
    const simplified = {
      ...traditional,
      id: 14737396,
      trackName: track.title,
      artistName: track.artist,
      plainLyrics: '不要不要假设我知道\n一切一切也都是为我而做\n为何这么伟大 如此感觉不到',
      syncedLyrics: '[00:14.000]不要不要假设我知道\n[00:18.000]一切一切也都是为我而做\n[00:22.000]为何这么伟大 如此感觉不到',
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = urlFrom(input);
      if (url.pathname === '/api/get') return jsonResponse({}, 404);
      const query = decodeURIComponent(url.search);
      return jsonResponse(
        query.includes('單車') || query.includes('陳奕迅')
          ? [traditional, simplified]
          : [traditional],
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new LyricsService(testStore(), { resolve: async () => track })
      .find(track);

    expect(result).toMatchObject({ kind: 'synced', providerId: simplified.id });
    expect(fetchMock.mock.calls.some(([input]) => {
      const query = decodeURIComponent(urlFrom(input).search);
      return query.includes('單車') || query.includes('陳奕迅');
    })).toBe(true);
  });

  it('bounds the extra wait for a Simplified variant and keeps the Traditional exact hit', async () => {
    const track: TrackMetadata = {
      title: '单车',
      artist: '陈奕迅',
      album: 'Shall We Dance? Shall We Talk!',
      durationMs: 209_000,
      source: 'Apple Music',
    };
    const traditional = {
      id: 14737395,
      trackName: '單車',
      artistName: '陳奕迅',
      albumName: track.album,
      duration: 208.627,
      instrumental: false,
      plainLyrics: '不要不要假設我知道',
      syncedLyrics: '[00:14.000]不要不要假設我知道',
    };
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) =>
      urlFrom(input).pathname === '/api/get'
        ? Promise.resolve(jsonResponse(traditional))
        : pendingUntilAbort(init));
    vi.stubGlobal('fetch', fetchMock);
    const startedAt = performance.now();

    const result = await new LyricsService(
      testStore(),
      { resolve: async () => track },
      undefined,
      { requestTimeoutMs: 2_000, lookupBudgetMs: 2_000 },
    ).find(track);

    expect(performance.now() - startedAt).toBeLessThan(900);
    expect(result).toMatchObject({
      kind: 'synced',
      providerId: traditional.id,
    });
    expect(result.retryable).not.toBe(true);
  });

  it('can restrict conservative bulk imports to the exact endpoint', async () => {
    const liveTrack: TrackMetadata = {
      ...CANDIDATE_TRACK,
      title: 'Midnight Circuit (Live at Chicago)',
      album: 'Live at Chicago',
    };
    const wrongVenue = {
      ...RESULT,
      id: 84,
      trackName: 'Midnight Circuit (Live at Wembley)',
      albumName: 'Live at Wembley',
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = urlFrom(input);
      return url.pathname === '/api/get'
        ? jsonResponse({}, 404)
        : jsonResponse([wrongVenue]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new LyricsService(
      testStore(),
      { resolve: async (track) => track },
    ).find(liveTrack, { forceRefresh: true, exactOnly: true });

    expect(result.kind).toBe('missing');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.every(([input]) => urlFrom(input).pathname === '/api/get'))
      .toBe(true);
  });

  it('uses a completed search hit when the parallel exact request times out', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = urlFrom(input);
      if (url.pathname === '/api/get') return pendingUntilAbort(init);
      return delayedResponse(init, 10, jsonResponse([RESULT]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const store = testStore();
    const service = new LyricsService(
      store,
      { resolve: async (track) => track },
      undefined,
      { requestTimeoutMs: 30, lookupBudgetMs: 80 },
    );

    const result = await service.find(CANDIDATE_TRACK);

    expect(result).toEqual(expect.objectContaining({
      kind: 'synced',
      providerId: RESULT.id,
    }));
    expect(result.retryable).not.toBe(true);
    expect(service.cacheStats().lrclib.timeouts).toBe(1);
    expect(store.snapshot().lyricsCache[trackFingerprint(CANDIDATE_TRACK)]?.lookupStrategy)
      .toBe('lrclib-multi-v4-simplified-first');
  });

  it('aborts the remaining strategies at one shared budget without negative-caching', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return pendingUntilAbort(init);
    });
    vi.stubGlobal('fetch', fetchMock);
    const store = testStore();
    const service = new LyricsService(
      store,
      { resolve: async (track) => track },
      undefined,
      { requestTimeoutMs: 30, lookupBudgetMs: 55 },
    );
    const startedAt = performance.now();

    const result = await service.find(CANDIDATE_TRACK);

    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(result).toEqual(expect.objectContaining({
      kind: 'missing',
      retryable: true,
    }));
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(store.snapshot().lyricsCache).toEqual({});
  });

  it('refreshes an active v2 missing entry and stores the result as v3', async () => {
    const key = trackFingerprint(CANDIDATE_TRACK);
    const store = testStore({
      lyricsCache: {
        [key]: {
          payload: { kind: 'missing', lines: [], provider: null },
          lookupStrategy: 'lrclib-multi-v2',
          metadataSignature: lyricsLookupFingerprint(CANDIDATE_TRACK),
          expiresAt: Date.now() + 60_000,
        },
      },
    });
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) =>
      urlFrom(input).pathname === '/api/get'
        ? Promise.resolve(jsonResponse(RESULT))
        : pendingUntilAbort(init));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new LyricsService(
      store,
      { resolve: async (track) => track },
      undefined,
      SCALED_TIMING,
    ).find(CANDIDATE_TRACK);

    expect(result).toEqual(expect.objectContaining({ providerId: RESULT.id }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.snapshot().lyricsCache[key]?.lookupStrategy)
      .toBe('lrclib-multi-v4-simplified-first');
  });

  it('continues to serve an active v2 positive entry without going online', async () => {
    const key = trackFingerprint(CANDIDATE_TRACK);
    const cachedPayload: LyricsPayload = {
      kind: 'synced',
      lines: [{ id: 'v2-positive', startMs: 0, text: 'Still valid' }],
      provider: 'lrclib',
      providerId: 7,
    };
    const store = testStore({
      lyricsCache: {
        [key]: {
          payload: cachedPayload,
          lookupStrategy: 'lrclib-multi-v2',
          metadataSignature: lyricsLookupFingerprint(CANDIDATE_TRACK),
          expiresAt: Date.now() + 60_000,
        },
      },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(new LyricsService(store).find(CANDIDATE_TRACK)).resolves.toEqual(cachedPayload);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.snapshot().lyricsCache[key]?.lookupStrategy).toBe('lrclib-multi-v2');
  });

  it('refreshes one old automatic Traditional cache entry for the Simplified policy epoch', async () => {
    const track: TrackMetadata = {
      title: '单车',
      artist: '陈奕迅',
      album: 'Shall We Dance? Shall We Talk!',
      durationMs: 209_000,
      source: 'Apple Music',
    };
    const key = trackFingerprint(track);
    const traditional = {
      id: 14737395,
      trackName: '單車',
      artistName: '陳奕迅',
      albumName: track.album,
      duration: 208.627,
      instrumental: false,
      plainLyrics: '不要不要假設我知道',
      syncedLyrics: '[00:14.000]不要不要假設我知道',
    };
    const store = testStore({
      lyricsCache: {
        [key]: {
          payload: {
            kind: 'synced',
            lines: [{ id: 'old', startMs: 14_000, text: '不要不要假設我知道' }],
            provider: 'lrclib',
            providerId: traditional.id,
          },
          lookupStrategy: 'lrclib-multi-v3',
          metadataSignature: lyricsLookupFingerprint(track),
          expiresAt: Date.now() + 60_000,
        },
      },
    });
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      jsonResponse(urlFrom(input).pathname === '/api/get' ? traditional : []));
    vi.stubGlobal('fetch', fetchMock);
    const service = new LyricsService(
      store,
      { resolve: async () => track },
      undefined,
      SCALED_TIMING,
    );

    await expect(service.find(track)).resolves.toMatchObject({
      kind: 'synced',
      providerId: traditional.id,
    });
    const requestsAfterRefresh = fetchMock.mock.calls.length;
    expect(requestsAfterRefresh).toBeGreaterThan(0);
    expect(store.snapshot().lyricsCache[key]?.lookupStrategy)
      .toBe('lrclib-multi-v4-simplified-first');

    await service.find(track);
    expect(fetchMock).toHaveBeenCalledTimes(requestsAfterRefresh);
  });

  it('keeps an old Traditional cache entry visible when its policy refresh times out', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const track: TrackMetadata = {
      title: '单车',
      artist: '陈奕迅',
      album: 'Shall We Dance? Shall We Talk!',
      durationMs: 209_000,
      source: 'Apple Music',
    };
    const key = trackFingerprint(track);
    const cachedPayload: LyricsPayload = {
      kind: 'synced',
      lines: [{ id: 'old', startMs: 14_000, text: '不要不要假設我知道' }],
      provider: 'lrclib',
      providerId: 14737395,
    };
    const store = testStore({
      lyricsCache: {
        [key]: {
          payload: cachedPayload,
          lookupStrategy: 'lrclib-multi-v3',
          metadataSignature: lyricsLookupFingerprint(track),
          expiresAt: Date.now() + 60_000,
        },
      },
    });
    vi.stubGlobal('fetch', vi.fn((_input: string | URL | Request, init?: RequestInit) =>
      pendingUntilAbort(init)));

    const result = await new LyricsService(
      store,
      { resolve: async () => track },
      undefined,
      SCALED_TIMING,
    ).find(track);

    expect(result).toMatchObject({
      kind: 'synced',
      providerId: 14737395,
      retryable: true,
    });
    expect(result.lines[0]?.text).toBe('不要不要假設我知道');
    expect(store.snapshot().lyricsCache[key]).toMatchObject({
      payload: cachedPayload,
      lookupStrategy: 'lrclib-multi-v3',
    });
  });

  it('does not replace an old Traditional lyric with a provisional instrumental result', async () => {
    const track: TrackMetadata = {
      title: '单车',
      artist: '陈奕迅',
      album: 'Shall We Dance? Shall We Talk!',
      durationMs: 209_000,
      source: 'Apple Music',
    };
    const key = trackFingerprint(track);
    const cachedPayload: LyricsPayload = {
      kind: 'synced',
      lines: [{ id: 'old', startMs: 14_000, text: '不要不要假設我知道' }],
      provider: 'lrclib',
      providerId: 14737395,
    };
    const store = testStore({
      lyricsCache: {
        [key]: {
          payload: cachedPayload,
          lookupStrategy: 'lrclib-multi-v3',
          metadataSignature: lyricsLookupFingerprint(track),
          expiresAt: Date.now() + 60_000,
        },
      },
    });
    const instrumental = {
      id: 14737395,
      trackName: '單車',
      artistName: '陳奕迅',
      albumName: track.album,
      duration: 208.627,
      instrumental: true,
      plainLyrics: null,
      syncedLyrics: null,
    };
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) =>
      jsonResponse(urlFrom(input).pathname === '/api/get' ? instrumental : [])));

    const result = await new LyricsService(
      store,
      { resolve: async () => track },
      undefined,
      SCALED_TIMING,
    ).find(track);

    expect(result).toMatchObject({ kind: 'synced', providerId: 14737395 });
    expect(result.lines[0]?.text).toBe('不要不要假設我知道');
    expect(store.snapshot().lyricsCache[key]?.lookupStrategy)
      .toBe('lrclib-multi-v4-simplified-first');
  });

  it('persists a definitive miss and refreshes it when album metadata improves', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [],
    }));
    vi.stubGlobal('fetch', fetchMock);
    const store = testStore();
    const service = new LyricsService(store, { resolve: async () => null });
    const incomplete = {
      title: 'Midnight Circuit',
      artist: '',
      album: '',
      durationMs: 214_000,
      source: '',
    };

    const first = await service.find(incomplete);
    const cached = store.snapshot().lyricsCache[trackFingerprint(incomplete)];
    expect(first.retryable).not.toBe(true);
    expect(cached?.metadataSignature).toBe(lyricsLookupFingerprint(incomplete));

    await service.find({ ...incomplete, album: 'After Dark' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('serves an expired positive cache immediately and marks it for background refresh', async () => {
    const key = trackFingerprint(CANDIDATE_TRACK);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const store = testStore({
      lyricsCache: {
        [key]: {
          payload: {
            kind: 'synced',
            lines: [{ id: 'cached', startMs: 0, text: 'Stale but useful' }],
            provider: 'lrclib',
            providerId: 42,
          },
          lookupStrategy: 'lrclib-multi-v2',
          metadataSignature: lyricsLookupFingerprint(CANDIDATE_TRACK),
          expiresAt: Date.now() - 1,
        },
      },
    });

    const result = await new LyricsService(store, { resolve: async () => null }).find(
      CANDIDATE_TRACK,
    );

    expect(result).toEqual(expect.objectContaining({
      kind: 'synced',
      retryable: true,
      notice: expect.stringContaining('本地缓存'),
    }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses narrow per-track reads for a hot cache hit', async () => {
    const key = trackFingerprint(CANDIDATE_TRACK);
    const cached = {
      payload: {
        kind: 'synced' as const,
        lines: [{ id: 'cached', startMs: 0, text: 'Immediate cache hit' }],
        provider: null,
      },
      lookupStrategy: 'lrclib-multi-v2',
      metadataSignature: lyricsLookupFingerprint(CANDIDATE_TRACK),
      expiresAt: Date.now() + 60_000,
    };
    const store = testStore();
    store.readLyricsEntries = vi.fn(() => ({ cached }));
    store.readWorkLyrics = vi.fn(() => undefined);
    store.snapshot = vi.fn(() => {
      throw new Error('full snapshot should not be read');
    });

    const result = await new LyricsService(store, { resolve: async () => null }).find(
      CANDIDATE_TRACK,
    );

    expect(result.kind).toBe('synced');
    expect(store.readLyricsEntries).toHaveBeenCalledWith(key);
    expect(store.snapshot).not.toHaveBeenCalled();
  });

  it('does not coalesce different album lookups or let an older miss replace newer lyrics', async () => {
    const responses: Array<(value: object) => void> = [];
    const fetchMock = vi.fn(() => {
      if (responses.length >= 2) {
        return Promise.resolve({ ok: true, status: 200, json: async () => [] });
      }
      return new Promise<object>((resolve) => responses.push(resolve));
    });
    vi.stubGlobal('fetch', fetchMock);
    const store = testStore();
    const service = new LyricsService(store, { resolve: async () => null });
    const track = {
      title: 'Midnight Circuit',
      artist: '',
      album: 'First Album',
      durationMs: 214_000,
      source: '',
    };

    const older = service.find(track);
    const newer = service.find({ ...track, album: 'Correct Album' }, { forceRefresh: true });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    responses[1]?.({
      ok: true,
      status: 200,
      json: async () => [{
        id: 77,
        trackName: 'Midnight Circuit',
        artistName: 'Local Drive',
        albumName: 'Correct Album',
        duration: 214,
        instrumental: false,
        plainLyrics: null,
        syncedLyrics: '[00:00.00]Newest lyrics',
      }],
    });
    await newer;
    responses[0]?.({ ok: true, status: 200, json: async () => [] });
    await older;

    expect(store.snapshot().lyricsCache[trackFingerprint(track)]?.payload.providerId).toBe(77);
  });

  it('finds lyrics through a cleaned title variant', async () => {
    const requestedUrls: URL[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      requestedUrls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => url.searchParams.get('track_name') === 'Midnight Circuit'
          ? [RESULT]
          : [],
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new LyricsService(testStore(), { resolve: async () => null }).find({
      title: 'Midnight Circuit (Official Audio)',
      artist: '',
      album: 'After Dark',
      durationMs: 214_000,
      source: '',
    });

    expect(result.kind).toBe('synced');
    expect(requestedUrls.some((url) =>
      url.searchParams.get('track_name') === 'Midnight Circuit')).toBe(true);
  });

  it('finds lyrics through LRCLIB broad q search', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      if (!url.searchParams.has('q')) throw new Error('fielded search unavailable');
      return {
        ok: true,
        status: 200,
        json: async () => [RESULT],
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new LyricsService(testStore(), { resolve: async () => null }).find({
      title: 'Midnight Circuit',
      artist: '',
      album: 'After Dark',
      durationMs: 214_000,
      source: '',
    });

    expect(result.kind).toBe('synced');
    expect(fetchMock.mock.calls.some(([input]) => {
      const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      return url.searchParams.has('q');
    })).toBe(true);
  });

  it('continues after a partial search failure and does not persist an incomplete miss', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      if (url.searchParams.has('q')) throw new Error('q unavailable');
      return { ok: true, status: 200, json: async () => [] };
    });
    vi.stubGlobal('fetch', fetchMock);
    const store = testStore();

    const result = await new LyricsService(store, { resolve: async () => null }).find({
      title: 'Unknown Track',
      artist: '',
      album: '',
      durationMs: 180_000,
      source: '',
    });

    expect(result).toEqual(expect.objectContaining({ kind: 'missing', retryable: true }));
    expect(store.snapshot().lyricsCache).toEqual({});
  });

  it('uses the second reliable candidate when the highest-ranked record has no lyrics', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [
        { ...RESULT, id: 41, plainLyrics: null, syncedLyrics: null },
        RESULT,
      ],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new LyricsService(testStore(), { resolve: async () => null }).find({
      title: 'Midnight Circuit',
      artist: '',
      album: 'After Dark',
      durationMs: 214_000,
      source: '',
    });

    expect(result.providerId).toBe(42);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves an instrumental result when the requested title explicitly identifies it', async () => {
    const track: TrackMetadata = {
      ...CANDIDATE_TRACK,
      title: 'Midnight Circuit (Instrumental)',
    };
    const instrumental = {
      ...RESULT,
      trackName: track.title,
      instrumental: true,
      plainLyrics: null,
      syncedLyrics: null,
    };
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) =>
      jsonResponse(urlFrom(input).pathname === '/api/get' ? instrumental : [])));

    await expect(new LyricsService(testStore(), { resolve: async () => track }).find(track))
      .resolves.toMatchObject({
        kind: 'plain',
        lines: [],
        plainText: '这是一首纯音乐',
        provider: 'lrclib',
      });
  });

  it('stores reliable original lyrics as a work-level static fallback', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => RESULT,
    }));
    vi.stubGlobal('fetch', fetchMock);
    const store = testStore();
    const track = {
      title: 'Midnight Circuit',
      artist: 'Local Drive',
      album: 'After Dark',
      durationMs: 214_000,
      source: '',
    };

    await new LyricsService(store, { resolve: async () => track }).find(track);

    const key = lyricsWorkFingerprint(track);
    expect(key).not.toBeNull();
    expect(store.snapshot().workLyricsCache[key!]).toEqual(expect.objectContaining({
      schemaVersion: 1,
      providerId: 42,
      plainText: 'Streetlights draw a silver line',
    }));
  });

  it('lazily seeds the work cache from an existing original-track cache hit', async () => {
    const track = {
      title: 'Midnight Circuit',
      artist: 'Local Drive',
      album: 'After Dark',
      durationMs: 214_000,
      source: '',
    };
    const key = trackFingerprint(track);
    const store = testStore({
      lyricsCache: {
        [key]: {
          payload: {
            kind: 'synced',
            lines: [{ id: '0', startMs: 0, text: 'Existing lyrics' }],
            provider: 'lrclib',
            providerId: 42,
          },
          metadataSignature: lyricsLookupFingerprint(track),
          lookupStrategy: 'lrclib-multi-v2',
          expiresAt: Date.now() + 60_000,
        },
      },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await new LyricsService(store, { resolve: async () => track }).find(track);

    expect(result.kind).toBe('synced');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.snapshot().workLyricsCache[lyricsWorkFingerprint(track)!]?.plainText).toBe(
      'Existing lyrics',
    );
  });

  it('returns opaque candidate tokens without exposing provider ids or full lyric bodies', async () => {
    vi.stubGlobal('fetch', candidateFetch());
    const service = new LyricsService(testStore(), { resolve: async () => null });

    const result = await service.listCandidates(CANDIDATE_TRACK);

    expect(result).not.toHaveProperty('trackFingerprint');
    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0]!;
    expect(candidate.token).toEqual(expect.any(String));
    expect(candidate.token.length).toBeGreaterThan(16);
    expect(candidate.token).not.toBe(String(CANDIDATE_RESULT.id));
    expect(candidate).not.toHaveProperty('id');
    expect(candidate).not.toHaveProperty('plainLyrics');
    expect(candidate).not.toHaveProperty('syncedLyrics');
    expect(candidate.preview).toEqual(['Synced line one', 'Synced line two']);
    expect(JSON.stringify(result)).not.toContain('Private plain line four');
    expect(JSON.stringify(result)).not.toContain('[00:00.00]');
  });

  it('evicts the oldest per-user candidate token at the configured limit', async () => {
    vi.stubGlobal('fetch', candidateFetch());
    const service = new LyricsService(
      testStore(),
      { resolve: async () => null },
      undefined,
      undefined,
      { maxCandidateSelections: 1, maxCandidateSelectionBytes: 1_024 * 1_024 },
    );

    const first = (await service.listCandidates(CANDIDATE_TRACK)).candidates[0]!.token;
    const second = (await service.listCandidates(CANDIDATE_TRACK)).candidates[0]!.token;

    await expect(service.selectCandidate(CANDIDATE_TRACK, first, 'synced'))
      .rejects.toMatchObject({ statusCode: 409 });
    await expect(service.selectCandidate(CANDIDATE_TRACK, second, 'synced'))
      .resolves.toMatchObject({ provider: 'lrclib' });
  });

  it('lists Traditional candidates for Simplified metadata', async () => {
    const track: TrackMetadata = {
      title: '单车',
      artist: '陈奕迅',
      album: '2013 陈奕迅 Music Life 精选',
      durationMs: 209_000,
      source: 'Apple Music',
    };
    const traditional = {
      id: 14737395,
      trackName: '單車',
      artistName: '陳奕迅',
      albumName: '2013 陳奕迅 Music Life 精選',
      duration: 208.627,
      instrumental: false,
      plainLyrics: '不要不要假設我知道',
      syncedLyrics: '[00:14.00]不要不要假設我知道',
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const query = decodeURIComponent(urlFrom(input).search);
      return jsonResponse(query.includes('單車') || query.includes('陳奕迅')
        ? [traditional]
        : []);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new LyricsService(testStore(), { resolve: async () => track })
      .listCandidates(track);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      trackName: '單車',
      artistName: '陳奕迅',
      hasSyncedLyrics: true,
    });
  });

  it('lists a safe native Simplified candidate before its Traditional equivalent', async () => {
    const track: TrackMetadata = {
      title: '单车',
      artist: '陈奕迅',
      album: 'Shall We Dance? Shall We Talk!',
      durationMs: 209_000,
      source: 'Apple Music',
    };
    const traditional = {
      id: 14737395,
      trackName: '單車',
      artistName: '陳奕迅',
      albumName: track.album,
      duration: 208.627,
      instrumental: false,
      plainLyrics: '不要不要假設我知道\n一切一切也都是為我而做\n為何這麼偉大 如此感覺不到',
      syncedLyrics: '[00:14.000]不要不要假設我知道\n[00:18.000]一切一切也都是為我而做\n[00:22.000]為何這麼偉大 如此感覺不到',
    };
    const simplified = {
      ...traditional,
      id: 14737396,
      trackName: track.title,
      artistName: track.artist,
      plainLyrics: '不要不要假设我知道\n一切一切也都是为我而做\n为何这么伟大 如此感觉不到',
      syncedLyrics: '[00:14.000]不要不要假设我知道\n[00:18.000]一切一切也都是为我而做\n[00:22.000]为何这么伟大 如此感觉不到',
    };
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([traditional, simplified])));

    const result = await new LyricsService(testStore(), { resolve: async () => track })
      .listCandidates(track);

    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((candidate) => candidate.trackName))
      .toEqual(['单车', '單車']);
  });

  it.each([
    { mode: 'synced' as const, kind: 'synced' as const, text: 'Synced line one' },
    { mode: 'plain' as const, kind: 'plain' as const, text: 'Plain line one' },
  ])('persists and resolves a selected $mode candidate while clearing competing state', async ({
    mode,
    kind,
    text,
  }) => {
    const key = trackFingerprint(CANDIDATE_TRACK);
    const store = testStore({
      lyricOffsets: { [key]: 1_700 },
      lyricOverrides: {
        [key]: { lrc: '[00:00.00]Old manual lyrics', updatedAt: 1 },
      },
      candidateLyricsOverrides: {
        [key]: {
          schemaVersion: 1,
          mode: 'plain',
          candidateId: 7,
          trackName: 'Old candidate',
          artistName: 'Local Drive',
          albumName: 'Old album',
          durationMs: 200_000,
          plainText: 'Old selected lyrics',
          updatedAt: 1,
        },
      },
      lyricsCache: {
        [key]: {
          payload: {
            kind: 'synced',
            lines: [{ id: 'old', startMs: 0, text: 'Old automatic lyrics' }],
            provider: 'lrclib',
            providerId: 8,
          },
          expiresAt: Date.now() + 60_000,
        },
      },
    });
    vi.stubGlobal('fetch', candidateFetch());
    const service = new LyricsService(store, { resolve: async () => null });
    const token = await candidateToken(service);

    const selected = await service.selectCandidate(CANDIDATE_TRACK, token, mode);

    expect(selected).toEqual(expect.objectContaining({
      kind,
      provider: 'lrclib',
      providerId: CANDIDATE_RESULT.id,
    }));
    expect(selected.lines.some((line) => line.text === text)).toBe(true);
    const persisted = store.snapshot();
    expect(persisted.candidateLyricsOverrides[key]).toEqual(expect.objectContaining({
      schemaVersion: 1,
      mode,
      candidateId: CANDIDATE_RESULT.id,
      trackName: CANDIDATE_RESULT.trackName,
      artistName: CANDIDATE_RESULT.artistName,
      albumName: CANDIDATE_RESULT.albumName,
      durationMs: CANDIDATE_RESULT.duration * 1_000,
    }));
    if (mode === 'synced') {
      expect(persisted.candidateLyricsOverrides[key]?.lrc).toBe(CANDIDATE_RESULT.syncedLyrics);
      expect(persisted.candidateLyricsOverrides[key]?.plainText).toBeUndefined();
    } else {
      expect(persisted.candidateLyricsOverrides[key]?.plainText).toBe(CANDIDATE_RESULT.plainLyrics);
      expect(persisted.candidateLyricsOverrides[key]?.lrc).toBeUndefined();
    }
    expect(persisted.lyricOverrides[key]).toBeUndefined();
    expect(persisted.lyricsCache[key]).toBeUndefined();
    expect(persisted.lyricOffsets[key]).toBeUndefined();

    const unexpectedFetch = vi.fn(() => {
      throw new Error('a persisted candidate selection must resolve without LRCLIB');
    });
    vi.stubGlobal('fetch', unexpectedFetch);
    const resolved = await new LyricsService(store, { resolve: async () => null }).find(
      CANDIDATE_TRACK,
    );
    expect(resolved).toEqual(expect.objectContaining({
      kind,
      provider: 'lrclib',
      providerId: CANDIDATE_RESULT.id,
    }));
    expect(resolved.lines.some((line) => line.text === text)).toBe(true);
    expect(unexpectedFetch).not.toHaveBeenCalled();
  });

  it('rejects a tampered token without consuming the valid token', async () => {
    vi.stubGlobal('fetch', candidateFetch());
    const service = new LyricsService(testStore(), { resolve: async () => null });
    const token = await candidateToken(service);

    await expect(service.selectCandidate(CANDIDATE_TRACK, `${token}x`, 'plain')).rejects
      .toMatchObject({ statusCode: 409 });
    await expect(service.selectCandidate(CANDIDATE_TRACK, token, 'plain')).resolves
      .toEqual(expect.objectContaining({ kind: 'plain', providerId: CANDIDATE_RESULT.id }));
  });

  it('consumes a candidate token after one successful selection', async () => {
    vi.stubGlobal('fetch', candidateFetch());
    const service = new LyricsService(testStore(), { resolve: async () => null });
    const token = await candidateToken(service);

    await service.selectCandidate(CANDIDATE_TRACK, token, 'synced');

    await expect(service.selectCandidate(CANDIDATE_TRACK, token, 'synced')).rejects
      .toMatchObject({ statusCode: 409 });
  });

  it('rejects an expired candidate token', async () => {
    const startedAt = 1_800_000_000_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
    vi.stubGlobal('fetch', candidateFetch());
    const service = new LyricsService(testStore(), { resolve: async () => null });
    const token = await candidateToken(service);
    now.mockReturnValue(startedAt + 10 * 60 * 1_000 + 1);

    await expect(service.selectCandidate(CANDIDATE_TRACK, token, 'plain')).rejects
      .toMatchObject({ statusCode: 409 });
    now.mockRestore();
  });

  it('rejects a candidate token after the track metadata changes', async () => {
    vi.stubGlobal('fetch', candidateFetch());
    const service = new LyricsService(testStore(), { resolve: async () => null });
    const token = await candidateToken(service);

    await expect(service.selectCandidate(
      { ...CANDIDATE_TRACK, album: 'A Different Album' },
      token,
      'plain',
    )).rejects.toMatchObject({ statusCode: 409 });
  });

  it('does not let an older in-flight lookup cache over a candidate selection', async () => {
    const store = testStore();
    vi.stubGlobal('fetch', candidateFetch());
    const service = new LyricsService(store, { resolve: async () => null });
    const token = await candidateToken(service);
    const finishLookups: Array<{
      url: URL;
      resolve: (response: object) => void;
    }> = [];
    const lookupFetch = vi.fn((input: string | URL | Request) =>
      new Promise<object>((resolve) => {
        finishLookups.push({ url: urlFrom(input), resolve });
      }));
    vi.stubGlobal('fetch', lookupFetch);

    const olderLookup = service.find(CANDIDATE_TRACK, { forceRefresh: true });
    await vi.waitFor(() => expect(lookupFetch).toHaveBeenCalledTimes(2));
    await service.selectCandidate(CANDIDATE_TRACK, token, 'plain');
    for (const pending of finishLookups) {
      pending.resolve({
        ok: true,
        status: 200,
        json: async () => pending.url.pathname === '/api/get'
          ? CANDIDATE_RESULT
          : [CANDIDATE_RESULT],
      });
    }
    await olderLookup;

    const key = trackFingerprint(CANDIDATE_TRACK);
    expect(store.snapshot().candidateLyricsOverrides[key]).toEqual(expect.objectContaining({
      mode: 'plain',
      candidateId: CANDIDATE_RESULT.id,
    }));
    expect(store.snapshot().lyricsCache[key]).toBeUndefined();
  });

  it('removes a persisted candidate selection when manual LRC is saved', async () => {
    const key = trackFingerprint(CANDIDATE_TRACK);
    const store = testStore({
      candidateLyricsOverrides: {
        [key]: {
          schemaVersion: 1,
          mode: 'synced',
          candidateId: CANDIDATE_RESULT.id,
          trackName: CANDIDATE_RESULT.trackName,
          artistName: CANDIDATE_RESULT.artistName,
          albumName: CANDIDATE_RESULT.albumName,
          durationMs: CANDIDATE_RESULT.duration * 1_000,
          lrc: CANDIDATE_RESULT.syncedLyrics,
          updatedAt: 1,
        },
      },
      lyricsCache: {
        [key]: {
          payload: { kind: 'missing', lines: [], provider: null },
          expiresAt: Date.now() + 60_000,
        },
      },
    });

    await new LyricsService(store, { resolve: async () => null }).setManualLrc(
      CANDIDATE_TRACK,
      '[00:00.00]My manual lyrics',
    );

    const persisted = store.snapshot();
    expect(persisted.lyricOverrides[key]?.lrc).toBe('[00:00.00]My manual lyrics');
    expect(persisted.candidateLyricsOverrides[key]).toBeUndefined();
    expect(persisted.lyricsCache[key]).toBeUndefined();
  });
});
