// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { NavigationMapSnapshot } from '../../shared/contracts.js';
import NavigationMap from './NavigationMap.js';
import { navigationMapGeometry } from '../navigation-map-geometry.js';

const map: NavigationMapSnapshot = {
  location: { latitude: 31.18942, longitude: 121.32644 },
  locationUpdatedAtMs: 100_000,
  destination: { latitude: 31.19521, longitude: 121.32719 },
  destinationUpdatedAtMs: 100_000,
  route: [
    { latitude: 31.18942, longitude: 121.32644 },
    { latitude: 31.19521, longitude: 121.32719 },
  ],
  routeUpdatedAtMs: 100_000,
};

describe('navigation base map', () => {
  it('loads bounded visible tiles and retains licence attribution when a tile fails', () => {
    const { container } = render(<NavigationMap map={map} now={100_000} />);
    const tiles = [...container.querySelectorAll('img')];
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.length).toBeLessThanOrEqual(9);
    for (const tile of tiles)
      expect(tile.src).toMatch(/^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/);
    expect(screen.getByRole('link')).toHaveTextContent('© OpenStreetMap contributors');
    fireEvent.error(tiles[0]);
    expect(screen.getByText('底图暂不可用')).toBeInTheDocument();
    expect(container.querySelectorAll('polyline')).toHaveLength(2);
    expect(screen.getByRole('img')).toBeInTheDocument();
  });

  it('drops an expired route and retains the same tile DOM across progress updates', () => {
    const { container, rerender } = render(<NavigationMap map={map} now={100_000} />);
    const tile = container.querySelector('img');
    rerender(<NavigationMap map={{ ...map }} now={100_001} />);
    expect(container.querySelector('img')).toBe(tile);
    rerender(<NavigationMap map={map} now={190_000} />);
    expect(container.querySelectorAll('polyline')).toHaveLength(0);
    expect(container.querySelector('.am-navigation-map-location path')).toBeNull();
    expect(container.querySelector('.am-navigation-map-location circle')).toBeInTheDocument();
  });

  it('draws an old route confirmed by fresh navigation and drops it when that confirmation expires', () => {
    const confirmed = {
      ...map,
      locationUpdatedAtMs: 220_000,
      destinationUpdatedAtMs: 220_000,
      routeConfirmedAtMs: 220_000,
    };
    const { container, rerender } = render(<NavigationMap map={confirmed} now={220_000} />);
    expect(container.querySelectorAll('polyline')).toHaveLength(2);
    expect(container.querySelector('polyline[stroke="#3e6ae1"]')).toBeInTheDocument();
    rerender(
      <NavigationMap
        map={{ ...confirmed, locationUpdatedAtMs: 310_000, destinationUpdatedAtMs: 310_000 }}
        now={310_000}
      />,
    );
    expect(container.querySelectorAll('polyline')).toHaveLength(0);
    container.querySelectorAll('img').forEach((tile) => fireEvent.load(tile));
    expect(screen.getByText('等待车辆路线')).toBeInTheDocument();
  });

  it('requires a fresh map and rejects an old route without a confirmation', () => {
    const { container, rerender } = render(
      <NavigationMap map={{ ...map, routeConfirmedAtMs: 220_000 }} now={220_000} />,
    );
    expect(container.querySelectorAll('polyline')).toHaveLength(0);
    rerender(
      <NavigationMap
        map={{ ...map, locationUpdatedAtMs: 220_000, destinationUpdatedAtMs: 220_000 }}
        now={220_000}
      />,
    );
    expect(container.querySelectorAll('polyline')).toHaveLength(0);
    rerender(
      <NavigationMap
        map={{
          ...map,
          locationUpdatedAtMs: 220_000,
          destinationUpdatedAtMs: 220_000,
          routeConfirmedAtMs: 220_001,
        }}
        now={220_000}
      />,
    );
    expect(container.querySelectorAll('polyline')).toHaveLength(0);
  });
});

describe('smooth navigation updates', () => {
  let clock = 0;
  let id = 0;
  let hidden = false;
  let callbacks: Map<number, FrameRequestCallback>;
  const moved = (latitude: number, at: number): NavigationMapSnapshot => ({
    ...map,
    location: { ...map.location, latitude },
    locationUpdatedAtMs: at,
  });
  const transformFor = (value: NavigationMapSnapshot) => {
    const { location } = navigationMapGeometry(value, 400, 210, true);
    return `translate(${location.x},${location.y})`;
  };
  const advance = (elapsed: number) => {
    clock += elapsed;
    const pending = [...callbacks.values()];
    callbacks.clear();
    act(() => pending.forEach((callback) => callback(clock)));
  };
  beforeEach(() => {
    clock = 0;
    id = 0;
    hidden = false;
    callbacks = new Map();
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callbacks.set(++id, callback);
      return id;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((frame) => {
      callbacks.delete(frame);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows intermediate positions, reaches the observation and leaves no idle animation', () => {
    const { container, rerender } = render(<NavigationMap map={map} now={100_000} />);
    const marker = () =>
      container.querySelector('.am-navigation-map-location')!.getAttribute('transform');
    const start = marker();
    const next = moved(31.18982, 105_000);
    rerender(<NavigationMap map={next} now={105_000} />);
    expect(marker()).toBe(start);
    advance(625);
    expect(marker()).not.toBe(start);
    expect(marker()).not.toBe(transformFor(next));
    const pending = [...callbacks.keys()];
    rerender(
      <NavigationMap
        map={{ ...next, route: next.route?.map((point) => ({ ...point })) }}
        now={105_001}
      />,
    );
    expect([...callbacks.keys()]).toEqual(pending);
    advance(625);
    expect(marker()).toBe(transformFor(next));
    expect(callbacks.size).toBe(0);
  });

  it('retargets from the displayed position and ignores an older location', () => {
    const { container, rerender, unmount } = render(<NavigationMap map={map} now={100_000} />);
    const marker = () =>
      container.querySelector('.am-navigation-map-location')!.getAttribute('transform');
    rerender(<NavigationMap map={moved(31.18982, 105_000)} now={105_000} />);
    advance(625);
    const middle = marker();
    const next = moved(31.18992, 106_000);
    rerender(<NavigationMap map={next} now={106_000} />);
    advance(0);
    expect(marker()).toBe(middle);
    rerender(<NavigationMap map={map} now={106_000} />);
    advance(400);
    expect(marker()).toBe(transformFor(next));
    unmount();
    expect(callbacks.size).toBe(0);
  });

  it('snaps after a gap or destination change and stops when the route expires', () => {
    const { container, rerender } = render(<NavigationMap map={map} now={100_000} />);
    const marker = () =>
      container.querySelector('.am-navigation-map-location')!.getAttribute('transform');
    const afterGap = moved(31.18982, 115_000);
    rerender(<NavigationMap map={afterGap} now={115_000} />);
    expect(callbacks.size).toBe(0);
    expect(marker()).toBe(transformFor(afterGap));
    const next = moved(31.19002, 120_000);
    rerender(<NavigationMap map={next} now={120_000} />);
    expect(callbacks.size).toBe(1);
    rerender(<NavigationMap map={next} now={190_000} />);
    expect(callbacks.size).toBe(0);
    expect(container.querySelectorAll('polyline')).toHaveLength(0);
    const newDestination = {
      ...next,
      destination: { latitude: 31.195, longitude: 121.33 },
      destinationUpdatedAtMs: 195_000,
      locationUpdatedAtMs: 195_000,
      routeUpdatedAtMs: 195_000,
    };
    rerender(<NavigationMap map={newDestination} now={195_000} />);
    expect(callbacks.size).toBe(0);
    expect(marker()).toBe(transformFor(newDestination));
  });

  it('stops off-screen work and resumes at the latest observation', () => {
    const { container, rerender } = render(<NavigationMap map={map} now={100_000} />);
    const next = moved(31.18982, 105_000);
    rerender(<NavigationMap map={next} now={105_000} />);
    advance(200);
    hidden = true;
    fireEvent(document, new Event('visibilitychange'));
    expect(callbacks.size).toBe(0);
    const latest = moved(31.19002, 110_000);
    rerender(<NavigationMap map={latest} now={110_000} />);
    hidden = false;
    fireEvent(document, new Event('visibilitychange'));
    expect(container.querySelector('.am-navigation-map-location')).toHaveAttribute(
      'transform',
      transformFor(latest),
    );
    expect(callbacks.size).toBe(0);
  });

  it('honors a reduced motion preference without scheduling frames', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
    const { container, rerender } = render(<NavigationMap map={map} now={100_000} />);
    const next = moved(31.18982, 105_000);
    rerender(<NavigationMap map={next} now={105_000} />);
    expect(container.querySelector('.am-navigation-map-location')).toHaveAttribute(
      'transform',
      transformFor(next),
    );
    expect(callbacks.size).toBe(0);
  });
});
