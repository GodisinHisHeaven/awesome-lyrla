import type { TrackMetadata } from './contracts.js';

const FEATURE_BLOCK = /\s*[([{]\s*(feat\.?|ft\.?|featuring)\b[^\])}]*[\])}]/gi;
const VERSION_BLOCK = /\s*[([{]\s*(remaster(?:ed)?|live|radio edit|acoustic|mono|stereo|deluxe)[^\])}]*[\])}]/gi;
const VERSION_SUFFIX = /\s+-\s+(\d{4}\s+)?(remaster(?:ed)?|live|radio edit|acoustic|mono|stereo).*$/gi;
const RECORDING_VERSION_TAG = /\b(live|remaster(?:ed)?|acoustic|radio edit|mono|stereo|deluxe|remix(?:ed)?|instrumental|karaoke|demo|sped(?:\s+up)?|slowed(?:\s+down)?|nightcore|clean|explicit|club mix|extended mix|original mix|single version)\b/gi;
const STATIC_FALLBACK_VERSION_BLOCK = /\s*[([{（【]\s*((?:live|acoustic)\b|不插[电電])([^\])}）】]*)[\])}）】]\s*$/iu;
const STATIC_FALLBACK_VERSION_SUFFIX = /\s[-–—]\s*(?:\d{4}\s+)?((?:live|acoustic)\b|不插[电電])(.*)$/iu;
const UNSUPPORTED_VERSION_DECORATION = /(?:[([{（【][^\])}）】]*(?:remix|remaster(?:ed)?|radio edit|instrumental|karaoke|demo|sped(?:\s+up)?|slowed(?:\s+down)?|nightcore|club mix|extended mix)[^\])}）】]*[\])}）】]|\s[-–—]\s*[^\n]*(?:remix|remaster(?:ed)?|radio edit|instrumental|karaoke|demo|sped(?:\s+up)?|slowed(?:\s+down)?|nightcore|club mix|extended mix)\b)/i;
const UNSUPPORTED_CHINESE_VERSION_DECORATION = /(?:[([{（【][^\])}）】]*(?:混音|重[制製]|[纯純]音[乐樂]|伴奏)[^\])}）】]*[\])}）】]|\s[-–—]\s*[^\n]*(?:混音|重[制製]|[纯純]音[乐樂]|伴奏))/iu;
const SEARCH_NOISE_BLOCK = /\s*[([{]\s*(?:official\s+(?:audio|video)|audio|music\s+video|lyric\s+video|visuali[sz]er|lyrics?)\s*[\])}]/gi;
const SEARCH_NOISE_SUFFIX = /\s[-–—]\s*(?:official\s+(?:audio|video)|audio|music\s+video|lyric\s+video|visuali[sz]er|lyrics?)\s*$/i;

export type StaticLyricsFallbackVersion = 'live' | 'acoustic';

function parseStaticLyricsFallbackVersion(
  title: string,
): { version: StaticLyricsFallbackVersion; baseTitle: string } | null {
  const match = title.match(STATIC_FALLBACK_VERSION_BLOCK)
    ?? title.match(STATIC_FALLBACK_VERSION_SUFFIX);
  const rawVersion = match?.[1]?.toLowerCase();
  const chineseAcoustic = rawVersion === '不插电' || rawVersion === '不插電';
  const version = chineseAcoustic ? 'acoustic' : rawVersion;
  if (version !== 'live' && version !== 'acoustic') return null;

  const qualifier = match?.[2]?.trim().toLowerCase() ?? '';
  const allowedQualifier = chineseAcoustic
    ? /^(?:|版|版本)$/u
    : version === 'live'
      ? /^(?:|version|at\s+.+|in\s+.+|from\s+.+|session|recording|performance)$/i
      : /^(?:|version|session|take|recording|performance)$/i;
  if (!allowedQualifier.test(qualifier)) return null;

  const baseTitle = title.slice(0, match?.index ?? title.length).trim();
  if (
    !baseTitle
    || UNSUPPORTED_VERSION_DECORATION.test(baseTitle)
    || UNSUPPORTED_CHINESE_VERSION_DECORATION.test(baseTitle)
  ) return null;
  return { version, baseTitle };
}

export function staticLyricsFallbackVersion(title: string): StaticLyricsFallbackVersion | null {
  return parseStaticLyricsFallbackVersion(title)?.version ?? null;
}

export function staticLyricsFallbackBaseTitle(title: string): string | null {
  return parseStaticLyricsFallbackVersion(title)?.baseTitle ?? null;
}

function canonicalVersionTag(tag: string): string {
  if (tag.startsWith('remaster')) return 'remaster';
  if (tag.startsWith('remix')) return 'remix';
  if (tag.startsWith('sped')) return 'sped';
  if (tag.startsWith('slowed')) return 'slowed';
  return tag.replace(/\s+/g, ' ');
}

function recordingVersionTags(value: string): Set<string> {
  return new Set(Array.from(
    value.toLowerCase().matchAll(RECORDING_VERSION_TAG),
    (match) => canonicalVersionTag(match[0]),
  ));
}

/**
 * Search/fallback-only aliases. Persistent v1 fingerprints must continue to
 * use recordingVersionTags so adding localized labels never changes a stored
 * Exact key.
 */
function matchingRecordingVersionTags(value: string): Set<string> {
  const tags = recordingVersionTags(value);
  if (/不插[电電]/u.test(value)) tags.add('acoustic');
  if (/混音/u.test(value)) tags.add('remix');
  if (/重[制製]/u.test(value)) tags.add('remaster');
  if (/(?:[纯純]音[乐樂]|伴奏)/u.test(value)) tags.add('instrumental');
  return tags;
}

export function metadataVersionSignature(value: string): string {
  return [...recordingVersionTags(value)].sort().join(',');
}

/** Conservative version detector for bulk writes; false positives only reduce preload coverage. */
export function hasRecordingVersionTag(value: string): boolean {
  return matchingRecordingVersionTags(value).size > 0;
}

export function lyricsSearchTitleVariants(title: string): string[] {
  const withoutFeatures = title.replace(FEATURE_BLOCK, '').trim();
  const withoutNoise = title
    .replace(SEARCH_NOISE_BLOCK, '')
    .replace(SEARCH_NOISE_SUFFIX, '')
    .trim();
  const candidates = [
    title,
    withoutFeatures,
    withoutNoise,
    withoutFeatures
      .replace(SEARCH_NOISE_BLOCK, '')
      .replace(SEARCH_NOISE_SUFFIX, '')
      .trim(),
  ];
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = candidate.toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function lyricsWorkFingerprint(
  track: Pick<TrackMetadata, 'title' | 'artist'>,
): string | null {
  const artist = normalizeMetadata(track.artist);
  if (!artist) return null;
  const cleanedTitle = lyricsSearchTitleVariants(track.title).at(-1) ?? track.title;
  const tags = matchingRecordingVersionTags(cleanedTitle);
  const safeStandaloneVersion = tags.size <= 1 && [...tags].every((tag) =>
    ['live', 'acoustic', 'remaster'].includes(tag));
  const variantSuffix = tags.size > 0 && !safeStandaloneVersion
    ? `::variant=${[...tags].sort().join(',')}`
    : '';
  const baseTitle = staticLyricsFallbackBaseTitle(cleanedTitle) ?? cleanedTitle;
  return `${normalizeMetadata(baseTitle)}::${artist}${variantSuffix}`;
}

export function normalizeMetadata(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(FEATURE_BLOCK, '')
    .replace(VERSION_BLOCK, '')
    .replace(VERSION_SUFFIX, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/\s+/g, ' ');
}

export function trackFingerprint(track: Pick<TrackMetadata, 'title' | 'artist' | 'durationMs'>): string {
  const durationBucket = Math.round(track.durationMs / 2_000) * 2;
  const versionSignature = metadataVersionSignature(track.title);
  const versionSuffix = versionSignature ? `::v=${versionSignature}` : '';
  return `${normalizeMetadata(track.title)}::${normalizeMetadata(track.artist)}::${durationBucket}${versionSuffix}`;
}

export function lyricsLookupFingerprint(
  track: Pick<TrackMetadata, 'title' | 'artist' | 'album' | 'durationMs'>,
): string {
  return `${trackFingerprint(track)}::${normalizeMetadata(track.album)}`;
}

function levenshtein(left: string, right: string): number {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

export function metadataSimilarity(left: string, right: string): number {
  const a = normalizeMetadata(left);
  const b = normalizeMetadata(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

export function metadataVersionMismatch(left: string, right: string): boolean {
  const a = matchingRecordingVersionTags(left);
  const b = matchingRecordingVersionTags(right);
  return a.size !== b.size || [...a].some((tag) => !b.has(tag));
}

export function trackMatchScore(
  wanted: Pick<TrackMetadata, 'title' | 'artist' | 'album' | 'durationMs'>,
  candidate: { trackName: string; artistName: string; albumName?: string; duration: number },
): number {
  const signals = [{ score: metadataSimilarity(wanted.title, candidate.trackName), weight: 0.48 }];

  if (normalizeMetadata(wanted.artist)) {
    signals.push({ score: metadataSimilarity(wanted.artist, candidate.artistName), weight: 0.3 });
  }
  if (wanted.durationMs > 0 && candidate.duration > 0) {
    const difference = Math.abs(wanted.durationMs / 1_000 - candidate.duration);
    signals.push({ score: Math.max(0, 1 - difference / 12), weight: 0.17 });
  }
  if (normalizeMetadata(wanted.album) && candidate.albumName) {
    signals.push({ score: metadataSimilarity(wanted.album, candidate.albumName), weight: 0.05 });
  }

  const totalWeight = signals.reduce((total, signal) => total + signal.weight, 0);
  return signals.reduce((total, signal) => total + signal.score * signal.weight, 0) / totalWeight;
}
