export type PlaybackStatus = 'playing' | 'paused' | 'stopped' | 'unknown';

export interface TrackMetadata {
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  source: string;
}

export interface NavigationSnapshot {
  destinationName: string;
  minutesToArrival: number;
  updatedAtMs: number;
  /** Remaining route distance from Tesla's navigation telemetry, in miles. */
  distanceToArrivalMiles?: number;
  /** Estimated state of charge on arrival when a trusted projection is available. */
  arrivalBatteryPercent?: number;
}

export interface LyricLine {
  id: string;
  startMs: number;
  text: string;
}

export interface LyricsPayload {
  kind: 'synced' | 'plain' | 'missing' | 'loading';
  lines: LyricLine[];
  plainText?: string;
  provider: 'lrclib' | 'apple' | 'manual' | 'demo' | null;
  /** Numeric provider identity retained for LRCLIB compatibility. */
  providerId?: number;
  /** Provider identity when the upstream uses an opaque or string key. */
  providerTrackId?: string;
  notice?: string;
  retryable?: boolean;
  fallbackKind?: 'original-version' | 'work-cache';
}

export type LyricsCandidateMode = 'synced' | 'plain';

export interface LyricsCandidate {
  token: string;
  trackName: string;
  artistName: string;
  albumName: string;
  durationMs: number;
  hasSyncedLyrics: boolean;
  hasPlainLyrics: boolean;
  versionMismatch: boolean;
  matchScore: number;
  preview: string[];
}

export interface LyricsCandidateSet {
  candidates: LyricsCandidate[];
}

export interface ArtworkSpatialField {
  schemaVersion: 1;
  id: string;
  columns: 6;
  rows: 4;
  base: string;
  colors: string[];
}

export interface ArtworkPalette {
  primary: string;
  secondary: string;
  source: 'apple' | 'fallback';
  field?: ArtworkSpatialField;
}

export type ArtworkLookupStage =
  | 'primary-full'
  | 'primary-core'
  | 'fallback-core';

export type ArtworkLookupFailureReason =
  | 'insufficient-metadata'
  | 'catalog-empty'
  | 'catalog-missing-artwork'
  | 'catalog-version-mismatch'
  | 'catalog-album-mismatch'
  | 'catalog-low-confidence'
  | 'no-reliable-match'
  | 'ambiguous-candidate'
  | 'local-rate-limit'
  | 'catalog-rate-limit'
  | 'catalog-timeout'
  | 'catalog-network'
  | 'catalog-http-client'
  | 'catalog-http-server'
  | 'catalog-invalid-response'
  | 'artwork-url-rejected'
  | 'artwork-timeout'
  | 'artwork-network'
  | 'artwork-rate-limit'
  | 'artwork-http-client'
  | 'artwork-http-server'
  | 'artwork-invalid-response'
  | 'unknown';

export type ArtworkLookupStatus =
  | { state: 'idle' | 'loading' }
  | {
    state: 'success';
    source: 'catalog' | 'positive-cache' | 'supabase-cache';
    stage?: ArtworkLookupStage;
  }
  | {
    state: 'fallback';
    reason: ArtworkLookupFailureReason;
    retryable: boolean;
    cache: 'miss' | 'negative-hit';
    stage?: ArtworkLookupStage;
  };

export interface PlayerSnapshot {
  mode: 'demo' | 'live';
  connection: 'connected' | 'waiting' | 'offline' | 'demo';
  track: TrackMetadata | null;
  playbackStatus: PlaybackStatus;
  elapsedMs: number;
  capturedAtMs: number;
  /** Monotonic identity for the current playback metadata epoch. */
  trackGeneration?: number;
  /** Playback generation that produced the current lyrics payload. */
  lyricsGeneration?: number;
  /**
   * False when the last presented lyrics belong to metadata that contradicts
   * the current track. Clients must not retain that payload while replacement
   * lyrics are being resolved.
   */
  lyricsTrackMatchesCurrent?: boolean;
  /** True after elapsed telemetry has been attributed to trackGeneration. */
  playbackClockReady?: boolean;
  /** Monotonic snapshot ordering within one server process. */
  snapshotRevision?: number;
  manualOffsetMs: number;
  lyrics: LyricsPayload;
  artworkPalette: ArtworkPalette | null;
  artworkLookup?: ArtworkLookupStatus;
  navigation?: NavigationSnapshot | null;
  vehicleName?: string;
}

export interface SetupStatus {
  demoMode: boolean;
  appOrigin: string;
  developerApp: {
    configured: boolean;
    callbackUrl: string;
    publicKeyUrl: string;
    requiredScopes: string[];
  };
  teslaAccount: {
    connected: boolean;
    authorizationCurrent: boolean;
    tokenExpiresAt?: number;
  };
  vehicle: {
    selected: boolean;
    maskedVin: string | null;
  };
  telemetry: {
    configured: boolean;
    synced: boolean;
    hostname: string | null;
    mqttReady: boolean;
  };
}

export interface TelemetryConfigurationResult {
  accepted: true;
}

export interface TelemetryConfigurationStatus {
  configured: boolean;
  synced: boolean;
  keyPaired: boolean;
  limitReached: boolean;
}

export interface TeslaVehicleSummary {
  id: number;
  vin: string;
  displayName: string;
  state: string;
}

export type PlayerEvent =
  { type: 'snapshot'; payload: PlayerSnapshot };
