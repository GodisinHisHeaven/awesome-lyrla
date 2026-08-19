import {
  APPLE_TTML_MAX_BYTES,
  convertAppleTtmlToLyrics,
  convertAppleTtmlToLyricsV3,
  type AppleTtmlDiagnosticCode,
} from './apple-lyrics-ttml.js';

const TTML_NAMESPACE = 'http://www.w3.org/ns/ttml';
const APPLE_NAMESPACE = 'http://music.apple.com/lyric-ttml-internal';
const METADATA_NAMESPACE = 'http://www.w3.org/ns/ttml#metadata';
const PARAMETER_NAMESPACE = 'http://www.w3.org/ns/ttml#parameter';

function document(
  body: string,
  timing: string | null = 'Line',
  head = '',
): string {
  const timingAttribute = timing === null ? '' : ` apple:timing="${timing}"`;
  return [
    `<tt xmlns="${TTML_NAMESPACE}"`,
    ` xmlns:apple="${APPLE_NAMESPACE}"`,
    ` xmlns:ttm="${METADATA_NAMESPACE}"${timingAttribute}>`,
    head,
    `<body><div>${body}</div></body>`,
    '</tt>',
  ].join('');
}

function diagnosticCodes(result: ReturnType<typeof convertAppleTtmlToLyrics>): AppleTtmlDiagnosticCode[] {
  return result.diagnostics.map((entry) => entry.code);
}

describe('convertAppleTtmlToLyrics', () => {
  it('maps each paragraph to one deterministic line without losing millisecond precision', () => {
    const result = convertAppleTtmlToLyrics(document(`
      <p begin="00:01.2345"><span>First</span> <span>line</span></p>
      <p begin="2.5004s"><span>Second</span><span> line</span></p>
      <p begin="3450ms"><![CDATA[Third & final]]></p>
    `));

    expect(result).toEqual({
      kind: 'synced',
      lines: [
        { id: 'apple-1235-0', startMs: 1_235, text: 'First line' },
        { id: 'apple-2500-1', startMs: 2_500, text: 'Second line' },
        { id: 'apple-3450-2', startMs: 3_450, text: 'Third & final' },
      ],
      plainText: 'First line\nSecond line\nThird & final',
      sourceTimingMode: 'line',
      diagnostics: [],
    });
  });

  it('accepts namespace aliases by URI rather than requiring an itunes prefix', () => {
    const result = convertAppleTtmlToLyrics(`
      <tt:tt xmlns:tt="${TTML_NAMESPACE}"
             xmlns:renamed="${APPLE_NAMESPACE}"
             renamed:timing="Line">
        <tt:body><tt:p begin="00:01.001">Alias works</tt:p></tt:body>
      </tt:tt>
    `);

    expect(result.kind).toBe('synced');
    expect(result.lines).toEqual([
      { id: 'apple-1001-0', startMs: 1_001, text: 'Alias works' },
    ]);
  });

  it('parses full clock times and rounds only sub-millisecond precision', () => {
    const result = convertAppleTtmlToLyrics(document(`
      <p begin="01:02:03.0044">Hour clock</p>
      <p begin="3723004.5ms">Fractional milliseconds</p>
    `));

    expect(result.kind).toBe('synced');
    expect(result.lines).toEqual([
      { id: 'apple-3723004-0', startMs: 3_723_004, text: 'Hour clock' },
      {
        id: 'apple-3723005-1',
        startMs: 3_723_005,
        text: 'Fractional milliseconds',
      },
    ]);
  });

  it('treats strict non-negative bare decimal offsets as seconds', () => {
    const result = convertAppleTtmlToLyrics(document(`
      <p begin="1" end="1.5">Whole second</p>
      <p begin="1.2345">Rounded decimal</p>
      <p begin="0">Zero</p>
    `));

    expect(result.kind).toBe('synced');
    expect(result.lines).toEqual([
      { id: 'apple-0-0', startMs: 0, text: 'Zero' },
      { id: 'apple-1000-1', startMs: 1_000, text: 'Whole second' },
      { id: 'apple-1235-2', startMs: 1_235, text: 'Rounded decimal' },
    ]);
  });

  it.each([
    ['.5', 'missing integer part'],
    ['1.', 'missing fractional part'],
    ['-1', 'negative value'],
    ['+1', 'explicit sign'],
    ['1e3', 'exponent notation'],
    ['12f', 'frame offset'],
    ['25t', 'tick offset'],
  ])('rejects unsupported bare offset %s (%s)', (begin) => {
    const result = convertAppleTtmlToLyrics(document(`
      <p begin="1">Valid line</p>
      <p begin="${begin}">Invalid line</p>
    `));

    expect(result.kind).toBe('plain');
    expect(result.lines).toEqual([]);
    expect(result.plainText).toBe('Valid line\nInvalid line');
    expect(diagnosticCodes(result)).toContain('invalid-line-timing');
  });

  it('does not interpret bare offsets as seconds under an SMPTE time base', () => {
    const result = convertAppleTtmlToLyrics(`
      <tt xmlns="${TTML_NAMESPACE}"
          xmlns:apple="${APPLE_NAMESPACE}"
          xmlns:ttp="${PARAMETER_NAMESPACE}"
          apple:timing="Line"
          ttp:timeBase="smpte">
        <body><div>
          <p begin="1">Ambiguous bare offset</p>
          <p begin="2s">Explicit seconds</p>
        </div></body>
      </tt>
    `);

    expect(result.kind).toBe('plain');
    expect(result.lines).toEqual([]);
    expect(result.plainText).toBe('Ambiguous bare offset\nExplicit seconds');
    expect(diagnosticCodes(result)).toContain('invalid-line-timing');
  });

  it('recovers a missing paragraph start from the earliest valid word span', () => {
    const result = convertAppleTtmlToLyrics(document(`
      <p end="3s">
        <span begin="2s" end="2.5s">later</span>
        <span begin="1.125s" end="1.5s"> first</span>
      </p>
    `, 'Word'));

    expect(result.kind).toBe('synced');
    expect(result.lines).toEqual([
      { id: 'apple-1125-0', startMs: 1_125, text: 'later first' },
    ]);
    expect(diagnosticCodes(result)).toContain('span-time-promoted');
  });

  it('does not turn word spans into separate lyric rows', () => {
    const result = convertAppleTtmlToLyrics(document(`
      <p begin="1s" end="3s">
        <span begin="1s" end="1.5s">One</span>
        <span begin="1.5s" end="2s"> paragraph</span>
      </p>
    `, 'Word'));

    expect(result.kind).toBe('synced');
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatchObject({
      startMs: 1_000,
      text: 'One paragraph',
    });
  });

  it('keeps a valid paragraph synchronized when only optional word timing is malformed', () => {
    const result = convertAppleTtmlToLyrics(document(`
      <p begin="1s" end="3s">
        <span begin="2s" end="1s">Still</span> usable
      </p>
    `, 'Word'));

    expect(result.kind).toBe('synced');
    expect(result.lines[0]?.text).toBe('Still usable');
    expect(diagnosticCodes(result)).toContain('invalid-span-timing');
  });

  it('downgrades the whole document to plain when any visible paragraph lacks timing', () => {
    const result = convertAppleTtmlToLyrics(document(`
      <p begin="1s">Timed line</p>
      <p>Untimed line</p>
      <p begin="3s">Another timed line</p>
    `));

    expect(result.kind).toBe('plain');
    expect(result.lines).toEqual([]);
    expect(result.plainText).toBe('Timed line\nUntimed line\nAnother timed line');
    expect(diagnosticCodes(result)).toContain('missing-line-timing');
  });

  it('does not hide an invalid explicit paragraph time behind a valid span time', () => {
    const result = convertAppleTtmlToLyrics(document(`
      <p begin="not-a-time">
        <span begin="1s">Static only</span>
      </p>
    `, 'Word'));

    expect(result.kind).toBe('plain');
    expect(result.plainText).toBe('Static only');
    expect(diagnosticCodes(result)).toContain('invalid-line-timing');
    expect(diagnosticCodes(result)).not.toContain('span-time-promoted');
  });

  it.each([
    ['-1s', 'negative offsets'],
    ['00:00:60.000', 'out-of-range clock seconds'],
    ['00:01:02:15', 'frame times'],
    ['12f', 'frame offsets'],
    ['25t', 'tick offsets'],
  ])('downgrades unsupported %s (%s) to plain text', (begin) => {
    const result = convertAppleTtmlToLyrics(document(`<p begin="${begin}">Static</p>`));

    expect(result.kind).toBe('plain');
    expect(result.plainText).toBe('Static');
    expect(diagnosticCodes(result)).toContain('invalid-line-timing');
  });

  it('requires an end time to be later than the resolved start', () => {
    const result = convertAppleTtmlToLyrics(document(`
      <p begin="2s" end="2s">No positive interval</p>
    `));

    expect(result.kind).toBe('plain');
    expect(diagnosticCodes(result)).toContain('invalid-line-end');
  });

  it('returns static lyrics for None, missing, and unsupported timing modes', () => {
    const none = convertAppleTtmlToLyrics(document('<p>None</p>', 'None'));
    const missing = convertAppleTtmlToLyrics(document('<p begin="1s">Missing</p>', null));
    const unsupported = convertAppleTtmlToLyrics(
      document('<p begin="1s">Unsupported</p>', 'Syllable'),
    );

    expect(none).toMatchObject({ kind: 'plain', plainText: 'None', lines: [] });
    expect(missing).toMatchObject({ kind: 'plain', plainText: 'Missing', lines: [] });
    expect(unsupported).toMatchObject({
      kind: 'plain',
      plainText: 'Unsupported',
      lines: [],
    });
    expect(diagnosticCodes(missing)).toContain('missing-timing-mode');
    expect(diagnosticCodes(unsupported)).toContain('unsupported-timing-mode');
    expect(diagnosticCodes(none)).not.toContain('missing-line-timing');
    expect(none.sourceTimingMode).toBe('none');
    expect(missing.sourceTimingMode).toBe('missing');
    expect(unsupported.sourceTimingMode).toBe('unsupported');
  });

  it('stably sorts non-monotonic rows and preserves equal-time vocal parts', () => {
    const result = convertAppleTtmlToLyrics(document(`
      <p begin="2s">Later</p>
      <p begin="1s" ttm:agent="lead">Same word</p>
      <p begin="1s" ttm:agent="backing">Same word</p>
      <p begin="1s" ttm:agent="lead">Same word</p>
      <p begin="3s">Later</p>
    `));

    expect(result.kind).toBe('synced');
    expect(result.lines).toEqual([
      { id: 'apple-1000-0', startMs: 1_000, text: 'Same word' },
      { id: 'apple-1000-1', startMs: 1_000, text: 'Same word' },
      { id: 'apple-2000-2', startMs: 2_000, text: 'Later' },
      { id: 'apple-3000-3', startMs: 3_000, text: 'Later' },
    ]);
    expect(diagnosticCodes(result)).toEqual(expect.arrayContaining([
      'non-monotonic-lines',
      'duplicate-line-dropped',
    ]));
  });

  it('normalizes a br inside a paragraph without creating another row', () => {
    const result = convertAppleTtmlToLyrics(document(`
      <p begin="1s">First<br/>continuation</p>
    `));

    expect(result.kind).toBe('synced');
    expect(result.lines).toEqual([
      { id: 'apple-1000-0', startMs: 1_000, text: 'First continuation' },
    ]);
    expect(diagnosticCodes(result)).toContain('line-break-normalized');
  });

  it('ignores translation and transliteration metadata outside the TTML body', () => {
    const head = `
      <head>
        <metadata>
          <apple:iTunesMetadata>
            <apple:translations>
              <apple:text apple:key="line-1">Not body lyrics</apple:text>
            </apple:translations>
            <apple:transliterations>
              <apple:text apple:key="line-1">Not body transliteration</apple:text>
            </apple:transliterations>
          </apple:iTunesMetadata>
        </metadata>
      </head>
    `;
    const result = convertAppleTtmlToLyrics(
      document('<p begin="1s">Body lyric</p>', 'Line', head),
    );

    expect(result.kind).toBe('synced');
    expect(result.plainText).toBe('Body lyric');
    expect(result.lines[0]?.text).toBe('Body lyric');
  });

  it('returns missing for a valid body without displayable lyric text', () => {
    const result = convertAppleTtmlToLyrics(document(`
      <p begin="1s">   </p>
      <p begin="2s"><span> \n </span></p>
    `));

    expect(result).toMatchObject({
      kind: 'missing',
      lines: [],
    });
    expect(diagnosticCodes(result)).toContain('no-lyrics');
  });

  it('rejects a DOCTYPE before any entity content can be trusted', () => {
    const result = convertAppleTtmlToLyrics(`
      <!DOCTYPE tt [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
      <tt xmlns="${TTML_NAMESPACE}" xmlns:apple="${APPLE_NAMESPACE}" apple:timing="Line">
        <body><p begin="1s">&xxe;</p></body>
      </tt>
    `);

    expect(result).toEqual({
      kind: 'invalid',
      lines: [],
      sourceTimingMode: 'unknown',
      diagnostics: [
        expect.objectContaining({
          code: 'doctype-not-allowed',
          severity: 'error',
        }),
      ],
    });
  });

  it('returns only invalid after a parser error, even if a paragraph was read first', () => {
    const result = convertAppleTtmlToLyrics(`
      <tt xmlns="${TTML_NAMESPACE}" xmlns:apple="${APPLE_NAMESPACE}" apple:timing="Line">
        <body>
          <p begin="1s">Do not trust this</p>
          <p begin="2s">Broken</div>
        </body>
      </tt>
    `);

    expect(result.kind).toBe('invalid');
    expect(result.lines).toEqual([]);
    expect(result.plainText).toBeUndefined();
    expect(result.sourceTimingMode).toBe('line');
    expect(diagnosticCodes(result)).toEqual(['malformed-xml']);
  });

  it('rejects non-TTML roots and lookalike namespaces', () => {
    const wrongRoot = convertAppleTtmlToLyrics('<lyrics/>');
    const wrongNamespace = convertAppleTtmlToLyrics(`
      <tt xmlns="https://attacker.example/ttml"
          xmlns:apple="${APPLE_NAMESPACE}"
          apple:timing="Line">
        <body><p begin="1s">Lookalike</p></body>
      </tt>
    `);

    expect(wrongRoot.kind).toBe('invalid');
    expect(diagnosticCodes(wrongRoot)).toEqual(['invalid-root']);
    expect(wrongNamespace.kind).toBe('invalid');
    expect(diagnosticCodes(wrongNamespace)).toEqual(['unsupported-namespace']);
  });

  it('rejects a missing body and multiple body elements', () => {
    const missing = convertAppleTtmlToLyrics(`
      <tt xmlns="${TTML_NAMESPACE}" xmlns:apple="${APPLE_NAMESPACE}" apple:timing="Line"/>
    `);
    const multiple = convertAppleTtmlToLyrics(`
      <tt xmlns="${TTML_NAMESPACE}" xmlns:apple="${APPLE_NAMESPACE}" apple:timing="Line">
        <body/><body/>
      </tt>
    `);

    expect(missing.kind).toBe('invalid');
    expect(diagnosticCodes(missing)).toEqual(['missing-body']);
    expect(multiple.kind).toBe('invalid');
    expect(diagnosticCodes(multiple)).toEqual(['invalid-structure']);
  });

  it('rejects a TTML paragraph outside the body', () => {
    const result = convertAppleTtmlToLyrics(`
      <tt xmlns="${TTML_NAMESPACE}" xmlns:apple="${APPLE_NAMESPACE}" apple:timing="Line">
        <head><p begin="1s">Wrong container</p></head>
        <body/>
      </tt>
    `);

    expect(result.kind).toBe('invalid');
    expect(diagnosticCodes(result)).toEqual(['invalid-structure']);
  });

  it('rejects UTF-8 input larger than 512 KiB before parsing', () => {
    const result = convertAppleTtmlToLyrics('界'.repeat(
      Math.floor(APPLE_TTML_MAX_BYTES / 3) + 1,
    ));

    expect(result.kind).toBe('invalid');
    expect(diagnosticCodes(result)).toEqual(['input-too-large']);
  });

  it('rejects excessive XML nesting and decoded line text', () => {
    const deeplyNested = document(
      `<p begin="1s">${'<span>'.repeat(33)}text${'</span>'.repeat(33)}</p>`,
    );
    const longLine = document(`<p begin="1s">${'界'.repeat(3_000)}</p>`);

    expect(diagnosticCodes(convertAppleTtmlToLyrics(deeplyNested))).toEqual([
      'limit-exceeded',
    ]);
    expect(diagnosticCodes(convertAppleTtmlToLyrics(longLine))).toEqual([
      'limit-exceeded',
    ]);
  });
});

describe('convertAppleTtmlToLyricsV3 timeline validation and repair', () => {
  function lineBody(
    paragraphStarts: readonly number[],
    spanStarts: readonly (number | null)[],
  ): string {
    return paragraphStarts.map((startMs, index) => {
      const spanStart = spanStarts[index];
      const text = `Line ${index + 1}`;
      return spanStart === null
        ? `<p begin="${startMs}ms">${text}</p>`
        : `<p begin="${startMs}ms"><span begin="${spanStart}ms">${text}</span></p>`;
    }).join('');
  }

  it('repairs a duration-overrun paragraph timeline from complete leaf-span evidence', () => {
    const paragraphStarts = Array.from(
      { length: 12 },
      (_, index) => 600_000 + index * 1_000,
    );
    const spanStarts = Array.from(
      { length: 12 },
      (_, index) => 10_000 + index * 10_000,
    );
    const ttml = document(lineBody(paragraphStarts, spanStarts));

    const v2 = convertAppleTtmlToLyrics(ttml);
    expect(v2.kind).toBe('synced');
    expect(v2.lines.at(-1)?.startMs).toBe(611_000);

    const result = convertAppleTtmlToLyricsV3(ttml, {
      durationMs: 180_000,
    });
    expect(result.kind).toBe('synced');
    expect(result.lines.map((line) => line.startMs)).toEqual(spanStarts);
    expect(result.timelineValidation).toEqual({
      version: 'apple-timeline-validation-v1',
      outcome: 'repaired',
      sourceAnomaly: 'timestamp-duration-overrun',
      repairMethod: 'word-span-line-start-v1',
    });
    expect(diagnosticCodes(result)).toContain('timeline-repaired-from-spans');
  });

  it('repairs a collapsed paragraph timeline from a distributed leaf-span timeline', () => {
    const paragraphStarts = Array.from(
      { length: 12 },
      (_, index) => index * 100,
    );
    const spanStarts = Array.from(
      { length: 12 },
      (_, index) => 10_000 + index * 10_000,
    );
    const result = convertAppleTtmlToLyricsV3(
      document(lineBody(paragraphStarts, spanStarts)),
      { durationMs: 180_000 },
    );

    expect(result.kind).toBe('synced');
    expect(result.lines.map((line) => line.startMs)).toEqual(spanStarts);
    expect(result.timelineValidation).toMatchObject({
      outcome: 'repaired',
      sourceAnomaly: 'collapsed-timeline-coverage',
      repairMethod: 'word-span-line-start-v1',
    });
  });

  it('repairs a fully collapsed 11-line timeline from distributed leaf spans', () => {
    const paragraphStarts = Array.from(
      { length: 11 },
      (_, index) => index * 100,
    );
    const spanStarts = Array.from(
      { length: 11 },
      (_, index) => 10_000 + index * 10_000,
    );
    const result = convertAppleTtmlToLyricsV3(
      document(lineBody(paragraphStarts, spanStarts)),
      { durationMs: 180_000 },
    );

    expect(result.kind).toBe('synced');
    expect(result.lines.map((line) => line.startMs)).toEqual(spanStarts);
    expect(result.timelineValidation).toMatchObject({
      outcome: 'repaired',
      sourceAnomaly: 'collapsed-timeline-coverage',
      repairMethod: 'word-span-line-start-v1',
    });
  });

  it('keeps a healthy paragraph timeline unchanged even when spans start later', () => {
    const paragraphStarts = Array.from(
      { length: 12 },
      (_, index) => 10_000 + index * 10_000,
    );
    const spanStarts = paragraphStarts.map((startMs) => startMs + 750);
    const result = convertAppleTtmlToLyricsV3(
      document(lineBody(paragraphStarts, spanStarts)),
      { durationMs: 180_000 },
    );

    expect(result.kind).toBe('synced');
    expect(result.lines.map((line) => line.startMs)).toEqual(paragraphStarts);
    expect(result.timelineValidation).toEqual({
      version: 'apple-timeline-validation-v1',
      outcome: 'valid',
      sourceAnomaly: null,
      repairMethod: null,
    });
    expect(diagnosticCodes(result)).not.toContain('timeline-repaired-from-spans');
  });

  it('keeps lyrics static when duration metadata cannot validate the timeline', () => {
    const paragraphStarts = Array.from(
      { length: 12 },
      (_, index) => 10_000 + index * 10_000,
    );
    const result = convertAppleTtmlToLyricsV3(
      document(lineBody(paragraphStarts, paragraphStarts)),
      { durationMs: 0 },
    );

    expect(result.kind).toBe('plain');
    expect(result.lines).toEqual([]);
    expect(result.plainText).toContain('Line 1');
    expect(result.timelineValidation).toEqual({
      version: 'apple-timeline-validation-v1',
      outcome: 'not-evaluated',
      sourceAnomaly: null,
      repairMethod: null,
    });
  });

  it('downgrades to static when any visible paragraph lacks independent span evidence', () => {
    const paragraphStarts = Array.from(
      { length: 12 },
      (_, index) => 600_000 + index * 1_000,
    );
    const spanStarts: Array<number | null> = Array.from(
      { length: 12 },
      (_, index) => 10_000 + index * 10_000,
    );
    spanStarts[5] = null;
    const result = convertAppleTtmlToLyricsV3(
      document(lineBody(paragraphStarts, spanStarts)),
      { durationMs: 180_000 },
    );

    expect(result.kind).toBe('plain');
    expect(result.lines).toEqual([]);
    expect(result.timelineValidation).toMatchObject({
      outcome: 'rejected',
      sourceAnomaly: 'timestamp-duration-overrun',
      repairMethod: null,
    });
    expect(diagnosticCodes(result)).toContain('timeline-anomaly-unrepairable');
  });

  it('does not treat one timed word as complete evidence for an untimed leaf span', () => {
    const body = Array.from({ length: 12 }, (_, index) => {
      const paragraphStart = 600_000 + index * 1_000;
      const spanStart = 10_000 + index * 10_000;
      return index === 5
        ? `<p begin="${paragraphStart}ms">`
          + `<span begin="${spanStart}ms">Timed</span>`
          + '<span> untimed</span></p>'
        : `<p begin="${paragraphStart}ms">`
          + `<span begin="${spanStart}ms">Line ${index + 1}</span></p>`;
    }).join('');

    const result = convertAppleTtmlToLyricsV3(document(body), {
      durationMs: 180_000,
    });

    expect(result.kind).toBe('plain');
    expect(result.timelineValidation).toMatchObject({
      outcome: 'rejected',
      sourceAnomaly: 'timestamp-duration-overrun',
    });
  });

  it('does not repair visible paragraph text outside timed leaf spans', () => {
    const body = Array.from({ length: 12 }, (_, index) => {
      const paragraphStart = 600_000 + index * 1_000;
      const spanStart = 10_000 + index * 10_000;
      return index === 5
        ? `<p begin="${paragraphStart}ms">Unspanned `
          + `<span begin="${spanStart}ms">timed</span></p>`
        : `<p begin="${paragraphStart}ms">`
          + `<span begin="${spanStart}ms">Line ${index + 1}</span></p>`;
    }).join('');

    const result = convertAppleTtmlToLyricsV3(document(body), {
      durationMs: 180_000,
    });

    expect(result.kind).toBe('plain');
    expect(result.timelineValidation).toMatchObject({
      outcome: 'rejected',
      sourceAnomaly: 'timestamp-duration-overrun',
    });
  });

  it('downgrades to static when the independent span candidate is also anomalous', () => {
    const paragraphStarts = Array.from(
      { length: 12 },
      (_, index) => 600_000 + index * 1_000,
    );
    const collapsedSpanStarts = Array.from(
      { length: 12 },
      (_, index) => index * 100,
    );
    const result = convertAppleTtmlToLyricsV3(
      document(lineBody(paragraphStarts, collapsedSpanStarts)),
      { durationMs: 180_000 },
    );

    expect(result.kind).toBe('plain');
    expect(result.lines).toEqual([]);
    expect(result.timelineValidation).toMatchObject({
      outcome: 'rejected',
      sourceAnomaly: 'timestamp-duration-overrun',
      repairMethod: null,
    });
  });

  it('does not repair when span timing would reorder the v2 lyric text', () => {
    const paragraphStarts = Array.from(
      { length: 12 },
      (_, index) => 600_000 + (11 - index) * 1_000,
    );
    const spanStarts = Array.from(
      { length: 12 },
      (_, index) => 10_000 + index * 10_000,
    );
    const ttml = document(lineBody(paragraphStarts, spanStarts));

    expect(convertAppleTtmlToLyrics(ttml).lines.map((line) => line.text))
      .toEqual(Array.from(
        { length: 12 },
        (_, index) => `Line ${12 - index}`,
      ));

    const result = convertAppleTtmlToLyricsV3(ttml, {
      durationMs: 180_000,
    });
    expect(result.kind).toBe('plain');
    expect(result.timelineValidation).toMatchObject({
      outcome: 'rejected',
      sourceAnomaly: 'timestamp-duration-overrun',
      repairMethod: null,
    });
  });

  it('fails closed for non-media TTML time bases without changing v2 semantics', () => {
    const ttml = `
      <tt xmlns="${TTML_NAMESPACE}"
          xmlns:apple="${APPLE_NAMESPACE}"
          xmlns:ttp="${PARAMETER_NAMESPACE}"
          apple:timing="Line"
          ttp:timeBase="clock">
        <body><div><p begin="00:00:01.000">Clock-based line</p></div></body>
      </tt>
    `;

    expect(convertAppleTtmlToLyrics(ttml).kind).toBe('synced');
    const result = convertAppleTtmlToLyricsV3(ttml, {
      durationMs: 180_000,
    });
    expect(result.kind).toBe('plain');
    expect(result.lines).toEqual([]);
    expect(result.timelineValidation).toMatchObject({
      outcome: 'rejected',
      sourceAnomaly: 'unsupported-time-base',
    });
    expect(diagnosticCodes(result)).toContain('unsupported-time-base');
  });

  it('does not treat an explicitly empty time base as the default media base', () => {
    const ttml = `
      <tt xmlns="${TTML_NAMESPACE}"
          xmlns:apple="${APPLE_NAMESPACE}"
          xmlns:ttp="${PARAMETER_NAMESPACE}"
          apple:timing="Line"
          ttp:timeBase="">
        <body><div><p begin="1s">Ambiguous time base</p></div></body>
      </tt>
    `;

    const result = convertAppleTtmlToLyricsV3(ttml, {
      durationMs: 180_000,
    });
    expect(result.kind).toBe('plain');
    expect(result.timelineValidation).toMatchObject({
      outcome: 'rejected',
      sourceAnomaly: 'unsupported-time-base',
    });
  });
});
