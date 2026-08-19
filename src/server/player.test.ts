vi.mock('./config.js', () => ({
  config: {
    demoMode: false,
    isProduction: false,
    tesla: { allowedVin: '' },
  },
}));

import type { ArtworkPalette, LyricsPayload, TrackMetadata } from '../shared/contracts.js';
import type { ArtworkPaletteService } from './artwork-palette-service.js';
import { config } from './config.js';
import type { LyricsService } from './lyrics-service.js';
import {
  LYRICS_METADATA_DEBOUNCE_MS,
  LYRICS_TRANSITION_INCOMPLETE_SETTLE_MS,
  NAVIGATION_STALE_AFTER_MS,
  PlayerCoordinator,
} from './player.js';
import { PlaybackClockObservability } from './playback-clock-observability.js';
import type { JsonStore, PersistedState } from './store.js';

const VIN = '7SAYGDEE1RF000000';
const COMPLETE_TRACK: TrackMetadata = {
  title: 'Midnight Circuit',
  artist: 'Local Drive',
  album: 'After Dark',
  durationMs: 214_000,
  source: 'Apple Music',
};
const APPLE_BACKFILL_TEST_FIELDS = [
  'title',
  'artist',
  'album',
  'durationMs',
] as const;
type AppleBackfillTestField = (typeof APPLE_BACKFILL_TEST_FIELDS)[number];

const TELEMETRY_FIELD_BY_TRACK_FIELD: Record<AppleBackfillTestField, string> = {
  title: 'MediaNowPlayingTitle',
  artist: 'MediaNowPlayingArtist',
  album: 'MediaNowPlayingAlbum',
  durationMs: 'MediaNowPlayingDuration',
};

function fieldPermutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [[...values]];
  return values.flatMap((value, index) =>
    fieldPermutations(values.filter((_, candidateIndex) => candidateIndex !== index))
      .map((remaining) => [value, ...remaining]));
}

function ingestBackfillTrackField(
  player: PlayerCoordinator,
  track: TrackMetadata,
  field: AppleBackfillTestField,
): void {
  player.ingest(VIN, TELEMETRY_FIELD_BY_TRACK_FIELD[field], track[field]);
}

function ingestBackfillTrack(
  player: PlayerCoordinator,
  track: TrackMetadata,
  order: readonly AppleBackfillTestField[] = APPLE_BACKFILL_TEST_FIELDS,
): void {
  for (const field of order) ingestBackfillTrackField(player, track, field);
}

function testStore(): JsonStore {
  const state = {
    selectedVin: VIN,
    selectedVehicleName: 'Tesla',
  } as PersistedState;
  return {
    snapshot: vi.fn(() => structuredClone(state)),
    readSelectedVin: vi.fn(() => state.selectedVin),
    readSelectedVehicleName: vi.fn(() => state.selectedVehicleName),
  } as unknown as JsonStore;
}

function lyricsService(
  find: (
    track: TrackMetadata,
    options?: { bypassLocalCache?: boolean },
  ) => Promise<LyricsPayload>,
  observePlayback: (track: TrackMetadata) => void = vi.fn(),
): LyricsService {
  return {
    find,
    observePlayback,
    getOffset: () => 0,
  } as unknown as LyricsService;
}

function artworkPaletteService(
  find: (track: TrackMetadata) => Promise<ArtworkPalette> = async () => ({
    primary: '#334455',
    secondary: '#667788',
    source: 'fallback',
  }),
): ArtworkPaletteService {
  return {
    find,
  } as unknown as ArtworkPaletteService;
}

describe('PlayerCoordinator lyric resolution', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('exposes complete navigation telemetry and expires it from memory', async () => {
    const player = new PlayerCoordinator(
      lyricsService(async () => ({ kind: 'missing', lines: [], provider: null })),
      artworkPaletteService(),
      testStore(),
    );

    player.ingest(VIN, 'DestinationName', { stringValue: '虹桥国际机场' });
    expect(player.snapshot().navigation).toBeNull();

    player.ingest(VIN, 'MinutesToArrival', { doubleValue: 18.2 });
    const navigation = player.snapshot().navigation;
    expect(navigation).toEqual({
      destinationName: '虹桥国际机场',
      minutesToArrival: 18.2,
      updatedAtMs: expect.any(Number),
    });

    await vi.advanceTimersByTimeAsync(30_000);
    player.ingest(VIN, 'DestinationName', { stringValue: '虹桥国际机场' });
    expect(player.snapshot().navigation?.updatedAtMs).toBe(navigation?.updatedAtMs);

    await vi.advanceTimersByTimeAsync(NAVIGATION_STALE_AFTER_MS - 30_001);
    expect(player.snapshot().navigation).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(player.snapshot().navigation).toBeNull();
  });

  it('exposes Tesla expected arrival energy and hides it when the signal is invalid', () => {
    const player = new PlayerCoordinator(
      lyricsService(async () => ({ kind: 'missing', lines: [], provider: null })),
      artworkPaletteService(),
      testStore(),
    );

    player.ingest(VIN, 'DestinationName', '虹桥国际机场');
    player.ingest(VIN, 'MinutesToArrival', 18.2);
    player.ingest(VIN, 'MilesToArrival', { doubleValue: 12.4 });
    player.ingest(VIN, 'ExpectedEnergyPercentAtTripArrival', { intValue: 68 });

    expect(player.snapshot().navigation).toEqual(expect.objectContaining({
      destinationName: '虹桥国际机场',
      minutesToArrival: 18.2,
      distanceToArrivalMiles: 12.4,
      arrivalBatteryPercent: 68,
    }));

    player.ingest(VIN, 'MilesToArrival', { value: { invalid: true } });
    expect(player.snapshot().navigation).toEqual(expect.objectContaining({
      destinationName: '虹桥国际机场',
      minutesToArrival: 18.2,
      arrivalBatteryPercent: 68,
    }));
    expect(player.snapshot().navigation).not.toHaveProperty('distanceToArrivalMiles');

    player.ingest(VIN, 'ExpectedEnergyPercentAtTripArrival', { value: { invalid: true } });
    expect(player.snapshot().navigation).toEqual({
      destinationName: '虹桥国际机场',
      minutesToArrival: 18.2,
      updatedAtMs: expect.any(Number),
    });
  });

  it('does not keep an old arrival-energy estimate after the route telemetry is refreshed', async () => {
    const player = new PlayerCoordinator(
      lyricsService(async () => ({ kind: 'missing', lines: [], provider: null })),
      artworkPaletteService(),
      testStore(),
    );

    player.ingest(VIN, 'DestinationName', '虹桥国际机场');
    player.ingest(VIN, 'MinutesToArrival', 18.2);
    player.ingest(VIN, 'ExpectedEnergyPercentAtTripArrival', 68);
    await vi.advanceTimersByTimeAsync(80_000);
    player.ingest(VIN, 'DestinationName', '虹桥国际机场');
    player.ingest(VIN, 'MinutesToArrival', 17.1);
    await vi.advanceTimersByTimeAsync(11_000);

    expect(player.snapshot().navigation).toEqual(expect.objectContaining({
      destinationName: '虹桥国际机场',
      minutesToArrival: 17.1,
    }));
    expect(player.snapshot().navigation).not.toHaveProperty('arrivalBatteryPercent');
  });

  it('clears navigation on Tesla invalid signals and does not mix a stale ETA into a new route', async () => {
    const player = new PlayerCoordinator(
      lyricsService(async () => ({ kind: 'missing', lines: [], provider: null })),
      artworkPaletteService(),
      testStore(),
    );

    player.ingest(VIN, 'DestinationName', '旧目的地');
    player.ingest(VIN, 'MinutesToArrival', 12);
    player.ingest(VIN, 'MilesToArrival', 8.5);
    player.ingest(VIN, 'ExpectedEnergyPercentAtTripArrival', 61);
    await vi.advanceTimersByTimeAsync(2_001);
    player.ingest(VIN, 'DestinationName', '新目的地');
    expect(player.snapshot().navigation).toBeNull();

    player.ingest(VIN, 'MinutesToArrival', 24);
    expect(player.snapshot().navigation).toEqual(expect.objectContaining({
      destinationName: '新目的地',
      minutesToArrival: 24,
    }));
    expect(player.snapshot().navigation).not.toHaveProperty('arrivalBatteryPercent');
    expect(player.snapshot().navigation).not.toHaveProperty('distanceToArrivalMiles');

    player.ingest(VIN, 'MinutesToArrival', { value: { invalid: true } });
    expect(player.snapshot().navigation).toBeNull();
  });

  it('resolves lyrics without waiting forever for an artist field', async () => {
    const find = vi.fn(async (): Promise<LyricsPayload> => ({
      kind: 'synced',
      lines: [{ id: '0', startMs: 0, text: 'Line one' }],
      provider: 'lrclib',
    }));
    const player = new PlayerCoordinator(lyricsService(find), artworkPaletteService(), testStore());

    player.ingest(VIN, 'MediaNowPlayingTitle', { stringValue: 'Midnight Circuit' });
    player.ingest(VIN, 'MediaNowPlayingAlbum', { stringValue: 'After Dark' });
    player.ingest(VIN, 'MediaNowPlayingDuration', { longValue: 214_000 });
    await vi.advanceTimersByTimeAsync(700);

    expect(find).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Midnight Circuit',
      artist: '',
      album: 'After Dark',
      durationMs: 214_000,
    }));
    expect(player.snapshot().lyrics.kind).toBe('synced');
  });

  it('starts lyric resolution after a short metadata debounce', async () => {
    const find = vi.fn(async (): Promise<LyricsPayload> => ({
      kind: 'missing',
      lines: [],
      provider: null,
    }));
    const player = new PlayerCoordinator(lyricsService(find), artworkPaletteService(), testStore());

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Midnight Circuit');
    await vi.advanceTimersByTimeAsync(199);
    expect(find).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('ignores null and blank numeric telemetry instead of resetting the playback clock', () => {
    const player = new PlayerCoordinator(
      lyricsService(async () => ({ kind: 'missing', lines: [], provider: null })),
      artworkPaletteService(),
      testStore(),
    );

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Midnight Circuit');
    player.ingest(VIN, 'MediaNowPlayingDuration', 214_000);
    player.ingest(VIN, 'MediaNowPlayingElapsed', 42_000);
    player.ingest(VIN, 'MediaPlaybackStatus', 'PAUSED');

    player.ingest(VIN, 'MediaNowPlayingElapsed', null);
    player.ingest(VIN, 'MediaNowPlayingElapsed', '   ');
    player.ingest(VIN, 'MediaNowPlayingDuration', { value: null });
    player.ingest(VIN, 'MediaNowPlayingDuration', { stringValue: '' });

    expect(player.snapshot().elapsedMs).toBe(42_000);
    expect(player.snapshot().track?.durationMs).toBe(214_000);
  });

  it('records a backward playing sample without emitting one log per telemetry packet', () => {
    const logs: string[] = [];
    const clockObservability = new PlaybackClockObservability({
      log: (message) => logs.push(message),
    });
    const player = new PlayerCoordinator(
      lyricsService(async () => ({ kind: 'missing', lines: [], provider: null })),
      artworkPaletteService(),
      testStore(),
      clockObservability,
    );

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Midnight Circuit');
    player.ingest(VIN, 'MediaNowPlayingDuration', 214_000);
    player.ingest(VIN, 'MediaPlaybackStatus', 'PLAYING');
    player.ingest(VIN, 'MediaNowPlayingElapsed', 10_000);
    player.ingest(VIN, 'MediaNowPlayingElapsed', 9_600);

    expect(clockObservability.snapshot()).toMatchObject({
      backwardSamples: 1,
      acceptedBackwardSamples: 1,
      hardRebaseCandidates: 1,
    });
    expect(logs).toEqual([]);
  });

  it('keeps replacement lyrics static until elapsed telemetry proves the new playback clock', async () => {
    const find = vi.fn(async (track: TrackMetadata): Promise<LyricsPayload> => ({
      kind: 'synced',
      lines: [{ id: track.title, startMs: 0, text: track.title }],
      provider: 'apple',
    }));
    const player = new PlayerCoordinator(lyricsService(find), artworkPaletteService(), testStore());

    ingestBackfillTrack(player, {
      title: 'Track A',
      artist: 'Artist A',
      album: 'Album A',
      durationMs: 180_000,
      source: '',
    });
    player.ingest(VIN, 'MediaPlaybackStatus', 'PLAYING');
    player.ingest(VIN, 'MediaNowPlayingElapsed', 82_500);
    await vi.advanceTimersByTimeAsync(500);
    player.ingest(VIN, 'MediaNowPlayingElapsed', 83_000);
    await vi.advanceTimersByTimeAsync(1_250);

    const trackAGeneration = player.snapshot().trackGeneration;
    expect(player.snapshot().playbackClockReady).toBe(true);

    ingestBackfillTrack(player, {
      title: 'Track B',
      artist: 'Artist B',
      album: 'Album B',
      durationMs: 210_000,
      source: '',
    });
    expect(player.snapshot().lyricsTrackMatchesCurrent).toBe(false);
    await vi.advanceTimersByTimeAsync(200);

    const resolved = player.snapshot();
    expect(resolved.trackGeneration).toBeGreaterThan(trackAGeneration ?? -1);
    expect(resolved.lyricsGeneration).toBe(resolved.trackGeneration);
    expect(resolved.lyrics.lines[0]?.text).toBe('Track B');
    expect(resolved.lyricsTrackMatchesCurrent).toBe(true);
    expect(resolved.playbackClockReady).toBe(false);
    const frozenElapsedMs = resolved.elapsedMs;

    // Tesla can publish the prior track's elapsed value after all of B's
    // metadata. It follows A's trajectory and must not unlock B.
    player.ingest(VIN, 'MediaNowPlayingElapsed', 83_500);
    expect(player.snapshot().playbackClockReady).toBe(false);
    await vi.advanceTimersByTimeAsync(800);
    expect(player.snapshot().elapsedMs).toBe(frozenElapsedMs);

    player.ingest(VIN, 'MediaNowPlayingElapsed', 700);
    expect(player.snapshot()).toEqual(expect.objectContaining({
      playbackClockReady: true,
      elapsedMs: 700,
    }));
  });

  it('keeps a confirmed clock ready when an empty album is enriched', async () => {
    const find = vi.fn(async (): Promise<LyricsPayload> => ({
      kind: 'synced',
      lines: [{ id: '0', startMs: 0, text: 'Found' }],
      provider: 'apple',
    }));
    const player = new PlayerCoordinator(lyricsService(find), artworkPaletteService(), testStore());

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track A');
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Artist A');
    player.ingest(VIN, 'MediaNowPlayingDuration', 180_000);
    player.ingest(VIN, 'MediaPlaybackStatus', 'PLAYING');
    player.ingest(VIN, 'MediaNowPlayingElapsed', 82_000);
    await vi.advanceTimersByTimeAsync(1_000);
    player.ingest(VIN, 'MediaNowPlayingElapsed', 83_000);
    await vi.advanceTimersByTimeAsync(200);

    const beforeEnrichment = player.snapshot();
    expect(beforeEnrichment.playbackClockReady).toBe(true);
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'Album A');
    expect(player.snapshot().lyricsTrackMatchesCurrent).toBe(true);

    const enriched = player.snapshot();
    expect(enriched.trackGeneration).toBe((beforeEnrichment.trackGeneration ?? 0) + 1);
    expect(enriched.playbackClockReady).toBe(true);
    await vi.advanceTimersByTimeAsync(1_250);
    expect(find).toHaveBeenCalledTimes(2);
    expect(find).toHaveBeenLastCalledWith(
      expect.objectContaining({ album: 'Album A' }),
      { bypassLocalCache: true },
    );
    expect(player.snapshot().lyricsGeneration).toBe(player.snapshot().trackGeneration);

    const enrichedGeneration = player.snapshot().trackGeneration;
    player.ingest(VIN, 'MediaNowPlayingAlbum', '  album   a ');
    expect(player.snapshot().trackGeneration).toBe(enrichedGeneration);
    expect(player.snapshot().playbackClockReady).toBe(true);

    player.ingest(VIN, 'MediaNowPlayingAlbum', 'Album B');
    expect(player.snapshot().trackGeneration).toBe((enrichedGeneration ?? 0) + 1);
    expect(player.snapshot().playbackClockReady).toBe(false);
  });

  it('discards intermediate elapsed evidence across A to B to C metadata changes', async () => {
    const player = new PlayerCoordinator(
      lyricsService(async () => ({ kind: 'missing', lines: [], provider: null })),
      artworkPaletteService(),
      testStore(),
    );

    ingestBackfillTrack(player, {
      title: 'Track A',
      artist: 'Artist A',
      album: 'Album A',
      durationMs: 180_000,
      source: '',
    });
    player.ingest(VIN, 'MediaPlaybackStatus', 'PLAYING');
    player.ingest(VIN, 'MediaNowPlayingElapsed', 82_000);
    await vi.advanceTimersByTimeAsync(1_000);
    player.ingest(VIN, 'MediaNowPlayingElapsed', 83_000);

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track B');
    const generationB = player.snapshot().trackGeneration;
    player.ingest(VIN, 'MediaNowPlayingElapsed', 100_000);
    expect(player.snapshot().playbackClockReady).toBe(false);

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track C');
    expect(player.snapshot().trackGeneration).toBe((generationB ?? 0) + 1);
    player.ingest(VIN, 'MediaNowPlayingElapsed', 101_000);
    expect(player.snapshot().playbackClockReady).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    player.ingest(VIN, 'MediaNowPlayingElapsed', 102_000);
    expect(player.snapshot()).toEqual(expect.objectContaining({
      playbackClockReady: true,
      elapsedMs: 102_000,
    }));
  });

  it('does not attribute a confirmed B trajectory to a rapid C switch', async () => {
    const player = new PlayerCoordinator(
      lyricsService(async () => ({ kind: 'missing', lines: [], provider: null })),
      artworkPaletteService(),
      testStore(),
    );

    ingestBackfillTrack(player, {
      title: 'Track A',
      artist: 'Artist',
      album: 'Album A',
      durationMs: 180_000,
      source: '',
    });
    player.ingest(VIN, 'MediaPlaybackStatus', 'PLAYING');
    player.ingest(VIN, 'MediaNowPlayingElapsed', 82_000);
    await vi.advanceTimersByTimeAsync(1_000);
    player.ingest(VIN, 'MediaNowPlayingElapsed', 83_000);

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track B');
    player.ingest(VIN, 'MediaNowPlayingElapsed', 0);
    expect(player.snapshot().playbackClockReady).toBe(true);

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track C');
    player.ingest(VIN, 'MediaNowPlayingElapsed', 1_000);
    expect(player.snapshot().playbackClockReady).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    player.ingest(VIN, 'MediaNowPlayingElapsed', 2_000);
    expect(player.snapshot().playbackClockReady).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    player.ingest(VIN, 'MediaNowPlayingElapsed', 3_000);
    expect(player.snapshot().playbackClockReady).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    player.ingest(VIN, 'MediaNowPlayingElapsed', 4_000);
    expect(player.snapshot()).toEqual(expect.objectContaining({
      playbackClockReady: true,
      elapsedMs: 4_000,
    }));
  });

  it('does not mistake a clock accepted mid-burst for the previous track clock', async () => {
    const player = new PlayerCoordinator(
      lyricsService(async () => ({ kind: 'missing', lines: [], provider: null })),
      artworkPaletteService(),
      testStore(),
    );

    ingestBackfillTrack(player, {
      title: 'Track A',
      artist: 'Artist A',
      album: 'Album A',
      durationMs: 180_000,
      source: '',
    });
    player.ingest(VIN, 'MediaPlaybackStatus', 'PLAYING');
    player.ingest(VIN, 'MediaNowPlayingElapsed', 82_000);
    await vi.advanceTimersByTimeAsync(1_000);
    player.ingest(VIN, 'MediaNowPlayingElapsed', 83_000);

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track B');
    player.ingest(VIN, 'MediaNowPlayingElapsed', 0);
    await vi.advanceTimersByTimeAsync(1_000);
    player.ingest(VIN, 'MediaNowPlayingElapsed', 1_000);
    expect(player.snapshot().playbackClockReady).toBe(true);

    // Duration is another exact-identity field from B's independent metadata
    // burst. It invalidates the mid-burst evidence, but must retain A as the
    // transition root long enough to reject old packets, then recover from
    // B's continuing trajectory within a bounded grace period.
    player.ingest(VIN, 'MediaNowPlayingDuration', 210_000);
    expect(player.snapshot().playbackClockReady).toBe(false);
    player.ingest(VIN, 'MediaNowPlayingElapsed', 2_000);
    expect(player.snapshot().playbackClockReady).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    player.ingest(VIN, 'MediaNowPlayingElapsed', 3_000);
    expect(player.snapshot().playbackClockReady).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    player.ingest(VIN, 'MediaNowPlayingElapsed', 4_000);
    expect(player.snapshot().playbackClockReady).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    player.ingest(VIN, 'MediaNowPlayingElapsed', 5_000);
    expect(player.snapshot().playbackClockReady).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    player.ingest(VIN, 'MediaNowPlayingElapsed', 6_000);
    expect(player.snapshot()).toEqual(expect.objectContaining({
      playbackClockReady: true,
      elapsedMs: 6_000,
    }));
  });

  it('retains both A and mid-burst B trajectories until late metadata settles', async () => {
    const player = new PlayerCoordinator(
      lyricsService(async () => ({ kind: 'missing', lines: [], provider: null })),
      artworkPaletteService(),
      testStore(),
    );

    ingestBackfillTrack(player, {
      title: 'Track A',
      artist: 'Artist A',
      album: 'Album A',
      durationMs: 180_000,
      source: '',
    });
    player.ingest(VIN, 'MediaPlaybackStatus', 'PLAYING');
    player.ingest(VIN, 'MediaNowPlayingElapsed', 82_000);
    await vi.advanceTimersByTimeAsync(1_000);
    player.ingest(VIN, 'MediaNowPlayingElapsed', 83_000);

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track B');
    player.ingest(VIN, 'MediaNowPlayingElapsed', 0);
    expect(player.snapshot().playbackClockReady).toBe(true);
    player.ingest(VIN, 'MediaNowPlayingDuration', 210_000);
    expect(player.snapshot().playbackClockReady).toBe(false);

    player.ingest(VIN, 'MediaNowPlayingElapsed', 83_500);
    await vi.advanceTimersByTimeAsync(1_000);
    player.ingest(VIN, 'MediaNowPlayingElapsed', 84_500);
    expect(player.snapshot().playbackClockReady).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    player.ingest(VIN, 'MediaNowPlayingElapsed', 3_000);
    expect(player.snapshot().playbackClockReady).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    player.ingest(VIN, 'MediaNowPlayingElapsed', 4_000);
    expect(player.snapshot()).toEqual(expect.objectContaining({
      playbackClockReady: true,
      elapsedMs: 4_000,
    }));
  });

  it('rejects a delayed A sample that arrives after B has already reset the clock', async () => {
    const player = new PlayerCoordinator(
      lyricsService(async () => ({ kind: 'missing', lines: [], provider: null })),
      artworkPaletteService(),
      testStore(),
    );

    ingestBackfillTrack(player, {
      title: 'Track A',
      artist: 'Artist A',
      album: 'Album A',
      durationMs: 180_000,
      source: '',
    });
    player.ingest(VIN, 'MediaPlaybackStatus', 'PLAYING');
    player.ingest(VIN, 'MediaNowPlayingElapsed', 82_000);
    await vi.advanceTimersByTimeAsync(1_000);
    player.ingest(VIN, 'MediaNowPlayingElapsed', 83_000);

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track B');
    player.ingest(VIN, 'MediaNowPlayingElapsed', 0);
    expect(player.snapshot().playbackClockReady).toBe(true);

    player.ingest(VIN, 'MediaNowPlayingElapsed', 83_000);
    expect(player.snapshot()).toEqual(expect.objectContaining({
      playbackClockReady: true,
      elapsedMs: 0,
    }));

    await vi.advanceTimersByTimeAsync(1_000);
    player.ingest(VIN, 'MediaNowPlayingElapsed', 1_000);
    expect(player.snapshot()).toEqual(expect.objectContaining({
      playbackClockReady: true,
      elapsedMs: 1_000,
    }));
  });

  it('accepts a resumed high-position B clock only after two continuous samples', async () => {
    const player = new PlayerCoordinator(
      lyricsService(async () => ({ kind: 'missing', lines: [], provider: null })),
      artworkPaletteService(),
      testStore(),
    );

    ingestBackfillTrack(player, {
      title: 'Track A',
      artist: 'Artist A',
      album: 'Album A',
      durationMs: 180_000,
      source: '',
    });
    player.ingest(VIN, 'MediaPlaybackStatus', 'PLAYING');
    player.ingest(VIN, 'MediaNowPlayingElapsed', 82_000);
    await vi.advanceTimersByTimeAsync(1_000);
    player.ingest(VIN, 'MediaNowPlayingElapsed', 83_000);

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track B');
    player.ingest(VIN, 'MediaNowPlayingElapsed', 42_000);
    expect(player.snapshot().playbackClockReady).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    player.ingest(VIN, 'MediaNowPlayingElapsed', 43_000);
    expect(player.snapshot()).toEqual(expect.objectContaining({
      playbackClockReady: true,
      elapsedMs: 43_000,
    }));
  });

  it('uses even a single prior sample to reject delayed A evidence during the grace period', async () => {
    const player = new PlayerCoordinator(
      lyricsService(async () => ({ kind: 'missing', lines: [], provider: null })),
      artworkPaletteService(),
      testStore(),
    );

    ingestBackfillTrack(player, {
      title: 'Track A',
      artist: 'Artist',
      album: 'Album A',
      durationMs: 180_000,
      source: '',
    });
    player.ingest(VIN, 'MediaPlaybackStatus', 'PLAYING');
    player.ingest(VIN, 'MediaNowPlayingElapsed', 83_000);

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track B');
    player.ingest(VIN, 'MediaNowPlayingElapsed', 83_500);
    await vi.advanceTimersByTimeAsync(1_000);
    player.ingest(VIN, 'MediaNowPlayingElapsed', 84_500);
    expect(player.snapshot().playbackClockReady).toBe(false);

    player.ingest(VIN, 'MediaNowPlayingElapsed', 0);
    await vi.advanceTimersByTimeAsync(1_000);
    player.ingest(VIN, 'MediaNowPlayingElapsed', 1_000);
    expect(player.snapshot().playbackClockReady).toBe(true);

    player.ingest(VIN, 'MediaNowPlayingElapsed', 85_500);
    expect(player.snapshot()).toEqual(expect.objectContaining({
      playbackClockReady: true,
      elapsedMs: 1_000,
    }));
  });

  it('lets an ambiguous resumed trajectory take over after grace plus two samples', async () => {
    const player = new PlayerCoordinator(
      lyricsService(async () => ({ kind: 'missing', lines: [], provider: null })),
      artworkPaletteService(),
      testStore(),
    );

    ingestBackfillTrack(player, {
      title: 'Track A',
      artist: 'Artist',
      album: 'Album A',
      durationMs: 180_000,
      source: '',
    });
    player.ingest(VIN, 'MediaPlaybackStatus', 'PLAYING');
    player.ingest(VIN, 'MediaNowPlayingElapsed', 82_000);
    await vi.advanceTimersByTimeAsync(1_000);
    player.ingest(VIN, 'MediaNowPlayingElapsed', 83_000);

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track B');
    for (let second = 0; second < 5; second += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      player.ingest(VIN, 'MediaNowPlayingElapsed', 84_000 + second * 1_000);
    }
    expect(player.snapshot()).toEqual(expect.objectContaining({
      playbackClockReady: true,
      elapsedMs: 88_000,
    }));
  });

  it('requires two continuous samples before a large post-grace jump replaces a ready clock', async () => {
    const player = new PlayerCoordinator(
      lyricsService(async () => ({ kind: 'missing', lines: [], provider: null })),
      artworkPaletteService(),
      testStore(),
    );

    ingestBackfillTrack(player, {
      title: 'Track A',
      artist: 'Artist',
      album: 'Album A',
      durationMs: 180_000,
      source: '',
    });
    player.ingest(VIN, 'MediaPlaybackStatus', 'PLAYING');
    player.ingest(VIN, 'MediaNowPlayingElapsed', 82_000);
    await vi.advanceTimersByTimeAsync(1_000);
    player.ingest(VIN, 'MediaNowPlayingElapsed', 83_000);

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track B');
    player.ingest(VIN, 'MediaNowPlayingElapsed', 0);
    expect(player.snapshot().playbackClockReady).toBe(true);

    await vi.advanceTimersByTimeAsync(5_001);
    player.ingest(VIN, 'MediaNowPlayingElapsed', 88_001);
    expect(player.snapshot().elapsedMs).toBeLessThan(10_000);

    await vi.advanceTimersByTimeAsync(1_000);
    player.ingest(VIN, 'MediaNowPlayingElapsed', 6_001);
    expect(player.snapshot().elapsedMs).toBe(6_001);
  });

  it('accepts a single large seek sample while playback is paused', () => {
    const player = new PlayerCoordinator(
      lyricsService(async () => ({ kind: 'missing', lines: [], provider: null })),
      artworkPaletteService(),
      testStore(),
    );

    ingestBackfillTrack(player, {
      title: 'Paused Track',
      artist: 'Artist',
      album: 'Album',
      durationMs: 180_000,
      source: '',
    });
    player.ingest(VIN, 'MediaPlaybackStatus', 'PAUSED');
    player.ingest(VIN, 'MediaNowPlayingElapsed', 1_000);
    expect(player.snapshot().playbackClockReady).toBe(true);

    player.ingest(VIN, 'MediaNowPlayingElapsed', 50_000);
    expect(player.snapshot()).toEqual(expect.objectContaining({
      playbackClockReady: true,
      elapsedMs: 50_000,
    }));
  });

  it('invalidates a confirmed clock when a nonempty album is cleared before replacement', () => {
    const player = new PlayerCoordinator(
      lyricsService(async () => ({ kind: 'missing', lines: [], provider: null })),
      artworkPaletteService(),
      testStore(),
    );

    ingestBackfillTrack(player, {
      title: 'Same Track',
      artist: 'Artist',
      album: 'Album A',
      durationMs: 180_000,
      source: '',
    });
    player.ingest(VIN, 'MediaNowPlayingElapsed', 30_000);
    expect(player.snapshot().playbackClockReady).toBe(true);

    player.ingest(VIN, 'MediaNowPlayingAlbum', '');
    expect(player.snapshot().playbackClockReady).toBe(false);
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'Album B');
    expect(player.snapshot().playbackClockReady).toBe(false);
  });

  it('coalesces telemetry bursts into one strictly increasing snapshot revision', async () => {
    const player = new PlayerCoordinator(
      lyricsService(async () => ({ kind: 'missing', lines: [], provider: null })),
      artworkPaletteService(),
      testStore(),
    );
    const revisions: number[] = [];
    const unsubscribe = player.subscribe((snapshot) => {
      revisions.push(snapshot.snapshotRevision ?? -1);
    });

    player.setConnection(true);
    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track A');
    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track A');
    await vi.advanceTimersByTimeAsync(0);
    unsubscribe();

    expect(revisions).toHaveLength(2);
    expect(revisions.slice(1).every((revision, index) =>
      revision > revisions[index])).toBe(true);
    expect(player.snapshot().snapshotRevision).toBe(revisions.at(-1));
  });

  it('serializes a published snapshot once for every SSE subscriber', async () => {
    const player = new PlayerCoordinator(
      lyricsService(async () => ({ kind: 'missing', lines: [], provider: null })),
      artworkPaletteService(),
      testStore(),
    );
    const first: string[] = [];
    const second: string[] = [];
    const unsubscribeFirst = player.subscribeSerialized((snapshot) => first.push(snapshot));
    const unsubscribeSecond = player.subscribeSerialized((snapshot) => second.push(snapshot));
    const stringify = vi.spyOn(JSON, 'stringify');

    player.setConnection(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(stringify).toHaveBeenCalledTimes(1);
    expect(first.at(-1)).toBe(second.at(-1));
    expect(JSON.parse(first.at(-1) ?? '{}')).toMatchObject({ connection: 'connected' });
    unsubscribeFirst();
    unsubscribeSecond();
  });

  it('does not query or publish an intermediate title-only metadata epoch', async () => {
    const find = vi.fn()
      .mockResolvedValueOnce({
        kind: 'synced',
        lines: [{ id: 'a', startMs: 0, text: 'Track A' }],
        provider: 'apple',
      } satisfies LyricsPayload)
      .mockResolvedValueOnce({
        kind: 'synced',
        lines: [{ id: 'c', startMs: 0, text: 'Track C' }],
        provider: 'apple',
      } satisfies LyricsPayload);
    const player = new PlayerCoordinator(lyricsService(find), artworkPaletteService(), testStore());

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track A');
    await vi.advanceTimersByTimeAsync(200);
    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track B');
    await vi.advanceTimersByTimeAsync(1_000);
    const generationB = player.snapshot().trackGeneration;
    expect(find).toHaveBeenCalledTimes(1);
    expect(player.snapshot().lyrics.lines[0]?.text).toBe('Track A');

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track C');
    const generationC = player.snapshot().trackGeneration;
    expect(generationC).toBe((generationB ?? 0) + 1);
    expect(player.snapshot().lyricsGeneration).not.toBe(generationC);

    await vi.advanceTimersByTimeAsync(1_249);
    expect(find).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(player.snapshot()).toEqual(expect.objectContaining({
      trackGeneration: generationC,
      lyricsGeneration: generationC,
    }));
    expect(find).toHaveBeenCalledTimes(2);
    expect(find.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      title: 'Track C',
      artist: '',
      album: '',
      durationMs: 0,
    }));
    expect(player.snapshot().lyrics.lines[0]?.text).toBe('Track C');
  });

  it.each(fieldPermutations(APPLE_BACKFILL_TEST_FIELDS).map((order) => [
    order.join(' → '),
    order,
  ] as const))(
    'publishes one lyrics version when replacement fields arrive as %s',
    async (_label, order) => {
      const trackA: TrackMetadata = {
        title: 'Track A',
        artist: 'Artist A',
        album: 'Album A',
        durationMs: 180_000,
        source: '',
      };
      const trackB: TrackMetadata = {
        title: 'Track B',
        artist: 'Artist B',
        album: 'Album B',
        durationMs: 200_000,
        source: '',
      };
      const find = vi.fn(async (track: TrackMetadata): Promise<LyricsPayload> => ({
        kind: 'synced',
        lines: [{
          id: track.title,
          startMs: 0,
          text: `${track.title}|${track.artist}|${track.album}|${track.durationMs}`,
        }],
        provider: 'apple',
      }));
      const player = new PlayerCoordinator(
        lyricsService(find),
        artworkPaletteService(),
        testStore(),
      );

      ingestBackfillTrack(player, trackA);
      await vi.advanceTimersByTimeAsync(LYRICS_METADATA_DEBOUNCE_MS);
      expect(find).toHaveBeenCalledTimes(1);

      for (const [index, field] of order.entries()) {
        ingestBackfillTrackField(player, trackB, field);
        if (index < order.length - 1) {
          await vi.advanceTimersByTimeAsync(
            LYRICS_TRANSITION_INCOMPLETE_SETTLE_MS - 250,
          );
          expect(find).toHaveBeenCalledTimes(1);
          expect(player.snapshot().lyrics.lines[0]?.text).toContain('Track A|');
        }
      }

      await vi.advanceTimersByTimeAsync(
        LYRICS_TRANSITION_INCOMPLETE_SETTLE_MS - 1,
      );
      expect(find).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);

      expect(find).toHaveBeenCalledTimes(2);
      expect(find.mock.calls[1]?.[0]).toEqual(trackB);
      expect(player.snapshot().lyrics.lines[0]?.text).toBe(
        'Track B|Artist B|Album B|200000',
      );
    },
  );

  it('marks previous lyrics stale for the full duration of a replacement lookup', async () => {
    let finishReplacement: ((lyrics: LyricsPayload) => void) | undefined;
    const replacement = new Promise<LyricsPayload>((resolve) => {
      finishReplacement = resolve;
    });
    const find = vi.fn()
      .mockResolvedValueOnce({
        kind: 'synced',
        lines: [{ id: 'a', startMs: 0, text: 'Track A timeline' }],
        provider: 'apple',
      } satisfies LyricsPayload)
      .mockReturnValueOnce(replacement);
    const player = new PlayerCoordinator(
      lyricsService(find),
      artworkPaletteService(),
      testStore(),
    );

    ingestBackfillTrack(player, {
      title: 'Track A',
      artist: 'Artist A',
      album: 'Album A',
      durationMs: 180_000,
      source: '',
    });
    await vi.advanceTimersByTimeAsync(LYRICS_METADATA_DEBOUNCE_MS);
    expect(player.snapshot().lyricsTrackMatchesCurrent).toBe(true);

    ingestBackfillTrack(player, {
      title: 'Track B',
      artist: 'Artist B',
      album: 'Album B',
      durationMs: 200_000,
      source: '',
    });
    expect(player.snapshot()).toEqual(expect.objectContaining({
      lyricsTrackMatchesCurrent: false,
      lyrics: expect.objectContaining({
        kind: 'synced',
        lines: [expect.objectContaining({ text: 'Track A timeline' })],
      }),
    }));

    await vi.advanceTimersByTimeAsync(LYRICS_METADATA_DEBOUNCE_MS);
    expect(player.snapshot()).toEqual(expect.objectContaining({
      lyricsTrackMatchesCurrent: false,
      lyrics: expect.objectContaining({ kind: 'loading' }),
    }));

    await vi.advanceTimersByTimeAsync(18_000);
    expect(player.snapshot().lyricsTrackMatchesCurrent).toBe(false);

    finishReplacement?.({
      kind: 'synced',
      lines: [{ id: 'b', startMs: 0, text: 'Track B timeline' }],
      provider: 'apple',
    });
    await Promise.resolve();
    expect(player.snapshot()).toEqual(expect.objectContaining({
      lyricsTrackMatchesCurrent: true,
      lyrics: expect.objectContaining({
        kind: 'synced',
        lines: [expect.objectContaining({ text: 'Track B timeline' })],
      }),
    }));
  });

  it('replaces an early next-track artist with the later title epoch artist', async () => {
    const trackA: TrackMetadata = {
      title: 'Track A',
      artist: 'Artist A',
      album: 'Album A',
      durationMs: 180_000,
      source: '',
    };
    const trackB: TrackMetadata = {
      title: 'Track B',
      artist: 'Artist B',
      album: 'Album B',
      durationMs: 200_000,
      source: '',
    };
    const trackC: TrackMetadata = {
      title: 'Track C',
      artist: 'Artist C',
      album: 'Album C',
      durationMs: 220_000,
      source: '',
    };
    const find = vi.fn(async (track: TrackMetadata): Promise<LyricsPayload> => ({
      kind: 'synced',
      lines: [{ id: track.title, startMs: 0, text: track.title }],
      provider: 'apple',
    }));
    const player = new PlayerCoordinator(
      lyricsService(find),
      artworkPaletteService(),
      testStore(),
    );

    ingestBackfillTrack(player, trackA);
    await vi.advanceTimersByTimeAsync(LYRICS_METADATA_DEBOUNCE_MS);

    ingestBackfillTrackField(player, trackB, 'artist');
    await vi.advanceTimersByTimeAsync(1_000);
    for (const field of ['title', 'album', 'durationMs', 'artist'] as const) {
      ingestBackfillTrackField(player, trackC, field);
      if (field !== 'artist') await vi.advanceTimersByTimeAsync(1_000);
    }

    expect(find).toHaveBeenCalledTimes(1);
    expect(player.snapshot().lyrics.lines[0]?.text).toBe('Track A');
    await vi.advanceTimersByTimeAsync(LYRICS_TRANSITION_INCOMPLETE_SETTLE_MS);

    expect(find).toHaveBeenCalledTimes(2);
    expect(find.mock.calls[1]?.[0]).toEqual(trackC);
    expect(player.snapshot().lyrics.lines[0]?.text).toBe('Track C');
  });

  it('pins a title-only version when the remaining metadata arrives late', async () => {
    const find = vi.fn()
      .mockResolvedValueOnce({
        kind: 'synced',
        lines: [{ id: 'a', startMs: 0, text: 'Track A timeline' }],
        provider: 'apple',
      } satisfies LyricsPayload)
      .mockResolvedValueOnce({
        kind: 'synced',
        lines: [{ id: 'b-provisional', startMs: 0, text: 'Track B provisional timeline' }],
        provider: 'lrclib',
      } satisfies LyricsPayload)
      .mockResolvedValueOnce({
        kind: 'synced',
        lines: [{ id: 'b-exact', startMs: 200, text: 'Track B exact timeline' }],
        provider: 'apple',
      } satisfies LyricsPayload);
    const player = new PlayerCoordinator(
      lyricsService(find),
      artworkPaletteService(),
      testStore(),
    );

    ingestBackfillTrack(player, {
      title: 'Track A',
      artist: 'Artist A',
      album: 'Album A',
      durationMs: 180_000,
      source: '',
    });
    await vi.advanceTimersByTimeAsync(LYRICS_METADATA_DEBOUNCE_MS);

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track B');
    await vi.advanceTimersByTimeAsync(LYRICS_TRANSITION_INCOMPLETE_SETTLE_MS);
    expect(player.snapshot().lyrics.lines[0]?.text).toBe(
      'Track B provisional timeline',
    );

    player.ingest(VIN, 'MediaNowPlayingArtist', 'Artist B');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'Album B');
    player.ingest(VIN, 'MediaNowPlayingDuration', 200_000);
    await vi.advanceTimersByTimeAsync(LYRICS_TRANSITION_INCOMPLETE_SETTLE_MS);

    expect(find).toHaveBeenCalledTimes(3);
    expect(find.mock.calls[2]?.[0]).toEqual(expect.objectContaining({
      title: 'Track B',
      artist: 'Artist B',
      album: 'Album B',
      durationMs: 200_000,
    }));
    expect(find.mock.calls[2]?.[1]).toEqual({ bypassLocalCache: true });
    expect(player.snapshot().lyrics.lines[0]?.text).toBe(
      'Track B provisional timeline',
    );
  });

  it('logs anonymous initial, replaced, and pinned version decisions', async () => {
    const productionConfig = config as typeof config & { isProduction: boolean };
    productionConfig.isProduction = true;
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const find = vi.fn()
      .mockResolvedValueOnce({
        kind: 'synced',
        lines: [{ id: 'a', startMs: 0, text: 'Private Track A lyrics' }],
        provider: 'lrclib',
        providerId: 1,
      } satisfies LyricsPayload)
      .mockResolvedValueOnce({
        kind: 'synced',
        lines: [{ id: 'b', startMs: 0, text: 'Private Track B lyrics' }],
        provider: 'apple',
        providerId: 2,
      } satisfies LyricsPayload)
      .mockResolvedValueOnce({
        kind: 'synced',
        lines: [{ id: 'b2', startMs: 100, text: 'Private corrected lyrics' }],
        provider: 'apple',
        providerId: 3,
      } satisfies LyricsPayload);
    const player = new PlayerCoordinator(
      lyricsService(find),
      artworkPaletteService(),
      testStore(),
    );

    try {
      ingestBackfillTrack(player, {
        title: 'Private Track A',
        artist: 'Private Artist A',
        album: 'Private Album A',
        durationMs: 180_000,
        source: '',
      });
      await vi.advanceTimersByTimeAsync(LYRICS_METADATA_DEBOUNCE_MS);
      ingestBackfillTrack(player, {
        title: 'Private Track B',
        artist: 'Private Artist B',
        album: 'Private Album B',
        durationMs: 200_000,
        source: '',
      });
      await vi.advanceTimersByTimeAsync(LYRICS_METADATA_DEBOUNCE_MS);
      player.ingest(VIN, 'MediaNowPlayingAlbum', 'Private Album B corrected');
      await vi.advanceTimersByTimeAsync(LYRICS_TRANSITION_INCOMPLETE_SETTLE_MS);

      const events = info.mock.calls.map(([message]) => JSON.parse(String(message)));
      expect(events.map((event) => event.action)).toEqual([
        'initial',
        'replaced',
        'pinned',
      ]);
      expect(events.every((event) => /^[a-f0-9]{16}$/.test(event.trackHash))).toBe(true);
      expect(info.mock.calls.map(([message]) => String(message)).join('\n')).not.toMatch(
        /Private Track|Private Artist|Private Album|Private corrected lyrics/,
      );
    } finally {
      productionConfig.isProduction = false;
    }
  });

  it.each([
    ['a synced hit', {
      kind: 'synced',
      lines: [{ id: '0', startMs: 0, text: 'Found' }],
      provider: 'lrclib',
    }],
    ['a definitive miss', {
      kind: 'missing',
      lines: [],
      provider: null,
    }],
    ['a retryable failure', {
      kind: 'missing',
      lines: [],
      provider: null,
      retryable: true,
    }],
  ] satisfies Array<[string, LyricsPayload]>)(
    'observes complete playback independently from %s',
    async (_label, payload) => {
      const find = vi.fn(async () => payload);
      const observePlayback = vi.fn();
      const player = new PlayerCoordinator(
        lyricsService(find, observePlayback),
        artworkPaletteService(),
        testStore(),
      );

      player.ingest(VIN, 'MediaNowPlayingTitle', 'Midnight Circuit');
      player.ingest(VIN, 'MediaNowPlayingArtist', 'Local Drive');
      player.ingest(VIN, 'MediaNowPlayingAlbum', 'After Dark');
      player.ingest(VIN, 'MediaNowPlayingDuration', 214_000);
      await vi.advanceTimersByTimeAsync(1_500);

      // Identical Fleet Telemetry must not keep postponing the observation.
      player.ingest(VIN, 'MediaNowPlayingTitle', 'Midnight Circuit');
      player.ingest(VIN, 'MediaNowPlayingArtist', 'Local Drive');
      expect(observePlayback).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(500);
      expect(observePlayback).toHaveBeenCalledExactlyOnceWith({
        title: 'Midnight Circuit',
        artist: 'Local Drive',
        album: 'After Dark',
        durationMs: 214_000,
        source: '',
      });
      expect(find).toHaveBeenCalledTimes(1);
    },
  );

  it('drops a sub-debounce track instead of mixing it with later metadata', async () => {
    const observePlayback = vi.fn();
    const player = new PlayerCoordinator(
      lyricsService(
        vi.fn(async (): Promise<LyricsPayload> => ({
          kind: 'missing',
          lines: [],
          provider: null,
        })),
        observePlayback,
      ),
      artworkPaletteService(),
      testStore(),
    );

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track A');
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Artist A');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'Album A');
    player.ingest(VIN, 'MediaNowPlayingDuration', 180_000);
    await vi.advanceTimersByTimeAsync(500);
    expect(observePlayback).not.toHaveBeenCalled();

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track B');
    expect(observePlayback).not.toHaveBeenCalled();

    // The old artist/album/duration still live in the UI snapshot, but they
    // are not eligible for the new playback metadata epoch.
    await vi.advanceTimersByTimeAsync(1_100);
    expect(observePlayback).not.toHaveBeenCalled();
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Artist B');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'Album B');
    player.ingest(VIN, 'MediaNowPlayingDuration', 'not-a-number');
    await vi.advanceTimersByTimeAsync(1_100);
    expect(observePlayback).not.toHaveBeenCalled();

    player.ingest(VIN, 'MediaNowPlayingDuration', 200_000);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(observePlayback).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(observePlayback).toHaveBeenCalledExactlyOnceWith({
      title: 'Track B',
      artist: 'Artist B',
      album: 'Album B',
      durationMs: 200_000,
      source: '',
    });
  });

  it('accepts an initial metadata burst whose title arrives last', async () => {
    const observePlayback = vi.fn();
    const player = new PlayerCoordinator(
      lyricsService(
        vi.fn(async (): Promise<LyricsPayload> => ({
          kind: 'missing',
          lines: [],
          provider: null,
        })),
        observePlayback,
      ),
      artworkPaletteService(),
      testStore(),
    );

    player.ingest(VIN, 'MediaNowPlayingArtist', 'Local Drive');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'After Dark');
    player.ingest(VIN, 'MediaNowPlayingDuration', 214_000);
    player.ingest(VIN, 'MediaNowPlayingTitle', 'Midnight Circuit');
    await vi.advanceTimersByTimeAsync(2_000);

    expect(observePlayback).toHaveBeenCalledExactlyOnceWith({
      title: 'Midnight Circuit',
      artist: 'Local Drive',
      album: 'After Dark',
      durationMs: 214_000,
      source: '',
    });
  });

  it('starts a clean next epoch when its artist arrives before its title', async () => {
    const observePlayback = vi.fn();
    const player = new PlayerCoordinator(
      lyricsService(
        vi.fn(async (): Promise<LyricsPayload> => ({
          kind: 'missing',
          lines: [],
          provider: null,
        })),
        observePlayback,
      ),
      artworkPaletteService(),
      testStore(),
    );

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track A');
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Artist A');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'Album A');
    player.ingest(VIN, 'MediaNowPlayingDuration', 180_000);
    await vi.advanceTimersByTimeAsync(500);

    player.ingest(VIN, 'MediaNowPlayingArtist', 'Artist B');
    expect(observePlayback).not.toHaveBeenCalled();

    player.ingest(VIN, 'MediaNowPlayingAlbum', 'Album B');
    player.ingest(VIN, 'MediaNowPlayingDuration', 200_000);
    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track B');
    await vi.advanceTimersByTimeAsync(2_000);

    expect(observePlayback).toHaveBeenCalledExactlyOnceWith({
      title: 'Track B',
      artist: 'Artist B',
      album: 'Album B',
      durationMs: 200_000,
      source: '',
    });
  });

  it('does not use repeated stable fields to promote a new exact track', async () => {
    const observePlayback = vi.fn();
    const player = new PlayerCoordinator(
      lyricsService(
        vi.fn(async (): Promise<LyricsPayload> => ({
          kind: 'missing',
          lines: [],
          provider: null,
        })),
        observePlayback,
      ),
      artworkPaletteService(),
      testStore(),
    );

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track A');
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Shared Artist');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'Shared Album');
    player.ingest(VIN, 'MediaNowPlayingDuration', 180_000);
    player.ingest(VIN, 'MediaNowPlayingElapsed', 60_000);
    await vi.advanceTimersByTimeAsync(2_000);

    player.ingest(VIN, 'MediaNowPlayingArtist', 'Shared Artist');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'Shared Album');
    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track B');
    player.ingest(VIN, 'MediaNowPlayingDuration', 200_000);
    player.ingest(VIN, 'MediaNowPlayingElapsed', 0);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(observePlayback).toHaveBeenCalledExactlyOnceWith({
      title: 'Track A',
      artist: 'Shared Artist',
      album: 'Shared Album',
      durationMs: 180_000,
      source: '',
    });
  });

  it('does not carry repeated fields across a completed observation', async () => {
    const observePlayback = vi.fn();
    const player = new PlayerCoordinator(
      lyricsService(
        vi.fn(async (): Promise<LyricsPayload> => ({
          kind: 'missing',
          lines: [],
          provider: null,
        })),
        observePlayback,
      ),
      artworkPaletteService(),
      testStore(),
    );

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track A');
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Artist A');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'Album A');
    player.ingest(VIN, 'MediaNowPlayingDuration', 180_000);
    await vi.advanceTimersByTimeAsync(1_500);
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Artist A');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'Album A');
    await vi.advanceTimersByTimeAsync(500);
    expect(observePlayback).toHaveBeenCalledTimes(1);

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track B');
    player.ingest(VIN, 'MediaNowPlayingDuration', 200_000);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(observePlayback).toHaveBeenCalledTimes(1);

    player.ingest(VIN, 'MediaNowPlayingArtist', 'Artist B');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'Album B');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(observePlayback).toHaveBeenCalledTimes(2);
    expect(observePlayback).toHaveBeenLastCalledWith({
      title: 'Track B',
      artist: 'Artist B',
      album: 'Album B',
      durationMs: 200_000,
      source: '',
    });
  });

  it.each(fieldPermutations(APPLE_BACKFILL_TEST_FIELDS).map((order) => [
    order.join(' → '),
    order,
  ] as const))(
    'does not mix a completed 30-second resend into the next track (%s)',
    async (_label, order) => {
      const observePlayback = vi.fn();
      const player = new PlayerCoordinator(
        lyricsService(
          vi.fn(async (): Promise<LyricsPayload> => ({
            kind: 'missing',
            lines: [],
            provider: null,
          })),
          observePlayback,
        ),
        artworkPaletteService(),
        testStore(),
      );
      const trackA: TrackMetadata = {
        title: 'Track A',
        artist: 'Artist A',
        album: 'Album A',
        durationMs: 180_000,
        source: '',
      };
      const trackB: TrackMetadata = {
        title: 'Track B',
        artist: 'Artist B',
        album: 'Album B',
        durationMs: 200_000,
        source: '',
      };

      ingestBackfillTrack(player, trackA);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(observePlayback).toHaveBeenCalledExactlyOnceWith(trackA);

      await vi.advanceTimersByTimeAsync(30_000);
      ingestBackfillTrack(player, trackA);
      expect(observePlayback).toHaveBeenCalledTimes(1);

      for (const field of order) {
        ingestBackfillTrackField(player, trackB, field);
        expect(observePlayback).toHaveBeenCalledTimes(1);
      }
      await vi.advanceTimersByTimeAsync(1_999);
      expect(observePlayback).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(observePlayback).toHaveBeenCalledTimes(2);
      expect(observePlayback).toHaveBeenLastCalledWith(trackB);
    },
  );

  it.each(APPLE_BACKFILL_TEST_FIELDS)(
    'does not flush an unconfirmed short track when %s changes first',
    async (firstField) => {
      const observePlayback = vi.fn();
      const player = new PlayerCoordinator(
        lyricsService(
          vi.fn(async (): Promise<LyricsPayload> => ({
            kind: 'missing',
            lines: [],
            provider: null,
          })),
          observePlayback,
        ),
        artworkPaletteService(),
        testStore(),
      );
      const trackA: TrackMetadata = {
        title: 'Track A',
        artist: 'Artist A',
        album: 'Album A',
        durationMs: 180_000,
        source: '',
      };
      const trackB: TrackMetadata = {
        title: 'Track B',
        artist: 'Artist B',
        album: 'Album B',
        durationMs: 200_000,
        source: '',
      };

      ingestBackfillTrack(player, trackA);
      await vi.advanceTimersByTimeAsync(500);
      expect(observePlayback).not.toHaveBeenCalled();

      ingestBackfillTrackField(player, trackB, firstField);
      expect(observePlayback).not.toHaveBeenCalled();
      ingestBackfillTrack(
        player,
        trackB,
        APPLE_BACKFILL_TEST_FIELDS.filter((field) => field !== firstField),
      );
      await vi.advanceTimersByTimeAsync(2_000);

      expect(observePlayback).toHaveBeenCalledExactlyOnceWith(trackB);
    },
  );

  it('does not promote a shared-field candidate from repeated stable values', async () => {
    const observePlayback = vi.fn();
    const player = new PlayerCoordinator(
      lyricsService(
        vi.fn(async (): Promise<LyricsPayload> => ({
          kind: 'missing',
          lines: [],
          provider: null,
        })),
        observePlayback,
      ),
      artworkPaletteService(),
      testStore(),
    );
    const trackA: TrackMetadata = {
      title: 'Track A',
      artist: 'Shared Artist',
      album: 'Shared Album',
      durationMs: 180_000,
      source: '',
    };
    const trackB: TrackMetadata = {
      title: 'Track B',
      artist: 'Shared Artist',
      album: 'Shared Album',
      durationMs: 200_000,
      source: '',
    };

    ingestBackfillTrack(player, trackA);
    await vi.advanceTimersByTimeAsync(2_000);
    player.ingest(VIN, 'MediaNowPlayingElapsed', 60_000);
    ingestBackfillTrackField(player, trackB, 'artist');
    ingestBackfillTrackField(player, trackB, 'album');
    ingestBackfillTrackField(player, trackB, 'title');
    ingestBackfillTrackField(player, trackB, 'durationMs');
    player.ingest(VIN, 'MediaNowPlayingElapsed', 0);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(observePlayback).toHaveBeenCalledExactlyOnceWith(trackA);
  });

  it.each([
    ['artist', {
      title: 'Track B',
      artist: 'Shared Artist',
      album: 'Album B',
      durationMs: 200_000,
      source: '',
    }],
    ['album', {
      title: 'Track B',
      artist: 'Artist B',
      album: 'Shared Album',
      durationMs: 200_000,
      source: '',
    }],
    ['duration', {
      title: 'Track B',
      artist: 'Artist B',
      album: 'Album B',
      durationMs: 180_000,
      source: '',
    }],
    ['artist, album, and duration', {
      title: 'Track B',
      artist: 'Shared Artist',
      album: 'Shared Album',
      durationMs: 180_000,
      source: '',
    }],
  ] satisfies Array<[string, TrackMetadata]>)(
    'observes a new track when Tesla does not re-emit its shared %s metadata',
    async (_label, trackB) => {
      const observePlayback = vi.fn();
      const player = new PlayerCoordinator(
        lyricsService(
          vi.fn(async (): Promise<LyricsPayload> => ({
            kind: 'missing',
            lines: [],
            provider: null,
          })),
          observePlayback,
        ),
        artworkPaletteService(),
        testStore(),
      );
      const trackA: TrackMetadata = {
        title: 'Track A',
        artist: 'Shared Artist',
        album: 'Shared Album',
        durationMs: 180_000,
        source: '',
      };

      ingestBackfillTrack(player, trackA);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(observePlayback).toHaveBeenCalledExactlyOnceWith(trackA);

      // Fleet Telemetry emits changed values immediately, but unchanged fields
      // may not be sent again until the 30-second resend interval.
      ingestBackfillTrack(
        player,
        trackB,
        APPLE_BACKFILL_TEST_FIELDS.filter(
          (field) => trackB[field] !== trackA[field],
        ),
      );
      await vi.advanceTimersByTimeAsync(1_999);
      expect(observePlayback).toHaveBeenCalledExactlyOnceWith(trackA);
      await vi.advanceTimersByTimeAsync(1);

      expect(observePlayback).toHaveBeenCalledTimes(2);
      expect(observePlayback).toHaveBeenLastCalledWith(trackB);
    },
  );

  it('observes a shared-metadata track immediately after a complete stable resend', async () => {
    const observePlayback = vi.fn();
    const player = new PlayerCoordinator(
      lyricsService(
        vi.fn(async (): Promise<LyricsPayload> => ({
          kind: 'missing',
          lines: [],
          provider: null,
        })),
        observePlayback,
      ),
      artworkPaletteService(),
      testStore(),
    );
    const trackA: TrackMetadata = {
      title: 'Track A',
      artist: 'Shared Artist',
      album: 'Shared Album',
      durationMs: 180_000,
      source: '',
    };
    const trackB: TrackMetadata = {
      ...trackA,
      title: 'Track B',
    };

    ingestBackfillTrack(player, trackA);
    await vi.advanceTimersByTimeAsync(2_000);
    ingestBackfillTrack(player, trackA);
    await vi.advanceTimersByTimeAsync(1_000);

    ingestBackfillTrackField(player, trackB, 'title');
    await vi.advanceTimersByTimeAsync(2_000);

    expect(observePlayback).toHaveBeenCalledTimes(2);
    expect(observePlayback).toHaveBeenLastCalledWith(trackB);
  });

  it('observes a shared-metadata track after an independent stable field resend', async () => {
    const observePlayback = vi.fn();
    const player = new PlayerCoordinator(
      lyricsService(
        vi.fn(async (): Promise<LyricsPayload> => ({
          kind: 'missing',
          lines: [],
          provider: null,
        })),
        observePlayback,
      ),
      artworkPaletteService(),
      testStore(),
    );
    const trackA: TrackMetadata = {
      title: 'Track A',
      artist: 'Shared Artist',
      album: 'Shared Album',
      durationMs: 180_000,
      source: '',
    };
    const trackB: TrackMetadata = {
      ...trackA,
      title: 'Track B',
    };

    ingestBackfillTrack(player, trackA);
    await vi.advanceTimersByTimeAsync(2_000);
    ingestBackfillTrackField(player, trackA, 'artist');
    await vi.advanceTimersByTimeAsync(1_000);

    ingestBackfillTrackField(player, trackB, 'title');
    await vi.advanceTimersByTimeAsync(2_999);
    expect(observePlayback).toHaveBeenCalledExactlyOnceWith(trackA);
    await vi.advanceTimersByTimeAsync(1);

    expect(observePlayback).toHaveBeenCalledTimes(2);
    expect(observePlayback).toHaveBeenLastCalledWith(trackB);
  });

  it('lets hard epoch expiry win over a cautious commit due at the same instant', async () => {
    const observePlayback = vi.fn();
    const player = new PlayerCoordinator(
      lyricsService(
        vi.fn(async (): Promise<LyricsPayload> => ({
          kind: 'missing',
          lines: [],
          provider: null,
        })),
        observePlayback,
      ),
      artworkPaletteService(),
      testStore(),
    );
    const trackA: TrackMetadata = {
      title: 'Track A',
      artist: 'Artist A',
      album: 'Shared Album',
      durationMs: 180_000,
      source: '',
    };
    const trackB: TrackMetadata = {
      ...trackA,
      title: 'Track B',
      artist: 'Artist B',
    };

    ingestBackfillTrack(player, trackA);
    await vi.advanceTimersByTimeAsync(2_000);
    ingestBackfillTrackField(player, trackA, 'artist');
    await vi.advanceTimersByTimeAsync(1_000);

    setTimeout(() => {
      ingestBackfillTrackField(player, trackB, 'artist');
    }, 3_000);
    ingestBackfillTrackField(player, trackB, 'title');
    await vi.advanceTimersByTimeAsync(5_000);

    expect(observePlayback).toHaveBeenCalledExactlyOnceWith(trackA);
    await vi.runOnlyPendingTimersAsync();
    expect(observePlayback).toHaveBeenCalledExactlyOnceWith(trackA);
  });

  it('does not treat a delayed stable resend as confirmation of inherited fields', async () => {
    const observePlayback = vi.fn();
    const player = new PlayerCoordinator(
      lyricsService(
        vi.fn(async (): Promise<LyricsPayload> => ({
          kind: 'missing',
          lines: [],
          provider: null,
        })),
        observePlayback,
      ),
      artworkPaletteService(),
      testStore(),
    );
    const trackA: TrackMetadata = {
      title: 'Track A',
      artist: 'Artist A',
      album: 'Album A',
      durationMs: 180_000,
      source: '',
    };

    ingestBackfillTrack(player, trackA);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(observePlayback).toHaveBeenCalledExactlyOnceWith(trackA);

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track B');
    ingestBackfillTrack(
      player,
      trackA,
      ['artist', 'album', 'durationMs'],
    );
    await vi.advanceTimersByTimeAsync(2_000);

    expect(observePlayback).toHaveBeenCalledExactlyOnceWith(trackA);
  });

  it('expires an incomplete resend before accepting a later track', async () => {
    const observePlayback = vi.fn();
    const player = new PlayerCoordinator(
      lyricsService(
        vi.fn(async (): Promise<LyricsPayload> => ({
          kind: 'missing',
          lines: [],
          provider: null,
        })),
        observePlayback,
      ),
      artworkPaletteService(),
      testStore(),
    );
    const trackA: TrackMetadata = {
      title: 'Track A',
      artist: 'Artist A',
      album: 'Album A',
      durationMs: 180_000,
      source: '',
    };
    const trackB: TrackMetadata = {
      title: 'Track B',
      artist: 'Artist B',
      album: 'Album B',
      durationMs: 200_000,
      source: '',
    };

    ingestBackfillTrack(player, trackA);
    await vi.advanceTimersByTimeAsync(2_000);
    ingestBackfillTrackField(player, trackA, 'artist');
    ingestBackfillTrackField(player, trackA, 'album');
    await vi.advanceTimersByTimeAsync(APPLE_BACKFILL_TEST_FIELDS.length * 1_000);

    ingestBackfillTrackField(player, trackB, 'title');
    ingestBackfillTrackField(player, trackB, 'durationMs');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(observePlayback).toHaveBeenCalledTimes(1);

    ingestBackfillTrackField(player, trackB, 'artist');
    ingestBackfillTrackField(player, trackB, 'album');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(observePlayback).toHaveBeenCalledTimes(2);
    expect(observePlayback).toHaveBeenLastCalledWith(trackB);
  });

  it('does not promote a partial resend mixed with a later title and duration', async () => {
    const observePlayback = vi.fn();
    const player = new PlayerCoordinator(
      lyricsService(
        vi.fn(async (): Promise<LyricsPayload> => ({
          kind: 'missing',
          lines: [],
          provider: null,
        })),
        observePlayback,
      ),
      artworkPaletteService(),
      testStore(),
    );
    const trackA: TrackMetadata = {
      title: 'Track A',
      artist: 'Artist A',
      album: 'Album A',
      durationMs: 180_000,
      source: '',
    };
    const trackB: TrackMetadata = {
      title: 'Track B',
      artist: 'Artist B',
      album: 'Album B',
      durationMs: 200_000,
      source: '',
    };

    ingestBackfillTrack(player, trackA);
    await vi.advanceTimersByTimeAsync(2_000);
    ingestBackfillTrackField(player, trackA, 'artist');
    ingestBackfillTrackField(player, trackA, 'album');
    ingestBackfillTrackField(player, trackB, 'title');
    ingestBackfillTrackField(player, trackB, 'durationMs');
    await vi.advanceTimersByTimeAsync(2_000);

    expect(observePlayback).toHaveBeenCalledExactlyOnceWith(trackA);
  });

  it('does not let an elapsed reset promote fields from a partial resend', async () => {
    const observePlayback = vi.fn();
    const player = new PlayerCoordinator(
      lyricsService(
        vi.fn(async (): Promise<LyricsPayload> => ({
          kind: 'missing',
          lines: [],
          provider: null,
        })),
        observePlayback,
      ),
      artworkPaletteService(),
      testStore(),
    );
    const trackA: TrackMetadata = {
      title: 'Track A',
      artist: 'Artist A',
      album: 'Album A',
      durationMs: 180_000,
      source: '',
    };
    const trackB: TrackMetadata = {
      title: 'Track B',
      artist: 'Artist B',
      album: 'Album B',
      durationMs: 200_000,
      source: '',
    };

    ingestBackfillTrack(player, trackA);
    player.ingest(VIN, 'MediaNowPlayingElapsed', 60_000);
    await vi.advanceTimersByTimeAsync(2_000);
    ingestBackfillTrackField(player, trackA, 'artist');
    ingestBackfillTrackField(player, trackA, 'album');
    ingestBackfillTrackField(player, trackB, 'title');
    ingestBackfillTrackField(player, trackB, 'durationMs');
    player.ingest(VIN, 'MediaNowPlayingElapsed', 0);
    await vi.advanceTimersByTimeAsync(2_100);

    expect(observePlayback).toHaveBeenCalledExactlyOnceWith(trackA);
  });

  it('waits for direct replacement fields before promoting after a partial resend', async () => {
    const observePlayback = vi.fn();
    const player = new PlayerCoordinator(
      lyricsService(
        vi.fn(async (): Promise<LyricsPayload> => ({
          kind: 'missing',
          lines: [],
          provider: null,
        })),
        observePlayback,
      ),
      artworkPaletteService(),
      testStore(),
    );
    const trackA: TrackMetadata = {
      title: 'Track A',
      artist: 'Artist A',
      album: 'Album A',
      durationMs: 180_000,
      source: '',
    };
    const trackB: TrackMetadata = {
      title: 'Track B',
      artist: 'Artist B',
      album: 'Album B',
      durationMs: 200_000,
      source: '',
    };

    ingestBackfillTrack(player, trackA);
    await vi.advanceTimersByTimeAsync(2_000);
    ingestBackfillTrackField(player, trackA, 'artist');
    ingestBackfillTrackField(player, trackA, 'album');
    ingestBackfillTrackField(player, trackB, 'title');
    ingestBackfillTrackField(player, trackB, 'durationMs');
    await vi.advanceTimersByTimeAsync(999);
    ingestBackfillTrackField(player, trackB, 'artist');
    ingestBackfillTrackField(player, trackB, 'album');
    await vi.advanceTimersByTimeAsync(1_999);
    expect(observePlayback).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(observePlayback).toHaveBeenCalledTimes(2);
    expect(observePlayback).toHaveBeenLastCalledWith(trackB);
  });

  it.each(APPLE_BACKFILL_TEST_FIELDS)(
    'does not promote an interleaved resend when %s changes inside it',
    async (changedField) => {
      const observePlayback = vi.fn();
      const player = new PlayerCoordinator(
        lyricsService(
          vi.fn(async (): Promise<LyricsPayload> => ({
            kind: 'missing',
            lines: [],
            provider: null,
          })),
          observePlayback,
        ),
        artworkPaletteService(),
        testStore(),
      );
      const trackA: TrackMetadata = {
        title: 'Track A',
        artist: 'Artist A',
        album: 'Album A',
        durationMs: 180_000,
        source: '',
      };
      const trackB: TrackMetadata = {
        title: 'Track B',
        artist: 'Artist B',
        album: 'Album B',
        durationMs: 200_000,
        source: '',
      };

      ingestBackfillTrack(player, trackA);
      await vi.advanceTimersByTimeAsync(2_000);
      for (const field of APPLE_BACKFILL_TEST_FIELDS) {
        ingestBackfillTrackField(
          player,
          field === changedField ? trackB : trackA,
          field,
        );
      }
      await vi.advanceTimersByTimeAsync(1_100);
      expect(observePlayback).toHaveBeenCalledExactlyOnceWith(trackA);

      ingestBackfillTrack(player, trackB);
      ingestBackfillTrack(player, trackB);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(observePlayback).toHaveBeenCalledTimes(2);
      expect(observePlayback).toHaveBeenLastCalledWith(trackB);
    },
  );

  it('drops a sub-debounce mixed candidate and keeps the following complete track', async () => {
    const observePlayback = vi.fn();
    const player = new PlayerCoordinator(
      lyricsService(
        vi.fn(async (): Promise<LyricsPayload> => ({
          kind: 'missing',
          lines: [],
          provider: null,
        })),
        observePlayback,
      ),
      artworkPaletteService(),
      testStore(),
    );
    const trackA: TrackMetadata = {
      title: 'Track A',
      artist: 'Artist A',
      album: 'Album A',
      durationMs: 180_000,
      source: '',
    };
    const trackB: TrackMetadata = {
      title: 'Track B',
      artist: 'Artist B',
      album: 'Album B',
      durationMs: 200_000,
      source: '',
    };
    const trackC: TrackMetadata = {
      title: 'Track C',
      artist: 'Artist C',
      album: 'Album C',
      durationMs: 220_000,
      source: '',
    };

    ingestBackfillTrack(player, trackA);
    await vi.advanceTimersByTimeAsync(2_000);
    ingestBackfillTrackField(player, trackB, 'title');
    ingestBackfillTrackField(player, trackC, 'artist');
    ingestBackfillTrackField(player, trackC, 'album');
    ingestBackfillTrackField(player, trackC, 'durationMs');
    await vi.advanceTimersByTimeAsync(1_001);
    ingestBackfillTrackField(player, trackC, 'title');
    ingestBackfillTrack(player, trackC);
    // Cross the mixed candidate's old deadline, then stop 1ms before the
    // replacement candidate has completed its own stabilization window.
    await vi.advanceTimersByTimeAsync(999);
    expect(observePlayback).toHaveBeenCalledExactlyOnceWith(trackA);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(observePlayback).toHaveBeenCalledExactlyOnceWith(trackA);
    await vi.advanceTimersByTimeAsync(1);

    expect(observePlayback).toHaveBeenCalledTimes(2);
    expect(observePlayback).toHaveBeenNthCalledWith(1, trackA);
    expect(observePlayback).toHaveBeenNthCalledWith(2, trackC);
  });

  it('does not commit disjoint rapid-track fields before the stabilization window', async () => {
    const observePlayback = vi.fn();
    const player = new PlayerCoordinator(
      lyricsService(
        vi.fn(async (): Promise<LyricsPayload> => ({
          kind: 'missing',
          lines: [],
          provider: null,
        })),
        observePlayback,
      ),
      artworkPaletteService(),
      testStore(),
    );
    const trackA: TrackMetadata = {
      title: 'Track A',
      artist: 'Artist A',
      album: 'Album A',
      durationMs: 180_000,
      source: '',
    };
    const trackB: TrackMetadata = {
      title: 'Track B',
      artist: 'Artist B',
      album: 'Album B',
      durationMs: 200_000,
      source: '',
    };
    const trackC: TrackMetadata = {
      title: 'Track C',
      artist: 'Artist C',
      album: 'Album C',
      durationMs: 220_000,
      source: '',
    };

    ingestBackfillTrack(player, trackA);
    await vi.advanceTimersByTimeAsync(2_000);
    ingestBackfillTrackField(player, trackB, 'title');
    ingestBackfillTrackField(player, trackB, 'artist');
    await vi.advanceTimersByTimeAsync(100);
    ingestBackfillTrackField(player, trackC, 'album');
    ingestBackfillTrackField(player, trackC, 'durationMs');
    await vi.advanceTimersByTimeAsync(1_999);

    expect(observePlayback).toHaveBeenCalledExactlyOnceWith(trackA);

    ingestBackfillTrack(player, trackC);
    await vi.advanceTimersByTimeAsync(1);
    expect(observePlayback).toHaveBeenCalledExactlyOnceWith(trackA);
    await vi.advanceTimersByTimeAsync(1_998);
    expect(observePlayback).toHaveBeenCalledExactlyOnceWith(trackA);
    await vi.advanceTimersByTimeAsync(1);
    expect(observePlayback).toHaveBeenCalledTimes(2);
    expect(observePlayback).toHaveBeenLastCalledWith(trackC);
  });

  it('resets the whole epoch when an incomplete rapid track changes identity', async () => {
    const observePlayback = vi.fn();
    const player = new PlayerCoordinator(
      lyricsService(
        vi.fn(async (): Promise<LyricsPayload> => ({
          kind: 'missing',
          lines: [],
          provider: null,
        })),
        observePlayback,
      ),
      artworkPaletteService(),
      testStore(),
    );
    const trackA: TrackMetadata = {
      title: 'Track A',
      artist: 'Artist A',
      album: 'Album A',
      durationMs: 180_000,
      source: '',
    };
    const trackB: TrackMetadata = {
      title: 'Track B',
      artist: 'Artist B',
      album: 'Album B',
      durationMs: 200_000,
      source: '',
    };
    const trackC: TrackMetadata = {
      title: 'Track C',
      artist: 'Artist C',
      album: 'Album C',
      durationMs: 220_000,
      source: '',
    };

    ingestBackfillTrack(player, trackA);
    await vi.advanceTimersByTimeAsync(2_000);
    ingestBackfillTrackField(player, trackB, 'title');
    ingestBackfillTrackField(player, trackB, 'artist');
    await vi.advanceTimersByTimeAsync(100);
    ingestBackfillTrackField(player, trackC, 'title');
    ingestBackfillTrackField(player, trackC, 'album');
    ingestBackfillTrackField(player, trackC, 'durationMs');
    await vi.advanceTimersByTimeAsync(1_100);
    expect(observePlayback).toHaveBeenCalledExactlyOnceWith(trackA);

    ingestBackfillTrackField(player, trackC, 'artist');
    await vi.advanceTimersByTimeAsync(1_999);
    expect(observePlayback).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(observePlayback).toHaveBeenCalledTimes(2);
    expect(observePlayback).toHaveBeenLastCalledWith(trackC);
  });

  it('skips an unconfirmed 500ms track before the following metadata burst', async () => {
    const observePlayback = vi.fn();
    const player = new PlayerCoordinator(
      lyricsService(
        vi.fn(async (): Promise<LyricsPayload> => ({
          kind: 'missing',
          lines: [],
          provider: null,
        })),
        observePlayback,
      ),
      artworkPaletteService(),
      testStore(),
    );
    const trackA: TrackMetadata = {
      title: 'Track A',
      artist: 'Artist A',
      album: 'Album A',
      durationMs: 180_000,
      source: '',
    };
    const trackB: TrackMetadata = {
      title: 'Track B',
      artist: 'Artist B',
      album: 'Album B',
      durationMs: 200_000,
      source: '',
    };
    const trackC: TrackMetadata = {
      title: 'Track C',
      artist: 'Artist C',
      album: 'Album C',
      durationMs: 220_000,
      source: '',
    };

    ingestBackfillTrack(player, trackA);
    await vi.advanceTimersByTimeAsync(2_000);
    ingestBackfillTrack(player, trackB);
    await vi.advanceTimersByTimeAsync(500);
    ingestBackfillTrack(
      player,
      trackC,
      ['artist', 'album', 'durationMs', 'title'],
    );
    await vi.advanceTimersByTimeAsync(2_000);

    expect(observePlayback).toHaveBeenCalledTimes(2);
    expect(observePlayback).toHaveBeenNthCalledWith(1, trackA);
    expect(observePlayback).toHaveBeenNthCalledWith(2, trackC);
  });

  it('does not let an elapsed reset promote inherited shared fields', async () => {
    const observePlayback = vi.fn();
    const player = new PlayerCoordinator(
      lyricsService(
        vi.fn(async (): Promise<LyricsPayload> => ({
          kind: 'missing',
          lines: [],
          provider: null,
        })),
        observePlayback,
      ),
      artworkPaletteService(),
      testStore(),
    );
    const trackA: TrackMetadata = {
      title: 'Track A',
      artist: 'Shared Artist',
      album: 'Shared Album',
      durationMs: 180_000,
      source: '',
    };
    const trackB: TrackMetadata = {
      title: 'Track B',
      artist: 'Shared Artist',
      album: 'Shared Album',
      durationMs: 200_000,
      source: '',
    };
    const trackC: TrackMetadata = {
      title: 'Track C',
      artist: 'Artist C',
      album: 'Album C',
      durationMs: 220_000,
      source: '',
    };

    ingestBackfillTrack(player, trackA);
    player.ingest(VIN, 'MediaNowPlayingElapsed', 60_000);
    await vi.advanceTimersByTimeAsync(2_000);
    ingestBackfillTrack(player, trackB);
    player.ingest(VIN, 'MediaNowPlayingElapsed', 0);
    await vi.advanceTimersByTimeAsync(500);
    ingestBackfillTrack(player, trackC);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(observePlayback).toHaveBeenCalledTimes(2);
    expect(observePlayback).toHaveBeenNthCalledWith(1, trackA);
    expect(observePlayback).toHaveBeenNthCalledWith(2, trackC);
  });

  it('expires an incomplete cold-start epoch before combining later fields', async () => {
    const observePlayback = vi.fn();
    const player = new PlayerCoordinator(
      lyricsService(
        vi.fn(async (): Promise<LyricsPayload> => ({
          kind: 'missing',
          lines: [],
          provider: null,
        })),
        observePlayback,
      ),
      artworkPaletteService(),
      testStore(),
    );
    const trackB: TrackMetadata = {
      title: 'Track B',
      artist: 'Artist B',
      album: 'Album B',
      durationMs: 200_000,
      source: '',
    };

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track A');
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Artist A');
    await vi.advanceTimersByTimeAsync(5_001);
    ingestBackfillTrackField(player, trackB, 'album');
    ingestBackfillTrackField(player, trackB, 'durationMs');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(observePlayback).not.toHaveBeenCalled();

    ingestBackfillTrackField(player, trackB, 'title');
    ingestBackfillTrackField(player, trackB, 'artist');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(observePlayback).toHaveBeenCalledExactlyOnceWith(trackB);
  });

  it('does not extend the hard epoch limit with slow metadata progress', async () => {
    const observePlayback = vi.fn();
    const player = new PlayerCoordinator(
      lyricsService(
        vi.fn(async (): Promise<LyricsPayload> => ({
          kind: 'missing',
          lines: [],
          provider: null,
        })),
        observePlayback,
      ),
      artworkPaletteService(),
      testStore(),
    );
    const track: TrackMetadata = {
      title: 'Track A',
      artist: 'Artist A',
      album: 'Album A',
      durationMs: 180_000,
      source: '',
    };

    ingestBackfillTrackField(player, track, 'title');
    await vi.advanceTimersByTimeAsync(1_500);
    ingestBackfillTrackField(player, track, 'artist');
    await vi.advanceTimersByTimeAsync(1_500);
    ingestBackfillTrackField(player, track, 'album');
    await vi.advanceTimersByTimeAsync(1_500);
    ingestBackfillTrackField(player, track, 'durationMs');
    await vi.advanceTimersByTimeAsync(2_000);

    expect(observePlayback).not.toHaveBeenCalled();
  });

  it.each(APPLE_BACKFILL_TEST_FIELDS)(
    'does not extend the hard epoch limit with duplicate cold-start %s fields',
    async (duplicatedField) => {
      const observePlayback = vi.fn();
      const player = new PlayerCoordinator(
        lyricsService(
          vi.fn(async (): Promise<LyricsPayload> => ({
            kind: 'missing',
            lines: [],
            provider: null,
          })),
          observePlayback,
        ),
        artworkPaletteService(),
        testStore(),
      );
      const trackA: TrackMetadata = {
        title: 'Stale Track A',
        artist: 'Stale Artist A',
        album: 'Stale Album A',
        durationMs: 180_000,
        source: '',
      };
      const trackB: TrackMetadata = {
        title: 'Track B',
        artist: 'Artist B',
        album: 'Album B',
        durationMs: 200_000,
        source: '',
      };

      ingestBackfillTrackField(player, trackA, duplicatedField);
      await vi.advanceTimersByTimeAsync(1_500);
      ingestBackfillTrackField(player, trackA, duplicatedField);
      await vi.advanceTimersByTimeAsync(1_500);
      ingestBackfillTrackField(player, trackA, duplicatedField);
      await vi.advanceTimersByTimeAsync(1);
      ingestBackfillTrackField(player, trackA, duplicatedField);
      ingestBackfillTrack(
        player,
        trackB,
        APPLE_BACKFILL_TEST_FIELDS.filter((field) => field !== duplicatedField),
      );

      // The mixed candidate would commit 1ms after the original hard deadline.
      // Same-value duplicates must not move that deadline.
      await vi.advanceTimersByTimeAsync(1_999);
      expect(observePlayback).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(observePlayback).not.toHaveBeenCalled();
    },
  );

  it('does not duplicate observations across repeated full resends', async () => {
    const observePlayback = vi.fn();
    const player = new PlayerCoordinator(
      lyricsService(
        vi.fn(async (): Promise<LyricsPayload> => ({
          kind: 'missing',
          lines: [],
          provider: null,
        })),
        observePlayback,
      ),
      artworkPaletteService(),
      testStore(),
    );
    const track: TrackMetadata = {
      title: 'Track A',
      artist: 'Artist A',
      album: 'Album A',
      durationMs: 180_000,
      source: '',
    };

    ingestBackfillTrack(player, track);
    await vi.advanceTimersByTimeAsync(2_000);
    for (let resend = 0; resend < 3; resend += 1) {
      await vi.advanceTimersByTimeAsync(30_000);
      ingestBackfillTrack(
        player,
        track,
        [...APPLE_BACKFILL_TEST_FIELDS].reverse(),
      );
    }
    await vi.advanceTimersByTimeAsync(2_000);

    expect(observePlayback).toHaveBeenCalledExactlyOnceWith(track);
  });

  it.each([
    ['missing artist', { ...COMPLETE_TRACK, artist: '' }],
    ['missing album', { ...COMPLETE_TRACK, album: '' }],
    ['zero duration', { ...COMPLETE_TRACK, durationMs: 0 }],
    ['radio duration', { ...COMPLETE_TRACK, durationMs: 18_000_000 }],
  ] satisfies Array<[string, TrackMetadata]>)(
    'does not observe playback with %s',
    async (_label, track) => {
      const observePlayback = vi.fn();
      const player = new PlayerCoordinator(
        lyricsService(
          vi.fn(async (): Promise<LyricsPayload> => ({
            kind: 'missing',
            lines: [],
            provider: null,
          })),
          observePlayback,
        ),
        artworkPaletteService(),
        testStore(),
      );

      player.ingest(VIN, 'MediaNowPlayingTitle', track.title);
      player.ingest(VIN, 'MediaNowPlayingArtist', track.artist);
      player.ingest(VIN, 'MediaNowPlayingAlbum', track.album);
      player.ingest(VIN, 'MediaNowPlayingDuration', track.durationMs);
      await vi.advanceTimersByTimeAsync(2_000);

      expect(observePlayback).not.toHaveBeenCalled();
    },
  );

  it('retries a temporary failure after five seconds and stops after success', async () => {
    const find = vi.fn()
      .mockResolvedValueOnce({
        kind: 'missing',
        lines: [],
        provider: null,
        retryable: true,
      } satisfies LyricsPayload)
      .mockResolvedValueOnce({
        kind: 'synced',
        lines: [{ id: '0', startMs: 0, text: 'Recovered' }],
        provider: 'lrclib',
      } satisfies LyricsPayload);
    const player = new PlayerCoordinator(lyricsService(find), artworkPaletteService(), testStore());

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Midnight Circuit');
    await vi.advanceTimersByTimeAsync(200);
    expect(find).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(find).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(find).toHaveBeenCalledTimes(2);
    expect(find.mock.calls[1]?.[1]).toEqual({ bypassLocalCache: true });
    expect(player.snapshot().lyrics.kind).toBe('synced');

    await vi.advanceTimersByTimeAsync(180_000);
    expect(find).toHaveBeenCalledTimes(2);
  });

  it('updates the cache without replacing stale usable lyrics during playback', async () => {
    const find = vi.fn()
      .mockResolvedValueOnce({
        kind: 'synced',
        lines: [{ id: 'lrclib', startMs: 1_000, text: 'LRCLIB timeline' }],
        provider: 'lrclib',
        providerId: 41,
        retryable: true,
        notice: '正在显示本地缓存，稍后会在后台更新。',
      } satisfies LyricsPayload)
      .mockResolvedValueOnce({
        kind: 'synced',
        lines: [{ id: 'apple', startMs: 1_200, text: 'Apple timeline' }],
        provider: 'apple',
        providerId: 99,
      } satisfies LyricsPayload);
    const player = new PlayerCoordinator(lyricsService(find), artworkPaletteService(), testStore());

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Midnight Circuit');
    await vi.advanceTimersByTimeAsync(200);
    expect(player.snapshot().lyrics.lines[0]?.text).toBe('LRCLIB timeline');

    await vi.advanceTimersByTimeAsync(5_000);

    expect(find).toHaveBeenCalledTimes(2);
    expect(find.mock.calls[1]?.[1]).toEqual({ bypassLocalCache: true });
    expect(player.snapshot().lyrics).toEqual(expect.objectContaining({
      kind: 'synced',
      provider: 'lrclib',
      providerId: 41,
    }));
    expect(player.snapshot().lyrics.lines[0]?.text).toBe('LRCLIB timeline');
    expect(player.snapshot().lyrics.retryable).not.toBe(true);
    expect(player.snapshot().lyrics.notice).toBeUndefined();
  });

  it('keeps static work-cache lyrics visible while retrying in the background', async () => {
    const find = vi.fn()
      .mockResolvedValueOnce({
        kind: 'plain',
        lines: [{ id: 'plain-0', startMs: 0, text: 'Cached original lyrics' }],
        plainText: 'Cached original lyrics',
        provider: 'lrclib',
        retryable: true,
        fallbackKind: 'work-cache',
      } satisfies LyricsPayload)
      .mockResolvedValueOnce({
        kind: 'synced',
        lines: [{ id: '0', startMs: 0, text: 'Recovered Live lyrics' }],
        provider: 'lrclib',
      } satisfies LyricsPayload);
    const player = new PlayerCoordinator(lyricsService(find), artworkPaletteService(), testStore());

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Midnight Circuit (Live)');
    await vi.advanceTimersByTimeAsync(200);
    expect(player.snapshot().lyrics).toEqual(expect.objectContaining({
      kind: 'plain',
      plainText: 'Cached original lyrics',
    }));

    await vi.advanceTimersByTimeAsync(5_000);

    expect(find).toHaveBeenCalledTimes(2);
    expect(find.mock.calls[1]?.[1]).toEqual({ bypassLocalCache: true });
    expect(player.snapshot().lyrics).toEqual(expect.objectContaining({
      kind: 'plain',
      plainText: 'Cached original lyrics',
      fallbackKind: 'work-cache',
    }));
    expect(player.snapshot().lyrics.retryable).not.toBe(true);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(find).toHaveBeenCalledTimes(2);
  });

  it('keeps usable lyrics visible when a background source retry is still unavailable', async () => {
    const fallback = {
      kind: 'plain',
      lines: [{ id: 'plain-0', startMs: 0, text: 'Cached original lyrics' }],
      plainText: 'Cached original lyrics',
      provider: 'lrclib',
      retryable: true,
      fallbackKind: 'work-cache',
    } satisfies LyricsPayload;
    const find = vi.fn()
      .mockResolvedValueOnce(fallback)
      .mockResolvedValueOnce({
        kind: 'missing',
        lines: [],
        provider: null,
        retryable: true,
        notice: '歌词来源仍然暂时不可用。',
      } satisfies LyricsPayload);
    const player = new PlayerCoordinator(lyricsService(find), artworkPaletteService(), testStore());

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Midnight Circuit (Live)');
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(find).toHaveBeenCalledTimes(2);
    expect(find.mock.calls[1]?.[1]).toEqual({ bypassLocalCache: true });
    expect(player.snapshot().lyrics).toEqual(expect.objectContaining({
      kind: 'plain',
      plainText: 'Cached original lyrics',
      retryable: true,
      notice: '歌词来源仍然暂时不可用。',
    }));
  });

  it('keeps usable lyrics visible when a background source retry rejects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fallback = {
      kind: 'plain',
      lines: [{ id: 'plain-0', startMs: 0, text: 'Cached original lyrics' }],
      plainText: 'Cached original lyrics',
      provider: 'lrclib',
      retryable: true,
      fallbackKind: 'work-cache',
    } satisfies LyricsPayload;
    const find = vi.fn()
      .mockResolvedValueOnce(fallback)
      .mockRejectedValueOnce(new Error('temporary source failure'));
    const player = new PlayerCoordinator(lyricsService(find), artworkPaletteService(), testStore());

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Midnight Circuit (Acoustic)');
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(find).toHaveBeenCalledTimes(2);
    expect(find.mock.calls[1]?.[1]).toEqual({ bypassLocalCache: true });
    expect(player.snapshot().lyrics).toEqual(expect.objectContaining({
      kind: 'plain',
      plainText: 'Cached original lyrics',
      retryable: true,
      notice: '歌词查询没有完成，请稍后切歌或刷新重试。',
    }));
  });

  it('does not retry a definitive miss', async () => {
    const find = vi.fn(async (): Promise<LyricsPayload> => ({
      kind: 'missing',
      lines: [],
      provider: null,
    }));
    const player = new PlayerCoordinator(lyricsService(find), artworkPaletteService(), testStore());

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Midnight Circuit');
    await vi.advanceTimersByTimeAsync(180_000);

    expect(find).toHaveBeenCalledTimes(1);
  });

  it('rechecks a miss when album metadata arrives later', async () => {
    let finishFirst: ((lyrics: LyricsPayload) => void) | undefined;
    const first = new Promise<LyricsPayload>((resolve) => { finishFirst = resolve; });
    const find = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({
        kind: 'synced',
        lines: [{ id: '0', startMs: 0, text: 'Found with album' }],
        provider: 'lrclib',
      } satisfies LyricsPayload);
    const player = new PlayerCoordinator(lyricsService(find), artworkPaletteService(), testStore());

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Midnight Circuit');
    await vi.advanceTimersByTimeAsync(200);
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'After Dark');
    finishFirst?.({ kind: 'missing', lines: [], provider: null });
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(1_249);
    expect(find).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(find).toHaveBeenCalledTimes(2);
    expect(find.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ album: 'After Dark' }));
    expect(find.mock.calls[1]?.[1]).toEqual({ bypassLocalCache: true });
    expect(player.snapshot().lyrics.kind).toBe('synced');
  });

  it('keeps displayed lyrics pinned when album metadata arrives after incomplete settle', async () => {
    const find = vi.fn()
      .mockResolvedValueOnce({
        kind: 'synced',
        lines: [{ id: 'incomplete', startMs: 0, text: 'Incomplete album timeline' }],
        provider: 'lrclib',
      } satisfies LyricsPayload)
      .mockResolvedValueOnce({
        kind: 'synced',
        lines: [{ id: 'correct', startMs: 0, text: 'Correct album timeline' }],
        provider: 'apple',
      } satisfies LyricsPayload);
    const player = new PlayerCoordinator(lyricsService(find), artworkPaletteService(), testStore());

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Midnight Circuit');
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Local Drive');
    player.ingest(VIN, 'MediaNowPlayingDuration', 214_000);
    await vi.advanceTimersByTimeAsync(899);
    expect(find).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(find).toHaveBeenCalledTimes(1);
    expect(player.snapshot().lyrics.lines[0]?.text).toBe('Incomplete album timeline');

    player.ingest(VIN, 'MediaNowPlayingAlbum', 'After Dark');
    expect(player.snapshot().lyrics.lines[0]?.text).toBe('Incomplete album timeline');
    await vi.advanceTimersByTimeAsync(1_250);
    expect(find).toHaveBeenCalledTimes(2);
    expect(find.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ album: 'After Dark' }));
    expect(find.mock.calls[1]?.[1]).toEqual({ bypassLocalCache: true });
    expect(player.snapshot().lyrics.lines[0]?.text).toBe('Incomplete album timeline');
  });

  it('refreshes a non-empty album correction without replacing displayed lyrics', async () => {
    const find = vi.fn()
      .mockResolvedValueOnce({
        kind: 'synced',
        lines: [{ id: 'first', startMs: 0, text: 'First album timeline' }],
        provider: 'apple',
      } satisfies LyricsPayload)
      .mockResolvedValueOnce({
        kind: 'synced',
        lines: [{ id: 'corrected', startMs: 0, text: 'Corrected album timeline' }],
        provider: 'apple',
      } satisfies LyricsPayload);
    const player = new PlayerCoordinator(lyricsService(find), artworkPaletteService(), testStore());

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Midnight Circuit');
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Local Drive');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'Wrong Album');
    player.ingest(VIN, 'MediaNowPlayingDuration', 214_000);
    await vi.advanceTimersByTimeAsync(200);
    expect(player.snapshot().lyrics.lines[0]?.text).toBe('First album timeline');

    player.ingest(VIN, 'MediaNowPlayingAlbum', 'After Dark');
    expect(player.snapshot().lyrics.kind).toBe('synced');
    await vi.advanceTimersByTimeAsync(1_250);

    expect(find).toHaveBeenCalledTimes(2);
    expect(find.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ album: 'After Dark' }));
    expect(find.mock.calls[1]?.[1]).toEqual({ bypassLocalCache: true });
    expect(player.snapshot().lyrics.lines[0]?.text).toBe('First album timeline');
  });

  it('does not force-refresh a miss for an unchanged repeated album', async () => {
    const find = vi.fn(async (
      _track: TrackMetadata,
      _options?: { bypassLocalCache?: boolean },
    ): Promise<LyricsPayload> => ({
      kind: 'missing',
      lines: [],
      provider: null,
    }));
    const player = new PlayerCoordinator(lyricsService(find), artworkPaletteService(), testStore());

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Midnight Circuit');
    await vi.advanceTimersByTimeAsync(200);
    expect(find).toHaveBeenCalledTimes(1);

    player.ingest(VIN, 'MediaNowPlayingAlbum', 'After Dark');
    await vi.advanceTimersByTimeAsync(1_250);
    expect(find).toHaveBeenCalledTimes(2);
    expect(find.mock.calls[1]?.[1]).toEqual({ bypassLocalCache: true });

    player.ingest(VIN, 'MediaNowPlayingAlbum', '  after   dark  ');
    await vi.advanceTimersByTimeAsync(1_250);
    expect(find).toHaveBeenCalledTimes(2);

    player.ingest(VIN, 'MediaNowPlayingAlbum', 'Corrected Album');
    await vi.advanceTimersByTimeAsync(1_250);
    expect(find).toHaveBeenCalledTimes(3);
    expect(find.mock.calls[2]?.[0]).toEqual(expect.objectContaining({ album: 'Corrected Album' }));
    expect(find.mock.calls[2]?.[1]).toEqual({ bypassLocalCache: true });
  });

  it('does not build an unobserved snapshot on the telemetry player hot path', async () => {
    const store = testStore();
    const player = new PlayerCoordinator(lyricsService(async () => ({
      kind: 'missing',
      lines: [],
      provider: null,
    })), artworkPaletteService(), store);

    player.selectedVin();
    player.ingest(VIN, 'MediaNowPlayingElapsed', 1_000);
    player.ingest(VIN, 'MediaPlaybackStatus', 'PLAYING');
    await vi.advanceTimersByTimeAsync(0);
    player.snapshot();

    expect(store.snapshot).not.toHaveBeenCalled();
    expect(store.readSelectedVin).toHaveBeenCalledTimes(3);
    expect(store.readSelectedVehicleName).toHaveBeenCalledTimes(1);
  });

  it('treats original and Acoustic recordings as separate playback identities', async () => {
    const find = vi.fn(async (track: TrackMetadata): Promise<LyricsPayload> => ({
      kind: 'synced',
      lines: [{ id: '0', startMs: 0, text: track.title }],
      provider: 'lrclib',
    }));
    const player = new PlayerCoordinator(lyricsService(find), artworkPaletteService(), testStore());

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Midnight Circuit');
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Local Drive');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'After Dark');
    player.ingest(VIN, 'MediaNowPlayingDuration', 214_000);
    await vi.advanceTimersByTimeAsync(200);

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Midnight Circuit (Acoustic)');
    await vi.advanceTimersByTimeAsync(1_250);

    expect(find).toHaveBeenCalledTimes(2);
    expect(find.mock.calls[1]?.[0].title).toBe('Midnight Circuit (Acoustic)');
  });

  it('exits loading state when lyric persistence or lookup rejects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const player = new PlayerCoordinator(
      lyricsService(async () => Promise.reject(new Error('lookup failed'))),
      artworkPaletteService(),
      testStore(),
    );

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Midnight Circuit');
    await vi.advanceTimersByTimeAsync(700);

    expect(player.snapshot().lyrics.kind).toBe('missing');
    expect(player.snapshot().lyrics.notice).toContain('没有完成');
  });

  it('lists candidates for the current complete metadata snapshot', async () => {
    const service = lyricsService(async () => ({ kind: 'missing', lines: [], provider: null }));
    const listCandidates = vi.fn(async () => ({ candidates: [] }));
    service.listCandidates = listCandidates;
    const player = new PlayerCoordinator(service, artworkPaletteService(), testStore());

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Midnight Circuit');
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Local Drive');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'After Dark');
    player.ingest(VIN, 'MediaNowPlayingDuration', 214_000);

    await expect(player.listLyricsCandidates()).resolves.toEqual({ candidates: [] });
    expect(listCandidates).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Midnight Circuit',
      artist: 'Local Drive',
      album: 'After Dark',
      durationMs: 214_000,
    }));
  });

  it('keeps a selected candidate visible when an older lookup finishes later', async () => {
    let finishLookup: ((lyrics: LyricsPayload) => void) | undefined;
    const pendingLookup = new Promise<LyricsPayload>((resolve) => { finishLookup = resolve; });
    const service = lyricsService(vi.fn(() => pendingLookup));
    const selected: LyricsPayload = {
      kind: 'plain',
      lines: [{ id: 'plain-0', startMs: 0, text: 'Selected lyrics' }],
      plainText: 'Selected lyrics',
      provider: 'lrclib',
      providerId: 42,
    };
    const selectCandidate = vi.fn(async () => selected);
    service.selectCandidate = selectCandidate;
    const player = new PlayerCoordinator(service, artworkPaletteService(), testStore());

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Midnight Circuit');
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Local Drive');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'After Dark');
    player.ingest(VIN, 'MediaNowPlayingDuration', 214_000);
    await vi.advanceTimersByTimeAsync(200);

    await player.selectLyricsCandidate('opaque-token', 'plain');
    expect(player.snapshot().lyrics).toEqual(selected);
    expect(selectCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Midnight Circuit', artist: 'Local Drive' }),
      'opaque-token',
      'plain',
    );

    finishLookup?.({
      kind: 'synced',
      lines: [{ id: '0', startMs: 0, text: 'Late automatic result' }],
      provider: 'lrclib',
      providerId: 99,
    });
    await Promise.resolve();
    expect(player.snapshot().lyrics).toEqual(selected);
  });

  it('waits briefly for a late album before the first lyrics lookup', async () => {
    const lyricFind = vi.fn(async (): Promise<LyricsPayload> => ({
      kind: 'synced',
      lines: [{ id: '0', startMs: 0, text: 'Line one' }],
      provider: 'lrclib',
    }));
    const paletteFind = vi.fn(async (): Promise<ArtworkPalette> => ({
      primary: '#224466',
      secondary: '#884422',
      source: 'apple',
    }));
    const observePlayback = vi.fn();
    const player = new PlayerCoordinator(
      lyricsService(lyricFind, observePlayback),
      artworkPaletteService(paletteFind),
      testStore(),
    );

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Midnight Circuit');
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Local Drive');
    player.ingest(VIN, 'MediaNowPlayingDuration', 214_000);
    await vi.advanceTimersByTimeAsync(700);
    expect(lyricFind).not.toHaveBeenCalled();
    expect(player.snapshot().lyrics.kind).toBe('missing');
    expect(observePlayback).not.toHaveBeenCalled();
    expect(paletteFind).not.toHaveBeenCalled();

    player.ingest(VIN, 'MediaNowPlayingAlbum', 'After Dark');
    await vi.advanceTimersByTimeAsync(199);
    expect(lyricFind).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(501);

    expect(lyricFind).toHaveBeenCalledTimes(1);
    expect(lyricFind).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Midnight Circuit',
        artist: 'Local Drive',
        album: 'After Dark',
        durationMs: 214_000,
      }),
    );
    expect(paletteFind).toHaveBeenCalledTimes(1);
    expect(paletteFind).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Midnight Circuit',
      artist: 'Local Drive',
      album: 'After Dark',
      durationMs: 214_000,
    }));
    expect(player.snapshot().lyrics.kind).toBe('synced');
    expect(player.snapshot().artworkPalette?.source).toBe('apple');
    expect(observePlayback).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_300);
    expect(observePlayback).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      title: 'Midnight Circuit',
      artist: 'Local Drive',
      album: 'After Dark',
      durationMs: 214_000,
    }));
  });

  it('publishes the current artwork fallback reason without mixing it into the palette', async () => {
    const resolve = vi.fn(async () => ({
      palette: {
        primary: '#3B3E45',
        secondary: '#191C22',
        source: 'fallback' as const,
      },
      status: {
        state: 'fallback' as const,
        reason: 'catalog-timeout' as const,
        retryable: true,
        cache: 'miss' as const,
        stage: 'primary-core' as const,
      },
    }));
    const paletteService = {
      resolve,
      find: vi.fn(),
    } as unknown as ArtworkPaletteService;
    const player = new PlayerCoordinator(
      lyricsService(async () => ({ kind: 'missing', lines: [], provider: null })),
      paletteService,
      testStore(),
    );

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Midnight Circuit');
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Local Drive');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'After Dark');
    player.ingest(VIN, 'MediaNowPlayingDuration', 214_000);
    expect(player.snapshot().artworkLookup).toEqual({ state: 'loading' });

    await vi.advanceTimersByTimeAsync(700);

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(player.snapshot().artworkPalette).not.toHaveProperty('reason');
    expect(player.snapshot().artworkLookup).toEqual({
      state: 'fallback',
      reason: 'catalog-timeout',
      retryable: true,
      cache: 'miss',
      stage: 'primary-core',
    });
  });

  it('publishes an exact cached palette after a short stable window', async () => {
    const cachedPalette: ArtworkPalette = {
      primary: '#224466',
      secondary: '#884422',
      source: 'apple',
    };
    const resolveCached = vi.fn(async () => ({
      palette: cachedPalette,
      status: { state: 'success' as const, source: 'supabase-cache' as const },
    }));
    const resolve = vi.fn(async () => {
      throw new Error('The slow artwork lookup must not start for an exact cache hit');
    });
    const player = new PlayerCoordinator(
      lyricsService(async () => ({ kind: 'missing', lines: [], provider: null })),
      { resolveCached, resolve, find: vi.fn() } as unknown as ArtworkPaletteService,
      testStore(),
    );

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Midnight Circuit');
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Local Drive');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'After Dark');
    player.ingest(VIN, 'MediaNowPlayingDuration', 214_000);

    expect(resolveCached).toHaveBeenCalledTimes(1);
    expect(player.snapshot().artworkPalette?.source).toBe('fallback');
    await vi.advanceTimersByTimeAsync(349);
    expect(player.snapshot().artworkPalette?.source).toBe('fallback');
    await vi.advanceTimersByTimeAsync(1);

    expect(player.snapshot().artworkPalette).toEqual(cachedPalette);
    expect(player.snapshot().artworkLookup).toEqual({
      state: 'success',
      source: 'supabase-cache',
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('keeps the existing Apple lookup debounce after an exact cache miss', async () => {
    const resolvedPalette: ArtworkPalette = {
      primary: '#224466',
      secondary: '#884422',
      source: 'apple',
    };
    const resolveCached = vi.fn(async () => null);
    const resolve = vi.fn(async () => ({
      palette: resolvedPalette,
      status: { state: 'success' as const, source: 'catalog' as const },
    }));
    const player = new PlayerCoordinator(
      lyricsService(async () => ({ kind: 'missing', lines: [], provider: null })),
      { resolveCached, resolve, find: vi.fn() } as unknown as ArtworkPaletteService,
      testStore(),
    );

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Midnight Circuit');
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Local Drive');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'After Dark');
    player.ingest(VIN, 'MediaNowPlayingDuration', 214_000);

    await vi.advanceTimersByTimeAsync(649);
    expect(resolveCached).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(player.snapshot().artworkPalette).toEqual(resolvedPalette);
  });

  it('discards a superseded exact cache result during rapid track changes', async () => {
    const firstPalette: ArtworkPalette = {
      primary: '#AA2200',
      secondary: '#DD8800',
      source: 'apple',
    };
    const secondPalette: ArtworkPalette = {
      primary: '#224466',
      secondary: '#884422',
      source: 'apple',
    };
    let releaseFirst!: (result: {
      palette: ArtworkPalette;
      status: { state: 'success'; source: 'supabase-cache' };
    }) => void;
    const firstResult = new Promise<{
      palette: ArtworkPalette;
      status: { state: 'success'; source: 'supabase-cache' };
    }>((resolve) => {
      releaseFirst = resolve;
    });
    const resolveCached = vi.fn((track: TrackMetadata) => track.title === 'Track A'
      ? firstResult
      : Promise.resolve({
        palette: secondPalette,
        status: { state: 'success' as const, source: 'supabase-cache' as const },
      }));
    const resolve = vi.fn(async () => {
      throw new Error('The slow artwork lookup must not start for an exact cache hit');
    });
    const player = new PlayerCoordinator(
      lyricsService(async () => ({ kind: 'missing', lines: [], provider: null })),
      { resolveCached, resolve, find: vi.fn() } as unknown as ArtworkPaletteService,
      testStore(),
    );

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track A');
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Artist A');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'Album A');
    player.ingest(VIN, 'MediaNowPlayingDuration', 180_000);
    await vi.advanceTimersByTimeAsync(100);

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track B');
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Artist B');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'Album B');
    player.ingest(VIN, 'MediaNowPlayingDuration', 200_000);
    await vi.advanceTimersByTimeAsync(350);

    expect(player.snapshot().artworkPalette).toEqual(secondPalette);
    releaseFirst({
      palette: firstPalette,
      status: { state: 'success', source: 'supabase-cache' },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(player.snapshot().artworkPalette).toEqual(secondPalette);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('retries a retryable artwork fallback and stops after a successful retry', async () => {
    const resolve = vi.fn()
      .mockResolvedValueOnce({
        palette: { primary: '#3B3E45', secondary: '#191C22', source: 'fallback' },
        status: {
          state: 'fallback',
          reason: 'catalog-timeout',
          retryable: true,
          cache: 'miss',
          stage: 'primary-full',
        },
      })
      .mockResolvedValue({
        palette: { primary: '#224466', secondary: '#884422', source: 'apple' },
        status: { state: 'success', source: 'catalog', stage: 'primary-core' },
      });
    const player = new PlayerCoordinator(
      lyricsService(async () => ({ kind: 'missing', lines: [], provider: null })),
      { resolve, find: vi.fn() } as unknown as ArtworkPaletteService,
      testStore(),
    );

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Midnight Circuit');
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Local Drive');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'After Dark');
    player.ingest(VIN, 'MediaNowPlayingDuration', 214_000);
    await vi.advanceTimersByTimeAsync(700);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(player.snapshot().artworkLookup).toMatchObject({ reason: 'catalog-timeout' });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(player.snapshot().artworkLookup).toEqual({
      state: 'success',
      source: 'catalog',
      stage: 'primary-core',
    });

    await vi.advanceTimersByTimeAsync(120_000);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('records fallback resolution once and defers delivery until a retry succeeds', async () => {
    const resolve = vi.fn()
      .mockResolvedValueOnce({
        palette: { primary: '#3B3E45', secondary: '#191C22', source: 'fallback' },
        status: {
          state: 'fallback',
          reason: 'catalog-timeout',
          retryable: true,
          cache: 'miss',
          stage: 'primary-full',
        },
      })
      .mockResolvedValueOnce({
        palette: { primary: '#224466', secondary: '#884422', source: 'apple' },
        status: { state: 'success', source: 'catalog', stage: 'primary-core' },
      });
    const recordResolutionDuration = vi.fn();
    const recordDeliveryDuration = vi.fn();
    const player = new PlayerCoordinator(
      lyricsService(async () => ({ kind: 'missing', lines: [], provider: null })),
      {
        resolve,
        find: vi.fn(),
        recordResolutionDuration,
        recordDeliveryDuration,
      } as unknown as ArtworkPaletteService,
      testStore(),
    );

    // Keep the delivery epoch strictly positive; the coordinator uses zero as
    // its inactive sentinel and fake timers otherwise begin at performance 0.
    await vi.advanceTimersByTimeAsync(1);
    player.ingest(VIN, 'MediaNowPlayingTitle', 'Midnight Circuit');
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Local Drive');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'After Dark');
    player.ingest(VIN, 'MediaNowPlayingDuration', 214_000);
    await vi.advanceTimersByTimeAsync(700);

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(recordResolutionDuration).toHaveBeenCalledTimes(1);
    expect(recordDeliveryDuration).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(resolve).toHaveBeenCalledTimes(2);
    expect(recordResolutionDuration).toHaveBeenCalledTimes(1);
    expect(recordDeliveryDuration).toHaveBeenCalledTimes(1);
  });

  it('keeps the previous palette through a local rate limit until the retry succeeds', async () => {
    const firstPalette: ArtworkPalette = {
      primary: '#AA2200',
      secondary: '#DD8800',
      source: 'apple',
    };
    const secondPalette: ArtworkPalette = {
      primary: '#224466',
      secondary: '#884422',
      source: 'apple',
    };
    const resolve = vi.fn()
      .mockResolvedValueOnce({
        palette: firstPalette,
        status: { state: 'success', source: 'catalog', stage: 'primary-core' },
      })
      .mockResolvedValueOnce({
        palette: { primary: '#3B3E45', secondary: '#191C22', source: 'fallback' },
        status: {
          state: 'fallback',
          reason: 'local-rate-limit',
          retryable: true,
          cache: 'miss',
          stage: 'primary-core',
        },
      })
      .mockResolvedValueOnce({
        palette: secondPalette,
        status: { state: 'success', source: 'catalog', stage: 'primary-core' },
      });
    const player = new PlayerCoordinator(
      lyricsService(async () => ({ kind: 'missing', lines: [], provider: null })),
      { resolve, find: vi.fn() } as unknown as ArtworkPaletteService,
      testStore(),
    );
    const publishedPalettes: Array<ArtworkPalette | null> = [];
    player.subscribe((snapshot) => publishedPalettes.push(snapshot.artworkPalette));

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track A');
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Artist A');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'Album A');
    player.ingest(VIN, 'MediaNowPlayingDuration', 180_000);
    await vi.advanceTimersByTimeAsync(700);
    expect(player.snapshot().artworkPalette).toEqual(firstPalette);

    publishedPalettes.length = 0;
    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track B');
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Artist B');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'Album B');
    player.ingest(VIN, 'MediaNowPlayingDuration', 200_000);
    await vi.advanceTimersByTimeAsync(700);

    expect(player.snapshot().artworkLookup).toMatchObject({
      state: 'fallback',
      reason: 'local-rate-limit',
      retryable: true,
    });
    expect(player.snapshot().artworkPalette).toEqual(firstPalette);
    expect(publishedPalettes).not.toContainEqual(expect.objectContaining({ source: 'fallback' }));

    await vi.advanceTimersByTimeAsync(5_000);

    expect(resolve).toHaveBeenCalledTimes(3);
    expect(player.snapshot().artworkPalette).toEqual(secondPalette);
    expect(player.snapshot().artworkLookup).toMatchObject({ state: 'success' });
  });

  it('does not retry a definitive artwork catalog miss', async () => {
    const resolve = vi.fn(async () => ({
      palette: { primary: '#3B3E45', secondary: '#191C22', source: 'fallback' as const },
      status: {
        state: 'fallback' as const,
        reason: 'catalog-empty' as const,
        retryable: false,
        cache: 'miss' as const,
        stage: 'fallback-core' as const,
      },
    }));
    const player = new PlayerCoordinator(
      lyricsService(async () => ({ kind: 'missing', lines: [], provider: null })),
      { resolve, find: vi.fn() } as unknown as ArtworkPaletteService,
      testStore(),
    );

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Midnight Circuit');
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Local Drive');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'After Dark');
    player.ingest(VIN, 'MediaNowPlayingDuration', 214_000);
    await vi.advanceTimersByTimeAsync(700);
    await vi.advanceTimersByTimeAsync(200_000);

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(player.snapshot().artworkLookup).toMatchObject({
      state: 'fallback',
      reason: 'catalog-empty',
      retryable: false,
    });
  });

  it('gives a definitive miss a bounded grace period before replacing an old palette', async () => {
    const firstPalette: ArtworkPalette = {
      primary: '#AA2200',
      secondary: '#DD8800',
      source: 'apple',
    };
    const resolve = vi.fn()
      .mockResolvedValueOnce({
        palette: firstPalette,
        status: { state: 'success', source: 'catalog', stage: 'primary-core' },
      })
      .mockResolvedValueOnce({
        palette: { primary: '#3B3E45', secondary: '#191C22', source: 'fallback' },
        status: {
          state: 'fallback',
          reason: 'catalog-empty',
          retryable: false,
          cache: 'miss',
          stage: 'fallback-core',
        },
      });
    const player = new PlayerCoordinator(
      lyricsService(async () => ({ kind: 'missing', lines: [], provider: null })),
      { resolve, find: vi.fn() } as unknown as ArtworkPaletteService,
      testStore(),
    );

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track A');
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Artist A');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'Album A');
    player.ingest(VIN, 'MediaNowPlayingDuration', 180_000);
    await vi.advanceTimersByTimeAsync(700);

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track B');
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Artist B');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'Album B');
    player.ingest(VIN, 'MediaNowPlayingDuration', 200_000);
    await vi.advanceTimersByTimeAsync(700);

    expect(player.snapshot().artworkPalette).toEqual(firstPalette);
    expect(player.snapshot().artworkLookup).toMatchObject({
      state: 'fallback',
      reason: 'catalog-empty',
      retryable: false,
    });

    await vi.advanceTimersByTimeAsync(4_900);
    expect(player.snapshot().artworkPalette).toEqual(firstPalette);

    await vi.advanceTimersByTimeAsync(200);
    expect(player.snapshot().artworkPalette).toEqual({
      primary: '#3B3E45',
      secondary: '#191C22',
      source: 'fallback',
    });
  });

  it('preserves a definitive fallback deadline across an album metadata detour', async () => {
    const firstPalette: ArtworkPalette = {
      primary: '#AA2200',
      secondary: '#DD8800',
      source: 'apple',
    };
    const resolve = vi.fn()
      .mockResolvedValueOnce({
        palette: firstPalette,
        status: { state: 'success', source: 'catalog', stage: 'primary-core' },
      })
      .mockResolvedValueOnce({
        palette: { primary: '#3B3E45', secondary: '#191C22', source: 'fallback' },
        status: {
          state: 'fallback',
          reason: 'catalog-empty',
          retryable: false,
          cache: 'miss',
          stage: 'fallback-core',
        },
      });
    const player = new PlayerCoordinator(
      lyricsService(async () => ({ kind: 'missing', lines: [], provider: null })),
      { resolve, find: vi.fn() } as unknown as ArtworkPaletteService,
      testStore(),
    );

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track A');
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Artist A');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'Album A');
    player.ingest(VIN, 'MediaNowPlayingDuration', 180_000);
    await vi.advanceTimersByTimeAsync(700);

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track B');
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Artist B');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'Album B');
    player.ingest(VIN, 'MediaNowPlayingDuration', 200_000);
    await vi.advanceTimersByTimeAsync(700);
    expect(player.snapshot().artworkPalette).toEqual(firstPalette);

    await vi.advanceTimersByTimeAsync(2_000);
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'Album C');
    expect(player.snapshot().artworkLookup).toEqual({ state: 'loading' });

    await vi.advanceTimersByTimeAsync(1_000);
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'Album B');
    expect(player.snapshot().artworkLookup).toMatchObject({
      state: 'fallback',
      reason: 'catalog-empty',
      retryable: false,
    });
    expect(player.snapshot().artworkPalette).toEqual(firstPalette);

    await vi.advanceTimersByTimeAsync(1_800);
    expect(player.snapshot().artworkPalette).toEqual(firstPalette);

    await vi.advanceTimersByTimeAsync(300);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(player.snapshot().artworkPalette).toEqual({
      primary: '#3B3E45',
      secondary: '#191C22',
      source: 'fallback',
    });
  });

  it('does not extend a definitive fallback deadline across repeated empty title bursts', async () => {
    const firstPalette: ArtworkPalette = {
      primary: '#AA2200',
      secondary: '#DD8800',
      source: 'apple',
    };
    const resolve = vi.fn()
      .mockResolvedValueOnce({
        palette: firstPalette,
        status: { state: 'success', source: 'catalog', stage: 'primary-core' },
      })
      .mockResolvedValueOnce({
        palette: { primary: '#3B3E45', secondary: '#191C22', source: 'fallback' },
        status: {
          state: 'fallback',
          reason: 'catalog-empty',
          retryable: false,
          cache: 'miss',
          stage: 'fallback-core',
        },
      });
    const player = new PlayerCoordinator(
      lyricsService(async () => ({ kind: 'missing', lines: [], provider: null })),
      { resolve, find: vi.fn() } as unknown as ArtworkPaletteService,
      testStore(),
    );

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track A');
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Artist A');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'Album A');
    player.ingest(VIN, 'MediaNowPlayingDuration', 180_000);
    await vi.advanceTimersByTimeAsync(700);

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track B');
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Artist B');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'Album B');
    player.ingest(VIN, 'MediaNowPlayingDuration', 200_000);
    await vi.advanceTimersByTimeAsync(700);
    expect(player.snapshot().artworkPalette).toEqual(firstPalette);

    await vi.advanceTimersByTimeAsync(2_000);
    player.ingest(VIN, 'MediaNowPlayingTitle', '');
    await vi.advanceTimersByTimeAsync(100);
    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track B');
    expect(player.snapshot().artworkPalette).toEqual(firstPalette);

    await vi.advanceTimersByTimeAsync(1_900);
    player.ingest(VIN, 'MediaNowPlayingTitle', '');
    await vi.advanceTimersByTimeAsync(900);
    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track B');

    expect(resolve).toHaveBeenCalledTimes(2);
    expect(player.snapshot().artworkLookup).toMatchObject({
      state: 'fallback',
      reason: 'catalog-empty',
    });
    expect(player.snapshot().artworkPalette).toEqual(firstPalette);

    await vi.advanceTimersByTimeAsync(200);
    expect(player.snapshot().artworkPalette).toEqual({
      primary: '#3B3E45',
      secondary: '#191C22',
      source: 'fallback',
    });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('falls back after all retryable artwork attempts and the final grace period', async () => {
    const firstPalette: ArtworkPalette = {
      primary: '#AA2200',
      secondary: '#DD8800',
      source: 'apple',
    };
    const retryableFallback = {
      palette: { primary: '#3B3E45', secondary: '#191C22', source: 'fallback' as const },
      status: {
        state: 'fallback' as const,
        reason: 'local-rate-limit' as const,
        retryable: true,
        cache: 'miss' as const,
        stage: 'primary-core' as const,
      },
    };
    const resolve = vi.fn()
      .mockResolvedValueOnce({
        palette: firstPalette,
        status: { state: 'success', source: 'catalog', stage: 'primary-core' },
      })
      .mockResolvedValue(retryableFallback);
    const player = new PlayerCoordinator(
      lyricsService(async () => ({ kind: 'missing', lines: [], provider: null })),
      { resolve, find: vi.fn() } as unknown as ArtworkPaletteService,
      testStore(),
    );

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track A');
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Artist A');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'Album A');
    player.ingest(VIN, 'MediaNowPlayingDuration', 180_000);
    await vi.advanceTimersByTimeAsync(700);

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track B');
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Artist B');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'Album B');
    player.ingest(VIN, 'MediaNowPlayingDuration', 200_000);
    await vi.advanceTimersByTimeAsync(700);
    expect(player.snapshot().artworkPalette).toEqual(firstPalette);

    for (const retryDelay of [5_000, 30_000, 120_000]) {
      await vi.advanceTimersByTimeAsync(retryDelay);
      expect(player.snapshot().artworkPalette).toEqual(firstPalette);
    }
    expect(resolve).toHaveBeenCalledTimes(5);
    expect(player.snapshot().artworkLookup).toMatchObject({
      state: 'fallback',
      reason: 'local-rate-limit',
      retryable: true,
    });

    await vi.advanceTimersByTimeAsync(4_900);
    expect(player.snapshot().artworkPalette).toEqual(firstPalette);

    await vi.advanceTimersByTimeAsync(200);
    expect(player.snapshot().artworkPalette).toEqual({
      primary: '#3B3E45',
      secondary: '#191C22',
      source: 'fallback',
    });

    await vi.advanceTimersByTimeAsync(120_000);
    expect(resolve).toHaveBeenCalledTimes(5);
  });

  it('does not let a late artwork lookup overwrite the newest track palette', async () => {
    const resolvers = new Map<string, (palette: ArtworkPalette) => void>();
    const paletteFind = vi.fn((track: TrackMetadata) => new Promise<ArtworkPalette>((resolve) => {
      resolvers.set(track.title, resolve);
    }));
    const player = new PlayerCoordinator(
      lyricsService(async () => ({ kind: 'missing', lines: [], provider: null })),
      artworkPaletteService(paletteFind),
      testStore(),
    );

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track A');
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Artist A');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'Album A');
    player.ingest(VIN, 'MediaNowPlayingDuration', 180_000);
    await vi.advanceTimersByTimeAsync(700);

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track B');
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Artist B');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'Album B');
    player.ingest(VIN, 'MediaNowPlayingDuration', 200_000);
    await vi.advanceTimersByTimeAsync(700);

    resolvers.get('Track B')?.({ primary: '#112233', secondary: '#445566', source: 'apple' });
    await Promise.resolve();
    resolvers.get('Track A')?.({ primary: '#AA0000', secondary: '#00AA00', source: 'apple' });
    await Promise.resolve();

    expect(player.snapshot().artworkPalette).toEqual({
      primary: '#112233',
      secondary: '#445566',
      source: 'apple',
    });
  });

  it('ignores an expired retryable fallback after a newer palette succeeds', async () => {
    type RetryableResolution = {
      palette: ArtworkPalette;
      status: {
        state: 'fallback';
        reason: 'local-rate-limit';
        retryable: true;
        cache: 'miss';
      };
    };
    let finishExpiredLookup: ((resolution: RetryableResolution) => void) | undefined;
    const resolve = vi.fn((track: TrackMetadata) => {
      if (track.title === 'Track B') {
        return new Promise<RetryableResolution>((finish) => {
          finishExpiredLookup = finish;
        });
      }
      return Promise.resolve({
        palette: {
          primary: track.title === 'Track A' ? '#AA2200' : '#112233',
          secondary: track.title === 'Track A' ? '#DD8800' : '#445566',
          source: 'apple' as const,
        },
        status: {
          state: 'success' as const,
          source: 'catalog' as const,
          stage: 'primary-core' as const,
        },
      });
    });
    const player = new PlayerCoordinator(
      lyricsService(async () => ({ kind: 'missing', lines: [], provider: null })),
      { resolve, find: vi.fn() } as unknown as ArtworkPaletteService,
      testStore(),
    );

    for (const [title, artist, album, duration] of [
      ['Track A', 'Artist A', 'Album A', 180_000],
      ['Track B', 'Artist B', 'Album B', 190_000],
      ['Track C', 'Artist C', 'Album C', 200_000],
    ] as const) {
      player.ingest(VIN, 'MediaNowPlayingTitle', title);
      player.ingest(VIN, 'MediaNowPlayingArtist', artist);
      player.ingest(VIN, 'MediaNowPlayingAlbum', album);
      player.ingest(VIN, 'MediaNowPlayingDuration', duration);
      await vi.advanceTimersByTimeAsync(700);
    }

    expect(player.snapshot().artworkPalette).toEqual({
      primary: '#112233',
      secondary: '#445566',
      source: 'apple',
    });

    finishExpiredLookup?.({
      palette: { primary: '#3B3E45', secondary: '#191C22', source: 'fallback' },
      status: {
        state: 'fallback',
        reason: 'local-rate-limit',
        retryable: true,
        cache: 'miss',
      },
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(resolve).toHaveBeenCalledTimes(3);
    expect(player.snapshot().artworkPalette).toEqual({
      primary: '#112233',
      secondary: '#445566',
      source: 'apple',
    });
    expect(player.snapshot().artworkLookup).toMatchObject({ state: 'success' });
  });

  it('keeps the previous cover visible while the next track artwork loads', async () => {
    const paletteFind = vi.fn(async (): Promise<ArtworkPalette> => ({
      primary: '#AA2200',
      secondary: '#DD8800',
      source: 'apple',
    }));
    const player = new PlayerCoordinator(
      lyricsService(async () => ({ kind: 'missing', lines: [], provider: null })),
      artworkPaletteService(paletteFind),
      testStore(),
    );

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track A');
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Artist A');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'Album A');
    player.ingest(VIN, 'MediaNowPlayingDuration', 180_000);
    await vi.advanceTimersByTimeAsync(700);
    expect(player.snapshot().artworkPalette?.source).toBe('apple');

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track B');

    expect(player.snapshot().artworkPalette).toEqual({
      primary: '#AA2200',
      secondary: '#DD8800',
      source: 'apple',
    });
  });

  it('restores the active lookup when metadata returns before the next debounce', async () => {
    const firstPalette: ArtworkPalette = {
      primary: '#AA2200',
      secondary: '#DD8800',
      source: 'apple',
    };
    const resolve = vi.fn(async () => ({
      palette: firstPalette,
      status: {
        state: 'success' as const,
        source: 'catalog' as const,
        stage: 'primary-core' as const,
      },
    }));
    const player = new PlayerCoordinator(
      lyricsService(async () => ({ kind: 'missing', lines: [], provider: null })),
      { resolve, find: vi.fn() } as unknown as ArtworkPaletteService,
      testStore(),
    );

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track A');
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Artist A');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'Album A');
    player.ingest(VIN, 'MediaNowPlayingDuration', 180_000);
    await vi.advanceTimersByTimeAsync(700);
    expect(player.snapshot().artworkLookup).toEqual({
      state: 'success',
      source: 'catalog',
      stage: 'primary-core',
    });

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track B');
    expect(player.snapshot().artworkLookup).toEqual({ state: 'loading' });
    expect(player.snapshot().artworkPalette).toEqual(firstPalette);

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track A');
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Artist A');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'Album A');
    player.ingest(VIN, 'MediaNowPlayingDuration', 180_000);

    expect(player.snapshot().artworkLookup).toEqual({
      state: 'success',
      source: 'catalog',
      stage: 'primary-core',
    });
    expect(player.snapshot().artworkPalette).toEqual(firstPalette);

    await vi.advanceTimersByTimeAsync(200_000);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(player.snapshot().artworkLookup).toMatchObject({ state: 'success' });
  });

  it('keeps the old palette through an empty title burst', async () => {
    const firstPalette: ArtworkPalette = {
      primary: '#AA2200',
      secondary: '#DD8800',
      source: 'apple',
    };
    const secondPalette: ArtworkPalette = {
      primary: '#224466',
      secondary: '#884422',
      source: 'apple',
    };
    const paletteFind = vi.fn(async (track: TrackMetadata): Promise<ArtworkPalette> =>
      track.title === 'Track A' ? firstPalette : secondPalette);
    const player = new PlayerCoordinator(
      lyricsService(async () => ({ kind: 'missing', lines: [], provider: null })),
      artworkPaletteService(paletteFind),
      testStore(),
    );

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track A');
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Shared Artist');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'Shared Album');
    player.ingest(VIN, 'MediaNowPlayingDuration', 180_000);
    await vi.advanceTimersByTimeAsync(700);
    expect(player.snapshot().artworkPalette).toEqual(firstPalette);

    player.ingest(VIN, 'MediaNowPlayingTitle', '');
    expect(player.snapshot().artworkPalette).toEqual(firstPalette);
    expect(player.snapshot().artworkLookup).toEqual({ state: 'idle' });

    player.ingest(VIN, 'MediaNowPlayingArtist', 'Shared Artist');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'Shared Album');
    player.ingest(VIN, 'MediaNowPlayingDuration', 180_000);
    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track B');
    expect(player.snapshot().artworkPalette).toEqual(firstPalette);

    await vi.advanceTimersByTimeAsync(700);
    expect(player.snapshot().artworkPalette).toEqual(secondPalette);
  });

  it('clears an old palette when the title stays empty beyond the grace period', async () => {
    const firstPalette: ArtworkPalette = {
      primary: '#AA2200',
      secondary: '#DD8800',
      source: 'apple',
    };
    const player = new PlayerCoordinator(
      lyricsService(async () => ({ kind: 'missing', lines: [], provider: null })),
      artworkPaletteService(async () => firstPalette),
      testStore(),
    );

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track A');
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Artist A');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'Album A');
    player.ingest(VIN, 'MediaNowPlayingDuration', 180_000);
    await vi.advanceTimersByTimeAsync(700);

    player.ingest(VIN, 'MediaNowPlayingTitle', '');
    await vi.advanceTimersByTimeAsync(4_900);
    expect(player.snapshot().artworkPalette).toEqual(firstPalette);
    expect(player.snapshot().artworkLookup).toEqual({ state: 'idle' });

    await vi.advanceTimersByTimeAsync(200);
    expect(player.snapshot().artworkPalette).toBeNull();
    expect(player.snapshot().artworkLookup).toEqual({ state: 'idle' });
  });

  it('waits for a late album field instead of publishing an intermediate palette', async () => {
    const firstPalette: ArtworkPalette = {
      primary: '#AA2200',
      secondary: '#DD8800',
      source: 'apple',
    };
    const secondPalette: ArtworkPalette = {
      primary: '#224466',
      secondary: '#884422',
      source: 'apple',
    };
    const paletteFind = vi.fn(async (track: TrackMetadata): Promise<ArtworkPalette> =>
      track.title === 'Track A' ? firstPalette : secondPalette);
    const player = new PlayerCoordinator(
      lyricsService(async () => ({ kind: 'missing', lines: [], provider: null })),
      artworkPaletteService(paletteFind),
      testStore(),
    );

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track A');
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Artist A');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'Album A');
    player.ingest(VIN, 'MediaNowPlayingDuration', 180_000);
    await vi.advanceTimersByTimeAsync(700);
    paletteFind.mockClear();

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track B');
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Artist B');
    player.ingest(VIN, 'MediaNowPlayingDuration', 200_000);
    await vi.advanceTimersByTimeAsync(1_500);

    expect(paletteFind).not.toHaveBeenCalled();
    expect(player.snapshot().artworkPalette).toEqual(firstPalette);

    player.ingest(VIN, 'MediaNowPlayingAlbum', 'Album B');
    await vi.advanceTimersByTimeAsync(700);

    expect(paletteFind).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      title: 'Track B',
      artist: 'Artist B',
      album: 'Album B',
      durationMs: 200_000,
    }));
    expect(player.snapshot().artworkPalette).toEqual(secondPalette);
  });

  it('does not restart an in-flight artwork lookup for repeated metadata', async () => {
    const paletteFind = vi.fn(() => new Promise<ArtworkPalette>(() => undefined));
    const player = new PlayerCoordinator(
      lyricsService(async () => ({ kind: 'missing', lines: [], provider: null })),
      artworkPaletteService(paletteFind),
      testStore(),
    );

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track A');
    player.ingest(VIN, 'MediaNowPlayingArtist', 'Artist A');
    player.ingest(VIN, 'MediaNowPlayingAlbum', 'Album A');
    player.ingest(VIN, 'MediaNowPlayingDuration', 180_000);
    await vi.advanceTimersByTimeAsync(700);

    player.ingest(VIN, 'MediaNowPlayingTitle', 'Track A');
    await vi.advanceTimersByTimeAsync(700);

    expect(paletteFind).toHaveBeenCalledTimes(1);
  });
});
