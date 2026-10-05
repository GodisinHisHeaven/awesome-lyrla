import { decodeNavigationRoute } from './navigation-route.js';

function encodeRoute(points: Array<[number, number]>): string {
  let encoded = '';
  const previous = [0, 0];
  for (const point of points) {
    point.forEach((coordinate, axis) => {
      const integer = Math.round(coordinate * 1e6);
      const delta = integer - previous[axis];
      previous[axis] = integer;
      let value = delta < 0 ? ~(delta << 1) : delta << 1;
      while (value >= 32) {
        encoded += String.fromCharCode(((value & 31) | 32) + 63);
        value >>>= 5;
      }
      encoded += String.fromCharCode(value + 63);
    });
  }
  return Buffer.from(encoded).toString('base64');
}

function wrappedRoute(encoded: string, metadata = Buffer.from([0x12, 3, 0x08, 0xac, 2])): string {
  const polyline = Buffer.from(encoded, 'base64');
  let length = polyline.length;
  const prefix = [0x0a];
  do {
    const byte = length & 127;
    length = Math.floor(length / 128);
    prefix.push(byte | (length ? 128 : 0));
  } while (length);
  return Buffer.concat([Buffer.from(prefix), polyline, metadata]).toString('base64');
}

describe('Tesla RouteLine decoding', () => {
  it('decodes a realistic precision-6 route with exact endpoints', () => {
    expect(decodeNavigationRoute('d3lzbnpAb3VkbGZGX2xFPz97bUB7e0M/')).toEqual([
      { latitude: 31.18942, longitude: 121.32644 },
      { latitude: 31.1927, longitude: 121.32644 },
      { latitude: 31.1927, longitude: 121.32719 },
      { latitude: 31.19521, longitude: 121.32719 },
    ]);
  });
  it('uses precision 6 after base64 decoding the documented polyline example', () => {
    const encoded = Buffer.from('_p~iF~ps|U_ulLnnqC_mqNvxq`@').toString('base64');
    expect(decodeNavigationRoute(encoded)).toEqual(
      [
        { latitude: 3.85, longitude: -12.02 },
        { latitude: 4.07, longitude: -12.095 },
        { latitude: 4.3252, longitude: -12.6453 },
      ].slice(-2),
    );
  });

  it('extracts the precision-6 polyline from the real vehicle envelope format', () => {
    const encoded = 'd3lzbnpAb3VkbGZGX2xFPz97bUB7e0M/';
    expect(decodeNavigationRoute(wrappedRoute(encoded))).toEqual(decodeNavigationRoute(encoded));
  });

  it('reads multi-byte lengths and skips unrelated metadata without changing endpoints', () => {
    const points = Array.from({ length: 100 }, (_, index): [number, number] => [
      31 + index * 0.0001,
      121,
    ]);
    const encoded = encodeRoute(points);
    expect(Buffer.from(encoded, 'base64').length).toBeGreaterThan(127);
    const metadata = Buffer.from([
      0x18,
      ...Array<number>(9).fill(0xff),
      1, // uint64
      0x21,
      ...Array<number>(8).fill(0), // fixed64
      0x2d,
      ...Array<number>(4).fill(0), // fixed32
      0x12,
      3,
      0x08,
      0xac,
      2, // nested metadata
    ]);
    expect(decodeNavigationRoute(wrappedRoute(encoded, metadata))).toEqual(
      decodeNavigationRoute(encoded),
    );
  });

  it('accepts metadata before the polyline, and rejects metadata-only cancellation records', () => {
    const metadata = Buffer.from([0x12, 3, 0x08, 0xac, 2]);
    const encoded = 'd3lzbnpAb3VkbGZGX2xFPz97bUB7e0M/';
    const reordered = Buffer.concat([
      metadata,
      Buffer.from(wrappedRoute(encoded, Buffer.alloc(0)), 'base64'),
    ]);
    expect(decodeNavigationRoute(reordered.toString('base64'))).toEqual(
      decodeNavigationRoute(encoded),
    );
    expect(
      decodeNavigationRoute(Buffer.concat([metadata, metadata]).toString('base64')),
    ).toBeNull();
  });

  it('rejects malformed envelopes and ambiguous duplicate polylines', () => {
    const route = Buffer.from(wrappedRoute('d3lzbnpAb3VkbGZGX2xFPz97bUB7e0M/'), 'base64');
    const invalid = [
      Buffer.concat([route, route]),
      Buffer.concat([route, Buffer.from([0x12, 20, 0])]),
      Buffer.concat([route, Buffer.from([0x21, 0])]),
      Buffer.concat([route, Buffer.from([0x2d, 0])]),
      Buffer.concat([route, Buffer.from([0x18, ...Array<number>(9).fill(0xff), 2])]),
      Buffer.concat([route, Buffer.from([0x1b])]),
      Buffer.from([0x0a, 0x80]),
      Buffer.from([0x0a, 0xff, 0xff, 0xff, 0xff, 0x7f]),
      Buffer.from([0x08, 1]),
      Buffer.from([0, 0]),
      Buffer.from([0x0a, 2, 0xff, 0xff]),
    ];
    for (const bytes of invalid) expect(decodeNavigationRoute(bytes.toString('base64'))).toBeNull();
  });

  it('bounds a long dense route to its final section and keeps the destination exact', () => {
    const points = Array.from({ length: 1_000 }, (_, index): [number, number] => [
      31 + index * 0.0001,
      121,
    ]);
    const decoded = decodeNavigationRoute(encodeRoute(points))!;
    expect(decoded.length).toBeLessThanOrEqual(256);
    expect(decoded[0].latitude).toBeGreaterThan(31.06);
    expect(decoded.at(-1)).toEqual({ latitude: 31.0999, longitude: 121 });
  });

  it('rejects out-of-range route coordinates', () => {
    expect(
      decodeNavigationRoute(
        encodeRoute([
          [91, 121],
          [91.01, 121],
        ]),
      ),
    ).toBeNull();
  });

  it.each([
    '',
    'not base64!',
    Buffer.from('_').toString('base64'),
    Buffer.from('?').toString('base64'),
    Buffer.from([0xff, 0xff]).toString('base64'),
    'A'.repeat(262_145),
  ])('rejects malformed or excessive input', (encoded) => {
    expect(decodeNavigationRoute(encoded)).toBeNull();
  });
});
