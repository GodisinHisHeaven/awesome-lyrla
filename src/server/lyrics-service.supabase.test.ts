import type { LyricsPayload, TrackMetadata } from '../shared/contracts.js';
import {
  lyricsLookupFingerprint,
  lyricsWorkFingerprint,
  trackFingerprint,
} from '../shared/track.js';
import {
  LyricsRepository,
  PRIMARY_APPLE_EXACT_LOOKUP_STRATEGY,
  PRIMARY_EXACT_REVALIDATE_MS,
  PRIMARY_LRCLIB_EXACT_LOOKUP_STRATEGY,
  PRIMARY_SELECTED_EXACT_LOOKUP_STRATEGY,
  type LyricsLibraryClient,
  type LyricsLibraryResolveInput,
  type LyricsLibraryResolveResult,
} from './lyrics-repository.js';
import { LyricsService } from './lyrics-service.js';
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

const LRCLIB_RESULT = {
  id: 42,
  trackName: TRACK.title,
  artistName: TRACK.artist,
  albumName: TRACK.album,
  duration: TRACK.durationMs / 1_000,
  instrumental: false,
  plainLyrics: 'Streetlights draw a silver line',
  syncedLyrics: '[00:00.00]Streetlights draw a silver line',
};

const REMOTE_EXACT_PAYLOAD: LyricsPayload = {
  kind: 'synced',
  lines: [{ id: 'remote-1', startMs: 0, text: 'Already in the private library' }],
  provider: 'lrclib',
  providerId: 9001,
};

const REMOTE_APPLE_PAYLOAD: LyricsPayload = {
  kind: 'synced',
  lines: [{ id: 'apple-remote-1', startMs: 0, text: 'Apple primary lyric' }],
  provider: 'apple',
  providerTrackId: 'apple-track-9001',
};

const REMOTE_APPLE_STATIC_PAYLOAD: LyricsPayload = {
  kind: 'plain',
  lines: [
    { id: 'plain-0', startMs: 0, text: 'Apple static first line' },
    { id: 'plain-1', startMs: 0, text: 'Apple static second line' },
  ],
  plainText: 'Apple static first line\nApple static second line',
  provider: 'apple',
  providerTrackId: 'apple-track-static-9001',
  notice: '正在使用个人歌词库中的静态歌词。',
};

const REMOTE_WORK_PAYLOAD: LyricsPayload = {
  kind: 'plain',
  lines: [{ id: 'remote-work-1', startMs: 0, text: 'Static original lyrics' }],
  plainText: 'Static original lyrics',
  provider: 'lrclib',
  providerId: 9002,
  notice: '未找到当前版本歌词，当前显示同一作品的本地静态歌词。',
  fallbackKind: 'work-cache',
};

const REMOTE_APPLE_DURATION_ALIAS_PAYLOAD: LyricsPayload = {
  kind: 'plain',
  lines: [
    { id: 'plain-0', startMs: 0, text: '童言无忌第一行' },
    { id: 'plain-1', startMs: 0, text: '童言无忌第二行' },
  ],
  plainText: '童言无忌第一行\n童言无忌第二行',
  provider: 'apple',
  providerTrackId: '6768224531',
  notice: '未找到当前版本歌词，当前显示同一作品歌词（静态模式）。',
  fallbackKind: 'work-cache',
};

const REMOTE_APPLE_DURATION_ALIAS_SYNCED_PAYLOAD: LyricsPayload = {
  kind: 'synced',
  lines: [
    { id: 'apple-alias-0', startMs: 1_000, text: 'Apple synchronized first line' },
    { id: 'apple-alias-1', startMs: 2_000, text: 'Apple synchronized second line' },
  ],
  provider: 'apple',
  providerTrackId: '6768224531',
};

const NO_ENRICHMENT = {
  resolve: async (track: TrackMetadata): Promise<TrackMetadata> => track,
};

const LRCLIB_RESPONSE_LIMIT_BYTES = 4 * 1_024 * 1_024;

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
  const readWorkLyrics = vi.fn((key: string): CachedWorkLyrics | undefined => {
    const cached = state.workLyricsCache[key];
    return cached ? structuredClone(cached) : undefined;
  });
  const updateCachedLyrics = vi.fn(async (
    key: string,
    mutator: (current: CachedLyrics | undefined) => CachedLyrics | undefined,
  ): Promise<void> => {
    const current = state.lyricsCache[key];
    const next = mutator(current ? structuredClone(current) : undefined);
    if (next) state.lyricsCache[key] = structuredClone(next);
    else delete state.lyricsCache[key];
  });
  const updateWorkLyrics = vi.fn(async (
    key: string,
    value: CachedWorkLyrics | undefined,
  ): Promise<void> => {
    if (value) state.workLyricsCache[key] = structuredClone(value);
    else delete state.workLyricsCache[key];
  });
  const update = vi.fn(async (mutator: (draft: PersistedState) => void): Promise<void> => {
    mutator(state);
  });
  const store = {
    snapshot: vi.fn(() => structuredClone(state)),
    readLyricOffset: vi.fn((key: string) => state.lyricOffsets[key] ?? 0),
    readLyricsEntries,
    readWorkLyrics,
    updateCachedLyrics,
    updateWorkLyrics,
    update,
  } as unknown as JsonStore;
  return { store, state, readLyricsEntries, updateCachedLyrics };
}

function fakeRemote(
  handler: (
    input: LyricsLibraryResolveInput,
  ) => Promise<LyricsLibraryResolveResult> = async () => ({ state: 'miss' }),
) {
  const resolve = vi.fn(handler);
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
  mode: 'primary' | 'shadow',
  remote: LyricsLibraryClient,
  appleBackfill?: {
    enabled: boolean;
    storefront: string;
    locale: string;
    maxAttempts: number;
  },
): LyricsRepository {
  return new LyricsRepository(store, {
    mode,
    memoryMaxEntries: 300,
    memoryMaxBytes: 4 * 1_024 * 1_024,
    legacyMaxEntries: 300,
    legacyMaxBytes: 8 * 1_024 * 1_024,
    remote,
    appleBackfill,
  });
}

function serviceWith(
  store: JsonStore,
  mode: 'primary' | 'shadow',
  remote: LyricsLibraryClient,
  appleBackfill?: {
    enabled: boolean;
    storefront: string;
    locale: string;
    maxAttempts: number;
  },
): { service: LyricsService; repository: LyricsRepository } {
  const lyricsRepository = repository(store, mode, remote, appleBackfill);
  return {
    service: new LyricsService(store, NO_ENRICHMENT, lyricsRepository),
    repository: lyricsRepository,
  };
}

function urlFrom(input: string | URL | Request): URL {
  return input instanceof URL
    ? input
    : new URL(typeof input === 'string' ? input : input.url);
}

function exactHitFetch(result = LRCLIB_RESULT) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => new Response(
    JSON.stringify(urlFrom(input).pathname === '/api/get' ? result : [result]),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  ));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function definitiveMissFetch() {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = urlFrom(input);
    if (url.pathname === '/api/get') {
      return new Response('{}', {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('[]', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function oversizedDeclaredResponse(): Response {
  return new Response('[]', {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(LRCLIB_RESPONSE_LIMIT_BYTES + 1),
    },
  });
}

function oversizedChunkedResponse(): Response {
  const whitespace = new TextEncoder().encode(' '.repeat(1_024 * 1_024));
  const suffix = new TextEncoder().encode('[]');
  let chunk = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunk < 5) {
        chunk += 1;
        controller.enqueue(whitespace);
        return;
      }
      controller.enqueue(suffix);
      controller.close();
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function activeExactResult(
  payload: LyricsPayload = REMOTE_EXACT_PAYLOAD,
): LyricsLibraryResolveResult {
  return {
    state: 'hit',
    matchKind: 'exact',
    payload,
    documentId: '00000000-0000-4000-8000-000000009001',
  };
}

function workResult(): LyricsLibraryResolveResult {
  return {
    state: 'hit',
    matchKind: 'work',
    payload: REMOTE_WORK_PAYLOAD,
    documentId: '00000000-0000-4000-8000-000000009002',
  };
}

describe('LyricsService Supabase repository integration', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('serves an active remote exact hit without calling LRCLIB', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('LRCLIB must not be called for an active exact hit');
    });
    vi.stubGlobal('fetch', fetchMock);
    const fake = fakeStore();
    const remote = fakeRemote(async () => activeExactResult());
    const { service } = serviceWith(fake.store, 'primary', remote.remote);

    await expect(service.find(TRACK)).resolves.toEqual(REMOTE_EXACT_PAYLOAD);

    expect(remote.resolve).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      track: TRACK,
      exactKey: lyricsLookupFingerprint(TRACK),
      allowWorkFallback: false,
    }));
    expect(remote.compareQuarantined).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serves and caches an Apple static exact fallback without calling LRCLIB', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('LRCLIB must not be called for an Apple static exact hit');
    });
    vi.stubGlobal('fetch', fetchMock);
    const fake = fakeStore();
    const remote = fakeRemote(async () =>
      activeExactResult(REMOTE_APPLE_STATIC_PAYLOAD));
    const integrated = serviceWith(fake.store, 'primary', remote.remote);

    await expect(integrated.service.find(TRACK))
      .resolves.toEqual(REMOTE_APPLE_STATIC_PAYLOAD);

    expect(remote.resolve).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      track: TRACK,
      exactKey: lyricsLookupFingerprint(TRACK),
      allowWorkFallback: false,
    }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(integrated.repository.readTrack(trackFingerprint(TRACK)).cached)
      .toMatchObject({
        payload: REMOTE_APPLE_STATIC_PAYLOAD,
        lookupStrategy: PRIMARY_APPLE_EXACT_LOOKUP_STRATEGY,
      });
  });

  it('serves a synchronized Apple duration alias before querying LRCLIB', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('LRCLIB must not be called for a synchronized Apple alias');
    });
    vi.stubGlobal('fetch', fetchMock);
    const fake = fakeStore();
    const remote = fakeRemote(async () => ({
      state: 'hit',
      matchKind: 'work',
      payload: REMOTE_APPLE_DURATION_ALIAS_SYNCED_PAYLOAD,
      documentId: '00000000-0000-4000-8000-000000009005',
      selectionMethod: 'provider',
      providerRoute: 'apple-duration-alias-synced-v1',
    }));
    const { service } = serviceWith(fake.store, 'primary', remote.remote);

    await expect(service.find(TRACK)).resolves.toEqual(
      REMOTE_APPLE_DURATION_ALIAS_SYNCED_PAYLOAD,
    );

    expect(remote.resolve).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      track: TRACK,
      exactKey: lyricsLookupFingerprint(TRACK),
      workKey: lyricsWorkFingerprint(TRACK),
      allowWorkFallback: false,
    }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('projects a Traditional Apple exact hit to Simplified without replacing its source', async () => {
    const track: TrackMetadata = {
      title: '单车',
      artist: '陈奕迅',
      album: 'Shall We Dance? Shall We Talk!',
      durationMs: 209_000,
      source: 'Apple Music',
    };
    const appleTraditional: LyricsPayload = {
      kind: 'synced',
      lines: [
        { id: 'apple-1', startMs: 14_000, text: '不要不要假設我知道' },
        { id: 'apple-2', startMs: 18_000, text: '為何這麼偉大' },
      ],
      provider: 'apple',
      providerTrackId: '667921841',
    };
    const fetchMock = vi.fn(async () => {
      throw new Error('LRCLIB must remain a source fallback for an Apple hit');
    });
    vi.stubGlobal('fetch', fetchMock);
    const fake = fakeStore();
    const remote = fakeRemote(async () => activeExactResult(appleTraditional));
    const integrated = serviceWith(fake.store, 'primary', remote.remote);

    const result = await integrated.service.find(track);

    expect(result).toMatchObject({
      kind: 'synced',
      provider: 'apple',
      providerTrackId: '667921841',
    });
    expect(result.lines).toEqual([
      { id: 'apple-1', startMs: 14_000, text: '不要不要假设我知道' },
      { id: 'apple-2', startMs: 18_000, text: '为何这么伟大' },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(integrated.repository.readTrack(trackFingerprint(track)).cached?.payload.lines)
      .toEqual(result.lines);
    expect(appleTraditional.lines[0]?.text).toBe('不要不要假設我知道');
  });

  it('checks a direct Traditional provider exact for a safe native Simplified LRCLIB variant', async () => {
    const track: TrackMetadata = {
      title: '单车',
      artist: '陈奕迅',
      album: 'Shall We Dance? Shall We Talk!',
      durationMs: 209_000,
      source: 'Apple Music',
    };
    const traditionalResult = {
      id: 14737395,
      trackName: '單車',
      artistName: '陳奕迅',
      albumName: track.album,
      duration: 208.627,
      instrumental: false,
      plainLyrics: '不要不要假設我知道\n一切一切也都是為我而做\n為何這麼偉大 如此感覺不到',
      syncedLyrics: '[00:14.000]不要不要假設我知道\n[00:18.000]一切一切也都是為我而做\n[00:22.000]為何這麼偉大 如此感覺不到',
    };
    const simplifiedResult = {
      ...traditionalResult,
      id: 14737396,
      trackName: track.title,
      artistName: track.artist,
      plainLyrics: '不要不要假设我知道\n一切一切也都是为我而做\n为何这么伟大 如此感觉不到',
      syncedLyrics: '[00:14.000]不要不要假设我知道\n[00:18.000]一切一切也都是为我而做\n[00:22.000]为何这么伟大 如此感觉不到',
    };
    const remotePayload: LyricsPayload = {
      kind: 'synced',
      lines: [
        { id: 'remote-trad-1', startMs: 14_000, text: '不要不要假設我知道' },
        { id: 'remote-trad-2', startMs: 18_000, text: '一切一切也都是為我而做' },
        { id: 'remote-trad-3', startMs: 22_000, text: '為何這麼偉大 如此感覺不到' },
      ],
      provider: 'lrclib',
      providerId: traditionalResult.id,
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => new Response(
      JSON.stringify(urlFrom(input).pathname === '/api/get'
        ? traditionalResult
        : [traditionalResult, simplifiedResult]),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const fake = fakeStore();
    const remote = fakeRemote(async () => ({
      ...activeExactResult(remotePayload),
      selectionMethod: 'provider',
    }));
    const { service } = serviceWith(fake.store, 'primary', remote.remote);

    const result = await service.find(track);

    expect(result).toMatchObject({
      kind: 'synced',
      provider: 'lrclib',
      providerId: simplifiedResult.id,
    });
    expect(result.lines.map((line) => line.text)).toEqual([
      '不要不要假设我知道',
      '一切一切也都是为我而做',
      '为何这么伟大 如此感觉不到',
    ]);
    expect(remote.resolve).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
  });

  it('continues past a mixed-script Supabase LRCLIB exact for a safe Simplified variant', async () => {
    const track: TrackMetadata = {
      title: '单车',
      artist: '陈奕迅',
      album: 'Shall We Dance? Shall We Talk!',
      durationMs: 209_000,
      source: 'Apple Music',
    };
    const mixedResult = {
      id: 14737395,
      trackName: '單車',
      artistName: '陳奕迅',
      albumName: track.album,
      duration: 208.627,
      instrumental: false,
      plainLyrics: '不要不要假設我知道\n一切一切也都是为我而做\n为何这么伟大 如此感觉不到',
      syncedLyrics: '[00:14.000]不要不要假設我知道\n[00:18.000]一切一切也都是为我而做\n[00:22.000]为何这么伟大 如此感觉不到',
    };
    const simplifiedResult = {
      ...mixedResult,
      id: 14737396,
      trackName: track.title,
      artistName: track.artist,
      plainLyrics: '不要不要假设我知道\n一切一切也都是为我而做\n为何这么伟大 如此感觉不到',
      syncedLyrics: '[00:14.000]不要不要假设我知道\n[00:18.000]一切一切也都是为我而做\n[00:22.000]为何这么伟大 如此感觉不到',
    };
    const remotePayload: LyricsPayload = {
      kind: 'synced',
      lines: [
        { id: 'remote-mixed-1', startMs: 14_000, text: '不要不要假設我知道' },
        { id: 'remote-mixed-2', startMs: 18_000, text: '一切一切也都是为我而做' },
        { id: 'remote-mixed-3', startMs: 22_000, text: '为何这么伟大 如此感觉不到' },
      ],
      provider: 'lrclib',
      providerId: mixedResult.id,
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => new Response(
      JSON.stringify(urlFrom(input).pathname === '/api/get'
        ? mixedResult
        : [mixedResult, simplifiedResult]),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const fake = fakeStore();
    const remote = fakeRemote(async () => ({
      ...activeExactResult(remotePayload),
      selectionMethod: 'provider',
    }));
    const { service } = serviceWith(fake.store, 'primary', remote.remote);

    const result = await service.find(track);

    expect(result).toMatchObject({
      kind: 'synced',
      provider: 'lrclib',
      providerId: simplifiedResult.id,
    });
    expect(result.lines.map((line) => line.text)).toEqual([
      '不要不要假设我知道',
      '一切一切也都是为我而做',
      '为何这么伟大 如此感觉不到',
    ]);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
  });

  it('falls back to a direct Traditional provider exact when no safe Simplified variant exists', async () => {
    const track: TrackMetadata = {
      title: '单车',
      artist: '陈奕迅',
      album: 'Shall We Dance? Shall We Talk!',
      durationMs: 209_000,
      source: 'Apple Music',
    };
    const traditionalResult = {
      id: 14737395,
      trackName: '單車',
      artistName: '陳奕迅',
      albumName: track.album,
      duration: 208.627,
      instrumental: false,
      plainLyrics: '不要不要假設我知道',
      syncedLyrics: '[00:14.000]不要不要假設我知道',
    };
    const remotePayload: LyricsPayload = {
      kind: 'synced',
      lines: [{ id: 'remote-trad', startMs: 14_000, text: '不要不要假設我知道' }],
      provider: 'lrclib',
      providerId: traditionalResult.id,
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => new Response(
      JSON.stringify(urlFrom(input).pathname === '/api/get' ? traditionalResult : []),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const fake = fakeStore();
    const remote = fakeRemote(async () => ({
      ...activeExactResult(remotePayload),
      selectionMethod: 'provider',
    }));
    const integrated = serviceWith(fake.store, 'primary', remote.remote);

    await expect(integrated.service.find(track)).resolves.toEqual(remotePayload);
    expect(remote.resolve).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    expect(integrated.repository.readTrack(trackFingerprint(track)).cached).toMatchObject({
      payload: remotePayload,
      lookupStrategy: PRIMARY_LRCLIB_EXACT_LOOKUP_STRATEGY,
    });
  });

  it('revalidates a Supabase LRCLIB exact hit after five minutes and adopts Apple', async () => {
    let now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchMock = vi.fn(async () => {
      throw new Error('LRCLIB upstream must not be called for remote exact hits');
    });
    vi.stubGlobal('fetch', fetchMock);
    const fake = fakeStore();
    const remote = fakeRemote();
    remote.resolve
      .mockResolvedValueOnce(activeExactResult())
      .mockResolvedValueOnce(activeExactResult(REMOTE_APPLE_PAYLOAD));
    const integrated = serviceWith(fake.store, 'primary', remote.remote);
    const key = trackFingerprint(TRACK);

    await expect(integrated.service.find(TRACK)).resolves.toEqual(REMOTE_EXACT_PAYLOAD);
    let cached = integrated.repository.readTrack(key).cached;
    expect(cached).toMatchObject({
      lookupStrategy: PRIMARY_LRCLIB_EXACT_LOOKUP_STRATEGY,
      expiresAt: now + 30 * 24 * 60 * 60 * 1_000,
      revalidateAt: now + PRIMARY_EXACT_REVALIDATE_MS,
    });

    await Promise.resolve();
    now += PRIMARY_EXACT_REVALIDATE_MS - 1;
    await expect(integrated.service.find(TRACK)).resolves.toEqual(REMOTE_EXACT_PAYLOAD);
    expect(remote.resolve).toHaveBeenCalledTimes(1);

    await Promise.resolve();
    now += 1;
    await expect(integrated.service.find(TRACK)).resolves.toEqual(expect.objectContaining({
      ...REMOTE_EXACT_PAYLOAD,
      retryable: true,
    }));
    expect(remote.resolve).toHaveBeenCalledTimes(1);

    await Promise.resolve();
    await expect(integrated.service.find(
      TRACK,
      { bypassLocalCache: true },
    )).resolves.toEqual(REMOTE_APPLE_PAYLOAD);
    cached = integrated.repository.readTrack(key).cached;
    expect(cached).toMatchObject({
      lookupStrategy: PRIMARY_APPLE_EXACT_LOOKUP_STRATEGY,
      expiresAt: now + PRIMARY_EXACT_REVALIDATE_MS,
      revalidateAt: now + PRIMARY_EXACT_REVALIDATE_MS,
    });
    expect(remote.resolve).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps a user-selected Supabase exact hit out of automatic revalidation', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('selected lyrics must stay on the local fast path');
    });
    vi.stubGlobal('fetch', fetchMock);
    const fake = fakeStore();
    const remote = fakeRemote(async () => ({
      ...activeExactResult(),
      selectionMethod: 'candidate',
    }));
    const integrated = serviceWith(fake.store, 'primary', remote.remote);
    const key = trackFingerprint(TRACK);

    await expect(integrated.service.find(TRACK)).resolves.toEqual(REMOTE_EXACT_PAYLOAD);
    await Promise.resolve();
    await expect(integrated.service.find(TRACK)).resolves.toEqual(REMOTE_EXACT_PAYLOAD);

    expect(remote.resolve).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(integrated.repository.readTrack(key).cached).toMatchObject({
      lookupStrategy: PRIMARY_SELECTED_EXACT_LOOKUP_STRATEGY,
    });
    expect(integrated.repository.readTrack(key).cached?.revalidateAt).toBeUndefined();
  });

  it('revalidates a direct LRCLIB cache after five minutes and adopts Apple', async () => {
    let now = 1_800_100_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchMock = exactHitFetch();
    const fake = fakeStore();
    const remote = fakeRemote();
    remote.resolve
      .mockResolvedValueOnce({ state: 'miss' })
      .mockResolvedValueOnce(activeExactResult(REMOTE_APPLE_PAYLOAD));
    const integrated = serviceWith(fake.store, 'primary', remote.remote);
    const key = trackFingerprint(TRACK);

    await expect(integrated.service.find(TRACK)).resolves.toMatchObject({
      kind: 'synced',
      provider: 'lrclib',
      providerId: LRCLIB_RESULT.id,
    });
    const requestsAfterLrclib = fetchMock.mock.calls.length;
    expect(integrated.repository.readTrack(key).cached).toMatchObject({
      lookupStrategy: PRIMARY_LRCLIB_EXACT_LOOKUP_STRATEGY,
      expiresAt: now + 30 * 24 * 60 * 60 * 1_000,
      revalidateAt: now + PRIMARY_EXACT_REVALIDATE_MS,
    });

    await Promise.resolve();
    now += PRIMARY_EXACT_REVALIDATE_MS;
    await expect(integrated.service.find(TRACK)).resolves.toMatchObject({
      kind: 'synced',
      provider: 'lrclib',
      retryable: true,
    });

    await Promise.resolve();
    await expect(integrated.service.find(
      TRACK,
      { bypassLocalCache: true },
    )).resolves.toEqual(REMOTE_APPLE_PAYLOAD);
    expect(remote.resolve).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(requestsAfterLrclib);
  });

  it('falls back from an expired Apple route through Supabase to LRCLIB', async () => {
    let now = 1_800_200_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchMock = vi.fn(async () => {
      throw new Error('Supabase LRCLIB fallback must not call the upstream service');
    });
    vi.stubGlobal('fetch', fetchMock);
    const fake = fakeStore();
    const remote = fakeRemote();
    remote.resolve
      .mockResolvedValueOnce(activeExactResult(REMOTE_APPLE_PAYLOAD))
      .mockResolvedValueOnce(activeExactResult());
    const integrated = serviceWith(fake.store, 'primary', remote.remote);
    const key = trackFingerprint(TRACK);

    await expect(integrated.service.find(TRACK)).resolves.toEqual(REMOTE_APPLE_PAYLOAD);
    expect(fetchMock).not.toHaveBeenCalled();

    await Promise.resolve();
    now += PRIMARY_EXACT_REVALIDATE_MS;
    await expect(integrated.service.find(TRACK)).resolves.toEqual(expect.objectContaining({
      ...REMOTE_APPLE_PAYLOAD,
      retryable: true,
    }));

    await Promise.resolve();
    await expect(integrated.service.find(
      TRACK,
      { bypassLocalCache: true },
    )).resolves.toEqual(REMOTE_EXACT_PAYLOAD);
    expect(remote.resolve).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(integrated.repository.readTrack(key).cached).toMatchObject({
      lookupStrategy: PRIMARY_LRCLIB_EXACT_LOOKUP_STRATEGY,
      expiresAt: now + 30 * 24 * 60 * 60 * 1_000,
      revalidateAt: now + PRIMARY_EXACT_REVALIDATE_MS,
    });
  });

  it('immediately rechecks an old 30-day primary strategy epoch', async () => {
    const now = 1_800_300_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const key = trackFingerprint(TRACK);
    const fake = fakeStore({
      lyricsCache: {
        [key]: {
          payload: REMOTE_EXACT_PAYLOAD,
          lookupStrategy: 'supabase-v1',
          metadataSignature: lyricsLookupFingerprint(TRACK),
          expiresAt: now + 30 * 24 * 60 * 60 * 1_000,
        },
      },
    });
    const remote = fakeRemote(async () => activeExactResult(REMOTE_APPLE_PAYLOAD));
    const integrated = serviceWith(fake.store, 'primary', remote.remote);
    const fetchMock = vi.fn(async () => {
      throw new Error('old epoch should recheck Supabase before LRCLIB');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(integrated.service.find(TRACK)).resolves.toEqual(REMOTE_APPLE_PAYLOAD);

    expect(remote.resolve).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(integrated.repository.readTrack(key).cached?.lookupStrategy)
      .toBe(PRIMARY_APPLE_EXACT_LOOKUP_STRATEGY);
  });

  it.each([
    ['declared Content-Length', oversizedDeclaredResponse],
    ['chunked transfer without Content-Length', oversizedChunkedResponse],
  ])('fails safely when an LRCLIB candidate response exceeds the limit via %s', async (
    _label,
    response,
  ) => {
    const fetchMock = vi.fn(async () => response());
    vi.stubGlobal('fetch', fetchMock);
    const fake = fakeStore();
    const remote = fakeRemote();
    const { service } = serviceWith(fake.store, 'shadow', remote.remote);

    await expect(service.listCandidates(TRACK)).rejects.toMatchObject({ statusCode: 503 });
    expect(fetchMock).toHaveBeenCalled();
  });

  it.each([
    ['miss', { state: 'miss' }],
    ['unavailable', { state: 'unavailable', reason: 'timeout' }],
    ['ambiguous', { state: 'ambiguous', candidateCount: 2 }],
  ] satisfies Array<[string, LyricsLibraryResolveResult]>) (
    'fails open from a remote %s to the existing LRCLIB lookup',
    async (_label, remoteResult) => {
      const fetchMock = exactHitFetch();
      const fake = fakeStore();
      const remote = fakeRemote(async () => remoteResult);
      const { service } = serviceWith(fake.store, 'primary', remote.remote);

      const result = await service.find(TRACK);

      expect(result).toEqual(expect.objectContaining({
        kind: 'synced',
        provider: 'lrclib',
        providerId: LRCLIB_RESULT.id,
      }));
      expect(remote.resolve).toHaveBeenCalledTimes(1);
      expect(remote.upsertExact).toHaveBeenCalledExactlyOnceWith({
        track: TRACK,
        exactKey: lyricsLookupFingerprint(TRACK),
        keyVersion: 1,
        cached: expect.objectContaining({
          payload: expect.objectContaining({
            kind: 'synced',
            provider: 'lrclib',
            providerId: LRCLIB_RESULT.id,
          }),
        }),
        trust: 'active',
        sourceKind: 'automatic',
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(urlFrom(fetchMock.mock.calls[0]![0]).pathname).toBe('/api/get');
      expect(fetchMock.mock.calls.map(([input]) => urlFrom(input).pathname))
        .toContain('/api/search');
    },
  );

  it('does not let an unverified empty instrumental exact result block text search', async () => {
    const instrumentalExact = {
      ...LRCLIB_RESULT,
      id: 27248323,
      instrumental: true,
      plainLyrics: null,
      syncedLyrics: null,
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = urlFrom(input);
      return new Response(JSON.stringify(
        url.pathname === '/api/get' ? instrumentalExact : [LRCLIB_RESULT],
      ), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const fake = fakeStore();
    const remote = fakeRemote(async () => ({ state: 'miss' }));
    const { service } = serviceWith(fake.store, 'primary', remote.remote);

    await expect(service.find(TRACK)).resolves.toMatchObject({
      kind: 'synced',
      provider: 'lrclib',
      providerId: LRCLIB_RESULT.id,
    });

    expect(fetchMock.mock.calls.map(([input]) => urlFrom(input).pathname))
      .toContain('/api/search');
    expect(remote.upsertExact).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      cached: expect.objectContaining({
        payload: expect.objectContaining({
          kind: 'synced',
          providerId: LRCLIB_RESULT.id,
        }),
      }),
    }));
  });

  it('does not persist an unverified empty instrumental result as a long-lived positive', async () => {
    const now = 1_800_400_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const instrumentalExact = {
      ...LRCLIB_RESULT,
      id: 27248323,
      instrumental: true,
      plainLyrics: null,
      syncedLyrics: null,
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = urlFrom(input);
      return new Response(JSON.stringify(
        url.pathname === '/api/get' ? instrumentalExact : [],
      ), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const fake = fakeStore();
    const remote = fakeRemote(async () => ({ state: 'miss' }));
    const integrated = serviceWith(fake.store, 'primary', remote.remote);

    await expect(integrated.service.find(TRACK)).resolves.toMatchObject({
      kind: 'plain',
      lines: [],
      provider: 'lrclib',
      providerId: instrumentalExact.id,
      notice: 'LRCLIB 标记为纯音乐；未找到更可靠的文本歌词。',
    });

    const cached = integrated.repository.readTrack(trackFingerprint(TRACK)).cached;
    if (cached) {
      expect(cached.payload).toMatchObject({
        kind: 'plain',
        provider: 'lrclib',
        providerId: instrumentalExact.id,
      });
      expect(cached.expiresAt).toBeLessThanOrEqual(now + 6 * 60 * 60 * 1_000);
    }
    expect(remote.upsertExact).not.toHaveBeenCalled();
  });

  it('keeps a provisional instrumental retryable when text search is unavailable', async () => {
    const instrumentalExact = {
      ...LRCLIB_RESULT,
      id: 27248323,
      instrumental: true,
      plainLyrics: null,
      syncedLyrics: null,
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = urlFrom(input);
      return url.pathname === '/api/get'
        ? new Response(JSON.stringify(instrumentalExact), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        : new Response('{}', {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          });
    });
    vi.stubGlobal('fetch', fetchMock);
    const fake = fakeStore();
    const remote = fakeRemote(async () => ({ state: 'miss' }));
    const integrated = serviceWith(fake.store, 'primary', remote.remote);

    await expect(integrated.service.find(TRACK)).resolves.toMatchObject({
      kind: 'plain',
      provider: 'lrclib',
      providerId: instrumentalExact.id,
      retryable: true,
    });

    expect(integrated.repository.stats().entries).toBe(0);
    expect(remote.upsertExact).not.toHaveBeenCalled();
  });

  it('evicts a legacy long-lived instrumental cache before resolving Apple primary', async () => {
    const key = trackFingerprint(TRACK);
    const fake = fakeStore({
      lyricsCache: {
        [key]: {
          payload: {
            kind: 'plain',
            lines: [],
            plainText: '这是一首纯音乐',
            provider: 'lrclib',
            providerId: 27248323,
            notice: 'LRCLIB 将这首曲目标记为纯音乐。',
          },
          lookupStrategy: PRIMARY_LRCLIB_EXACT_LOOKUP_STRATEGY,
          metadataSignature: lyricsLookupFingerprint(TRACK),
          expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1_000,
          revalidateAt: Date.now() + PRIMARY_EXACT_REVALIDATE_MS,
        },
      },
    });
    const remote = fakeRemote(async () => activeExactResult(REMOTE_APPLE_PAYLOAD));
    const integrated = serviceWith(fake.store, 'primary', remote.remote);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(integrated.service.find(TRACK)).resolves.toEqual(REMOTE_APPLE_PAYLOAD);

    expect(fake.updateCachedLyrics.mock.calls[0]?.[0]).toBe(key);
    await vi.waitFor(() => expect(fake.state.lyricsCache[key]).toBeUndefined());
    expect(remote.resolve).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('searches script aliases and accepts Traditional lyrics for Simplified metadata', async () => {
    const track: TrackMetadata = {
      title: '单车',
      artist: '陈奕迅',
      album: '2013 陈奕迅 Music Life 精选',
      durationMs: 209_000,
      source: 'Apple Music',
    };
    const traditionalResult = {
      id: 14737395,
      trackName: '單車',
      artistName: '陳奕迅',
      albumName: 'Shall We Dance? Shall We Talk!',
      duration: 208.627,
      instrumental: false,
      plainLyrics: '不要不要假設我知道',
      syncedLyrics: '[00:14.00]不要不要假設我知道',
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = urlFrom(input);
      if (url.pathname === '/api/get') {
        return new Response('{}', {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const query = decodeURIComponent(url.search);
      const usesTraditionalAlias = query.includes('單車') || query.includes('陳奕迅');
      return new Response(JSON.stringify(usesTraditionalAlias ? [traditionalResult] : []), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const fake = fakeStore();
    const remote = fakeRemote(async () => ({ state: 'miss' }));
    const { service } = serviceWith(fake.store, 'primary', remote.remote);

    await expect(service.find(track)).resolves.toMatchObject({
      kind: 'synced',
      provider: 'lrclib',
      providerId: traditionalResult.id,
    });

    expect(fetchMock.mock.calls.some(([input]) => {
      const query = decodeURIComponent(urlFrom(input).search);
      return query.includes('單車') || query.includes('陳奕迅');
    })).toBe(true);
  });

  it('does not negative-cache a remote unavailable result after an LRCLIB miss', async () => {
    const fetchMock = definitiveMissFetch();
    const fake = fakeStore();
    const remote = fakeRemote(async () => ({ state: 'unavailable', reason: 'timeout' }));
    const integrated = serviceWith(fake.store, 'primary', remote.remote);

    await expect(integrated.service.find(TRACK)).resolves.toMatchObject({ kind: 'missing' });
    const requestsAfterFirstLookup = fetchMock.mock.calls.length;
    expect(requestsAfterFirstLookup).toBeGreaterThan(0);
    expect(integrated.repository.stats().entries).toBe(0);

    // A second lookup must retry both sources instead of returning an L1
    // "missing" entry produced while the primary library was unavailable.
    await Promise.resolve();
    await expect(integrated.service.find(TRACK)).resolves.toMatchObject({ kind: 'missing' });
    expect(remote.resolve).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(requestsAfterFirstLookup);
  });

  it('returns a retryable miss without waiting for Apple backfill enqueue', async () => {
    definitiveMissFetch();
    let finishEnqueue: (() => void) | undefined;
    const enqueueGate = new Promise<void>((resolve) => {
      finishEnqueue = resolve;
    });
    const fake = fakeStore();
    const remote = fakeRemote(async () => ({ state: 'miss' }));
    remote.enqueueAppleLyricsBackfill.mockImplementation(async () => enqueueGate);
    const integrated = serviceWith(fake.store, 'primary', remote.remote, {
      enabled: true,
      storefront: 'us',
      locale: 'en-US',
      maxAttempts: 5,
    });
    const startedAt = Date.now();

    await expect(integrated.service.find(TRACK)).resolves.toMatchObject({
      kind: 'missing',
      retryable: true,
      notice: 'LRCLIB 暂时没有可靠匹配，可在设置页粘贴自己的 LRC。',
    });
    expect(remote.enqueueAppleLyricsBackfill).toHaveBeenCalledExactlyOnceWith({
      exactKey: lyricsLookupFingerprint(TRACK),
      keyVersion: 1,
      storefront: 'us',
      locale: 'en-US',
      track: TRACK,
      maxAttempts: 5,
    });
    expect(integrated.repository.stats().appleBackfill.pending).toBe(1);
    const cachedMiss = integrated.repository.readTrack(trackFingerprint(TRACK)).cached;
    expect(cachedMiss?.expiresAt).toBeGreaterThanOrEqual(startedAt + 29_000);
    expect(cachedMiss?.expiresAt).toBeLessThanOrEqual(Date.now() + 30_000);

    finishEnqueue?.();
    await enqueueGate;
  });

  it('observes playback without waiting for Apple enqueue or querying LRCLIB', async () => {
    let finishEnqueue: (() => void) | undefined;
    const enqueueGate = new Promise<void>((resolve) => {
      finishEnqueue = resolve;
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const fake = fakeStore();
    const remote = fakeRemote();
    remote.enqueueAppleLyricsBackfill.mockImplementation(async () => enqueueGate);
    const { service, repository: lyricsRepository } = serviceWith(
      fake.store,
      'primary',
      remote.remote,
      {
        enabled: true,
        storefront: 'us',
        locale: 'en-US',
        maxAttempts: 5,
      },
    );

    expect(service.observePlayback(TRACK)).toBeUndefined();
    expect(remote.enqueueAppleLyricsBackfill).toHaveBeenCalledExactlyOnceWith({
      exactKey: lyricsLookupFingerprint(TRACK),
      keyVersion: 1,
      storefront: 'us',
      locale: 'en-US',
      track: TRACK,
      maxAttempts: 5,
    });
    expect(lyricsRepository.stats().appleBackfill.pending).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();

    finishEnqueue?.();
    await enqueueGate;
  });

  it('does not enqueue Apple backfill for a retryable upstream failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () =>
      new Response('temporarily unavailable', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const fake = fakeStore();
    const remote = fakeRemote(async () => ({ state: 'miss' }));
    const integrated = serviceWith(fake.store, 'primary', remote.remote, {
      enabled: true,
      storefront: 'us',
      locale: 'en-US',
      maxAttempts: 5,
    });

    await expect(integrated.service.find(TRACK)).resolves.toMatchObject({
      kind: 'missing',
      retryable: true,
    });
    expect(remote.enqueueAppleLyricsBackfill).not.toHaveBeenCalled();
  });

  it('does not negative-cache an LRCLIB exact 500 when every search returns an empty result', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = urlFrom(input);
      if (url.pathname === '/api/get') {
        return new Response('{}', {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('[]', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const fake = fakeStore();
    const remote = fakeRemote(async () => ({ state: 'miss' }));
    const integrated = serviceWith(fake.store, 'primary', remote.remote);

    await expect(integrated.service.find(TRACK)).resolves.toMatchObject({
      kind: 'missing',
      retryable: true,
    });
    const requestsAfterFirstLookup = fetchMock.mock.calls.length;
    expect(integrated.repository.stats().entries).toBe(0);

    await Promise.resolve();
    await expect(integrated.service.find(TRACK)).resolves.toMatchObject({
      kind: 'missing',
      retryable: true,
    });
    // Each miss probes Exact first and then the guarded Work path so a
    // duration-alias Apple route can recover a mismatched recording.
    expect(remote.resolve).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(requestsAfterFirstLookup);
  });

  it.each([
    'Midnight Circuit (Live)',
    'Midnight Circuit - Acoustic Version',
  ])('does not negative-cache %s when the remote work lookup is unavailable', async (title) => {
    const track = { ...TRACK, title };
    const fetchMock = definitiveMissFetch();
    const fake = fakeStore();
    const remote = fakeRemote(async (input) => (
      input.allowWorkFallback
        ? { state: 'unavailable', reason: 'timeout' }
        : { state: 'miss' }
    ));
    const integrated = serviceWith(fake.store, 'primary', remote.remote);

    await expect(integrated.service.find(track)).resolves.toMatchObject({
      kind: 'missing',
      retryable: true,
    });
    const requestsAfterFirstLookup = fetchMock.mock.calls.length;
    expect(integrated.repository.stats().entries).toBe(0);

    await Promise.resolve();
    await expect(integrated.service.find(track)).resolves.toMatchObject({
      kind: 'missing',
      retryable: true,
    });
    expect(remote.resolve.mock.calls.map(([input]) => input.allowWorkFallback)).toEqual([
      false,
      true,
      false,
      true,
    ]);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(requestsAfterFirstLookup);
  });

  it.each([
    'Midnight Circuit (Live)',
    'Midnight Circuit - Acoustic Version',
  ])('lets real LRCLIB lyrics for %s win over a remote work fallback', async (title) => {
    const track = { ...TRACK, title };
    const realVersion = {
      ...LRCLIB_RESULT,
      id: 84,
      trackName: title,
      albumName: 'Live and Unplugged',
      syncedLyrics: '[00:00.00]The requested recording',
    };
    const fetchMock = exactHitFetch(realVersion);
    const fake = fakeStore();
    const remote = fakeRemote(async (input) => (
      input.allowWorkFallback ? workResult() : { state: 'miss' }
    ));
    const { service } = serviceWith(fake.store, 'primary', remote.remote);

    const result = await service.find(track);

    expect(result).toEqual(expect.objectContaining({
      kind: 'synced',
      providerId: realVersion.id,
    }));
    expect(result.fallbackKind).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(remote.resolve).toHaveBeenCalledTimes(1);
    expect(remote.resolve.mock.calls[0]![0].allowWorkFallback).toBe(false);
  });

  it.each([
    'Midnight Circuit (Live)',
    'Midnight Circuit - Acoustic Version',
  ])('uses a static remote work fallback for %s only after a definitive LRCLIB miss', async (title) => {
    const track = { ...TRACK, title };
    const fetchMock = definitiveMissFetch();
    const fake = fakeStore();
    const remote = fakeRemote(async (input) => (
      input.allowWorkFallback ? workResult() : { state: 'miss' }
    ));
    const { service } = serviceWith(fake.store, 'primary', remote.remote);

    const result = await service.find(track);

    expect(result).toEqual(REMOTE_WORK_PAYLOAD);
    expect(result.kind).toBe('plain');
    expect(result.fallbackKind).toBe('work-cache');
    expect(fetchMock.mock.calls.some(([input]) => urlFrom(input).pathname === '/api/search')).toBe(true);
    expect(remote.resolve.mock.calls.map(([input]) => input.allowWorkFallback)).toEqual([
      false,
      true,
    ]);
    expect(remote.upsertExact).not.toHaveBeenCalled();
  });

  it('uses a static Apple duration alias for Chinese 不插电 only after a definitive LRCLIB miss', async () => {
    const track: TrackMetadata = {
      title: '童言无忌(不插电)',
      artist: '王以太',
      album: '闪火mixtape - EP',
      durationMs: 216_000,
      source: 'Apple Music',
    };
    const fetchMock = definitiveMissFetch();
    const fake = fakeStore();
    const remote = fakeRemote(async (input) => (
      input.allowWorkFallback
        ? {
            state: 'hit',
            matchKind: 'work',
            payload: REMOTE_APPLE_DURATION_ALIAS_PAYLOAD,
            documentId: '00000000-0000-4000-8000-000000009003',
            selectionMethod: 'provider',
          }
        : { state: 'miss' }
    ));
    const { service } = serviceWith(fake.store, 'primary', remote.remote);

    await expect(service.find(track)).resolves.toEqual(
      REMOTE_APPLE_DURATION_ALIAS_PAYLOAD,
    );

    expect(fetchMock.mock.calls.some(([input]) =>
      urlFrom(input).pathname === '/api/search')).toBe(true);
    expect(remote.resolve.mock.calls.map(([input]) => input.allowWorkFallback))
      .toEqual([false, true]);
    expect(remote.resolve.mock.calls[1]![0]).toEqual(expect.objectContaining({
      exactKey: lyricsLookupFingerprint(track),
      workKey: lyricsWorkFingerprint(track),
      allowWorkFallback: true,
    }));
    expect(remote.upsertExact).not.toHaveBeenCalled();
  });

  it('uses an Apple duration alias for a normal recording after a definitive LRCLIB miss', async () => {
    const fetchMock = definitiveMissFetch();
    const fake = fakeStore();
    const remote = fakeRemote(async (input) => (
      input.allowWorkFallback
        ? {
            state: 'hit',
            matchKind: 'work',
            payload: REMOTE_APPLE_DURATION_ALIAS_PAYLOAD,
            documentId: '00000000-0000-4000-8000-000000009004',
            selectionMethod: 'provider',
            providerRoute: 'apple-duration-alias-static-v1',
          }
        : { state: 'miss' }
    ));
    const { service } = serviceWith(fake.store, 'primary', remote.remote, {
      enabled: true,
      storefront: 'us',
      locale: 'en-US',
      maxAttempts: 5,
    });

    await expect(service.find(TRACK)).resolves.toEqual({
      ...REMOTE_APPLE_DURATION_ALIAS_PAYLOAD,
      retryable: true,
    });

    expect(fetchMock.mock.calls.some(([input]) =>
      urlFrom(input).pathname === '/api/search')).toBe(true);
    expect(remote.resolve.mock.calls.map(([input]) => input.allowWorkFallback))
      .toEqual([false, true]);
  });

  it('reuses a remote work fallback until forceRefresh explicitly rechecks LRCLIB', async () => {
    const track = { ...TRACK, title: 'Midnight Circuit (Live)' };
    const fetchMock = definitiveMissFetch();
    const fake = fakeStore();
    const remote = fakeRemote(async (input) => (
      input.allowWorkFallback ? workResult() : { state: 'miss' }
    ));
    const { service } = serviceWith(fake.store, 'primary', remote.remote);

    await expect(service.find(track)).resolves.toEqual(REMOTE_WORK_PAYLOAD);
    const lrclibRequestsAfterFirst = fetchMock.mock.calls.length;
    const remoteRequestsAfterFirst = remote.resolve.mock.calls.length;

    await Promise.resolve();
    await expect(service.find(track)).resolves.toEqual(REMOTE_WORK_PAYLOAD);
    expect(fetchMock).toHaveBeenCalledTimes(lrclibRequestsAfterFirst);
    expect(remote.resolve).toHaveBeenCalledTimes(remoteRequestsAfterFirst);

    await Promise.resolve();
    await expect(service.find(track, { forceRefresh: true })).resolves.toEqual(
      REMOTE_WORK_PAYLOAD,
    );
    expect(fetchMock.mock.calls.length).toBeGreaterThan(lrclibRequestsAfterFirst);
    expect(remote.resolve).toHaveBeenCalledTimes(remoteRequestsAfterFirst + 1);
    expect(remote.resolve.mock.calls.at(-1)?.[0].allowWorkFallback).toBe(true);
  });

  it.each([
    'Midnight Circuit (Live)',
    'Midnight Circuit - Acoustic Version',
  ])('rejects an unexpected exact-stage work hit so real LRCLIB %s lyrics can win', async (title) => {
    const track = { ...TRACK, title };
    const realVersion = {
      ...LRCLIB_RESULT,
      id: 108,
      trackName: title,
      syncedLyrics: '[00:00.00]Actual requested version',
    };
    const fetchMock = exactHitFetch(realVersion);
    const fake = fakeStore();
    const remote = fakeRemote(async () => workResult());
    const { service } = serviceWith(fake.store, 'primary', remote.remote);

    const result = await service.find(track);

    expect(result).toEqual(expect.objectContaining({
      kind: 'synced',
      providerId: realVersion.id,
    }));
    expect(result.fallbackKind).toBeUndefined();
    expect(remote.resolve).toHaveBeenCalledTimes(1);
    expect(remote.resolve.mock.calls[0]![0].allowWorkFallback).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not let a pending shadow read delay a hot local result', async () => {
    const key = trackFingerprint(TRACK);
    const cached: CachedLyrics = {
      payload: REMOTE_EXACT_PAYLOAD,
      lookupStrategy: 'lrclib-multi-v2',
      metadataSignature: lyricsLookupFingerprint(TRACK),
      expiresAt: Date.now() + 60_000,
    };
    const fake = fakeStore({ lyricsCache: { [key]: cached } });
    const never = new Promise<LyricsLibraryResolveResult>(() => undefined);
    const remote = fakeRemote(async () => never);
    remote.compareQuarantined.mockImplementation(async () => (
      new Promise<never>(() => undefined)
    ));
    const integrated = serviceWith(fake.store, 'shadow', remote.remote);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    // Simulate an already-running shadow observation. It must remain wholly
    // independent from the local serving path.
    integrated.repository.observeRemote(TRACK);
    await expect(integrated.service.find(TRACK)).resolves.toEqual(REMOTE_EXACT_PAYLOAD);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(remote.resolve).toHaveBeenCalledTimes(1);
    expect(remote.compareQuarantined).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not let a pending shadow read delay an LRCLIB result', async () => {
    const never = new Promise<LyricsLibraryResolveResult>(() => undefined);
    const remote = fakeRemote(async () => never);
    const fake = fakeStore();
    const { service } = serviceWith(fake.store, 'shadow', remote.remote);
    const fetchMock = exactHitFetch();

    const result = await service.find(TRACK);

    expect(result).toEqual(expect.objectContaining({
      kind: 'synced',
      providerId: LRCLIB_RESULT.id,
    }));
    expect(remote.resolve).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('skips the remote exact read when forceRefresh is requested', async () => {
    const remote = fakeRemote(async () => activeExactResult());
    const fake = fakeStore();
    const { service } = serviceWith(fake.store, 'primary', remote.remote);
    const fetchMock = exactHitFetch();

    const result = await service.find(TRACK, { forceRefresh: true });

    expect(result).toEqual(expect.objectContaining({
      kind: 'synced',
      providerId: LRCLIB_RESULT.id,
    }));
    expect(remote.resolve).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries the complete Primary to LRCLIB chain after a temporary failure', async () => {
    const remote = fakeRemote();
    remote.resolve
      .mockResolvedValueOnce({ state: 'unavailable', reason: 'timeout' })
      .mockResolvedValueOnce(activeExactResult());
    const fake = fakeStore();
    const { service } = serviceWith(fake.store, 'primary', remote.remote);
    const fetchMock = definitiveMissFetch();

    await expect(service.find(TRACK)).resolves.toMatchObject({
      kind: 'missing',
      retryable: true,
    });
    const lrclibRequests = fetchMock.mock.calls.length;

    await expect(service.find(TRACK, { bypassLocalCache: true })).resolves.toEqual(
      REMOTE_EXACT_PAYLOAD,
    );
    expect(remote.resolve).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(lrclibRequests);
  });
});
