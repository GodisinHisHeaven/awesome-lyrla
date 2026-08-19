import 'dotenv/config';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LyricsPayload, TrackMetadata } from '../src/shared/contracts.js';
import {
  hasRecordingVersionTag,
  lyricsLookupFingerprint,
  lyricsWorkFingerprint,
} from '../src/shared/track.js';
import {
  fetchAppleMusicPlaylist,
  parseAppleMusicPlaylistUrl,
  type AppleMusicPlaylistSnapshot,
  type AppleMusicPlaylistTrack,
} from '../src/server/apple-music-playlist.js';
import {
  createAppleMusicDeveloperToken,
} from '../src/server/apple-music-catalog.js';
import { config } from '../src/server/config.js';
import {
  LYRICS_EXACT_LOOKUP_STRATEGY,
  LYRICS_LOOKUP_STRATEGY,
  LyricsService,
} from '../src/server/lyrics-service.js';
import {
  LYRICS_FINGERPRINT_VERSION,
  LyricsRepository,
  type LyricsLibraryResolveResult,
} from '../src/server/lyrics-repository.js';
import { JsonStore } from '../src/server/store.js';
import { SupabaseLyricsClient } from '../src/server/supabase-lyrics-client.js';

type PreflightStatus =
  | 'existing'
  | 'ready'
  | 'fallback-original-version'
  | 'fallback-work-cache'
  | 'missing'
  | 'retryable-unavailable'
  | 'remote-ambiguous'
  | 'remote-unavailable'
  | 'invalid-provider'
  | 'error';

type FinalStatus = PreflightStatus | 'written' | 'write-failed' | 'verify-failed';

interface CliOptions {
  playlistUrl: string;
  apply: boolean;
  concurrency: number;
  lrclibRequestsPerSecond: number;
  lookupRetries: number;
  reportPath?: string;
  expectedProjectRef?: string;
  expectedLibraryId?: string;
  limit?: number;
}

interface ImportResult {
  item: AppleMusicPlaylistTrack;
  exactKey: string;
  status: FinalStatus;
  payload?: LyricsPayload;
  lookupStrategy?: string;
  reason?: string;
}

interface PublicImportResult {
  position: number;
  appleSongId: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  appleHasLyrics?: boolean;
  exactKeyDigest: string;
  providerId?: number;
  lookupMode?: 'exact-only' | 'multi-strategy';
  status: FinalStatus;
  reason?: string;
}

interface ImportReport {
  schemaVersion: 1;
  mode: 'dry-run' | 'apply';
  phase:
    | 'preflight'
    | 'applying'
    | 'applied-unverified'
    | 'complete'
    | 'failed'
    | 'playlist-changed';
  completed: boolean;
  startedAt: string;
  finishedAt: string;
  playlist: Omit<AppleMusicPlaylistSnapshot, 'tracks'>;
  selectedExactKeys: number;
  playlistUnchanged?: boolean;
  summary: Record<string, number>;
  items: PublicImportResult[];
}

const POSITIVE_CACHE_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_LRCLIB_RPS = 2;

function usage(): string {
  return [
    'Usage:',
    '  npm run lyrics:preload-playlist -- --playlist <Apple Music URL> [options]',
    '',
    'Options:',
    '  --apply                         Write verified Exact matches to Supabase',
    '  --expected-project-ref <ref>    Required with --apply; guards the target project',
    '  --expected-library-id <uuid>    Required with --apply; guards the target library',
    '  --concurrency <1-4>             Track workers (default: 2)',
    '  --lrclib-rps <1-5>              Global LRCLIB request starts/second (default: 2)',
    '  --lookup-retries <0-3>          Retry retryable track lookups (default: 2)',
    '  --report <path>                 Save a metadata-only JSON report',
    '  --limit <count>                 Process only the first N unique Exact keys',
    '  --help                          Show this help',
    '',
    'Dry-run is the default. Lyrics text is never written to the report or console.',
  ].join('\n');
}

function optionValue(args: string[], index: number, name: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function boundedInteger(value: string, name: string, minimum: number, maximum: number): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseArgs(args: string[]): CliOptions {
  if (args.includes('--help')) {
    console.log(usage());
    process.exit(0);
  }
  let playlistUrl = '';
  let apply = false;
  let concurrency = DEFAULT_CONCURRENCY;
  let lrclibRequestsPerSecond = DEFAULT_LRCLIB_RPS;
  let lookupRetries = 2;
  let reportPath: string | undefined;
  let expectedProjectRef: string | undefined;
  let expectedLibraryId: string | undefined;
  let limit: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--apply') {
      apply = true;
    } else if (argument === '--playlist') {
      playlistUrl = optionValue(args, index, argument);
      index += 1;
    } else if (argument === '--concurrency') {
      concurrency = boundedInteger(optionValue(args, index, argument), argument, 1, 4);
      index += 1;
    } else if (argument === '--lrclib-rps') {
      lrclibRequestsPerSecond = boundedInteger(
        optionValue(args, index, argument), argument, 1, 5,
      );
      index += 1;
    } else if (argument === '--lookup-retries') {
      lookupRetries = boundedInteger(optionValue(args, index, argument), argument, 0, 3);
      index += 1;
    } else if (argument === '--report') {
      reportPath = path.resolve(optionValue(args, index, argument));
      index += 1;
    } else if (argument === '--expected-project-ref') {
      expectedProjectRef = optionValue(args, index, argument);
      index += 1;
    } else if (argument === '--expected-library-id') {
      expectedLibraryId = optionValue(args, index, argument);
      index += 1;
    } else if (argument === '--limit') {
      limit = boundedInteger(optionValue(args, index, argument), argument, 1, 5_000);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!playlistUrl) throw new Error('--playlist is required');
  if (apply && (!expectedProjectRef || !expectedLibraryId)) {
    throw new Error(
      '--expected-project-ref and --expected-library-id are required with --apply',
    );
  }
  return {
    playlistUrl,
    apply,
    concurrency,
    lrclibRequestsPerSecond,
    lookupRetries,
    ...(reportPath ? { reportPath } : {}),
    ...(expectedProjectRef ? { expectedProjectRef } : {}),
    ...(expectedLibraryId ? { expectedLibraryId } : {}),
    ...(limit ? { limit } : {}),
  };
}

async function appleDeveloperToken(): Promise<string> {
  if (config.appleMusic.developerToken) return config.appleMusic.developerToken;
  if (!config.appleMusic.teamId || !config.appleMusic.keyId || !config.appleMusic.privateKeyPath) {
    throw new Error('Apple Music developer token configuration is missing');
  }
  const privateKey = await readFile(config.appleMusic.privateKeyPath, 'utf8');
  return createAppleMusicDeveloperToken(
    config.appleMusic.teamId,
    config.appleMusic.keyId,
    privateKey,
  ).token;
}

function projectRef(urlValue: string): string | null {
  try {
    const url = new URL(urlValue);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      (url.pathname !== '' && url.pathname !== '/') ||
      url.search ||
      url.hash
    ) return null;
    const match = url.hostname.match(/^([a-z0-9]+)\.supabase\.co$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function supabaseClient(
  options: CliOptions,
  fetcher: typeof fetch,
): SupabaseLyricsClient | undefined {
  const configured = Boolean(
    config.supabase.url && config.supabase.secretKey && config.supabase.libraryId,
  );
  if (!configured) {
    if (options.apply) throw new Error('Supabase URL, secret key, and library id are required');
    return undefined;
  }
  const actualRef = projectRef(config.supabase.url);
  if (!actualRef) {
    throw new Error('Supabase URL must be a clean hosted HTTPS origin');
  }
  if (options.expectedProjectRef && actualRef !== options.expectedProjectRef) {
    throw new Error(
      `Supabase project guard failed: expected ${options.expectedProjectRef}, received ${actualRef ?? 'invalid'}`,
    );
  }
  if (options.expectedLibraryId && config.supabase.libraryId !== options.expectedLibraryId) {
    throw new Error(
      `Supabase library guard failed: expected ${options.expectedLibraryId}`,
    );
  }
  return new SupabaseLyricsClient({
    url: config.supabase.url,
    secretKey: config.supabase.secretKey,
    libraryId: config.supabase.libraryId,
    timeoutMs: 5_000,
    writeTimeoutMs: 15_000,
    fetcher,
  });
}

function abortableDelay(milliseconds: number, signal?: AbortSignal | null): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const timeout = setTimeout(done, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason ?? new Error('aborted'));
    };
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

class RequestStartLimiter {
  private queue: Promise<void> = Promise.resolve();
  private nextStartAt = 0;

  constructor(private readonly intervalMs: number) {}

  async acquire(signal?: AbortSignal | null): Promise<void> {
    const previous = this.queue;
    let release: () => void = () => undefined;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const waitMs = Math.max(0, this.nextStartAt - Date.now());
      await abortableDelay(waitMs, signal);
      this.nextStartAt = Date.now() + this.intervalMs;
    } finally {
      release();
    }
  }
}

function lrclibLimitedFetch(fetcher: typeof fetch, requestsPerSecond: number): typeof fetch {
  const limiter = new RequestStartLimiter(Math.ceil(1_000 / requestsPerSecond));
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === 'lrclib.net') {
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      await limiter.acquire(signal);
    }
    return fetcher(input, init);
  };
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await worker(values[index]!, index);
    }
  }));
  return results;
}

async function resolveExisting(
  remote: SupabaseLyricsClient,
  track: TrackMetadata,
): Promise<LyricsLibraryResolveResult> {
  let result: LyricsLibraryResolveResult = { state: 'unavailable', reason: 'network' };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    result = await remote.resolve({
      track,
      exactKey: lyricsLookupFingerprint(track),
      workKey: lyricsWorkFingerprint(track),
      keyVersion: LYRICS_FINGERPRINT_VERSION,
      allowWorkFallback: false,
    });
    if (result.state !== 'unavailable') return result;
    if (attempt < 2) await abortableDelay(500 * (2 ** attempt));
  }
  return result;
}

async function lookupLyrics(
  service: LyricsService,
  item: AppleMusicPlaylistTrack,
  exactKey: string,
  retries: number,
): Promise<ImportResult> {
  const exactOnly = hasRecordingVersionTag(item.track.title);
  const lookupStrategy = exactOnly
    ? LYRICS_EXACT_LOOKUP_STRATEGY
    : LYRICS_LOOKUP_STRATEGY;
  try {
    let payload: LyricsPayload | undefined;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      payload = await service.find(item.track, { forceRefresh: true, exactOnly });
      if (!payload.retryable || attempt === retries) break;
      await abortableDelay(1_000 * (2 ** attempt));
    }
    if (!payload) {
      return { item, exactKey, status: 'error', lookupStrategy, reason: 'empty_lookup_result' };
    }
    if (payload.fallbackKind) {
      return {
        item,
        exactKey,
        status: payload.fallbackKind === 'work-cache'
          ? 'fallback-work-cache'
          : 'fallback-original-version',
        lookupStrategy,
      };
    }
    if (payload.kind === 'missing' || payload.kind === 'loading') {
      return {
        item,
        exactKey,
        status: payload.retryable ? 'retryable-unavailable' : 'missing',
        lookupStrategy,
      };
    }
    if (payload.provider !== 'lrclib' || !Number.isSafeInteger(payload.providerId)) {
      return { item, exactKey, status: 'invalid-provider', lookupStrategy };
    }
    return { item, exactKey, status: 'ready', payload, lookupStrategy };
  } catch (error) {
    return { item, exactKey, status: 'error', lookupStrategy, reason: safeError(error) };
  }
}

function safeError(error: unknown): string {
  if (error instanceof Error) return error.name || 'Error';
  return 'unknown_error';
}

function statusCounts(results: ImportResult[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const result of results) counts[result.status] = (counts[result.status] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) =>
    left.localeCompare(right)));
}

function publicResult(result: ImportResult): PublicImportResult {
  return {
    position: result.item.position,
    appleSongId: result.item.appleSongId,
    title: result.item.track.title,
    artist: result.item.track.artist,
    album: result.item.track.album,
    durationMs: result.item.track.durationMs,
    ...(result.item.hasLyrics === undefined ? {} : { appleHasLyrics: result.item.hasLyrics }),
    exactKeyDigest: createHash('sha256').update(result.exactKey).digest('hex').slice(0, 16),
    ...(result.payload?.providerId === undefined ? {} : { providerId: result.payload.providerId }),
    ...(result.lookupStrategy === undefined ? {} : {
      lookupMode: result.lookupStrategy === LYRICS_EXACT_LOOKUP_STRATEGY
        ? 'exact-only' as const
        : 'multi-strategy' as const,
    }),
    status: result.status,
    ...(result.reason ? { reason: result.reason } : {}),
  };
}

async function writeReport(reportPath: string, report: ImportReport): Promise<void> {
  await mkdir(path.dirname(reportPath), { recursive: true });
  const temporary = `${reportPath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, reportPath);
}

function reportFor(
  options: CliOptions,
  startedAt: string,
  snapshot: AppleMusicPlaylistSnapshot,
  results: ImportResult[],
  phase: ImportReport['phase'],
  playlistUnchanged?: boolean,
): ImportReport {
  const { tracks: _tracks, ...playlist } = snapshot;
  return {
    schemaVersion: 1,
    mode: options.apply ? 'apply' : 'dry-run',
    phase,
    completed: phase === 'complete',
    startedAt,
    finishedAt: new Date().toISOString(),
    playlist,
    selectedExactKeys: results.length,
    ...(playlistUnchanged === undefined ? {} : { playlistUnchanged }),
    summary: statusCounts(results),
    items: results.map(publicResult),
  };
}

function retryableWrite(error: unknown): boolean {
  const reason = typeof error === 'object' && error !== null
    ? (error as { reason?: unknown }).reason
    : undefined;
  return reason === 'timeout' || reason === 'network' || reason === 'server';
}

async function writeExact(
  remote: SupabaseLyricsClient,
  result: ImportResult,
): Promise<ImportResult> {
  if (result.status !== 'ready' || !result.payload) return result;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await remote.upsertExact({
          track: result.item.track,
          exactKey: result.exactKey,
          keyVersion: LYRICS_FINGERPRINT_VERSION,
          cached: {
            payload: result.payload,
            lookupStrategy: result.lookupStrategy ?? LYRICS_LOOKUP_STRATEGY,
            metadataSignature: result.exactKey,
            expiresAt: Date.now() + POSITIVE_CACHE_MS,
          },
          trust: 'active',
          sourceKind: 'automatic',
        });
        break;
      } catch (error) {
        if (attempt === 2 || !retryableWrite(error)) throw error;
        await abortableDelay(1_000 * (2 ** attempt));
      }
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const verified = await resolveExisting(remote, result.item.track);
      if (
        verified.state === 'hit' &&
        verified.matchKind === 'exact' &&
        verified.payload.provider === 'lrclib' &&
        verified.payload.providerId === result.payload.providerId
      ) {
        return { ...result, status: 'written' };
      }
      if (verified.state === 'hit' || verified.state === 'ambiguous') {
        return { ...result, status: 'verify-failed', reason: 'unexpected_active_binding' };
      }
      if (attempt < 2) await abortableDelay(500 * (2 ** attempt));
    }
    return { ...result, status: 'verify-failed', reason: 'active_binding_not_resolved' };
  } catch (error) {
    return { ...result, status: 'write-failed', reason: safeError(error) };
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const nativeFetch = globalThis.fetch;
  const location = parseAppleMusicPlaylistUrl(options.playlistUrl);
  const developerToken = await appleDeveloperToken();
  console.log(`Fetching Apple Music playlist ${location.playlistId} from ${location.storefront}...`);
  const snapshot = await fetchAppleMusicPlaylist(location, {
    developerToken,
    fetcher: nativeFetch,
  });
  const selectedTracks = options.limit
    ? snapshot.tracks.slice(0, options.limit)
    : snapshot.tracks;
  console.log(JSON.stringify({
    sourceTracks: snapshot.sourceTrackCount,
    uniqueAppleSongs: snapshot.uniqueAppleSongCount,
    uniqueExactKeys: snapshot.uniqueExactKeyCount,
    selectedExactKeys: selectedTracks.length,
    checksum: snapshot.checksum,
  }));

  const remote = supabaseClient(options, nativeFetch);
  const store = new JsonStore();
  const repository = new LyricsRepository(store, {
    mode: 'primary',
    memoryMaxEntries: Math.max(1, selectedTracks.length),
    memoryMaxBytes: 64 * 1_024 * 1_024,
    legacyMaxEntries: 0,
    legacyMaxBytes: 0,
  });
  const service = new LyricsService(
    store,
    { resolve: async () => null, isConfigured: () => false },
    repository,
    { requestTimeoutMs: 12_000, lookupBudgetMs: 30_000 },
  );
  globalThis.fetch = lrclibLimitedFetch(nativeFetch, options.lrclibRequestsPerSecond);
  let completed = 0;
  let results: ImportResult[];
  try {
    results = await mapConcurrent(selectedTracks, options.concurrency, async (item) => {
      const exactKey = lyricsLookupFingerprint(item.track);
      let result: ImportResult;
      if (remote) {
        const existing = await resolveExisting(remote, item.track);
        if (existing.state === 'hit') {
          result = { item, exactKey, status: 'existing' };
        } else if (existing.state === 'ambiguous') {
          result = { item, exactKey, status: 'remote-ambiguous' };
        } else if (existing.state === 'unavailable') {
          result = { item, exactKey, status: 'remote-unavailable', reason: existing.reason };
        } else {
          result = await lookupLyrics(service, item, exactKey, options.lookupRetries);
        }
      } else {
        result = await lookupLyrics(service, item, exactKey, options.lookupRetries);
      }
      completed += 1;
      if (completed % 10 === 0 || completed === selectedTracks.length) {
        console.log(`Preflight ${completed}/${selectedTracks.length}`);
      }
      return result;
    });
  } finally {
    globalThis.fetch = nativeFetch;
  }

  console.log(`Preflight summary: ${JSON.stringify(statusCounts(results))}`);
  if (options.reportPath) {
    await writeReport(
      options.reportPath,
      reportFor(options, startedAt, snapshot, results, options.apply ? 'preflight' : 'complete'),
    );
  }
  if (!options.apply) {
    console.log('Dry-run complete; no Supabase writes were performed.');
    return;
  }
  if (!remote) throw new Error('Supabase client was not configured');

  const ready = results.filter((result) => result.status === 'ready');
  console.log(`Applying ${ready.length} verified Exact matches to Supabase...`);
  let written = 0;
  const resultIndexByKey = new Map(results.map((result, index) => [result.exactKey, index]));
  let checkpoint = Promise.resolve();
  await mapConcurrent(ready, options.concurrency, async (result) => {
    const next = await writeExact(remote, result);
    results[resultIndexByKey.get(result.exactKey)!] = next;
    written += 1;
    if (written % 10 === 0 || written === ready.length) {
      console.log(`Apply ${written}/${ready.length}`);
    }
    if (
      options.reportPath &&
      (written % 10 === 0 || written === ready.length || next.status !== 'written')
    ) {
      checkpoint = checkpoint.then(() => writeReport(
        options.reportPath!,
        reportFor(options, startedAt, snapshot, results, 'applying'),
      ));
      await checkpoint;
    }
    return next;
  });
  await checkpoint;
  if (options.reportPath) {
    await writeReport(
      options.reportPath,
      reportFor(options, startedAt, snapshot, results, 'applied-unverified'),
    );
  }

  const finalSnapshot = await fetchAppleMusicPlaylist(location, {
    developerToken,
    fetcher: nativeFetch,
  });
  const playlistUnchanged = finalSnapshot.checksum === snapshot.checksum;
  const writeFailed = results.some((result) =>
    result.status === 'write-failed' || result.status === 'verify-failed');
  const finalPhase: ImportReport['phase'] = !playlistUnchanged
    ? 'playlist-changed'
    : writeFailed
      ? 'failed'
      : 'complete';
  console.log(`Apply summary: ${JSON.stringify(statusCounts(results))}`);
  console.log(`Playlist unchanged during run: ${playlistUnchanged}`);
  if (options.reportPath) {
    await writeReport(
      options.reportPath,
      reportFor(options, startedAt, snapshot, results, finalPhase, playlistUnchanged),
    );
    console.log(`Report: ${options.reportPath}`);
  }
  if (!playlistUnchanged) {
    throw new Error('Apple Music playlist changed during the import');
  }
  if (writeFailed) {
    throw new Error('One or more Supabase writes failed verification');
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Playlist preload failed');
  process.exitCode = 1;
});
