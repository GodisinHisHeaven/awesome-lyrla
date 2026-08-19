import {
  chineseLyricsScript,
  isExplicitInstrumentalTitle,
  metadataScriptVariants,
  scriptAwareMetadataSimilarity,
  scriptEquivalentTrackMetadata,
} from './lyrics-metadata-alias.js';

describe('lyrics metadata script aliases', () => {
  it('produces deterministic Simplified and Traditional search aliases', () => {
    expect(metadataScriptVariants('单车')).toEqual(['单车', '單車']);
    expect(metadataScriptVariants('陳奕迅')).toEqual(['陳奕迅', '陈奕迅']);
    expect(scriptAwareMetadataSimilarity('单车', '單車')).toBe(1);
  });

  it('accepts only script-equivalent recording metadata', () => {
    const simplified = {
      title: '单车',
      artist: '陈奕迅',
      album: '2013 陈奕迅 Music Life 精选',
    };
    expect(scriptEquivalentTrackMetadata(simplified, {
      title: '單車',
      artist: '陳奕迅',
      album: '2013 陳奕迅 Music Life 精選',
    })).toBe(true);
    expect(scriptEquivalentTrackMetadata(simplified, {
      ...simplified,
      title: '单车 (Live)',
    })).toBe(false);
    expect(scriptEquivalentTrackMetadata(simplified, {
      ...simplified,
      album: 'A Different Album',
    })).toBe(false);
  });

  it.each([
    ['不要不要假设我知道，骑着单车', 'simplified'],
    ['不要不要假設我知道，騎著單車', 'traditional'],
    ['不要不要假設我知道，骑着单车', 'mixed'],
    ['夜空', 'neutral'],
    ['何時でも夢を見ている', 'neutral'],
    ['사랑 後悔', 'neutral'],
    ['Only you', 'neutral'],
  ] as const)('classifies displayed lyric script without converting %s', (text, expected) => {
    expect(chineseLyricsScript(text)).toBe(expected);
  });

  it.each([
    'Midnight Circuit (Instrumental)',
    'Midnight Circuit - Karaoke',
    '单车（纯音乐）',
    '單車（純音樂）',
  ])('recognizes explicit instrumental evidence in %s', (title) => {
    expect(isExplicitInstrumentalTitle(title)).toBe(true);
  });

  it('does not treat an ordinary vocal title as instrumental evidence', () => {
    expect(isExplicitInstrumentalTitle('单车')).toBe(false);
  });
});
