import type { NavigationMapSnapshot } from '../shared/contracts.js';
import { navigationMapGeometry } from './navigation-map-geometry.js';

function map(locationLongitude = 121.32, destinationLongitude = 121.327): NavigationMapSnapshot {
  return {
    location: { latitude: 31.19, longitude: locationLongitude },
    locationUpdatedAtMs: 1,
    destination: { latitude: 31.195, longitude: destinationLongitude },
    destinationUpdatedAtMs: 1,
  };
}

describe('small navigation map viewport', () => {
  it('fits both markers and requests only visible tiles', () => {
    const geometry = navigationMapGeometry(map(), 400, 210, true);
    for (const point of [geometry.location, geometry.destination]) {
      expect(point.x).toBeGreaterThanOrEqual(44);
      expect(point.x).toBeLessThanOrEqual(356);
      expect(point.y).toBeGreaterThanOrEqual(44);
      expect(point.y).toBeLessThanOrEqual(166);
    }
    expect(geometry.tiles.length).toBeLessThanOrEqual(9);
    for (const tile of geometry.tiles) {
      expect(tile.x).toBeLessThan(400);
      expect(tile.x + 256).toBeGreaterThan(0);
      expect(tile.y).toBeLessThan(210);
      expect(tile.y + 256).toBeGreaterThan(0);
    }
    expect(geometry.route).toEqual([]);
  });

  it('wraps the date line instead of zooming out to the whole world', () => {
    const geometry = navigationMapGeometry(map(179.999, -179.998), 400, 210, false);
    expect(geometry.tiles[0].zoom).toBeGreaterThanOrEqual(13);
    expect(geometry.tiles.every((tile) => tile.column >= 0 && tile.column < 2 ** tile.zoom)).toBe(
      true,
    );
    expect(Math.abs(geometry.location.x - geometry.destination.x)).toBeLessThan(356);
  });

  it('keeps tiles and markers aligned while the camera pans and zooms between tile levels', () => {
    const current = map();
    const start = navigationMapGeometry(current, 400, 210, false);
    const camera = { ...start.camera, x: start.camera.x + 0.00001, zoom: start.camera.zoom + 0.5 };
    const middle = navigationMapGeometry(current, 400, 210, false, camera);
    const tileSize = 256 * Math.sqrt(2);
    expect(middle.camera).toEqual(camera);
    expect(middle.tiles.length).toBeLessThanOrEqual(9);
    expect(middle.tiles[0].size).toBeCloseTo(tileSize);
    expect(middle.tiles.every((tile) => tile.zoom === start.camera.zoom)).toBe(true);
    const left = camera.x * 256 * 2 ** camera.zoom - 200;
    for (const tile of middle.tiles) expect(tile.x).toBeCloseTo(tile.column * tileSize - left);
    expect(middle.location.x).toBeCloseTo(
      (start.location.x - 200) * Math.sqrt(2) + 200 - 0.00001 * 256 * 2 ** camera.zoom,
    );
  });

  it('does not join an off-route vehicle to an unrelated route or show an expired route', () => {
    const current = map();
    current.route = [{ latitude: 31.25, longitude: 121.4 }, current.destination];
    expect(navigationMapGeometry(current, 400, 210, true).route).toEqual([]);
    current.route = [current.location, current.destination];
    expect(navigationMapGeometry(current, 400, 210, false).route).toEqual([]);
    expect(navigationMapGeometry(current, 400, 210, false).routeDirectionDegrees).toBeNull();
    expect(navigationMapGeometry(current, 400, 210, true).route).toHaveLength(2);
  });

  it('renders a long road segment when both vertices are over 500 meters from the vehicle', () => {
    const current = map();
    current.destination = { latitude: 31.19, longitude: 121.34 };
    current.route = [{ latitude: 31.19, longitude: 121.3 }, current.destination];
    const geometry = navigationMapGeometry(current, 598, 360, true);
    expect(geometry.route).toHaveLength(2);
    expect(geometry.route[0].x).toBeCloseTo(geometry.location.x);
    expect(geometry.route[0].y).toBeCloseTo(geometry.location.y);
    expect(geometry.route[1]).toEqual(geometry.destination);
    expect(geometry.routeDirectionDegrees).toBeCloseTo(90);
  });

  it('keeps an off-road marker separate from the supplied road and rejects a distant road', () => {
    const current = map();
    current.destination = { latitude: 31.19, longitude: 121.34 };
    current.route = [{ latitude: 31.19, longitude: 121.3 }, current.destination];
    current.location.latitude = 31.192;
    const geometry = navigationMapGeometry(current, 598, 360, true);
    expect(geometry.route).toHaveLength(2);
    expect(geometry.route[0].y).not.toBeCloseTo(geometry.location.y);
    current.location.latitude = 31.2;
    expect(navigationMapGeometry(current, 598, 360, true).route).toEqual([]);
  });

  it('finds a road segment crossing the date line', () => {
    const current = map(180, -179.98);
    current.destination.latitude = current.location.latitude;
    current.route = [{ latitude: 31.19, longitude: 179.98 }, current.destination];
    const geometry = navigationMapGeometry(current, 598, 360, true);
    expect(geometry.route).toHaveLength(2);
    expect(geometry.route[0].x).toBeCloseTo(geometry.location.x);
    expect(geometry.routeDirectionDegrees).toBeCloseTo(90);
  });

  it('points the route marker east and north in a north-up map', () => {
    const current = map();
    current.destination = { latitude: current.location.latitude, longitude: 121.325 };
    current.route = [current.location, current.destination];
    expect(navigationMapGeometry(current, 400, 210, true).routeDirectionDegrees).toBeCloseTo(90);
    current.destination = { latitude: 31.195, longitude: current.location.longitude };
    current.route = [current.location, current.destination];
    expect(navigationMapGeometry(current, 400, 210, true).routeDirectionDegrees).toBeCloseTo(0);
  });

  it('uses the outgoing direction at a corner and ignores duplicate route points', () => {
    const current = map();
    current.destination = { latitude: 31.195, longitude: current.location.longitude };
    current.route = [
      { latitude: current.location.latitude, longitude: current.location.longitude - 0.001 },
      current.location,
      current.location,
      current.destination,
    ];
    expect(navigationMapGeometry(current, 400, 210, true).routeDirectionDegrees).toBeCloseTo(0);
  });

  it('shows no direction when the vehicle reaches the route end or the route has no direction', () => {
    const current = map();
    current.route = [current.location, current.destination];
    current.location = current.destination;
    expect(navigationMapGeometry(current, 400, 210, true).routeDirectionDegrees).toBeNull();
    current.route = [current.location, current.location];
    expect(navigationMapGeometry(current, 400, 210, true).routeDirectionDegrees).toBeNull();
  });
});
