import { createHash } from 'node:crypto';
import type { ArtworkPalette, TrackMetadata } from '../shared/contracts.js';
import {
  type PaletteWriteInput,
  SupabasePaletteClient,
} from './supabase-palette-client.js';

const SUPABASE_URL = 'https://lyrics-project.supabase.co';
const SECRET_KEY = 'unit-test-secret-key';
const LIBRARY_ID = '11111111-1111-4111-8111-111111111111';

const TRACK: TrackMetadata = {
  title: 'Midnight Circuit',
  artist: 'Local Drive',
  album: 'After Dark',
  durationMs: 214_000,
  source: 'Apple Music',
};

const PALETTE: ArtworkPalette = {
  primary: '#DC233C',
  secondary: '#195ADC',
  source: 'apple',
  field: {
    schemaVersion: 1,
    id: 'field:0123456789abcdef',
    columns: 6,
    rows: 4,
    base: '#17202A',
    colors: Array.from({ length: 24 }, (_, index) => index < 12 ? '#DC233C' : '#195ADC'),
  },
};

const WRITE_INPUT: PaletteWriteInput = {
  track: TRACK,
  artworkKey: 'v3::midnight circuit::local drive::after dark::214',
  providerName: 'apple',
  providerTrackId: 42,
  matchConfidence: 0.94,
  palette: PALETTE,
};

function makeClient(
  fetcher: typeof fetch,
  secretKey = SECRET_KEY,
  libraryId = LIBRARY_ID,
  readTimeoutMs = 125,
): SupabasePaletteClient {
  return new SupabasePaletteClient({
    url: SUPABASE_URL,
    secretKey,
    libraryId,
    timeoutMs: 750,
    readTimeoutMs,
    fetcher,
  });
}

function parsedJsonBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('Expected JSON request body');
  return JSON.parse(init.body) as Record<string, unknown>;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('SupabasePaletteClient', () => {
  it('reads one current palette through the exact SHA-256 RPC', async () => {
    const updatedAt = '2026-07-22T14:15:16.000Z';
    const fetcher = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => jsonResponse({
      palette: PALETTE,
      provider_name: 'apple',
      provider_track_id: '42',
      match_confidence: 0.94,
      updated_at: updatedAt,
    }));

    await expect(makeClient(fetcher as typeof fetch).read(WRITE_INPUT.artworkKey))
      .resolves.toEqual({
        palette: PALETTE,
        providerName: 'apple',
        providerTrackId: '42',
        matchConfidence: 0.94,
        updatedAt,
      });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe(`${SUPABASE_URL}/rest/v1/rpc/read_artwork_palette`);
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(parsedJsonBody(init)).toEqual({
      p_library_id: LIBRARY_ID,
      p_artwork_key: `sha256:${createHash('sha256')
        .update(WRITE_INPUT.artworkKey)
        .digest('hex')}`,
      p_key_version: 2,
    });
  });

  it('returns undefined for an exact palette miss', async () => {
    const fetcher = vi.fn(async () => jsonResponse(null));

    await expect(makeClient(fetcher as typeof fetch).read(WRITE_INPUT.artworkKey))
      .resolves.toBeUndefined();
  });

  it('strictly rejects unexpected metadata or a malformed palette', async () => {
    const updatedAt = '2026-07-22T14:15:16.000Z';
    const unexpectedMetadata = vi.fn(async () => jsonResponse({
      palette: PALETTE,
      provider_name: 'apple',
      provider_track_id: '42',
      match_confidence: 0.94,
      updated_at: updatedAt,
      raw_metadata: { title: 'must not cross the read boundary' },
    }));
    await expect(makeClient(unexpectedMetadata as typeof fetch)
      .read(WRITE_INPUT.artworkKey)).rejects.toThrow();

    const malformedPalette = vi.fn(async () => jsonResponse({
      palette: { ...PALETTE, primary: '#lowercase' },
      provider_name: 'apple',
      provider_track_id: '42',
      match_confidence: 0.94,
      updated_at: updatedAt,
    }));
    await expect(makeClient(malformedPalette as typeof fetch)
      .read(WRITE_INPUT.artworkKey)).rejects.toThrow();
  });

  it('rejects oversized palette responses before parsing them', async () => {
    const fetcher = vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'Content-Length': String(9 * 1_024) },
    }));

    await expect(makeClient(fetcher as typeof fetch).read(WRITE_INPUT.artworkKey))
      .rejects.toThrow(/response exceeds/);
  });

  it('surfaces a non-successful palette read response', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ message: 'unavailable' }, 503));

    await expect(makeClient(fetcher as typeof fetch).read(WRITE_INPUT.artworkKey))
      .rejects.toThrow(/palette read failed: 503/);
  });

  it('writes one small palette RPC and never uploads image bytes', async () => {
    const fetcher = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(null, { status: 200 }));

    await makeClient(fetcher as typeof fetch).upsert(WRITE_INPUT);

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    const expectedArtworkKey = `sha256:${createHash('sha256')
      .update(WRITE_INPUT.artworkKey)
      .digest('hex')}`;

    expect(String(url)).toBe(`${SUPABASE_URL}/rest/v1/rpc/upsert_artwork_palette`);
    expect(String(url)).not.toContain('/storage/v1/');
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get('apikey')).toBe(SECRET_KEY);
    expect(headers.get('Authorization')).toBeNull();
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(String(init?.body)).not.toContain(SECRET_KEY);
    expect(parsedJsonBody(init)).toEqual({
      p_library_id: LIBRARY_ID,
      p_artwork_key: expectedArtworkKey,
      p_key_version: 2,
      p_palette: PALETTE,
      p_provider_name: 'apple',
      p_provider_track_id: '42',
      p_match_confidence: 0.94,
      p_raw_metadata: {
        title: TRACK.title,
        artist: TRACK.artist,
        album: TRACK.album,
        duration_ms: TRACK.durationMs,
        source: TRACK.source,
      },
    });
    expect(Buffer.byteLength(JSON.stringify(PALETTE), 'utf8')).toBeLessThan(4 * 1_024);
    expect(String(init?.body)).not.toMatch(/image|mzstatic|storage\/v1/i);
  });

  it('adds Authorization only for a legacy service-role JWT', async () => {
    const legacyKey = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signature';
    const fetcher = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(null, { status: 200 }));

    await makeClient(fetcher as typeof fetch, legacyKey).upsert(WRITE_INPUT);

    const headers = new Headers(fetcher.mock.calls[0][1]?.headers);
    expect(headers.get('apikey')).toBe(legacyKey);
    expect(headers.get('Authorization')).toBe(`Bearer ${legacyKey}`);
  });

  it('canonicalizes an uppercase library UUID', async () => {
    const fetcher = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(null, { status: 200 }));

    await makeClient(fetcher as typeof fetch, SECRET_KEY, LIBRARY_ID.toUpperCase())
      .upsert(WRITE_INPUT);

    expect(parsedJsonBody(fetcher.mock.calls[0][1])).toMatchObject({
      p_library_id: LIBRARY_ID,
    });
  });

  it('writes cached palettes without inventing provider identity details', async () => {
    const fetcher = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(null, { status: 200 }));

    await makeClient(fetcher as typeof fetch).upsert({
      track: TRACK,
      artworkKey: WRITE_INPUT.artworkKey,
      providerName: 'local-cache',
      palette: PALETTE,
    });

    expect(parsedJsonBody(fetcher.mock.calls[0][1])).toMatchObject({
      p_provider_name: 'local-cache',
      p_provider_track_id: null,
      p_match_confidence: null,
    });
  });

  it('rejects oversized metadata before making a request', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 200 }));

    await expect(makeClient(fetcher as typeof fetch).upsert({
      ...WRITE_INPUT,
      track: { ...TRACK, title: 'x'.repeat(17 * 1_024) },
    })).rejects.toThrow(/metadata exceeds/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([-0.01, 1.01, Number.NaN])(
    'rejects invalid match confidence %s before making a request',
    async (matchConfidence) => {
      const fetcher = vi.fn(async () => new Response(null, { status: 200 }));
      await expect(makeClient(fetcher as typeof fetch).upsert({
        ...WRITE_INPUT,
        matchConfidence,
      })).rejects.toThrow(/matchConfidence/);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('surfaces a non-successful palette RPC response', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 503 }));

    await expect(makeClient(fetcher as typeof fetch).upsert(WRITE_INPUT)).rejects.toThrow(
      /palette write failed: 503/,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
