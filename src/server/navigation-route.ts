import type { NavigationCoordinate } from '../shared/contracts.js';
import {
  coordinateDistanceMeters,
  isNavigationCoordinate,
  NAVIGATION_ROUTE_MAX_POINTS,
} from '../shared/navigation-map.js';

/** Extract field 1 from the binary RouteLine envelope sent by current vehicles. */
function wrappedPolyline(bytes: Buffer): Buffer | null {
  let cursor = 0;
  let polyline: Buffer | null = null;
  const readVarint = (): bigint | null => {
    let result = 0n;
    for (let shift = 0; shift < 70 && cursor < bytes.length; shift += 7) {
      const byte = bytes[cursor++];
      if (shift === 63 && byte > 1) return null;
      result |= BigInt(byte & 127) << BigInt(shift);
      if (byte < 128) return result;
    }
    return null;
  };
  while (cursor < bytes.length) {
    const tag = readVarint();
    if (tag === null || tag > 0xffff_ffffn || tag < 8n) return null;
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (field === 1 && (wire !== 2 || polyline !== null)) return null;
    if (wire === 0) {
      if (readVarint() === null) return null;
    } else if (wire === 1 || wire === 5) {
      cursor += wire === 1 ? 8 : 4;
    } else if (wire === 2) {
      const length = readVarint();
      if (length === null || length > BigInt(bytes.length - cursor)) return null;
      const end = cursor + Number(length);
      if (field === 1) polyline = bytes.subarray(cursor, end);
      cursor = end;
    } else {
      return null;
    }
    if (cursor > bytes.length) return null;
  }
  return polyline;
}

/** Accept the documented plain polyline and the observed Protobuf envelope. */
export function decodeNavigationRoute(value: unknown): NavigationCoordinate[] | null {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 262_144 ||
    value.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
    return null;
  const bytes = Buffer.from(value, 'base64');
  const isPolylineByte = (byte: number) => byte >= 63 && byte <= 126;
  const payload = bytes.every(isPolylineByte) ? bytes : wrappedPolyline(bytes);
  if (!payload?.length || !payload.every(isPolylineByte)) return null;
  const encoded = payload.toString('ascii');
  let cursor = 0;
  let latitude = 0;
  let longitude = 0;
  const points: NavigationCoordinate[] = [];
  const readDelta = (): number | null => {
    let result = 0;
    let shift = 0;
    while (cursor < encoded.length && shift <= 30) {
      const byte = encoded.charCodeAt(cursor++) - 63;
      if (byte < 0 || byte > 63) return null;
      result += (byte & 31) * 2 ** shift;
      if (byte < 32) return result % 2 ? -(Math.floor(result / 2) + 1) : result / 2;
      shift += 5;
    }
    return null;
  };
  while (cursor < encoded.length) {
    if (points.length >= 20_000) return null;
    const latDelta = readDelta();
    const lonDelta = readDelta();
    if (latDelta === null || lonDelta === null) return null;
    latitude += latDelta;
    longitude += lonDelta;
    const point = { latitude: latitude / 1e6, longitude: longitude / 1e6 };
    if (!isNavigationCoordinate(point)) return null;
    points.push(point);
  }
  if (points.length < 2) return null;
  let start = points.length - 2;
  let lengthMeters = 0;
  for (; start > 0; start--) {
    lengthMeters += coordinateDistanceMeters(points[start], points[start + 1]);
    if (lengthMeters >= 4_000) break;
  }
  const tail = points.slice(start);
  if (tail.length <= NAVIGATION_ROUTE_MAX_POINTS) return tail;
  return Array.from(
    { length: NAVIGATION_ROUTE_MAX_POINTS },
    (_, index) => tail[Math.round((index * (tail.length - 1)) / (NAVIGATION_ROUTE_MAX_POINTS - 1))],
  );
}
