export type ByteEstimator<K, V> = (value: V, key: K) => number;

export interface BoundedLruOptions<K, V> {
  /** Maximum number of entries retained. Zero disables retention. */
  maxEntries: number;
  /** Maximum estimated value bytes retained. Zero only permits zero-byte values. */
  maxBytes: number;
  /**
   * Estimates the bytes charged for an entry. The default measures strings and
   * binary views directly, and otherwise measures UTF-8 JSON output.
   */
  estimateBytes?: ByteEstimator<K, V>;
}

interface CacheEntry<V> {
  value: V;
  bytes: number;
}

const UTF8_ENCODER = new TextEncoder();

/**
 * Dependency-free byte estimator suitable for JSON-like payloads.
 *
 * Objects must be JSON serializable. Callers caching other value types should
 * inject an estimator instead.
 */
export function defaultByteEstimator(value: unknown): number {
  if (typeof value === 'string') {
    return UTF8_ENCODER.encode(value).byteLength;
  }

  if (value instanceof ArrayBuffer) {
    return value.byteLength;
  }

  if (ArrayBuffer.isView(value)) {
    return value.byteLength;
  }

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(
      'The default byte estimator only supports JSON-serializable values; provide estimateBytes for this value type.',
      { cause: error },
    );
  }

  if (serialized === undefined) {
    throw new TypeError(
      'The default byte estimator only supports JSON-serializable values; provide estimateBytes for this value type.',
    );
  }

  return UTF8_ENCODER.encode(serialized).byteLength;
}

/**
 * An in-memory least-recently-used cache bounded by both entry count and an
 * estimated byte budget.
 *
 * `get` marks an entry as most recently used. TTL is intentionally left to the
 * caller so stale values can remain available for stale-while-revalidate flows.
 */
export class BoundedLruCache<K, V> {
  readonly maxEntries: number;
  readonly maxBytes: number;

  readonly #entries = new Map<K, CacheEntry<V>>();
  readonly #estimateBytes: ByteEstimator<K, V>;
  #estimatedBytes = 0;

  constructor(options: BoundedLruOptions<K, V>) {
    assertNonNegativeSafeInteger(options.maxEntries, 'maxEntries');
    assertNonNegativeSafeInteger(options.maxBytes, 'maxBytes');

    this.maxEntries = options.maxEntries;
    this.maxBytes = options.maxBytes;
    this.#estimateBytes = options.estimateBytes ?? ((value) => defaultByteEstimator(value));
  }

  get size(): number {
    return this.#entries.size;
  }

  get estimatedBytes(): number {
    return this.#estimatedBytes;
  }

  has(key: K): boolean {
    return this.#entries.has(key);
  }

  get(key: K): V | undefined {
    const entry = this.#entries.get(key);
    if (!entry) {
      return undefined;
    }

    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  /**
   * Inserts or replaces an entry and returns whether the new value was retained.
   * A value larger than the entire byte budget is rejected. Replacing a key with
   * a rejected value removes the old value rather than serving stale data under
   * that key.
   */
  set(key: K, value: V): boolean {
    const bytes = this.#estimateBytes(value, key);
    assertNonNegativeSafeInteger(bytes, 'estimateBytes result');

    const existing = this.#entries.get(key);
    if (existing) {
      this.#entries.delete(key);
      this.#estimatedBytes -= existing.bytes;
    }

    if (this.maxEntries === 0 || bytes > this.maxBytes) {
      return false;
    }

    this.#entries.set(key, { value, bytes });
    this.#estimatedBytes += bytes;
    this.#evictToLimits();
    return this.#entries.has(key);
  }

  delete(key: K): boolean {
    const entry = this.#entries.get(key);
    if (!entry) {
      return false;
    }

    this.#entries.delete(key);
    this.#estimatedBytes -= entry.bytes;
    return true;
  }

  clear(): void {
    this.#entries.clear();
    this.#estimatedBytes = 0;
  }

  #evictToLimits(): void {
    while (this.#entries.size > this.maxEntries || this.#estimatedBytes > this.maxBytes) {
      const oldestKey = this.#entries.keys().next();
      if (oldestKey.done) {
        break;
      }
      this.delete(oldestKey.value);
    }
  }
}

function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}
