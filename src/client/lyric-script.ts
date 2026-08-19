export type LyricScript = 'cjk' | 'latin' | 'mixed' | 'neutral';
export type LyricRunScript = Exclude<LyricScript, 'mixed'>;

export interface LyricScriptRun {
  script: LyricRunScript;
  text: string;
  language?: 'ja' | 'ko' | 'zh-Hans';
}

export interface LyricTextAnalysis {
  script: LyricScript;
  runs: LyricScriptRun[];
}

const HAN = /\p{Script=Han}/u;
const HIRAGANA = /\p{Script=Hiragana}/u;
const KATAKANA = /\p{Script=Katakana}/u;
const HANGUL = /\p{Script=Hangul}/u;
const LATIN = /\p{Script=Latin}/u;
const CJK_PUNCTUATION = /[，。！？、；：…—《》〈〉「」『』【】〔〕（）［］｛｝“”‘’]/u;

function characterScript(character: string): LyricRunScript {
  if (
    HAN.test(character)
    || HIRAGANA.test(character)
    || KATAKANA.test(character)
    || HANGUL.test(character)
  ) return 'cjk';
  if (LATIN.test(character)) return 'latin';
  return 'neutral';
}

function cjkLanguage(text: string): LyricScriptRun['language'] {
  if (HIRAGANA.test(text) || KATAKANA.test(text)) return 'ja';
  if (HANGUL.test(text)) return 'ko';
  return 'zh-Hans';
}

export function analyzeLyricText(text: string): LyricTextAnalysis {
  const characters = [...text];
  const rawScripts = characters.map(characterScript);
  const hasCjk = rawScripts.includes('cjk');
  const hasLatin = rawScripts.includes('latin');
  const language = hasCjk ? cjkLanguage(text) : undefined;
  const script: LyricScript = hasCjk && hasLatin
    ? 'mixed'
    : hasCjk
      ? 'cjk'
      : hasLatin
        ? 'latin'
        : 'neutral';

  if (characters.length === 0) return { script, runs: [] };

  const resolvedScripts = rawScripts.map((current, index): LyricRunScript => {
    if (current !== 'neutral') return current;
    if (hasCjk && CJK_PUNCTUATION.test(characters[index] ?? '')) return 'cjk';

    let previous: LyricRunScript | undefined;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (rawScripts[cursor] !== 'neutral') {
        previous = rawScripts[cursor];
        break;
      }
    }
    if (previous) return previous;

    for (let cursor = index + 1; cursor < rawScripts.length; cursor += 1) {
      if (rawScripts[cursor] !== 'neutral') return rawScripts[cursor];
    }
    return 'neutral';
  });

  const runs: LyricScriptRun[] = [];
  characters.forEach((character, index) => {
    const runScript = resolvedScripts[index] ?? 'neutral';
    const currentRun = runs.at(-1);
    if (currentRun?.script === runScript) {
      currentRun.text += character;
      return;
    }
    runs.push({ script: runScript, text: character });
  });

  for (const run of runs) {
    if (run.script === 'cjk') run.language = language;
  }

  return { script, runs };
}
