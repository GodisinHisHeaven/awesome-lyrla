import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type {
  ArtworkLookupStatus,
  ArtworkPalette,
  LyricsCandidateMode,
  LyricsCandidateSet,
  LyricsPayload,
  PlaybackStatus,
  PlayerSnapshot,
  TrackMetadata,
} from '../shared/contracts.js';
import { parseLrc } from '../shared/lrc.js';
import { lyricsLookupFingerprint, trackFingerprint } from '../shared/track.js';
import {
  artworkFingerprint,
  fallbackArtworkPalette,
  type ArtworkPaletteService,
} from './artwork-palette-service.js';
import { config } from './config.js';
import type { LyricsService } from './lyrics-service.js';
import {
  playbackClockObservability,
  type PlaybackClockObservability,
} from './playback-clock-observability.js';
import {
  productionObservability,
  type ProductionObservability,
} from './production-observability.js';
import {
  NavigationState,
  type NavigationField,
} from './navigation-state.js';
import type { StateStore } from './store.js';

export { NAVIGATION_STALE_AFTER_MS } from './navigation-state.js';

type SnapshotListener = (snapshot: PlayerSnapshot) => void;
type SerializedSnapshotListener = (snapshot: string) => void;
type AppleBackfillMetadataField = 'title' | 'artist' | 'album' | 'durationMs';
type AppleBackfillMetadataValue = string | number;
type LyricsResolutionReason =
  | 'metadata'
  | 'metadata-enrichment'
  | 'metadata-correction'
  | 'retry'
  | 'selection';

interface LyricsMetadataEpoch {
  id: number;
  startedAtMs: number;
  values: Map<AppleBackfillMetadataField, AppleBackfillMetadataValue>;
  observedFields: Set<AppleBackfillMetadataField>;
  backgroundRefresh: boolean;
  reason: LyricsResolutionReason;
}

interface LyricsResolutionOptions {
  bypassLocalCache?: boolean;
  resetRetry?: boolean;
  backgroundRefresh?: boolean;
  reason?: LyricsResolutionReason;
  requestedTrack?: TrackMetadata;
  settleMs?: number;
  metadataEpochId?: number;
}

interface AppleBackfillMetadataEpoch {
  id: number;
  values: Map<AppleBackfillMetadataField, AppleBackfillMetadataValue>;
  stableReplayFields: Set<AppleBackfillMetadataField>;
  inheritedFields: Set<AppleBackfillMetadataField>;
  cautiousInheritedFields: Set<AppleBackfillMetadataField>;
}

interface PendingAppleBackfillObservation {
  fingerprint: string;
  track: TrackMetadata;
  epochId: number;
}

interface PreviousPlaybackClock {
  elapsedMs: number;
  capturedAtMs: number;
  playing: boolean;
  trusted: boolean;
}

interface PendingPlaybackClockSample {
  generation: number;
  elapsedMs: number;
  capturedAtMs: number;
}

type ArtworkFallbackStatus = Extract<ArtworkLookupStatus, { state: 'fallback' }>;

const DEMO_TRACK: TrackMetadata = {
  title: 'Midnight Circuit',
  artist: 'Local Drive',
  album: 'After Dark',
  durationMs: 152_000,
  source: 'Apple Music',
};

const DEMO_LRC = `[00:00.00]Streetlights draw a silver line
[00:08.00]The city folds behind the glass
[00:17.00]Every signal keeps the time
[00:27.00]Every shadow lets us pass
[00:38.00]Hold the moment at the horizon
[00:49.00]Let the quiet engine sing
[01:01.00]Blue reflections on the dashboard
[01:13.00]Morning waits beyond the ring
[01:25.00]One more mile beneath the starlight
[01:37.00]One more chorus, then we turn
[01:50.00]Road and rhythm moving with us
[02:03.00]Till the eastern windows burn`;

const DEMO_LYRICS: LyricsPayload = {
  kind: 'synced',
  lines: parseLrc(DEMO_LRC).lines,
  provider: 'demo',
  notice: '原创演示歌词',
};

const FIELD_MAP: Record<string, keyof TrackMetadata | 'elapsedMs' | 'status'> = {
  MediaNowPlayingTitle: 'title',
  MediaNowPlayingArtist: 'artist',
  MediaNowPlayingAlbum: 'album',
  MediaNowPlayingDuration: 'durationMs',
  MediaNowPlayingElapsed: 'elapsedMs',
  MediaPlaybackSource: 'source',
  MediaPlaybackStatus: 'status',
};

const LYRIC_RETRY_DELAYS_MS = [5_000, 30_000, 120_000] as const;
export const LYRICS_METADATA_DEBOUNCE_MS = 200;
export const LYRICS_INCOMPLETE_METADATA_SETTLE_MS = 900;
export const LYRICS_TRANSITION_INCOMPLETE_SETTLE_MS = 1_250;
const LYRICS_METADATA_BURST_WINDOW_MS = 500;
const ARTWORK_RETRY_DELAYS_MS = [5_000, 30_000, 120_000] as const;
const ARTWORK_CACHE_PROBE_MIN_SETTLE_MS = 350;
const ARTWORK_METADATA_DEBOUNCE_MS = 650;
const ARTWORK_INCOMPLETE_METADATA_SETTLE_MS = 2_000;
const ARTWORK_STALE_PALETTE_GRACE_MS = 5_000;
const ARTWORK_MISSING_TITLE_GRACE_MS = 5_000;
// Fleet Telemetry has no packet/track epoch. A sample that remains close to
// the previous track's predicted position is therefore ambiguous and must not
// unlock auto-scroll for a replacement track.
const PREVIOUS_CLOCK_TRAJECTORY_TOLERANCE_MS = 5_000;
const PLAYBACK_CLOCK_CONTINUITY_TOLERANCE_MS = 2_500;
const PLAYBACK_CLOCK_STRONG_RESET_MS = 5_000;
const PLAYBACK_CLOCK_NEW_TRACK_START_MAX_MS = 10_000;
const PLAYBACK_CLOCK_TRANSITION_GRACE_MS = 3_000;
// Tesla samples these fields once per second but publishes them independently.
// Require two stable intervals, then abandon any unconfirmed assembly after five seconds.
const APPLE_BACKFILL_DEBOUNCE_MS = 2_000;
const APPLE_BACKFILL_CAUTIOUS_INHERIT_DEBOUNCE_MS = 3_000;
const APPLE_BACKFILL_EPOCH_MAX_AGE_MS = 5_000;
const APPLE_BACKFILL_RADIO_DURATION_MS = 18_000_000;
const APPLE_BACKFILL_MAX_DURATION_MS = 24 * 60 * 60 * 1_000;
const APPLE_BACKFILL_METADATA_FIELDS = [
  'title',
  'artist',
  'album',
  'durationMs',
] as const satisfies readonly AppleBackfillMetadataField[];

function playerError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}

function valueFromTelemetry(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const object = value as Record<string, unknown>;
  for (const key of ['value', 'stringValue', 'intValue', 'longValue', 'doubleValue']) {
    if (object[key] !== undefined) return object[key];
  }
  return value;
}

function numericTelemetryValue(value: unknown): number | null {
  if (
    typeof value !== 'number'
    && (typeof value !== 'string' || value.trim().length === 0)
  ) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function invalidTelemetryValue(rawValue: unknown, value: unknown): boolean {
  if (typeof value === 'string' && value.trim().toLowerCase() === 'invalid') return true;
  return [rawValue, value].some((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    return Object.entries(candidate as Record<string, unknown>).some(([key, entry]) =>
      key.toLowerCase().includes('invalid')
      && entry !== false
      && entry !== null
      && entry !== undefined,
    );
  });
}

function playbackStatus(value: unknown): PlaybackStatus {
  const normalized = String(value ?? '').toLowerCase();
  if (normalized.includes('playing') || normalized === 'play') return 'playing';
  if (normalized.includes('paused') || normalized === 'pause') return 'paused';
  if (normalized.includes('stopped') || normalized === 'stop') return 'stopped';
  return 'unknown';
}

function comparableTelemetryText(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/\s+/g, ' ');
}

function appleBackfillValuesEqual(
  field: AppleBackfillMetadataField,
  left: AppleBackfillMetadataValue,
  right: AppleBackfillMetadataValue,
): boolean {
  if (field === 'durationMs') return Number(left) === Number(right);
  return comparableTelemetryText(String(left)) === comparableTelemetryText(String(right));
}

function canObserveAppleBackfill(track: TrackMetadata | null): track is TrackMetadata {
  return Boolean(
    track
    && track.title.trim()
    && track.artist.trim()
    && track.album.trim()
    && Number.isFinite(track.durationMs)
    && track.durationMs > 0
    && track.durationMs <= APPLE_BACKFILL_MAX_DURATION_MS
    && track.durationMs !== APPLE_BACKFILL_RADIO_DURATION_MS,
  );
}

function exactTrackIdentity(track: TrackMetadata | null): string {
  if (!track?.title.trim()) return '';
  return lyricsLookupFingerprint(track);
}

function hasUsableLyrics(lyrics: LyricsPayload): boolean {
  return (
    (lyrics.kind === 'synced' || lyrics.kind === 'plain')
    && lyrics.lines.length > 0
  );
}

function lyricsTrackIdentityContradicts(
  presented: TrackMetadata,
  candidate: TrackMetadata,
): boolean {
  if (
    presented.title.trim()
    && candidate.title.trim()
    && comparableTelemetryText(presented.title)
      !== comparableTelemetryText(candidate.title)
  ) return true;
  if (
    presented.artist.trim()
    && candidate.artist.trim()
    && comparableTelemetryText(presented.artist)
      !== comparableTelemetryText(candidate.artist)
  ) return true;
  return (
    presented.durationMs > 0
    && candidate.durationMs > 0
    && Math.round(presented.durationMs / 2_000)
      !== Math.round(candidate.durationMs / 2_000)
  );
}

function lyricsMetadataSettleMs(track: TrackMetadata): number {
  const waitingForAlbum = track.artist.trim().length > 0
    && !track.album.trim()
    && Number.isFinite(track.durationMs)
    && track.durationMs > 0;
  return waitingForAlbum
    ? LYRICS_INCOMPLETE_METADATA_SETTLE_MS
    : LYRICS_METADATA_DEBOUNCE_MS;
}

function lyricsVersionDigest(lyrics: LyricsPayload): string | null {
  if (!hasUsableLyrics(lyrics)) return null;
  return createHash('sha256').update(JSON.stringify({
    kind: lyrics.kind,
    provider: lyrics.provider,
    providerId: lyrics.providerId,
    fallbackKind: lyrics.fallbackKind,
    lines: lyrics.lines.map((line) => [line.startMs, line.text]),
  })).digest('hex').slice(0, 16);
}

function stableLyricsAfterRefresh(
  current: LyricsPayload,
  refreshed: LyricsPayload,
): LyricsPayload {
  const stable = { ...current };
  if (refreshed.retryable) stable.retryable = true;
  else delete stable.retryable;

  if (refreshed.kind === 'missing' && refreshed.notice) {
    stable.notice = refreshed.notice;
  } else if (hasUsableLyrics(refreshed) && !current.fallbackKind) {
    if (refreshed.notice) stable.notice = refreshed.notice;
    else delete stable.notice;
  }
  return stable;
}

export class PlayerCoordinator {
  private listeners = new Set<SnapshotListener>();
  private serializedListeners = new Set<SerializedSnapshotListener>();
  private disposed = false;
  private connection: PlayerSnapshot['connection'] = config.demoMode ? 'demo' : 'waiting';
  private track: TrackMetadata | null = config.demoMode ? DEMO_TRACK : null;
  private lyrics: LyricsPayload = config.demoMode
    ? DEMO_LYRICS
    : { kind: 'missing', lines: [], provider: null };
  private status: PlaybackStatus = config.demoMode ? 'playing' : 'unknown';
  private elapsedMs = config.demoMode ? 24_000 : 0;
  private capturedAtMs = Date.now();
  private trackGeneration = config.demoMode ? 1 : 0;
  private lyricsGeneration = config.demoMode ? 1 : 0;
  private playbackClockReady = config.demoMode;
  private playbackClockEvidenceCount = config.demoMode ? 2 : 0;
  private previousPlaybackClocks: PreviousPlaybackClock[] = [];
  private pendingPlaybackClockSample?: PendingPlaybackClockSample;
  private lastPlaybackClockInvalidationAtMs = 0;
  private snapshotRevision = Date.now() * 1_000;
  private activeFingerprint = config.demoMode ? trackFingerprint(DEMO_TRACK) : '';
  private lookupSequence = 0;
  private identityTimer?: NodeJS.Timeout;
  private activeLyricsMetadata = config.demoMode
    ? lyricsLookupFingerprint(DEMO_TRACK)
    : '';
  private activeLyricsTrack: TrackMetadata | null = config.demoMode
    ? { ...DEMO_TRACK }
    : null;
  private presentedLyricsTrack: TrackMetadata | null = config.demoMode
    ? { ...DEMO_TRACK }
    : null;
  private pendingLyricsTrack?: TrackMetadata;
  private pendingLyricsMetadataEpochId?: number;
  private lyricsMetadataEpoch?: LyricsMetadataEpoch;
  private lyricsMetadataEpochSequence = 0;
  private bypassLyricsCache = false;
  private backgroundLyricsRefresh = false;
  private lyricsResolutionReason: LyricsResolutionReason = 'metadata';
  private lyricRetryTimer?: NodeJS.Timeout;
  private lyricRetryAttempt = 0;
  private appleBackfillTimer?: NodeJS.Timeout;
  private appleBackfillEpochTimer?: NodeJS.Timeout;
  private pendingAppleBackfillObservation?: PendingAppleBackfillObservation;
  private observedAppleBackfillFingerprint = '';
  private stableAppleBackfillTrack: TrackMetadata | null = null;
  private stableAppleBackfillReplayAt = new Map<AppleBackfillMetadataField, number>();
  private appleBackfillEpoch?: AppleBackfillMetadataEpoch;
  private appleBackfillEpochSequence = 0;
  private artworkPalette: ArtworkPalette | null = null;
  private artworkLookup: ArtworkLookupStatus = { state: 'idle' };
  private activeArtworkFingerprint = config.demoMode ? artworkFingerprint(DEMO_TRACK) : '';
  private activeArtworkLookup: ArtworkLookupStatus = config.demoMode
    ? { state: 'success', source: 'catalog' }
    : { state: 'idle' };
  private pendingArtworkFingerprint = '';
  private artworkLookupSequence = 0;
  private artworkAbortController?: AbortController;
  private artworkCacheProbeAbortController?: AbortController;
  private artworkCacheProbeFingerprint = '';
  private artworkDeliveryFingerprint = '';
  private artworkDeliveryStartedAtMs = 0;
  private artworkResolutionRecorded = false;
  private artworkTimer?: NodeJS.Timeout;
  private artworkRetryTimer?: NodeJS.Timeout;
  private artworkRetryAttempt = 0;
  private artworkRetryFingerprint = '';
  private artworkMetadataEpochOpen = false;
  private readonly artworkMetadataObservedFields = new Set<AppleBackfillMetadataField>();
  private artworkStalePaletteTimer?: NodeJS.Timeout;
  private artworkStalePaletteFingerprint = '';
  private artworkStalePaletteTrack: TrackMetadata | null = null;
  private artworkStalePaletteDeadlineMs = 0;
  private artworkMissingTitleTimer?: NodeJS.Timeout;
  private readonly navigationState: NavigationState;
  private telemetryPublishTimer?: NodeJS.Immediate;
  private demoTimer?: NodeJS.Timeout;

  constructor(
    private readonly lyricsService: LyricsService,
    private readonly artworkPaletteService: ArtworkPaletteService,
    private readonly store: StateStore,
    private readonly clockObservability: PlaybackClockObservability = playbackClockObservability,
    private readonly observability: ProductionObservability = productionObservability,
  ) {
    this.navigationState = new NavigationState(() => this.publish());
    if (config.demoMode) {
      this.demoTimer = setInterval(() => this.publish(), 1_000);
      this.demoTimer.unref();
    }
  }

  snapshot(): PlayerSnapshot {
    const now = Date.now();
    return {
      mode: config.demoMode ? 'demo' : 'live',
      connection: this.connection,
      track: this.track,
      playbackStatus: this.status,
      elapsedMs: this.currentElapsedMs(now),
      capturedAtMs: now,
      trackGeneration: this.trackGeneration,
      lyricsGeneration: this.lyricsGeneration,
      lyricsTrackMatchesCurrent: this.lyricsTrackMatchesCurrent(),
      playbackClockReady: this.playbackClockReady,
      snapshotRevision: this.snapshotRevision,
      manualOffsetMs: this.track ? this.lyricsService.getOffset(this.track) : 0,
      lyrics: this.lyrics,
      artworkPalette: this.artworkPalette,
      artworkLookup: this.artworkLookup,
      navigation: this.navigationSnapshot(now),
      vehicleName: this.store.readSelectedVehicleName() ?? undefined,
    };
  }

  private lyricsTrackMatchesCurrent(): boolean {
    if (!this.presentedLyricsTrack?.title.trim()) {
      return !hasUsableLyrics(this.lyrics);
    }
    if (!this.track?.title.trim()) return false;
    return !lyricsTrackIdentityContradicts(
      this.presentedLyricsTrack,
      this.track,
    );
  }

  subscribe(listener: SnapshotListener): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  subscribeSerialized(listener: SerializedSnapshotListener): () => void {
    if (this.disposed) return () => undefined;
    this.serializedListeners.add(listener);
    listener(JSON.stringify(this.snapshot()));
    return () => this.serializedListeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    this.serializedListeners.clear();
    if (this.identityTimer) clearTimeout(this.identityTimer);
    if (this.lyricRetryTimer) clearTimeout(this.lyricRetryTimer);
    if (this.appleBackfillTimer) clearTimeout(this.appleBackfillTimer);
    if (this.appleBackfillEpochTimer) clearTimeout(this.appleBackfillEpochTimer);
    if (this.artworkTimer) clearTimeout(this.artworkTimer);
    if (this.artworkRetryTimer) clearTimeout(this.artworkRetryTimer);
    if (this.artworkStalePaletteTimer) clearTimeout(this.artworkStalePaletteTimer);
    if (this.artworkMissingTitleTimer) clearTimeout(this.artworkMissingTitleTimer);
    this.navigationState.dispose();
    if (this.telemetryPublishTimer) clearImmediate(this.telemetryPublishTimer);
    if (this.demoTimer) clearInterval(this.demoTimer);
    this.artworkAbortController?.abort();
    this.artworkCacheProbeAbortController?.abort();
    this.identityTimer = undefined;
    this.lyricRetryTimer = undefined;
    this.appleBackfillTimer = undefined;
    this.appleBackfillEpochTimer = undefined;
    this.artworkTimer = undefined;
    this.artworkRetryTimer = undefined;
    this.artworkStalePaletteTimer = undefined;
    this.artworkMissingTitleTimer = undefined;
    this.telemetryPublishTimer = undefined;
    this.demoTimer = undefined;
    this.artworkAbortController = undefined;
    this.artworkCacheProbeAbortController = undefined;
    this.previousPlaybackClocks = [];
    this.stableAppleBackfillReplayAt.clear();
    this.artworkMetadataObservedFields.clear();
  }

  private publish(): void {
    if (this.disposed) return;
    if (this.telemetryPublishTimer) {
      clearImmediate(this.telemetryPublishTimer);
      this.telemetryPublishTimer = undefined;
    }
    this.snapshotRevision = Math.max(this.snapshotRevision + 1, Date.now() * 1_000);
    if (this.listeners.size === 0 && this.serializedListeners.size === 0) return;
    const current = this.snapshot();
    for (const listener of this.listeners) listener(current);
    if (this.serializedListeners.size > 0) {
      const serialized = JSON.stringify(current);
      for (const listener of this.serializedListeners) listener(serialized);
    }
  }

  private scheduleTelemetryPublish(): void {
    if (this.telemetryPublishTimer) return;
    const timer = setImmediate(() => {
      if (this.telemetryPublishTimer !== timer) return;
      this.telemetryPublishTimer = undefined;
      this.publish();
    });
    timer.unref();
    this.telemetryPublishTimer = timer;
  }

  setConnection(connected: boolean): void {
    if (config.demoMode) return;
    const nextConnection = connected ? 'connected' : 'offline';
    if (this.connection === nextConnection) return;
    this.connection = nextConnection;
    this.scheduleTelemetryPublish();
  }

  selectedVin(): string | null {
    return this.store.readSelectedVin() ?? config.tesla.allowedVin ?? null;
  }

  ingest(vin: string, field: string, rawValue: unknown): void {
    if (config.demoMode) return;
    const selectedVin = this.selectedVin();
    if (selectedVin && vin !== selectedVin) return;
    if (
      field === 'DestinationName'
      || field === 'MinutesToArrival'
      || field === 'MilesToArrival'
      || field === 'ExpectedEnergyPercentAtTripArrival'
    ) {
      this.ingestNavigation(field, rawValue);
      return;
    }
    const mapped = FIELD_MAP[field];
    if (!mapped) return;
    const now = Date.now();
    const value = valueFromTelemetry(rawValue);
    const numericValue = mapped === 'elapsedMs' || mapped === 'durationMs'
      ? numericTelemetryValue(value)
      : undefined;
    if (
      (mapped === 'elapsedMs' || mapped === 'durationMs')
      && numericValue === null
    ) return;
    const appleBackfillField = APPLE_BACKFILL_METADATA_FIELDS.includes(
      mapped as AppleBackfillMetadataField,
    )
      ? mapped as AppleBackfillMetadataField
      : null;
    const nextDuration = appleBackfillField === 'durationMs' ? numericValue ?? null : null;
    const validAppleBackfillField = appleBackfillField !== 'durationMs'
      || Number.isFinite(nextDuration);
    const appleBackfillFieldChanged = appleBackfillField === 'durationMs'
      ? validAppleBackfillField && nextDuration !== this.track?.durationMs
      : appleBackfillField !== null
        && comparableTelemetryText(this.track?.[appleBackfillField] as string ?? '')
          !== comparableTelemetryText(String(value ?? ''));
    const previousExactIdentity = appleBackfillField
      ? exactTrackIdentity(this.track)
      : '';
    const previousAlbumIdentity = appleBackfillField === 'album'
      ? comparableTelemetryText(this.track?.album ?? '')
      : '';
    const previousClockElapsed = appleBackfillField && this.playbackClockReady
      ? this.currentElapsedMs(now)
      : null;
    const previousClockPlaying = this.status === 'playing';

    if (mapped === 'elapsedMs') {
      this.ingestPlaybackElapsed(Math.max(0, numericValue!), now);
    } else if (mapped === 'status') {
      const anchored = this.currentElapsedMs(now);
      this.elapsedMs = anchored;
      this.capturedAtMs = now;
      this.status = playbackStatus(value);
    } else if (mapped === 'durationMs') {
      this.ensureTrack();
      if (this.track) this.track.durationMs = Math.max(0, numericValue!);
    } else {
      this.ensureTrack();
      if (this.track) this.track[mapped] = String(value ?? '') as never;
    }

    if (appleBackfillField) {
      const nextExactIdentity = exactTrackIdentity(this.track);
      if (nextExactIdentity !== previousExactIdentity) {
        const invalidatesPlaybackClock = appleBackfillField !== 'album'
          || Boolean(previousAlbumIdentity);
        this.advanceTrackGeneration({
          invalidatesPlaybackClock,
          now,
          previousClockElapsed,
          previousClockPlaying,
        });
      }
    }

    this.connection = 'connected';
    if (appleBackfillField) {
      this.scheduleLyricsMetadataResolution(
        appleBackfillField,
        appleBackfillFieldChanged,
      );
    }
    if (appleBackfillField) {
      if (validAppleBackfillField) {
        const metadataValue = appleBackfillField === 'durationMs'
          ? Number(value)
          : String(value ?? '');
        this.ingestAppleBackfillMetadata(appleBackfillField, metadataValue);
      }
      this.scheduleArtworkResolution(
        appleBackfillField,
        appleBackfillFieldChanged,
      );
    }
    this.scheduleTelemetryPublish();
  }

  private navigationSnapshot(now = Date.now()) {
    return this.navigationState.snapshot(now);
  }

  private ingestNavigation(
    field: NavigationField,
    rawValue: unknown,
  ): void {
    const now = Date.now();
    const wasConnected = this.connection === 'connected';
    const value = valueFromTelemetry(rawValue);
    const update = this.navigationState.ingest(
      field,
      typeof value === 'string' || typeof value === 'number' ? value : null,
      invalidTelemetryValue(rawValue, value),
      now,
    );
    if (!update.accepted) return;
    this.connection = 'connected';
    if (update.changed || !wasConnected) this.scheduleTelemetryPublish();
  }

  private ensureTrack(): void {
    if (!this.track) {
      this.track = { title: '', artist: '', album: '', durationMs: 0, source: '' };
    }
  }

  private currentElapsedMs(now = Date.now()): number {
    let elapsed = this.elapsedMs;
    if (this.status === 'playing' && this.playbackClockReady) {
      elapsed += now - this.capturedAtMs;
    }
    const duration = this.track?.durationMs ?? 0;
    if (duration > 0) elapsed = Math.min(duration, Math.max(0, elapsed));
    return elapsed;
  }

  private advanceTrackGeneration({
    invalidatesPlaybackClock,
    now,
    previousClockElapsed,
    previousClockPlaying,
  }: {
    invalidatesPlaybackClock: boolean;
    now: number;
    previousClockElapsed: number | null;
    previousClockPlaying: boolean;
  }): void {
    this.trackGeneration += 1;
    this.pendingPlaybackClockSample = undefined;
    if (!invalidatesPlaybackClock) return;

    if (this.playbackClockReady && previousClockElapsed !== null) {
      const previousClock = {
        elapsedMs: previousClockElapsed,
        capturedAtMs: now,
        playing: previousClockPlaying,
        trusted: this.playbackClockEvidenceCount >= 2,
      };
      const preservesTransitionRoots = this.previousPlaybackClocks.length > 0
        && now - this.lastPlaybackClockInvalidationAtMs
          <= PLAYBACK_CLOCK_TRANSITION_GRACE_MS;
      if (!preservesTransitionRoots) {
        this.previousPlaybackClocks = [previousClock];
      } else {
        const duplicatesExistingRoot = this.previousPlaybackClocks.some((candidate) => {
          const predictedElapsed = candidate.elapsedMs
            + (candidate.playing ? now - candidate.capturedAtMs : 0);
          return Math.abs(predictedElapsed - previousClockElapsed)
            <= PREVIOUS_CLOCK_TRAJECTORY_TOLERANCE_MS;
        });
        if (!duplicatesExistingRoot) {
          this.previousPlaybackClocks = [
            ...this.previousPlaybackClocks,
            previousClock,
          ].slice(-4);
        }
      }
      this.elapsedMs = previousClockElapsed;
      this.capturedAtMs = now;
    }
    this.lastPlaybackClockInvalidationAtMs = now;
    this.playbackClockReady = false;
    this.playbackClockEvidenceCount = 0;
  }

  private ingestPlaybackElapsed(elapsedMs: number, now: number): void {
    if (this.playbackClockReady) {
      const previousClocks = this.previousPlaybackClocks;
      const withinTransitionGrace = previousClocks.length > 0
        && now - this.lastPlaybackClockInvalidationAtMs
          <= PLAYBACK_CLOCK_TRANSITION_GRACE_MS;
      if (withinTransitionGrace) {
        const currentElapsed = this.currentElapsedMs(now);
        const matchesPreviousClock = previousClocks.some((previousClock) => {
          const previousElapsed = previousClock.elapsedMs
            + (previousClock.playing ? now - previousClock.capturedAtMs : 0);
          return Math.abs(elapsedMs - previousElapsed)
            <= PREVIOUS_CLOCK_TRAJECTORY_TOLERANCE_MS;
        });
        if (
          matchesPreviousClock
          && Math.abs(elapsedMs - currentElapsed)
            > PREVIOUS_CLOCK_TRAJECTORY_TOLERANCE_MS
        ) {
          // A reset from B can arrive before an older in-flight A sample.
          // Retaining the transition root lets us reject that reverse order
          // without moving the already-confirmed B clock back onto A.
          this.clockObservability.observeTransitionRejected();
          return;
        }
      }
      const currentElapsed = this.currentElapsedMs(now);
      const deltaMs = elapsedMs - currentElapsed;
      if (deltaMs <= -250) {
        this.clockObservability.observeBackwardSample({
          deltaMs,
          decision: (
            this.status === 'paused'
            || this.status === 'stopped'
            || Math.abs(deltaMs) <= PREVIOUS_CLOCK_TRAJECTORY_TOLERANCE_MS
          ) ? 'accepted' : 'pending',
          playbackStatus: this.status,
          trackGeneration: this.trackGeneration,
        });
      }
      if (
        Math.abs(deltaMs)
          > PREVIOUS_CLOCK_TRAJECTORY_TOLERANCE_MS
      ) {
        if (this.status === 'paused' || this.status === 'stopped') {
          this.acceptPlaybackClock(elapsedMs, now);
          return;
        }
        const pending = this.pendingPlaybackClockSample;
        if (
          pending
          && pending.generation === this.trackGeneration
          && this.playbackClockSamplesAreContinuous(pending, elapsedMs, now)
        ) {
          this.acceptPlaybackClock(elapsedMs, now, 2);
          return;
        }
        this.pendingPlaybackClockSample = {
          generation: this.trackGeneration,
          elapsedMs,
          capturedAtMs: now,
        };
        return;
      }
      this.pendingPlaybackClockSample = undefined;
      if (
        previousClocks.length > 0
        && now - this.lastPlaybackClockInvalidationAtMs
          > PLAYBACK_CLOCK_TRANSITION_GRACE_MS
      ) {
        this.previousPlaybackClocks = [];
      }
      this.elapsedMs = elapsedMs;
      this.capturedAtMs = now;
      this.playbackClockEvidenceCount = Math.min(
        2,
        this.playbackClockEvidenceCount + 1,
      );
      return;
    }

    if (!exactTrackIdentity(this.track)) {
      this.elapsedMs = elapsedMs;
      this.capturedAtMs = now;
      return;
    }

    const previousClocks = this.previousPlaybackClocks;
    if (previousClocks.length === 0) {
      const pending = this.pendingPlaybackClockSample;
      if (pending && pending.generation === this.trackGeneration) {
        if (this.playbackClockSamplesAreContinuous(pending, elapsedMs, now)) {
          this.acceptPlaybackClock(elapsedMs, now, 2);
        } else {
          this.pendingPlaybackClockSample = {
            generation: this.trackGeneration,
            elapsedMs,
            capturedAtMs: now,
          };
        }
        return;
      }
      this.acceptPlaybackClock(elapsedMs, now);
      return;
    }
    if (
      now - this.lastPlaybackClockInvalidationAtMs
        >= PLAYBACK_CLOCK_TRANSITION_GRACE_MS
    ) {
      // MQTT supplies no cross-topic packet id. Once the reorder window has
      // elapsed, require two continuous samples to regain liveness without
      // allowing one stale packet to move the clock.
      this.previousPlaybackClocks = [];
      this.pendingPlaybackClockSample = {
        generation: this.trackGeneration,
        elapsedMs,
        capturedAtMs: now,
      };
      return;
    }

    const previousClockPositions = previousClocks.map((previousClock) => ({
      elapsedMs: previousClock.elapsedMs
        + (previousClock.playing ? now - previousClock.capturedAtMs : 0),
      trusted: previousClock.trusted,
    }));
    const matchesPreviousClock = previousClockPositions.some((previousClock) =>
      Math.abs(elapsedMs - previousClock.elapsedMs)
        <= PREVIOUS_CLOCK_TRAJECTORY_TOLERANCE_MS);
    if (matchesPreviousClock) {
      // This can still be a late sample from a previous song. Do not let it
      // become evidence for the new generation.
      this.pendingPlaybackClockSample = undefined;
      return;
    }
    const isStrongReset = previousClockPositions.some((previousClock) =>
      previousClock.trusted
      && previousClock.elapsedMs - elapsedMs >= PLAYBACK_CLOCK_STRONG_RESET_MS)
      && elapsedMs <= PLAYBACK_CLOCK_NEW_TRACK_START_MAX_MS;
    if (isStrongReset) {
      this.acceptPlaybackClock(elapsedMs, now);
      return;
    }

    const pending = this.pendingPlaybackClockSample;
    if (
      pending
      && pending.generation === this.trackGeneration
      && this.playbackClockSamplesAreContinuous(pending, elapsedMs, now)
    ) {
      this.acceptPlaybackClock(elapsedMs, now, 2);
      return;
    }
    this.pendingPlaybackClockSample = {
      generation: this.trackGeneration,
      elapsedMs,
      capturedAtMs: now,
    };
  }

  private playbackClockSamplesAreContinuous(
    previous: PendingPlaybackClockSample,
    elapsedMs: number,
    now: number,
  ): boolean {
    const wallAdvanceMs = Math.max(0, now - previous.capturedAtMs);
    const mediaAdvanceMs = elapsedMs - previous.elapsedMs;
    if (mediaAdvanceMs < -PLAYBACK_CLOCK_CONTINUITY_TOLERANCE_MS) return false;
    const playingContinuity = Math.abs(mediaAdvanceMs - wallAdvanceMs)
      <= PLAYBACK_CLOCK_CONTINUITY_TOLERANCE_MS;
    const staticContinuity = Math.abs(mediaAdvanceMs)
      <= PLAYBACK_CLOCK_CONTINUITY_TOLERANCE_MS;
    if (this.status === 'playing') return playingContinuity;
    if (this.status === 'paused' || this.status === 'stopped') return staticContinuity;
    return playingContinuity || staticContinuity;
  }

  private acceptPlaybackClock(
    elapsedMs: number,
    now: number,
    evidenceCount = 1,
  ): void {
    this.elapsedMs = elapsedMs;
    this.capturedAtMs = now;
    this.playbackClockReady = true;
    this.playbackClockEvidenceCount = evidenceCount;
    this.pendingPlaybackClockSample = undefined;
  }

  private scheduleLyricsMetadataResolution(
    field: AppleBackfillMetadataField,
    fieldChanged: boolean,
  ): void {
    const currentTrack = this.track;
    if (!currentTrack) return;
    if (field === 'title' && !currentTrack.title.trim()) {
      this.lyricsMetadataEpoch = undefined;
      this.scheduleLyricsResolution({ requestedTrack: currentTrack });
      return;
    }

    if (!this.activeLyricsMetadata && !this.presentedLyricsTrack) {
      this.scheduleLyricsResolution({ requestedTrack: currentTrack });
      return;
    }

    let epoch = this.lyricsMetadataEpoch;
    const epochHasReplacementTitle = Boolean(
      epoch
      && epoch.observedFields.has('title')
      && this.presentedLyricsTrack
      && comparableTelemetryText(String(epoch.values.get('title') ?? ''))
        !== comparableTelemetryText(this.presentedLyricsTrack.title),
    );
    const startsFreshEpoch = !epoch
      ? fieldChanged
      : fieldChanged
        && epoch.observedFields.has(field)
        && (field === 'title' || !epochHasReplacementTitle);
    if (startsFreshEpoch) {
      const values = new Map<
        AppleBackfillMetadataField,
        AppleBackfillMetadataValue
      >();
      const inheritedTrack = this.presentedLyricsTrack ?? this.activeLyricsTrack;
      if (field !== 'title' && inheritedTrack?.title.trim()) {
        for (const metadataField of APPLE_BACKFILL_METADATA_FIELDS) {
          values.set(metadataField, inheritedTrack[metadataField]);
        }
      }
      epoch = {
        id: ++this.lyricsMetadataEpochSequence,
        startedAtMs: Date.now(),
        values,
        observedFields: new Set(),
        backgroundRefresh: hasUsableLyrics(this.lyrics),
        reason: hasUsableLyrics(this.lyrics)
          ? 'metadata-enrichment'
          : 'metadata-correction',
      };
      this.lyricsMetadataEpoch = epoch;
    }
    if (!epoch) return;

    const value = field === 'durationMs'
      ? currentTrack.durationMs
      : currentTrack[field];
    epoch.values.set(field, value);
    const validValue = field === 'durationMs'
      ? Number.isFinite(value) && Number(value) > 0
      : String(value).trim().length > 0;
    if (validValue) epoch.observedFields.add(field);
    else epoch.observedFields.delete(field);

    const candidateTitle = String(epoch.values.get('title') ?? '');
    if (
      candidateTitle.trim()
      && this.presentedLyricsTrack
      && comparableTelemetryText(candidateTitle)
        !== comparableTelemetryText(this.presentedLyricsTrack.title)
    ) {
      epoch.backgroundRefresh = false;
      epoch.reason = 'metadata';
      for (const metadataField of APPLE_BACKFILL_METADATA_FIELDS) {
        if (!epoch.observedFields.has(metadataField)) {
          epoch.values.delete(metadataField);
        }
      }
    }

    if (!candidateTitle.trim()) return;
    const requestedTrack: TrackMetadata = {
      title: candidateTitle,
      artist: String(epoch.values.get('artist') ?? ''),
      album: String(epoch.values.get('album') ?? ''),
      durationMs: Number(epoch.values.get('durationMs') ?? 0),
      source: currentTrack.source,
    };
    if (
      this.presentedLyricsTrack
      && lyricsTrackIdentityContradicts(
        this.presentedLyricsTrack,
        requestedTrack,
      )
    ) {
      epoch.backgroundRefresh = false;
      epoch.reason = 'metadata';
    }
    const completeMetadata = APPLE_BACKFILL_METADATA_FIELDS.every(
      (metadataField) => epoch.observedFields.has(metadataField),
    );
    const completedAsOneBurst = completeMetadata
      && Date.now() - epoch.startedAtMs <= LYRICS_METADATA_BURST_WINDOW_MS;
    this.scheduleLyricsResolution({
      bypassLocalCache:
        epoch.backgroundRefresh || epoch.reason === 'metadata-correction',
      resetRetry: fieldChanged,
      backgroundRefresh: epoch.backgroundRefresh,
      reason: epoch.reason,
      requestedTrack,
      settleMs: completedAsOneBurst
        ? LYRICS_METADATA_DEBOUNCE_MS
        : LYRICS_TRANSITION_INCOMPLETE_SETTLE_MS,
      metadataEpochId: epoch.id,
    });
  }

  private scheduleLyricsResolution(
    options: LyricsResolutionOptions = {},
  ): void {
    const requestedTrack = options.requestedTrack ?? this.track;
    if (!requestedTrack?.title.trim()) {
      this.lookupSequence += 1;
      this.activeFingerprint = '';
      this.activeLyricsMetadata = '';
      this.activeLyricsTrack = null;
      this.presentedLyricsTrack = null;
      this.pendingLyricsTrack = undefined;
      this.pendingLyricsMetadataEpochId = undefined;
      this.lyricsMetadataEpoch = undefined;
      this.clearLyricRetry(true);
      if (this.identityTimer) clearTimeout(this.identityTimer);
      this.identityTimer = undefined;
      this.bypassLyricsCache = false;
      this.backgroundLyricsRefresh = false;
      this.lyricsResolutionReason = 'metadata';
      this.lyrics = {
        kind: 'missing',
        lines: [],
        provider: null,
        notice: '等待 Tesla 提供歌曲信息。',
      };
      this.lyricsGeneration = this.trackGeneration;
      return;
    }

    const fingerprint = trackFingerprint(requestedTrack);
    const metadataFingerprint = lyricsLookupFingerprint(requestedTrack);
    if (fingerprint !== this.activeFingerprint) this.clearLyricRetry(true);
    else if (options.resetRetry) this.clearLyricRetry(true);
    if (
      metadataFingerprint === this.activeLyricsMetadata
      && !options.bypassLocalCache
    ) {
      if (this.lyricsMetadataEpoch?.id === options.metadataEpochId) {
        this.lyricsMetadataEpoch = undefined;
      }
      return;
    }

    this.lookupSequence += 1;
    this.pendingLyricsTrack = { ...requestedTrack };
    this.pendingLyricsMetadataEpochId = options.metadataEpochId;
    this.bypassLyricsCache = Boolean(options.bypassLocalCache);
    this.backgroundLyricsRefresh = Boolean(options.backgroundRefresh);
    this.lyricsResolutionReason = options.reason ?? 'metadata';
    if (this.identityTimer) clearTimeout(this.identityTimer);
    // Fleet Telemetry commonly delivers the fields of one track in a short burst.
    // A replacement epoch excludes old fields from the previous track. It can
    // use the fast path only when every field lands in one tight burst; fields
    // spread across sampling intervals require a quiet window so two adjacent
    // songs can never form one apparently complete lookup.
    this.identityTimer = setTimeout(
      () => this.maybeResolveLyrics(),
      options.settleMs ?? lyricsMetadataSettleMs(requestedTrack),
    );
    this.identityTimer.unref();
  }

  private maybeResolveLyrics(): void {
    this.identityTimer = undefined;
    const bypassLocalCache = this.bypassLyricsCache;
    const backgroundRefresh = this.backgroundLyricsRefresh;
    const resolutionReason = this.lyricsResolutionReason;
    const requestedTrack = this.pendingLyricsTrack
      ?? this.activeLyricsTrack
      ?? this.track;
    const metadataEpochId = this.pendingLyricsMetadataEpochId;
    this.pendingLyricsTrack = undefined;
    this.pendingLyricsMetadataEpochId = undefined;
    if (this.lyricsMetadataEpoch?.id === metadataEpochId) {
      this.lyricsMetadataEpoch = undefined;
    }
    this.bypassLyricsCache = false;
    this.backgroundLyricsRefresh = false;
    this.lyricsResolutionReason = 'metadata';
    if (!requestedTrack?.title.trim()) return;
    const fingerprint = trackFingerprint(requestedTrack);
    const requestedMetadata = lyricsLookupFingerprint(requestedTrack);
    if (requestedTrack.durationMs === APPLE_BACKFILL_RADIO_DURATION_MS) {
      this.activeFingerprint = fingerprint;
      this.activeLyricsMetadata = requestedMetadata;
      this.activeLyricsTrack = { ...requestedTrack };
      this.presentedLyricsTrack = { ...requestedTrack };
      this.lyrics = {
        kind: 'missing',
        lines: [],
        provider: null,
        notice: '当前来源看起来是广播，无法可靠同步逐行歌词。',
      };
      this.lyricsGeneration = this.trackGeneration;
      this.publish();
      return;
    }
    if (
      requestedMetadata === this.activeLyricsMetadata
      && !bypassLocalCache
    ) return;
    this.activeFingerprint = fingerprint;
    this.activeLyricsMetadata = requestedMetadata;
    this.activeLyricsTrack = { ...requestedTrack };
    const sequence = ++this.lookupSequence;
    const requestedGeneration = this.trackGeneration;
    const lyricsBeforeLookup = this.lyrics;
    if (!backgroundRefresh) {
      this.lyrics = { kind: 'loading', lines: [], provider: null };
      this.lyricsGeneration = requestedGeneration;
      this.publish();
    }
    const lookup = bypassLocalCache
      ? this.lyricsService.find(requestedTrack, { bypassLocalCache: true })
      : this.lyricsService.find(requestedTrack);
    void lookup
      .then((lyrics) => {
        if (sequence !== this.lookupSequence) {
          this.observability.observeStaleLyricsResult('sequence');
          return;
        }
        if (fingerprint !== this.activeFingerprint) {
          this.observability.observeStaleLyricsResult('fingerprint');
          return;
        }
        if (requestedGeneration !== this.trackGeneration) {
          this.observability.observeStaleLyricsResult('generation');
          return;
        }
        const previousLyrics = lyricsBeforeLookup;
        const preserveUsableLyrics = backgroundRefresh && hasUsableLyrics(previousLyrics);
        const action = preserveUsableLyrics
          ? 'pinned'
          : hasUsableLyrics(previousLyrics)
            ? 'replaced'
            : 'initial';
        this.observeLyricsVersionDecision(
          requestedTrack,
          previousLyrics,
          lyrics,
          resolutionReason,
          action,
        );
        this.lyrics = preserveUsableLyrics
          ? stableLyricsAfterRefresh(previousLyrics, lyrics)
          : lyrics;
        if (!preserveUsableLyrics) {
          this.presentedLyricsTrack = { ...requestedTrack };
        }
        this.lyricsGeneration = requestedGeneration;
        this.publish();
        if (lyrics.kind !== 'missing') {
          if (lyrics.retryable) this.scheduleLyricRetry(fingerprint);
          else this.clearLyricRetry(true);
          return;
        }
        if (lyrics.retryable) this.scheduleLyricRetry(fingerprint);
        else this.clearLyricRetry(true);
      })
      .catch((error: unknown) => {
        console.error('Lyrics resolution failed:', error);
        if (sequence !== this.lookupSequence) {
          this.observability.observeStaleLyricsResult('sequence');
          return;
        }
        if (fingerprint !== this.activeFingerprint) {
          this.observability.observeStaleLyricsResult('fingerprint');
          return;
        }
        if (requestedGeneration !== this.trackGeneration) {
          this.observability.observeStaleLyricsResult('generation');
          return;
        }
        const notice = '歌词查询没有完成，请稍后切歌或刷新重试。';
        this.lyrics = backgroundRefresh && hasUsableLyrics(lyricsBeforeLookup)
          ? { ...lyricsBeforeLookup, notice, retryable: true }
          : {
              kind: 'missing',
              lines: [],
              provider: null,
              notice,
              retryable: true,
            };
        if (!backgroundRefresh) {
          this.presentedLyricsTrack = { ...requestedTrack };
        }
        this.lyricsGeneration = requestedGeneration;
        this.publish();
        this.scheduleLyricRetry(fingerprint);
      });
  }

  private scheduleLyricRetry(fingerprint: string): void {
    if (this.lyricRetryTimer || this.lyricRetryAttempt >= LYRIC_RETRY_DELAYS_MS.length) return;
    const delay = LYRIC_RETRY_DELAYS_MS[this.lyricRetryAttempt];
    this.lyricRetryAttempt += 1;
    this.lyricRetryTimer = setTimeout(() => {
      this.lyricRetryTimer = undefined;
      if (
        this.activeFingerprint !== fingerprint ||
        !this.lyrics.retryable
      ) return;
      this.bypassLyricsCache = true;
      this.backgroundLyricsRefresh = true;
      this.lyricsResolutionReason = 'retry';
      this.maybeResolveLyrics();
    }, delay);
    this.lyricRetryTimer.unref();
  }

  private clearLyricRetry(resetAttempt: boolean): void {
    if (this.lyricRetryTimer) clearTimeout(this.lyricRetryTimer);
    this.lyricRetryTimer = undefined;
    if (resetAttempt) this.lyricRetryAttempt = 0;
  }

  private observeLyricsVersionDecision(
    track: TrackMetadata,
    current: LyricsPayload,
    refreshed: LyricsPayload,
    reason: LyricsResolutionReason,
    action: 'initial' | 'pinned' | 'replaced',
  ): void {
    if (!config.isProduction) return;
    const currentDigest = lyricsVersionDigest(current);
    const refreshedDigest = lyricsVersionDigest(refreshed);
    if (
      !refreshedDigest
      || (action === 'pinned' && currentDigest === refreshedDigest)
    ) return;
    this.observability.observeLyricsVersionTransition(
      action,
      current.provider,
      refreshed.provider,
    );
    this.observability.logLyricsVersionTransition({
      event: 'lyrics_version_transition',
      action,
      reason,
      trackHash: createHash('sha256')
        .update(lyricsLookupFingerprint(track))
        .digest('hex')
        .slice(0, 16),
      current: {
        digest: currentDigest ?? null,
        kind: current.kind,
        provider: current.provider,
        providerId: current.providerId ?? null,
        fallbackKind: current.fallbackKind ?? null,
      },
      refreshed: {
        digest: refreshedDigest,
        kind: refreshed.kind,
        provider: refreshed.provider,
        providerId: refreshed.providerId ?? null,
        fallbackKind: refreshed.fallbackKind ?? null,
      },
    });
  }

  private ingestAppleBackfillMetadata(
    field: AppleBackfillMetadataField,
    value: AppleBackfillMetadataValue,
  ): void {
    if (this.appleBackfillEpoch) {
      this.recordAppleBackfillEpochField(this.appleBackfillEpoch, field, value);
      return;
    }

    const stableTrack = this.stableAppleBackfillTrack;
    if (
      stableTrack
      && appleBackfillValuesEqual(field, stableTrack[field], value)
    ) {
      const now = Date.now();
      this.stableAppleBackfillReplayAt.set(field, now);
      const completedStableReplay = APPLE_BACKFILL_METADATA_FIELDS.every(
        (candidateField) => {
          const replayAt = this.stableAppleBackfillReplayAt.get(candidateField);
          return replayAt !== undefined
            && now - replayAt <= APPLE_BACKFILL_EPOCH_MAX_AGE_MS;
        },
      );
      if (completedStableReplay) this.stableAppleBackfillReplayAt.clear();
      return;
    }

    this.startAppleBackfillEpoch(field, value);
  }

  private startAppleBackfillEpoch(
    field: AppleBackfillMetadataField,
    value: AppleBackfillMetadataValue,
  ): void {
    const now = Date.now();
    const stableReplayFields = new Set<AppleBackfillMetadataField>();
    const inheritedFields = new Set<AppleBackfillMetadataField>();
    const cautiousInheritedFields = new Set<AppleBackfillMetadataField>();
    const values = new Map<AppleBackfillMetadataField, AppleBackfillMetadataValue>();
    const stableTrack = this.stableAppleBackfillTrack;
    const fieldMatchesStable = Boolean(
      stableTrack
      && appleBackfillValuesEqual(field, stableTrack[field], value),
    );
    if (fieldMatchesStable) {
      stableReplayFields.add(field);
    } else if (stableTrack) {
      for (const candidateField of APPLE_BACKFILL_METADATA_FIELDS) {
        if (candidateField === field) continue;
        const replayAt = this.stableAppleBackfillReplayAt.get(candidateField);
        if (
          replayAt !== undefined
          && now - replayAt <= APPLE_BACKFILL_EPOCH_MAX_AGE_MS
        ) {
          // This can be a partial previous-track resend immediately before the
          // identity change. Inherit it for liveness, but give replacement
          // fields one extra second to arrive before enqueueing the candidate.
          cautiousInheritedFields.add(candidateField);
        }
        values.set(candidateField, stableTrack[candidateField]);
        inheritedFields.add(candidateField);
      }
      this.stableAppleBackfillReplayAt.clear();
    }
    values.set(field, value);
    const epoch: AppleBackfillMetadataEpoch = {
      id: ++this.appleBackfillEpochSequence,
      values,
      stableReplayFields,
      inheritedFields,
      cautiousInheritedFields,
    };
    this.appleBackfillEpoch = epoch;
    this.armAppleBackfillEpochExpiry(epoch.id);
    this.tryArmAppleBackfillObservation(epoch);
  }

  private recordAppleBackfillEpochField(
    epoch: AppleBackfillMetadataEpoch,
    field: AppleBackfillMetadataField,
    value: AppleBackfillMetadataValue,
  ): void {
    const existing = epoch.values.get(field);
    if (
      existing !== undefined
      && !appleBackfillValuesEqual(field, existing, value)
    ) {
      if (epoch.inheritedFields.has(field)) {
        epoch.values.set(field, value);
        epoch.inheritedFields.delete(field);
        epoch.cautiousInheritedFields.delete(field);
        epoch.stableReplayFields.delete(field);
        this.stableAppleBackfillReplayAt.delete(field);
        this.tryArmAppleBackfillObservation(epoch);
        return;
      }
      // MQTT publishes each telemetry field independently and supplies no
      // packet/epoch identifier. Once an already-seen field changes, the other
      // values may belong to either side of a track boundary. Discard the whole
      // epoch instead of ever promoting a mixed exact key.
      this.cancelPendingAppleBackfillObservation();
      this.clearAppleBackfillEpoch(epoch.id);
      this.startAppleBackfillEpoch(field, value);
      return;
    }

    const wasInherited = epoch.inheritedFields.has(field);
    epoch.values.set(field, value);
    const stableTrack = this.stableAppleBackfillTrack;
    if (
      (existing === undefined || wasInherited)
      && stableTrack
      && appleBackfillValuesEqual(field, stableTrack[field], value)
    ) {
      // A direct value equal to the last verified track can be its delayed
      // 30-second resend. Even when we optimistically inherited that value,
      // the packet cannot confirm that it belongs to the replacement track.
      epoch.stableReplayFields.add(field);
    } else if (!wasInherited) {
      epoch.stableReplayFields.delete(field);
    }
    this.tryArmAppleBackfillObservation(epoch);
  }

  private tryArmAppleBackfillObservation(epoch: AppleBackfillMetadataEpoch): void {
    if (
      APPLE_BACKFILL_METADATA_FIELDS.some((field) => !epoch.values.has(field))
    ) {
      if (this.pendingAppleBackfillObservation?.epochId === epoch.id) {
        this.cancelPendingAppleBackfillObservation();
      }
      return;
    }

    const track: TrackMetadata = {
      title: String(epoch.values.get('title') ?? ''),
      artist: String(epoch.values.get('artist') ?? ''),
      album: String(epoch.values.get('album') ?? ''),
      durationMs: Number(epoch.values.get('durationMs')),
      source: this.track?.source ?? this.stableAppleBackfillTrack?.source ?? '',
    };
    if (!canObserveAppleBackfill(track)) {
      if (this.pendingAppleBackfillObservation?.epochId === epoch.id) {
        this.cancelPendingAppleBackfillObservation();
      }
      return;
    }

    if (epoch.stableReplayFields.size > 0) {
      if (this.pendingAppleBackfillObservation?.epochId === epoch.id) {
        this.cancelPendingAppleBackfillObservation();
      }
      return;
    }

    this.armAppleBackfillObservation(
      track,
      epoch.id,
      epoch.cautiousInheritedFields.size > 0
        ? APPLE_BACKFILL_CAUTIOUS_INHERIT_DEBOUNCE_MS
        : APPLE_BACKFILL_DEBOUNCE_MS,
    );
  }

  private armAppleBackfillObservation(
    track: TrackMetadata,
    epochId: number,
    debounceMs = APPLE_BACKFILL_DEBOUNCE_MS,
  ): void {
    const candidate = { ...track };
    const fingerprint = lyricsLookupFingerprint(candidate);
    if (fingerprint === this.observedAppleBackfillFingerprint) {
      this.cancelPendingAppleBackfillObservation();
      this.stableAppleBackfillTrack = candidate;
      this.stableAppleBackfillReplayAt.clear();
      this.clearAppleBackfillEpoch(epochId);
      return;
    }

    const existing = this.pendingAppleBackfillObservation;
    if (existing?.fingerprint === fingerprint) {
      this.pendingAppleBackfillObservation = {
        ...existing,
        track: candidate,
      };
      return;
    }

    this.cancelPendingAppleBackfillObservation();
    this.pendingAppleBackfillObservation = {
      fingerprint,
      track: candidate,
      epochId,
    };
    this.armAppleBackfillCommitTimer(fingerprint, debounceMs);
  }

  private armAppleBackfillCommitTimer(fingerprint: string, debounceMs: number): void {
    if (this.appleBackfillTimer) clearTimeout(this.appleBackfillTimer);
    this.appleBackfillTimer = setTimeout(() => {
      this.commitPendingAppleBackfillObservation(fingerprint);
    }, debounceMs);
    this.appleBackfillTimer.unref();
  }

  private commitPendingAppleBackfillObservation(fingerprint: string): void {
    const pending = this.pendingAppleBackfillObservation;
    if (
      !pending
      || pending.fingerprint !== fingerprint
      || this.appleBackfillEpoch?.id !== pending.epochId
    ) return;

    if (this.appleBackfillTimer) clearTimeout(this.appleBackfillTimer);
    this.appleBackfillTimer = undefined;
    this.pendingAppleBackfillObservation = undefined;
    this.clearAppleBackfillEpoch(pending.epochId);
    this.stableAppleBackfillTrack = { ...pending.track };
    this.stableAppleBackfillReplayAt.clear();
    if (fingerprint === this.observedAppleBackfillFingerprint) return;
    this.observedAppleBackfillFingerprint = fingerprint;
    this.lyricsService.observePlayback({ ...pending.track });
  }

  private cancelPendingAppleBackfillObservation(): void {
    if (this.appleBackfillTimer) clearTimeout(this.appleBackfillTimer);
    this.appleBackfillTimer = undefined;
    this.pendingAppleBackfillObservation = undefined;
  }

  private armAppleBackfillEpochExpiry(epochId: number): void {
    if (this.appleBackfillEpochTimer) clearTimeout(this.appleBackfillEpochTimer);
    this.appleBackfillEpochTimer = setTimeout(() => {
      if (this.appleBackfillEpoch?.id !== epochId) return;
      this.cancelPendingAppleBackfillObservation();
      this.clearAppleBackfillEpoch(epochId);
    }, APPLE_BACKFILL_EPOCH_MAX_AGE_MS);
    this.appleBackfillEpochTimer.unref();
  }

  private clearAppleBackfillEpoch(epochId: number): void {
    if (this.appleBackfillEpoch?.id !== epochId) return;
    if (this.appleBackfillEpochTimer) clearTimeout(this.appleBackfillEpochTimer);
    this.appleBackfillEpochTimer = undefined;
    this.appleBackfillEpoch = undefined;
  }

  private scheduleArtworkResolution(
    field: AppleBackfillMetadataField,
    fieldChanged: boolean,
  ): void {
    const trackHasTitle = Boolean(this.track?.title.trim());
    const fingerprint = trackHasTitle && this.track
      ? artworkFingerprint(this.track)
      : '';
    if (fingerprint && fingerprint !== this.activeArtworkFingerprint) {
      if (
        this.artworkDeliveryStartedAtMs <= 0
        || (field === 'title' && fieldChanged)
      ) {
        this.artworkDeliveryStartedAtMs = performance.now();
        this.artworkResolutionRecorded = false;
      }
      this.artworkDeliveryFingerprint = fingerprint;
    }
    if (trackHasTitle) this.clearMissingTitleArtworkTimer();
    if (
      fingerprint
      && fingerprint === this.activeArtworkFingerprint
      && this.artworkPalette
    ) {
      if (
        this.pendingArtworkFingerprint
        || this.artworkTimer
        || this.artworkMetadataEpochOpen
      ) {
        this.cancelActiveArtworkLookup();
        this.artworkLookupSequence += 1;
        this.pendingArtworkFingerprint = '';
        if (this.artworkTimer) clearTimeout(this.artworkTimer);
        this.artworkTimer = undefined;
        this.clearArtworkRetry(true);
        this.pauseStaleArtworkPalette();
        this.finishArtworkMetadataEpoch();
        this.artworkLookup = this.activeArtworkLookup;
        this.resumeActiveArtworkFallback(fingerprint);
      }
      return;
    }
    const currentFingerprintIsSettled = Boolean(
      fingerprint
      && fingerprint === this.activeArtworkFingerprint
      && !this.pendingArtworkFingerprint
      && this.artworkRetryFingerprint !== fingerprint,
    );
    if (currentFingerprintIsSettled) return;
    if (
      fingerprint
      && fingerprint === this.pendingArtworkFingerprint
      && !this.artworkTimer
    ) return;

    const startsFreshEpoch = !this.artworkMetadataEpochOpen
      || (
        field === 'title'
        && fieldChanged
        && this.artworkMetadataObservedFields.has('title')
      );
    if (startsFreshEpoch) {
      this.artworkMetadataEpochOpen = true;
      this.artworkMetadataObservedFields.clear();
    }
    if (
      this.track
      && (
        field === 'durationMs'
          ? Number.isFinite(this.track.durationMs) && this.track.durationMs > 0
          : this.track[field].trim().length > 0
      )
    ) {
      this.artworkMetadataObservedFields.add(field);
    }

    if (!trackHasTitle || !this.track) {
      this.cancelActiveArtworkLookup();
      this.artworkDeliveryFingerprint = '';
      this.artworkDeliveryStartedAtMs = 0;
      this.artworkResolutionRecorded = false;
      this.artworkLookupSequence += 1;
      this.pendingArtworkFingerprint = '';
      this.artworkLookup = { state: 'idle' };
      if (this.artworkTimer) clearTimeout(this.artworkTimer);
      this.artworkTimer = undefined;
      this.clearArtworkRetry(true);
      this.pauseStaleArtworkPalette();
      this.deferMissingTitleArtworkClear();
      return;
    }

    if (this.artworkRetryTimer && this.artworkRetryFingerprint === fingerprint) return;
    if (this.artworkRetryFingerprint && this.artworkRetryFingerprint !== fingerprint) {
      this.clearArtworkRetry(true);
    }
    this.pauseStaleArtworkPalette();
    if (fingerprint !== this.pendingArtworkFingerprint) {
      this.cancelActiveArtworkLookup();
      this.artworkLookupSequence += 1;
    }
    this.pendingArtworkFingerprint = fingerprint;
    this.artworkLookup = { state: 'loading' };
    if (!this.artworkPalette) this.artworkPalette = fallbackArtworkPalette(this.track);
    if (this.artworkTimer) clearTimeout(this.artworkTimer);
    const completeMetadata = APPLE_BACKFILL_METADATA_FIELDS.every(
      (metadataField) => this.artworkMetadataObservedFields.has(metadataField),
    );
    this.artworkTimer = setTimeout(
      () => this.maybeResolveArtwork(),
      completeMetadata
        ? ARTWORK_METADATA_DEBOUNCE_MS
        : ARTWORK_INCOMPLETE_METADATA_SETTLE_MS,
    );
    this.artworkTimer.unref();
    if (completeMetadata) {
      this.startArtworkCacheProbe({ ...this.track }, fingerprint);
    }
  }

  private startArtworkCacheProbe(
    requestedTrack: TrackMetadata,
    fingerprint: string,
  ): void {
    if (
      typeof this.artworkPaletteService.resolveCached !== 'function'
      || (
        this.artworkCacheProbeFingerprint === fingerprint
        && this.artworkCacheProbeAbortController
      )
    ) return;

    this.cancelArtworkCacheProbe();
    const sequence = this.artworkLookupSequence;
    const abortController = new AbortController();
    this.artworkCacheProbeAbortController = abortController;
    this.artworkCacheProbeFingerprint = fingerprint;
    const stableWindow = new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(Object.assign(new Error('lookup_canceled'), { name: 'AbortError' }));
      };
      const timer = setTimeout(() => {
        abortController.signal.removeEventListener('abort', onAbort);
        resolve();
      }, ARTWORK_CACHE_PROBE_MIN_SETTLE_MS);
      timer.unref();
      abortController.signal.addEventListener('abort', onAbort, { once: true });
    });

    void Promise.all([
      this.artworkPaletteService.resolveCached(requestedTrack, {
        signal: abortController.signal,
      }),
      stableWindow,
    ])
      .then(([result]) => {
        if (
          !result
          || abortController.signal.aborted
          || sequence !== this.artworkLookupSequence
          || fingerprint !== this.pendingArtworkFingerprint
          || !this.track?.title
          || artworkFingerprint(this.track) !== fingerprint
        ) return;
        if (this.artworkTimer) clearTimeout(this.artworkTimer);
        this.artworkTimer = undefined;
        this.artworkCacheProbeAbortController = undefined;
        this.artworkCacheProbeFingerprint = '';
        this.applyArtworkSuccess(fingerprint, result.palette, result.status);
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.artworkCacheProbeAbortController === abortController) {
          this.artworkCacheProbeAbortController = undefined;
          this.artworkCacheProbeFingerprint = '';
        }
      });
  }

  private maybeResolveArtwork(): void {
    this.artworkTimer = undefined;
    if (!this.track?.title) {
      this.pendingArtworkFingerprint = '';
      this.artworkLookup = { state: 'idle' };
      return;
    }
    const requestedTrack = { ...this.track };
    const fingerprint = artworkFingerprint(requestedTrack);
    if (fingerprint !== this.pendingArtworkFingerprint) return;
    if (fingerprint === this.activeArtworkFingerprint && this.artworkPalette) {
      this.pendingArtworkFingerprint = '';
      this.clearArtworkRetry(true);
      this.pauseStaleArtworkPalette();
      this.finishArtworkMetadataEpoch();
      this.artworkLookup = this.activeArtworkLookup;
      this.resumeActiveArtworkFallback(fingerprint);
      return;
    }
    const sequence = ++this.artworkLookupSequence;
    this.cancelActiveArtworkLookup();
    const abortController = new AbortController();
    this.artworkAbortController = abortController;
    const resolution = typeof this.artworkPaletteService.resolve === 'function'
      ? this.artworkPaletteService.resolve(requestedTrack, {
          signal: abortController.signal,
        })
      : this.artworkPaletteService.find(requestedTrack).then((palette) => ({
        palette,
        status: palette.source === 'apple'
          ? { state: 'success' as const, source: 'catalog' as const }
          : {
            state: 'fallback' as const,
            reason: 'unknown' as const,
            retryable: true,
            cache: 'miss' as const,
          },
      }));
    void resolution
      .then(({ palette, status }) => {
        if (
          sequence !== this.artworkLookupSequence ||
          fingerprint !== this.pendingArtworkFingerprint
        ) return;
        if (status.state === 'fallback') {
          this.pendingArtworkFingerprint = '';
          this.finishArtworkMetadataEpoch();
          this.applyArtworkFallback(requestedTrack, fingerprint, palette, status);
          return;
        }
        this.applyArtworkSuccess(fingerprint, palette, status);
      })
      .catch(() => {
        if (
          sequence !== this.artworkLookupSequence ||
          fingerprint !== this.pendingArtworkFingerprint
        ) return;
        this.pendingArtworkFingerprint = '';
        this.finishArtworkMetadataEpoch();
        this.applyArtworkFallback(
          requestedTrack,
          fingerprint,
          fallbackArtworkPalette(requestedTrack),
          {
            state: 'fallback',
            reason: 'unknown',
            retryable: true,
            cache: 'miss',
          },
        );
      })
      .finally(() => {
        if (this.artworkAbortController === abortController) {
          this.artworkAbortController = undefined;
        }
      });
  }

  private cancelActiveArtworkLookup(): void {
    this.artworkAbortController?.abort();
    this.artworkAbortController = undefined;
    this.cancelArtworkCacheProbe();
  }

  private cancelArtworkCacheProbe(): void {
    this.artworkCacheProbeAbortController?.abort();
    this.artworkCacheProbeAbortController = undefined;
    this.artworkCacheProbeFingerprint = '';
  }

  private applyArtworkSuccess(
    fingerprint: string,
    palette: ArtworkPalette,
    status: Extract<ArtworkLookupStatus, { state: 'success' }>,
  ): void {
    this.pendingArtworkFingerprint = '';
    this.finishArtworkMetadataEpoch();
    this.clearArtworkRetry(true);
    this.clearStaleArtworkPalette();
    this.artworkPalette = palette;
    this.artworkLookup = status;
    this.activeArtworkFingerprint = fingerprint;
    this.activeArtworkLookup = status;
    this.recordArtworkDelivery(fingerprint);
    this.publish();
  }

  private recordArtworkDelivery(fingerprint: string): void {
    this.recordArtworkResolution(fingerprint);
    if (
      fingerprint !== this.artworkDeliveryFingerprint
      || this.artworkDeliveryStartedAtMs <= 0
    ) return;
    const recorder = this.artworkPaletteService as ArtworkPaletteService & {
      recordDeliveryDuration?: (durationMs: number) => void;
    };
    recorder.recordDeliveryDuration?.(
      Math.max(0, performance.now() - this.artworkDeliveryStartedAtMs),
    );
    this.artworkDeliveryFingerprint = '';
    this.artworkDeliveryStartedAtMs = 0;
    this.artworkResolutionRecorded = false;
  }

  private recordArtworkResolution(fingerprint: string): void {
    if (
      this.artworkResolutionRecorded
      || fingerprint !== this.artworkDeliveryFingerprint
      || this.artworkDeliveryStartedAtMs <= 0
    ) return;
    const recorder = this.artworkPaletteService as ArtworkPaletteService & {
      recordResolutionDuration?: (durationMs: number) => void;
    };
    recorder.recordResolutionDuration?.(
      Math.max(0, performance.now() - this.artworkDeliveryStartedAtMs),
    );
    this.artworkResolutionRecorded = true;
  }

  private finishArtworkMetadataEpoch(): void {
    this.artworkMetadataEpochOpen = false;
    this.artworkMetadataObservedFields.clear();
  }

  private applyArtworkFallback(
    requestedTrack: TrackMetadata,
    fingerprint: string,
    fallback: ArtworkPalette,
    status: ArtworkFallbackStatus,
  ): void {
    const retainPreviousPalette = this.artworkPalette?.source === 'apple';
    this.artworkLookup = status;
    if (!retainPreviousPalette) this.artworkPalette = fallback;

    const retryScheduled = status.retryable
      ? this.scheduleArtworkRetry(fingerprint)
      : false;
    if (!status.retryable) this.clearArtworkRetry(true);
    this.activeArtworkFingerprint = retryScheduled ? '' : fingerprint;
    if (!retryScheduled) this.activeArtworkLookup = status;

    if (retainPreviousPalette && !retryScheduled) {
      this.deferStaleArtworkPaletteFallback(requestedTrack, fingerprint);
    } else {
      this.clearStaleArtworkPalette();
    }
    this.recordArtworkResolution(fingerprint);
    this.publish();
  }

  private deferStaleArtworkPaletteFallback(
    requestedTrack: TrackMetadata,
    fingerprint: string,
  ): void {
    this.clearStaleArtworkPalette();
    this.artworkStalePaletteFingerprint = fingerprint;
    this.artworkStalePaletteTrack = { ...requestedTrack };
    this.artworkStalePaletteDeadlineMs = Date.now() + ARTWORK_STALE_PALETTE_GRACE_MS;
    this.armStaleArtworkPaletteFallback();
  }

  private armStaleArtworkPaletteFallback(): void {
    const fingerprint = this.artworkStalePaletteFingerprint;
    const requestedTrack = this.artworkStalePaletteTrack;
    if (!fingerprint || !requestedTrack) return;
    this.pauseStaleArtworkPalette();
    const remainingMs = Math.max(0, this.artworkStalePaletteDeadlineMs - Date.now());
    this.artworkStalePaletteTimer = setTimeout(() => {
      this.artworkStalePaletteTimer = undefined;
      if (
        !this.track?.title
        || artworkFingerprint(this.track) !== fingerprint
        || this.activeArtworkFingerprint !== fingerprint
        || this.pendingArtworkFingerprint
        || this.artworkLookup.state !== 'fallback'
        || this.artworkStalePaletteFingerprint !== fingerprint
      ) return;
      this.artworkStalePaletteFingerprint = '';
      this.artworkStalePaletteTrack = null;
      this.artworkStalePaletteDeadlineMs = 0;
      this.artworkPalette = fallbackArtworkPalette(requestedTrack);
      this.publish();
    }, remainingMs);
    this.artworkStalePaletteTimer.unref();
  }

  private resumeActiveArtworkFallback(fingerprint: string): void {
    if (
      this.activeArtworkLookup.state !== 'fallback'
      || this.artworkPalette?.source !== 'apple'
      || !this.track?.title
    ) {
      this.clearStaleArtworkPalette();
      return;
    }
    if (this.artworkStalePaletteFingerprint !== fingerprint) {
      this.deferStaleArtworkPaletteFallback(this.track, fingerprint);
      return;
    }
    this.armStaleArtworkPaletteFallback();
  }

  private pauseStaleArtworkPalette(): void {
    if (this.artworkStalePaletteTimer) clearTimeout(this.artworkStalePaletteTimer);
    this.artworkStalePaletteTimer = undefined;
  }

  private clearStaleArtworkPalette(): void {
    this.pauseStaleArtworkPalette();
    this.artworkStalePaletteFingerprint = '';
    this.artworkStalePaletteTrack = null;
    this.artworkStalePaletteDeadlineMs = 0;
  }

  private deferMissingTitleArtworkClear(): void {
    if (this.artworkMissingTitleTimer || !this.artworkPalette) return;
    this.artworkMissingTitleTimer = setTimeout(() => {
      this.artworkMissingTitleTimer = undefined;
      if (this.track?.title.trim() || this.artworkLookup.state !== 'idle') return;
      this.artworkLookupSequence += 1;
      this.clearStaleArtworkPalette();
      this.activeArtworkFingerprint = '';
      this.activeArtworkLookup = { state: 'idle' };
      this.artworkPalette = null;
      this.finishArtworkMetadataEpoch();
      this.publish();
    }, ARTWORK_MISSING_TITLE_GRACE_MS);
    this.artworkMissingTitleTimer.unref();
  }

  private clearMissingTitleArtworkTimer(): void {
    if (this.artworkMissingTitleTimer) clearTimeout(this.artworkMissingTitleTimer);
    this.artworkMissingTitleTimer = undefined;
  }

  private scheduleArtworkRetry(fingerprint: string): boolean {
    if (this.artworkRetryTimer) return true;
    if (this.artworkRetryAttempt >= ARTWORK_RETRY_DELAYS_MS.length) {
      this.artworkRetryFingerprint = '';
      return false;
    }
    const delay = ARTWORK_RETRY_DELAYS_MS[this.artworkRetryAttempt];
    this.artworkRetryAttempt += 1;
    this.artworkRetryFingerprint = fingerprint;
    this.artworkRetryTimer = setTimeout(() => {
      this.artworkRetryTimer = undefined;
      if (
        !this.track?.title
        || artworkFingerprint(this.track) !== fingerprint
        || this.artworkLookup.state !== 'fallback'
        || !this.artworkLookup.retryable
      ) {
        this.artworkRetryFingerprint = '';
        return;
      }
      this.pendingArtworkFingerprint = fingerprint;
      this.artworkLookup = { state: 'loading' };
      this.publish();
      this.maybeResolveArtwork();
    }, delay);
    this.artworkRetryTimer.unref();
    return true;
  }

  private clearArtworkRetry(resetAttempt: boolean): void {
    if (this.artworkRetryTimer) clearTimeout(this.artworkRetryTimer);
    this.artworkRetryTimer = undefined;
    this.artworkRetryFingerprint = '';
    if (resetAttempt) this.artworkRetryAttempt = 0;
  }

  async setOffset(offsetMs: number): Promise<void> {
    if (!this.track) return;
    await this.lyricsService.setOffset(this.track, offsetMs);
    this.publish();
  }

  async setManualLrc(lrc: string): Promise<void> {
    if (!this.track) throw new Error('当前没有正在播放的歌曲');
    const requestedTrack = { ...this.track };
    const requestedSignature = lyricsLookupFingerprint(requestedTrack);
    const selected = await this.lyricsService.setManualLrc(requestedTrack, lrc);
    if (!this.track || lyricsLookupFingerprint(this.track) !== requestedSignature) {
      throw playerError('歌曲已经切换，手动歌词已保存到上一首歌', 409);
    }
    this.applySelectedLyrics(requestedTrack, selected);
  }

  async listLyricsCandidates(): Promise<LyricsCandidateSet> {
    if (!this.track?.title) throw playerError('当前没有正在播放的歌曲', 409);
    const requestedTrack = { ...this.track };
    const requestedSignature = lyricsLookupFingerprint(requestedTrack);
    const candidates = await this.lyricsService.listCandidates(requestedTrack);
    if (!this.track || lyricsLookupFingerprint(this.track) !== requestedSignature) {
      throw playerError('歌曲信息已经变化，请重新读取候选歌词', 409);
    }
    return candidates;
  }

  async selectLyricsCandidate(token: string, mode: LyricsCandidateMode): Promise<void> {
    if (!this.track?.title) throw playerError('当前没有正在播放的歌曲', 409);
    const requestedTrack = { ...this.track };
    const requestedSignature = lyricsLookupFingerprint(requestedTrack);
    const selected = await this.lyricsService.selectCandidate(requestedTrack, token, mode);
    if (!this.track || lyricsLookupFingerprint(this.track) !== requestedSignature) {
      throw playerError('歌曲已经切换，选择已保存到上一首歌', 409);
    }
    this.applySelectedLyrics(requestedTrack, selected);
  }

  private applySelectedLyrics(track: TrackMetadata, lyrics: LyricsPayload): void {
    const previousLyrics = this.lyrics;
    this.lookupSequence += 1;
    if (this.identityTimer) clearTimeout(this.identityTimer);
    this.identityTimer = undefined;
    this.pendingLyricsTrack = undefined;
    this.pendingLyricsMetadataEpochId = undefined;
    this.lyricsMetadataEpoch = undefined;
    this.bypassLyricsCache = false;
    this.backgroundLyricsRefresh = false;
    this.lyricsResolutionReason = 'metadata';
    this.clearLyricRetry(true);
    this.activeFingerprint = trackFingerprint(track);
    this.activeLyricsMetadata = lyricsLookupFingerprint(track);
    this.activeLyricsTrack = { ...track };
    this.presentedLyricsTrack = { ...track };
    this.observeLyricsVersionDecision(
      track,
      previousLyrics,
      lyrics,
      'selection',
      hasUsableLyrics(previousLyrics) ? 'replaced' : 'initial',
    );
    this.lyrics = lyrics;
    this.lyricsGeneration = this.trackGeneration;
    this.publish();
  }

  demoAction(action: 'toggle' | 'restart' | 'forward'): void {
    if (!config.demoMode || !this.track) return;
    this.elapsedMs = this.currentElapsedMs();
    this.capturedAtMs = Date.now();
    if (action === 'toggle') this.status = this.status === 'playing' ? 'paused' : 'playing';
    if (action === 'restart') this.elapsedMs = 0;
    if (action === 'forward') this.elapsedMs = Math.min(this.track.durationMs, this.elapsedMs + 15_000);
    this.publish();
  }
}
