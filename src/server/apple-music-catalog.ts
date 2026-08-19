import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { TrackMetadata } from '../shared/contracts.js';
import {
  metadataVersionMismatch,
  normalizeMetadata,
  trackFingerprint,
} from '../shared/track.js';
import { config } from './config.js';
import {
  scriptAwareMetadataSimilarity,
  scriptAwareTrackMatchScore,
} from './lyrics-metadata-alias.js';

const appleMusicSearchSchema = z.object({
  results: z.object({
    songs: z.object({
      data: z.array(z.object({
        id: z.string(),
        attributes: z.object({
          name: z.string(),
          artistName: z.string(),
          albumName: z.string().optional().default(''),
          durationInMillis: z.number().nonnegative().optional().default(0),
          hasLyrics: z.boolean().optional(),
          isrc: z.string().optional(),
        }),
      })).max(25),
    }).optional(),
  }),
});

type AppleMusicSong = NonNullable<
  z.infer<typeof appleMusicSearchSchema>['results']['songs']
>['data'][number];

export interface AppleMusicCatalogSettings {
  developerToken: string;
  teamId: string;
  keyId: string;
  privateKeyPath: string;
  storefront: string;
  fetchImpl?: typeof fetch;
}

export interface AppleMusicCatalogMatch extends TrackMetadata {
  providerTrackId: string;
  hasLyrics?: boolean;
  isrc?: string;
}

interface GeneratedDeveloperToken {
  token: string;
  expiresAtMs: number;
}

const RESPONSE_BODY_LIMIT = 512 * 1_024;
const TOKEN_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1_000;
const MAX_SEARCH_PLANS = 3;

function encodedJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function createAppleMusicDeveloperToken(
  teamId: string,
  keyId: string,
  privateKey: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): GeneratedDeveloperToken {
  const issuedAt = nowSeconds - 60;
  const expiresAt = nowSeconds + TOKEN_LIFETIME_SECONDS;
  const header = encodedJson({ alg: 'ES256', kid: keyId });
  const payload = encodedJson({ iss: teamId, iat: issuedAt, exp: expiresAt });
  const signingInput = `${header}.${payload}`;
  const signature = createSign('SHA256')
    .update(signingInput)
    .end()
    .sign({ key: privateKey, dsaEncoding: 'ieee-p1363' })
    .toString('base64url');
  return {
    token: `${signingInput}.${signature}`,
    expiresAtMs: expiresAt * 1_000,
  };
}

function clipped(value: string): string {
  return Array.from(value).slice(0, 200).join('');
}

function candidateTrack(song: AppleMusicSong, source: string): TrackMetadata {
  return {
    title: song.attributes.name,
    artist: song.attributes.artistName,
    album: song.attributes.albumName,
    durationMs: song.attributes.durationInMillis,
    source,
  };
}

function candidateReliable(track: TrackMetadata, candidate: TrackMetadata, score: number): boolean {
  if (metadataVersionMismatch(track.title, candidate.title)) return false;
  const title = scriptAwareMetadataSimilarity(track.title, candidate.title);
  const artist = scriptAwareMetadataSimilarity(track.artist, candidate.artist);
  const album = track.album && candidate.album
    ? scriptAwareMetadataSimilarity(track.album, candidate.album)
    : 0;
  const durationDifference = track.durationMs > 0 && candidate.durationMs > 0
    ? Math.abs(track.durationMs - candidate.durationMs) / 1_000
    : Number.POSITIVE_INFINITY;

  if (normalizeMetadata(track.artist)) {
    const hasSecondaryEvidence = durationDifference <= 10 || album >= 0.8;
    return score >= 0.78 && title >= 0.88 && artist >= 0.75 && hasSecondaryEvidence;
  }
  return score >= 0.84 && title >= 0.95 && durationDifference <= 8 && album >= 0.75;
}

async function readLimitedJson(
  response: Response,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) {
    cancelBody(response, abortReason(signal));
    throw abortReason(signal);
  }
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > RESPONSE_BODY_LIMIT) {
    cancelBody(response, new Error('Apple Music catalog response exceeded its byte limit'));
    throw new Error('apple_music_response_too_large');
  }
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  let onAbort: (() => void) | undefined;
  const aborted = signal
    ? new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          reject(abortReason(signal));
          cancelReader(reader, abortReason(signal));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      })
    : undefined;
  try {
    while (true) {
      signal?.throwIfAborted();
      const pendingRead = reader.read();
      void pendingRead.catch(() => undefined);
      const { done, value } = aborted
        ? await Promise.race([pendingRead, aborted])
        : await pendingRead;
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_BODY_LIMIT) {
        cancelReader(reader, new Error('Apple Music catalog response exceeded its byte limit'));
        throw new Error('apple_music_response_too_large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
  signal?.throwIfAborted();
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Operation aborted', 'AbortError');
}

function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: unknown,
): void {
  void reader.cancel(reason).catch(() => undefined);
}

function cancelBody(response: Response, reason: unknown): void {
  if (!response.body || response.body.locked) return;
  void response.body.cancel(reason).catch(() => undefined);
}

function enrichmentFingerprint(track: TrackMetadata): string {
  return `${trackFingerprint(track)}::${normalizeMetadata(track.album)}`;
}

function searchTerms(track: TrackMetadata): string[] {
  const candidates = [
    [track.title, track.artist, track.album],
    [track.title, track.artist],
    [track.title],
  ];
  const seen = new Set<string>();
  return candidates
    .map((parts) => clipped(parts.filter(Boolean).join(' ')))
    .filter((term) => {
      const key = normalizeMetadata(term);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_SEARCH_PLANS);
}

interface RankedCatalogCandidate {
  song: AppleMusicSong;
  candidate: TrackMetadata;
  score: number;
}

export class AppleMusicCatalogService {
  private generatedToken?: GeneratedDeveloperToken;
  private readonly inFlight = new Map<string, Promise<AppleMusicCatalogMatch | null>>();
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly settings: AppleMusicCatalogSettings = config.appleMusic) {
    this.fetchImpl = settings.fetchImpl ?? globalThis.fetch;
  }

  isConfigured(): boolean {
    return Boolean(
      this.settings.developerToken ||
      (this.settings.teamId && this.settings.keyId && this.settings.privateKeyPath),
    );
  }

  async resolve(
    track: TrackMetadata,
    options: { signal?: AbortSignal } = {},
  ): Promise<TrackMetadata | null> {
    // Foreground LRCLIB enrichment stays on the original one-request path.
    // Exhaustive discovery is reserved for the asynchronous Apple worker.
    const match = await this.resolveMatch(track, undefined, {
      ...options,
      exhaustive: false,
    });
    if (!match) return null;
    return {
      title: match.title,
      artist: match.artist,
      album: match.album,
      durationMs: match.durationMs,
      source: match.source,
    };
  }

  async resolveMatch(
    track: TrackMetadata,
    storefrontOverride?: string,
    options: { signal?: AbortSignal; exhaustive?: boolean } = {},
  ): Promise<AppleMusicCatalogMatch | null> {
    options.signal?.throwIfAborted();
    if (!this.isConfigured() || !normalizeMetadata(track.title)) return null;
    const requestedStorefront = storefrontOverride?.toLowerCase();
    const configuredStorefront = this.settings.storefront.toLowerCase();
    const storefront = requestedStorefront && /^[a-z]{2}$/.test(requestedStorefront)
      ? requestedStorefront
      : /^[a-z]{2}$/.test(configuredStorefront)
        ? configuredStorefront
        : 'us';
    const exhaustive = options.exhaustive ?? false;
    const key = `${exhaustive ? 'exhaustive' : 'fast'}:${storefront}:`
      + enrichmentFingerprint(track);
    // A caller-owned cancellation signal cannot safely own a promise shared
    // with unrelated callers. Signalled worker lookups therefore bypass the
    // request-path deduplication map and remain independently cancellable.
    if (options.signal) {
      return this.search(track, storefront, exhaustive, options.signal);
    }
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const request = this.search(track, storefront, exhaustive)
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, request);
    return request;
  }

  private async developerToken(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (this.settings.developerToken) return this.settings.developerToken;
    if (
      this.generatedToken &&
      this.generatedToken.expiresAtMs - TOKEN_REFRESH_MARGIN_MS > Date.now()
    ) {
      return this.generatedToken.token;
    }
    const privateKey = await readFile(this.settings.privateKeyPath, {
      encoding: 'utf8',
      ...(signal ? { signal } : {}),
    });
    this.generatedToken = createAppleMusicDeveloperToken(
      this.settings.teamId,
      this.settings.keyId,
      privateKey,
    );
    return this.generatedToken.token;
  }

  private async search(
    track: TrackMetadata,
    storefront: string,
    exhaustive: boolean,
    signal?: AbortSignal,
  ): Promise<AppleMusicCatalogMatch | null> {
    const timeoutSignal = AbortSignal.timeout(5_000);
    const requestSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    requestSignal.throwIfAborted();
    const developerToken = await this.developerToken(requestSignal);
    const rankedById = new Map<string, RankedCatalogCandidate>();
    const terms = searchTerms(track);
    for (const term of exhaustive ? terms : terms.slice(0, 1)) {
      const songs = await this.searchTerm(
        storefront,
        term,
        developerToken,
        requestSignal,
      );
      for (const song of songs) {
        const candidate = candidateTrack(song, track.source);
        const ranked = {
          song,
          candidate,
          score: scriptAwareTrackMatchScore(track, {
            trackName: candidate.title,
            artistName: candidate.artist,
            albumName: candidate.album,
            duration: candidate.durationMs / 1_000,
          }),
        };
        const existing = rankedById.get(song.id);
        if (!existing || ranked.score > existing.score) {
          rankedById.set(song.id, ranked);
        }
      }

      // Exact v1 metadata is stronger than any later broad-search candidate.
      // Returning here retains the common one-request path while reliable but
      // non-exact candidates remain provisional until all bounded terms have
      // had a chance to contribute a better match.
      const exact = [...rankedById.values()]
        .filter(({ candidate, score }) =>
          enrichmentFingerprint(candidate) === enrichmentFingerprint(track)
          && candidateReliable(track, candidate, score))
        .sort((left, right) => right.score - left.score)[0];
      if (exact) return this.catalogMatch(track, exact);
    }

    const best = [...rankedById.values()]
      .sort((left, right) => right.score - left.score)
      .find(({ candidate, score }) => candidateReliable(track, candidate, score));
    return best ? this.catalogMatch(track, best) : null;
  }

  private async searchTerm(
    storefront: string,
    term: string,
    developerToken: string,
    signal: AbortSignal,
  ): Promise<AppleMusicSong[]> {
    const url = new URL(`https://api.music.apple.com/v1/catalog/${storefront}/search`);
    url.searchParams.set('term', term);
    url.searchParams.set('types', 'songs');
    url.searchParams.set('limit', '10');
    const response = await this.fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${developerToken}`,
        'User-Agent': 'Awesome-Lyrla/0.1 (personal Tesla lyrics display)',
      },
      redirect: 'error',
      signal,
    });
    if (signal.aborted) {
      cancelBody(response, abortReason(signal));
      throw abortReason(signal);
    }
    if (!response.ok) {
      cancelBody(response, new Error(`Apple Music catalog HTTP ${response.status}`));
      throw new Error(`apple_music_search_http_${response.status}`);
    }
    const payload = appleMusicSearchSchema.parse(
      await readLimitedJson(response, signal),
    );
    return payload.results.songs?.data ?? [];
  }

  private catalogMatch(
    track: TrackMetadata,
    best: RankedCatalogCandidate,
  ): AppleMusicCatalogMatch {
    return {
      providerTrackId: best.song.id,
      title: best.candidate.title,
      artist: best.candidate.artist,
      album: best.candidate.album || track.album,
      durationMs: track.durationMs || best.candidate.durationMs,
      source: track.source,
      ...(best.song.attributes.hasLyrics === undefined
        ? {}
        : { hasLyrics: best.song.attributes.hasLyrics }),
      ...(best.song.attributes.isrc ? { isrc: best.song.attributes.isrc } : {}),
    };
  }
}
