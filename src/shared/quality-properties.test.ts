import fc from 'fast-check';
import { activeLyricIndex, parseLrc } from './lrc.js';
import {
  metadataSimilarity,
  metadataVersionSignature,
  normalizeMetadata,
  trackMatchScore,
} from './track.js';

const lyricText = fc
  .array(fc.constantFrom(...'abcdef ABCDEF世界道路星光'), { minLength: 1, maxLength: 24 })
  .map((characters) => characters.join('').trim() || '♪');

const timedLine = fc.record({
  minutes: fc.integer({ min: 0, max: 999 }),
  seconds: fc.integer({ min: 0, max: 59 }),
  milliseconds: fc.integer({ min: 0, max: 999 }),
  text: lyricText,
});

describe('critical policy properties', () => {
  it('parses arbitrary valid LRC into a stable, sorted, non-negative timeline', () => {
    fc.assert(
      fc.property(
        fc.array(timedLine, { minLength: 1, maxLength: 40 }),
        fc.integer({ min: -5_000, max: 5_000 }),
        (entries, offset) => {
          const input = [
            `[offset:${offset}]`,
            ...entries.map(
              ({ minutes, seconds, milliseconds, text }) =>
                `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}]${text}`,
            ),
          ].join('\n');
          const parsed = parseLrc(input);

          expect(parsed.embeddedOffsetMs).toBe(offset);
          expect(parsed.lines).toHaveLength(entries.length);
          expect(new Set(parsed.lines.map((line) => line.id))).toHaveLength(entries.length);
          expect(parsed.lines.every((line) => line.startMs >= 0)).toBe(true);
          expect(parsed.lines.map((line) => line.startMs)).toEqual(
            [...parsed.lines.map((line) => line.startMs)].sort((left, right) => left - right),
          );
        },
      ),
      { numRuns: 250 },
    );
  });

  it('selects exactly the last lyric at or before the effective playback time', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 0, max: 2_000_000 }), { maxLength: 100 }),
        fc.integer({ min: -1_000_000, max: 3_000_000 }),
        fc.integer({ min: -10_000, max: 10_000 }),
        (starts, elapsedMs, offsetMs) => {
          const sorted = [...starts].sort((left, right) => left - right);
          const lines = sorted.map((startMs, index) => ({
            id: String(index),
            startMs,
            text: String(index),
          }));
          const target = Math.max(0, elapsedMs + offsetMs);
          const expected = sorted.reduce(
            (result, startMs, index) => (startMs <= target ? index : result),
            -1,
          );
          expect(activeLyricIndex(lines, elapsedMs, offsetMs)).toBe(expected);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('keeps metadata normalization idempotent and similarity symmetric', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), fc.string({ maxLength: 120 }), (left, right) => {
        const normalized = normalizeMetadata(left);
        expect(normalizeMetadata(normalized)).toBe(normalized);
        const forward = metadataSimilarity(left, right);
        const backward = metadataSimilarity(right, left);
        expect(forward).toBeGreaterThanOrEqual(0);
        expect(forward).toBeLessThanOrEqual(1);
        expect(forward).toBeCloseTo(backward, 12);
      }),
      { numRuns: 500 },
    );
  });

  it('keeps exact metadata at the score ceiling and makes every mismatch costly', () => {
    const wanted = {
      title: 'Midnight Circuit',
      artist: 'Local Drive',
      album: 'After Dark',
      durationMs: 214_000,
    };
    const exact = {
      trackName: wanted.title,
      artistName: wanted.artist,
      albumName: wanted.album,
      duration: wanted.durationMs / 1_000,
    };

    expect(trackMatchScore(wanted, exact)).toBe(1);
    expect(trackMatchScore(wanted, { ...exact, artistName: 'Another Artist' })).toBeLessThan(1);
    expect(trackMatchScore(wanted, { ...exact, albumName: 'Another Album' })).toBeLessThan(1);
    expect(trackMatchScore(wanted, { ...exact, duration: exact.duration + 24 })).toBeLessThan(1);
  });

  it('canonicalizes and sorts every recording-version signal', () => {
    expect(metadataVersionSignature('Midnight Circuit (Sped Up, Remastered, Acoustic)')).toBe(
      'acoustic,remaster,sped',
    );
  });
});
