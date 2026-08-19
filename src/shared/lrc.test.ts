import { activeLyricIndex, parseLrc, plainLyricsToLines } from './lrc.js';

describe('parseLrc', () => {
  it('parses multiple timestamps, fractions, metadata and embedded offsets', () => {
    const result = parseLrc(`
[ar:Awesome Lyrla Demo Artist]
[offset:250]
[00:01.5]First line
[00:03.25][00:05.250]Repeated line
`);

    expect(result.embeddedOffsetMs).toBe(250);
    expect(result.lines.map((line) => [line.startMs, line.text])).toEqual([
      [1_250, 'First line'],
      [3_000, 'Repeated line'],
      [5_000, 'Repeated line'],
    ]);
  });

  it('strips enhanced per-word timestamps without changing line timing', () => {
    const result = parseLrc([
      '[00:01.25]<00:01.25>First <00:01.750>line',
      '[02:03.004]<001:02:03.004>Long song',
    ].join('\n'));

    expect(result.lines.map((line) => [line.startMs, line.text])).toEqual([
      [1_250, 'First line'],
      [123_004, 'Long song'],
    ]);
  });

  it('handles a Qing Hua Ci-sized enhanced LRC payload', () => {
    const taggedWords = Array.from(
      { length: 543 },
      (_, index) => `<${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.00>字`,
    ).join('');

    const result = parseLrc(`[00:00.00]${taggedWords}`);

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]?.text).toBe('字'.repeat(543));
    expect(result.lines[0]?.text).not.toContain('<');
  });

  it('preserves ordinary and malformed angle-bracket text', () => {
    const text = [
      '<verse>',
      '<3',
      '<script>alert(1)</script>',
      '<00:01>',
      '<00:60.00>',
      '<00:01.1234>',
      '<0000:01.00>',
      '<00:00:60.000>',
      '< 00:01.00>',
      '<00:01.00 extra>',
    ].join(' ');

    expect(parseLrc(`[00:01.00]${text}`).lines[0]?.text).toBe(text);
  });

  it('finds the active line with a manual timing correction', () => {
    const lines = parseLrc('[00:01.00]One\n[00:02.00]Two\n[00:03.00]Three').lines;
    expect(activeLyricIndex(lines, 1_900)).toBe(0);
    expect(activeLyricIndex(lines, 1_900, 200)).toBe(1);
    expect(activeLyricIndex(lines, 500)).toBe(-1);
  });

  it('creates display-only lines for plain lyrics', () => {
    expect(plainLyricsToLines(' one \n\n two ')).toHaveLength(2);
  });
});
