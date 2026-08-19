import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ArtworkPalette, TrackMetadata } from '../shared/contracts.js';
import { config } from './config.js';

const PALETTE_KEY_VERSION = 2;
const MAX_PALETTE_RESPONSE_BYTES = 8 * 1_024;

const hexColorSchema = z.string().regex(/^#[0-9A-F]{6}$/);
const artworkSpatialFieldSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^field:[0-9a-f]{16}$/),
  columns: z.literal(6),
  rows: z.literal(4),
  base: hexColorSchema,
  colors: z.array(hexColorSchema).length(24),
});
const artworkPaletteSchema = z.discriminatedUnion('source', [
  z.strictObject({
    primary: hexColorSchema,
    secondary: hexColorSchema,
    source: z.literal('apple'),
    field: artworkSpatialFieldSchema,
  }),
  z.strictObject({
    primary: hexColorSchema,
    secondary: hexColorSchema,
    source: z.literal('fallback'),
  }),
]);
const paletteReadResponseSchema = z.strictObject({
  palette: artworkPaletteSchema,
  provider_name: z.enum(['apple', 'local-cache']).nullable(),
  provider_track_id: z.string().min(1).max(512).nullable(),
  match_confidence: z.number().min(0).max(1).nullable(),
  updated_at: z.string().datetime({ offset: true }),
}).nullable();

export interface PaletteWriteInput {
  track: TrackMetadata;
  artworkKey: string;
  providerName: 'apple' | 'local-cache';
  providerTrackId?: number;
  matchConfidence?: number;
  palette: ArtworkPalette;
}

export interface PaletteReadResult {
  palette: ArtworkPalette;
  providerName?: 'apple' | 'local-cache';
  providerTrackId?: string;
  matchConfidence?: number;
  updatedAt: string;
}

export interface PaletteReader {
  read(artworkKey: string): Promise<PaletteReadResult | undefined>;
}

export interface PaletteWriter {
  upsert(input: PaletteWriteInput): Promise<void>;
}

/**
 * Keep read optional so local/test write-only sinks remain valid. The real
 * Supabase implementation provides both capabilities.
 */
export interface PaletteStore extends PaletteWriter {
  read?: PaletteReader['read'];
}

interface SupabasePaletteClientOptions {
  url: string;
  secretKey: string;
  libraryId: string;
  timeoutMs: number;
  readTimeoutMs?: number;
  fetcher?: typeof fetch;
}

export class SupabasePaletteClient implements PaletteReader, PaletteWriter {
  private readonly baseUrl: URL;
  private readonly fetcher: typeof fetch;
  private readonly libraryId: string;

  constructor(private readonly options: SupabasePaletteClientOptions) {
    this.baseUrl = new URL(options.url);
    if (!['http:', 'https:'].includes(this.baseUrl.protocol)) {
      throw new Error('SUPABASE_URL must use HTTP or HTTPS');
    }
    this.libraryId = z.string().uuid().parse(options.libraryId).toLowerCase();
    if (!options.secretKey) throw new Error('SUPABASE_SECRET_KEY is required');
    this.fetcher = options.fetcher ?? fetch;
  }

  async read(artworkKey: string): Promise<PaletteReadResult | undefined> {
    const response = await this.fetcher(
      new URL('/rest/v1/rpc/read_artwork_palette', this.baseUrl),
      {
        method: 'POST',
        headers: {
          ...this.authHeaders(),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          p_library_id: this.libraryId,
          p_artwork_key: hashedArtworkKey(artworkKey),
          p_key_version: PALETTE_KEY_VERSION,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(
          this.options.readTimeoutMs ?? this.options.timeoutMs,
        ),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Supabase palette read failed: ${response.status}`);
    }

    const raw = await readBoundedJson(response, MAX_PALETTE_RESPONSE_BYTES);
    const parsed = paletteReadResponseSchema.parse(raw);
    if (parsed === null) return undefined;
    return {
      palette: parsed.palette,
      ...(parsed.provider_name === null
        ? {}
        : { providerName: parsed.provider_name }),
      ...(parsed.provider_track_id === null
        ? {}
        : { providerTrackId: parsed.provider_track_id }),
      ...(parsed.match_confidence === null
        ? {}
        : { matchConfidence: parsed.match_confidence }),
      updatedAt: parsed.updated_at,
    };
  }

  async upsert(input: PaletteWriteInput): Promise<void> {
    if (
      input.providerTrackId !== undefined &&
      (!Number.isSafeInteger(input.providerTrackId) || input.providerTrackId < 0)
    ) {
      throw new Error('Palette providerTrackId must be a non-negative safe integer');
    }
    if (
      input.matchConfidence !== undefined &&
      (!Number.isFinite(input.matchConfidence) || input.matchConfidence < 0 || input.matchConfidence > 1)
    ) {
      throw new Error('Palette matchConfidence must be between 0 and 1');
    }
    if (Buffer.byteLength(input.artworkKey, 'utf8') > 16 * 1_024) {
      throw new Error('Palette lookup key exceeds the local size limit');
    }
    const artworkKey = hashedArtworkKey(input.artworkKey);
    const rawMetadata = {
      title: input.track.title,
      artist: input.track.artist,
      album: input.track.album,
      duration_ms: input.track.durationMs,
      source: input.track.source,
    };
    if (Buffer.byteLength(JSON.stringify(rawMetadata), 'utf8') > 16 * 1_024) {
      throw new Error('Palette raw metadata exceeds the RPC size limit');
    }
    if (Buffer.byteLength(JSON.stringify(input.palette), 'utf8') > 4 * 1_024) {
      throw new Error('Palette payload exceeds the RPC size limit');
    }

    const response = await this.fetcher(
      new URL('/rest/v1/rpc/upsert_artwork_palette', this.baseUrl),
      {
        method: 'POST',
        headers: {
          ...this.authHeaders(),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          p_library_id: this.libraryId,
          p_artwork_key: artworkKey,
          p_key_version: PALETTE_KEY_VERSION,
          p_palette: input.palette,
          p_provider_name: input.providerName,
          p_provider_track_id: input.providerTrackId === undefined
            ? null
            : String(input.providerTrackId),
          p_match_confidence: input.matchConfidence ?? null,
          p_raw_metadata: rawMetadata,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(this.options.timeoutMs),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Supabase palette write failed: ${response.status}`);
    }
    await response.body?.cancel();
  }

  private authHeaders(): Record<string, string> {
    return {
      apikey: this.options.secretKey,
      ...(isLegacyJwtKey(this.options.secretKey)
        ? { Authorization: `Bearer ${this.options.secretKey}` }
        : {}),
    };
  }
}

export function createSupabasePaletteStore(): PaletteStore | undefined {
  if (config.supabase.paletteMode === 'off') return undefined;
  const client = new SupabasePaletteClient({
    url: config.supabase.url,
    secretKey: config.supabase.secretKey,
    libraryId: config.supabase.libraryId,
    timeoutMs: config.supabase.writeTimeoutMs,
    readTimeoutMs: config.supabase.paletteReadTimeoutMs,
  });
  if (config.supabase.paletteMode === 'shadow') {
    return { upsert: (input) => client.upsert(input) };
  }
  return client;
}

function hashedArtworkKey(value: string): string {
  if (Buffer.byteLength(value, 'utf8') > 16 * 1_024) {
    throw new Error('Palette lookup key exceeds the local size limit');
  }
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

async function readBoundedJson(response: Response, limit: number): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    await response.body?.cancel();
    throw new Error('Supabase palette response exceeds the local size limit');
  }
  if (!response.body) throw new Error('Supabase palette response is empty');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error('Supabase palette response exceeds the local size limit');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error('Supabase palette response is invalid JSON');
  }
}

function isLegacyJwtKey(value: string): boolean {
  const segments = value.split('.');
  return segments.length === 3 && segments.every(Boolean);
}
