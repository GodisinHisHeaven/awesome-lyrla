import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { TrackMetadata } from '../shared/contracts.js';
import { lyricsLookupFingerprint } from '../shared/track.js';

const APPLE_API_ORIGIN = 'https://api.music.apple.com';
const MAX_PAGE_BYTES = 8 * 1_024 * 1_024;
const MAX_PAGES = 100;
const MAX_TRACKS = 5_000;

const appleSongSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.literal('songs'),
  attributes: z.object({
    name: z.string().min(1).max(2_048),
    artistName: z.string().min(1).max(2_048),
    albumName: z.string().max(2_048).optional().default(''),
    durationInMillis: z.number().nonnegative().max(24 * 60 * 60 * 1_000),
    hasLyrics: z.boolean().optional(),
    isrc: z.string().max(32).optional(),
  }),
});

const applePlaylistPageSchema = z.object({
  data: z.array(appleSongSchema).max(100),
  next: z.string().nullable().optional(),
});

type AppleSong = z.infer<typeof appleSongSchema>;

export interface AppleMusicPlaylistLocation {
  storefront: string;
  playlistId: string;
  sourceUrl: string;
}

export interface AppleMusicPlaylistTrack {
  position: number;
  appleSongId: string;
  hasLyrics?: boolean;
  isrc?: string;
  track: TrackMetadata;
}

export interface AppleMusicPlaylistSnapshot {
  location: AppleMusicPlaylistLocation;
  sourceTrackCount: number;
  uniqueAppleSongCount: number;
  uniqueExactKeyCount: number;
  duplicateAppleSongCount: number;
  duplicateExactKeyCount: number;
  checksum: string;
  tracks: AppleMusicPlaylistTrack[];
}

interface FetchPlaylistOptions {
  developerToken: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

function playlistPath(location: AppleMusicPlaylistLocation): string {
  return `/v1/catalog/${location.storefront}/playlists/${location.playlistId}/tracks`;
}

export function parseAppleMusicPlaylistUrl(value: string): AppleMusicPlaylistLocation {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'music.apple.com') {
    throw new Error('Playlist URL must use https://music.apple.com');
  }
  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const storefront = segments[0]?.toLowerCase() ?? '';
  const playlistIndex = segments.indexOf('playlist');
  const playlistId = segments.at(-1) ?? '';
  if (!/^[a-z]{2}$/.test(storefront) || playlistIndex !== 1) {
    throw new Error('Apple Music playlist URL has an invalid storefront or path');
  }
  if (!/^pl\.[A-Za-z0-9._-]{3,128}$/.test(playlistId)) {
    throw new Error('Apple Music playlist URL has an invalid playlist id');
  }
  return {
    storefront,
    playlistId,
    sourceUrl: url.href,
  };
}

export function normalizeApplePlaylistText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function playlistTrack(song: AppleSong, position: number): AppleMusicPlaylistTrack {
  return {
    position,
    appleSongId: song.id,
    ...(song.attributes.hasLyrics === undefined
      ? {}
      : { hasLyrics: song.attributes.hasLyrics }),
    ...(song.attributes.isrc ? { isrc: song.attributes.isrc } : {}),
    track: {
      title: normalizeApplePlaylistText(song.attributes.name),
      artist: normalizeApplePlaylistText(song.attributes.artistName),
      album: normalizeApplePlaylistText(song.attributes.albumName),
      durationMs: Math.max(0, Math.round(song.attributes.durationInMillis)),
      source: 'Apple Music playlist',
    },
  };
}

export function createAppleMusicPlaylistSnapshot(
  location: AppleMusicPlaylistLocation,
  songs: AppleSong[],
): AppleMusicPlaylistSnapshot {
  const sourceTracks = songs.map((song, index) => playlistTrack(song, index + 1));
  const uniqueAppleIds = new Set(sourceTracks.map((item) => item.appleSongId));
  const tracksByExactKey = new Map<string, AppleMusicPlaylistTrack>();
  for (const item of sourceTracks) {
    const key = lyricsLookupFingerprint(item.track);
    if (!tracksByExactKey.has(key)) tracksByExactKey.set(key, item);
  }
  const checksumInput = sourceTracks.map((item) => ({
    position: item.position,
    appleSongId: item.appleSongId,
    title: item.track.title,
    artist: item.track.artist,
    album: item.track.album,
    durationMs: item.track.durationMs,
  }));
  return {
    location,
    sourceTrackCount: sourceTracks.length,
    uniqueAppleSongCount: uniqueAppleIds.size,
    uniqueExactKeyCount: tracksByExactKey.size,
    duplicateAppleSongCount: sourceTracks.length - uniqueAppleIds.size,
    duplicateExactKeyCount: sourceTracks.length - tracksByExactKey.size,
    checksum: createHash('sha256').update(JSON.stringify(checksumInput)).digest('hex'),
    tracks: [...tracksByExactKey.values()],
  };
}

export async function fetchAppleMusicPlaylist(
  location: AppleMusicPlaylistLocation,
  options: FetchPlaylistOptions,
): Promise<AppleMusicPlaylistSnapshot> {
  if (!options.developerToken) throw new Error('Apple Music developer token is required');
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = Math.max(1_000, Math.min(30_000, options.timeoutMs ?? 10_000));
  const expectedPath = playlistPath(location);
  let nextUrl: URL | null = new URL(expectedPath, APPLE_API_ORIGIN);
  nextUrl.searchParams.set('limit', '100');
  const visited = new Set<string>();
  const songs: AppleSong[] = [];
  let previousOffset = -1;

  while (nextUrl) {
    validateNextUrl(nextUrl, expectedPath, previousOffset);
    const offset = Number.parseInt(nextUrl.searchParams.get('offset') ?? '0', 10);
    previousOffset = offset;
    if (visited.has(nextUrl.href)) throw new Error('Apple Music playlist pagination loop detected');
    visited.add(nextUrl.href);
    if (visited.size > MAX_PAGES) throw new Error('Apple Music playlist exceeded page limit');

    const response = await fetcher(nextUrl, {
      headers: {
        Authorization: `Bearer ${options.developerToken}`,
        'User-Agent': 'Awesome-Lyrla/0.1 (personal Tesla lyrics display)',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Apple Music playlist request failed with ${response.status}`);
    }
    const page = applePlaylistPageSchema.parse(await readLimitedJson(response));
    songs.push(...page.data);
    if (songs.length > MAX_TRACKS) throw new Error('Apple Music playlist exceeded track limit');
    nextUrl = page.next ? new URL(page.next, APPLE_API_ORIGIN) : null;
  }

  return createAppleMusicPlaylistSnapshot(location, songs);
}

function validateNextUrl(url: URL, expectedPath: string, previousOffset: number): void {
  if (url.origin !== APPLE_API_ORIGIN || decodeURIComponent(url.pathname) !== expectedPath) {
    throw new Error('Apple Music playlist pagination left the expected resource');
  }
  const allowed = new Set(['limit', 'offset']);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) throw new Error('Apple Music playlist pagination had an unexpected query');
  }
  const limit = url.searchParams.get('limit');
  if (limit !== null && limit !== '100') {
    throw new Error('Apple Music playlist pagination had an invalid limit');
  }
  const rawOffset = url.searchParams.get('offset') ?? '0';
  if (!/^\d+$/.test(rawOffset)) throw new Error('Apple Music playlist pagination had an invalid offset');
  const offset = Number.parseInt(rawOffset, 10);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset <= previousOffset) {
    throw new Error('Apple Music playlist pagination offset did not increase');
  }
}

async function readLimitedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PAGE_BYTES) {
    throw new Error('Apple Music playlist response exceeded size limit');
  }
  if (!response.body) throw new Error('Apple Music playlist response had no body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_PAGE_BYTES) {
        await reader.cancel('response exceeded size limit');
        throw new Error('Apple Music playlist response exceeded size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks, totalBytes).toString('utf8')) as unknown;
}
