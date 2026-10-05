import type { NavigationCoordinate } from '../shared/contracts.js';
import { coordinateDistanceMeters } from '../shared/navigation-map.js';
import type { NavigationMapCamera } from './navigation-map-geometry.js';

export interface NavigationMapFrame {
  location: NavigationCoordinate;
  camera: NavigationMapCamera;
  direction: number | null;
}

export interface NavigationMapMotion {
  from: NavigationMapFrame;
  to: NavigationMapFrame;
  path: NavigationCoordinate[];
  lengths: number[];
  distance: number;
  duration: number;
}

function longitudeDelta(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

function interpolateCoordinate(
  from: NavigationCoordinate,
  to: NavigationCoordinate,
  progress: number,
): NavigationCoordinate {
  return {
    latitude: from.latitude + (to.latitude - from.latitude) * progress,
    longitude:
      ((from.longitude + longitudeDelta(from.longitude, to.longitude) * progress + 540) % 360) -
      180,
  };
}

function closestSegment(point: NavigationCoordinate, route: NavigationCoordinate[]) {
  let closest: { index: number; progress: number; distance: number } | undefined;
  const cosLatitude = Math.cos((point.latitude * Math.PI) / 180);
  for (let index = 0; index < route.length - 1; index++) {
    const start = route[index];
    const end = route[index + 1];
    const dx = longitudeDelta(start.longitude, end.longitude) * cosLatitude;
    const dy = end.latitude - start.latitude;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared < 1e-16) continue;
    const progress = Math.max(
      0,
      Math.min(
        1,
        (longitudeDelta(start.longitude, point.longitude) * cosLatitude * dx +
          (point.latitude - start.latitude) * dy) /
          lengthSquared,
      ),
    );
    const distance = coordinateDistanceMeters(point, interpolateCoordinate(start, end, progress));
    if (!closest || distance <= closest.distance) closest = { index, progress, distance };
  }
  return closest;
}

function motionPath(
  from: NavigationCoordinate,
  to: NavigationCoordinate,
  route: NavigationCoordinate[],
) {
  const start = closestSegment(from, route);
  const end = closestSegment(to, route);
  // Only follow a nearby, forward section of the supplied route. Do not snap an
  // off-route position onto a road or take a detour through a route loop.
  if (
    !start ||
    !end ||
    start.distance > 35 ||
    end.distance > 35 ||
    end.index + end.progress < start.index + start.progress
  )
    return [from, to];
  const path = [from, ...route.slice(start.index + 1, end.index + 1), to];
  const distance = path
    .slice(1)
    .reduce((sum, point, i) => sum + coordinateDistanceMeters(path[i], point), 0);
  return distance <= Math.max(40, coordinateDistanceMeters(from, to) * 3) ? path : [from, to];
}

export function sameNavigationFrame(a: NavigationMapFrame, b: NavigationMapFrame): boolean {
  return (
    a.location.latitude === b.location.latitude &&
    a.location.longitude === b.location.longitude &&
    a.camera.x === b.camera.x &&
    a.camera.y === b.camera.y &&
    a.camera.zoom === b.camera.zoom &&
    a.direction === b.direction
  );
}

export function navigationMapMotion(
  from: NavigationMapFrame,
  to: NavigationMapFrame,
  route: NavigationCoordinate[],
  sampleIntervalMs: number,
): NavigationMapMotion | null {
  if (sampleIntervalMs <= 0 || sampleIntervalMs > 10_000 || sameNavigationFrame(from, to))
    return null;
  const path = motionPath(from.location, to.location, route);
  const lengths = path.slice(1).map((point, i) => coordinateDistanceMeters(path[i], point));
  const distance = lengths.reduce((sum, length) => sum + length, 0);
  if (distance > 300 || distance / (sampleIntervalMs / 1_000) > 55) return null;
  return {
    from,
    to,
    path,
    lengths,
    distance,
    duration: Math.max(400, Math.min(1_500, sampleIntervalMs / 4)),
  };
}

export function navigationMapFrameAt(
  motion: NavigationMapMotion,
  elapsedMs: number,
): NavigationMapFrame {
  const progress = Math.max(0, Math.min(1, elapsedMs / motion.duration));
  if (progress === 0) return motion.from;
  if (progress === 1) return motion.to;
  const eased = progress * progress * (3 - 2 * progress);
  let remaining = motion.distance * eased;
  let location = motion.to.location;
  for (let i = 0; i < motion.lengths.length; i++) {
    const length = motion.lengths[i];
    if (remaining <= length && length > 0) {
      location = interpolateCoordinate(motion.path[i], motion.path[i + 1], remaining / length);
      break;
    }
    remaining -= length;
  }
  const { from, to } = motion;
  return {
    location,
    camera: {
      x: from.camera.x + (to.camera.x - from.camera.x) * eased,
      y: from.camera.y + (to.camera.y - from.camera.y) * eased,
      zoom: from.camera.zoom + (to.camera.zoom - from.camera.zoom) * eased,
    },
    direction:
      from.direction === null || to.direction === null
        ? to.direction
        : from.direction + longitudeDelta(from.direction, to.direction) * eased,
  };
}
