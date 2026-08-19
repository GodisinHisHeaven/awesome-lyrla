import {
  hasRecordingVersionTag,
  lyricsLookupFingerprint,
  lyricsSearchTitleVariants,
  lyricsWorkFingerprint,
  metadataSimilarity,
  metadataVersionMismatch,
  normalizeMetadata,
  staticLyricsFallbackBaseTitle,
  staticLyricsFallbackVersion,
  trackFingerprint,
  trackMatchScore,
} from './track.js';

describe('track metadata matching', () => {
  it('normalizes common streaming title decorations', () => {
    expect(normalizeMetadata('Midnight Circuit (feat. Nova) - 2026 Remaster')).toBe('midnight circuit');
    expect(normalizeMetadata('Beyoncé & JAY-Z')).toBe('beyonce and jay z');
  });

  it('ranks a matching track above a similarly named wrong version', () => {
    const wanted = {
      title: 'Midnight Circuit',
      artist: 'Local Drive',
      album: 'After Dark',
      durationMs: 214_000,
    };
    const exact = trackMatchScore(wanted, {
      trackName: 'Midnight Circuit',
      artistName: 'Local Drive',
      albumName: 'After Dark',
      duration: 214,
    });
    const wrong = trackMatchScore(wanted, {
      trackName: 'Midnight Circuit (Live)',
      artistName: 'Local Drive',
      albumName: 'Live at Dawn',
      duration: 249,
    });

    expect(exact).toBeGreaterThan(0.98);
    expect(exact).toBeGreaterThan(wrong);
    expect(metadataSimilarity('Apple Music', 'AppleMusic')).toBeGreaterThan(0.85);
  });

  it('reweights available metadata when Tesla omits the artist', () => {
    const score = trackMatchScore(
      {
        title: 'Midnight Circuit',
        artist: '',
        album: 'After Dark',
        durationMs: 214_000,
      },
      {
        trackName: 'Midnight Circuit',
        artistName: 'Local Drive',
        albumName: 'After Dark',
        duration: 214,
      },
    );

    expect(score).toBeGreaterThan(0.98);
  });

  it('distinguishes recording versions while canonicalizing equivalent version labels', () => {
    expect(metadataVersionMismatch('Midnight Circuit', 'Midnight Circuit (Remix)')).toBe(true);
    expect(metadataVersionMismatch(
      'Midnight Circuit (2011 Remaster)',
      'Midnight Circuit (2011 Remastered)',
    )).toBe(false);
    expect(metadataVersionMismatch(
      'Midnight Circuit (Remix)',
      'Midnight Circuit (Remixed)',
    )).toBe(false);
  });

  it('uses album metadata for lookup identity without changing the persistent track key', () => {
    const track = {
      title: 'Midnight Circuit',
      artist: 'Local Drive',
      durationMs: 214_000,
    };
    const first = { ...track, album: 'First Album' };
    const corrected = { ...track, album: 'Correct Album' };

    expect(trackFingerprint(first)).toBe(trackFingerprint(corrected));
    expect(lyricsLookupFingerprint(first)).not.toBe(lyricsLookupFingerprint(corrected));
  });

  it('recognizes only decorated Live and Acoustic version labels for static fallback', () => {
    expect(staticLyricsFallbackVersion('Midnight Circuit (Live at the Forum)')).toBe('live');
    expect(staticLyricsFallbackVersion('Midnight Circuit - Acoustic Version')).toBe('acoustic');
    expect(staticLyricsFallbackVersion('午夜电路（不插电版）')).toBe('acoustic');
    expect(staticLyricsFallbackVersion('午夜電路 - 不插電')).toBe('acoustic');
    expect(staticLyricsFallbackBaseTitle('午夜电路（不插电版）')).toBe('午夜电路');
    expect(staticLyricsFallbackBaseTitle('午夜電路 - 不插電版本')).toBe('午夜電路');
    expect(staticLyricsFallbackVersion('Live Forever')).toBeNull();
    expect(staticLyricsFallbackVersion('Acoustic Soul')).toBeNull();
    expect(staticLyricsFallbackVersion('Midnight Circuit (Remix)')).toBeNull();
    expect(staticLyricsFallbackVersion('Midnight Circuit (Live Remix)')).toBeNull();
    expect(staticLyricsFallbackVersion('Midnight Circuit (Acoustic Remaster)')).toBeNull();
    expect(staticLyricsFallbackVersion('Midnight Circuit (Remastered) (Live)')).toBeNull();
    expect(staticLyricsFallbackVersion('午夜电路（不插电版 Remix）')).toBeNull();
    expect(staticLyricsFallbackVersion('午夜電路（不插電版 Remaster）')).toBeNull();
    expect(staticLyricsFallbackVersion('午夜电路（不插电版 Instrumental）')).toBeNull();
    expect(staticLyricsFallbackVersion('午夜电路（不插电混音版）')).toBeNull();
    expect(staticLyricsFallbackVersion('午夜電路（不插電重製版）')).toBeNull();
    expect(staticLyricsFallbackVersion('午夜电路（不插电纯音乐版）')).toBeNull();
    expect(staticLyricsFallbackVersion('午夜电路（混音版）（不插电版）')).toBeNull();
  });

  it('conservatively detects recording labels for exact-only bulk writes', () => {
    expect(hasRecordingVersionTag('Bohemian Rhapsody (Live Aid)')).toBe(true);
    expect(hasRecordingVersionTag('画 (Live Piano Session II)')).toBe(true);
    expect(hasRecordingVersionTag('Half the World Away (Remastered Live, Tokyo Hotel Room)'))
      .toBe(true);
    expect(hasRecordingVersionTag('午夜电路（不插电版）')).toBe(true);
    expect(hasRecordingVersionTag('午夜电路（混音版）')).toBe(true);
    expect(hasRecordingVersionTag('Midnight Circuit')).toBe(false);
  });

  it('keeps original, Live, and Acoustic recordings in separate track identities', () => {
    const track = {
      title: 'Midnight Circuit',
      artist: 'Local Drive',
      durationMs: 214_000,
    };

    expect(trackFingerprint(track)).not.toBe(trackFingerprint({
      ...track,
      title: 'Midnight Circuit (Live)',
    }));
    expect(trackFingerprint(track)).not.toBe(trackFingerprint({
      ...track,
      title: 'Midnight Circuit (Acoustic)',
    }));
    expect(trackFingerprint(track)).not.toBe(trackFingerprint({
      ...track,
      title: 'Midnight Circuit（不插电版）',
    }));
    expect(metadataVersionMismatch(
      'Midnight Circuit（不插電版）',
      'Midnight Circuit (Acoustic)',
    )).toBe(false);
    expect(lyricsLookupFingerprint({
      title: '童言无忌 (不插电)',
      artist: '王以太',
      album: '闪火mixtape - EP',
      durationMs: 300_141,
    })).toBe('童言无忌 不插电::王以太::300::闪火mixtape ep');
  });

  it('builds search variants without dropping recording-version labels', () => {
    expect(lyricsSearchTitleVariants(
      'Midnight Circuit (Live) (feat. Nova) [Official Audio]',
    )).toEqual(expect.arrayContaining([
      'Midnight Circuit (Live) [Official Audio]',
      'Midnight Circuit (Live) (feat. Nova)',
      'Midnight Circuit (Live)',
    ]));
    expect(lyricsSearchTitleVariants('Midnight Circuit (Live)')).not.toContain('midnight circuit');
  });

  it('shares a work identity only for safe recording variants', () => {
    const original = { title: 'Midnight Circuit', artist: 'Local Drive' };

    expect(lyricsWorkFingerprint({ ...original, title: 'Midnight Circuit (Live)' })).toBe(
      lyricsWorkFingerprint(original),
    );
    expect(lyricsWorkFingerprint({ ...original, title: 'Midnight Circuit (Acoustic)' })).toBe(
      lyricsWorkFingerprint(original),
    );
    expect(lyricsWorkFingerprint({ ...original, title: 'Midnight Circuit（不插电版）' })).toBe(
      lyricsWorkFingerprint(original),
    );
    expect(lyricsWorkFingerprint({ ...original, title: 'Midnight Circuit (Live Remix)' })).not.toBe(
      lyricsWorkFingerprint(original),
    );
    expect(lyricsWorkFingerprint({
      ...original,
      title: 'Midnight Circuit（不插电版 Remix）',
    })).not.toBe(lyricsWorkFingerprint(original));
    expect(lyricsWorkFingerprint({ ...original, artist: '' })).toBeNull();
  });
});
