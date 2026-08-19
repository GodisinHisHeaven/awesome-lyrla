import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';
import { z } from 'zod';
import type {
  ArtworkLookupFailureReason,
  ArtworkLookupStage,
  ArtworkLookupStatus,
  ArtworkPalette,
  ArtworkSpatialField,
  TrackMetadata,
} from '../shared/contracts.js';
import {
  metadataSimilarity,
  metadataVersionSignature,
  metadataVersionMismatch,
  normalizeMetadata,
  trackMatchScore,
} from '../shared/track.js';
import { config } from './config.js';
import { FixedDurationHistogram, type DurationStats } from './runtime-performance.js';
import type {
  CachedArtworkFailureReason,
  CachedArtworkPalette,
  StateStore,
} from './store.js';
import {
  createSupabasePaletteStore,
  type PaletteReadResult,
  type PaletteStore,
  type PaletteWriteInput,
} from './supabase-palette-client.js';

const appleSearchSchema = z.object({
  resultCount: z.number(),
  results: z.array(z.object({
    trackId: z.number(),
    trackName: z.string(),
    artistName: z.string(),
    collectionName: z.string().optional().default(''),
    trackTimeMillis: z.number().optional().default(0),
    artworkUrl100: z.string().url().optional(),
  })),
});

const hexColorSchema = z.string().regex(/^#[0-9A-F]{6}$/);
const artworkSpatialFieldSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^field:[0-9a-f]{16}$/),
  columns: z.literal(6),
  rows: z.literal(4),
  base: hexColorSchema,
  colors: z.array(hexColorSchema).length(24),
});
const artworkPaletteSchema = z.discriminatedUnion('source', [
  z.object({
    primary: hexColorSchema,
    secondary: hexColorSchema,
    source: z.literal('apple'),
    field: artworkSpatialFieldSchema,
  }),
  z.object({
    primary: hexColorSchema,
    secondary: hexColorSchema,
    source: z.literal('fallback'),
  }),
]);

type RawAppleCandidate = z.infer<typeof appleSearchSchema>['results'][number];
type AppleCandidate = RawAppleCandidate & { artworkUrl100: string };
type AppleCandidateMatch = {
  candidate: AppleCandidate;
  score: number;
  selectionScore: number;
  stage: ArtworkLookupStage;
};
type SearchPlan = {
  stage: ArtworkLookupStage;
  storefront: string;
  term: string;
};
type MatchRejectionReason = Extract<
  ArtworkLookupFailureReason,
  | 'catalog-version-mismatch'
  | 'catalog-album-mismatch'
  | 'catalog-low-confidence'
>;
type SearchSummary = {
  matches: AppleCandidateMatch[];
  rawResults: number;
  withArtwork: number;
  rejected: Record<MatchRejectionReason, number>;
};
export interface ArtworkLookupResult {
  palette: ArtworkPalette;
  status: Exclude<ArtworkLookupStatus, { state: 'idle' | 'loading' }>;
}
export interface ArtworkLookupSuccessResult {
  palette: ArtworkPalette;
  status: Extract<ArtworkLookupStatus, { state: 'success' }>;
}
type Rgb = { r: number; g: number; b: number };
type Hsl = { h: number; s: number; l: number };
type ColorBucket = Rgb & { weight: number; score: number; count: number };
type ArtworkContentType = 'image/jpeg' | 'image/png' | 'image/webp';

const POSITIVE_CACHE_MS = 30 * 24 * 60 * 60 * 1_000;
const NEGATIVE_CACHE_MS = 6 * 60 * 60 * 1_000;
const SEARCH_WINDOW_MS = 60_000;
const SEARCHES_PER_WINDOW = 18;
const SEARCH_BODY_LIMIT = 512 * 1_024;
const ARTWORK_BODY_LIMIT = 2 * 1_024 * 1_024;
const ARTWORK_CACHE_MAX_ENTRIES = 500;
// The web machine has one shared CPU. One cold extraction at a time avoids
// competing Sharp/JS analysis and bounds memory while stale work is cancelled.
const ARTWORK_LOOKUP_CONCURRENCY = 1;
const SPATIAL_FIELD_COLUMNS = 6;
const SPATIAL_FIELD_ROWS = 4;
const SPATIAL_FIELD_CELL_SIZE = 16;
const SPATIAL_SAMPLE_WIDTH = SPATIAL_FIELD_COLUMNS * SPATIAL_FIELD_CELL_SIZE;
const SPATIAL_SAMPLE_HEIGHT = SPATIAL_FIELD_ROWS * SPATIAL_FIELD_CELL_SIZE;
const SPATIAL_SAMPLE_SIGMA = 13;
const PALETTE_WRITE_CONCURRENCY = 1;
const PALETTE_WRITE_QUEUE_MAX_ENTRIES = 100;
const LOOKUP_STRATEGY = 'multistage-v1';
const SEARCH_PLAN_LIMIT = 4;
const AMBIGUOUS_SCORE_GAP = 0.05;
const AMBIGUOUS_CACHE_MS = 60 * 60 * 1_000;
const LOOKUP_BUDGET_MS = 15_000;
const SEARCH_REQUEST_TIMEOUT_MS = 4_000;
const ARTWORK_REQUEST_TIMEOUT_MS = 8_000;
const SUPABASE_HEDGE_DELAY_MS = 125;
const REMOTE_PALETTE_OUTCOME_CACHE_MS = 2_000;
const REMOTE_PALETTE_OUTCOME_CACHE_LIMIT = 32;
const ARTWORK_LOOKUP_STAGES: ArtworkLookupStage[] = [
  'primary-full',
  'primary-core',
  'fallback-core',
];
const ARTWORK_FAILURE_REASONS: ArtworkLookupFailureReason[] = [
  'insufficient-metadata',
  'catalog-empty',
  'catalog-missing-artwork',
  'catalog-version-mismatch',
  'catalog-album-mismatch',
  'catalog-low-confidence',
  'no-reliable-match',
  'ambiguous-candidate',
  'local-rate-limit',
  'catalog-rate-limit',
  'catalog-timeout',
  'catalog-network',
  'catalog-http-client',
  'catalog-http-server',
  'catalog-invalid-response',
  'artwork-url-rejected',
  'artwork-timeout',
  'artwork-network',
  'artwork-rate-limit',
  'artwork-http-client',
  'artwork-http-server',
  'artwork-invalid-response',
  'unknown',
];

const ARTWORK_DURATION_PHASES = [
  'local',
  'supabase',
  'queue',
  'catalog',
  'download',
  'analyze',
  'persist',
  'resolution',
  'delivery',
  'total',
] as const;
type ArtworkDurationPhase = typeof ARTWORK_DURATION_PHASES[number];

export interface ArtworkLookupOptions {
  signal?: AbortSignal;
}

type LookupFailure = {
  reason: ArtworkLookupFailureReason;
  retryable: boolean;
  stage?: ArtworkLookupStage;
};
type RemotePaletteOutcome =
  | { state: 'hit'; result: PaletteReadResult }
  | { state: 'miss' }
  | { state: 'unavailable' };

function countRecord<T extends string>(keys: T[]): Record<T, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
}

function knownLookupStage(value: unknown): value is ArtworkLookupStage {
  return typeof value === 'string'
    && ARTWORK_LOOKUP_STAGES.includes(value as ArtworkLookupStage);
}

function knownCachedFailureReason(value: unknown): value is CachedArtworkFailureReason {
  return [
    'catalog-empty',
    'catalog-missing-artwork',
    'catalog-version-mismatch',
    'catalog-album-mismatch',
    'catalog-low-confidence',
    'no-reliable-match',
    'ambiguous-candidate',
  ].includes(value as CachedArtworkFailureReason);
}

function timeoutError(): Error {
  const error = new Error('lookup_timeout');
  error.name = 'TimeoutError';
  return error;
}

function cancellationError(): Error {
  const error = new Error('lookup_canceled');
  error.name = 'AbortError';
  return error;
}

function throwIfCanceled(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancellationError();
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

function isCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError' && error.message === 'lookup_canceled';
}

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : '';
}

function catalogFailure(error: unknown, stage: ArtworkLookupStage): LookupFailure {
  const code = errorCode(error);
  if (isTimeout(error)) return { reason: 'catalog-timeout', retryable: true, stage };
  if (code === 'catalog_http_429') return { reason: 'catalog-rate-limit', retryable: true, stage };
  if (code === 'catalog_http_408') return { reason: 'catalog-timeout', retryable: true, stage };
  if (/^catalog_http_4\d\d$/.test(code)) {
    return { reason: 'catalog-http-client', retryable: false, stage };
  }
  if (/^catalog_http_5\d\d$/.test(code)) {
    return { reason: 'catalog-http-server', retryable: true, stage };
  }
  if (code === 'catalog_invalid_response' || code === 'response_too_large') {
    return { reason: 'catalog-invalid-response', retryable: true, stage };
  }
  if (error instanceof TypeError) return { reason: 'catalog-network', retryable: true, stage };
  return { reason: 'unknown', retryable: true, stage };
}

function artworkFailure(error: unknown, stage: ArtworkLookupStage): LookupFailure {
  const code = errorCode(error);
  if (isTimeout(error)) return { reason: 'artwork-timeout', retryable: true, stage };
  if (code === 'untrusted_artwork_url') {
    return { reason: 'artwork-url-rejected', retryable: false, stage };
  }
  if (code === 'artwork_http_429') {
    return { reason: 'artwork-rate-limit', retryable: true, stage };
  }
  if (code === 'artwork_http_408') {
    return { reason: 'artwork-timeout', retryable: true, stage };
  }
  if (/^artwork_http_4\d\d$/.test(code)) {
    return { reason: 'artwork-http-client', retryable: false, stage };
  }
  if (/^artwork_http_5\d\d$/.test(code)) {
    return { reason: 'artwork-http-server', retryable: true, stage };
  }
  if (
    code === 'response_too_large'
    || code === 'unsupported_artwork_type'
    || code === 'unsupported_artwork_channels'
    || code === 'artwork_type_mismatch'
  ) {
    return { reason: 'artwork-invalid-response', retryable: false, stage };
  }
  if (error instanceof TypeError) return { reason: 'artwork-network', retryable: true, stage };
  return { reason: 'artwork-invalid-response', retryable: false, stage };
}

function safeFallbackLog(failure: LookupFailure): void {
  console.warn('Artwork palette fallback', {
    reason: failure.reason,
    retryable: failure.retryable,
    stage: failure.stage ?? null,
    strategy: LOOKUP_STRATEGY,
  });
}

function clipped(value: string): string {
  return Array.from(value).slice(0, 200).join('');
}

function rgbDistance(left: Rgb, right: Rgb): number {
  return Math.hypot(left.r - right.r, left.g - right.g, left.b - right.b);
}

function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  const lightness = (maximum + minimum) / 2;
  if (delta === 0) return { h: 0, s: 0, l: lightness };
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue = 0;
  if (maximum === red) hue = 60 * (((green - blue) / delta) % 6);
  else if (maximum === green) hue = 60 * ((blue - red) / delta + 2);
  else hue = 60 * ((red - green) / delta + 4);
  return { h: (hue + 360) % 360, s: saturation, l: lightness };
}

function hslToRgb({ h, s, l }: Hsl): Rgb {
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const segment = h / 60;
  const x = chroma * (1 - Math.abs((segment % 2) - 1));
  let partial: [number, number, number];
  if (segment < 1) partial = [chroma, x, 0];
  else if (segment < 2) partial = [x, chroma, 0];
  else if (segment < 3) partial = [0, chroma, x];
  else if (segment < 4) partial = [0, x, chroma];
  else if (segment < 5) partial = [x, 0, chroma];
  else partial = [chroma, 0, x];
  const match = l - chroma / 2;
  return {
    r: Math.round((partial[0] + match) * 255),
    g: Math.round((partial[1] + match) * 255),
    b: Math.round((partial[2] + match) * 255),
  };
}

function ambientColor(color: Rgb, neutralArtwork = false): Rgb {
  const hsl = rgbToHsl(color);
  if (neutralArtwork) {
    return hslToRgb({ h: 0, s: 0, l: Math.max(0.24, Math.min(0.62, hsl.l)) });
  }
  return hslToRgb({
    h: hsl.h,
    s: hsl.s < 0.06 ? 0 : Math.min(0.82, hsl.s * 1.05),
    l: Math.max(0.24, Math.min(0.6, hsl.l)),
  });
}

function derivedSecondary(primary: Rgb, neutralArtwork = false): Rgb {
  const hsl = rgbToHsl(primary);
  if (neutralArtwork || hsl.s < 0.08) {
    return hslToRgb({ h: 0, s: 0, l: hsl.l > 0.46 ? hsl.l - 0.16 : hsl.l + 0.16 });
  }
  return hslToRgb({ h: (hsl.h + 42) % 360, s: hsl.s, l: Math.max(0.3, Math.min(0.58, hsl.l + 0.04)) });
}

function toHex(color: Rgb): string {
  return `#${[color.r, color.g, color.b]
    .map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0'))
    .join('')}`.toUpperCase();
}

function srgbToLinear(channel: number): number {
  const value = Math.max(0, Math.min(255, channel)) / 255;
  return value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(channel: number): number {
  const value = Math.max(0, Math.min(1, channel));
  const encoded = value <= 0.0031308
    ? value * 12.92
    : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.round(encoded * 255);
}

function spatialColor(color: Rgb, neutralArtwork: boolean): Rgb {
  const hsl = rgbToHsl(color);
  if (neutralArtwork) {
    return hslToRgb({ h: 0, s: 0, l: Math.max(0.1, Math.min(0.7, hsl.l)) });
  }
  return hslToRgb({
    h: hsl.h,
    s: Math.min(0.78, hsl.s),
    l: Math.max(0.1, Math.min(0.7, hsl.l)),
  });
}

function spatialField(
  data: Buffer,
  channels: number,
  neutralArtwork: boolean,
): ArtworkSpatialField {
  const colors: string[] = [];
  const fieldLinearTotal = { r: 0, g: 0, b: 0 };
  for (let row = 0; row < SPATIAL_FIELD_ROWS; row += 1) {
    for (let column = 0; column < SPATIAL_FIELD_COLUMNS; column += 1) {
      const linearTotal = { r: 0, g: 0, b: 0 };
      let weightTotal = 0;
      const centerX = (column + 0.5) * SPATIAL_FIELD_CELL_SIZE - 0.5;
      const centerY = (row + 0.5) * SPATIAL_FIELD_CELL_SIZE - 0.5;
      for (let y = 0; y < SPATIAL_SAMPLE_HEIGHT; y += 1) {
        for (let x = 0; x < SPATIAL_SAMPLE_WIDTH; x += 1) {
          const dx = (x - centerX) / SPATIAL_SAMPLE_SIGMA;
          const dy = (y - centerY) / SPATIAL_SAMPLE_SIGMA;
          const weight = Math.exp(-0.5 * (dx * dx + dy * dy));
          const offset = (y * SPATIAL_SAMPLE_WIDTH + x) * channels;
          linearTotal.r += srgbToLinear(data[offset]) * weight;
          linearTotal.g += srgbToLinear(data[offset + 1]) * weight;
          linearTotal.b += srgbToLinear(data[offset + 2]) * weight;
          weightTotal += weight;
        }
      }
      const toneMapped = spatialColor({
        r: linearToSrgb(linearTotal.r / weightTotal),
        g: linearToSrgb(linearTotal.g / weightTotal),
        b: linearToSrgb(linearTotal.b / weightTotal),
      }, neutralArtwork);
      colors.push(toHex(toneMapped));
      fieldLinearTotal.r += srgbToLinear(toneMapped.r);
      fieldLinearTotal.g += srgbToLinear(toneMapped.g);
      fieldLinearTotal.b += srgbToLinear(toneMapped.b);
    }
  }
  const cellCount = SPATIAL_FIELD_COLUMNS * SPATIAL_FIELD_ROWS;
  const average = {
    r: linearToSrgb(fieldLinearTotal.r / cellCount),
    g: linearToSrgb(fieldLinearTotal.g / cellCount),
    b: linearToSrgb(fieldLinearTotal.b / cellCount),
  };
  const averageHsl = rgbToHsl(average);
  const base = toHex(hslToRgb({
    h: averageHsl.h,
    s: Math.min(0.55, averageHsl.s),
    l: Math.max(0.09, Math.min(0.28, averageHsl.l * 0.58)),
  }));
  const id = `field:${createHash('sha256')
    .update(`organic-gaussian-v2:${base}:${colors.join(',')}`)
    .digest('hex')
    .slice(0, 16)}`;
  return artworkSpatialFieldSchema.parse({
    schemaVersion: 1,
    id,
    columns: SPATIAL_FIELD_COLUMNS,
    rows: SPATIAL_FIELD_ROWS,
    base,
    colors,
  });
}

export function artworkFingerprint(track: TrackMetadata): string {
  const durationBucket = Math.round(track.durationMs / 2_000) * 2;
  return [
    'v5',
    normalizeMetadata(track.title),
    normalizeMetadata(track.artist),
    normalizeMetadata(track.album),
    durationBucket,
    metadataVersionSignature(`${track.title} ${track.album}`),
  ].join('::');
}

export function fallbackArtworkPalette(_track: TrackMetadata): ArtworkPalette {
  return {
    primary: '#3B3E45',
    secondary: '#191C22',
    source: 'fallback',
  };
}

async function readLimitedBody(response: Response, limit: number): Promise<Buffer> {
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > limit) {
    await response.body?.cancel();
    throw new Error('response_too_large');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error('response_too_large');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}

interface ArtworkAnalysis {
  palette: ArtworkPalette;
  contentType: ArtworkContentType;
}

async function analyzeArtwork(image: Buffer): Promise<ArtworkAnalysis> {
  const pipeline = sharp(image, { failOn: 'error', limitInputPixels: 1_000_000 });
  const metadata = await pipeline.metadata();
  const contentType = metadata.format === 'jpeg'
    ? 'image/jpeg'
    : metadata.format === 'png'
      ? 'image/png'
      : metadata.format === 'webp'
        ? 'image/webp'
        : null;
  if (!contentType) throw new Error('unsupported_artwork_type');
  const { data, info } = await pipeline
    .rotate()
    .toColourspace('srgb')
    .flatten({ background: { r: 7, g: 9, b: 14 } })
    .resize(SPATIAL_SAMPLE_WIDTH, SPATIAL_SAMPLE_HEIGHT, {
      fit: 'cover',
      position: 'centre',
      kernel: sharp.kernel.lanczos3,
    })
    .blur(2.4)
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels < 3) throw new Error('unsupported_artwork_channels');

  const buckets = new Map<string, ColorBucket>();
  let usablePixels = 0;
  let saturationTotal = 0;
  let chromaticPixels = 0;
  const average = { r: 0, g: 0, b: 0 };
  let totalPixels = 0;
  for (let index = 0; index < data.length; index += info.channels) {
    const color = { r: data[index], g: data[index + 1], b: data[index + 2] };
    average.r += color.r;
    average.g += color.g;
    average.b += color.b;
    totalPixels += 1;
    const hsl = rgbToHsl(color);
    if (hsl.l < 0.045 || hsl.l > 0.955) continue;
    usablePixels += 1;
    saturationTotal += hsl.s;
    if (hsl.s >= 0.16) chromaticPixels += 1;
    const key = `${color.r >> 5}:${color.g >> 5}:${color.b >> 5}`;
    const weight = 1 + hsl.s * 0.45;
    const score = weight * (1 - Math.abs(hsl.l - 0.5) * 0.35);
    const bucket = buckets.get(key) ?? { r: 0, g: 0, b: 0, weight: 0, score: 0, count: 0 };
    bucket.r += color.r * weight;
    bucket.g += color.g * weight;
    bucket.b += color.b * weight;
    bucket.weight += weight;
    bucket.score += score;
    bucket.count += 1;
    buckets.set(key, bucket);
  }

  const neutralArtwork = usablePixels === 0 || (
    saturationTotal / usablePixels < 0.1
    && chromaticPixels / usablePixels < 0.12
  );
  const ranked = [...buckets.values()]
    .map((bucket) => ({
      r: bucket.r / bucket.weight,
      g: bucket.g / bucket.weight,
      b: bucket.b / bucket.weight,
      weight: bucket.weight,
      score: bucket.score,
      count: bucket.count,
    }))
    .sort((left, right) => neutralArtwork
      ? right.count - left.count
      : right.score - left.score);
  const rawPrimary = ranked[0] ?? {
    r: totalPixels ? average.r / totalPixels : 54,
    g: totalPixels ? average.g / totalPixels : 54,
    b: totalPixels ? average.b / totalPixels : 54,
  };
  const primary = ambientColor(rawPrimary, neutralArtwork);
  const secondaryCandidate = ranked
    .slice(1)
    .map((candidate) => ({
      candidate,
      rank: (neutralArtwork ? candidate.count : candidate.score)
        * (0.35 + rgbDistance(rawPrimary, candidate) / 220),
    }))
    .sort((left, right) => right.rank - left.rank)[0]?.candidate;
  let secondary = secondaryCandidate
    ? ambientColor(secondaryCandidate, neutralArtwork)
    : derivedSecondary(primary, neutralArtwork);
  if (rgbDistance(primary, secondary) < 54) secondary = derivedSecondary(primary, neutralArtwork);
  return {
    contentType,
    palette: artworkPaletteSchema.parse({
      primary: toHex(primary),
      secondary: toHex(secondary),
      source: 'apple',
      field: spatialField(data, info.channels, neutralArtwork),
    }),
  };
}

export async function extractArtworkPalette(image: Buffer): Promise<ArtworkPalette> {
  return (await analyzeArtwork(image)).palette;
}

function trustedArtworkUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !(url.hostname === 'mzstatic.com' || url.hostname.endsWith('.mzstatic.com')) ||
    !url.pathname.startsWith('/image/')
  ) {
    throw new Error('untrusted_artwork_url');
  }
  return url;
}

function artworkAssetKey(value: string): string {
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\/\d+x\d+(?:bb)?\.(?:jpe?g|png|webp)$/i, '/{size}');
    return url.hostname === 'mzstatic.com' || url.hostname.endsWith('.mzstatic.com')
      ? path
      : `${url.origin}${path}`;
  } catch {
    return 'invalid-artwork-url';
  }
}

function candidateEvidence(track: TrackMetadata, candidate: AppleCandidate) {
  const title = metadataSimilarity(track.title, candidate.trackName);
  const artist = metadataSimilarity(track.artist, candidate.artistName);
  const album = track.album ? metadataSimilarity(track.album, candidate.collectionName) : 0;
  const durationDifference = track.durationMs > 0
    ? Math.abs(track.durationMs - candidate.trackTimeMillis) / 1_000
    : Number.POSITIVE_INFINITY;
  return { title, artist, album, durationDifference };
}

function candidateRejection(
  track: TrackMetadata,
  candidate: AppleCandidate,
  score: number,
): MatchRejectionReason | null {
  const { title, artist, album, durationDifference } = candidateEvidence(track, candidate);
  if (metadataVersionMismatch(
    `${track.title} ${track.album}`,
    `${candidate.trackName} ${candidate.collectionName}`,
  )) return 'catalog-version-mismatch';
  const releaseMatches = normalizeMetadata(track.album)
    ? album >= 0.68
    : track.durationMs <= 0 || durationDifference <= 12;
  if (!releaseMatches) return 'catalog-album-mismatch';
  if (normalizeMetadata(track.artist)) {
    return score >= 0.72 && title >= 0.78 && artist >= 0.64
      ? null
      : 'catalog-low-confidence';
  }
  if (
    !normalizeMetadata(track.album)
    || album < 0.75
    || (track.durationMs > 0 && durationDifference > 8)
  ) {
    return 'catalog-album-mismatch';
  }
  return score >= 0.82 && title >= 0.92
    ? null
    : 'catalog-low-confidence';
}

function candidateSelectionScore(track: TrackMetadata, candidate: AppleCandidate): number {
  const { title, artist, album, durationDifference } = candidateEvidence(track, candidate);
  const signals = [{ value: title, weight: 0.4 }];
  if (normalizeMetadata(track.artist)) signals.push({ value: artist, weight: 0.25 });
  if (normalizeMetadata(track.album)) signals.push({ value: album, weight: 0.2 });
  if (track.durationMs > 0 && candidate.trackTimeMillis > 0) {
    signals.push({ value: Math.max(0, 1 - durationDifference / 12), weight: 0.15 });
  }
  const weight = signals.reduce((total, signal) => total + signal.weight, 0);
  return signals.reduce((total, signal) => total + signal.value * signal.weight, 0) / weight;
}

function candidateStrong(track: TrackMetadata, match: AppleCandidateMatch): boolean {
  const { title, artist, album, durationDifference } = candidateEvidence(track, match.candidate);
  const hasArtist = Boolean(normalizeMetadata(track.artist));
  const hasAlbum = Boolean(normalizeMetadata(track.album));
  return match.score >= 0.88
    && title >= 0.96
    && (hasArtist ? artist >= 0.9 : hasAlbum && album >= 0.9)
    && (!hasAlbum || album >= 0.9)
    && (track.durationMs <= 0 || durationDifference <= 5);
}

function searchPlans(track: TrackMetadata): SearchPlan[] {
  const primary = /^[A-Z]{2}$/.test(config.artwork.appleStorefront)
    ? config.artwork.appleStorefront
    : 'US';
  const fullTerm = clipped([track.title, track.artist, track.album].filter(Boolean).join(' '));
  const coreTerm = clipped([
    track.title,
    normalizeMetadata(track.artist) ? track.artist : track.album,
  ].filter(Boolean).join(' '));
  const candidates: SearchPlan[] = [
    { stage: 'primary-full', storefront: primary, term: fullTerm },
    { stage: 'primary-core', storefront: primary, term: coreTerm },
    ...config.artwork.appleFallbackStorefronts
      .filter((storefront) => storefront !== primary)
      .slice(0, 2)
      .map((storefront): SearchPlan => ({
        stage: 'fallback-core',
        storefront,
        term: coreTerm,
      })),
  ];
  const seen = new Set<string>();
  return candidates.filter((plan) => {
    const key = `${plan.storefront}:${normalizeMetadata(plan.term)}`;
    if (!normalizeMetadata(plan.term) || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, SEARCH_PLAN_LIMIT);
}

export class ArtworkPaletteService {
  private readonly inFlight = new Map<string, {
    promise: Promise<ArtworkLookupResult>;
    signal?: AbortSignal;
  }>();
  private readonly memoryCache = new Map<string, CachedArtworkPalette>();
  private readonly remotePaletteReads = new Map<string, Promise<RemotePaletteOutcome>>();
  private readonly recentRemotePaletteOutcomes = new Map<string, {
    expiresAt: number;
    outcome: RemotePaletteOutcome;
  }>();
  private readonly paletteWriteQueue: PaletteWriteInput[] = [];
  private readonly persistedPaletteWrites = new Set<string>();
  private readonly lookupWaiters: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];
  private readonly durations = new Map<ArtworkDurationPhase, FixedDurationHistogram>(
    ARTWORK_DURATION_PHASES.map((phase) => [phase, new FixedDurationHistogram()]),
  );
  private activeLookups = 0;
  private activePaletteWrites = 0;
  private paletteDrainScheduled = false;
  private paletteWriteSuccesses = 0;
  private paletteWriteFailures = 0;
  private paletteQueueDrops = 0;
  private lastPaletteWriteState: 'ok' | 'error' | null = null;
  private lastPaletteWriteReason: string | null = null;
  private searchTimestamps: number[] = [];
  private lookupRequests = 0;
  private lookupSuccesses = 0;
  private lookupFallbacks = 0;
  private searchRequests = 0;
  private positiveCacheHits = 0;
  private negativeCacheHits = 0;
  private supabaseCacheHits = 0;
  private supabaseReadHits = 0;
  private supabaseCacheMisses = 0;
  private supabaseUnavailable = 0;
  private cacheProbeRequests = 0;
  private cacheProbeHits = 0;
  private cacheProbeMisses = 0;
  private cacheProbeCancellations = 0;
  private cancellations = 0;
  private localPersistSuccesses = 0;
  private localPersistFailures = 0;
  private readonly stageAttempts = countRecord(ARTWORK_LOOKUP_STAGES);
  private readonly stageHits = countRecord(ARTWORK_LOOKUP_STAGES);
  private readonly attemptFailures = countRecord(ARTWORK_FAILURE_REASONS);
  private readonly fallbackReasons = countRecord(ARTWORK_FAILURE_REASONS);
  private lastLookupStatus: ArtworkLookupStatus = { state: 'idle' };

  constructor(
    private readonly store: StateStore,
    private readonly paletteStore: PaletteStore | undefined = createSupabasePaletteStore(),
  ) {}

  async find(track: TrackMetadata, options: ArtworkLookupOptions = {}): Promise<ArtworkPalette> {
    return (await this.resolve(track, options)).palette;
  }

  async resolveCached(
    track: TrackMetadata,
    options: ArtworkLookupOptions = {},
  ): Promise<ArtworkLookupSuccessResult | null> {
    throwIfCanceled(options.signal);
    this.cacheProbeRequests += 1;
    try {
      const key = artworkFingerprint(track);
      const localStartedAt = performance.now();
      const cached = this.readLocalCache(key);
      this.observeDuration('local', localStartedAt);
      if (cached?.expiresAt && cached.expiresAt > Date.now()) {
        if (
          cached.palette === null
          && cached.lookupStrategy === LOOKUP_STRATEGY
          && knownCachedFailureReason(cached.failureReason)
        ) return this.recordCacheProbeMiss();
        const parsed = artworkPaletteSchema.safeParse(cached.palette);
        if (parsed.success) {
          const stage = knownLookupStage(cached.lookupStage) ? cached.lookupStage : undefined;
          this.persistPaletteInBackground({
            track,
            artworkKey: key,
            providerName: 'local-cache',
            palette: parsed.data,
          });
          const status: Extract<ArtworkLookupStatus, { state: 'success' }> = {
            state: 'success',
            source: 'positive-cache',
            ...(stage ? { stage } : {}),
          };
          this.positiveCacheHits += 1;
          this.recordResult(status);
          return this.recordCacheProbeHit({ palette: parsed.data, status });
        }
      }
      if (!this.paletteStore?.read) return this.recordCacheProbeMiss();

      const remote = await this.awaitWithSignal(
        this.readRemotePaletteShared(key),
        options.signal,
      );
      throwIfCanceled(options.signal);
      if (remote.state !== 'hit') return this.recordCacheProbeMiss();
      return this.recordCacheProbeHit(this.remotePaletteResult(key, remote.result));
    } catch (error) {
      if (isCancellation(error) || options.signal?.aborted) {
        this.cacheProbeCancellations += 1;
      }
      throw error;
    }
  }

  recordDeliveryDuration(durationMs: number): void {
    this.durations.get('delivery')?.observe(durationMs);
  }

  recordResolutionDuration(durationMs: number): void {
    this.durations.get('resolution')?.observe(durationMs);
  }

  async resolve(
    track: TrackMetadata,
    options: ArtworkLookupOptions = {},
  ): Promise<ArtworkLookupResult> {
    const startedAt = performance.now();
    try {
      return await this.resolveInternal(track, options.signal);
    } catch (error) {
      if (isCancellation(error) || options.signal?.aborted) {
        this.cancellations += 1;
        throw cancellationError();
      }
      const failure: LookupFailure = isTimeout(error)
        ? { reason: 'catalog-timeout', retryable: true }
        : { reason: 'unknown', retryable: true };
      this.recordAttemptFailure(failure);
      return this.fallbackResult(track, failure);
    } finally {
      this.observeDuration('total', startedAt);
    }
  }

  private async resolveInternal(
    track: TrackMetadata,
    signal?: AbortSignal,
  ): Promise<ArtworkLookupResult> {
    throwIfCanceled(signal);
    const key = artworkFingerprint(track);
    const localStartedAt = performance.now();
    const cached = this.readLocalCache(key);
    this.observeDuration('local', localStartedAt);
    if (cached && cached.expiresAt > Date.now()) {
      if (
        cached.palette === null
        && cached.lookupStrategy === LOOKUP_STRATEGY
        && knownCachedFailureReason(cached.failureReason)
      ) {
        const stage = knownLookupStage(cached.lookupStage) ? cached.lookupStage : undefined;
        const status: ArtworkLookupStatus = {
          state: 'fallback',
          reason: cached.failureReason,
          retryable: false,
          cache: 'negative-hit',
          ...(stage ? { stage } : {}),
        };
        const result = { palette: fallbackArtworkPalette(track), status };
        this.negativeCacheHits += 1;
        this.recordResult(status);
        return result;
      }
      const parsed = artworkPaletteSchema.safeParse(cached.palette);
      if (parsed.success) {
        const stage = knownLookupStage(cached.lookupStage) ? cached.lookupStage : undefined;
        this.persistPaletteInBackground({
          track,
          artworkKey: key,
          providerName: 'local-cache',
          palette: parsed.data,
        });
        const status: ArtworkLookupStatus = {
          state: 'success',
          source: 'positive-cache',
          ...(stage ? { stage } : {}),
        };
        const result = { palette: parsed.data, status };
        this.positiveCacheHits += 1;
        this.recordResult(status);
        return result;
      }
    }
    const existing = this.inFlight.get(key);
    if (
      existing
      && !existing.signal?.aborted
      && (!existing.signal || existing.signal === signal)
    ) {
      return this.awaitWithSignal(existing.promise, signal);
    }
    const deadline = Date.now() + LOOKUP_BUDGET_MS;
    let request!: Promise<ArtworkLookupResult>;
    request = this.resolveCacheMiss(track, key, deadline, signal)
      .catch((error) => {
        if (isCancellation(error) || signal?.aborted) throw cancellationError();
        const failure: LookupFailure = isTimeout(error)
          ? { reason: 'catalog-timeout', retryable: true }
          : { reason: 'unknown', retryable: true };
        this.recordAttemptFailure(failure);
        return this.fallbackResult(track, failure);
      })
      .finally(() => {
        if (this.inFlight.get(key)?.promise === request) this.inFlight.delete(key);
      });
    this.inFlight.set(key, { promise: request, signal });
    return request;
  }

  private awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    throwIfCanceled(signal);
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(cancellationError());
      signal.addEventListener('abort', onAbort, { once: true });
      void promise.then(resolve, reject).finally(() => {
        signal.removeEventListener('abort', onAbort);
      });
    });
  }

  private readLocalCache(key: string): CachedArtworkPalette | undefined {
    const memory = this.memoryCache.get(key);
    if (memory) {
      if (memory.expiresAt <= Date.now()) {
        this.memoryCache.delete(key);
      } else {
        this.rememberMemoryCache(key, memory);
        return structuredClone(memory);
      }
    }

    const cached = this.store.readArtworkPalette(key);
    if (cached?.expiresAt && cached.expiresAt > Date.now()) {
      this.rememberMemoryCache(key, cached);
      return cached;
    }
    return undefined;
  }

  private async resolveCacheMiss(
    track: TrackMetadata,
    key: string,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<ArtworkLookupResult> {
    const startAppleLookup = (lookupSignal = signal) => this.withLookupSlot(
      () => this.lookup(track, key, deadline, lookupSignal),
      deadline,
      lookupSignal,
    );
    if (!this.paletteStore?.read) return startAppleLookup();

    const remote = this.readRemotePaletteShared(key);
    const early = await Promise.race([
      remote,
      delay(SUPABASE_HEDGE_DELAY_MS).then(() => null),
    ]);
    throwIfCanceled(signal);
    if (early !== null) {
      return early.state === 'hit'
        ? this.remotePaletteResult(key, early.result)
        : startAppleLookup();
    }

    // Do not add the full Supabase timeout to Apple latency. Start Apple after
    // a short head start, then use whichever valid result arrives first.
    const appleAbort = new AbortController();
    const appleSignal = signal
      ? AbortSignal.any([signal, appleAbort.signal])
      : appleAbort.signal;
    const apple = startAppleLookup(appleSignal);
    const appleOutcome = apple.then((result) => ({
      result,
      successful: result.status.state === 'success',
    }));
    const appleSuccess = appleOutcome.then((outcome) => {
      if (outcome.successful) {
        return { source: 'apple' as const, result: outcome.result };
      }
      return new Promise<never>(() => undefined);
    });
    const remoteWinner = remote.then(async (outcome) => {
      if (outcome.state === 'hit') {
        return {
          source: 'supabase' as const,
          remote: outcome.result,
        };
      }
      const appleFallback = await appleOutcome;
      return { source: 'apple' as const, result: appleFallback.result };
    });
    const winner = await Promise.race([appleSuccess, remoteWinner]);
    throwIfCanceled(signal);
    if (winner.source === 'supabase') {
      // The losing lookup has handlers attached above, so aborting it cannot
      // become an unhandled rejection while it releases its concurrency slot.
      void apple.catch(() => undefined);
      appleAbort.abort();
      return this.remotePaletteResult(key, winner.remote);
    }
    return winner.result;
  }

  private async readRemotePalette(key: string): Promise<RemotePaletteOutcome> {
    const startedAt = performance.now();
    try {
      const result = await this.paletteStore!.read!(key);
      if (!result) {
        this.supabaseCacheMisses += 1;
        return { state: 'miss' };
      }
      const parsed = artworkPaletteSchema.safeParse(result.palette);
      if (!parsed.success || parsed.data.source !== 'apple') {
        this.supabaseUnavailable += 1;
        return { state: 'unavailable' };
      }
      this.supabaseReadHits += 1;
      return { state: 'hit', result: { ...result, palette: parsed.data } };
    } catch {
      this.supabaseUnavailable += 1;
      return { state: 'unavailable' };
    } finally {
      this.observeDuration('supabase', startedAt);
    }
  }

  private readRemotePaletteShared(key: string): Promise<RemotePaletteOutcome> {
    this.pruneRemotePaletteOutcomes();
    const recent = this.recentRemotePaletteOutcomes.get(key);
    if (recent && recent.expiresAt > Date.now()) {
      this.recentRemotePaletteOutcomes.delete(key);
      this.recentRemotePaletteOutcomes.set(key, recent);
      return Promise.resolve(recent.outcome);
    }
    const existing = this.remotePaletteReads.get(key);
    if (existing) return existing;

    let request!: Promise<RemotePaletteOutcome>;
    request = this.readRemotePalette(key)
      .then((outcome) => {
        this.recentRemotePaletteOutcomes.set(key, {
          expiresAt: Date.now() + REMOTE_PALETTE_OUTCOME_CACHE_MS,
          outcome,
        });
        this.pruneRemotePaletteOutcomes();
        return outcome;
      })
      .finally(() => {
        if (this.remotePaletteReads.get(key) === request) {
          this.remotePaletteReads.delete(key);
        }
      });
    this.remotePaletteReads.set(key, request);
    return request;
  }

  private pruneRemotePaletteOutcomes(): void {
    const now = Date.now();
    for (const [key, cached] of this.recentRemotePaletteOutcomes) {
      if (cached.expiresAt <= now) this.recentRemotePaletteOutcomes.delete(key);
    }
    while (this.recentRemotePaletteOutcomes.size > REMOTE_PALETTE_OUTCOME_CACHE_LIMIT) {
      const oldest = this.recentRemotePaletteOutcomes.keys().next().value as string | undefined;
      if (!oldest) break;
      this.recentRemotePaletteOutcomes.delete(oldest);
    }
  }

  private recordCacheProbeHit(
    result: ArtworkLookupSuccessResult,
  ): ArtworkLookupSuccessResult {
    this.cacheProbeHits += 1;
    return result;
  }

  private recordCacheProbeMiss(): null {
    this.cacheProbeMisses += 1;
    return null;
  }

  private remotePaletteResult(
    key: string,
    remote: PaletteReadResult,
  ): ArtworkLookupSuccessResult {
    this.supabaseCacheHits += 1;
    const value: CachedArtworkPalette = {
      palette: structuredClone(remote.palette),
      expiresAt: Date.now() + POSITIVE_CACHE_MS,
      lookupStrategy: LOOKUP_STRATEGY,
    };
    this.rememberMemoryCache(key, value);
    const status: ArtworkLookupStatus = { state: 'success', source: 'supabase-cache' };
    this.recordResult(status);
    return { palette: structuredClone(remote.palette), status };
  }

  syncStats() {
    return {
      mode: config.supabase.paletteMode,
      queued: this.paletteWriteQueue.length,
      active: this.activePaletteWrites,
      successes: this.paletteWriteSuccesses,
      failures: this.paletteWriteFailures,
      dropped: this.paletteQueueDrops,
      lastState: this.lastPaletteWriteState,
      lastReason: this.lastPaletteWriteReason,
    };
  }

  lookupStats() {
    return {
      strategy: LOOKUP_STRATEGY,
      requests: this.lookupRequests,
      successes: this.lookupSuccesses,
      fallbacks: this.lookupFallbacks,
      searchRequests: this.searchRequests,
      cacheHits: {
        positive: this.positiveCacheHits,
        negative: this.negativeCacheHits,
        supabase: this.supabaseCacheHits,
      },
      supabase: {
        hits: this.supabaseCacheHits,
        readHits: this.supabaseReadHits,
        servedHits: this.supabaseCacheHits,
        misses: this.supabaseCacheMisses,
        unavailable: this.supabaseUnavailable,
      },
      cacheProbe: {
        requests: this.cacheProbeRequests,
        hits: this.cacheProbeHits,
        misses: this.cacheProbeMisses,
        cancellations: this.cacheProbeCancellations,
      },
      concurrency: {
        limit: ARTWORK_LOOKUP_CONCURRENCY,
        active: this.activeLookups,
        waiting: this.lookupWaiters.length,
        inFlight: this.inFlight.size,
      },
      cancellations: this.cancellations,
      localPersistence: {
        enabled: !this.paletteStore?.read,
        successes: this.localPersistSuccesses,
        failures: this.localPersistFailures,
      },
      durations: Object.fromEntries(
        ARTWORK_DURATION_PHASES.map((phase) => [
          phase,
          this.durations.get(phase)!.snapshot(),
        ]),
      ) as Record<ArtworkDurationPhase, DurationStats>,
      stageAttempts: { ...this.stageAttempts },
      stageHits: { ...this.stageHits },
      attemptFailures: { ...this.attemptFailures },
      fallbackReasons: { ...this.fallbackReasons },
      lastStatus: structuredClone(this.lastLookupStatus),
    };
  }

  private consumeSearchSlot(): boolean {
    const cutoff = Date.now() - SEARCH_WINDOW_MS;
    this.searchTimestamps = this.searchTimestamps.filter((timestamp) => timestamp > cutoff);
    if (this.searchTimestamps.length >= SEARCHES_PER_WINDOW) return false;
    this.searchTimestamps.push(Date.now());
    return true;
  }

  private recordResult(status: ArtworkLookupStatus): void {
    this.lookupRequests += 1;
    this.lastLookupStatus = structuredClone(status);
    if (status.state === 'success') {
      this.lookupSuccesses += 1;
      if (status.source === 'catalog' && status.stage) this.stageHits[status.stage] += 1;
    } else if (status.state === 'fallback') {
      this.lookupFallbacks += 1;
      this.fallbackReasons[status.reason] += 1;
    }
  }

  private recordAttemptFailure(failure: LookupFailure): void {
    this.attemptFailures[failure.reason] += 1;
  }

  private fallbackResult(
    track: TrackMetadata,
    failure: LookupFailure,
    cache: 'miss' | 'negative-hit' = 'miss',
  ): ArtworkLookupResult {
    const status: ArtworkLookupStatus = {
      state: 'fallback',
      reason: failure.reason,
      retryable: failure.retryable,
      cache,
      ...(failure.stage ? { stage: failure.stage } : {}),
    };
    if (cache === 'miss') safeFallbackLog(failure);
    this.recordResult(status);
    return { palette: fallbackArtworkPalette(track), status };
  }

  private preferredFailure(failures: LookupFailure[]): LookupFailure {
    const priority: ArtworkLookupFailureReason[] = [
      'local-rate-limit',
      'catalog-rate-limit',
      'catalog-timeout',
      'catalog-network',
      'catalog-http-server',
      'catalog-http-client',
      'catalog-invalid-response',
      'unknown',
    ];
    return [...failures].sort(
      (left, right) => priority.indexOf(left.reason) - priority.indexOf(right.reason),
    )[0] ?? { reason: 'unknown', retryable: true };
  }

  private selectMatch(matches: AppleCandidateMatch[]): AppleCandidateMatch | LookupFailure | null {
    const unique = new Map<string, AppleCandidateMatch>();
    for (const match of matches) {
      const identity = `${match.candidate.trackId}:${artworkAssetKey(match.candidate.artworkUrl100)}`;
      const existing = unique.get(identity);
      if (!existing || match.selectionScore > existing.selectionScore) {
        unique.set(identity, match);
      }
    }
    const ranked = [...unique.values()]
      .sort((left, right) => right.selectionScore - left.selectionScore);
    const best = ranked[0];
    if (!best) return null;
    const bestArtwork = artworkAssetKey(best.candidate.artworkUrl100);
    const runnerUp = ranked.find(
      (candidate) => artworkAssetKey(candidate.candidate.artworkUrl100) !== bestArtwork,
    );
    if (runnerUp && best.selectionScore - runnerUp.selectionScore < AMBIGUOUS_SCORE_GAP) {
      return {
        reason: 'ambiguous-candidate',
        retryable: false,
        stage: best.stage,
      };
    }
    return best;
  }

  private async lookup(
    track: TrackMetadata,
    key: string,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<ArtworkLookupResult> {
    throwIfCanceled(signal);
    if (!normalizeMetadata(track.artist) && !normalizeMetadata(track.album)) {
      return this.fallbackResult(track, {
        reason: 'insufficient-metadata',
        retryable: true,
      });
    }
    const plans = searchPlans(track);
    const matches: AppleCandidateMatch[] = [];
    const failures: LookupFailure[] = [];
    const rejectionReasons: MatchRejectionReason[] = [
      'catalog-version-mismatch',
      'catalog-album-mismatch',
      'catalog-low-confidence',
    ];
    const rejected = countRecord(rejectionReasons);
    let rawResults = 0;
    let withArtwork = 0;
    for (const plan of plans) {
      throwIfCanceled(signal);
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        const failure: LookupFailure = {
          reason: 'catalog-timeout',
          retryable: true,
          stage: plan.stage,
        };
        this.recordAttemptFailure(failure);
        failures.push(failure);
        break;
      }
      if (!this.consumeSearchSlot()) {
        const failure: LookupFailure = {
          reason: 'local-rate-limit',
          retryable: true,
          stage: plan.stage,
        };
        this.recordAttemptFailure(failure);
        failures.push(failure);
        break;
      }
      this.stageAttempts[plan.stage] += 1;
      this.searchRequests += 1;
      const catalogStartedAt = performance.now();
      try {
        const summary = await this.search(
          track,
          plan,
          Math.min(SEARCH_REQUEST_TIMEOUT_MS, remaining),
          signal,
        );
        rawResults += summary.rawResults;
        withArtwork += summary.withArtwork;
        for (const reason of rejectionReasons) rejected[reason] += summary.rejected[reason];
        matches.push(...summary.matches);
        const selected = this.selectMatch(matches);
        if (selected && 'candidate' in selected && candidateStrong(track, selected)) {
          return this.resolveMatch(track, key, selected, deadline, signal);
        }
      } catch (error) {
        if (signal?.aborted) throw cancellationError();
        const failure = catalogFailure(error, plan.stage);
        this.recordAttemptFailure(failure);
        failures.push(failure);
      } finally {
        this.observeDuration('catalog', catalogStartedAt);
      }
    }

    const selected = this.selectMatch(matches);
    if (selected && 'candidate' in selected) {
      return this.resolveMatch(track, key, selected, deadline, signal);
    }
    if (selected) {
      if (failures.length > 0) {
        return this.fallbackResult(track, this.preferredFailure(failures));
      }
      this.cache(key, null, AMBIGUOUS_CACHE_MS, {
        failureReason: 'ambiguous-candidate',
        lookupStage: selected.stage,
      });
      return this.fallbackResult(track, selected);
    }
    if (failures.length > 0) return this.fallbackResult(track, this.preferredFailure(failures));

    const rankedRejection = rejectionReasons
      .map((reason) => ({ reason, count: rejected[reason] }))
      .sort((left, right) => right.count - left.count)[0];
    const failureReason: CachedArtworkFailureReason = rawResults === 0
      ? 'catalog-empty'
      : withArtwork === 0
        ? 'catalog-missing-artwork'
        : rankedRejection && rankedRejection.count > 0
          ? rankedRejection.reason
          : 'no-reliable-match';
    const failure: LookupFailure = {
      reason: failureReason,
      retryable: false,
      stage: plans.at(-1)?.stage,
    };
    this.cache(key, null, NEGATIVE_CACHE_MS, {
      failureReason,
      lookupStage: failure.stage,
    });
    return this.fallbackResult(track, failure);
  }

  private async resolveMatch(
    track: TrackMetadata,
    key: string,
    match: AppleCandidateMatch,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<ArtworkLookupResult> {
    try {
      throwIfCanceled(signal);
      const { candidate, score, stage } = match;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw timeoutError();
      const artworkUrl = trustedArtworkUrl(candidate.artworkUrl100);
      const downloadStartedAt = performance.now();
      let image: Buffer;
      let contentType: string;
      try {
        const response = await fetch(artworkUrl, {
          headers: { 'User-Agent': 'Awesome-Lyrla/0.1 (personal Tesla lyrics display)' },
          redirect: 'error',
          signal: requestSignal(
            signal,
            Math.min(ARTWORK_REQUEST_TIMEOUT_MS, remaining),
          ),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`artwork_http_${response.status}`);
        }
        contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) {
          await response.body?.cancel();
          throw new Error('unsupported_artwork_type');
        }
        image = await readLimitedBody(response, ARTWORK_BODY_LIMIT);
      } finally {
        this.observeDuration('download', downloadStartedAt);
      }
      throwIfCanceled(signal);
      const analyzeStartedAt = performance.now();
      let analysis: Awaited<ReturnType<typeof analyzeArtwork>>;
      try {
        analysis = await analyzeArtwork(image);
      } finally {
        this.observeDuration('analyze', analyzeStartedAt);
      }
      throwIfCanceled(signal);
      if (analysis.contentType !== contentType) throw new Error('artwork_type_mismatch');
      const palette = analysis.palette;
      this.persistPaletteInBackground({
        track,
        artworkKey: key,
        providerName: 'apple',
        providerTrackId: candidate.trackId,
        matchConfidence: Math.max(0, Math.min(1, score)),
        palette,
      });
      this.cache(key, palette, POSITIVE_CACHE_MS, { lookupStage: stage });
      const status: ArtworkLookupStatus = { state: 'success', source: 'catalog', stage };
      this.recordResult(status);
      return { palette, status };
    } catch (error) {
      if (signal?.aborted) throw cancellationError();
      const failure = artworkFailure(error, match.stage);
      this.recordAttemptFailure(failure);
      return this.fallbackResult(track, failure);
    }
  }

  private persistPaletteInBackground(input: PaletteWriteInput): void {
    if (!this.paletteStore) return;
    if (this.persistedPaletteWrites.has(this.paletteWriteIdentity(input))) return;
    const existingIndex = this.paletteWriteQueue.findIndex(
      (queued) => queued.artworkKey === input.artworkKey,
    );
    if (existingIndex >= 0) {
      const existing = this.paletteWriteQueue[existingIndex]!;
      if (existing.providerName === 'apple' && input.providerName === 'local-cache') return;
      this.paletteWriteQueue.splice(existingIndex, 1);
    }
    while (this.paletteWriteQueue.length >= PALETTE_WRITE_QUEUE_MAX_ENTRIES) {
      this.paletteWriteQueue.shift();
      this.paletteQueueDrops += 1;
    }
    this.paletteWriteQueue.push(input);
    if (this.paletteDrainScheduled) return;
    this.paletteDrainScheduled = true;
    setImmediate(() => {
      this.paletteDrainScheduled = false;
      this.drainPaletteWriteQueue();
    });
  }

  private drainPaletteWriteQueue(): void {
    if (!this.paletteStore) return;
    while (
      this.activePaletteWrites < PALETTE_WRITE_CONCURRENCY &&
      this.paletteWriteQueue.length > 0
    ) {
      const input = this.paletteWriteQueue.shift()!;
      this.activePaletteWrites += 1;
      void this.writePaletteWithRetry(input).finally(() => {
        this.activePaletteWrites -= 1;
        this.drainPaletteWriteQueue();
      });
    }
  }

  private async withLookupSlot<T>(
    work: () => Promise<T>,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<T> {
    const queueStartedAt = performance.now();
    await this.acquireLookupSlot(deadline, signal);
    this.observeDuration('queue', queueStartedAt);
    try {
      throwIfCanceled(signal);
      if (Date.now() >= deadline) throw timeoutError();
      return await work();
    } finally {
      this.releaseLookupSlot();
    }
  }

  private acquireLookupSlot(deadline: number, signal?: AbortSignal): Promise<void> {
    throwIfCanceled(signal);
    if (this.activeLookups < ARTWORK_LOOKUP_CONCURRENCY) {
      this.activeLookups += 1;
      return Promise.resolve();
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return Promise.reject(timeoutError());
    return new Promise<void>((resolve, reject) => {
      let waiter!: {
        resolve: () => void;
        reject: (error: Error) => void;
        timer: NodeJS.Timeout;
        signal?: AbortSignal;
        onAbort?: () => void;
      };
      const cleanup = () => {
        clearTimeout(waiter.timer);
        if (waiter.signal && waiter.onAbort) {
          waiter.signal.removeEventListener('abort', waiter.onAbort);
        }
      };
      waiter = {
        resolve: () => {
          cleanup();
          resolve();
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        timer: setTimeout(() => {
          const index = this.lookupWaiters.indexOf(waiter);
          if (index >= 0) this.lookupWaiters.splice(index, 1);
          waiter.reject(timeoutError());
        }, remaining),
        signal,
      };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.lookupWaiters.indexOf(waiter);
          if (index >= 0) this.lookupWaiters.splice(index, 1);
          waiter.reject(cancellationError());
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      waiter.timer.unref();
      this.lookupWaiters.push(waiter);
    });
  }

  private releaseLookupSlot(): void {
    this.activeLookups = Math.max(0, this.activeLookups - 1);
    while (this.lookupWaiters.length > 0) {
      const next = this.lookupWaiters.shift()!;
      if (next.signal?.aborted) {
        next.reject(cancellationError());
        continue;
      }
      this.activeLookups += 1;
      next.resolve();
      return;
    }
  }

  private async writePaletteWithRetry(input: PaletteWriteInput): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.paletteStore!.upsert(input);
        this.rememberPaletteWrite(input);
        this.paletteWriteSuccesses += 1;
        this.lastPaletteWriteState = 'ok';
        this.lastPaletteWriteReason = null;
        return;
      } catch (error) {
        if (attempt === 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 250));
          continue;
        }
        console.warn(
          'Supabase palette write skipped:',
          error instanceof Error ? error.name : 'unknown_error',
        );
        this.paletteWriteFailures += 1;
        this.lastPaletteWriteState = 'error';
        this.lastPaletteWriteReason = error instanceof Error ? error.name : 'unknown_error';
      }
    }
  }

  private paletteWriteIdentity(input: PaletteWriteInput): string {
    return [
      input.artworkKey,
      input.providerName,
      input.providerTrackId ?? '',
      input.palette.primary,
      input.palette.secondary,
      input.palette.source,
      input.palette.field?.id ?? '',
    ].join('\u0000');
  }

  private rememberPaletteWrite(input: PaletteWriteInput): void {
    const identity = this.paletteWriteIdentity(input);
    this.persistedPaletteWrites.delete(identity);
    this.persistedPaletteWrites.add(identity);
    while (this.persistedPaletteWrites.size > ARTWORK_CACHE_MAX_ENTRIES) {
      const oldest = this.persistedPaletteWrites.values().next().value as string | undefined;
      if (!oldest) break;
      this.persistedPaletteWrites.delete(oldest);
    }
  }

  private async search(
    track: TrackMetadata,
    plan: SearchPlan,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<SearchSummary> {
    throwIfCanceled(signal);
    const url = new URL('https://itunes.apple.com/search');
    url.searchParams.set('term', plan.term);
    url.searchParams.set('country', plan.storefront);
    url.searchParams.set('media', 'music');
    url.searchParams.set('entity', 'song');
    url.searchParams.set('limit', '25');
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Awesome-Lyrla/0.1 (personal Tesla lyrics display)' },
      redirect: 'error',
      signal: requestSignal(signal, timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`catalog_http_${response.status}`);
    }
    let payload: z.infer<typeof appleSearchSchema>;
    try {
      const raw = await readLimitedBody(response, SEARCH_BODY_LIMIT);
      payload = appleSearchSchema.parse(JSON.parse(raw.toString('utf8')));
    } catch (error) {
      if (isTimeout(error) || error instanceof TypeError || errorCode(error) === 'response_too_large') {
        throw error;
      }
      throw new Error('catalog_invalid_response');
    }
    const rejected = countRecord<MatchRejectionReason>([
      'catalog-version-mismatch',
      'catalog-album-mismatch',
      'catalog-low-confidence',
    ]);
    const withArtwork = payload.results
      .filter((candidate): candidate is AppleCandidate => Boolean(candidate.artworkUrl100));
    const matches = withArtwork
      .map((candidate) => {
        const base = trackMatchScore(track, {
          trackName: candidate.trackName,
          artistName: candidate.artistName,
          albumName: candidate.collectionName,
          duration: candidate.trackTimeMillis / 1_000,
        });
        const score = base - (metadataVersionMismatch(track.title, candidate.trackName) ? 0.24 : 0);
        return {
          candidate,
          score,
          selectionScore: candidateSelectionScore(track, candidate),
          stage: plan.stage,
        };
      })
      .filter(({ candidate, score }) => {
        const reason = candidateRejection(track, candidate, score);
        if (!reason) return true;
        rejected[reason] += 1;
        return false;
      })
      .sort((left, right) => right.selectionScore - left.selectionScore);
    return {
      matches,
      rawResults: payload.results.length,
      withArtwork: withArtwork.length,
      rejected,
    };
  }

  private cache(
    key: string,
    palette: ArtworkPalette | null,
    ttl: number,
    details: {
      failureReason?: CachedArtworkFailureReason;
      lookupStage?: ArtworkLookupStage;
    } = {},
  ): void {
    const value: CachedArtworkPalette = {
      palette: palette ? structuredClone(palette) : null,
      expiresAt: Date.now() + ttl,
      lookupStrategy: LOOKUP_STRATEGY,
      ...details,
    };
    this.rememberMemoryCache(key, value);

    // Supabase primary is the durable L2. Avoid serializing and replacing the
    // complete compatibility state for every cold palette on the web process.
    if (this.paletteStore?.read) return;

    const startedAt = performance.now();
    void this.store.updateArtworkPalette(key, value, ARTWORK_CACHE_MAX_ENTRIES)
      .then(() => {
        this.localPersistSuccesses += 1;
      })
      .catch(() => {
        this.localPersistFailures += 1;
        console.warn('Artwork palette cache write skipped');
      })
      .finally(() => {
        this.observeDuration('persist', startedAt);
      });
  }

  private rememberMemoryCache(key: string, value: CachedArtworkPalette): void {
    this.memoryCache.delete(key);
    this.memoryCache.set(key, structuredClone(value));
    while (this.memoryCache.size > ARTWORK_CACHE_MAX_ENTRIES) {
      const oldest = this.memoryCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.memoryCache.delete(oldest);
    }
  }

  private observeDuration(phase: ArtworkDurationPhase, startedAt: number): void {
    this.durations.get(phase)?.observe(Math.max(0, performance.now() - startedAt));
  }
}
