import { createHash } from 'node:crypto';
import type { TrackMetadata } from '../shared/contracts.js';
import { lyricsLookupFingerprint, lyricsWorkFingerprint } from '../shared/track.js';
import type {
  LyricsLibraryExactWrite,
  LyricsLibraryResolveInput,
  LyricsLibraryWorkWrite,
} from './lyrics-repository.js';
import type { CachedLyrics } from './store.js';
import { SupabaseLyricsClient } from './supabase-lyrics-client.js';

const SUPABASE_URL = 'https://lyrics-project.supabase.co';
const SECRET_KEY = 'unit-test-secret-key';
const LIBRARY_ID = '11111111-1111-4111-8111-111111111111';
const DOCUMENT_ID = '22222222-2222-4222-8222-222222222222';
const OBSERVED_BEFORE = '2026-07-14T14:00:00.000Z';
const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const SELECTION_VERSION = 1_900_000_000_123;

const TRACK: TrackMetadata = {
  title: 'Midnight Circuit (Live)',
  artist: 'Local Drive',
  album: 'Live After Dark',
  durationMs: 214_000,
  source: 'Apple Music',
};

const RESOLVE_INPUT: LyricsLibraryResolveInput = {
  track: TRACK,
  exactKey: lyricsLookupFingerprint(TRACK),
  workKey: lyricsWorkFingerprint(TRACK),
  keyVersion: 1,
  allowWorkFallback: true,
};

function jsonResponse(
  value: unknown,
  init: { status?: number; headers?: HeadersInit } = {},
): Response {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: {
      'Content-Type': 'application/json',
      ...Object.fromEntries(new Headers(init.headers).entries()),
    },
  });
}

function makeClient(fetcher: typeof fetch): SupabaseLyricsClient {
  return new SupabaseLyricsClient({
    url: SUPABASE_URL,
    secretKey: SECRET_KEY,
    libraryId: LIBRARY_ID,
    timeoutMs: 750,
    fetcher,
  });
}

function exactWrite(
  sourceKind: LyricsLibraryExactWrite['sourceKind'] = 'automatic',
): LyricsLibraryExactWrite {
  const cached: CachedLyrics = {
    payload: {
      kind: 'synced',
      lines: [
        { id: 'negative', startMs: -50, text: 'Prelude' },
        { id: 'chorus', startMs: 61_009, text: 'Chorus' },
      ],
      plainText: 'Prelude\nChorus',
      provider: 'lrclib',
      providerId: 987,
    },
    expiresAt: 2_000_000_000_000,
    lookupStrategy: 'lrclib-multi-v2',
    metadataSignature: 'metadata-signature-v1',
  };
  const base = {
    track: TRACK,
    exactKey: RESOLVE_INPUT.exactKey,
    keyVersion: 1,
    cached,
  };
  if (sourceKind !== 'automatic') {
    return { ...base, sourceKind, trust: 'active', selectionVersion: SELECTION_VERSION };
  }
  return { ...base, sourceKind, trust: 'active' };
}

function workWrite(): LyricsLibraryWorkWrite {
  return {
    workKey: RESOLVE_INPUT.workKey!,
    keyVersion: 1,
    cached: {
      schemaVersion: 1,
      plainText: 'Studio first line\nStudio second line',
      provider: 'lrclib',
      providerId: 654,
      sourceTitle: 'Midnight Circuit',
      sourceArtist: 'Local Drive',
      storedAt: 1_900_000_000_000,
      expiresAt: 2_000_000_000_000,
    },
  };
}

function parsedRequestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('Expected a string request body');
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe('SupabaseLyricsClient.resolve', () => {
  it('returns an exact synchronized hit and sends the expected lookup RPC', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => jsonResponse({
      result_status: 'hit',
      match_kind: 'exact',
      document_id: DOCUMENT_ID,
      synced_lyrics: '[00:01.00]First line\n[00:02.50]Second line',
      plain_lyrics: 'First line\nSecond line',
      is_instrumental: false,
      provider_name: ' LRCLIB ',
      provider_track_id: '42',
      auto_scroll: true,
      raw_metadata: {
        title: TRACK.title,
        artist: TRACK.artist,
        album: TRACK.album,
        duration_ms: TRACK.durationMs,
        source: TRACK.source,
      },
    }));

    const result = await makeClient(fetcher as typeof fetch).resolve(RESOLVE_INPUT);

    expect(result).toEqual({
      state: 'hit',
      matchKind: 'exact',
      documentId: DOCUMENT_ID,
      payload: {
        kind: 'synced',
        lines: [
          { id: '1000-0', startMs: 1_000, text: 'First line' },
          { id: '2500-1', startMs: 2_500, text: 'Second line' },
        ],
        provider: 'lrclib',
        providerId: 42,
      },
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe(`${SUPABASE_URL}/rest/v1/rpc/resolve_lyrics`);
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('apikey')).toBe(SECRET_KEY);
    expect(parsedRequestBody(init)).toEqual({
      p_library_id: LIBRARY_ID,
      p_exact_key: RESOLVE_INPUT.exactKey,
      p_work_key: RESOLVE_INPUT.workKey,
      p_key_version: 1,
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('preserves an opaque Apple catalog id on an active library hit', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      result_status: 'hit',
      match_kind: 'exact',
      document_id: DOCUMENT_ID,
      synced_lyrics: '[00:01.001]First line',
      plain_lyrics: 'First line',
      is_instrumental: false,
      provider_name: 'apple',
      provider_track_id: '1450330685',
      selection_method: 'provider',
      auto_scroll: true,
      raw_metadata: {
        title: TRACK.title,
        artist: TRACK.artist,
        album: TRACK.album,
        duration_ms: TRACK.durationMs,
        source: TRACK.source,
      },
    }));

    await expect(makeClient(fetcher as typeof fetch).resolve(RESOLVE_INPUT))
      .resolves.toMatchObject({
        state: 'hit',
        selectionMethod: 'provider',
        payload: {
          kind: 'synced',
          provider: 'apple',
          providerTrackId: '1450330685',
        },
      });
  });

  it('returns a verified Apple static fallback as non-scrolling plain lyrics', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      result_status: 'hit',
      match_kind: 'exact',
      document_id: DOCUMENT_ID,
      synced_lyrics: null,
      plain_lyrics: 'First static line\nSecond static line',
      is_instrumental: false,
      provider_name: 'apple',
      provider_track_id: '1450330685',
      provider_route: 'apple-static-fallback-v1',
      selection_method: 'provider',
      auto_scroll: false,
      raw_metadata: {
        title: TRACK.title,
        artist: TRACK.artist,
        album: TRACK.album,
        duration_ms: TRACK.durationMs,
        source: TRACK.source,
      },
    }));

    await expect(makeClient(fetcher as typeof fetch).resolve(RESOLVE_INPUT))
      .resolves.toEqual({
        state: 'hit',
        matchKind: 'exact',
        documentId: DOCUMENT_ID,
        selectionMethod: 'provider',
        providerRoute: 'apple-static-fallback-v1',
        payload: {
          kind: 'plain',
          lines: [
            { id: 'plain-0', startMs: 0, text: 'First static line' },
            { id: 'plain-1', startMs: 0, text: 'Second static line' },
          ],
          plainText: 'First static line\nSecond static line',
          provider: 'apple',
          providerTrackId: '1450330685',
          notice: '正在使用个人歌词库中的静态歌词。',
        },
      });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('accepts a byte-identical Apple Exact duration alias only as static Work fallback', async () => {
    const track: TrackMetadata = {
      title: '童言无忌(不插电)',
      artist: '王以太',
      album: '闪火mixtape - EP',
      durationMs: 216_000,
      source: 'Apple Music',
    };
    const input: LyricsLibraryResolveInput = {
      track,
      exactKey: lyricsLookupFingerprint(track),
      workKey: lyricsWorkFingerprint(track),
      keyVersion: 1,
      allowWorkFallback: true,
    };
    const fetcher = vi.fn(async () => jsonResponse({
      result_status: 'hit',
      match_kind: 'work',
      document_id: DOCUMENT_ID,
      synced_lyrics: null,
      plain_lyrics: '童言无忌第一行\n童言无忌第二行',
      is_instrumental: false,
      provider_name: 'apple',
      provider_track_id: '6768224531',
      provider_route: 'apple-duration-alias-static-v1',
      selection_method: 'provider',
      auto_scroll: false,
      raw_metadata: {
        title: '童言无忌 (不插电)',
        artist: '王以太',
        album: '闪火mixtape - EP',
        duration_ms: 300_141,
        source: 'Apple Music',
      },
    }));

    await expect(makeClient(fetcher as typeof fetch).resolve(input))
      .resolves.toEqual({
        state: 'hit',
        matchKind: 'work',
        documentId: DOCUMENT_ID,
        selectionMethod: 'provider',
        providerRoute: 'apple-duration-alias-static-v1',
        payload: {
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
        },
      });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps a validated Apple duration alias synchronized when the source has a timeline', async () => {
    const track: TrackMetadata = {
      title: 'Midnight Circuit',
      artist: 'Local Drive',
      album: 'After Dark',
      durationMs: 214_000,
      source: 'Apple Music',
    };
    const input: LyricsLibraryResolveInput = {
      track,
      exactKey: lyricsLookupFingerprint(track),
      workKey: lyricsWorkFingerprint(track),
      keyVersion: 1,
      allowWorkFallback: true,
    };
    const fetcher = vi.fn(async () => jsonResponse({
      result_status: 'hit',
      match_kind: 'work',
      document_id: DOCUMENT_ID,
      synced_lyrics: '[00:01.000]First line\n[00:02.000]Second line',
      plain_lyrics: 'First line\nSecond line',
      is_instrumental: false,
      provider_name: 'apple',
      provider_track_id: '1450330685',
      provider_route: 'apple-duration-alias-synced-v1',
      selection_method: 'provider',
      auto_scroll: true,
      raw_metadata: {
        title: track.title,
        artist: track.artist,
        album: track.album,
        duration_ms: 212_000,
        source: track.source,
      },
    }));

    await expect(makeClient(fetcher as typeof fetch).resolve(input)).resolves.toEqual({
      state: 'hit',
      matchKind: 'work',
      documentId: DOCUMENT_ID,
      selectionMethod: 'provider',
      providerRoute: 'apple-duration-alias-synced-v1',
      payload: {
        kind: 'synced',
        lines: [
          { id: '1000-0', startMs: 1_000, text: 'First line' },
          { id: '2000-1', startMs: 2_000, text: 'Second line' },
        ],
        provider: 'apple',
        providerTrackId: '1450330685',
      },
    });
  });

  it('probes a synchronized Apple duration alias after a static LRCLIB Exact hit', async () => {
    const input: LyricsLibraryResolveInput = {
      ...RESOLVE_INPUT,
      allowWorkFallback: false,
    };
    let call = 0;
    const fetcher = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => {
      call += 1;
      if (call === 1) {
        return jsonResponse({
          result_status: 'hit',
          match_kind: 'exact',
          document_id: DOCUMENT_ID,
          synced_lyrics: null,
          plain_lyrics: 'LRCLIB static line',
          is_instrumental: false,
          provider_name: 'lrclib',
          provider_track_id: '42',
          selection_method: 'provider',
          auto_scroll: false,
          raw_metadata: {
            title: TRACK.title,
            artist: TRACK.artist,
            album: TRACK.album,
            duration_ms: TRACK.durationMs,
            source: TRACK.source,
          },
        });
      }
      return jsonResponse({
        result_status: 'hit',
        match_kind: 'work',
        document_id: DOCUMENT_ID,
        synced_lyrics: '[00:01.000]Apple synchronized line',
        plain_lyrics: 'Apple synchronized line',
        is_instrumental: false,
        provider_name: 'apple',
        provider_track_id: '1450330685',
        provider_route: 'apple-duration-alias-synced-v1',
        selection_method: 'provider',
        auto_scroll: true,
        raw_metadata: {
          title: TRACK.title,
          artist: TRACK.artist,
          album: TRACK.album,
          duration_ms: 212_000,
          source: TRACK.source,
        },
      });
    });

    await expect(makeClient(fetcher as typeof fetch).resolve(input)).resolves.toEqual({
      state: 'hit',
      matchKind: 'work',
      documentId: DOCUMENT_ID,
      selectionMethod: 'provider',
      providerRoute: 'apple-duration-alias-synced-v1',
      payload: {
        kind: 'synced',
        lines: [{ id: '1000-0', startMs: 1_000, text: 'Apple synchronized line' }],
        provider: 'apple',
        providerTrackId: '1450330685',
      },
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(parsedRequestBody(fetcher.mock.calls[0]?.[1])).toMatchObject({
      p_exact_key: input.exactKey,
      p_work_key: null,
    });
    expect(parsedRequestBody(fetcher.mock.calls[1]?.[1])).toMatchObject({
      p_exact_key: input.exactKey,
      p_work_key: input.workKey,
    });
  });

  it('keeps a static LRCLIB Exact when the optional alias probe is unavailable', async () => {
    const input: LyricsLibraryResolveInput = {
      ...RESOLVE_INPUT,
      allowWorkFallback: false,
    };
    let call = 0;
    const fetcher = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => {
      call += 1;
      if (call === 2) throw new Error('duration alias timeout');
      return jsonResponse({
        result_status: 'hit',
        match_kind: 'exact',
        document_id: DOCUMENT_ID,
        synced_lyrics: null,
        plain_lyrics: 'LRCLIB static line',
        is_instrumental: false,
        provider_name: 'lrclib',
        provider_track_id: '42',
        selection_method: 'provider',
        auto_scroll: false,
        raw_metadata: {
          title: TRACK.title,
          artist: TRACK.artist,
          album: TRACK.album,
          duration_ms: TRACK.durationMs,
          source: TRACK.source,
        },
      });
    });

    await expect(makeClient(fetcher as typeof fetch).resolve(input)).resolves.toMatchObject({
      state: 'hit',
      matchKind: 'exact',
      documentId: DOCUMENT_ID,
      payload: {
        kind: 'plain',
        plainText: 'LRCLIB static line',
        provider: 'lrclib',
        providerId: 42,
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects an Apple duration alias when album bytes differ', async () => {
    const track: TrackMetadata = {
      title: '童言无忌(不插电)',
      artist: '王以太',
      album: '闪火mixtape - EP',
      durationMs: 216_000,
      source: 'Apple Music',
    };
    const input: LyricsLibraryResolveInput = {
      track,
      exactKey: lyricsLookupFingerprint(track),
      workKey: lyricsWorkFingerprint(track),
      keyVersion: 1,
      allowWorkFallback: true,
    };
    const fetcher = vi.fn(async () => jsonResponse({
      result_status: 'hit',
      match_kind: 'work',
      document_id: DOCUMENT_ID,
      synced_lyrics: null,
      plain_lyrics: 'Wrong album text',
      is_instrumental: false,
      provider_name: 'apple',
      provider_track_id: '6768224531',
      provider_route: 'apple-duration-alias-static-v1',
      selection_method: 'provider',
      auto_scroll: false,
      raw_metadata: {
        title: '童言无忌 (不插电)',
        artist: '王以太',
        album: '另一张专辑',
        duration_ms: 300_141,
        source: 'Apple Music',
      },
    }));

    await expect(makeClient(fetcher as typeof fetch).resolve(input))
      .resolves.toEqual({ state: 'unavailable', reason: 'invalid-response' });
  });

  it('rejects an Apple duration alias when the Work capability key is arbitrary', async () => {
    const track: TrackMetadata = {
      title: '童言无忌(不插电)',
      artist: '王以太',
      album: '闪火mixtape - EP',
      durationMs: 216_000,
      source: 'Apple Music',
    };
    const input: LyricsLibraryResolveInput = {
      track,
      exactKey: lyricsLookupFingerprint(track),
      workKey: 'arbitrary::work-key',
      keyVersion: 1,
      allowWorkFallback: true,
    };
    const fetcher = vi.fn(async () => jsonResponse({
      result_status: 'hit',
      match_kind: 'work',
      document_id: DOCUMENT_ID,
      synced_lyrics: null,
      plain_lyrics: '童言无忌第一行',
      is_instrumental: false,
      provider_name: 'apple',
      provider_track_id: '6768224531',
      provider_route: 'apple-duration-alias-static-v1',
      selection_method: 'provider',
      auto_scroll: false,
      raw_metadata: {
        title: '童言无忌 (不插电)',
        artist: '王以太',
        album: '闪火mixtape - EP',
        duration_ms: 300_141,
        source: 'Apple Music',
      },
    }));

    await expect(makeClient(fetcher as typeof fetch).resolve(input))
      .resolves.toEqual({ state: 'unavailable', reason: 'invalid-response' });
  });

  it('keeps Apple primary and projects it to Simplified when LRCLIB also has Simplified text', async () => {
    const track: TrackMetadata = {
      title: '单车',
      artist: '陈奕迅',
      album: 'Shall We Dance? Shall We Talk!',
      durationMs: 209_000,
      source: 'Apple Music',
    };
    const input: LyricsLibraryResolveInput = {
      track,
      exactKey: lyricsLookupFingerprint(track),
      workKey: lyricsWorkFingerprint(track),
      keyVersion: 1,
      allowWorkFallback: false,
    };
    const traditional = [
      '不要不要假設我知道',
      '一切一切也都是為我而做',
      '為何這麼偉大 如此感覺不到',
    ];
    const simplified = [
      '不要不要假设我知道',
      '一切一切也都是为我而做',
      '为何这么伟大 如此感觉不到',
    ];
    const metadata = {
      title: track.title,
      artist: track.artist,
      album: track.album,
      duration_ms: track.durationMs,
      source: track.source,
    };
    const fallbackDocumentId = '33333333-3333-4333-8333-333333333333';
    const fetcher = vi.fn(async () => jsonResponse({
      result_status: 'hit',
      match_kind: 'exact',
      document_id: DOCUMENT_ID,
      synced_lyrics: traditional
        .map((line, index) => `[00:${String(index * 4 + 1).padStart(2, '0')}.000]${line}`)
        .join('\n'),
      plain_lyrics: traditional.join('\n'),
      is_instrumental: false,
      provider_name: 'apple',
      provider_track_id: '667921841',
      provider_route: 'apple-primary-v1',
      selection_method: 'provider',
      auto_scroll: true,
      raw_metadata: metadata,
      provider_fallback: {
        result_status: 'hit',
        match_kind: 'exact',
        document_id: fallbackDocumentId,
        synced_lyrics: simplified
          .map((line, index) => `[00:${String(index * 4 + 1).padStart(2, '0')}.000]${line}`)
          .join('\n'),
        plain_lyrics: simplified.join('\n'),
        is_instrumental: false,
        provider_name: 'lrclib',
        provider_track_id: '14737395',
        selection_method: 'provider',
        auto_scroll: true,
        raw_metadata: metadata,
      },
    }));

    const result = await makeClient(fetcher as typeof fetch).resolve(input);

    expect(result).toMatchObject({
      state: 'hit',
      matchKind: 'exact',
      documentId: DOCUMENT_ID,
      selectionMethod: 'provider',
      payload: {
        kind: 'synced',
        provider: 'apple',
        providerTrackId: '667921841',
      },
    });
    expect(result.state === 'hit' && result.payload.lines.map((line) => line.text))
      .toEqual(simplified);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps Apple primary when a Simplified provider fallback would lose synchronization', async () => {
    const track: TrackMetadata = {
      title: '单车',
      artist: '陈奕迅',
      album: 'Shall We Dance? Shall We Talk!',
      durationMs: 209_000,
      source: 'Apple Music',
    };
    const input: LyricsLibraryResolveInput = {
      track,
      exactKey: lyricsLookupFingerprint(track),
      workKey: lyricsWorkFingerprint(track),
      keyVersion: 1,
      allowWorkFallback: false,
    };
    const metadata = {
      title: track.title,
      artist: track.artist,
      album: track.album,
      duration_ms: track.durationMs,
      source: track.source,
    };
    const fetcher = vi.fn(async () => jsonResponse({
      result_status: 'hit',
      match_kind: 'exact',
      document_id: DOCUMENT_ID,
      synced_lyrics: [
        '[00:01.000]不要不要假設我知道',
        '[00:05.000]一切一切也都是為我而做',
        '[00:09.000]為何這麼偉大 如此感覺不到',
      ].join('\n'),
      plain_lyrics: '不要不要假設我知道\n一切一切也都是為我而做\n為何這麼偉大 如此感覺不到',
      is_instrumental: false,
      provider_name: 'apple',
      provider_track_id: '667921841',
      provider_route: 'apple-primary-v1',
      selection_method: 'provider',
      auto_scroll: true,
      raw_metadata: metadata,
      provider_fallback: {
        result_status: 'hit',
        match_kind: 'exact',
        document_id: '33333333-3333-4333-8333-333333333333',
        synced_lyrics: null,
        plain_lyrics: '不要不要假设我知道\n一切一切也都是为我而做\n为何这么伟大 如此感觉不到',
        is_instrumental: false,
        provider_name: 'lrclib',
        provider_track_id: '14737395',
        selection_method: 'provider',
        auto_scroll: false,
        raw_metadata: metadata,
      },
    }));

    await expect(makeClient(fetcher as typeof fetch).resolve(input)).resolves.toMatchObject({
      state: 'hit',
      documentId: DOCUMENT_ID,
      payload: {
        kind: 'synced',
        provider: 'apple',
        providerTrackId: '667921841',
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('forces a work hit into static plain lyrics even if a server claims it can auto-scroll', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => jsonResponse({
      result_status: 'hit',
      match_kind: 'work',
      document_id: DOCUMENT_ID,
      synced_lyrics: '[00:01.00]Studio first line\n[00:02.00]Studio second line',
      plain_lyrics: null,
      provider_name: 'lrclib',
      provider_track_id: 654,
      auto_scroll: true,
      raw_metadata: {
        title: 'Midnight Circuit',
        artist: TRACK.artist,
        album: 'Studio Album',
        duration_ms: 210_000,
      },
    }));

    const result = await makeClient(fetcher as typeof fetch).resolve(RESOLVE_INPUT);

    expect(result).toEqual({
      state: 'hit',
      matchKind: 'work',
      documentId: DOCUMENT_ID,
      payload: {
        kind: 'plain',
        lines: [
          { id: 'plain-0', startMs: 0, text: 'Studio first line' },
          { id: 'plain-1', startMs: 0, text: 'Studio second line' },
        ],
        plainText: 'Studio first line\nStudio second line',
        provider: 'lrclib',
        providerId: 654,
        notice: '未找到当前版本歌词，当前显示同一作品歌词（静态模式）。',
        fallbackKind: 'work-cache',
      },
    });
  });

  it('reuses a verified Apple exact hit from the adjacent duration bucket', async () => {
    const track: TrackMetadata = {
      title: '单车',
      artist: '陈奕迅',
      album: '2013 陈奕迅 Music Life 精选',
      durationMs: 209_000,
      source: 'Apple Music',
    };
    const input: LyricsLibraryResolveInput = {
      track,
      exactKey: lyricsLookupFingerprint(track),
      workKey: lyricsWorkFingerprint(track),
      keyVersion: 1,
      allowWorkFallback: false,
    };
    const adjacentKey = lyricsLookupFingerprint({ ...track, durationMs: 208_000 });
    const appleTrack: TrackMetadata = {
      ...track,
      title: '單車',
      artist: '陳奕迅',
      album: '2013 陳奕迅 Music Life 精選',
      durationMs: 208_627,
    };
    const appleAdjacentKey = lyricsLookupFingerprint(appleTrack);
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = parsedRequestBody(init);
      if (body.p_exact_key === input.exactKey) {
        return jsonResponse({
          result_status: 'hit',
          match_kind: 'exact',
          document_id: DOCUMENT_ID,
          synced_lyrics: null,
          plain_lyrics: null,
          is_instrumental: true,
          provider_name: 'lrclib',
          provider_track_id: '27248323',
          selection_method: 'provider',
          auto_scroll: false,
          raw_metadata: {
            title: track.title,
            artist: track.artist,
            album: track.album,
            duration_ms: track.durationMs,
            source: track.source,
          },
        });
      }
      if (body.p_exact_key !== appleAdjacentKey) {
        return jsonResponse({ result_status: 'miss', match_kind: null, candidates: [] });
      }
      return jsonResponse({
        result_status: 'hit',
        match_kind: 'exact',
        document_id: DOCUMENT_ID,
        synced_lyrics: '[00:14.00]不要不要假設我知道',
        plain_lyrics: '不要不要假設我知道',
        is_instrumental: false,
        provider_name: 'apple',
        provider_track_id: '667921841',
        provider_route: 'apple-primary-v1',
        selection_method: 'provider',
        auto_scroll: true,
        raw_metadata: {
          title: appleTrack.title,
          artist: appleTrack.artist,
          album: appleTrack.album,
          duration_ms: appleTrack.durationMs,
          source: appleTrack.source,
        },
      });
    });

    await expect(makeClient(fetcher as typeof fetch).resolve(input)).resolves.toMatchObject({
      state: 'hit',
      matchKind: 'exact',
      payload: {
        kind: 'synced',
        provider: 'apple',
        providerTrackId: '667921841',
      },
    });

    expect(parsedRequestBody(fetcher.mock.calls[0]![1]).p_exact_key).toBe(input.exactKey);
    expect(parsedRequestBody(fetcher.mock.calls[1]![1]).p_exact_key).toBe(adjacentKey);
    expect(parsedRequestBody(fetcher.mock.calls[2]![1]).p_exact_key).toBe(appleAdjacentKey);
  });

  it('reuses a verified Apple exact hit from a same-bucket script alias', async () => {
    const track: TrackMetadata = {
      title: '单车',
      artist: '陈奕迅',
      album: '2013 陈奕迅 Music Life 精选',
      durationMs: 208_627,
      source: 'Apple Music',
    };
    const appleTrack: TrackMetadata = {
      ...track,
      title: '單車',
      artist: '陳奕迅',
      album: '2013 陳奕迅 Music Life 精選',
    };
    const input: LyricsLibraryResolveInput = {
      track,
      exactKey: lyricsLookupFingerprint(track),
      workKey: lyricsWorkFingerprint(track),
      keyVersion: 1,
      allowWorkFallback: false,
    };
    const appleKey = lyricsLookupFingerprint(appleTrack);
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = parsedRequestBody(init);
      if (body.p_exact_key !== appleKey) {
        return jsonResponse({ result_status: 'miss', match_kind: null, candidates: [] });
      }
      return jsonResponse({
        result_status: 'hit',
        match_kind: 'exact',
        document_id: DOCUMENT_ID,
        synced_lyrics: '[00:14.00]不要不要假設我知道',
        plain_lyrics: '不要不要假設我知道',
        is_instrumental: false,
        provider_name: 'apple',
        provider_track_id: '667921841',
        provider_route: 'apple-primary-v1',
        selection_method: 'provider',
        auto_scroll: true,
        raw_metadata: {
          title: appleTrack.title,
          artist: appleTrack.artist,
          album: appleTrack.album,
          duration_ms: appleTrack.durationMs,
          source: appleTrack.source,
        },
        provider_fallback: {
          result_status: 'hit',
          match_kind: 'exact',
          document_id: '33333333-3333-4333-8333-333333333333',
          synced_lyrics: '[00:14.00]不要不要假设我知道',
          plain_lyrics: '不要不要假设我知道',
          is_instrumental: false,
          provider_name: 'lrclib',
          provider_track_id: '14737395',
          selection_method: 'provider',
          auto_scroll: true,
          raw_metadata: {
            title: appleTrack.title,
            artist: appleTrack.artist,
            album: appleTrack.album,
            duration_ms: appleTrack.durationMs,
            source: appleTrack.source,
          },
        },
      });
    });

    const resolved = await makeClient(fetcher as typeof fetch).resolve(input);
    expect(resolved).toMatchObject({
      state: 'hit',
      matchKind: 'exact',
      payload: {
        kind: 'synced',
        provider: 'apple',
        providerTrackId: '667921841',
      },
    });
    expect(resolved.state === 'hit' && resolved.payload.lines[0]?.text)
      .toBe('不要不要假设我知道');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(parsedRequestBody(fetcher.mock.calls[1]![1]).p_exact_key).toBe(appleKey);
  });

  it('does not reuse a non-Apple hit from the adjacent duration bucket', async () => {
    const track: TrackMetadata = {
      title: '单车',
      artist: '陈奕迅',
      album: '2013 陈奕迅 Music Life 精选',
      durationMs: 209_000,
      source: 'Apple Music',
    };
    const input: LyricsLibraryResolveInput = {
      track,
      exactKey: lyricsLookupFingerprint(track),
      workKey: lyricsWorkFingerprint(track),
      keyVersion: 1,
      allowWorkFallback: false,
    };
    const adjacentKey = lyricsLookupFingerprint({ ...track, durationMs: 208_000 });
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = parsedRequestBody(init);
      if (body.p_exact_key !== adjacentKey) {
        return jsonResponse({ result_status: 'miss', match_kind: null, candidates: [] });
      }
      return jsonResponse({
        result_status: 'hit',
        match_kind: 'exact',
        document_id: DOCUMENT_ID,
        synced_lyrics: '[00:14.00]不要不要假設我知道',
        plain_lyrics: '不要不要假設我知道',
        is_instrumental: false,
        provider_name: 'lrclib',
        provider_track_id: '14737395',
        selection_method: 'provider',
        auto_scroll: true,
        raw_metadata: {
          title: track.title,
          artist: track.artist,
          album: track.album,
          duration_ms: 208_627,
          source: track.source,
        },
      });
    });

    await expect(makeClient(fetcher as typeof fetch).resolve(input)).resolves.toEqual({
      state: 'miss',
    });
    expect(parsedRequestBody(fetcher.mock.calls[1]![1]).p_exact_key).toBe(adjacentKey);
  });

  it('rejects an adjacent-bucket Apple hit when raw duration differs by more than 500ms', async () => {
    const track: TrackMetadata = {
      title: '单车',
      artist: '陈奕迅',
      album: '2013 陈奕迅 Music Life 精选',
      durationMs: 209_000,
      source: 'Apple Music',
    };
    const input: LyricsLibraryResolveInput = {
      track,
      exactKey: lyricsLookupFingerprint(track),
      workKey: lyricsWorkFingerprint(track),
      keyVersion: 1,
      allowWorkFallback: false,
    };
    const adjacentKey = lyricsLookupFingerprint({ ...track, durationMs: 208_000 });
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = parsedRequestBody(init);
      if (body.p_exact_key !== adjacentKey) {
        return jsonResponse({ result_status: 'miss', match_kind: null, candidates: [] });
      }
      return jsonResponse({
        result_status: 'hit',
        match_kind: 'exact',
        document_id: DOCUMENT_ID,
        synced_lyrics: '[00:14.00]不要不要假設我知道',
        plain_lyrics: '不要不要假設我知道',
        is_instrumental: false,
        provider_name: 'apple',
        provider_track_id: '667921841',
        provider_route: 'apple-primary-v1',
        selection_method: 'provider',
        auto_scroll: true,
        raw_metadata: {
          title: track.title,
          artist: track.artist,
          album: track.album,
          duration_ms: 208_499,
          source: track.source,
        },
      });
    });

    await expect(makeClient(fetcher as typeof fetch).resolve(input)).resolves.toEqual({
      state: 'miss',
    });
    expect(parsedRequestBody(fetcher.mock.calls[1]![1]).p_exact_key).toBe(adjacentKey);
  });

  it('does not reuse an adjacent Apple revision without a validated primary route', async () => {
    const track: TrackMetadata = {
      title: '单车',
      artist: '陈奕迅',
      album: '2013 陈奕迅 Music Life 精选',
      durationMs: 209_000,
      source: 'Apple Music',
    };
    const adjacentKey = lyricsLookupFingerprint({ ...track, durationMs: 208_000 });
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = parsedRequestBody(init);
      if (body.p_exact_key !== adjacentKey) {
        return jsonResponse({ result_status: 'miss', match_kind: null, candidates: [] });
      }
      return jsonResponse({
        result_status: 'hit',
        match_kind: 'exact',
        document_id: DOCUMENT_ID,
        synced_lyrics: '[00:14.00]不要不要假設我知道',
        plain_lyrics: '不要不要假設我知道',
        is_instrumental: false,
        provider_name: 'apple',
        provider_track_id: '667921841',
        selection_method: 'provider',
        auto_scroll: true,
        raw_metadata: {
          title: track.title,
          artist: track.artist,
          album: track.album,
          duration_ms: 208_627,
          source: track.source,
        },
      });
    });

    await expect(makeClient(fetcher as typeof fetch).resolve({
      track,
      exactKey: lyricsLookupFingerprint(track),
      workKey: lyricsWorkFingerprint(track),
      keyVersion: 1,
      allowWorkFallback: false,
    })).resolves.toEqual({ state: 'miss' });
  });

  it('returns an instrumental marker as a valid positive hit', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => jsonResponse({
      result_status: 'hit',
      match_kind: 'exact',
      document_id: DOCUMENT_ID,
      synced_lyrics: null,
      plain_lyrics: null,
      is_instrumental: true,
      provider_name: 'manual',
      provider_track_id: null,
      auto_scroll: false,
      raw_metadata: {
        title: TRACK.title,
        artist: TRACK.artist,
        album: TRACK.album,
        duration_ms: TRACK.durationMs,
      },
    }));

    const result = await makeClient(fetcher as typeof fetch).resolve(RESOLVE_INPUT);

    expect(result).toEqual({
      state: 'hit',
      matchKind: 'exact',
      documentId: DOCUMENT_ID,
      payload: {
        kind: 'plain',
        lines: [],
        plainText: '这是一首纯音乐',
        provider: 'manual',
        notice: '个人歌词库将这首曲目标记为纯音乐。',
      },
    });
  });

  it('rejects a hit whose stored metadata does not reproduce the requested binding key', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      result_status: 'hit',
      match_kind: 'exact',
      document_id: DOCUMENT_ID,
      synced_lyrics: '[00:01.00]Wrong recording',
      auto_scroll: true,
      raw_metadata: {
        title: 'Midnight Circuit',
        artist: TRACK.artist,
        album: TRACK.album,
        duration_ms: TRACK.durationMs,
      },
    }));

    await expect(makeClient(fetcher as typeof fetch).resolve(RESOLVE_INPUT)).resolves.toEqual({
      state: 'unavailable',
      reason: 'invalid-response',
    });
  });

  it('returns a miss and suppresses the work key when work fallback is disabled', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => jsonResponse({
      result_status: 'miss',
      match_kind: null,
      candidates: [],
    }));

    const result = await makeClient(fetcher as typeof fetch).resolve({
      ...RESOLVE_INPUT,
      allowWorkFallback: false,
    });

    expect(result).toEqual({ state: 'miss' });
    expect(parsedRequestBody(fetcher.mock.calls[0][1])).toMatchObject({ p_work_key: null });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('returns ambiguity with the number of supplied candidates', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      result_status: 'ambiguous',
      match_kind: null,
      candidates: [{ id: 1 }, { id: 2 }, { id: 3 }],
    }));

    await expect(makeClient(fetcher as typeof fetch).resolve(RESOLVE_INPUT)).resolves.toEqual({
      state: 'ambiguous',
      candidateCount: 3,
    });
  });

  it('classifies timeout failures without turning them into misses', async () => {
    const fetcher = vi.fn(async () => {
      const error = new Error('request timed out');
      error.name = 'TimeoutError';
      throw error;
    });

    await expect(makeClient(fetcher as unknown as typeof fetch).resolve(RESOLVE_INPUT)).resolves.toEqual({
      state: 'unavailable',
      reason: 'timeout',
    });
  });

  it.each([401, 403])('classifies HTTP %i as an authentication failure', async (status) => {
    const fetcher = vi.fn(async () => jsonResponse({ message: 'denied' }, { status }));

    await expect(makeClient(fetcher as typeof fetch).resolve(RESOLVE_INPUT)).resolves.toEqual({
      state: 'unavailable',
      reason: 'auth',
    });
  });

  it.each([500, 502, 503])('classifies HTTP %i as a server failure', async (status) => {
    const fetcher = vi.fn(async () => jsonResponse({ message: 'unavailable' }, { status }));

    await expect(makeClient(fetcher as typeof fetch).resolve(RESOLVE_INPUT)).resolves.toEqual({
      state: 'unavailable',
      reason: 'server',
    });
  });

  it('classifies HTTP 408 as a timeout and 429 as a retryable server failure', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ message: 'retry later' }, { status: 408 }));
    const client = makeClient(fetcher as typeof fetch);

    await expect(client.resolve(RESOLVE_INPUT)).resolves.toEqual({
      state: 'unavailable',
      reason: 'timeout',
    });

    fetcher.mockResolvedValueOnce(jsonResponse({ message: 'rate limited' }, { status: 429 }));
    await expect(client.resolve(RESOLVE_INPUT)).resolves.toEqual({
      state: 'unavailable',
      reason: 'server',
    });
  });

  it('classifies a network rejection independently from timeout', async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });

    await expect(makeClient(fetcher as unknown as typeof fetch).resolve(RESOLVE_INPUT)).resolves.toEqual({
      state: 'unavailable',
      reason: 'network',
    });
  });

  it.each([
    {
      label: 'malformed JSON',
      response: () => new Response('{not-json', { status: 200 }),
    },
    {
      label: 'an unknown result status',
      response: () => jsonResponse({ result_status: 'maybe' }),
    },
    {
      label: 'a hit without a document id',
      response: () => jsonResponse({
        result_status: 'hit',
        match_kind: 'exact',
        synced_lyrics: '[00:01.00]Line',
        auto_scroll: true,
      }),
    },
    {
      label: 'a hit without usable lyric content',
      response: () => jsonResponse({
        result_status: 'hit',
        match_kind: 'exact',
        document_id: DOCUMENT_ID,
        synced_lyrics: null,
        plain_lyrics: null,
        is_instrumental: false,
      }),
    },
  ])('classifies $label as an invalid response', async ({ response }) => {
    const fetcher = vi.fn(async () => response());

    await expect(makeClient(fetcher as typeof fetch).resolve(RESOLVE_INPUT)).resolves.toEqual({
      state: 'unavailable',
      reason: 'invalid-response',
    });
  });

  it('rejects a response whose declared content length exceeds the limit', async () => {
    const fetcher = vi.fn(async () => jsonResponse(
      { result_status: 'miss' },
      { headers: { 'Content-Length': String(MAX_RESPONSE_BYTES + 1) } },
    ));

    await expect(makeClient(fetcher as typeof fetch).resolve(RESOLVE_INPUT)).resolves.toEqual({
      state: 'unavailable',
      reason: 'invalid-response',
    });
  });

  it('rejects an oversized body even without a content-length header', async () => {
    const oversized = JSON.stringify({
      result_status: 'miss',
      padding: 'x'.repeat(MAX_RESPONSE_BYTES),
    });
    const fetcher = vi.fn(async () => new Response(oversized, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(makeClient(fetcher as typeof fetch).resolve(RESOLVE_INPUT)).resolves.toEqual({
      state: 'unavailable',
      reason: 'invalid-response',
    });
  });
});

describe('SupabaseLyricsClient.compareQuarantined', () => {
  it('compares exact timing and static work text without returning candidate content', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => jsonResponse({
      exact: {
        candidate_count: 2,
        comparisons: 2,
        agreements: 1,
        disagreements: 1,
      },
      work: {
        candidate_count: 1,
        comparisons: 1,
        agreements: 1,
        disagreements: 0,
      },
    }));
    const expectedExact = exactWrite().cached.payload;
    const expectedWork = {
      kind: 'plain' as const,
      lines: [
        { id: 'plain-0', startMs: 0, text: 'Studio first line' },
        { id: 'plain-1', startMs: 0, text: 'Studio second line' },
      ],
      plainText: '  Studio first line\r\n\r\nStudio second line  ',
      provider: 'lrclib' as const,
      fallbackKind: 'work-cache' as const,
      notice: 'display-only metadata',
    };

    await expect(makeClient(fetcher as typeof fetch).compareQuarantined({
      track: TRACK,
      exactKey: RESOLVE_INPUT.exactKey,
      workKey: RESOLVE_INPUT.workKey,
      keyVersion: 1,
      observedBefore: OBSERVED_BEFORE,
      expectedExact,
      expectedWork,
    })).resolves.toEqual({
      state: 'ok',
      exact: { candidateCount: 2, comparisons: 2, agreements: 1, disagreements: 1 },
      work: { candidateCount: 1, comparisons: 1, agreements: 1, disagreements: 0 },
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe(`${SUPABASE_URL}/rest/v1/rpc/compare_quarantined_lyrics`);
    expect(parsedRequestBody(init)).toEqual({
      p_library_id: LIBRARY_ID,
      p_exact_key: RESOLVE_INPUT.exactKey,
      p_work_key: RESOLVE_INPUT.workKey,
      p_key_version: 1,
      p_observed_before: OBSERVED_BEFORE,
      p_expected_exact: {
        synced_lyrics: '[00:00.00]Prelude\n[01:01.01]Chorus',
        plain_lyrics: 'Prelude\nChorus',
        is_instrumental: false,
      },
      p_expected_work: {
        plain_lyrics: 'Studio first line\nStudio second line',
        is_instrumental: false,
      },
    });
    expect(String(init?.body)).not.toContain('display-only metadata');
  });

  it('fails closed when aggregate counters violate their invariants', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      exact: {
        candidate_count: 1,
        comparisons: 1,
        agreements: 1,
        disagreements: 1,
      },
      work: {
        candidate_count: 0,
        comparisons: 0,
        agreements: 0,
        disagreements: 0,
      },
    }));

    await expect(makeClient(fetcher as typeof fetch).compareQuarantined({
      track: TRACK,
      exactKey: RESOLVE_INPUT.exactKey,
      workKey: RESOLVE_INPUT.workKey,
      keyVersion: 1,
      observedBefore: OBSERVED_BEFORE,
      expectedExact: exactWrite().cached.payload,
    })).resolves.toEqual({ state: 'unavailable', reason: 'invalid-response' });
  });

  it('represents an instrumental exact result as a positive comparison payload', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => jsonResponse({
      exact: {
        candidate_count: 1,
        comparisons: 1,
        agreements: 1,
        disagreements: 0,
      },
      work: {
        candidate_count: 0,
        comparisons: 0,
        agreements: 0,
        disagreements: 0,
      },
    }));

    await makeClient(fetcher as typeof fetch).compareQuarantined({
      track: TRACK,
      exactKey: RESOLVE_INPUT.exactKey,
      workKey: RESOLVE_INPUT.workKey,
      keyVersion: 1,
      observedBefore: OBSERVED_BEFORE,
      expectedExact: {
        kind: 'plain',
        lines: [],
        plainText: '这是一首纯音乐',
        provider: 'lrclib',
      },
    });

    expect(parsedRequestBody(fetcher.mock.calls[0][1])).toMatchObject({
      p_expected_exact: { is_instrumental: true },
      p_expected_work: null,
    });
  });

  it('classifies a shadow comparison timeout without throwing', async () => {
    const fetcher = vi.fn(async () => {
      const error = new Error('request timed out');
      error.name = 'TimeoutError';
      throw error;
    });

    await expect(makeClient(fetcher as unknown as typeof fetch).compareQuarantined({
      track: TRACK,
      exactKey: RESOLVE_INPUT.exactKey,
      workKey: RESOLVE_INPUT.workKey,
      keyVersion: 1,
      observedBefore: OBSERVED_BEFORE,
      expectedExact: exactWrite().cached.payload,
    })).resolves.toEqual({ state: 'unavailable', reason: 'timeout' });
  });
});

describe('SupabaseLyricsClient writes', () => {
  it('reconstructs display LRC and sends exact provenance without leaking the secret into JSON', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => (
      jsonResponse({ document_id: DOCUMENT_ID })
    ));

    await makeClient(fetcher as typeof fetch).upsertExact(exactWrite());

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe(`${SUPABASE_URL}/rest/v1/rpc/upsert_lyrics_document`);
    expect(new Headers(init?.headers).get('apikey')).toBe(SECRET_KEY);
    expect(String(init?.body)).not.toContain(SECRET_KEY);
    expect(parsedRequestBody(init)).toEqual({
      p_library_id: LIBRARY_ID,
      p_exact_key: RESOLVE_INPUT.exactKey,
      p_work_key: null,
      p_key_version: 1,
      p_raw_metadata: {
        title: TRACK.title,
        artist: TRACK.artist,
        album: TRACK.album,
        duration_ms: TRACK.durationMs,
        source: TRACK.source,
      },
      p_payload: {
        synced_lyrics: '[00:00.00]Prelude\n[01:01.01]Chorus',
        plain_lyrics: 'Prelude\nChorus',
        is_instrumental: false,
        duration_ms: TRACK.durationMs,
      },
      p_provenance: {
        provider_name: 'lrclib',
        provider_track_id: 987,
        lookup_strategy: 'lrclib-multi-v2',
        metadata_signature: 'metadata-signature-v1',
        body_format: 'display-reconstructed-v1',
      },
      p_acquisition: 'provider',
      p_requested_status: 'active',
    });
  });

  it.each([
    ['automatic', 'provider'],
    ['manual', 'manual'],
    ['candidate', 'candidate'],
  ] as const)(
    'maps %s acquisition and requests an active exact binding',
    async (sourceKind, expectedAcquisition) => {
      const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => (
        jsonResponse({ document_id: DOCUMENT_ID })
      ));

      await makeClient(fetcher as typeof fetch).upsertExact(exactWrite(sourceKind));

      expect(parsedRequestBody(fetcher.mock.calls[0][1])).toMatchObject({
        p_acquisition: expectedAcquisition,
        p_requested_status: 'active',
      });
    },
  );

  it('isolates an active candidate from later automatic writes for the same provider id', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => (
      jsonResponse({ document_id: DOCUMENT_ID })
    ));

    await makeClient(fetcher as typeof fetch).upsertExact(exactWrite('candidate'));

    expect(parsedRequestBody(fetcher.mock.calls[0][1])).toMatchObject({
      p_provenance: {
        provider_name: 'lrclib',
        provider_track_id: 987,
        idempotency_key: `candidate:v1:${RESOLVE_INPUT.exactKey}:987`,
        selection_version: SELECTION_VERSION,
      },
      p_acquisition: 'candidate',
      p_requested_status: 'active',
    });
  });

  it('reserves selection version zero for automatic Exact writes', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => (
      jsonResponse({ document_id: DOCUMENT_ID })
    ));
    const input = exactWrite('manual');
    input.selectionVersion = 0;

    await expect(makeClient(fetcher as typeof fetch).upsertExact(input))
      .rejects.toThrow('positive selectionVersion');

    expect(fetcher).not.toHaveBeenCalled();
  });

  it('serializes an instrumental exact write without lyric text', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => (
      jsonResponse({ document_id: DOCUMENT_ID })
    ));
    const input = exactWrite('manual');
    input.cached.payload = {
      kind: 'plain',
      lines: [],
      plainText: '这是一首纯音乐',
      provider: 'manual',
    };

    await makeClient(fetcher as typeof fetch).upsertExact(input);

    expect(parsedRequestBody(fetcher.mock.calls[0][1])).toMatchObject({
      p_payload: { is_instrumental: true },
      p_acquisition: 'manual',
      p_requested_status: 'active',
    });
  });

  it('does not write an unverified automatic instrumental exact result', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ document_id: DOCUMENT_ID }));
    const input = exactWrite();
    input.cached.payload = {
      kind: 'plain',
      lines: [],
      plainText: '这是一首纯音乐',
      provider: 'lrclib',
      providerId: 27248323,
    };

    await makeClient(fetcher as typeof fetch).upsertExact(input);

    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['missing', 'loading'] as const)('does not write a %s display payload', async (kind) => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => (
      jsonResponse({ document_id: DOCUMENT_ID })
    ));
    const input = exactWrite();
    input.cached.payload = {
      kind,
      lines: [],
      provider: null,
    };

    await makeClient(fetcher as typeof fetch).upsertExact(input);

    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['original-version', 'work-cache'] as const)(
    'does not promote a %s fallback through an exact write',
    async (fallbackKind) => {
      const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => (
        jsonResponse({ document_id: DOCUMENT_ID })
      ));
      const input = exactWrite();
      input.cached.payload.fallbackKind = fallbackKind;

      await makeClient(fetcher as typeof fetch).upsertExact(input);

      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('writes work lyrics as static plain content with provider acquisition and requested status', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => (
      jsonResponse({ document_id: DOCUMENT_ID })
    ));

    await makeClient(fetcher as typeof fetch).upsertWork(workWrite());

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe(`${SUPABASE_URL}/rest/v1/rpc/upsert_lyrics_document`);
    expect(String(init?.body)).not.toContain(SECRET_KEY);
    expect(parsedRequestBody(init)).toEqual({
      p_library_id: LIBRARY_ID,
      p_exact_key: null,
      p_work_key: RESOLVE_INPUT.workKey,
      p_key_version: 1,
      p_raw_metadata: {
        title: 'Midnight Circuit',
        artist: 'Local Drive',
        duration_ms: 0,
      },
      p_payload: {
        plain_lyrics: 'Studio first line\nStudio second line',
        is_instrumental: false,
        duration_ms: 0,
      },
      p_provenance: {
        provider_name: 'lrclib',
        provider_track_id: 654,
        source_kind: 'work-cache',
        idempotency_key: `work:v1:${RESOLVE_INPUT.workKey}:654`,
      },
      p_acquisition: 'provider',
      p_requested_status: 'quarantine',
    });
  });
});

describe('SupabaseLyricsClient Apple backfill RPCs', () => {
  const JOB_ID = '33333333-3333-4333-8333-333333333333';
  const LEASE_TOKEN = '44444444-4444-4444-8444-444444444444';
  const REVISION_ID = '55555555-5555-4555-8555-555555555555';
  const ARTIFACT_ID = '66666666-6666-4666-8666-666666666666';

  it('enqueues metadata only and maps the claimed attempt count to the worker contract', async () => {
    const fetcher = vi.fn(async (
      input: string | URL | Request,
      _init?: RequestInit,
    ) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/enqueue_apple_lyrics_backfill')) {
        return jsonResponse({
          job_id: JOB_ID,
          status: 'pending',
          attempt_count: 0,
          max_attempts: 5,
        });
      }
      return jsonResponse([{
        job_id: JOB_ID,
        lease_token: LEASE_TOKEN,
        attempt_count: 3,
        max_attempts: 5,
        exact_key: RESOLVE_INPUT.exactKey,
        key_version: 1,
        storefront: 'us',
        locale: 'en-US',
        provider_track_id: null,
        isrc: null,
        track_metadata: {
          title: TRACK.title,
          artist: TRACK.artist,
          album: TRACK.album,
          duration_ms: TRACK.durationMs,
          source: TRACK.source,
        },
      }]);
    });
    const client = makeClient(fetcher as typeof fetch);

    await expect(client.enqueueAppleLyricsBackfill({
      exactKey: RESOLVE_INPUT.exactKey,
      keyVersion: 1,
      storefront: 'US',
      locale: 'en-US',
      track: TRACK,
      maxAttempts: 5,
    })).resolves.toEqual({ status: 'pending' });
    await expect(client.claimAppleLyricsBackfill({
      workerId: 'worker-1',
      limit: 1,
      leaseSeconds: 300,
    })).resolves.toEqual([{
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      attempts: 2,
      maxAttempts: 5,
      exactKey: RESOLVE_INPUT.exactKey,
      keyVersion: 1,
      storefront: 'us',
      locale: 'en-US',
      track: TRACK,
    }]);

    expect(parsedRequestBody(fetcher.mock.calls[0][1])).toMatchObject({
      p_library_id: LIBRARY_ID,
      p_storefront: 'us',
      p_track_metadata: {
        title: TRACK.title,
        artist: TRACK.artist,
        album: TRACK.album,
        duration_ms: TRACK.durationMs,
        source: TRACK.source,
      },
    });
    expect(JSON.stringify(parsedRequestBody(fetcher.mock.calls[0][1])))
      .not.toContain('media-user-token');
  });

  it('sends untouched TTML to atomic completion and verifies returned hash and byte size', async () => {
    const rawTtml = '\uFEFF<tt xmlns="http://www.w3.org/ns/ttml">原文</tt>\n';
    const artifactHash = createHash('sha256').update(rawTtml, 'utf8').digest('hex');
    const fetcher = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => jsonResponse({
      job_id: JOB_ID,
      status: 'completed',
      document_id: DOCUMENT_ID,
      revision_id: REVISION_ID,
      artifact_id: ARTIFACT_ID,
      artifact_content_hash: artifactHash,
      artifact_bytes: Buffer.byteLength(rawTtml, 'utf8'),
      storefront: 'cn',
      effective_status: 'quarantine',
      promotion_blocked: true,
    }));

    await makeClient(fetcher as typeof fetch).completeAppleLyricsBackfill({
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      providerTrackId: '1450330685',
      storefront: 'cn',
      rawMetadata: { title: TRACK.title },
      payload: { plain_lyrics: '原文', is_instrumental: false },
      provenance: { lookup_strategy: 'apple-async-exact-v1' },
      rawTtml,
      locale: 'zh-Hans',
      timingMode: 'word',
      recordingVariant: 'original',
    });

    expect(new URL(String(fetcher.mock.calls[0][0])).pathname)
      .toBe('/rest/v1/rpc/complete_apple_lyrics_backfill_v3');
    expect(parsedRequestBody(fetcher.mock.calls[0][1])).toMatchObject({
      p_raw_ttml: rawTtml,
      p_provider_track_id: '1450330685',
      p_storefront: 'cn',
      p_timing_mode: 'word',
      p_recording_variant: 'original',
    });
  });

  it('releases a failed lease using identifiers only', async () => {
    const fetcher = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => jsonResponse({
      job_id: JOB_ID,
      status: 'retry_wait',
    }));

    await makeClient(fetcher as typeof fetch).failAppleLyricsBackfill({
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      errorCode: 'fetch:http-503',
      retryable: true,
      retryAfterSeconds: 30,
    });

    expect(parsedRequestBody(fetcher.mock.calls[0][1])).toEqual({
      p_job_id: JOB_ID,
      p_lease_token: LEASE_TOKEN,
      p_error_code: 'fetch:http-503',
      p_retryable: true,
      p_retry_after_seconds: 30,
    });
  });
});

describe('SupabaseLyricsClient Apple TTML reprojection RPCs', () => {
  const JOB_ID = '33333333-3333-4333-8333-333333333333';
  const LEASE_TOKEN = '44444444-4444-4444-8444-444444444444';
  const REVISION_ID = '55555555-5555-4555-8555-555555555555';
  const SOURCE_ARTIFACT_ID = '66666666-6666-4666-8666-666666666666';
  const RESULT_ARTIFACT_ID = '77777777-7777-4777-8777-777777777777';
  const rawTtml = '<tt xmlns="http://www.w3.org/ns/ttml"><body /></tt>';
  const artifactHash = createHash('sha256').update(rawTtml).digest('hex');

  it('claims retained immutable TTML and maps its exact proof without Apple credentials', async () => {
    const fetcher = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => jsonResponse([{
      job_id: JOB_ID,
      lease_token: LEASE_TOKEN,
      lease_expires_at: '2026-07-18T18:00:00+00:00',
      attempt_count: 1,
      max_attempts: 5,
      target_projection_version: 'apple-ttml-line-model-v2',
      source_artifact: {
        id: SOURCE_ARTIFACT_ID,
        revision_id: REVISION_ID,
        provider_name: 'apple',
        provider_track_id: '1450330685',
        storefront: 'cn',
        exact_key: RESOLVE_INPUT.exactKey,
        key_version: 1,
        locale: 'zh-Hans-CN',
        timing_mode: 'line',
        recording_variant: 'original',
        projection_version: 'apple-ttml-line-model-v1',
        raw_ttml: rawTtml,
        content_hash: artifactHash,
        byte_size: Buffer.byteLength(rawTtml),
        fetched_at: '2026-07-18T12:00:00+00:00',
      },
      track_metadata: {
        title: TRACK.title,
        artist: TRACK.artist,
        album: TRACK.album,
        duration_ms: TRACK.durationMs,
        source: TRACK.source,
      },
      identity_proof: {
        proof_version: 1,
        evidence: ['catalog-id', 'catalog-metadata-v1'],
        provider_name: 'apple',
        provider_track_id: '1450330685',
        exact_key: RESOLVE_INPUT.exactKey,
        key_version: 1,
      },
    }]));

    await expect(makeClient(fetcher as typeof fetch).claimAppleLyricsReprojection({
      workerId: 'reproject-v2-1',
      limit: 1,
      leaseSeconds: 300,
    })).resolves.toMatchObject([{
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      attemptCount: 1,
      targetProjectionVersion: 'apple-ttml-line-model-v2',
      sourceArtifact: {
        id: SOURCE_ARTIFACT_ID,
        rawTtml,
        contentHash: artifactHash,
      },
      identityProof: {
        proofVersion: 1,
        evidence: ['catalog-id', 'catalog-metadata-v1'],
      },
    }]);

    expect(parsedRequestBody(fetcher.mock.calls[0][1])).toEqual({
      p_library_id: LIBRARY_ID,
      p_worker_id: 'reproject-v2-1',
      p_limit: 1,
      p_lease_seconds: 300,
    });
    expect(String(fetcher.mock.calls[0][1]?.body)).not.toContain('media-user-token');
  });

  it('verifies completion preserved the source hash, quarantine, and serving binding', async () => {
    const fetcher = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => jsonResponse({
      job_id: JOB_ID,
      status: 'completed',
      source_artifact_id: SOURCE_ARTIFACT_ID,
      document_id: DOCUMENT_ID,
      revision_id: REVISION_ID,
      artifact_id: RESULT_ARTIFACT_ID,
      target_projection_version: 'apple-ttml-line-model-v2',
      normalized_content_hash: 'a'.repeat(64),
      artifact_content_hash: artifactHash,
      artifact_bytes: Buffer.byteLength(rawTtml),
      effective_status: 'quarantine',
      serving_binding_unchanged: true,
    }));

    await makeClient(fetcher as typeof fetch).completeAppleLyricsReprojection({
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      sourceArtifactId: SOURCE_ARTIFACT_ID,
      sourceArtifactHash: artifactHash,
      sourceArtifactBytes: Buffer.byteLength(rawTtml),
      payload: { plain_lyrics: 'retained projection' },
      provenance: { projection_version: 'apple-ttml-line-model-v2' },
      timingMode: 'line',
    });

    expect(parsedRequestBody(fetcher.mock.calls[0][1])).toEqual({
      p_job_id: JOB_ID,
      p_lease_token: LEASE_TOKEN,
      p_payload: { plain_lyrics: 'retained projection' },
      p_provenance: { projection_version: 'apple-ttml-line-model-v2' },
      p_timing_mode: 'line',
    });
  });

  it('claims only v2 artifacts with a fixed v3 timeline anomaly', async () => {
    const fetcher = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => jsonResponse([{
      job_id: JOB_ID,
      lease_token: LEASE_TOKEN,
      lease_expires_at: '2026-07-19T18:00:00+00:00',
      attempt_count: 1,
      max_attempts: 5,
      target_projection_version: 'apple-ttml-line-model-v3',
      source_anomaly_code: 'timestamp-duration-overrun',
      source_artifact: {
        id: SOURCE_ARTIFACT_ID,
        revision_id: REVISION_ID,
        provider_name: 'apple',
        provider_track_id: '1450330685',
        storefront: 'cn',
        exact_key: RESOLVE_INPUT.exactKey,
        key_version: 1,
        locale: 'zh-Hans-CN',
        timing_mode: 'line',
        recording_variant: 'original',
        projection_version: 'apple-ttml-line-model-v2',
        raw_ttml: rawTtml,
        content_hash: artifactHash,
        byte_size: Buffer.byteLength(rawTtml),
        fetched_at: '2026-07-19T12:00:00+00:00',
      },
      track_metadata: {
        title: TRACK.title,
        artist: TRACK.artist,
        album: TRACK.album,
        duration_ms: TRACK.durationMs,
        source: TRACK.source,
      },
      identity_proof: {
        proof_version: 1,
        evidence: ['catalog-id', 'catalog-metadata-v1'],
        provider_name: 'apple',
        provider_track_id: '1450330685',
        exact_key: RESOLVE_INPUT.exactKey,
        key_version: 1,
      },
    }]));

    await expect(
      makeClient(fetcher as typeof fetch).claimAppleLyricsTimelineRepair({
        workerId: 'timeline-repair-v3-1',
        limit: 1,
        leaseSeconds: 300,
      }),
    ).resolves.toMatchObject([{
      jobId: JOB_ID,
      targetProjectionVersion: 'apple-ttml-line-model-v3',
      sourceAnomalyCode: 'timestamp-duration-overrun',
      sourceArtifact: {
        projectionVersion: 'apple-ttml-line-model-v2',
        rawTtml,
      },
    }]);
    expect(new URL(String(fetcher.mock.calls[0][0])).pathname)
      .toBe('/rest/v1/rpc/claim_apple_lyrics_timeline_repair_v3');
  });

  it('enqueues and completes v3 timeline repair through versioned RPCs', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        target_projection_version: 'apple-ttml-line-model-v3',
        enqueued: 1,
        remaining: 0,
      }))
      .mockResolvedValueOnce(jsonResponse({
        job_id: JOB_ID,
        status: 'completed',
        source_artifact_id: SOURCE_ARTIFACT_ID,
        document_id: DOCUMENT_ID,
        revision_id: REVISION_ID,
        artifact_id: RESULT_ARTIFACT_ID,
        target_projection_version: 'apple-ttml-line-model-v3',
        normalized_content_hash: 'b'.repeat(64),
        artifact_content_hash: artifactHash,
        artifact_bytes: Buffer.byteLength(rawTtml),
        effective_status: 'quarantine',
        serving_binding_unchanged: true,
      }));
    const client = makeClient(fetcher as typeof fetch);

    await expect(client.enqueueAppleLyricsTimelineRepair(100)).resolves.toEqual({
      enqueued: 1,
      remaining: 0,
    });
    await client.completeAppleLyricsTimelineRepair({
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      sourceArtifactId: SOURCE_ARTIFACT_ID,
      sourceArtifactHash: artifactHash,
      sourceArtifactBytes: Buffer.byteLength(rawTtml),
      payload: {
        synced_lyrics: '[00:01.000]Repaired',
        plain_lyrics: 'Repaired',
        duration_ms: TRACK.durationMs,
      },
      provenance: {
        timeline_validation_version: 'apple-timeline-validation-v1',
        timeline_validation_outcome: 'repaired',
        timeline_source_anomaly: 'timestamp-duration-overrun',
        timeline_repair_method: 'word-span-line-start-v1',
      },
      timingMode: 'line',
    });

    expect(new URL(String(fetcher.mock.calls[0][0])).pathname)
      .toBe('/rest/v1/rpc/enqueue_apple_lyrics_timeline_repair_v3');
    expect(new URL(String(fetcher.mock.calls[1][0])).pathname)
      .toBe('/rest/v1/rpc/complete_apple_lyrics_timeline_repair_v3');
  });
});

describe('SupabaseLyricsClient Apple worker cancellation', () => {
  const JOB_ID = '33333333-3333-4333-8333-333333333333';
  const LEASE_TOKEN = '44444444-4444-4444-8444-444444444444';
  const rawTtml = '<tt xmlns="http://www.w3.org/ns/ttml"><body /></tt>';
  const sourceHash = createHash('sha256').update(rawTtml).digest('hex');
  const backfillComplete = {
    jobId: JOB_ID,
    leaseToken: LEASE_TOKEN,
    providerTrackId: '1450330685',
    storefront: 'cn',
    rawMetadata: { title: TRACK.title },
    payload: { plain_lyrics: '原文', is_instrumental: false },
    provenance: { lookup_strategy: 'apple-async-exact-v3' },
    rawTtml,
    locale: 'zh-Hans',
    timingMode: 'line',
    recordingVariant: 'original',
  };
  const projectionComplete = {
    jobId: JOB_ID,
    leaseToken: LEASE_TOKEN,
    sourceArtifactId: '66666666-6666-4666-8666-666666666666',
    sourceArtifactHash: sourceHash,
    sourceArtifactBytes: Buffer.byteLength(rawTtml),
    payload: { plain_lyrics: '原文' },
    provenance: { projection_version: 'test' },
    timingMode: 'line',
  };
  const enqueue = {
    exactKey: RESOLVE_INPUT.exactKey,
    keyVersion: 1,
    storefront: 'cn',
    locale: 'zh-Hans',
    track: TRACK,
  };
  const claim = { workerId: 'worker-cancel-test', limit: 1, leaseSeconds: 300 };
  const failure = {
    jobId: JOB_ID,
    leaseToken: LEASE_TOKEN,
    errorCode: 'fetch:timeout',
    retryable: true,
    retryAfterSeconds: 30,
  };

  const operations: Array<[
    string,
    (client: SupabaseLyricsClient, signal: AbortSignal) => Promise<unknown>,
  ]> = [
    ['backfill enqueue', (client, signal) =>
      client.enqueueAppleLyricsBackfill(enqueue, { signal })],
    ['backfill claim', (client, signal) =>
      client.claimAppleLyricsBackfill(claim, { signal })],
    ['backfill complete', (client, signal) =>
      client.completeAppleLyricsBackfill(backfillComplete, { signal })],
    ['backfill fail', (client, signal) =>
      client.failAppleLyricsBackfill(failure, { signal })],
    ['v2 enqueue', (client, signal) =>
      client.enqueueAppleLyricsReprojection(100, { signal })],
    ['v2 claim', (client, signal) =>
      client.claimAppleLyricsReprojection(claim, { signal })],
    ['v2 complete', (client, signal) =>
      client.completeAppleLyricsReprojection(projectionComplete, { signal })],
    ['v2 fail', (client, signal) =>
      client.failAppleLyricsReprojection(failure, { signal })],
    ['v3 enqueue', (client, signal) =>
      client.enqueueAppleLyricsTimelineRepair(100, { signal })],
    ['v3 claim', (client, signal) =>
      client.claimAppleLyricsTimelineRepair(claim, { signal })],
    ['v3 complete', (client, signal) =>
      client.completeAppleLyricsTimelineRepair(projectionComplete, { signal })],
    ['v3 fail', (client, signal) =>
      client.failAppleLyricsTimelineRepair(failure, { signal })],
  ];

  it.each(operations)('aborts a pending %s RPC with the caller reason', async (_name, invoke) => {
    const fetcher = vi.fn((
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const client = makeClient(fetcher as typeof fetch);
    const controller = new AbortController();
    const reason = new DOMException('worker deadline', 'TimeoutError');

    const pending = invoke(client, controller.signal);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const requestSignal = fetcher.mock.calls[0]![1]?.signal;
    expect(requestSignal).toBeInstanceOf(AbortSignal);
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(requestSignal?.aborted).toBe(true);
  });

  it('aborts a stalled response body even when stream cancellation never settles', async () => {
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
      cancel: () => {
        cancellations += 1;
        return new Promise<void>(() => undefined);
      },
    });
    const fetcher = vi.fn(async () => new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const controller = new AbortController();
    const reason = new DOMException('worker deadline', 'TimeoutError');

    const pending = makeClient(fetcher as typeof fetch).claimAppleLyricsBackfill(
      claim,
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(body.locked).toBe(true));
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(cancellations).toBe(1);
  });

  it('does not await a rejected response body cancellation', async () => {
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
      cancel: () => {
        cancellations += 1;
        return new Promise<void>(() => undefined);
      },
    });
    const fetcher = vi.fn(async () => new Response(body, { status: 503 }));

    await expect(makeClient(fetcher as typeof fetch).claimAppleLyricsBackfill(claim))
      .rejects.toThrow(/server/);
    expect(cancellations).toBe(1);
  });
});

describe('SupabaseLyricsClient configuration', () => {
  it('adds Authorization for a legacy service-role JWT but not for a new opaque secret', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => (
      jsonResponse({ result_status: 'miss', candidates: [] })
    ));
    const legacyKey = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signature';
    const legacyClient = new SupabaseLyricsClient({
      url: SUPABASE_URL,
      secretKey: legacyKey,
      libraryId: LIBRARY_ID,
      timeoutMs: 100,
      fetcher: fetcher as typeof fetch,
    });

    await legacyClient.resolve(RESOLVE_INPUT);
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('Authorization')).toBe(
      `Bearer ${legacyKey}`,
    );

    fetcher.mockClear();
    await makeClient(fetcher as typeof fetch).resolve(RESOLVE_INPUT);
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('Authorization')).toBeNull();
  });

  it('rejects non-HTTP URLs, invalid library ids, and missing secrets', () => {
    expect(() => new SupabaseLyricsClient({
      url: 'file:///tmp/supabase',
      secretKey: SECRET_KEY,
      libraryId: LIBRARY_ID,
      timeoutMs: 100,
    })).toThrow(/HTTP or HTTPS/);

    expect(() => new SupabaseLyricsClient({
      url: SUPABASE_URL,
      secretKey: SECRET_KEY,
      libraryId: 'not-a-uuid',
      timeoutMs: 100,
    })).toThrow();

    expect(() => new SupabaseLyricsClient({
      url: SUPABASE_URL,
      secretKey: '',
      libraryId: LIBRARY_ID,
      timeoutMs: 100,
    })).toThrow(/SUPABASE_SECRET_KEY/);
  });
});

describe('SupabaseLyricsClient queue observability', () => {
  it('maps bounded queue counters without exposing queue payload details', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      expect(new URL(input.toString()).pathname).toBe(
        '/rest/v1/rpc/observe_apple_lyrics_queue',
      );
      return jsonResponse({
        backfill: {
          pending: 2,
          processing: 1,
          expired_processing: 1,
          oldest_pending_at: '2026-08-11T20:00:00.000Z',
          next_lease_expiry_at: '2026-08-11T20:05:00.000Z',
        },
      });
    });

    await expect(makeClient(fetcher as typeof fetch).observeAppleLyricsQueue())
      .resolves.toEqual({
        backfill: {
          pending: 2,
          processing: 1,
          expiredProcessing: 1,
          oldestPendingAt: '2026-08-11T20:00:00.000Z',
          nextLeaseExpiryAt: '2026-08-11T20:05:00.000Z',
        },
      });
  });
});
