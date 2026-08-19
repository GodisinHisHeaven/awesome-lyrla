import { BoundedLruCache, defaultByteEstimator } from './bounded-lru.js';

function stringCache(maxEntries: number, maxBytes: number): BoundedLruCache<string, string> {
  return new BoundedLruCache({
    maxEntries,
    maxBytes,
    estimateBytes: (value) => value.length,
  });
}

describe('BoundedLruCache', () => {
  it('stores, retrieves, deletes, and clears entries while tracking usage', () => {
    const cache = stringCache(3, 20);

    expect(cache.set('a', '1234')).toBe(true);
    expect(cache.set('b', '123')).toBe(true);
    expect(cache.size).toBe(2);
    expect(cache.estimatedBytes).toBe(7);
    expect(cache.has('a')).toBe(true);
    expect(cache.get('a')).toBe('1234');
    expect(cache.get('missing')).toBeUndefined();

    expect(cache.delete('b')).toBe(true);
    expect(cache.delete('b')).toBe(false);
    expect(cache.size).toBe(1);
    expect(cache.estimatedBytes).toBe(4);

    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.estimatedBytes).toBe(0);
  });

  it('evicts the least recently used entry when the entry limit is exceeded', () => {
    const cache = stringCache(2, 100);
    cache.set('a', 'a');
    cache.set('b', 'b');

    expect(cache.get('a')).toBe('a');
    cache.set('c', 'c');

    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);
  });

  it('evicts as many old entries as needed to satisfy the byte limit', () => {
    const cache = stringCache(10, 8);
    cache.set('a', '1234');
    cache.set('b', '5678');

    expect(cache.set('c', 'abcde')).toBe(true);

    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(false);
    expect(cache.get('c')).toBe('abcde');
    expect(cache.estimatedBytes).toBe(5);
  });

  it('applies count and byte limits together', () => {
    const cache = stringCache(2, 6);
    cache.set('a', '12');
    cache.set('b', '34');
    cache.set('c', '56');

    expect(cache.has('a')).toBe(false);
    expect(cache.size).toBe(2);
    expect(cache.estimatedBytes).toBe(4);

    cache.set('d', '12345');
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(false);
    expect(cache.get('d')).toBe('12345');
    expect(cache.estimatedBytes).toBe(5);
  });

  it('replacing an entry updates its byte charge and makes it most recent', () => {
    const cache = stringCache(2, 8);
    cache.set('a', '12');
    cache.set('b', '34');

    expect(cache.set('a', '1234567')).toBe(true);

    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.get('a')).toBe('1234567');
    expect(cache.size).toBe(1);
    expect(cache.estimatedBytes).toBe(7);
  });

  it('rejects an oversized value and removes an older value under the same key', () => {
    const cache = stringCache(3, 5);
    cache.set('a', '12');
    cache.set('b', '34');

    expect(cache.set('a', '123456')).toBe(false);

    expect(cache.has('a')).toBe(false);
    expect(cache.get('b')).toBe('34');
    expect(cache.size).toBe(1);
    expect(cache.estimatedBytes).toBe(2);
  });

  it('supports disabled retention with a zero entry limit', () => {
    const cache = stringCache(0, 100);

    expect(cache.set('a', 'value')).toBe(false);
    expect(cache.size).toBe(0);
    expect(cache.estimatedBytes).toBe(0);
  });

  it('allows zero-byte entries under a zero byte budget', () => {
    const cache = stringCache(2, 0);

    expect(cache.set('empty', '')).toBe(true);
    expect(cache.set('non-empty', 'x')).toBe(false);
    expect(cache.get('empty')).toBe('');
    expect(cache.estimatedBytes).toBe(0);
  });

  it('passes both value and key to an injected estimator', () => {
    const estimator = vi.fn((value: string, key: string) => value.length + key.length);
    const cache = new BoundedLruCache<string, string>({
      maxEntries: 2,
      maxBytes: 20,
      estimateBytes: estimator,
    });

    cache.set('key', 'value');

    expect(estimator).toHaveBeenCalledWith('value', 'key');
    expect(cache.estimatedBytes).toBe(8);
  });

  it('does not mutate an existing entry when estimation fails', () => {
    const cache = new BoundedLruCache<string, string>({
      maxEntries: 2,
      maxBytes: 20,
      estimateBytes: (value) => (value === 'bad' ? -1 : value.length),
    });
    cache.set('a', 'good');

    expect(() => cache.set('a', 'bad')).toThrow(RangeError);
    expect(cache.get('a')).toBe('good');
    expect(cache.estimatedBytes).toBe(4);
  });

  it.each([
    [{ maxEntries: -1, maxBytes: 10 }, 'maxEntries'],
    [{ maxEntries: 1.5, maxBytes: 10 }, 'maxEntries'],
    [{ maxEntries: 1, maxBytes: Number.POSITIVE_INFINITY }, 'maxBytes'],
  ])('rejects invalid cache limits: %o', (options, field) => {
    expect(() => new BoundedLruCache<string, string>(options)).toThrow(field);
  });

  it.each([Number.NaN, 1.5, Number.POSITIVE_INFINITY])(
    'rejects an invalid estimator result: %s',
    (result) => {
      const cache = new BoundedLruCache<string, string>({
        maxEntries: 1,
        maxBytes: 10,
        estimateBytes: () => result,
      });

      expect(() => cache.set('a', 'value')).toThrow(RangeError);
      expect(cache.size).toBe(0);
    },
  );
});

describe('defaultByteEstimator', () => {
  it('measures strings and binary data directly', () => {
    expect(defaultByteEstimator('lyrics')).toBe(6);
    expect(defaultByteEstimator('\u4f60\u597d')).toBe(6);
    expect(defaultByteEstimator(new Uint8Array(7))).toBe(7);
    expect(defaultByteEstimator(new ArrayBuffer(5))).toBe(5);
  });

  it('measures JSON-like values as UTF-8 serialized JSON', () => {
    const value = { lines: ['hello', '\u4f60\u597d'], synced: true };
    const expected = new TextEncoder().encode(JSON.stringify(value)).byteLength;

    expect(defaultByteEstimator(value)).toBe(expected);
  });

  it('requires a custom estimator for non-serializable values', () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(() => defaultByteEstimator(circular)).toThrow(/provide estimateBytes/);
    expect(() => defaultByteEstimator(undefined)).toThrow(/provide estimateBytes/);
  });
});
