import sharp from 'sharp';
import type { PersistedState } from './store.js';
import {
  ArtworkPaletteService,
  artworkFingerprint,
  extractArtworkPalette,
  fallbackArtworkPalette,
} from './artwork-palette-service.js';
import type {
  PaletteReadResult,
  PaletteStore,
  PaletteWriteInput,
} from './supabase-palette-client.js';
import type { JsonStore } from './store.js';

const TRACK = {
  title: 'Midnight Circuit',
  artist: 'Local Drive',
  album: 'After Dark',
  durationMs: 214_000,
  source: 'Apple Music',
};

const TEST_FIELD = {
  schemaVersion: 1 as const,
  id: 'field:0123456789abcdef',
  columns: 6 as const,
  rows: 4 as const,
  base: '#17202A',
  colors: Array.from({ length: 24 }, (_, index) => index < 12 ? '#AA3344' : '#3344AA'),
};

const TEST_PALETTE = {
  primary: '#112233',
  secondary: '#445566',
  source: 'apple' as const,
  field: TEST_FIELD,
};

type ResolveOptions = { signal?: AbortSignal };

function resolveWithOptions(
  service: ArtworkPaletteService,
  track: typeof TRACK,
  options: ResolveOptions,
) {
  return (service.resolve as unknown as (
    value: typeof TRACK,
    resolveOptions: ResolveOptions,
  ) => ReturnType<ArtworkPaletteService['resolve']>)(track, options);
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

type DurationSummary = {
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
};

function durationStats(service: ArtworkPaletteService): Record<string, DurationSummary | null> {
  return (service.lookupStats() as ReturnType<ArtworkPaletteService['lookupStats']> & {
    durations: Record<string, DurationSummary | null>;
  }).durations;
}

function testStore(): { store: JsonStore; state: PersistedState } {
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
  };
  return {
    state,
    store: {
      snapshot: () => structuredClone(state),
      readArtworkPalette: (key: string) => state.artworkPaletteCache[key],
      updateArtworkPalette: async (key: string, value: PersistedState['artworkPaletteCache'][string] | undefined) => {
        if (value) state.artworkPaletteCache[key] = structuredClone(value);
        else delete state.artworkPaletteCache[key];
      },
      update: async (mutator: (draft: PersistedState) => void) => mutator(state),
    } as unknown as JsonStore,
  };
}

async function splitColorArtwork(): Promise<Buffer> {
  const width = 40;
  const height = 20;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const color = x < width / 2 ? [220, 35, 60] : [25, 90, 220];
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

async function mostlyNeutralArtwork(): Promise<Buffer> {
  const width = 40;
  const height = 20;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const shade = y < height / 2 ? 205 : 52;
      const color = x < 4 ? [45, 51, 64] : [shade, shade, shade];
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

async function solidArtwork(value: number): Promise<Buffer> {
  return sharp({
    create: {
      width: 20,
      height: 20,
      channels: 3,
      background: { r: value, g: value, b: value },
    },
  }).png().toBuffer();
}

async function transparentArtwork(): Promise<Buffer> {
  const width = 40;
  const height = 20;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      pixels[offset] = x < width / 2 ? 255 : 25;
      pixels[offset + 1] = x < width / 2 ? 0 : 80;
      pixels[offset + 2] = x < width / 2 ? 0 : 220;
      pixels[offset + 3] = x < width / 2 ? 0 : 255;
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

function channelSpread(hex: string): number {
  const channels = [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
  return Math.max(...channels) - Math.min(...channels);
}

function applePayload(results: unknown[]): Response {
  return new Response(JSON.stringify({ resultCount: results.length, results }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function legacyArtworkFingerprint(track = TRACK): string {
  const [, ...parts] = artworkFingerprint(track).split('::');
  return ['v4', ...parts].join('::');
}

describe('ArtworkPaletteService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('matches the correct Apple song, extracts two colors, and caches only the palette', async () => {
    const artwork = await splitColorArtwork();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      if (url.hostname === 'itunes.apple.com') {
        return applePayload([
          {
            trackId: 1,
            trackName: 'Midnight Circuit (Live)',
            artistName: 'Local Drive',
            collectionName: 'Live at Dawn',
            trackTimeMillis: 249_000,
            artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/live/100x100bb.jpg',
          },
          {
            trackId: 2,
            trackName: 'Midnight Circuit',
            artistName: 'Local Drive',
            collectionName: 'After Dark',
            trackTimeMillis: 214_000,
            artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/studio/100x100bb.jpg',
          },
        ]);
      }
      return new Response(Uint8Array.from(artwork), {
        status: 200,
        headers: { 'Content-Type': 'image/png', 'Content-Length': String(artwork.length) },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { store, state } = testStore();
    const service = new ArtworkPaletteService(store);

    const [first, concurrent] = await Promise.all([service.find(TRACK), service.find(TRACK)]);
    const cached = await service.find(TRACK);

    expect(first).toEqual(concurrent);
    expect(cached).toEqual(first);
    expect(first.source).toBe('apple');
    expect(first.primary).toMatch(/^#[0-9A-F]{6}$/);
    expect(first.secondary).toMatch(/^#[0-9A-F]{6}$/);
    expect(first.primary).not.toBe(first.secondary);
    expect(first.field).toMatchObject({
      schemaVersion: 1,
      columns: 6,
      rows: 4,
      id: expect.stringMatching(/^field:[0-9a-f]{16}$/),
    });
    expect(first.field?.colors).toHaveLength(24);
    expect(first.field?.colors.every((color) => /^#[0-9A-F]{6}$/.test(color))).toBe(true);
    expect(Number.parseInt(first.field?.colors[0]?.slice(1, 3) ?? '0', 16))
      .toBeGreaterThan(Number.parseInt(first.field?.colors[0]?.slice(5, 7) ?? '0', 16));
    expect(Number.parseInt(first.field?.colors[5]?.slice(5, 7) ?? '0', 16))
      .toBeGreaterThan(Number.parseInt(first.field?.colors[5]?.slice(1, 3) ?? '0', 16));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(state.artworkPaletteCache)).not.toContain('mzstatic');
  });

  it('falls through from full metadata to the primary core query and records the hit stage', async () => {
    const artwork = await splitColorArtwork();
    const catalogUrls: URL[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      if (url.hostname === 'itunes.apple.com') {
        catalogUrls.push(url);
        if (url.searchParams.get('term')?.includes(TRACK.album)) return applePayload([]);
        return applePayload([{
          trackId: 21,
          trackName: TRACK.title,
          artistName: TRACK.artist,
          collectionName: TRACK.album,
          trackTimeMillis: TRACK.durationMs,
          artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/core/100x100bb.jpg',
        }]);
      }
      return new Response(Uint8Array.from(artwork), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const service = new ArtworkPaletteService(testStore().store);

    const result = await service.resolve(TRACK);

    expect(result.palette.source).toBe('apple');
    expect(result.status).toEqual({
      state: 'success',
      source: 'catalog',
      stage: 'primary-core',
    });
    expect(catalogUrls).toHaveLength(2);
    expect(catalogUrls[0].searchParams.get('term')).toContain(TRACK.album);
    expect(catalogUrls[1].searchParams.get('term')).not.toContain(TRACK.album);
    expect(service.lookupStats()).toMatchObject({
      requests: 1,
      successes: 1,
      searchRequests: 2,
      stageHits: { 'primary-core': 1 },
    });
  });

  it('tries a configured fallback storefront after both primary queries miss', async () => {
    const artwork = await splitColorArtwork();
    const countries: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      if (url.hostname === 'itunes.apple.com') {
        const country = url.searchParams.get('country') ?? '';
        countries.push(country);
        if (country !== 'CN') return applePayload([]);
        return applePayload([{
          trackId: 22,
          trackName: TRACK.title,
          artistName: TRACK.artist,
          collectionName: TRACK.album,
          trackTimeMillis: TRACK.durationMs,
          artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/regional/100x100bb.jpg',
        }]);
      }
      return new Response(Uint8Array.from(artwork), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new ArtworkPaletteService(testStore().store).resolve(TRACK);

    expect(result.status).toEqual({
      state: 'success',
      source: 'catalog',
      stage: 'fallback-core',
    });
    expect(countries).toEqual(['US', 'US', 'CN']);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('ignores a legacy negative cache while preserving the current positive cache identity', async () => {
    const artwork = await splitColorArtwork();
    const { store, state } = testStore();
    const key = artworkFingerprint(TRACK);
    state.artworkPaletteCache[legacyArtworkFingerprint()] = {
      palette: null,
      expiresAt: Date.now() + 60_000,
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      if (url.hostname === 'itunes.apple.com') {
        return applePayload([{
          trackId: 23,
          trackName: TRACK.title,
          artistName: TRACK.artist,
          collectionName: TRACK.album,
          trackTimeMillis: TRACK.durationMs,
          artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/refreshed/100x100bb.jpg',
        }]);
      }
      return new Response(Uint8Array.from(artwork), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new ArtworkPaletteService(store).resolve(TRACK);

    expect(result.status).toMatchObject({ state: 'success', source: 'catalog' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(state.artworkPaletteCache[key]).toMatchObject({
      lookupStrategy: 'multistage-v1',
      palette: { source: 'apple' },
    });
    expect(artworkFingerprint(TRACK)).toMatch(/^v5::/);
  });

  it('records a safe retryable reason when one catalog stage fails and does not negative-cache it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let catalogRequest = 0;
    const fetchMock = vi.fn(async () => {
      catalogRequest += 1;
      if (catalogRequest === 1) return new Response('', { status: 503 });
      return applePayload([]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { store, state } = testStore();
    const service = new ArtworkPaletteService(store);

    const result = await service.resolve(TRACK);

    expect(result.status).toMatchObject({
      state: 'fallback',
      reason: 'catalog-http-server',
      retryable: true,
      cache: 'miss',
    });
    expect(state.artworkPaletteCache[artworkFingerprint(TRACK)]).toBeUndefined();
    expect(service.lookupStats()).toMatchObject({
      fallbacks: 1,
      attemptFailures: { 'catalog-http-server': 1 },
      fallbackReasons: { 'catalog-http-server': 1 },
    });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('catalog-http-server');
    expect(logged).not.toContain(TRACK.title);
    expect(logged).not.toContain(TRACK.artist);
    expect(logged).not.toContain('itunes.apple.com');
  });

  it.each([
    {
      label: 'rate limit',
      reason: 'catalog-rate-limit',
      retryable: true,
      response: () => new Response('', { status: 429 }),
    },
    {
      label: 'client error',
      reason: 'catalog-http-client',
      retryable: false,
      response: () => new Response('', { status: 404 }),
    },
    {
      label: 'timeout',
      reason: 'catalog-timeout',
      retryable: true,
      response: () => Promise.reject(Object.assign(new Error('hidden'), { name: 'TimeoutError' })),
    },
    {
      label: 'network error',
      reason: 'catalog-network',
      retryable: true,
      response: () => Promise.reject(new TypeError('hidden request URL')),
    },
    {
      label: 'malformed response',
      reason: 'catalog-invalid-response',
      retryable: true,
      response: () => new Response('{', { status: 200 }),
    },
  ])('classifies a catalog $label without negative-caching it', async ({ reason, retryable, response }) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let catalogRequest = 0;
    const fetchMock = vi.fn(async () => {
      catalogRequest += 1;
      if (catalogRequest === 1) return response();
      return applePayload([]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { store, state } = testStore();

    const result = await new ArtworkPaletteService(store).resolve(TRACK);

    expect(result.status).toMatchObject({
      state: 'fallback',
      reason,
      retryable,
      cache: 'miss',
    });
    expect(state.artworkPaletteCache[artworkFingerprint(TRACK)]).toBeUndefined();
  });

  it('counts each catalog request against the local limit and does not cache an incomplete lookup', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () => applePayload([]));
    vi.stubGlobal('fetch', fetchMock);
    const { store, state } = testStore();
    const service = new ArtworkPaletteService(store);

    for (let index = 0; index < 4; index += 1) {
      const result = await service.resolve({ ...TRACK, title: `Missing ${index}` });
      expect(result.status).toMatchObject({ reason: 'catalog-empty' });
    }
    const limitedTrack = { ...TRACK, title: 'Rate Limited' };
    const limited = await service.resolve(limitedTrack);

    expect(limited.status).toMatchObject({
      state: 'fallback',
      reason: 'local-rate-limit',
      retryable: true,
      cache: 'miss',
    });
    expect(fetchMock).toHaveBeenCalledTimes(18);
    expect(state.artworkPaletteCache[artworkFingerprint(limitedTrack)]).toBeUndefined();
    expect(service.lookupStats()).toMatchObject({
      searchRequests: 18,
      attemptFailures: { 'local-rate-limit': 1 },
    });
  });

  it('includes lookup-slot queueing in the shared 15 second budget', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const fetchMock = vi.fn(async () => applePayload([]));
      vi.stubGlobal('fetch', fetchMock);
      const service = new ArtworkPaletteService(testStore().store);
      (service as unknown as { activeLookups: number }).activeLookups = 2;

      const pending = service.resolve(TRACK);
      await vi.advanceTimersByTimeAsync(15_000);
      const result = await pending;

      expect(result.status).toMatchObject({
        state: 'fallback',
        reason: 'catalog-timeout',
        retryable: true,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(service.lookupStats()).toMatchObject({
        requests: 1,
        fallbacks: 1,
        attemptFailures: { 'catalog-timeout': 1 },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts an obsolete lookup, releases its slot, and never caches its result', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const tracks = {
      first: { ...TRACK, title: 'Obsolete First' },
      newest: { ...TRACK, title: 'Newest Second' },
    };
    const firstRequests = new Map<string, number>();
    const releases = new Map<string, () => void>();
    const startedTerms: string[] = [];
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      const term = url.searchParams.get('term') ?? '';
      startedTerms.push(term);
      const stalledTrack = [tracks.first].find((track) => term.includes(track.title));
      if (!stalledTrack) return Promise.resolve(applePayload([]));
      const count = (firstRequests.get(stalledTrack.title) ?? 0) + 1;
      firstRequests.set(stalledTrack.title, count);
      if (count > 1) return Promise.resolve(applePayload([]));
      return new Promise<Response>((resolve, reject) => {
        let settled = false;
        const finish = (work: () => void) => {
          if (settled) return;
          settled = true;
          work();
        };
        releases.set(stalledTrack.title, () => finish(() => resolve(applePayload([]))));
        init?.signal?.addEventListener('abort', () => finish(() => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { store, state } = testStore();
    const service = new ArtworkPaletteService(store, undefined);
    const firstController = new AbortController();
    const first = resolveWithOptions(service, tracks.first, { signal: firstController.signal });
    const firstOutcome = first.then(
      () => undefined,
      (error: unknown) => error,
    );
    const newest = resolveWithOptions(service, tracks.newest, {});

    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(startedTerms.some((term) => term.includes(tracks.newest.title))).toBe(false);

      firstController.abort();

      await vi.waitFor(() => {
        expect(startedTerms.some((term) => term.includes(tracks.newest.title))).toBe(true);
      });
      await newest;
      await expect(firstOutcome).resolves.toMatchObject({
        name: 'AbortError',
        message: 'lookup_canceled',
      });
      expect(state.artworkPaletteCache[artworkFingerprint(tracks.first)]).toBeUndefined();
    } finally {
      releases.get(tracks.first.title)?.();
      await Promise.all([firstOutcome, newest]);
    }

    expect(service.lookupStats()).toMatchObject({ cancellations: 1 });
  });

  it('starts a fresh same-key lookup immediately after the previous owner is aborted', async () => {
    const artwork = await splitColorArtwork();
    let catalogRequests = 0;
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      if (url.hostname !== 'itunes.apple.com') {
        return Promise.resolve(new Response(Uint8Array.from(artwork), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        }));
      }
      catalogRequests += 1;
      if (catalogRequests > 1) {
        return Promise.resolve(applePayload([{
          trackId: 176,
          trackName: TRACK.title,
          artistName: TRACK.artist,
          collectionName: TRACK.album,
          trackTimeMillis: TRACK.durationMs,
          artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/restarted/100x100bb.jpg',
        }]));
      }
      return new Promise<Response>((resolve, reject) => {
        const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (init?.signal?.aborted) {
          onAbort();
          return;
        }
        init?.signal?.addEventListener('abort', onAbort, { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const service = new ArtworkPaletteService(testStore().store, undefined);
    const controller = new AbortController();
    const first = resolveWithOptions(service, TRACK, { signal: controller.signal });
    const firstOutcome = first.then(
      () => undefined,
      (error: unknown) => error,
    );

    await vi.waitFor(() => expect(catalogRequests).toBe(1));
    controller.abort();
    const restarted = service.resolve(TRACK);

    await expect(firstOutcome).resolves.toMatchObject({
      name: 'AbortError',
      message: 'lookup_canceled',
    });
    await expect(restarted).resolves.toMatchObject({
      palette: { source: 'apple' },
      status: { state: 'success', source: 'catalog' },
    });
    expect(catalogRequests).toBe(2);
    expect(service.lookupStats()).toMatchObject({
      cancellations: 1,
      concurrency: { active: 0, waiting: 0, inFlight: 0 },
    });
  });

  it('deduplicates identical full and core terms when album metadata is absent', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () => applePayload([]));
    vi.stubGlobal('fetch', fetchMock);
    const service = new ArtworkPaletteService(testStore().store);

    const result = await service.resolve({ ...TRACK, album: '' });

    expect(result.status).toMatchObject({ reason: 'catalog-empty' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(service.lookupStats()).toMatchObject({
      stageAttempts: {
        'primary-full': 1,
        'primary-core': 0,
        'fallback-core': 2,
      },
    });
  });

  it('waits for a second identity signal instead of matching on title and duration alone', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () => applePayload([]));
    vi.stubGlobal('fetch', fetchMock);
    const { store, state } = testStore();
    const incomplete = { ...TRACK, artist: '', album: '' };

    const result = await new ArtworkPaletteService(store).resolve(incomplete);

    expect(result.status).toEqual({
      state: 'fallback',
      reason: 'insufficient-metadata',
      retryable: true,
      cache: 'miss',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.artworkPaletteCache[artworkFingerprint(incomplete)]).toBeUndefined();
  });

  it('uses the local compatibility cache before consulting Supabase or Apple', async () => {
    const { store, state } = testStore();
    const key = artworkFingerprint(TRACK);
    state.artworkPaletteCache[key] = {
      palette: TEST_PALETTE,
      expiresAt: Date.now() + 60_000,
      lookupStrategy: 'multistage-v1',
    };
    const paletteStore = {
      read: vi.fn(async () => ({
        palette: { ...TEST_PALETTE, primary: '#AABBCC' },
        providerName: 'apple' as const,
        updatedAt: '2026-07-22T00:00:00.000Z',
      })),
      upsert: vi.fn(async (_input: PaletteWriteInput) => undefined),
    };
    const fetchMock = vi.fn(async () => {
      throw new Error('Apple must not be consulted for a local cache hit');
    });
    vi.stubGlobal('fetch', fetchMock);
    const service = new ArtworkPaletteService(store, paletteStore);

    const result = await service.resolve(TRACK);

    expect(result).toMatchObject({
      palette: TEST_PALETTE,
      status: { state: 'success', source: 'positive-cache' },
    });
    expect(paletteStore.read).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(durationStats(service).local).toMatchObject({ count: 1 });
    expect(durationStats(service).total).toMatchObject({ count: 1 });
  });

  it('returns an exact Supabase v2 palette without consulting Apple', async () => {
    const { store } = testStore();
    const key = artworkFingerprint(TRACK);
    const paletteStore = {
      read: vi.fn(async () => ({
        palette: TEST_PALETTE,
        providerName: 'apple' as const,
        providerTrackId: '77',
        matchConfidence: 0.97,
        updatedAt: '2026-07-22T00:00:00.000Z',
      })),
      upsert: vi.fn(async (_input: PaletteWriteInput) => undefined),
    };
    const fetchMock = vi.fn(async () => {
      throw new Error('Apple must not be consulted for a Supabase hit');
    });
    vi.stubGlobal('fetch', fetchMock);
    const service = new ArtworkPaletteService(store, paletteStore);

    const result = await service.resolve(TRACK);

    expect(result).toEqual({
      palette: TEST_PALETTE,
      status: { state: 'success', source: 'supabase-cache' },
    });
    expect(paletteStore.read).toHaveBeenCalledOnce();
    expect(paletteStore.read).toHaveBeenCalledWith(key);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(durationStats(service).supabase).toMatchObject({ count: 1 });
    expect(durationStats(service).total).toMatchObject({ count: 1 });

    await expect(service.resolve(TRACK)).resolves.toMatchObject({
      palette: TEST_PALETTE,
      status: { state: 'success', source: 'positive-cache' },
    });
    expect(paletteStore.read).toHaveBeenCalledOnce();
  });

  it('warms an exact Supabase palette without starting Apple lookup', async () => {
    const { store } = testStore();
    const key = artworkFingerprint(TRACK);
    const paletteStore = {
      read: vi.fn(async () => ({
        palette: TEST_PALETTE,
        providerName: 'apple' as const,
        providerTrackId: '77',
        matchConfidence: 0.97,
        updatedAt: '2026-07-22T00:00:00.000Z',
      })),
      upsert: vi.fn(async (_input: PaletteWriteInput) => undefined),
    };
    const fetchMock = vi.fn(async () => {
      throw new Error('Apple must not be consulted by an exact cache probe');
    });
    vi.stubGlobal('fetch', fetchMock);
    const service = new ArtworkPaletteService(store, paletteStore);

    await expect(service.resolveCached(TRACK)).resolves.toEqual({
      palette: TEST_PALETTE,
      status: { state: 'success', source: 'supabase-cache' },
    });
    expect(paletteStore.read).toHaveBeenCalledExactlyOnceWith(key);
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(service.resolve(TRACK)).resolves.toMatchObject({
      palette: TEST_PALETTE,
      status: { state: 'success', source: 'positive-cache' },
    });
    expect(paletteStore.read).toHaveBeenCalledOnce();
    expect(service.lookupStats()).toMatchObject({
      cacheProbe: { requests: 1, hits: 1, misses: 0, cancellations: 0 },
    });
  });

  it('reuses a recent Supabase probe miss when the Apple lookup begins', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const paletteStore = {
      read: vi.fn(async () => undefined),
      upsert: vi.fn(async (_input: PaletteWriteInput) => undefined),
    };
    const fetchMock = vi.fn(async () => applePayload([]));
    vi.stubGlobal('fetch', fetchMock);
    const service = new ArtworkPaletteService(testStore().store, paletteStore);

    await expect(service.resolveCached(TRACK)).resolves.toBeNull();
    const result = await service.resolve(TRACK);

    expect(result.status).toMatchObject({
      state: 'fallback',
      reason: 'catalog-empty',
    });
    expect(paletteStore.read).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalled();
    expect(service.lookupStats()).toMatchObject({
      cacheProbe: { requests: 1, hits: 0, misses: 1, cancellations: 0 },
    });
  });

  it('prefers an exact Supabase hit after the hedge over a faster Apple fallback', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let releaseRemote!: (result: PaletteReadResult) => void;
    const remote = new Promise<PaletteReadResult>((resolve) => {
      releaseRemote = resolve;
    });
    const paletteStore = {
      read: vi.fn(() => remote),
      upsert: vi.fn(async (_input: PaletteWriteInput) => undefined),
    } satisfies PaletteStore;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      expect(url.hostname).toBe('itunes.apple.com');
      return applePayload([]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const service = new ArtworkPaletteService(testStore().store, paletteStore);
    let settled = false;
    const pending = service.resolve(TRACK).then((result) => {
      settled = true;
      return result;
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    await nextTurn();
    expect(settled).toBe(false);

    releaseRemote({
      palette: TEST_PALETTE,
      providerName: 'apple',
      providerTrackId: 'delayed-exact',
      matchConfidence: 1,
      updatedAt: '2026-07-22T00:00:00.000Z',
    });

    await expect(pending).resolves.toEqual({
      palette: TEST_PALETTE,
      status: { state: 'success', source: 'supabase-cache' },
    });
    expect(service.lookupStats()).toMatchObject({
      cacheHits: { supabase: 1 },
      supabase: { readHits: 1, servedHits: 1 },
    });
  });

  it('counts a Supabase hit that loses to Apple only as read, not served', async () => {
    const artwork = await splitColorArtwork();
    let releaseRemote!: (result: PaletteReadResult) => void;
    const remote = new Promise<PaletteReadResult>((resolve) => {
      releaseRemote = resolve;
    });
    const paletteStore = {
      read: vi.fn(() => remote),
      upsert: vi.fn(async (_input: PaletteWriteInput) => undefined),
    } satisfies PaletteStore;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      if (url.hostname === 'itunes.apple.com') {
        return applePayload([{
          trackId: 178,
          trackName: TRACK.title,
          artistName: TRACK.artist,
          collectionName: TRACK.album,
          trackTimeMillis: TRACK.durationMs,
          artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/apple-winner/100x100bb.jpg',
        }]);
      }
      return new Response(Uint8Array.from(artwork), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const service = new ArtworkPaletteService(testStore().store, paletteStore);

    await expect(service.resolve(TRACK)).resolves.toMatchObject({
      palette: { source: 'apple' },
      status: { state: 'success', source: 'catalog' },
    });

    releaseRemote({
      palette: TEST_PALETTE,
      providerName: 'apple',
      providerTrackId: 'late-loser',
      matchConfidence: 1,
      updatedAt: '2026-07-22T00:00:00.000Z',
    });
    await vi.waitFor(() => {
      expect(service.lookupStats()).toMatchObject({
        cacheHits: { supabase: 0 },
        supabase: { readHits: 1, servedHits: 0 },
      });
    });
  });

  it('does not count a late Supabase hit as served after cancellation', async () => {
    let releaseRemote!: (result: PaletteReadResult) => void;
    const remote = new Promise<PaletteReadResult>((resolve) => {
      releaseRemote = resolve;
    });
    const paletteStore = {
      read: vi.fn(() => remote),
      upsert: vi.fn(async (_input: PaletteWriteInput) => undefined),
    } satisfies PaletteStore;
    const fetchMock = vi.fn(async () => applePayload([]));
    vi.stubGlobal('fetch', fetchMock);
    const service = new ArtworkPaletteService(testStore().store, paletteStore);
    const controller = new AbortController();
    const canceled = resolveWithOptions(service, TRACK, { signal: controller.signal });

    controller.abort();
    await expect(canceled).rejects.toMatchObject({
      name: 'AbortError',
      message: 'lookup_canceled',
    });
    releaseRemote({
      palette: TEST_PALETTE,
      providerName: 'apple',
      providerTrackId: 'late-after-cancel',
      matchConfidence: 1,
      updatedAt: '2026-07-22T00:00:00.000Z',
    });
    await vi.waitFor(() => {
      expect(service.lookupStats()).toMatchObject({
        cacheHits: { supabase: 0 },
        supabase: { readHits: 1, servedHits: 0 },
      });
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'miss',
      read: async () => undefined,
    },
    {
      label: 'timeout',
      read: async () => {
        throw Object.assign(new Error('read timeout'), { name: 'TimeoutError' });
      },
    },
  ])('continues to Apple when the Supabase read is a $label', async ({ read }) => {
    const artwork = await splitColorArtwork();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      if (url.hostname === 'itunes.apple.com') {
        return applePayload([{
          trackId: 78,
          trackName: TRACK.title,
          artistName: TRACK.artist,
          collectionName: TRACK.album,
          trackTimeMillis: TRACK.durationMs,
          artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/supabase-fallback/100x100bb.jpg',
        }]);
      }
      return new Response(Uint8Array.from(artwork), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const paletteStore = {
      read: vi.fn(read),
      upsert: vi.fn(async (_input: PaletteWriteInput) => undefined),
    };
    const service = new ArtworkPaletteService(testStore().store, paletteStore);

    const result = await service.resolve(TRACK);

    expect(result.status).toMatchObject({ state: 'success', source: 'catalog' });
    expect(result.palette.source).toBe('apple');
    expect(paletteStore.read).toHaveBeenCalledWith(artworkFingerprint(TRACK));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(durationStats(service).supabase).toMatchObject({ count: 1 });
    expect(durationStats(service).catalog).toMatchObject({ count: 1 });
  });

  it('returns a cold palette before a slow local compatibility-cache write completes', async () => {
    const artwork = await splitColorArtwork();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      if (url.hostname === 'itunes.apple.com') {
        return applePayload([{
          trackId: 79,
          trackName: TRACK.title,
          artistName: TRACK.artist,
          collectionName: TRACK.album,
          trackTimeMillis: TRACK.durationMs,
          artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/slow-persist/100x100bb.jpg',
        }]);
      }
      return new Response(Uint8Array.from(artwork), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { store, state } = testStore();
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const updateArtworkPalette = vi.fn(async (
      key: string,
      value: PersistedState['artworkPaletteCache'][string],
    ) => {
      await writeGate;
      state.artworkPaletteCache[key] = structuredClone(value);
    });
    Object.assign(store, { updateArtworkPalette });
    const service = new ArtworkPaletteService(store, undefined);
    let settled = false;
    const pending = service.resolve(TRACK).then((result) => {
      settled = true;
      return result;
    });

    try {
      await vi.waitFor(() => expect(updateArtworkPalette).toHaveBeenCalledOnce());
      await nextTurn();

      expect(settled).toBe(true);
      await expect(pending).resolves.toMatchObject({
        palette: { source: 'apple' },
        status: { state: 'success', source: 'catalog' },
      });
    } finally {
      releaseWrite();
      await pending;
    }

    await vi.waitFor(() => {
      expect(durationStats(service).persist).toMatchObject({ count: 1 });
    });
    const durations = durationStats(service);
    expect(Object.keys(durations)).toEqual(expect.arrayContaining([
      'local',
      'supabase',
      'queue',
      'catalog',
      'download',
      'analyze',
      'persist',
      'total',
    ]));
    expect(durations.catalog).toMatchObject({ count: 1 });
    expect(durations.download).toMatchObject({ count: 1 });
    expect(durations.analyze).toMatchObject({ count: 1 });
    expect(durations.total).toMatchObject({ count: 1 });
  });

  it('returns and caches the palette without waiting for asynchronous palette persistence', async () => {
    const artwork = await splitColorArtwork();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      if (url.hostname === 'itunes.apple.com') {
        return applePayload([{
          trackId: 77,
          trackName: TRACK.title,
          artistName: TRACK.artist,
          collectionName: TRACK.album,
          trackTimeMillis: TRACK.durationMs,
          artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/studio/100x100bb.jpg',
        }]);
      }
      return new Response(Uint8Array.from(artwork), {
        status: 200,
        headers: { 'Content-Type': 'image/png', 'Content-Length': String(artwork.length) },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    let releaseWrite!: () => void;
    let writeSettled = false;
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const paletteStore = {
      upsert: vi.fn(async (_input: PaletteWriteInput) => {
        await writeGate;
        writeSettled = true;
      }),
    } satisfies PaletteStore;
    const { store, state } = testStore();
    const key = artworkFingerprint(TRACK);

    const service = new ArtworkPaletteService(store, paletteStore);
    const palette = await service.find(TRACK);

    expect(palette.source).toBe('apple');
    expect(state.artworkPaletteCache[key]?.palette).toEqual(palette);
    expect(writeSettled).toBe(false);

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(paletteStore.upsert).toHaveBeenCalledTimes(1);
    const [persisted] = paletteStore.upsert.mock.calls[0];
    expect(persisted).toEqual({
      track: TRACK,
      artworkKey: key,
      providerName: 'apple',
      providerTrackId: 77,
      matchConfidence: expect.any(Number),
      palette,
    });
    expect(persisted.matchConfidence).toBeGreaterThanOrEqual(0.72);
    expect(persisted).not.toHaveProperty('image');
    expect(persisted).not.toHaveProperty('contentType');
    expect(JSON.stringify(persisted)).not.toContain(artwork.toString('base64'));
    expect(writeSettled).toBe(false);
    expect(service.syncStats()).toMatchObject({ mode: 'off', queued: 0, active: 1 });

    releaseWrite();
    await paletteStore.upsert.mock.results[0]?.value;
    expect(writeSettled).toBe(true);
    expect(service.syncStats()).toMatchObject({ successes: 1, failures: 0 });
  });

  it('does not let an immediate local-cache hit overwrite queued Apple provenance', async () => {
    const artwork = await splitColorArtwork();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      if (url.hostname === 'itunes.apple.com') {
        return applePayload([{
          trackId: 177,
          trackName: TRACK.title,
          artistName: TRACK.artist,
          collectionName: TRACK.album,
          trackTimeMillis: TRACK.durationMs,
          artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/provenance/100x100bb.jpg',
        }]);
      }
      return new Response(Uint8Array.from(artwork), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const paletteStore = {
      upsert: vi.fn(async (_input: PaletteWriteInput) => undefined),
    } satisfies PaletteStore;
    const service = new ArtworkPaletteService(testStore().store, paletteStore);

    await expect(service.resolve(TRACK)).resolves.toMatchObject({
      status: { state: 'success', source: 'catalog' },
    });
    await expect(service.resolve(TRACK)).resolves.toMatchObject({
      status: { state: 'success', source: 'positive-cache' },
    });
    await nextTurn();

    expect(paletteStore.upsert).toHaveBeenCalledTimes(1);
    expect(paletteStore.upsert.mock.calls.map(([input]) => input.providerName)).toEqual(['apple']);
    expect(paletteStore.upsert).toHaveBeenCalledWith(expect.objectContaining({
      artworkKey: artworkFingerprint(TRACK),
      providerName: 'apple',
      providerTrackId: 177,
    }));
  });

  it('persists an existing current palette without downloading or retaining artwork', async () => {
    const { store, state } = testStore();
    const key = artworkFingerprint(TRACK);
    const palette = {
      primary: '#112233',
      secondary: '#445566',
      source: 'apple' as const,
      field: TEST_FIELD,
    };
    state.artworkPaletteCache[key] = {
      palette,
      expiresAt: Date.now() + 60_000,
    };
    const paletteStore = {
      upsert: vi.fn(async (_input: PaletteWriteInput) => undefined),
    };
    const service = new ArtworkPaletteService(store, paletteStore);

    await expect(service.find(TRACK)).resolves.toEqual(palette);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(paletteStore.upsert).toHaveBeenCalledWith({
      track: TRACK,
      artworkKey: key,
      providerName: 'local-cache',
      palette,
    });
    expect(paletteStore.upsert.mock.calls[0][0]).not.toHaveProperty('image');
    expect(service.syncStats()).toMatchObject({ successes: 1, failures: 0 });
  });

  it('refreshes an unversioned song instead of trusting an unverifiable legacy positive cache', async () => {
    const artwork = await splitColorArtwork();
    const { store, state } = testStore();
    state.artworkPaletteCache[legacyArtworkFingerprint()] = {
      palette: {
        primary: '#112233',
        secondary: '#445566',
        source: 'apple',
        field: TEST_FIELD,
      },
      expiresAt: Date.now() + 60_000,
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      if (url.hostname === 'itunes.apple.com') {
        return applePayload([{
          trackId: 24,
          trackName: TRACK.title,
          artistName: TRACK.artist,
          collectionName: TRACK.album,
          trackTimeMillis: TRACK.durationMs,
          artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/v4/100x100bb.jpg',
        }]);
      }
      return new Response(Uint8Array.from(artwork), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new ArtworkPaletteService(store).resolve(TRACK);

    expect(result.status).toMatchObject({ state: 'success', source: 'catalog' });
    expect(result.palette.primary).not.toBe('#112233');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(state.artworkPaletteCache[artworkFingerprint(TRACK)]?.palette).toEqual(result.palette);
  });

  it('does not reuse a legacy positive palette for a versioned recording', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const versionedTrack = { ...TRACK, title: `${TRACK.title} (Live)` };
    const { store, state } = testStore();
    state.artworkPaletteCache[legacyArtworkFingerprint(versionedTrack)] = {
      palette: {
        primary: '#112233',
        secondary: '#445566',
        source: 'apple',
        field: TEST_FIELD,
      },
      expiresAt: Date.now() + 60_000,
    };
    const fetchMock = vi.fn(async () => applePayload([]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new ArtworkPaletteService(store).resolve(versionedTrack);

    expect(result.palette.source).toBe('fallback');
    expect(result.status).toMatchObject({ reason: 'catalog-empty' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('ignores an invalid current positive cache entry and retries catalog lookup', async () => {
    const { store, state } = testStore();
    state.artworkPaletteCache[artworkFingerprint(TRACK)] = {
      palette: {
        primary: '#112233',
        secondary: '#445566',
        source: 'apple',
      },
      expiresAt: Date.now() + 60_000,
    };
    const fetchMock = vi.fn(async () => applePayload([]));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new ArtworkPaletteService(store).find(TRACK))
      .resolves.toEqual(fallbackArtworkPalette(TRACK));

    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('negative-caches a low-confidence catalog result and returns a deterministic fallback', async () => {
    const fetchMock = vi.fn(async () => applePayload([
      {
        trackId: 3,
        trackName: 'Completely Different Song',
        artistName: 'Another Artist',
        collectionName: 'Other Album',
        trackTimeMillis: 90_000,
        artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/other/100x100bb.jpg',
      },
    ]));
    vi.stubGlobal('fetch', fetchMock);
    const { store, state } = testStore();
    const service = new ArtworkPaletteService(store);

    const first = await service.resolve(TRACK);
    const second = await service.resolve(TRACK);

    expect(first.palette).toEqual(second.palette);
    expect(first.palette.source).toBe('fallback');
    expect(first.status).toMatchObject({
      state: 'fallback',
      reason: 'catalog-album-mismatch',
      retryable: false,
      cache: 'miss',
    });
    expect(second.status).toMatchObject({
      state: 'fallback',
      reason: 'catalog-album-mismatch',
      cache: 'negative-hit',
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(state.artworkPaletteCache[artworkFingerprint(TRACK)]).toMatchObject({
      palette: null,
      lookupStrategy: 'multistage-v1',
      failureReason: 'catalog-album-mismatch',
      lookupStage: 'fallback-core',
    });
  });

  it.each([
    {
      reason: 'catalog-missing-artwork',
      candidate: {
        trackId: 51,
        trackName: TRACK.title,
        artistName: TRACK.artist,
        collectionName: TRACK.album,
        trackTimeMillis: TRACK.durationMs,
      },
    },
    {
      reason: 'catalog-version-mismatch',
      candidate: {
        trackId: 52,
        trackName: `${TRACK.title} (Live)`,
        artistName: TRACK.artist,
        collectionName: TRACK.album,
        trackTimeMillis: TRACK.durationMs,
        artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/live/100x100bb.jpg',
      },
    },
    {
      reason: 'catalog-low-confidence',
      candidate: {
        trackId: 53,
        trackName: 'Different Title',
        artistName: TRACK.artist,
        collectionName: TRACK.album,
        trackTimeMillis: TRACK.durationMs,
        artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/other/100x100bb.jpg',
      },
    },
  ])('records $reason as a definitive catalog miss', async ({ reason, candidate }) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () => applePayload([candidate]));
    vi.stubGlobal('fetch', fetchMock);
    const { store, state } = testStore();

    const result = await new ArtworkPaletteService(store).resolve(TRACK);

    expect(result.status).toMatchObject({ state: 'fallback', reason, retryable: false });
    expect(state.artworkPaletteCache[artworkFingerprint(TRACK)]).toMatchObject({
      palette: null,
      failureReason: reason,
      lookupStrategy: 'multistage-v1',
    });
  });

  it('rejects the same song and artist when the album does not match', async () => {
    const fetchMock = vi.fn(async () => applePayload([
      {
        trackId: 5,
        trackName: TRACK.title,
        artistName: TRACK.artist,
        collectionName: 'Unrelated Compilation',
        trackTimeMillis: TRACK.durationMs,
        artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/wrong/100x100bb.jpg',
      },
    ]));
    vi.stubGlobal('fetch', fetchMock);
    const { store } = testStore();

    const palette = await new ArtworkPaletteService(store).find(TRACK);

    expect(palette).toEqual(fallbackArtworkPalette(TRACK));
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('falls back instead of choosing between equally strong candidates with different covers', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () => applePayload([
      {
        trackId: 31,
        trackName: TRACK.title,
        artistName: TRACK.artist,
        collectionName: TRACK.album,
        trackTimeMillis: TRACK.durationMs,
        artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/edition-a/100x100bb.jpg',
      },
      {
        trackId: 32,
        trackName: TRACK.title,
        artistName: TRACK.artist,
        collectionName: TRACK.album,
        trackTimeMillis: TRACK.durationMs,
        artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/edition-b/100x100bb.jpg',
      },
    ]));
    vi.stubGlobal('fetch', fetchMock);
    const { store, state } = testStore();

    const result = await new ArtworkPaletteService(store).resolve(TRACK);

    expect(result.status).toMatchObject({
      state: 'fallback',
      reason: 'ambiguous-candidate',
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(state.artworkPaletteCache[artworkFingerprint(TRACK)]).toMatchObject({
      palette: null,
      lookupStrategy: 'multistage-v1',
      failureReason: 'ambiguous-candidate',
    });
  });

  it('keeps an earlier ambiguous candidate set when a later query returns only one edition', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let request = 0;
    const editions = [
      {
        trackId: 35,
        trackName: TRACK.title,
        artistName: TRACK.artist,
        collectionName: TRACK.album,
        trackTimeMillis: TRACK.durationMs,
        artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/edition-c/100x100bb.jpg',
      },
      {
        trackId: 36,
        trackName: TRACK.title,
        artistName: TRACK.artist,
        collectionName: TRACK.album,
        trackTimeMillis: TRACK.durationMs,
        artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/edition-d/100x100bb.jpg',
      },
    ];
    const fetchMock = vi.fn(async () => {
      request += 1;
      return applePayload(request === 1 ? editions : [editions[0]]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new ArtworkPaletteService(testStore().store).resolve(TRACK);

    expect(result.status).toMatchObject({ reason: 'ambiguous-candidate' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('treats different mzstatic hosts for the same asset path as one cover', async () => {
    const artwork = await splitColorArtwork();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      if (url.hostname === 'itunes.apple.com') {
        return applePayload([
          {
            trackId: 33,
            trackName: TRACK.title,
            artistName: TRACK.artist,
            collectionName: TRACK.album,
            trackTimeMillis: TRACK.durationMs,
            artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/shared/100x100bb.jpg?one=1',
          },
          {
            trackId: 34,
            trackName: TRACK.title,
            artistName: TRACK.artist,
            collectionName: TRACK.album,
            trackTimeMillis: TRACK.durationMs,
            artworkUrl100: 'https://is2-ssl.mzstatic.com/image/thumb/shared/200x200bb.jpg?two=2',
          },
        ]);
      }
      return new Response(Uint8Array.from(artwork), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new ArtworkPaletteService(testStore().store).resolve(TRACK);

    expect(result.palette.source).toBe('apple');
    expect(result.status).toMatchObject({ state: 'success', stage: 'primary-full' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('skips a higher-ranked wrong release and selects a reliable album match', async () => {
    const artwork = await splitColorArtwork();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      if (url.hostname === 'itunes.apple.com') {
        return applePayload([
          {
            trackId: 6,
            trackName: `${TRACK.title} (Remix)`,
            artistName: TRACK.artist,
            collectionName: 'Unrelated Compilation',
            trackTimeMillis: TRACK.durationMs,
            artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/wrong/100x100bb.jpg',
          },
          {
            trackId: 7,
            trackName: `${TRACK.title} (Remixed)`,
            artistName: TRACK.artist,
            collectionName: TRACK.album,
            trackTimeMillis: TRACK.durationMs,
            artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/correct/100x100bb.jpg',
          },
        ]);
      }
      return new Response(Uint8Array.from(artwork), {
        status: 200,
        headers: { 'Content-Type': 'image/png', 'Content-Length': String(artwork.length) },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { store } = testStore();

    const palette = await new ArtworkPaletteService(store).find({
      ...TRACK,
      title: `${TRACK.title} (Remix)`,
    });

    expect(palette.source).toBe('apple');
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('/correct/');
  });

  it('rejects artwork URLs outside the Apple image CDN', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () => applePayload([
      {
        trackId: 4,
        trackName: TRACK.title,
        artistName: TRACK.artist,
        collectionName: TRACK.album,
        trackTimeMillis: TRACK.durationMs,
        artworkUrl100: 'https://example.com/image/cover.jpg',
      },
    ]));
    vi.stubGlobal('fetch', fetchMock);
    const { store } = testStore();

    const result = await new ArtworkPaletteService(store).resolve(TRACK);

    expect(result.palette.source).toBe('fallback');
    expect(result.status).toMatchObject({
      state: 'fallback',
      reason: 'artwork-url-rejected',
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 404, reason: 'artwork-http-client', retryable: false },
    { status: 429, reason: 'artwork-rate-limit', retryable: true },
    { status: 503, reason: 'artwork-http-server', retryable: true },
  ])('classifies artwork HTTP $status without negative-caching it', async ({ status, reason, retryable }) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      if (url.hostname === 'itunes.apple.com') {
        return applePayload([{
          trackId: 41,
          trackName: TRACK.title,
          artistName: TRACK.artist,
          collectionName: TRACK.album,
          trackTimeMillis: TRACK.durationMs,
          artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/http/100x100bb.jpg',
        }]);
      }
      return new Response('', { status });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { store, state } = testStore();

    const result = await new ArtworkPaletteService(store).resolve(TRACK);

    expect(result.status).toMatchObject({
      state: 'fallback',
      reason,
      retryable,
      cache: 'miss',
    });
    expect(state.artworkPaletteCache[artworkFingerprint(TRACK)]).toBeUndefined();
  });

  it('rejects an artwork whose decoded format disagrees with the HTTP MIME type', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const artwork = await splitColorArtwork();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      if (url.hostname === 'itunes.apple.com') {
        return applePayload([{
          trackId: 9,
          trackName: TRACK.title,
          artistName: TRACK.artist,
          collectionName: TRACK.album,
          trackTimeMillis: TRACK.durationMs,
          artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/studio/100x100bb.jpg',
        }]);
      }
      return new Response(Uint8Array.from(artwork), {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const paletteStore = { upsert: vi.fn(async () => undefined) };

    const result = await new ArtworkPaletteService(testStore().store, paletteStore).resolve(TRACK);

    expect(result.palette.source).toBe('fallback');
    expect(result.status).toMatchObject({
      state: 'fallback',
      reason: 'artwork-invalid-response',
      retryable: false,
    });
    expect(paletteStore.upsert).not.toHaveBeenCalled();
  });

  it('extracts a valid, distinct palette from cover pixels', async () => {
    const palette = await extractArtworkPalette(await splitColorArtwork());

    expect(palette.source).toBe('apple');
    expect(palette.primary).toMatch(/^#[0-9A-F]{6}$/);
    expect(palette.secondary).toMatch(/^#[0-9A-F]{6}$/);
    expect(palette.primary).not.toBe(palette.secondary);
    expect(palette.field?.colors).toHaveLength(24);
    expect((await extractArtworkPalette(await splitColorArtwork())).field?.id).toBe(palette.field?.id);
  });

  it('keeps a mostly monochrome cover neutral instead of amplifying a small blue tint', async () => {
    const palette = await extractArtworkPalette(await mostlyNeutralArtwork());

    expect(palette.source).toBe('apple');
    expect(channelSpread(palette.primary)).toBeLessThanOrEqual(2);
    expect(channelSpread(palette.secondary)).toBeLessThanOrEqual(2);
  });

  it.each([0, 255])('keeps a solid grayscale cover neutral at channel value %i', async (value) => {
    const palette = await extractArtworkPalette(await solidArtwork(value));

    expect(channelSpread(palette.primary)).toBeLessThanOrEqual(2);
    expect(channelSpread(palette.secondary)).toBeLessThanOrEqual(2);
  });

  it('flattens transparent pixels onto the dark app base instead of leaking hidden RGB', async () => {
    const palette = await extractArtworkPalette(await transparentArtwork());
    const left = palette.field?.colors[0] ?? '#000000';
    const right = palette.field?.colors[5] ?? '#000000';

    expect(Number.parseInt(left.slice(1, 3), 16))
      .toBeLessThanOrEqual(Number.parseInt(left.slice(5, 7), 16) + 4);
    expect(Number.parseInt(right.slice(5, 7), 16))
      .toBeGreaterThan(Number.parseInt(right.slice(1, 3), 16));
  });

  it('uses album metadata, version tags, and the v5 organic-sampling algorithm in its cache identity', () => {
    expect(artworkFingerprint(TRACK)).toMatch(/^v5::/);
    expect(artworkFingerprint(TRACK)).not.toBe(
      artworkFingerprint({ ...TRACK, album: 'After Dark Deluxe' }),
    );
    expect(artworkFingerprint({ ...TRACK, title: `${TRACK.title} (Live)` })).not.toBe(
      artworkFingerprint(TRACK),
    );
    expect(artworkFingerprint({ ...TRACK, title: `${TRACK.title} (Acoustic)` })).not.toBe(
      artworkFingerprint(TRACK),
    );
  });
});
