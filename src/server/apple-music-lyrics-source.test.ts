import type { TrackMetadata } from '../shared/contracts.js';
import { lyricsLookupFingerprint } from '../shared/track.js';
import {
  AppleLyricsBackfillError,
  type AppleFetchedLyrics,
  type AppleLyricsBackfillJob,
} from './apple-lyrics-backfill.js';
import type { AppleMusicCatalogMatch } from './apple-music-catalog.js';
import {
  AppleMusicLyricsExactIdentityVerifier,
  AppleMusicLyricsSource,
  type AppleMusicLyricsSourceSettings,
} from './apple-music-lyrics-source.js';

const NOW_MS = 1_700_000_000_000;
const MEDIA_USER_TOKEN = 'media-user-token-secret';
const WEB_BEARER_TOKEN = 'web-bearer-secret';
const TRACK: TrackMetadata = {
  title: 'Midnight Circuit',
  artist: 'Local Drive',
  album: 'After Dark',
  durationMs: 214_000,
  source: 'Apple Music',
};
const MATCH: AppleMusicCatalogMatch = {
  ...TRACK,
  providerTrackId: '123456789',
  hasLyrics: true,
  isrc: 'USAAA2400001',
};
const JOB: AppleLyricsBackfillJob = {
  id: 'job-1',
  leaseToken: 'lease-1',
  attempts: 0,
  exactKey: lyricsLookupFingerprint(TRACK),
  keyVersion: 1,
  track: TRACK,
};

type FetchLike = NonNullable<AppleMusicLyricsSourceSettings['fetchImpl']>;

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: {
      'Content-Type': 'application/json',
      ...Object.fromEntries(new Headers(init.headers).entries()),
    },
  });
}

function storefrontResponse(
  storefront = 'us',
  locale = 'en-US',
): Response {
  return jsonResponse({
    data: [{
      id: storefront,
      attributes: { defaultLanguageTag: locale },
    }],
  });
}

function lyricsResponse(
  lyricsTtml: string | null,
  syllableTtml: string | null = null,
): Response {
  return lyricsResponseFor(MATCH, TRACK, lyricsTtml, syllableTtml);
}

function lyricsResponseFor(
  match: AppleMusicCatalogMatch,
  track: TrackMetadata,
  lyricsTtml: string | null,
  syllableTtml: string | null = null,
): Response {
  const relationship = (ttml: string | null) => ({
    data: ttml === null ? [] : [{ attributes: { ttml } }],
  });
  return jsonResponse({
    data: [{
      id: match.providerTrackId,
      attributes: {
        name: track.title,
        artistName: track.artist,
        albumName: track.album,
        durationInMillis: track.durationMs,
        isrc: match.isrc,
      },
      relationships: {
        lyrics: relationship(lyricsTtml),
        'syllable-lyrics': relationship(syllableTtml),
      },
    }],
  });
}

function catalog() {
  return {
    resolveMatch: vi.fn(async () => MATCH),
  };
}

function settings(
  fetchImpl: FetchLike,
  overrides: Partial<AppleMusicLyricsSourceSettings> = {},
): AppleMusicLyricsSourceSettings {
  return {
    mediaUserToken: MEDIA_USER_TOKEN,
    webBearerToken: WEB_BEARER_TOKEN,
    fetchImpl,
    now: () => NOW_MS,
    ...overrides,
  };
}

function requestUrl(input: string | URL | Request): URL {
  if (input instanceof URL) return input;
  if (input instanceof Request) return new URL(input.url);
  return new URL(input);
}

function jwt(expiresAtSeconds: number, marker: string): string {
  const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return [
    encoded({ alg: 'ES256', typ: 'JWT' }),
    encoded({ exp: expiresAtSeconds, marker }),
    Buffer.from(`signature-${marker}-long-enough`).toString('base64url'),
  ].join('.');
}

function fetchedLyrics(
  overrides: Partial<AppleFetchedLyrics> = {},
): AppleFetchedLyrics {
  return {
    ttml: '<tt></tt>',
    providerTrackId: MATCH.providerTrackId,
    storefront: 'us',
    catalogTrack: TRACK,
    fetchedAtMs: NOW_MS,
    isrc: MATCH.isrc,
    ...overrides,
  };
}

describe('AppleMusicLyricsSource', () => {
  it('has no construction side effects and preserves the original TTML string', async () => {
    const ttml = '\uFEFF<tt xml:lang="zh-Hans">\r\n  <p>夜 空</p>\r\n</tt>\n';
    const syllable = '<tt><p><span begin="0.1s">unused</span></p></tt>';
    const fetchImpl = vi.fn<FetchLike>(async (input, init) => {
      const url = requestUrl(input);
      expect(init?.redirect).toBe('error');
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe(`Bearer ${WEB_BEARER_TOKEN}`);
      expect(headers.get('media-user-token')).toBe(MEDIA_USER_TOKEN);
      if (url.pathname === '/v1/me/storefront') return storefrontResponse();
      return lyricsResponse(ttml, syllable);
    });
    const catalogResolver = catalog();
    const source = new AppleMusicLyricsSource(settings(fetchImpl), catalogResolver);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(catalogResolver.resolveMatch).not.toHaveBeenCalled();

    const fetched = await source.fetch({ job: JOB });

    expect(fetched.ttml).toBe(ttml);
    expect(fetched.timingMode).toBe('line-or-word');
    expect(fetched.catalogTrack).toEqual(TRACK);
    expect(fetched.providerTrackId).toBe(MATCH.providerTrackId);
    expect(fetched.storefront).toBe('us');
    expect(fetched.language).toBe('en-US');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const catalogCall = fetchImpl.mock.calls[1]!;
    const url = requestUrl(catalogCall[0]);
    expect(url.origin).toBe('https://amp-api.music.apple.com');
    expect(url.pathname).toBe(`/v1/catalog/us/songs/${MATCH.providerTrackId}`);
    expect(url.searchParams.get('include[songs]')).toBe(
      'albums,lyrics,syllable-lyrics',
    );
    expect(url.searchParams.get('l')).toBe('en-US');
  });

  it('forwards the operation signal to catalog matching and aborts a pending match', async () => {
    const controller = new AbortController();
    const catalogResolver = {
      resolveMatch: vi.fn(async (
        _track: TrackMetadata,
        _storefront?: string,
        options?: { signal?: AbortSignal },
      ) => new Promise<AppleMusicCatalogMatch | null>((_resolve, reject) => {
        options?.signal?.addEventListener(
          'abort',
          () => reject(options.signal?.reason),
          { once: true },
        );
      })),
    };
    const fetchImpl = vi.fn<FetchLike>(async () => storefrontResponse());
    const source = new AppleMusicLyricsSource(settings(fetchImpl), catalogResolver);

    const pending = source.fetch({ job: JOB, signal: controller.signal });
    await vi.waitFor(() => expect(catalogResolver.resolveMatch).toHaveBeenCalledTimes(1));
    controller.abort(new DOMException('worker deadline', 'TimeoutError'));

    await expect(pending).rejects.toMatchObject({
      code: 'apple-request-aborted',
      retryable: true,
    });
    expect(catalogResolver.resolveMatch).toHaveBeenCalledWith(
      TRACK,
      'us',
      { signal: controller.signal, exhaustive: true },
    );
  });

  it('aborts a stalled Apple response body without awaiting stream cancellation', async () => {
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
      cancel: () => {
        cancellations += 1;
        return new Promise<void>(() => undefined);
      },
    });
    const fetchImpl = vi.fn<FetchLike>(async () => new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const controller = new AbortController();
    const source = new AppleMusicLyricsSource(settings(fetchImpl), catalog());

    const pending = source.fetch({ job: JOB, signal: controller.signal });
    await vi.waitFor(() => expect(body.locked).toBe(true));
    controller.abort(new DOMException('worker deadline', 'TimeoutError'));

    await expect(pending).rejects.toMatchObject({
      code: 'apple-request-aborted',
      retryable: true,
    });
    expect(cancellations).toBe(1);
    expect(fetchImpl.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  });

  it('falls back to syllable TTML only when the lyrics relationship is absent', async () => {
    const syllable = '<tt><p><span begin="0.1s">syllable</span></p></tt>';
    const fetchImpl = vi.fn<FetchLike>(async (input) =>
      requestUrl(input).pathname === '/v1/me/storefront'
        ? storefrontResponse()
        : lyricsResponse(null, syllable));
    const source = new AppleMusicLyricsSource(settings(fetchImpl), catalog());

    const fetched = await source.fetch({ job: JOB });

    expect(fetched.ttml).toBe(syllable);
    expect(fetched.timingMode).toBe('syllable');
  });

  it('still requests lyrics when the catalog omits the hasLyrics hint', async () => {
    const matchWithoutLyricsFlag = { ...MATCH };
    delete matchWithoutLyricsFlag.hasLyrics;
    const fetchImpl = vi.fn<FetchLike>(async (input) =>
      requestUrl(input).pathname === '/v1/me/storefront'
        ? storefrontResponse()
        : lyricsResponse('<tt>available despite omitted hint</tt>'));
    const source = new AppleMusicLyricsSource(settings(fetchImpl), {
      resolveMatch: vi.fn(async () => matchWithoutLyricsFlag),
    });

    await expect(source.fetch({ job: JOB })).resolves.toMatchObject({
      ttml: '<tt>available despite omitted hint</tt>',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('uses the subscriber storefront for both Catalog matching and lyrics', async () => {
    const catalogResolver = catalog();
    const fetchImpl = vi.fn<FetchLike>(async (input) =>
      requestUrl(input).pathname === '/v1/me/storefront'
        ? storefrontResponse('cn', 'zh-Hans')
        : lyricsResponse('<tt>同一地区</tt>'));
    const source = new AppleMusicLyricsSource(settings(fetchImpl), catalogResolver);

    await expect(source.fetch({ job: JOB })).resolves.toMatchObject({
      ttml: '<tt>同一地区</tt>',
      storefront: 'cn',
      language: 'zh-Hans',
    });
    expect(catalogResolver.resolveMatch).toHaveBeenCalledWith(
      TRACK,
      'cn',
      { exhaustive: true },
    );
    expect(requestUrl(fetchImpl.mock.calls[1]![0]).pathname)
      .toBe(`/v1/catalog/cn/songs/${MATCH.providerTrackId}`);
  });

  it('tries only configured storefronts when a matched primary song has no TTML', async () => {
    const fallbackMatch: AppleMusicCatalogMatch = {
      ...MATCH,
      providerTrackId: '1791927318',
    };
    const catalogResolver = {
      resolveMatch: vi.fn(async (
        _track: TrackMetadata,
        storefront?: string,
      ) => storefront === 'us' ? fallbackMatch : MATCH),
    };
    const fetchImpl = vi.fn<FetchLike>(async (input) => {
      const url = requestUrl(input);
      if (url.pathname === '/v1/me/storefront') {
        return storefrontResponse('cn', 'zh-Hans');
      }
      if (url.pathname === `/v1/catalog/cn/songs/${MATCH.providerTrackId}`) {
        return lyricsResponse(null);
      }
      if (url.pathname === `/v1/catalog/us/songs/${fallbackMatch.providerTrackId}`) {
        return lyricsResponseFor(
          fallbackMatch,
          TRACK,
          '<tt>available in configured fallback</tt>',
        );
      }
      throw new Error(`Unexpected Apple request: ${url.pathname}`);
    });
    const source = new AppleMusicLyricsSource(
      settings(fetchImpl, {
        fallbackStorefronts: ['CN', 'invalid', 'CA', 'TW'],
      }),
      catalogResolver,
    );

    await expect(source.fetch({
      job: { ...JOB, storefront: 'US' },
    })).resolves.toMatchObject({
      ttml: '<tt>available in configured fallback</tt>',
      providerTrackId: fallbackMatch.providerTrackId,
      storefront: 'us',
      language: 'zh-Hans',
    });
    expect(catalogResolver.resolveMatch.mock.calls.map(([, storefront]) => storefront))
      .toEqual(['cn', 'us']);
    expect(fetchImpl.mock.calls.map(([input]) => requestUrl(input).pathname)).toEqual([
      '/v1/me/storefront',
      `/v1/catalog/cn/songs/${MATCH.providerTrackId}`,
      `/v1/catalog/us/songs/${fallbackMatch.providerTrackId}`,
    ]);
  });

  it('bounds configured storefront probing when no catalog match exists', async () => {
    const catalogResolver = {
      resolveMatch: vi.fn(async (
        _track: TrackMetadata,
        _storefront?: string,
      ) => null),
    };
    const fetchImpl = vi.fn<FetchLike>(async () =>
      storefrontResponse('cn', 'zh-Hans'));
    const source = new AppleMusicLyricsSource(
      settings(fetchImpl, {
        fallbackStorefronts: ['not-a-storefront', 'US', 'CA', 'TW'],
      }),
      catalogResolver,
    );

    await expect(source.fetch({ job: JOB })).rejects.toMatchObject({
      code: 'apple-catalog-match-not-found',
      retryable: false,
    });
    expect(catalogResolver.resolveMatch.mock.calls.map(([, storefront]) => storefront))
      .toEqual(['cn', 'us', 'ca']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('discovers an expiring web JWT and refreshes it at most once after auth rejection', async () => {
    const firstBearer = jwt(Math.floor(NOW_MS / 1_000) + 3_600, 'first');
    const secondBearer = jwt(Math.floor(NOW_MS / 1_000) + 7_200, 'second');
    let browseCount = 0;
    const fetchImpl = vi.fn<FetchLike>(async (input, init) => {
      const url = requestUrl(input);
      if (url.origin === 'https://music.apple.com' && url.pathname === '/us/browse') {
        browseCount += 1;
        return new Response(
          `<html>
            <script src="https://attacker.invalid/assets/index-stolen.js"></script>
            <script src="/assets/index-${browseCount}.js"></script>
          </html>`,
        );
      }
      if (url.pathname === '/assets/index-1.js') {
        return new Response(`window.token="${firstBearer}"`);
      }
      if (url.pathname === '/assets/index-2.js') {
        return new Response(`window.token="${secondBearer}"`);
      }
      const authorization = new Headers(init?.headers).get('Authorization');
      if (url.pathname === '/v1/me/storefront') {
        return authorization === `Bearer ${firstBearer}`
          ? new Response('', { status: 401 })
          : storefrontResponse();
      }
      expect(authorization).toBe(`Bearer ${secondBearer}`);
      return lyricsResponse('<tt>fresh</tt>');
    });
    const source = new AppleMusicLyricsSource(
      settings(fetchImpl, { webBearerToken: undefined }),
      catalog(),
    );

    await expect(source.fetch({ job: JOB })).resolves.toMatchObject({
      ttml: '<tt>fresh</tt>',
    });
    expect(browseCount).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(7);
    expect(fetchImpl.mock.calls.some(([input]) =>
      requestUrl(input).origin === 'https://attacker.invalid')).toBe(false);
  });

  it('follows only bounded same-origin redirects during public bearer discovery', async () => {
    const bearer = jwt(Math.floor(NOW_MS / 1_000) + 3_600, 'redirected');
    const expandedBrowsePadding = ' '.repeat(1_100_000);
    const fetchImpl = vi.fn<FetchLike>(async (input, init) => {
      const url = requestUrl(input);
      const headers = new Headers(init?.headers);
      if (url.pathname === '/us/browse') {
        expect(init?.redirect).toBe('manual');
        expect([...headers]).toEqual([]);
        return new Response('', {
          status: 301,
          headers: { Location: '/us/new' },
        });
      }
      if (url.pathname === '/us/new') {
        expect(init?.redirect).toBe('manual');
        expect([...headers]).toEqual([]);
        return new Response(
          `${expandedBrowsePadding}<script src="/assets/index-redirected.js"></script>`,
        );
      }
      if (url.pathname === '/assets/index-redirected.js') {
        expect(init?.redirect).toBe('manual');
        expect([...headers]).toEqual([]);
        return new Response(`window.token="${bearer}"`);
      }
      expect(init?.redirect).toBe('error');
      expect(headers.get('Authorization')).toBe(`Bearer ${bearer}`);
      expect(headers.get('media-user-token')).toBe(MEDIA_USER_TOKEN);
      return url.pathname === '/v1/me/storefront'
        ? storefrontResponse()
        : lyricsResponse('<tt>redirected discovery</tt>');
    });
    const source = new AppleMusicLyricsSource(
      settings(fetchImpl, { webBearerToken: undefined }),
      catalog(),
    );

    await expect(source.fetch({ job: JOB })).resolves.toMatchObject({
      ttml: '<tt>redirected discovery</tt>',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it('rejects cross-origin and excessive public bearer redirects', async () => {
    const crossOriginFetch = vi.fn<FetchLike>(async () =>
      new Response('', {
        status: 302,
        headers: { Location: 'https://attacker.invalid/assets/index.js' },
      }));
    const crossOriginSource = new AppleMusicLyricsSource(
      settings(crossOriginFetch, { webBearerToken: undefined }),
      catalog(),
    );

    await expect(crossOriginSource.fetch({ job: JOB })).rejects.toMatchObject({
      code: 'apple-redirect-rejected',
      retryable: false,
    });
    expect(crossOriginFetch).toHaveBeenCalledTimes(1);

    const loopingFetch = vi.fn<FetchLike>(async (_input, init) => {
      expect([...new Headers(init?.headers)]).toEqual([]);
      return new Response('', {
        status: 302,
        headers: { Location: '/us/browse' },
      });
    });
    const loopingSource = new AppleMusicLyricsSource(
      settings(loopingFetch, { webBearerToken: undefined }),
      catalog(),
    );

    await expect(loopingSource.fetch({ job: JOB })).rejects.toMatchObject({
      code: 'apple-redirect-rejected',
      retryable: false,
    });
    expect(loopingFetch).toHaveBeenCalledTimes(4);
  });

  it('finds a JWT across scan chunks while yielding the event loop', async () => {
    const bearer = jwt(Math.floor(NOW_MS / 1_000) + 3_600, 'chunked');
    const asset = `${'x'.repeat(256 * 1_024 - 20)}${bearer}`;
    let eventLoopYielded = false;
    setImmediate(() => {
      eventLoopYielded = true;
    });
    const fetchImpl = vi.fn<FetchLike>(async (input) => {
      const url = requestUrl(input);
      if (url.pathname === '/us/browse') {
        return new Response('<script src="/assets/index-chunked.js"></script>');
      }
      if (url.pathname === '/assets/index-chunked.js') return new Response(asset);
      if (url.pathname === '/v1/me/storefront') return storefrontResponse();
      return lyricsResponse('<tt>chunked</tt>');
    });
    const source = new AppleMusicLyricsSource(
      settings(fetchImpl, { webBearerToken: undefined }),
      catalog(),
    );

    await expect(source.fetch({ job: JOB })).resolves.toMatchObject({
      ttml: '<tt>chunked</tt>',
    });
    expect(eventLoopYielded).toBe(true);
  });

  it('stops after one dynamic-bearer refresh when authentication keeps failing', async () => {
    let browseCount = 0;
    const fetchImpl = vi.fn<FetchLike>(async (input) => {
      const url = requestUrl(input);
      if (url.pathname === '/us/browse') {
        browseCount += 1;
        return new Response('<script src="/assets/index.js"></script>');
      }
      if (url.pathname === '/assets/index.js') {
        return new Response(
          `token="${jwt(Math.floor(NOW_MS / 1_000) + browseCount * 3_600, String(browseCount))}"`,
        );
      }
      return new Response('', { status: 401 });
    });
    const source = new AppleMusicLyricsSource(
      settings(fetchImpl, { webBearerToken: undefined }),
      catalog(),
    );

    const error = await source.fetch({ job: JOB }).catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      code: 'apple-authentication-rejected',
      retryable: false,
    });
    expect(browseCount).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it('does not leak either credential when the network dependency throws them', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => {
      throw new Error(`${MEDIA_USER_TOKEN}:${WEB_BEARER_TOKEN}`);
    });
    const source = new AppleMusicLyricsSource(settings(fetchImpl), catalog());

    const error = await source.fetch({ job: JOB }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AppleLyricsBackfillError);
    if (!(error instanceof AppleLyricsBackfillError)) {
      throw new Error('Expected AppleLyricsBackfillError');
    }
    expect(error).toMatchObject({ code: 'apple-network', retryable: true });
    expect(String(error.message)).not.toContain(MEDIA_USER_TOKEN);
    expect(String(error.message)).not.toContain(WEB_BEARER_TOKEN);
    expect(String(error.stack)).not.toContain(MEDIA_USER_TOKEN);
    expect(String(error.stack)).not.toContain(WEB_BEARER_TOKEN);
    expect(error.cause).toBeUndefined();
  });

  it('classifies rate limiting as retryable without returning response details', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      new Response('private response', {
        status: 429,
        headers: { 'Retry-After': '7' },
      }));
    const source = new AppleMusicLyricsSource(settings(fetchImpl), catalog());

    const error = await source.fetch({ job: JOB }).catch((reason: unknown) => reason);

    if (!(error instanceof AppleLyricsBackfillError)) {
      throw new Error('Expected AppleLyricsBackfillError');
    }
    expect(error).toMatchObject({
      code: 'apple-http-429',
      retryable: true,
      retryAfterMs: 7_000,
    });
    expect(String(error.message)).not.toContain('private response');
  });

  it.each([500, 503])('classifies Apple HTTP %s as retryable', async (status) => {
    const fetchImpl = vi.fn<FetchLike>(async () => new Response('', { status }));
    const source = new AppleMusicLyricsSource(settings(fetchImpl), catalog());

    const error = await source.fetch({ job: JOB }).catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      code: `apple-http-${status}`,
      retryable: true,
    });
  });

  it('treats a deterministic missing-lyrics result as permanent', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (input) =>
      requestUrl(input).pathname === '/v1/me/storefront'
        ? storefrontResponse()
        : lyricsResponse(null));
    const source = new AppleMusicLyricsSource(settings(fetchImpl), catalog());

    const error = await source.fetch({ job: JOB }).catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      code: 'apple-lyrics-unavailable',
      retryable: false,
    });
  });

  it('rejects oversized and redirect responses without following them', async () => {
    const tooLargeFetch = vi.fn<FetchLike>(async () =>
      new Response('{}', {
        headers: { 'Content-Length': String(5 * 1_024 * 1_024) },
      }));
    const oversizedSource = new AppleMusicLyricsSource(
      settings(tooLargeFetch),
      catalog(),
    );
    const tooLargeError = await oversizedSource.fetch({ job: JOB })
      .catch((reason: unknown) => reason);
    expect(tooLargeError).toMatchObject({
      code: 'apple-response-too-large',
      retryable: false,
    });

    const redirectFetch = vi.fn<FetchLike>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe(`Bearer ${WEB_BEARER_TOKEN}`);
      expect(headers.get('media-user-token')).toBe(MEDIA_USER_TOKEN);
      return new Response('', {
        status: 302,
        headers: { Location: '/v1/me/storefront/redirected' },
      });
    });
    const redirectSource = new AppleMusicLyricsSource(
      settings(redirectFetch),
      catalog(),
    );
    const redirectError = await redirectSource.fetch({ job: JOB })
      .catch((reason: unknown) => reason);
    expect(redirectError).toMatchObject({
      code: 'apple-redirect-rejected',
      retryable: false,
    });
    expect(redirectFetch.mock.calls[0]?.[1]?.redirect).toBe('error');
    expect(redirectFetch).toHaveBeenCalledTimes(1);
  });

  it('fails before the lyrics request when durable provider or ISRC hints disagree', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => storefrontResponse());
    const source = new AppleMusicLyricsSource(settings(fetchImpl), catalog());

    const providerError = await source.fetch({
      job: { ...JOB, providerTrackId: '999' },
    }).catch((reason: unknown) => reason);
    expect(providerError).toMatchObject({
      code: 'apple-provider-track-id-mismatch',
      retryable: false,
    });

    const isrcError = await source.fetch({
      job: { ...JOB, isrc: 'GBBBB2400002' },
    }).catch((reason: unknown) => reason);
    expect(isrcError).toMatchObject({
      code: 'apple-isrc-mismatch',
      retryable: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(requestUrl(fetchImpl.mock.calls[0]![0]).pathname).toBe('/v1/me/storefront');
  });
});

describe('AppleMusicLyricsExactIdentityVerifier', () => {
  const verifier = new AppleMusicLyricsExactIdentityVerifier();

  it('verifies only a catalog fingerprint equal to the durable exact key', async () => {
    const result = await verifier.verify({
      expected: {
        exactKey: JOB.exactKey,
        keyVersion: 1,
        track: TRACK,
        providerTrackId: MATCH.providerTrackId,
        isrc: MATCH.isrc,
      },
      fetched: fetchedLyrics(),
    });

    expect(result).toEqual({
      state: 'verified',
      proof: {
        proofVersion: 1,
        provider: 'apple',
        providerTrackId: MATCH.providerTrackId,
        exactKey: JOB.exactKey,
        keyVersion: 1,
        evidence: ['catalog-metadata-v1', 'catalog-id', 'isrc'],
      },
    });
  });

  it.each([
    ['a 62ms catalog difference', 214_938],
    ['the inclusive 500ms boundary', 214_500],
  ])(
    'accepts a cross-bucket whole-second duration alias at %s',
    async (_label, catalogDurationMs) => {
      const observedTrack: TrackMetadata = {
        ...TRACK,
        durationMs: 215_000,
      };
      const catalogTrack: TrackMetadata = {
        ...TRACK,
        durationMs: catalogDurationMs,
      };
      const exactKey = lyricsLookupFingerprint(observedTrack);
      expect(lyricsLookupFingerprint(catalogTrack)).not.toBe(exactKey);

      await expect(verifier.verify({
        expected: {
          exactKey,
          keyVersion: 1,
          track: observedTrack,
        },
        fetched: fetchedLyrics({ catalogTrack }),
      })).resolves.toEqual({
        state: 'verified',
        proof: {
          proofVersion: 1,
          provider: 'apple',
          providerTrackId: MATCH.providerTrackId,
          exactKey,
          keyVersion: 1,
          evidence: [
            'catalog-metadata-nonduration-v1',
            'duration-second-quantized-500ms-v1',
          ],
        },
      });
    },
  );

  it('accepts a bounded duration alias when Apple metadata differs only by script', async () => {
    const observedTrack: TrackMetadata = {
      title: '单车',
      artist: '陈奕迅',
      album: '2013 陈奕迅 Music Life 精选',
      durationMs: 209_000,
      source: 'Apple Music',
    };
    const catalogTrack: TrackMetadata = {
      title: '單車',
      artist: '陳奕迅',
      album: '2013 陳奕迅 Music Life 精選',
      durationMs: 208_627,
      source: 'Apple Music',
    };

    await expect(verifier.verify({
      expected: {
        exactKey: lyricsLookupFingerprint(observedTrack),
        keyVersion: 1,
        track: observedTrack,
      },
      fetched: fetchedLyrics({ catalogTrack }),
    })).resolves.toEqual({
      state: 'verified',
      proof: {
        proofVersion: 1,
        provider: 'apple',
        providerTrackId: MATCH.providerTrackId,
        exactKey: lyricsLookupFingerprint(observedTrack),
        keyVersion: 1,
        evidence: [
          'catalog-metadata-nonduration-v1',
          'duration-second-quantized-500ms-v1',
          'catalog-metadata-script-equivalent-v1',
        ],
      },
    });
  });

  it.each([
    ['Live title', { title: `${TRACK.title} (Live)` }],
    ['Acoustic title', { title: `${TRACK.title} (Acoustic)` }],
    ['Remaster title', { title: `${TRACK.title} (2026 Remaster)` }],
    ['artist', { artist: 'A Different Artist' }],
  ] satisfies Array<[string, Partial<TrackMetadata>]>)(
    'does not let duration quantization bypass a %s mismatch',
    async (_label, mismatch) => {
      const observedTrack: TrackMetadata = {
        ...TRACK,
        durationMs: 215_000,
      };
      await expect(verifier.verify({
        expected: {
          exactKey: lyricsLookupFingerprint(observedTrack),
          keyVersion: 1,
          track: observedTrack,
        },
        fetched: fetchedLyrics({
          catalogTrack: {
            ...TRACK,
            ...mismatch,
            durationMs: 214_938,
          },
        }),
      })).resolves.toEqual({ state: 'rejected', reason: 'mismatch' });
    },
  );

  it('accepts catalog identity when playback duration drifts beyond the key bucket', async () => {
    const observedTrack: TrackMetadata = {
      ...TRACK,
      durationMs: 215_000,
    };
    const exactKey = lyricsLookupFingerprint(observedTrack);

    await expect(verifier.verify({
      expected: {
        exactKey,
        keyVersion: 1,
        track: observedTrack,
      },
      fetched: fetchedLyrics({
        catalogTrack: { ...TRACK, durationMs: 214_499 },
      }),
    })).resolves.toEqual({
      state: 'verified',
      proof: {
        proofVersion: 1,
        provider: 'apple',
        providerTrackId: MATCH.providerTrackId,
        exactKey,
        keyVersion: 1,
        evidence: ['catalog-metadata-duration-independent-v1'],
      },
    });

    const subsecondObservedTrack = { ...TRACK, durationMs: 215_100 };
    await expect(verifier.verify({
      expected: {
        exactKey: lyricsLookupFingerprint(subsecondObservedTrack),
        keyVersion: 1,
        track: subsecondObservedTrack,
      },
      fetched: fetchedLyrics({
        catalogTrack: { ...TRACK, durationMs: 180_000 },
      }),
    })).resolves.toMatchObject({
      state: 'verified',
      proof: {
        evidence: ['catalog-metadata-duration-independent-v1'],
      },
    });

    // A duration-independent promotion still requires the non-duration
    // recording metadata to remain equivalent.
    await expect(verifier.verify({
      expected: {
        exactKey,
        keyVersion: 1,
        track: observedTrack,
      },
      fetched: fetchedLyrics({
        catalogTrack: {
          ...TRACK,
          album: 'A Different Album',
          durationMs: 180_000,
        },
      }),
    })).resolves.toEqual({ state: 'rejected', reason: 'mismatch' });

    await expect(verifier.verify({
      expected: {
        exactKey: JOB.exactKey,
        keyVersion: 1,
        track: observedTrack,
      },
      fetched: fetchedLyrics({
        catalogTrack: { ...TRACK, durationMs: 180_000 },
      }),
    })).resolves.toEqual({ state: 'rejected', reason: 'mismatch' });
  });

  it('rejects metadata and claim-hint mismatches and fails closed on unknown key versions', async () => {
    await expect(verifier.verify({
      expected: {
        exactKey: JOB.exactKey,
        keyVersion: 1,
        track: TRACK,
      },
      fetched: fetchedLyrics({
        catalogTrack: { ...TRACK, album: 'A Different Album' },
      }),
    })).resolves.toEqual({ state: 'rejected', reason: 'mismatch' });

    await expect(verifier.verify({
      expected: {
        exactKey: JOB.exactKey,
        keyVersion: 1,
        track: TRACK,
        providerTrackId: '999',
      },
      fetched: fetchedLyrics(),
    })).resolves.toEqual({ state: 'rejected', reason: 'mismatch' });

    await expect(verifier.verify({
      expected: {
        exactKey: JOB.exactKey,
        keyVersion: 1,
        track: TRACK,
        isrc: MATCH.isrc,
      },
      fetched: fetchedLyrics({ isrc: undefined }),
    })).resolves.toEqual({
      state: 'rejected',
      reason: 'insufficient-evidence',
    });

    await expect(verifier.verify({
      expected: {
        exactKey: JOB.exactKey,
        keyVersion: 2,
        track: TRACK,
      },
      fetched: fetchedLyrics(),
    })).resolves.toEqual({
      state: 'rejected',
      reason: 'insufficient-evidence',
    });
  });
});
