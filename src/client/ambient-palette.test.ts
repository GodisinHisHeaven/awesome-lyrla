import type { PlayerSnapshot } from '../shared/contracts.js';
import {
  ambientFieldPalette,
  spatialFieldForSnapshot,
} from './ambient-palette.js';

function snapshotWith(
  primary: string,
  secondary: string,
  title = 'Midnight Circuit',
): PlayerSnapshot {
  return {
    mode: 'live',
    connection: 'connected',
    track: {
      title,
      artist: 'Local Drive',
      album: 'After Dark',
      durationMs: 214_000,
      source: 'Apple Music',
    },
    playbackStatus: 'playing',
    elapsedMs: 4_000,
    capturedAtMs: 1_000,
    manualOffsetMs: 0,
    lyrics: { kind: 'missing', lines: [], provider: null },
    artworkPalette: { primary, secondary, source: 'apple' },
  };
}

describe('ambientFieldPalette', () => {
  it('preserves a validated album palette and derives a stable bridge color', () => {
    const palette = ambientFieldPalette(snapshotWith('#123456', '#A0B0C0'));

    expect(palette.primary).toBe('18 52 86');
    expect(palette.secondary).toBe('160 176 192');
    expect(palette.bridge).toBe('86 112 137');
    expect(palette.key).toBe('18 52 86:160 176 192:86 112 137');
    expect(Number.parseInt(palette.cycleA)).toBeGreaterThanOrEqual(31);
    expect(Number.parseInt(palette.cycleA)).toBeLessThanOrEqual(35);
    expect(Number.parseInt(palette.cycleB)).toBeGreaterThanOrEqual(43);
    expect(Number.parseInt(palette.cycleB)).toBeLessThanOrEqual(49);
  });

  it('uses one deterministic metadata fallback when either artwork color is invalid', () => {
    const invalidPair = ambientFieldPalette(snapshotWith('#123456', 'not-a-color'));
    const missingPair = ambientFieldPalette({
      ...snapshotWith('#123456', '#A0B0C0'),
      artworkPalette: null,
    });

    expect(invalidPair).toEqual(missingPair);
    expect(invalidPair.primary).not.toBe('18 52 86');
    expect(ambientFieldPalette(snapshotWith('#123456', 'not-a-color'))).toEqual(invalidPair);
  });

  it('reduces field opacity for bright artwork without changing its colors', () => {
    const dark = ambientFieldPalette(snapshotWith('#101820', '#283848'));
    const bright = ambientFieldPalette(snapshotWith('#F8F4E8', '#E8D8B0'));

    expect(bright.primary).toBe('248 244 232');
    expect(bright.secondary).toBe('232 216 176');
    expect(Number(bright.primaryAlpha)).toBeLessThan(Number(dark.primaryAlpha));
    expect(Number(bright.secondaryAlpha)).toBeLessThan(Number(dark.secondaryAlpha));
    expect(Number(bright.bridgeAlpha)).toBeLessThan(Number(dark.bridgeAlpha));
  });

  it('varies the fallback field and motion phase with the track identity', () => {
    const first = ambientFieldPalette({
      ...snapshotWith('#123456', '#A0B0C0'),
      artworkPalette: null,
    });
    const second = ambientFieldPalette({
      ...snapshotWith('#123456', '#A0B0C0', 'Sunrise Circuit'),
      artworkPalette: null,
    });

    expect(second.key).not.toBe(first.key);
    expect([second.cycleA, second.cycleB, second.delayA, second.delayB])
      .not.toEqual([first.cycleA, first.cycleB, first.delayA, first.delayB]);
  });
});

describe('spatialFieldForSnapshot', () => {
  it('maps a validated real artwork field without losing its spatial direction', () => {
    const source = snapshotWith('#123456', '#A0B0C0');
    source.artworkPalette = {
      ...source.artworkPalette!,
      field: {
        schemaVersion: 1,
        id: 'field:0123456789abcdef',
        columns: 6,
        rows: 4,
        base: '#17202A',
        colors: Array.from({ length: 24 }, (_, index) => index % 6 < 3 ? '#AA3344' : '#3344AA'),
      },
    };

    const field = spatialFieldForSnapshot(source);

    expect(field).toMatchObject({
      id: 'field:0123456789abcdef',
      columns: 6,
      rows: 4,
      base: '#17202A',
    });
    expect(field.colors).toEqual(source.artworkPalette.field?.colors);
    expect(field.colors).not.toBe(source.artworkPalette.field?.colors);
    expect(Number.parseInt(field.cycleA ?? '')).toBeGreaterThanOrEqual(89);
    expect(Number.parseInt(field.cycleA ?? '')).toBeLessThanOrEqual(101);
    expect(Number.parseInt(field.cycleB ?? '')).toBeGreaterThanOrEqual(43);
    expect(Number.parseInt(field.cycleB ?? '')).toBeLessThanOrEqual(53);
    expect(Number.parseInt(field.cycleC ?? '')).toBeGreaterThanOrEqual(131);
    expect(Number.parseInt(field.cycleC ?? '')).toBeLessThanOrEqual(149);
  });

  it('uses a stable 6x4 fallback for a missing or malformed real field', () => {
    const source = snapshotWith('#123456', '#A0B0C0');
    const malformed = {
      ...source,
      artworkPalette: {
        ...source.artworkPalette!,
        field: {
          schemaVersion: 1,
          id: 'not-a-field',
          columns: 6,
          rows: 4,
          base: '#17202A',
          colors: ['#AA3344'],
        },
      },
    } as unknown as PlayerSnapshot;

    const first = spatialFieldForSnapshot(malformed);
    const second = spatialFieldForSnapshot(malformed);

    expect(first.id).toMatch(/^fallback:/);
    expect(first.colors).toHaveLength(24);
    expect(second).toEqual(first);
  });
});
