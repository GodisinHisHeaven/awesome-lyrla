import {
  navigationMapFrameAt,
  navigationMapMotion,
  type NavigationMapFrame,
} from './navigation-map-motion.js';

function frame(latitude = 31, longitude = 121, direction: number | null = 0): NavigationMapFrame {
  return { location: { latitude, longitude }, camera: { x: 0.8, y: 0.4, zoom: 15 }, direction };
}

describe('navigation position interpolation', () => {
  it('moves through a route corner instead of cutting diagonally across it', () => {
    const from = frame();
    const corner = { latitude: 31, longitude: 121.0005 };
    const to = frame(31.0005, 121.0005, 0);
    const motion = navigationMapMotion(from, to, [from.location, corner, to.location], 5_000)!;
    const firstHalf = navigationMapFrameAt(motion, motion.duration * 0.4).location;
    const secondHalf = navigationMapFrameAt(motion, motion.duration * 0.75).location;
    expect(firstHalf.latitude).toBe(31);
    expect(firstHalf.longitude).toBeGreaterThan(121);
    expect(firstHalf.longitude).toBeLessThan(121.0005);
    expect(secondHalf.longitude).toBeCloseTo(121.0005, 8);
    expect(secondHalf.latitude).toBeGreaterThan(31);
    expect(navigationMapFrameAt(motion, 0)).toBe(from);
    expect(navigationMapFrameAt(motion, motion.duration)).toBe(to);
    expect(navigationMapFrameAt(motion, motion.duration * 10)).toBe(to);
  });

  it('keeps off-route observations off-route and rejects a loop detour', () => {
    const from = frame();
    const to = frame(31.0001, 121.0002);
    const farRoute = [frame(31.01, 121.01).location, frame(31.011, 121.011).location];
    expect(navigationMapMotion(from, to, farRoute, 5_000)?.path).toEqual([
      from.location,
      to.location,
    ]);
    const loop = [
      from.location,
      frame(31.001, 121).location,
      frame(31.001, 121.0002).location,
      to.location,
    ];
    expect(navigationMapMotion(from, to, loop, 5_000)?.path).toEqual([from.location, to.location]);
  });

  it('interpolates the camera and takes the shortest heading rotation', () => {
    const from = frame(31, 121, 350);
    const to = { ...frame(31.0001, 121, 10), camera: { x: 0.80001, y: 0.40001, zoom: 16 } };
    const motion = navigationMapMotion(from, to, [], 5_000)!;
    const middle = navigationMapFrameAt(motion, motion.duration / 2);
    expect(middle.camera.x).toBeCloseTo(0.800005, 8);
    expect(middle.camera.y).toBeCloseTo(0.400005, 8);
    expect(middle.camera.zoom).toBe(15.5);
    expect(middle.direction).toBe(360);
  });

  it('crosses the date line over the short distance', () => {
    const from = frame(31, 179.9999);
    const to = frame(31, -179.9999);
    const motion = navigationMapMotion(from, to, [], 5_000)!;
    expect(
      Math.abs(navigationMapFrameAt(motion, motion.duration / 2).location.longitude),
    ).toBeCloseTo(180);
    expect(motion.distance).toBeLessThan(25);
  });

  it('does not animate old observations, long gaps, teleports or implausible speed', () => {
    const from = frame();
    expect(navigationMapMotion(from, frame(31.0001), [], 0)).toBeNull();
    expect(navigationMapMotion(from, frame(31.0001), [], -1)).toBeNull();
    expect(navigationMapMotion(from, frame(31.0001), [], 10_001)).toBeNull();
    expect(navigationMapMotion(from, frame(31.01), [], 5_000)).toBeNull();
    expect(navigationMapMotion(from, frame(31.001), [], 1_000)).toBeNull();
    expect(navigationMapMotion(from, from, [], 5_000)).toBeNull();
  });
});
