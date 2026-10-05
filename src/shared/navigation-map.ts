import type {
  NavigationCoordinate,
  NavigationMapSnapshot,
  NavigationSnapshot,
} from './contracts.js';

export const NAVIGATION_LOCATION_STALE_MS = 30_000;
export const NAVIGATION_MAP_STALE_MS = 90_000;
export const NAVIGATION_ROUTE_MAX_POINTS = 256;

export function isNavigationCoordinate(value: unknown): value is NavigationCoordinate {
  if (!value || typeof value !== 'object') return false;
  const point = value as NavigationCoordinate;
  return (
    Number.isFinite(point.latitude) &&
    Math.abs(point.latitude) <= 90 &&
    Number.isFinite(point.longitude) &&
    Math.abs(point.longitude) <= 180
  );
}

export function isNavigationMap(value: unknown): value is NavigationMapSnapshot {
  if (!value || typeof value !== 'object') return false;
  const map = value as NavigationMapSnapshot;
  return (
    isNavigationCoordinate(map.location) &&
    isNavigationCoordinate(map.destination) &&
    Number.isFinite(map.locationUpdatedAtMs) &&
    Number.isFinite(map.destinationUpdatedAtMs) &&
    (map.routeConfirmedAtMs === undefined || Number.isFinite(map.routeConfirmedAtMs)) &&
    (map.route === undefined ||
      (Array.isArray(map.route) &&
        map.route.length >= 2 &&
        map.route.length <= NAVIGATION_ROUTE_MAX_POINTS &&
        map.route.every(isNavigationCoordinate) &&
        Number.isFinite(map.routeUpdatedAtMs)))
  );
}

export function navigationRouteIsFresh(map: NavigationMapSnapshot, now: number): boolean {
  const updatedAt = Math.max(map.routeUpdatedAtMs ?? 0, map.routeConfirmedAtMs ?? 0);
  return Boolean(
    map.route?.length &&
    navigationMapIsFresh(map, now) &&
    now >= updatedAt &&
    now - updatedAt < NAVIGATION_MAP_STALE_MS,
  );
}

export function navigationMapIsFresh(
  map: NavigationMapSnapshot | undefined,
  now: number,
): map is NavigationMapSnapshot {
  return (
    isNavigationMap(map) &&
    now >= map.locationUpdatedAtMs &&
    now - map.locationUpdatedAtMs < NAVIGATION_LOCATION_STALE_MS &&
    now >= map.destinationUpdatedAtMs &&
    now - map.destinationUpdatedAtMs < NAVIGATION_MAP_STALE_MS
  );
}

export function isNearArrival(navigation: NavigationSnapshot): boolean {
  return (
    navigation.minutesToArrival <= 3 ||
    (navigation.distanceToArrivalMiles !== undefined &&
      navigation.distanceToArrivalMiles * 1_609.344 <= 1_000)
  );
}

export function coordinateDistanceMeters(a: NavigationCoordinate, b: NavigationCoordinate): number {
  const radians = Math.PI / 180;
  const latDelta = (b.latitude - a.latitude) * radians;
  const lonDelta = (b.longitude - a.longitude) * radians;
  const h =
    Math.sin(latDelta / 2) ** 2 +
    Math.cos(a.latitude * radians) * Math.cos(b.latitude * radians) * Math.sin(lonDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}

/** Find the closest point on a supplied route; a long segment is still a road. */
export function nearestNavigationRouteSegment(
  location: NavigationCoordinate,
  route: NavigationCoordinate[],
) {
  let closest: { index: number; point: NavigationCoordinate; distanceMeters: number } | null = null;
  const longitudeDelta = (from: number, to: number) => ((to - from + 540) % 360) - 180;
  const cosLatitude = Math.cos((location.latitude * Math.PI) / 180);
  for (let index = 0; index < route.length - 1; index++) {
    const start = route[index];
    const end = route[index + 1];
    const longitude = longitudeDelta(start.longitude, end.longitude);
    const dx = longitude * cosLatitude;
    const dy = end.latitude - start.latitude;
    const lengthSquared = dx * dx + dy * dy;
    const progress =
      lengthSquared === 0
        ? 0
        : Math.max(
            0,
            Math.min(
              1,
              (longitudeDelta(start.longitude, location.longitude) * cosLatitude * dx +
                (location.latitude - start.latitude) * dy) /
                lengthSquared,
            ),
          );
    const point = {
      latitude: start.latitude + dy * progress,
      longitude: ((start.longitude + longitude * progress + 540) % 360) - 180,
    };
    const distanceMeters = coordinateDistanceMeters(location, point);
    if (!closest || distanceMeters <= closest.distanceMeters + 1e-6)
      closest = { index, point, distanceMeters };
  }
  return closest;
}
