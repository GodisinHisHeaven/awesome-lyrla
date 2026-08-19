import type { LyricLine } from './contracts.js';

const TIME_TAG = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
const ENHANCED_TIME_TAG =
  /<(?:\d{1,3}:[0-5]\d\.\d{1,3}|\d{1,3}:[0-5]\d:[0-5]\d\.\d{1,3})>/g;
const OFFSET_TAG = /^\[offset:([+-]?\d+)\]$/i;
const METADATA_TAG = /^\[(ar|al|ti|au|by|re|ve|length):/i;

export interface ParsedLrc {
  lines: LyricLine[];
  embeddedOffsetMs: number;
}

function fractionToMilliseconds(fraction: string | undefined): number {
  if (!fraction) return 0;
  if (fraction.length === 1) return Number(fraction) * 100;
  if (fraction.length === 2) return Number(fraction) * 10;
  return Number(fraction.slice(0, 3));
}

export function parseLrc(input: string): ParsedLrc {
  const parsed: Array<Omit<LyricLine, 'id'>> = [];
  let embeddedOffsetMs = 0;

  for (const rawLine of input.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const offsetMatch = line.match(OFFSET_TAG);
    if (offsetMatch) {
      embeddedOffsetMs = Number(offsetMatch[1]);
      continue;
    }
    if (METADATA_TAG.test(line)) continue;

    const tags = [...line.matchAll(TIME_TAG)];
    if (tags.length === 0) continue;

    const text = line
      .replace(TIME_TAG, '')
      .replace(ENHANCED_TIME_TAG, '')
      .trim();
    for (const tag of tags) {
      const minutes = Number(tag[1]);
      const seconds = Number(tag[2]);
      const milliseconds = fractionToMilliseconds(tag[3]);
      parsed.push({
        startMs: minutes * 60_000 + seconds * 1_000 + milliseconds,
        text: text || '♪',
      });
    }
  }

  const sorted = parsed
    .map((line) => ({ ...line, startMs: Math.max(0, line.startMs - embeddedOffsetMs) }))
    .sort((a, b) => a.startMs - b.startMs);

  return {
    embeddedOffsetMs,
    lines: sorted.map((line, index) => ({
      ...line,
      id: `${line.startMs}-${index}`,
    })),
  };
}

export function activeLyricIndex(
  lines: LyricLine[],
  elapsedMs: number,
  manualOffsetMs = 0,
): number {
  if (lines.length === 0) return -1;
  const target = Math.max(0, elapsedMs + manualOffsetMs);
  let low = 0;
  let high = lines.length - 1;
  let result = -1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (lines[middle].startMs <= target) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return result;
}

export function plainLyricsToLines(input: string): LyricLine[] {
  return input
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text, index) => ({ id: `plain-${index}`, startMs: 0, text }));
}
