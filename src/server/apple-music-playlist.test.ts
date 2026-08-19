import {
  createAppleMusicPlaylistSnapshot,
  fetchAppleMusicPlaylist,
  normalizeApplePlaylistText,
  parseAppleMusicPlaylistUrl,
} from './apple-music-playlist.js';

const LOCATION = parseAppleMusicPlaylistUrl(
  'https://music.apple.com/cn/playlist/favourite-songs/pl.u-Z6UVBrVJmb?l=en',
);

function song(
  id: string,
  name: string,
  albumName = 'Album',
  durationInMillis = 180_000,
) {
  return {
    id,
    type: 'songs' as const,
    attributes: {
      name,
      artistName: 'Artist',
      albumName,
      durationInMillis,
      hasLyrics: true,
      isrc: `ISRC${id}`,
    },
  };
}

describe('Apple Music playlist ingestion', () => {
  it('parses a public playlist URL and rejects a foreign origin', () => {
    expect(LOCATION).toMatchObject({
      storefront: 'cn',
      playlistId: 'pl.u-Z6UVBrVJmb',
    });
    expect(() => parseAppleMusicPlaylistUrl(
      'https://example.com/cn/playlist/favourite-songs/pl.u-Z6UVBrVJmb',
    )).toThrow('https://music.apple.com');
  });

  it('normalizes non-breaking and repeated whitespace before fingerprinting', () => {
    expect(normalizeApplePlaylistText('  偷笑\u00a0 \n')).toBe('偷笑');
  });

  it('deduplicates source ids for audit and exact fingerprints for import', () => {
    const snapshot = createAppleMusicPlaylistSnapshot(LOCATION, [
      song('1', 'One'),
      song('1', 'One'),
      song('2', 'Two'),
      song('3', 'Two'),
      song('4', 'Two', 'Other album'),
    ]);
    expect(snapshot).toMatchObject({
      sourceTrackCount: 5,
      uniqueAppleSongCount: 4,
      uniqueExactKeyCount: 3,
      duplicateAppleSongCount: 1,
      duplicateExactKeyCount: 2,
    });
    expect(snapshot.tracks.map((item) => item.appleSongId)).toEqual(['1', '2', '4']);
    expect(snapshot.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('follows safe increasing pagination until next is absent', async () => {
    const urls: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      urls.push(url.href);
      const offset = url.searchParams.get('offset') ?? '0';
      return new Response(JSON.stringify(offset === '0'
        ? {
            data: [song('1', 'One'), song('2', 'Two')],
            next: '/v1/catalog/cn/playlists/pl.u-Z6UVBrVJmb/tracks?offset=100',
          }
        : { data: [song('3', 'Three')] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const snapshot = await fetchAppleMusicPlaylist(LOCATION, {
      developerToken: 'test-token',
      fetcher,
    });
    expect(urls).toHaveLength(2);
    expect(snapshot.sourceTrackCount).toBe(3);
    expect(snapshot.uniqueExactKeyCount).toBe(3);
  });

  it('rejects pagination that could forward the developer token elsewhere', async () => {
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({
      data: [song('1', 'One')],
      next: 'https://example.com/v1/catalog/cn/playlists/pl.u-Z6UVBrVJmb/tracks?offset=100',
    }), { status: 200 });
    await expect(fetchAppleMusicPlaylist(LOCATION, {
      developerToken: 'test-token',
      fetcher,
    })).rejects.toThrow('left the expected resource');
  });

  it('rejects pagination offsets that do not advance', async () => {
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({
      data: [song('1', 'One')],
      next: '/v1/catalog/cn/playlists/pl.u-Z6UVBrVJmb/tracks?offset=0',
    }), { status: 200 });
    await expect(fetchAppleMusicPlaylist(LOCATION, {
      developerToken: 'test-token',
      fetcher,
    })).rejects.toThrow('offset did not increase');
  });
});
