import { SaxesParser, type SaxesAttributeNS, type SaxesTagNS } from 'saxes';
import type { LyricLine } from '../shared/contracts.js';
import {
  APPLE_TIMELINE_SPAN_REPAIR_METHOD,
  APPLE_TIMELINE_VALIDATION_VERSION,
  appleLyricsTimelineAnomaly,
  isCredibleAppleTimelineDuration,
  type AppleLyricsTimelineAnomaly,
} from './apple-lyrics-timeline.js';

export const APPLE_TTML_MAX_BYTES = 512 * 1_024;

const MAX_XML_DEPTH = 32;
const MAX_PARAGRAPHS = 5_000;
const MAX_SPANS = 50_000;
const MAX_LINE_BYTES = 8 * 1_024;
const MAX_TEXT_BYTES = APPLE_TTML_MAX_BYTES;

const TTML_NAMESPACES = new Set([
  'http://www.w3.org/ns/ttml',
  'http://www.w3.org/2006/10/ttaf1',
]);
const APPLE_TTML_NAMESPACES = new Set([
  'http://itunes.apple.com/lyric-ttml-internal',
  'http://music.apple.com/lyric-ttml-internal',
]);
const TTML_METADATA_NAMESPACES = new Set([
  'http://www.w3.org/ns/ttml#metadata',
  'http://www.w3.org/2006/10/ttaf1#metadata',
]);
const TTML_PARAMETER_NAMESPACES = new Set([
  'http://www.w3.org/ns/ttml#parameter',
  'http://www.w3.org/2006/10/ttaf1#parameter',
]);
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
const EMPTY_NAMESPACE = new Set(['']);

export type AppleTtmlSourceTimingMode =
  | 'line'
  | 'word'
  | 'none'
  | 'missing'
  | 'unsupported'
  | 'unknown';
type ParsedTimingMode = Exclude<AppleTtmlSourceTimingMode, 'unknown'>;

export type AppleTtmlDiagnosticCode =
  | 'doctype-not-allowed'
  | 'duplicate-line-dropped'
  | 'input-too-large'
  | 'invalid-line-end'
  | 'invalid-line-timing'
  | 'invalid-root'
  | 'invalid-span-timing'
  | 'invalid-structure'
  | 'line-break-normalized'
  | 'limit-exceeded'
  | 'malformed-xml'
  | 'missing-body'
  | 'missing-line-timing'
  | 'missing-timing-mode'
  | 'no-lyrics'
  | 'non-monotonic-lines'
  | 'span-time-promoted'
  | 'timeline-anomaly-unrepairable'
  | 'timeline-repaired-from-spans'
  | 'unsupported-namespace'
  | 'unsupported-time-base'
  | 'unsupported-timing-mode';

export interface AppleTtmlDiagnostic {
  code: AppleTtmlDiagnosticCode;
  severity: 'info' | 'warning' | 'error';
  message: string;
  sourceIndex?: number;
  line?: number;
  column?: number;
  value?: string;
}

export interface AppleTtmlConversionResult {
  kind: 'synced' | 'plain' | 'missing' | 'invalid';
  lines: LyricLine[];
  plainText?: string;
  sourceTimingMode: AppleTtmlSourceTimingMode;
  diagnostics: AppleTtmlDiagnostic[];
  timelineValidation?: AppleTtmlTimelineValidation;
}

export interface AppleTtmlTimelineValidation {
  version: typeof APPLE_TIMELINE_VALIDATION_VERSION;
  outcome:
    | 'valid'
    | 'repaired'
    | 'rejected'
    | 'not-evaluated'
    | 'not-applicable';
  sourceAnomaly:
    | AppleLyricsTimelineAnomaly
    | 'unsupported-time-base'
    | null;
  repairMethod: typeof APPLE_TIMELINE_SPAN_REPAIR_METHOD | null;
}

interface SourcePosition {
  line: number;
  column: number;
}

interface SpanTiming {
  beginMs?: number;
  valid: boolean;
  hasChildSpan: boolean;
  hasVisibleText: boolean;
}

interface ParagraphContext {
  sourceIndex: number;
  depth: number;
  position: SourcePosition;
  textParts: string[];
  beginPresent: boolean;
  beginRaw?: string;
  endPresent: boolean;
  endRaw?: string;
  semanticKey: string;
  spanTimings: SpanTiming[];
  hasUnspannedVisibleText: boolean;
  normalizedBreak: boolean;
}

interface ParsedParagraph {
  sourceIndex: number;
  position: SourcePosition;
  text: string;
  semanticKey: string;
  startMs?: number;
  repairStartMs?: number;
  timingValid: boolean;
}

interface ElementFrame {
  local: string;
  uri: string;
  suppressesParagraphText: boolean;
  spanTimingIndex?: number;
}

type AppleTtmlConversionOptions =
  | { projection: 'v2' }
  | { projection: 'v3'; durationMs: number };

class TtmlParseFailure extends Error {
  constructor(
    readonly diagnostic: AppleTtmlDiagnostic,
  ) {
    super(diagnostic.message);
  }
}

function diagnostic(
  code: AppleTtmlDiagnosticCode,
  severity: AppleTtmlDiagnostic['severity'],
  message: string,
  details: Partial<Omit<AppleTtmlDiagnostic, 'code' | 'severity' | 'message'>> = {},
): AppleTtmlDiagnostic {
  return { code, severity, message, ...details };
}

function clippedValue(value: string): string {
  return value.length <= 80 ? value : `${value.slice(0, 77)}...`;
}

function invalidResult(
  entry: AppleTtmlDiagnostic,
  sourceTimingMode: AppleTtmlSourceTimingMode = 'unknown',
): AppleTtmlConversionResult {
  return {
    kind: 'invalid',
    lines: [],
    sourceTimingMode,
    diagnostics: [entry],
  };
}

function findAttribute(
  tag: SaxesTagNS,
  local: string,
  acceptedUris: ReadonlySet<string>,
): SaxesAttributeNS | undefined {
  return Object.values(tag.attributes).find(
    (attribute) => attribute.local === local && acceptedUris.has(attribute.uri),
  );
}

function findUnqualifiedAttribute(
  tag: SaxesTagNS,
  local: string,
): SaxesAttributeNS | undefined {
  return findAttribute(tag, local, EMPTY_NAMESPACE);
}

function decimalToRoundedMilliseconds(
  whole: string,
  fraction: string | undefined,
  unitMilliseconds: bigint,
): bigint | null {
  // More than 16 whole digits cannot fit in the application's safe millisecond
  // range. Reject before constructing a needlessly large BigInt.
  if (whole.length > 16) return null;

  const wholeValue = BigInt(whole);
  let result = wholeValue * unitMilliseconds;
  if (!fraction) return result;

  if (unitMilliseconds === 1_000n) {
    const milliseconds = fraction.slice(0, 3).padEnd(3, '0');
    result += BigInt(milliseconds);
    if (fraction.length > 3 && fraction[3] >= '5') result += 1n;
  } else if (fraction[0] >= '5') {
    result += 1n;
  }
  return result;
}

function safeMilliseconds(value: bigint | null): number | undefined {
  if (value === null || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return undefined;
  }
  return Number(value);
}

function parseTimeExpression(
  raw: string,
  allowBareSeconds: boolean,
): number | undefined {
  const value = raw.trim();

  const clock = /^(\d+):([0-5]\d):([0-5]\d)(?:\.(\d+))?$/.exec(value);
  if (clock) {
    const [, hours, minutes, seconds, fraction] = clock;
    if (hours.length > 16) return undefined;
    const wholeSeconds =
      BigInt(hours) * 3_600n + BigInt(minutes) * 60n + BigInt(seconds);
    const fractionMs = decimalToRoundedMilliseconds('0', fraction, 1_000n);
    return safeMilliseconds(
      fractionMs === null ? null : wholeSeconds * 1_000n + fractionMs,
    );
  }

  const shortClock = /^([0-5]?\d):([0-5]\d)(?:\.(\d+))?$/.exec(value);
  if (shortClock) {
    const [, minutes, seconds, fraction] = shortClock;
    const wholeSeconds = BigInt(minutes) * 60n + BigInt(seconds);
    const fractionMs = decimalToRoundedMilliseconds('0', fraction, 1_000n);
    return safeMilliseconds(
      fractionMs === null ? null : wholeSeconds * 1_000n + fractionMs,
    );
  }

  const milliseconds = /^(\d+)(?:\.(\d+))?ms$/.exec(value);
  if (milliseconds) {
    return safeMilliseconds(
      decimalToRoundedMilliseconds(milliseconds[1], milliseconds[2], 1n),
    );
  }

  const seconds = /^(\d+)(?:\.(\d+))?s$/.exec(value);
  if (seconds) {
    return safeMilliseconds(
      decimalToRoundedMilliseconds(seconds[1], seconds[2], 1_000n),
    );
  }

  // Apple also emits offset times without a unit. Treat only a complete,
  // non-negative decimal token as seconds; do not broaden this to exponent,
  // sign, frame, tick, or incomplete-decimal syntax.
  if (allowBareSeconds) {
    const bareSeconds = /^(\d+)(?:\.(\d+))?$/.exec(value);
    if (bareSeconds) {
      return safeMilliseconds(
        decimalToRoundedMilliseconds(bareSeconds[1], bareSeconds[2], 1_000n),
      );
    }
  }

  return undefined;
}

function rootAllowsBareSeconds(tag: SaxesTagNS): boolean {
  const timeBase = findAttribute(tag, 'timeBase', TTML_PARAMETER_NAMESPACES);
  // Unitless offsets are an observed Apple extension. Under SMPTE, keeping
  // them static is safer than guessing whether the number denotes seconds or
  // frame-related time.
  return timeBase?.value.trim().toLowerCase() !== 'smpte';
}

function rootTimeBase(tag: SaxesTagNS): string {
  const timeBase = findAttribute(tag, 'timeBase', TTML_PARAMETER_NAMESPACES);
  return timeBase ? timeBase.value.trim().toLowerCase() : 'media';
}

function normalizedText(parts: string[]): string {
  return parts
    .join('')
    .replace(/[\t\n\r ]+/g, ' ')
    .trim()
    .normalize('NFC');
}

function semanticKey(tag: SaxesTagNS): string {
  const values = Object.values(tag.attributes)
    .filter((attribute) => (
      (attribute.local === 'agent' && TTML_METADATA_NAMESPACES.has(attribute.uri))
      || (attribute.local === 'role' && (
        TTML_METADATA_NAMESPACES.has(attribute.uri)
        || APPLE_TTML_NAMESPACES.has(attribute.uri)
      ))
      || (attribute.local === 'lang' && attribute.uri === XML_NAMESPACE)
    ))
    .map((attribute) => `${attribute.uri}:${attribute.local}=${attribute.value}`)
    .sort();
  return values.join('|');
}

function timingModeFromRoot(
  tag: SaxesTagNS,
  diagnostics: AppleTtmlDiagnostic[],
  position: SourcePosition,
): ParsedTimingMode {
  const timing = findAttribute(tag, 'timing', APPLE_TTML_NAMESPACES);
  if (!timing) {
    diagnostics.push(diagnostic(
      'missing-timing-mode',
      'warning',
      'The Apple TTML timing mode is missing; lyrics will remain static.',
      position,
    ));
    return 'missing';
  }

  switch (timing.value.trim().toLowerCase()) {
    case 'line':
      return 'line';
    case 'word':
      return 'word';
    case 'none':
      return 'none';
    default:
      diagnostics.push(diagnostic(
        'unsupported-timing-mode',
        'warning',
        'The Apple TTML timing mode is not supported; lyrics will remain static.',
        { ...position, value: clippedValue(timing.value) },
      ));
      return 'unsupported';
  }
}

function parseSpanTiming(
  tag: SaxesTagNS,
  paragraph: ParagraphContext,
  diagnostics: AppleTtmlDiagnostic[],
  position: SourcePosition,
  allowBareSeconds: boolean,
): number {
  const begin = findUnqualifiedAttribute(tag, 'begin');
  const beginMs = begin
    ? parseTimeExpression(begin.value, allowBareSeconds)
    : undefined;
  const end = findUnqualifiedAttribute(tag, 'end');
  const endMs = end
    ? parseTimeExpression(end.value, allowBareSeconds)
    : undefined;
  const valid = Boolean(begin)
    && beginMs !== undefined
    && (!end || (endMs !== undefined && endMs > beginMs));

  paragraph.spanTimings.push({
    beginMs,
    valid,
    hasChildSpan: false,
    hasVisibleText: false,
  });
  const spanTimingIndex = paragraph.spanTimings.length - 1;

  if (begin && !valid) {
    diagnostics.push(diagnostic(
      'invalid-span-timing',
      'warning',
      'A word span has invalid timing and cannot supply the line start.',
      {
        ...position,
        sourceIndex: paragraph.sourceIndex,
        value: clippedValue(end ? `${begin.value}–${end.value}` : begin.value),
      },
    ));
  }
  return spanTimingIndex;
}

function finalizeParagraph(
  paragraph: ParagraphContext,
  diagnostics: AppleTtmlDiagnostic[],
  validateTiming: boolean,
  allowBareSeconds: boolean,
): ParsedParagraph | null {
  const text = normalizedText(paragraph.textParts);
  if (!text) return null;

  if (Buffer.byteLength(text, 'utf8') > MAX_LINE_BYTES) {
    throw new TtmlParseFailure(diagnostic(
      'limit-exceeded',
      'error',
      `A TTML paragraph exceeds the ${MAX_LINE_BYTES}-byte text limit.`,
      { ...paragraph.position, sourceIndex: paragraph.sourceIndex },
    ));
  }

  if (!validateTiming) {
    return {
      sourceIndex: paragraph.sourceIndex,
      position: paragraph.position,
      text,
      semanticKey: paragraph.semanticKey,
      timingValid: false,
    };
  }

  let startMs: number | undefined;
  let timingValid = true;
  const validSpanStarts = paragraph.spanTimings
    .filter((span) => span.valid && span.beginMs !== undefined)
    .map((span) => span.beginMs as number);
  const visibleSpanTimings = paragraph.spanTimings.filter(
    (span) => span.hasVisibleText,
  );
  const repairStartMs = !paragraph.hasUnspannedVisibleText
    && visibleSpanTimings.length > 0
    && visibleSpanTimings.every(
      (span) => (
        !span.hasChildSpan
        && span.valid
        && span.beginMs !== undefined
      ),
    )
    ? Math.min(...visibleSpanTimings.map((span) => span.beginMs as number))
    : undefined;

  if (paragraph.beginPresent) {
    startMs = parseTimeExpression(
      paragraph.beginRaw!,
      allowBareSeconds,
    );
    if (startMs === undefined) {
      timingValid = false;
      diagnostics.push(diagnostic(
        'invalid-line-timing',
        'warning',
        'A lyric line has an invalid begin time.',
        {
          ...paragraph.position,
          sourceIndex: paragraph.sourceIndex,
          value: clippedValue(paragraph.beginRaw!),
        },
      ));
    }
  } else {
    const earliestSpanStart = validSpanStarts.length > 0
      ? Math.min(...validSpanStarts)
      : undefined;
    if (earliestSpanStart !== undefined) {
      startMs = earliestSpanStart;
      diagnostics.push(diagnostic(
        'span-time-promoted',
        'info',
        'The line start was recovered from its earliest valid word span.',
        { ...paragraph.position, sourceIndex: paragraph.sourceIndex },
      ));
    } else {
      timingValid = false;
      diagnostics.push(diagnostic(
        'missing-line-timing',
        'warning',
        'A lyric line has no usable begin time.',
        { ...paragraph.position, sourceIndex: paragraph.sourceIndex },
      ));
    }
  }

  if (paragraph.endPresent) {
    const endMs = parseTimeExpression(
      paragraph.endRaw!,
      allowBareSeconds,
    );
    if (endMs === undefined || startMs === undefined || endMs <= startMs) {
      timingValid = false;
      diagnostics.push(diagnostic(
        'invalid-line-end',
        'warning',
        'A lyric line has an invalid end time.',
        {
          ...paragraph.position,
          sourceIndex: paragraph.sourceIndex,
          value: clippedValue(paragraph.endRaw!),
        },
      ));
    }
  }

  return {
    sourceIndex: paragraph.sourceIndex,
    position: paragraph.position,
    text,
    semanticKey: paragraph.semanticKey,
    startMs,
    repairStartMs,
    timingValid,
  };
}

/**
 * Converts an Apple lyric TTML document into the application's row-level
 * lyric model. A valid but partially timed document deliberately becomes
 * `plain`, so the player never auto-scrolls a subset of the visible lyrics.
 */
export function convertAppleTtmlToLyrics(ttml: string): AppleTtmlConversionResult {
  return convertAppleTtmlToLyricsInternal(ttml, { projection: 'v2' });
}

export function convertAppleTtmlToLyricsV3(
  ttml: string,
  options: { durationMs: number },
): AppleTtmlConversionResult {
  return convertAppleTtmlToLyricsInternal(ttml, {
    projection: 'v3',
    durationMs: options.durationMs,
  });
}

function convertAppleTtmlToLyricsInternal(
  ttml: string,
  options: AppleTtmlConversionOptions,
): AppleTtmlConversionResult {
  const inputBytes = Buffer.byteLength(ttml, 'utf8');
  if (inputBytes > APPLE_TTML_MAX_BYTES) {
    return invalidResult(diagnostic(
      'input-too-large',
      'error',
      `Apple TTML exceeds the ${APPLE_TTML_MAX_BYTES}-byte input limit.`,
    ));
  }

  const diagnostics: AppleTtmlDiagnostic[] = [];
  const paragraphs: ParsedParagraph[] = [];
  const stack: ElementFrame[] = [];
  let activeParagraph: ParagraphContext | undefined;
  let suppressedTextDepth = 0;
  let rootSeen = false;
  let rootNamespace = '';
  const parserState = {
    timingMode: 'unknown' as AppleTtmlSourceTimingMode,
    allowBareSeconds: true,
    timeBase: 'media',
  };
  let bodyDepth: number | undefined;
  let bodyCount = 0;
  let paragraphCount = 0;
  let spanCount = 0;
  let totalTextBytes = 0;

  const parser = new SaxesParser({ xmlns: true, position: true });
  const currentPosition = (): SourcePosition => ({
    line: parser.line,
    column: parser.column,
  });

  parser.on('doctype', () => {
    throw new TtmlParseFailure(diagnostic(
      'doctype-not-allowed',
      'error',
      'DOCTYPE declarations are not allowed in Apple TTML.',
      currentPosition(),
    ));
  });

  parser.on('error', (error) => {
    throw new TtmlParseFailure(diagnostic(
      'malformed-xml',
      'error',
      `Apple TTML is not well-formed XML: ${error.message}`,
      currentPosition(),
    ));
  });

  parser.on('opentag', (tag) => {
    const position = currentPosition();
    const depth = stack.length + 1;
    if (depth > MAX_XML_DEPTH) {
      throw new TtmlParseFailure(diagnostic(
        'limit-exceeded',
        'error',
        `Apple TTML exceeds the maximum XML depth of ${MAX_XML_DEPTH}.`,
        position,
      ));
    }

    if (!rootSeen) {
      rootSeen = true;
      if (tag.local !== 'tt') {
        throw new TtmlParseFailure(diagnostic(
          'invalid-root',
          'error',
          'Apple TTML must have a <tt> root element.',
          position,
        ));
      }
      if (!TTML_NAMESPACES.has(tag.uri)) {
        throw new TtmlParseFailure(diagnostic(
          'unsupported-namespace',
          'error',
          'The TTML root uses an unsupported namespace.',
          { ...position, value: clippedValue(tag.uri) },
        ));
      }
      rootNamespace = tag.uri;
      parserState.timingMode = timingModeFromRoot(tag, diagnostics, position);
      parserState.allowBareSeconds = rootAllowsBareSeconds(tag);
      parserState.timeBase = rootTimeBase(tag);
    }

    const isTtml = tag.uri === rootNamespace;
    const parent = stack.at(-1);
    if (isTtml && tag.local === 'body') {
      if (
        bodyDepth !== undefined
        || bodyCount > 0
        || !parent
        || parent.local !== 'tt'
        || parent.uri !== rootNamespace
      ) {
        throw new TtmlParseFailure(diagnostic(
          'invalid-structure',
          'error',
          'Apple TTML must contain at most one direct <body> child.',
          position,
        ));
      }
      bodyCount += 1;
      bodyDepth = depth;
    }

    if (isTtml && tag.local === 'p' && bodyDepth === undefined) {
      throw new TtmlParseFailure(diagnostic(
        'invalid-structure',
        'error',
        'TTML paragraphs must be descendants of the <body> element.',
        position,
      ));
    }
    const isParagraph = isTtml
      && tag.local === 'p'
      && bodyDepth !== undefined
      && depth > bodyDepth;
    if (isParagraph) {
      if (activeParagraph) {
        throw new TtmlParseFailure(diagnostic(
          'invalid-structure',
          'error',
          'Nested TTML paragraphs are not supported.',
          position,
        ));
      }
      paragraphCount += 1;
      if (paragraphCount > MAX_PARAGRAPHS) {
        throw new TtmlParseFailure(diagnostic(
          'limit-exceeded',
          'error',
          `Apple TTML exceeds the ${MAX_PARAGRAPHS}-paragraph limit.`,
          position,
        ));
      }
      const begin = findUnqualifiedAttribute(tag, 'begin');
      const end = findUnqualifiedAttribute(tag, 'end');
      activeParagraph = {
        sourceIndex: paragraphCount - 1,
        depth,
        position,
        textParts: [],
        beginPresent: Boolean(begin),
        beginRaw: begin?.value,
        endPresent: Boolean(end),
        endRaw: end?.value,
        semanticKey: semanticKey(tag),
        spanTimings: [],
        hasUnspannedVisibleText: false,
        normalizedBreak: false,
      };
    }

    const suppressesParagraphText = Boolean(activeParagraph) && (
      tag.uri !== rootNamespace
      || tag.local === 'metadata'
      || TTML_METADATA_NAMESPACES.has(tag.uri)
    );
    if (suppressesParagraphText) suppressedTextDepth += 1;

    if (
      activeParagraph
      && suppressedTextDepth === 0
      && isTtml
      && tag.local === 'span'
    ) {
      spanCount += 1;
      if (spanCount > MAX_SPANS) {
        throw new TtmlParseFailure(diagnostic(
          'limit-exceeded',
          'error',
          `Apple TTML exceeds the ${MAX_SPANS}-span limit.`,
          position,
        ));
      }
      if (
        parserState.timingMode === 'line'
        || parserState.timingMode === 'word'
      ) {
        let parentTimedSpan: ElementFrame | undefined;
        for (let index = stack.length - 1; index >= 0; index -= 1) {
          if (stack[index]!.spanTimingIndex !== undefined) {
            parentTimedSpan = stack[index];
            break;
          }
        }
        if (
          parentTimedSpan?.spanTimingIndex !== undefined
          && activeParagraph.spanTimings[parentTimedSpan.spanTimingIndex]
        ) {
          activeParagraph.spanTimings[
            parentTimedSpan.spanTimingIndex
          ]!.hasChildSpan = true;
        }
        const spanTimingIndex = parseSpanTiming(
          tag,
          activeParagraph,
          diagnostics,
          position,
          parserState.allowBareSeconds,
        );
        stack.push({
          local: tag.local,
          uri: tag.uri,
          suppressesParagraphText,
          spanTimingIndex,
        });
        return;
      }
    }

    if (
      activeParagraph
      && suppressedTextDepth === 0
      && isTtml
      && tag.local === 'br'
    ) {
      activeParagraph.textParts.push(' ');
      if (!activeParagraph.normalizedBreak) {
        activeParagraph.normalizedBreak = true;
        diagnostics.push(diagnostic(
          'line-break-normalized',
          'info',
          'An inline TTML line break was normalized to a space.',
          { ...position, sourceIndex: activeParagraph.sourceIndex },
        ));
      }
    }

    stack.push({
      local: tag.local,
      uri: tag.uri,
      suppressesParagraphText,
    });
  });

  const appendText = (text: string): void => {
    if (!activeParagraph || suppressedTextDepth > 0 || !text) return;
    if (/\S/u.test(text)) {
      let containingSpan: ElementFrame | undefined;
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index]!.spanTimingIndex !== undefined) {
          containingSpan = stack[index];
          break;
        }
      }
      if (containingSpan?.spanTimingIndex === undefined) {
        activeParagraph.hasUnspannedVisibleText = true;
      } else {
        activeParagraph.spanTimings[
          containingSpan.spanTimingIndex
        ]!.hasVisibleText = true;
      }
    }
    activeParagraph.textParts.push(text);
    totalTextBytes += Buffer.byteLength(text, 'utf8');
    if (totalTextBytes > MAX_TEXT_BYTES) {
      throw new TtmlParseFailure(diagnostic(
        'limit-exceeded',
        'error',
        `Decoded TTML text exceeds the ${MAX_TEXT_BYTES}-byte limit.`,
        { ...activeParagraph.position, sourceIndex: activeParagraph.sourceIndex },
      ));
    }
  };
  parser.on('text', appendText);
  parser.on('cdata', appendText);

  parser.on('closetag', () => {
    const frame = stack.at(-1);
    if (!frame) {
      throw new TtmlParseFailure(diagnostic(
        'malformed-xml',
        'error',
        'Apple TTML closed an element that was not open.',
        currentPosition(),
      ));
    }

    const depth = stack.length;
    if (activeParagraph && activeParagraph.depth === depth) {
      const parsed = finalizeParagraph(
        activeParagraph,
        diagnostics,
        parserState.timingMode === 'line' || parserState.timingMode === 'word',
        parserState.allowBareSeconds,
      );
      if (parsed) paragraphs.push(parsed);
      activeParagraph = undefined;
    }

    if (frame.suppressesParagraphText) suppressedTextDepth -= 1;
    if (bodyDepth === depth && frame.local === 'body' && frame.uri === rootNamespace) {
      bodyDepth = undefined;
    }
    stack.pop();
  });

  try {
    parser.write(ttml).close();
  } catch (error) {
    if (error instanceof TtmlParseFailure) {
      return invalidResult(error.diagnostic, parserState.timingMode);
    }
    const message = error instanceof Error ? error.message : String(error);
    return invalidResult(diagnostic(
      'malformed-xml',
      'error',
      `Apple TTML could not be parsed: ${message}`,
    ), parserState.timingMode);
  }

  if (!rootSeen) {
    return invalidResult(diagnostic(
      'invalid-root',
      'error',
      'Apple TTML must have a <tt> root element.',
    ));
  }
  if (bodyCount === 0) {
    return invalidResult(diagnostic(
      'missing-body',
      'error',
      'Apple TTML does not contain a <body> element.',
    ), parserState.timingMode);
  }

  const plainText = paragraphs.map((paragraph) => paragraph.text).join('\n');
  if (!plainText) {
    return {
      kind: 'missing',
      lines: [],
      sourceTimingMode: parserState.timingMode,
      diagnostics: [
        ...diagnostics,
        diagnostic('no-lyrics', 'info', 'Apple TTML contains no displayable lyric text.'),
      ],
    };
  }

  if (options.projection === 'v3' && parserState.timeBase !== 'media') {
    diagnostics.push(diagnostic(
      'unsupported-time-base',
      'warning',
      'Only media-based TTML timing can drive synchronized playback.',
      { value: clippedValue(parserState.timeBase) },
    ));
    return {
      kind: 'plain',
      lines: [],
      plainText,
      sourceTimingMode: parserState.timingMode,
      diagnostics,
      timelineValidation: {
        version: APPLE_TIMELINE_VALIDATION_VERSION,
        outcome: 'rejected',
        sourceAnomaly: 'unsupported-time-base',
        repairMethod: null,
      },
    };
  }

  const canSynchronize = (
    parserState.timingMode === 'line' || parserState.timingMode === 'word'
  )
    && paragraphs.every(
      (paragraph) => paragraph.timingValid && paragraph.startMs !== undefined,
    );
  if (!canSynchronize) {
    return {
      kind: 'plain',
      lines: [],
      plainText,
      sourceTimingMode: parserState.timingMode,
      diagnostics,
      ...(options.projection === 'v3'
        ? {
            timelineValidation: {
              version: APPLE_TIMELINE_VALIDATION_VERSION,
              outcome: 'not-applicable' as const,
              sourceAnomaly: null,
              repairMethod: null,
            },
          }
        : {}),
    };
  }

  const sourceOrderStarts = paragraphs.map((paragraph) => paragraph.startMs as number);
  if (sourceOrderStarts.some((startMs, index) => (
    index > 0 && startMs < sourceOrderStarts[index - 1]
  ))) {
    diagnostics.push(diagnostic(
      'non-monotonic-lines',
      'info',
      'Non-monotonic TTML lines were stably sorted by start time.',
    ));
  }

  const ordered = paragraphs
    .map((paragraph) => ({
      ...paragraph,
      startMs: paragraph.startMs as number,
    }))
    .sort((left, right) => (
      left.startMs - right.startMs || left.sourceIndex - right.sourceIndex
    ));

  const seen = new Set<string>();
  const deduplicated = ordered.filter((paragraph) => {
    const key = JSON.stringify([
      paragraph.startMs,
      paragraph.text,
      paragraph.semanticKey,
    ]);
    if (!seen.has(key)) {
      seen.add(key);
      return true;
    }
    diagnostics.push(diagnostic(
      'duplicate-line-dropped',
      'info',
      'An exact duplicate lyric line was dropped.',
      {
        ...paragraph.position,
        sourceIndex: paragraph.sourceIndex,
      },
    ));
    return false;
  });

  const projectedLines = deduplicated.map((paragraph, index) => ({
    id: `apple-${paragraph.startMs}-${index}`,
    startMs: paragraph.startMs,
    text: paragraph.text,
  }));
  if (options.projection === 'v2') {
    return {
      kind: 'synced',
      lines: projectedLines,
      plainText,
      sourceTimingMode: parserState.timingMode,
      diagnostics,
    };
  }

  const durationMs = options.projection === 'v3'
    ? options.durationMs
    : Number.NaN;
  if (!isCredibleAppleTimelineDuration(durationMs)) {
    return {
      kind: 'plain',
      lines: [],
      plainText,
      sourceTimingMode: parserState.timingMode,
      diagnostics,
      timelineValidation: {
        version: APPLE_TIMELINE_VALIDATION_VERSION,
        outcome: 'not-evaluated',
        sourceAnomaly: null,
        repairMethod: null,
      },
    };
  }

  const sourceAnomaly = appleLyricsTimelineAnomaly(
    projectedLines,
    durationMs,
  );
  if (!sourceAnomaly) {
    return {
      kind: 'synced',
      lines: projectedLines,
      plainText,
      sourceTimingMode: parserState.timingMode,
      diagnostics,
      timelineValidation: {
        version: APPLE_TIMELINE_VALIDATION_VERSION,
        outcome: 'valid',
        sourceAnomaly: null,
        repairMethod: null,
      },
    };
  }

  const hasCompleteRepairEvidence = paragraphs.every(
    (paragraph) => paragraph.repairStartMs !== undefined,
  );
  if (hasCompleteRepairEvidence) {
    const repairedOrdered = paragraphs
      .map((paragraph) => ({
        ...paragraph,
        startMs: paragraph.repairStartMs as number,
      }))
      .sort((left, right) => (
        left.startMs - right.startMs || left.sourceIndex - right.sourceIndex
      ));
    const repairedSeen = new Set<string>();
    const repairedParagraphs = repairedOrdered.filter((paragraph) => {
      const key = JSON.stringify([
        paragraph.startMs,
        paragraph.text,
        paragraph.semanticKey,
      ]);
      if (repairedSeen.has(key)) return false;
      repairedSeen.add(key);
      return true;
    });
    const repairedLines = repairedParagraphs.map((paragraph, index) => ({
      id: `apple-${paragraph.startMs}-${index}`,
      startMs: paragraph.startMs,
      text: paragraph.text,
    }));
    if (
      repairedLines.length === projectedLines.length
      && repairedParagraphs.every(
        (paragraph, index) => (
          paragraph.sourceIndex === deduplicated[index]!.sourceIndex
        ),
      )
      && appleLyricsTimelineAnomaly(repairedLines, durationMs) === null
    ) {
      diagnostics.push(diagnostic(
        'timeline-repaired-from-spans',
        'warning',
        'A structurally invalid line timeline was repaired from complete leaf-span timing.',
      ));
      return {
        kind: 'synced',
        lines: repairedLines,
        plainText,
        sourceTimingMode: parserState.timingMode,
        diagnostics,
        timelineValidation: {
          version: APPLE_TIMELINE_VALIDATION_VERSION,
          outcome: 'repaired',
          sourceAnomaly,
          repairMethod: APPLE_TIMELINE_SPAN_REPAIR_METHOD,
        },
      };
    }
  }

  diagnostics.push(diagnostic(
    'timeline-anomaly-unrepairable',
    'warning',
    'A structurally invalid line timeline had no complete, valid leaf-span repair.',
  ));
  return {
    kind: 'plain',
    lines: [],
    plainText,
    sourceTimingMode: parserState.timingMode,
    diagnostics,
    timelineValidation: {
      version: APPLE_TIMELINE_VALIDATION_VERSION,
      outcome: 'rejected',
      sourceAnomaly,
      repairMethod: null,
    },
  };
}
