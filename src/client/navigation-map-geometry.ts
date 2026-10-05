import type { NavigationCoordinate, NavigationMapSnapshot } from '../shared/contracts.js';
import { nearestNavigationRouteSegment } from '../shared/navigation-map.js';

interface Point {
  x: number;
  y: number;
}
export interface NavigationMapCamera {
  x: number;
  y: number;
  zoom: number;
}
export interface MapTile extends Point {
  key: string;
  column: number;
  row: number;
  zoom: number;
  size: number;
}

function mercator(point: NavigationCoordinate, referenceLongitude: number): Point {
  const latitude = Math.max(-85.05112878, Math.min(85.05112878, point.latitude));
  let longitude = point.longitude;
  while (longitude - referenceLongitude > 180) longitude -= 360;
  while (longitude - referenceLongitude < -180) longitude += 360;
  const radians = (latitude * Math.PI) / 180;
  return { x: (longitude + 180) / 360, y: (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 };
}

function routeDirection(location: Point, route: Point[]): number | null {
  let closestDistance = Infinity;
  let direction: number | null = null;
  for (let i = 1; i < route.length; i++) {
    const start = route[i - 1];
    const end = route[i];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared < 1e-6) continue;
    const progress = Math.max(
      0,
      Math.min(1, ((location.x - start.x) * dx + (location.y - start.y) * dy) / lengthSquared),
    );
    const distance = Math.hypot(
      location.x - start.x - progress * dx,
      location.y - start.y - progress * dy,
    );
    // At a corner prefer the next segment, rather than pointing back at the
    // segment just travelled. This estimates route direction, not GPS heading.
    if (distance <= closestDistance + 1e-6) {
      closestDistance = distance;
      direction = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
    }
  }
  const end = route.at(-1);
  if (end && Math.hypot(location.x - end.x, location.y - end.y) < 2) return null;
  return direction;
}

export function navigationMapGeometry(
  map: NavigationMapSnapshot,
  width: number,
  height: number,
  routeIsFresh: boolean,
  camera?: NavigationMapCamera,
) {
  // Render the section ahead of the closest route segment; never invent a road
  // connection if the vehicle is off-route or Tesla has not supplied a route.
  let route = routeIsFresh ? (map.route ?? []) : [];
  if (route.length) {
    const closest = nearestNavigationRouteSegment(map.location, route);
    route =
      closest && closest.distanceMeters <= 500
        ? [closest.point, ...route.slice(closest.index + 1)]
        : [];
  }
  const coordinates = [map.location, map.destination, ...route];
  const points = coordinates.map((point) => mercator(point, map.destination.longitude));
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const fit = Math.min(
    (width - 88) / Math.max(maxX - minX, 1e-9),
    (height - 88) / Math.max(maxY - minY, 1e-9),
  );
  const viewport = camera ?? {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    zoom: Math.max(0, Math.min(17, Math.floor(Math.log2(Math.max(256, fit) / 256)))),
  };
  const zoom = Math.floor(viewport.zoom);
  const scale = 256 * 2 ** viewport.zoom;
  const tileSize = 256 * 2 ** (viewport.zoom - zoom);
  const left = viewport.x * scale - width / 2;
  const top = viewport.y * scale - height / 2;
  const project = (point: Point): Point => ({
    x: point.x * scale - left,
    y: point.y * scale - top,
  });
  const tiles: MapTile[] = [];
  const columns = 2 ** zoom;
  for (
    let column = Math.floor(left / tileSize);
    column < Math.ceil((left + width) / tileSize);
    column++
  ) {
    for (let row = Math.floor(top / tileSize); row < Math.ceil((top + height) / tileSize); row++) {
      if (row < 0 || row >= columns) continue;
      const wrappedColumn = ((column % columns) + columns) % columns;
      tiles.push({
        key: `${zoom}/${wrappedColumn}/${row}`,
        column: wrappedColumn,
        row,
        zoom,
        x: column * tileSize - left,
        y: row * tileSize - top,
        size: tileSize,
      });
    }
  }
  const location = project(points[0]);
  const projectedRoute = points.slice(2).map(project);
  return {
    camera: viewport,
    tiles,
    location,
    destination: project(points[1]),
    route: projectedRoute,
    routeDirectionDegrees: routeDirection(location, projectedRoute),
  };
}
