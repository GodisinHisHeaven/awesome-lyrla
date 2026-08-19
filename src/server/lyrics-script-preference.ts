import type { LyricsPayload } from '../shared/contracts.js';
import { appleLyricsTimelineAnomaly } from './apple-lyrics-timeline.js';
import {
  chineseLyricsScript,
  type ChineseLyricsScript,
  normalizeChineseScriptForComparison,
  simplifyChineseDisplayText,
} from './lyrics-metadata-alias.js';

interface ComparableLyrics {
  points: string[];
  trigrams: Map<string, number>;
  trigramTotal: number;
}

interface LyricsPreferenceAnalysis {
  text: string | null;
  script: ChineseLyricsScript;
  presentationRank: number;
  comparable: ComparableLyrics | null;
}

const analysisCache = new WeakMap<LyricsPayload, LyricsPreferenceAnalysis>();

export function displayedLyricsText(payload: LyricsPayload): string | null {
  if (!['synced', 'plain'].includes(payload.kind)) return null;
  const lineText = payload.lines.map((line) => line.text).filter(Boolean).join('\n');
  if (lineText) return lineText;
  const plainText = payload.plainText?.trim();
  return plainText || null;
}

/**
 * Present Apple Chinese lyrics in Simplified script without mutating the
 * persisted revision or retained TTML. Timings, provider identity, notices,
 * and every non-text field remain unchanged. Japanese/Korean and non-Chinese
 * text stay byte-for-byte untouched through chineseLyricsScript's guard.
 */
export function projectAppleLyricsToSimplified(
  payload: LyricsPayload,
): LyricsPayload {
  if (
    payload.provider !== 'apple'
    || !['synced', 'plain'].includes(payload.kind)
  ) return payload;

  const text = displayedLyricsText(payload);
  const script = chineseLyricsScript(text ?? '');
  if (script !== 'traditional' && script !== 'mixed') return payload;

  const lines = payload.lines.map((line) => ({
    ...line,
    text: simplifyChineseDisplayText(line.text),
  }));
  const plainText = payload.plainText === undefined
    ? undefined
    : simplifyChineseDisplayText(payload.plainText);
  const changed = lines.some((line, index) => line.text !== payload.lines[index]?.text)
    || plainText !== payload.plainText;
  if (!changed) return payload;

  return {
    ...payload,
    lines,
    ...(plainText === undefined ? {} : { plainText }),
  };
}

function presentationRank(payload: LyricsPayload): number {
  if (payload.kind === 'synced' && payload.lines.length > 0) return 2;
  if (payload.kind === 'plain' && (payload.lines.length > 0 || payload.plainText?.trim())) return 1;
  return 0;
}

function synchronizedTimelinesAreCompatible(
  incumbent: LyricsPayload,
  alternative: LyricsPayload,
): boolean {
  if (incumbent.kind !== 'synced') return true;
  if (
    alternative.kind !== 'synced'
    || incumbent.lines.length !== alternative.lines.length
    || incumbent.lines.length === 0
  ) return false;
  const differences = incumbent.lines
    .map((line, index) =>
      Math.abs(line.startMs - alternative.lines[index]!.startMs))
    .sort((left, right) => left - right);
  const p90 = differences[Math.max(0, Math.ceil(differences.length * 0.9) - 1)]!;
  return p90 <= 2_000 && differences.at(-1)! <= 5_000;
}

function comparableCodePoints(value: string): string[] {
  return Array.from(
    normalizeChineseScriptForComparison(value)
      .normalize('NFKC')
      .toLocaleLowerCase('und'),
  )
    .filter((point) => /[\p{L}\p{N}]/u.test(point))
    .slice(0, 20_000);
}

function trigramCounts(points: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  if (points.length < 3) {
    if (points.length > 0) counts.set(points.join(''), 1);
    return counts;
  }
  for (let index = 0; index <= points.length - 3; index += 1) {
    const trigram = points.slice(index, index + 3).join('');
    counts.set(trigram, (counts.get(trigram) ?? 0) + 1);
  }
  return counts;
}

function comparableLyrics(value: string): ComparableLyrics {
  const points = comparableCodePoints(value);
  const trigrams = trigramCounts(points);
  let trigramTotal = 0;
  for (const count of trigrams.values()) trigramTotal += count;
  return { points, trigrams, trigramTotal };
}

function equivalentComparableLyrics(
  left: ComparableLyrics,
  right: ComparableLyrics,
): boolean {
  if (left.points.length === 0 || right.points.length === 0) return false;
  const lengthRatio = left.points.length / right.points.length;
  if (lengthRatio < 0.85 || lengthRatio > 1.18) return false;

  let intersection = 0;
  for (const [trigram, count] of left.trigrams) {
    intersection += Math.min(count, right.trigrams.get(trigram) ?? 0);
  }
  return left.trigramTotal + right.trigramTotal > 0
    && (2 * intersection) / (left.trigramTotal + right.trigramTotal) >= 0.92;
}

export function equivalentLyricsAfterScriptNormalization(
  left: string,
  right: string,
): boolean {
  return equivalentComparableLyrics(comparableLyrics(left), comparableLyrics(right));
}

function analyzeLyrics(payload: LyricsPayload): LyricsPreferenceAnalysis {
  const cached = analysisCache.get(payload);
  if (cached) return cached;
  const text = displayedLyricsText(payload);
  const analysis: LyricsPreferenceAnalysis = {
    text,
    script: chineseLyricsScript(text ?? ''),
    presentationRank: presentationRank(payload),
    comparable: text ? comparableLyrics(text) : null,
  };
  analysisCache.set(payload, analysis);
  return analysis;
}

/**
 * Prefer only a native Simplified transcription that preserves the incumbent
 * lyric coverage and presentation quality. The returned payload is always the
 * provider's untouched text; OpenCC is used exclusively for comparison.
 */
export function isSafeNativeSimplifiedPayload(
  incumbent: LyricsPayload,
  alternative: LyricsPayload,
  durationMs: number,
): boolean {
  const incumbentAnalysis = analyzeLyrics(incumbent);
  const alternativeAnalysis = analyzeLyrics(alternative);
  if (
    !incumbentAnalysis.text
    || !alternativeAnalysis.text
    || !incumbentAnalysis.comparable
    || !alternativeAnalysis.comparable
    || alternative.fallbackKind
    || (
      incumbentAnalysis.script !== 'traditional'
      && incumbentAnalysis.script !== 'mixed'
    )
    || alternativeAnalysis.script !== 'simplified'
    || alternativeAnalysis.presentationRank < incumbentAnalysis.presentationRank
    || !synchronizedTimelinesAreCompatible(incumbent, alternative)
  ) return false;

  if (
    alternative.kind === 'synced'
    && appleLyricsTimelineAnomaly(alternative.lines, durationMs)
  ) return false;
  return equivalentComparableLyrics(
    incumbentAnalysis.comparable,
    alternativeAnalysis.comparable,
  );
}
