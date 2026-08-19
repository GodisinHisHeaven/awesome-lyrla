import type { LyricsPayload } from '../shared/contracts.js';
import {
  displayedLyricsText,
  equivalentLyricsAfterScriptNormalization,
  isSafeNativeSimplifiedPayload,
  projectAppleLyricsToSimplified,
} from './lyrics-script-preference.js';

function synced(text: string, starts = [1_000, 5_000, 9_000]): LyricsPayload {
  return {
    kind: 'synced',
    lines: text.split('\n').map((line, index) => ({
      id: `line-${index}`,
      startMs: starts[index] ?? index * 4_000,
      text: line,
    })),
    provider: 'lrclib',
  };
}

describe('native Simplified lyrics preference', () => {
  const traditional = [
    '不要不要假設我知道',
    '一切一切也都是為我而做',
    '為何這麼偉大 如此感覺不到',
  ].join('\n');
  const simplified = [
    '不要不要假设我知道',
    '一切一切也都是为我而做',
    '为何这么伟大 如此感觉不到',
  ].join('\n');

  it('recognizes equivalent native Simplified text without returning a conversion', () => {
    expect(equivalentLyricsAfterScriptNormalization(traditional, simplified)).toBe(true);
    const alternative = synced(simplified);
    expect(isSafeNativeSimplifiedPayload(
      synced(traditional),
      alternative,
      209_000,
    )).toBe(true);
    expect(alternative.lines.map((line) => line.text).join('\n')).toBe(simplified);
  });

  it('accepts a native Simplified variant for a mixed-script incumbent', () => {
    const mixed = '不要不要假設我知道\n一切一切也都是为我而做\n为何这么伟大 如此感觉不到';
    expect(isSafeNativeSimplifiedPayload(
      synced(mixed),
      synced(simplified),
      209_000,
    )).toBe(true);
  });

  it('rejects translations, truncation, and a loss of synchronized timing', () => {
    const incumbent = synced(traditional);
    expect(isSafeNativeSimplifiedPayload(
      incumbent,
      synced('This is a translated lyric\nwith unrelated words\nand different meaning'),
      209_000,
    )).toBe(false);
    expect(isSafeNativeSimplifiedPayload(
      incumbent,
      synced('不要不要假设我知道'),
      209_000,
    )).toBe(false);
    expect(isSafeNativeSimplifiedPayload(incumbent, {
      kind: 'plain',
      lines: simplified.split('\n').map((text, index) => ({
        id: `plain-${index}`,
        startMs: index,
        text,
      })),
      plainText: simplified,
      provider: 'lrclib',
    }, 209_000)).toBe(false);
    expect(isSafeNativeSimplifiedPayload(
      incumbent,
      synced(simplified, [8_000, 12_000, 16_000]),
      209_000,
    )).toBe(false);
  });

  it('does not treat Japanese or Korean text as a Simplified alternative', () => {
    expect(isSafeNativeSimplifiedPayload(
      synced('何時でも夢を見ている'),
      synced('何时でも梦を見ている'),
      209_000,
    )).toBe(false);
    expect(isSafeNativeSimplifiedPayload(
      synced('사랑 後悔'),
      synced('사랑 后悔'),
      209_000,
    )).toBe(false);
  });

  it('rejects a structurally collapsed Simplified timeline', () => {
    const lines = Array.from({ length: 12 }, (_, index) =>
      index % 2 === 0 ? '不要不要假设我知道' : '为何这么伟大如此感觉不到');
    expect(isSafeNativeSimplifiedPayload(
      synced(lines.map((line) =>
        line.replaceAll('假设', '假設').replaceAll('为何', '為何').replaceAll('么', '麼'))
        .join('\n')),
      synced(lines.join('\n'), Array.from({ length: 12 }, (_, index) => index * 100)),
      209_000,
    )).toBe(false);
  });
});

describe('Apple Simplified display projection', () => {
  it('projects Apple plain text even when the row list is empty', () => {
    const payload: LyricsPayload = {
      kind: 'plain',
      lines: [],
      plainText: '單車與後來',
      provider: 'apple',
    };

    expect(displayedLyricsText(payload)).toBe('單車與後來');
    expect(projectAppleLyricsToSimplified(payload)).toMatchObject({
      lines: [],
      plainText: '单车与后来',
      provider: 'apple',
    });
    expect(payload.plainText).toBe('單車與後來');
  });

  it('converts Apple text while preserving timing and provider identity', () => {
    const payload: LyricsPayload = {
      kind: 'synced',
      lines: [
        { id: 'line-1', startMs: 14_000, text: '不要不要假設我知道' },
        { id: 'line-2', startMs: 18_000, text: '為何這麼偉大' },
      ],
      provider: 'apple',
      providerTrackId: '667921841',
      notice: 'source notice',
    };

    expect(projectAppleLyricsToSimplified(payload)).toEqual({
      ...payload,
      lines: [
        { id: 'line-1', startMs: 14_000, text: '不要不要假设我知道' },
        { id: 'line-2', startMs: 18_000, text: '为何这么伟大' },
      ],
    });
    expect(payload.lines[0]?.text).toBe('不要不要假設我知道');
  });

  it('converts both plain representations and leaves other providers untouched', () => {
    const apple: LyricsPayload = {
      kind: 'plain',
      lines: [{ id: 'line-1', startMs: 0, text: '單車與後來' }],
      plainText: '單車與後來',
      provider: 'apple',
    };
    const lrclib: LyricsPayload = { ...apple, provider: 'lrclib' };

    expect(projectAppleLyricsToSimplified(apple)).toMatchObject({
      lines: [{ text: '单车与后来' }],
      plainText: '单车与后来',
      provider: 'apple',
    });
    expect(projectAppleLyricsToSimplified(lrclib)).toBe(lrclib);
  });

  it('does not convert Japanese or Korean Apple lyrics', () => {
    const japanese: LyricsPayload = {
      kind: 'synced',
      lines: [{ id: 'line-1', startMs: 1_000, text: '何時でも夢を見ている' }],
      provider: 'apple',
    };
    const korean: LyricsPayload = {
      kind: 'synced',
      lines: [{ id: 'line-1', startMs: 1_000, text: '사랑 後悔' }],
      provider: 'apple',
    };

    expect(projectAppleLyricsToSimplified(japanese)).toBe(japanese);
    expect(projectAppleLyricsToSimplified(korean)).toBe(korean);
  });
});
