import { createVerify, generateKeyPairSync } from 'node:crypto';
import type { TrackMetadata } from '../shared/contracts.js';
import {
  AppleMusicCatalogService,
  createAppleMusicDeveloperToken,
  type AppleMusicCatalogSettings,
} from './apple-music-catalog.js';

const TRACK: TrackMetadata = {
  title: 'Midnight Circuit',
  artist: 'Local Drive',
  album: 'After Dark',
  durationMs: 214_000,
  source: 'Apple Music',
};

const settings = (overrides: Partial<AppleMusicCatalogSettings> = {}): AppleMusicCatalogSettings => ({
  developerToken: 'developer-token',
  teamId: '',
  keyId: '',
  privateKeyPath: '',
  storefront: 'us',
  ...overrides,
});

function searchResponse(songs: unknown[]): Response {
  return new Response(JSON.stringify({ results: { songs: { data: songs } } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requestUrl(input: string | URL | Request): URL {
  if (input instanceof URL) return input;
  if (input instanceof Request) return new URL(input.url);
  return new URL(input);
}

function song(
  id: string,
  attributes: Partial<{
    name: string;
    artistName: string;
    albumName: string;
    durationInMillis: number;
    hasLyrics: boolean;
    isrc: string;
  }> = {},
) {
  return {
    id,
    type: 'songs',
    attributes: {
      name: 'Midnight Circuit',
      artistName: 'Local Drive',
      albumName: 'After Dark',
      durationInMillis: 214_000,
      hasLyrics: true,
      ...attributes,
    },
  };
}

describe('AppleMusicCatalogService', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('creates a verifiable ES256 developer token with Apple claims', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const generated = createAppleMusicDeveloperToken(
      'TEAM123456',
      'KEY1234567',
      privatePem,
      1_700_000_000,
    );
    const [encodedHeader, encodedPayload, encodedSignature] = generated.token.split('.');
    const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    const verified = createVerify('SHA256')
      .update(`${encodedHeader}.${encodedPayload}`)
      .end()
      .verify(
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(encodedSignature, 'base64url'),
      );

    expect(header).toEqual({ alg: 'ES256', kid: 'KEY1234567' });
    expect(payload).toEqual({
      iss: 'TEAM123456',
      iat: 1_699_999_940,
      exp: 1_702_592_000,
    });
    expect(verified).toBe(true);
    expect(generated.expiresAtMs).toBe(1_702_592_000_000);
  });

  it('searches the configured storefront and returns reliable canonical metadata', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      searchResponse([
        song('wrong-version', { name: 'Midnight Circuit (Live)' }),
        song('right', { durationInMillis: 214_120, hasLyrics: false }),
      ]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new AppleMusicCatalogService(settings({ storefront: 'gb' })).resolve(TRACK);

    expect(result).toEqual(TRACK);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0]!;
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
    expect(url.pathname).toBe('/v1/catalog/gb/search');
    expect(url.searchParams.get('term')).toBe('Midnight Circuit Local Drive After Dark');
    expect(url.searchParams.get('types')).toBe('songs');
    expect(url.searchParams.get('limit')).toBe('10');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer developer-token');
  });

  it('fills a missing artist only with matching album and duration evidence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => searchResponse([song('right')])));

    const result = await new AppleMusicCatalogService(settings()).resolve({ ...TRACK, artist: '' });

    expect(result?.artist).toBe('Local Drive');
    expect(result?.album).toBe('After Dark');
  });

  it('lets the subscriber storefront override the configured search storefront', async () => {
    const fetchMock = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => searchResponse([song('right')]));
    vi.stubGlobal('fetch', fetchMock);

    await new AppleMusicCatalogService(settings({ storefront: 'us' }))
      .resolveMatch(TRACK, 'cn');

    const [input] = fetchMock.mock.calls[0]!;
    const url = input instanceof URL
      ? input
      : new URL(typeof input === 'string' ? input : input.url);
    expect(url.pathname).toBe('/v1/catalog/cn/search');
  });

  it('merges bounded shorter-term searches when the full term misses the exact song', async () => {
    const liveTrack: TrackMetadata = {
      title: 'Here We Go (Live)',
      artist: 'Masiwei',
      album: 'Dark Horse Season (Live)',
      durationMs: 285_000,
      source: '8',
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof URL
        ? input
        : new URL(typeof input === 'string' ? input : input.url);
      const term = url.searchParams.get('term');
      if (term === 'Here We Go (Live) Masiwei Dark Horse Season (Live)') {
        return searchResponse([
          song('reliable-but-wrong-album', {
            name: liveTrack.title,
            artistName: liveTrack.artist,
            albumName: 'A Different Live Album',
            durationInMillis: 284_900,
          }),
        ]);
      }
      if (term === 'Here We Go (Live) Masiwei') {
        return searchResponse([
          song('1791927318', {
            name: liveTrack.title,
            artistName: liveTrack.artist,
            albumName: liveTrack.album,
            durationInMillis: 285_133,
          }),
        ]);
      }
      throw new Error(`Unexpected search term: ${term}`);
    });
    const service = new AppleMusicCatalogService(settings({
      fetchImpl: fetchMock as typeof fetch,
    }));

    await expect(service.resolveMatch(liveTrack, 'us', { exhaustive: true }))
      .resolves.toMatchObject({
      providerTrackId: '1791927318',
      title: liveTrack.title,
      artist: liveTrack.artist,
      album: liveTrack.album,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([input]) => requestUrl(input).pathname))
      .toEqual(['/v1/catalog/us/search', '/v1/catalog/us/search']);
  });

  it('keeps foreground metadata enrichment on the original one-request search', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) =>
      searchResponse([]));
    const service = new AppleMusicCatalogService(settings({
      fetchImpl: fetchMock as typeof fetch,
    }));

    await expect(service.resolve(TRACK)).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestUrl(fetchMock.mock.calls[0]![0]).searchParams.get('term'))
      .toBe('Midnight Circuit Local Drive After Dark');
  });

  it('exposes the exact catalog identity only through resolveMatch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => searchResponse([
      song('1450330685', { isrc: 'USAAA2400001' }),
    ])));

    await expect(new AppleMusicCatalogService(settings()).resolveMatch(TRACK))
      .resolves.toEqual({
        ...TRACK,
        providerTrackId: '1450330685',
        hasLyrics: true,
        isrc: 'USAAA2400001',
      });
  });

  it('accepts deterministic Simplified and Traditional catalog metadata equivalence', async () => {
    const simplified: TrackMetadata = {
      title: '单车',
      artist: '陈奕迅',
      album: '2013 陈奕迅 Music Life 精选',
      durationMs: 209_000,
      source: 'Apple Music',
    };
    vi.stubGlobal('fetch', vi.fn(async () => searchResponse([
      song('667921841', {
        name: '單車',
        artistName: '陳奕迅',
        albumName: '2013 陳奕迅 Music Life 精選',
        durationInMillis: 208_627,
      }),
    ])));

    await expect(new AppleMusicCatalogService(settings()).resolveMatch(simplified))
      .resolves.toMatchObject({
        providerTrackId: '667921841',
        title: '單車',
        artist: '陳奕迅',
        album: '2013 陳奕迅 Music Life 精選',
      });
  });

  it.each(['Live', 'Remix', 'Instrumental', 'Sped Up'])(
    'rejects a different %s recording version',
    async (version) => {
      vi.stubGlobal('fetch', vi.fn(async () => searchResponse([
        song('wrong-version', { name: `Midnight Circuit (${version})` }),
      ])));

      await expect(new AppleMusicCatalogService(settings()).resolve(TRACK)).resolves.toBeNull();
    },
  );

  it('does not make a request when credentials are absent', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      new AppleMusicCatalogService(settings({ developerToken: '' })).resolve(TRACK),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards caller cancellation through catalog search', async () => {
    const fetchMock = vi.fn((
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => reject(init.signal?.reason),
        { once: true },
      );
    }));
    const controller = new AbortController();
    const reason = new DOMException('worker deadline', 'TimeoutError');
    const service = new AppleMusicCatalogService(settings({
      fetchImpl: fetchMock as typeof fetch,
    }));

    const pending = service.resolveMatch(TRACK, 'us', { signal: controller.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const requestSignal = fetchMock.mock.calls[0]![1]?.signal;
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(requestSignal?.aborted).toBe(true);
  });

  it('aborts a stalled catalog body without awaiting stream cancellation', async () => {
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
      cancel: () => {
        cancellations += 1;
        return new Promise<void>(() => undefined);
      },
    });
    const fetchMock = vi.fn(async () => new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const controller = new AbortController();
    const reason = new DOMException('worker deadline', 'TimeoutError');
    const service = new AppleMusicCatalogService(settings({
      fetchImpl: fetchMock as typeof fetch,
    }));

    const pending = service.resolveMatch(TRACK, 'us', { signal: controller.signal });
    await vi.waitFor(() => expect(body.locked).toBe(true));
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(cancellations).toBe(1);
  });

  it('aborts an exhaustive lookup while its second search plan is pending', async () => {
    let requestCount = 0;
    const fetchMock = vi.fn((
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      requestCount += 1;
      if (requestCount === 1) {
        return Promise.resolve(searchResponse([
          song('reliable-but-not-exact', { albumName: 'A Different Album' }),
        ]));
      }
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(init.signal?.reason),
          { once: true },
        );
      });
    });
    const controller = new AbortController();
    const reason = new DOMException('worker deadline', 'TimeoutError');
    const service = new AppleMusicCatalogService(settings({
      fetchImpl: fetchMock as typeof fetch,
    }));

    const pending = service.resolveMatch(TRACK, 'us', {
      signal: controller.signal,
      exhaustive: true,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const secondRequestSignal = fetchMock.mock.calls[1]![1]?.signal;
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(secondRequestSignal?.aborted).toBe(true);
  });

  it('deduplicates concurrent searches for the same track', async () => {
    const fetchMock = vi.fn(async () => searchResponse([song('right')]));
    vi.stubGlobal('fetch', fetchMock);
    const service = new AppleMusicCatalogService(settings());

    await Promise.all([service.resolve(TRACK), service.resolve({ ...TRACK })]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not share an in-flight request between fast and exhaustive modes', async () => {
    const fetchMock = vi.fn(async () => searchResponse([song('right')]));
    const service = new AppleMusicCatalogService(settings({
      fetchImpl: fetchMock as typeof fetch,
    }));

    await Promise.all([
      service.resolve(TRACK),
      service.resolveMatch(TRACK, 'us', { exhaustive: true }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
