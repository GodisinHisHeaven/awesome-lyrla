import { analyzeLyricText } from './lyric-script.js';

describe('analyzeLyricText', () => {
  it.each([
    ['夜空中最亮的星', 'cjk'],
    ['“后来，我们终于明白。”', 'cjk'],
    ['Streetlights draw a silver line', 'latin'],
    ['I still 想你 every night', 'mixed'],
    ['2026 ♫', 'neutral'],
    ['', 'neutral'],
  ] as const)('classifies %j as %s', (text, expected) => {
    expect(analyzeLyricText(text).script).toBe(expected);
  });

  it('preserves mixed text while separating Latin and Chinese glyph runs', () => {
    const analysis = analyzeLyricText('I still 想你 every night');

    expect(analysis.runs).toEqual([
      { script: 'latin', text: 'I still ' },
      { script: 'cjk', text: '想你 ', language: 'zh-Hans' },
      { script: 'latin', text: 'every night' },
    ]);
    expect(analysis.runs.map((run) => run.text).join('')).toBe('I still 想你 every night');
  });

  it('keeps Chinese punctuation with the CJK font around a Latin run', () => {
    const analysis = analyzeLyricText('“你好，world。”');

    expect(analysis.runs).toEqual([
      { script: 'cjk', text: '“你好，', language: 'zh-Hans' },
      { script: 'latin', text: 'world' },
      { script: 'cjk', text: '。”', language: 'zh-Hans' },
    ]);
  });

  it('marks kana and hangul runs with their semantic languages', () => {
    expect(analyzeLyricText('星が降る').runs).toEqual([
      { script: 'cjk', text: '星が降る', language: 'ja' },
    ]);
    expect(analyzeLyricText('별이 내려').runs).toEqual([
      { script: 'cjk', text: '별이 내려', language: 'ko' },
    ]);
  });

  it('uses one language across every CJK run in a mixed Japanese line', () => {
    expect(analyzeLyricText('東京 Love の夜').runs).toEqual([
      { script: 'cjk', text: '東京 ', language: 'ja' },
      { script: 'latin', text: 'Love ' },
      { script: 'cjk', text: 'の夜', language: 'ja' },
    ]);
  });
});
