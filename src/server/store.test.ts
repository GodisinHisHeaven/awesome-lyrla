import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LyricsPayload } from '../shared/contracts.js';
import { JsonStore, type PersistedState } from './store.js';

function emptyState(): PersistedState {
  return {
    version: 1,
    selectedVin: null,
    selectedVehicleName: null,
    teslaTokens: null,
    telemetryAccepted: false,
    telemetryConfiguredAt: null,
    telemetrySynced: false,
    lyricOffsets: {},
    lyricOverrides: {},
    candidateLyricsOverrides: {},
    lyricsCache: {},
    workLyricsCache: {},
    artworkPaletteCache: {},
  };
}

function cachedPayload(text: string, expiresAt = Date.now() + 60_000) {
  const payload: LyricsPayload = {
    kind: 'synced',
    lines: [{ id: text, startMs: 0, text }],
    provider: 'lrclib',
  };
  return { payload, expiresAt };
}

function withInternals(store: JsonStore, state: PersistedState, filePath: string): void {
  const internals = store as unknown as {
    state: PersistedState;
    filePath: string;
    compatibilityFilePath: string;
  };
  internals.state = state;
  internals.filePath = filePath;
  internals.compatibilityFilePath = `${filePath}.compatibility.json`;
}

describe('JsonStore narrow cache access', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'awesome-lyrla-store-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('clones only the requested track entries', () => {
    const state = emptyState();
    state.lyricsCache.track = cachedPayload('one');
    state.workLyricsCache.work = {
      schemaVersion: 1,
      plainText: 'work',
      provider: 'lrclib',
      sourceTitle: 'Song',
      sourceArtist: 'Artist',
      storedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    const store = new JsonStore();
    withInternals(store, state, path.join(directory, 'state.json'));

    const track = store.readLyricsEntries('track');
    const work = store.readWorkLyrics('work');
    track.cached!.payload.lines[0]!.text = 'mutated';
    work!.plainText = 'mutated';

    expect(state.lyricsCache.track!.payload.lines[0]!.text).toBe('one');
    expect(state.workLyricsCache.work!.plainText).toBe('work');
  });

  it('defers serialization, coalesces a burst, and prunes expired/old entries', async () => {
    const state = emptyState();
    state.lyricsCache.expired = cachedPayload('expired', Date.now() - 1);
    const store = new JsonStore();
    const filePath = path.join(directory, 'state.json');
    withInternals(store, state, filePath);

    const first = store.updateCachedLyrics('first', () => cachedPayload('first'), 2);
    const second = store.updateCachedLyrics('second', () => cachedPayload('second'), 2);
    const third = store.updateCachedLyrics('third', () => cachedPayload('third'), 2);

    await expect(access(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await Promise.all([first, second, third]);

    const persisted = JSON.parse(
      await readFile(`${filePath}.compatibility.json`, 'utf8'),
    ) as Pick<PersistedState, 'lyricsCache' | 'workLyricsCache' | 'artworkPaletteCache'>;
    expect(Object.keys(persisted.lyricsCache)).toEqual(['second', 'third']);
    expect(persisted.lyricsCache.expired).toBeUndefined();
    expect((await readFile(`${filePath}.compatibility.json`, 'utf8')).split('\n')).toHaveLength(2);
    await expect(access(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('bounds exact and work compatibility caches with one combined byte budget', async () => {
    const store = new JsonStore();
    const filePath = path.join(directory, 'state.json');
    withInternals(store, emptyState(), filePath);
    const exact = cachedPayload('x'.repeat(1_024));
    const exactBytes = Buffer.byteLength('exact:exact', 'utf8')
      + Buffer.byteLength(JSON.stringify(exact), 'utf8');
    const work = {
      schemaVersion: 1 as const,
      plainText: 'y'.repeat(1_024),
      provider: 'lrclib' as const,
      sourceTitle: 'Song',
      sourceArtist: 'Artist',
      storedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    const workBytes = Buffer.byteLength('work:work', 'utf8')
      + Buffer.byteLength(JSON.stringify(work), 'utf8');
    const byteLimit = Math.max(exactBytes, workBytes) + 32;

    await store.updateCachedLyrics('exact', () => exact, 10, byteLimit);
    await store.updateWorkLyrics('work', work, 10, byteLimit);

    const persisted = JSON.parse(
      await readFile(`${filePath}.compatibility.json`, 'utf8'),
    ) as Pick<PersistedState, 'lyricsCache' | 'workLyricsCache' | 'artworkPaletteCache'>;
    expect(persisted.lyricsCache).toEqual({});
    expect(Object.keys(persisted.workLyricsCache)).toEqual(['work']);
  });

  it('round-trips versioned artwork failure diagnostics without storing image data', async () => {
    const store = new JsonStore();
    const filePath = path.join(directory, 'state.json');
    withInternals(store, emptyState(), filePath);

    await store.updateArtworkPalette('track', {
      palette: null,
      expiresAt: Date.now() + 60_000,
      lookupStrategy: 'multistage-v1',
      failureReason: 'no-reliable-match',
      lookupStage: 'fallback-core',
    }, 500);

    const cached = store.readArtworkPalette('track');
    expect(cached).toMatchObject({
      palette: null,
      lookupStrategy: 'multistage-v1',
      failureReason: 'no-reliable-match',
      lookupStage: 'fallback-core',
    });
    expect(JSON.stringify(cached)).not.toContain('image');
    const persisted = JSON.parse(
      await readFile(`${filePath}.compatibility.json`, 'utf8'),
    ) as Pick<PersistedState, 'lyricsCache' | 'workLyricsCache' | 'artworkPaletteCache'>;
    expect(persisted.artworkPaletteCache.track).toEqual(cached);
  });

  it('migrates legacy inline caches into the compatibility sidecar', async () => {
    const store = new JsonStore();
    const filePath = path.join(directory, 'state.json');
    const legacy = emptyState();
    legacy.selectedVehicleName = 'Test vehicle';
    legacy.lyricsCache.track = cachedPayload('legacy');
    await writeFile(filePath, JSON.stringify(legacy));
    withInternals(store, emptyState(), filePath);

    await store.load();

    const persistedState = JSON.parse(await readFile(filePath, 'utf8')) as PersistedState;
    const persistedCache = JSON.parse(
      await readFile(`${filePath}.compatibility.json`, 'utf8'),
    ) as Pick<PersistedState, 'lyricsCache' | 'workLyricsCache' | 'artworkPaletteCache'>;
    expect(persistedState.selectedVehicleName).toBe('Test vehicle');
    expect(persistedState.lyricsCache).toEqual({});
    expect(persistedCache.lyricsCache.track).toEqual(legacy.lyricsCache.track);
    expect(store.readLyricsEntries('track').cached).toEqual(legacy.lyricsCache.track);
  });
});
