import OpenCC from 'opencc-js';
import type { TrackMetadata } from '../shared/contracts.js';
import {
  metadataSimilarity,
  metadataVersionMismatch,
  metadataVersionSignature,
  normalizeMetadata,
  trackMatchScore,
} from '../shared/track.js';

const toSimplified = OpenCC.Converter({ from: 't', to: 'cn' });
const toTraditional = OpenCC.Converter({ from: 'cn', to: 't' });
const HAN_CHARACTER = /\p{Script=Han}/u;
const JAPANESE_OR_KOREAN_CHARACTER =
  /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export type ChineseLyricsScript =
  | 'simplified'
  | 'traditional'
  | 'mixed'
  | 'neutral';

function boundedScriptSample(value: string): string {
  return Array.from(value.slice(0, 40_000)).slice(0, 20_000).join('');
}

/**
 * Classify the script of the text that will actually be displayed.
 *
 * This deliberately does not return converted text. It is only a selection
 * signal, so provider text, timestamps, hashes, and manual choices remain
 * byte-for-byte unchanged. Kana/Hangul make the result neutral to avoid
 * treating Japanese shinjitai or Korean hanja as Chinese Traditional text.
 */
export function chineseLyricsScript(value: string): ChineseLyricsScript {
  const sample = boundedScriptSample(value);
  if (
    !sample.trim()
    || !HAN_CHARACTER.test(sample)
    || JAPANESE_OR_KOREAN_CHARACTER.test(sample)
  ) return 'neutral';

  const changesWhenSimplified = toSimplified(sample) !== sample;
  const changesWhenTraditionalized = toTraditional(sample) !== sample;
  if (!changesWhenSimplified && changesWhenTraditionalized) return 'simplified';
  if (changesWhenSimplified && !changesWhenTraditionalized) return 'traditional';
  if (changesWhenSimplified && changesWhenTraditionalized) return 'mixed';
  return 'neutral';
}

/** Normalize script only for equivalence scoring; never use this as display text. */
export function normalizeChineseScriptForComparison(value: string): string {
  return toSimplified(boundedScriptSample(value));
}

/**
 * Convert the complete display string to Simplified Chinese.
 *
 * Callers must first establish that the content is Chinese. Metadata matching
 * continues to use the bounded comparison helper above, while Apple display
 * projection needs the complete, untruncated provider text.
 */
export function simplifyChineseDisplayText(value: string): string {
  return toSimplified(value);
}

function distinctMetadata(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = normalizeMetadata(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Search-only aliases. Persistent v1 fingerprints deliberately keep their
 * original script so existing bindings and manual overrides remain stable.
 */
export function metadataScriptVariants(value: string): string[] {
  if (!value.trim()) return [];
  return distinctMetadata([value, toSimplified(value), toTraditional(value)]);
}

export function trackScriptVariants(track: TrackMetadata): TrackMetadata[] {
  const candidates = [
    track,
    {
      ...track,
      title: toSimplified(track.title),
      artist: toSimplified(track.artist),
      album: toSimplified(track.album),
    },
    {
      ...track,
      title: toTraditional(track.title),
      artist: toTraditional(track.artist),
      album: toTraditional(track.album),
    },
  ];
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = [candidate.title, candidate.artist, candidate.album]
      .map(normalizeMetadata)
      .join('\u001f');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function scriptAwareMetadataSimilarity(left: string, right: string): number {
  return Math.max(
    metadataSimilarity(left, right),
    metadataSimilarity(toSimplified(left), toSimplified(right)),
  );
}

export function scriptEquivalentMetadata(left: string, right: string): boolean {
  const normalizedLeft = normalizeMetadata(toSimplified(left));
  const normalizedRight = normalizeMetadata(toSimplified(right));
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

export function scriptAwareTrackMatchScore(
  wanted: Pick<TrackMetadata, 'title' | 'artist' | 'album' | 'durationMs'>,
  candidate: { trackName: string; artistName: string; albumName?: string; duration: number },
): number {
  return Math.max(
    trackMatchScore(wanted, candidate),
    trackMatchScore(
      {
        ...wanted,
        title: toSimplified(wanted.title),
        artist: toSimplified(wanted.artist),
        album: toSimplified(wanted.album),
      },
      {
        ...candidate,
        trackName: toSimplified(candidate.trackName),
        artistName: toSimplified(candidate.artistName),
        albumName: candidate.albumName === undefined
          ? undefined
          : toSimplified(candidate.albumName),
      },
    ),
  );
}

export function scriptEquivalentTrackMetadata(
  left: Pick<TrackMetadata, 'title' | 'artist' | 'album'>,
  right: Pick<TrackMetadata, 'title' | 'artist' | 'album'>,
): boolean {
  const leftAlbum = normalizeMetadata(left.album);
  const rightAlbum = normalizeMetadata(right.album);
  return !metadataVersionMismatch(left.title, right.title)
    && scriptEquivalentMetadata(left.title, right.title)
    && scriptEquivalentMetadata(left.artist, right.artist)
    && (
      (!leftAlbum && !rightAlbum)
      || (Boolean(leftAlbum && rightAlbum) && scriptEquivalentMetadata(left.album, right.album))
    );
}

export function isExplicitInstrumentalTitle(title: string): boolean {
  const tags = metadataVersionSignature(title).split(',');
  return tags.includes('instrumental')
    || tags.includes('karaoke')
    || /纯音乐|純音樂/u.test(title);
}
