import { NavigationState } from './navigation-state.js';
import { NAVIGATION_LOCATION_STALE_MS } from '../shared/navigation-map.js';

const location = { latitude: 31.19, longitude: 121.32 };
const destination = { latitude: 31.195, longitude: 121.327 };
const routeLine = 'd3lzbnpAb3VkbGZGX2xFPz97bUB7e0M/';

describe('ephemeral navigation map state', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
  });
  afterEach(() => vi.useRealTimers());

  function state(onExpired = vi.fn()) {
    const navigation = new NavigationState(onExpired);
    navigation.ingest('DestinationName', 'Airport', false);
    navigation.ingest('MinutesToArrival', 2, false);
    navigation.ingest('Location', location, false);
    navigation.ingest('DestinationLocation', destination, false);
    return navigation;
  }

  function refresh(navigation: NavigationState, point = location) {
    navigation.ingest('Location', point, false);
    navigation.ingest('DestinationLocation', destination, false);
    navigation.ingest('DestinationName', 'Airport', false);
    navigation.ingest('MinutesToArrival', 2, false);
  }

  it('retains an unchanged route beyond 90 seconds while the same navigation stays fresh', () => {
    const onExpired = vi.fn();
    const navigation = state(onExpired);
    navigation.ingest('RouteLine', routeLine, false);
    for (let index = 0; index < 6; index++) {
      vi.advanceTimersByTime(20_000);
      refresh(navigation);
    }
    expect(navigation.snapshot()?.map).toMatchObject({
      routeUpdatedAtMs: 100_000,
      routeConfirmedAtMs: 220_000,
    });
    expect(navigation.snapshot()?.map?.route).toHaveLength(4);
    expect(onExpired).not.toHaveBeenCalled();
    navigation.dispose();
  });

  it('keeps the final route section until the vehicle enters it', () => {
    const navigation = state();
    const distantLocation = { latitude: 31.15, longitude: 121.25 };
    navigation.ingest('Location', distantLocation, false);
    navigation.ingest('RouteLine', routeLine, false);
    for (let index = 0; index < 6; index++) {
      vi.advanceTimersByTime(20_000);
      refresh(navigation, distantLocation);
    }
    refresh(navigation);
    expect(navigation.snapshot()?.map?.location).toEqual(location);
    expect(navigation.snapshot()?.map?.route).toHaveLength(4);
    navigation.dispose();
  });

  it('does not renew a route from location updates or reads when navigation stops updating', () => {
    const navigation = state();
    navigation.ingest('RouteLine', routeLine, false);
    for (let index = 0; index < 4; index++) {
      vi.advanceTimersByTime(20_000);
      navigation.ingest('Location', location, false);
      navigation.ingest('DestinationLocation', destination, false);
      navigation.ingest('MinutesToArrival', 2, false);
      expect(navigation.snapshot()?.map?.routeConfirmedAtMs).toBe(100_000);
    }
    vi.advanceTimersByTime(10_000);
    expect(navigation.snapshot()).toBeNull();
    refresh(navigation);
    expect(navigation.snapshot()?.map?.route).toBeUndefined();
    navigation.dispose();
  });

  it('expires the map and then navigation even if snapshots are repeatedly requested', () => {
    const navigation = state();
    navigation.ingest('RouteLine', routeLine, false);
    for (let index = 0; index < 5; index++) {
      vi.advanceTimersByTime(5_000);
      expect(navigation.snapshot()?.map?.routeConfirmedAtMs).toBe(100_000);
    }
    vi.advanceTimersByTime(5_000);
    expect(navigation.snapshot()?.map).toBeUndefined();
    vi.advanceTimersByTime(60_000);
    expect(navigation.snapshot()).toBeNull();
    refresh(navigation);
    expect(navigation.snapshot()?.map?.route).toBeUndefined();
    navigation.dispose();
  });

  it('clears a retained route immediately on cancellation and a destination change', () => {
    const navigation = state();
    navigation.ingest('RouteLine', routeLine, false);
    for (let index = 0; index < 6; index++) {
      vi.advanceTimersByTime(20_000);
      refresh(navigation);
    }
    navigation.ingest('RouteLine', null, true);
    refresh(navigation);
    expect(navigation.snapshot()?.map?.route).toBeUndefined();
    navigation.ingest('RouteLine', routeLine, false);
    navigation.ingest('DestinationName', 'New destination', false);
    navigation.ingest('DestinationLocation', destination, false);
    expect(navigation.snapshot()?.map?.route).toBeUndefined();
    navigation.dispose();
  });

  it('publishes location expiry independently of a still-fresh text card', () => {
    const onExpired = vi.fn();
    const navigation = state(onExpired);
    expect(navigation.snapshot()?.map).toMatchObject({ location, destination });
    vi.advanceTimersByTime(NAVIGATION_LOCATION_STALE_MS);
    expect(onExpired).toHaveBeenCalledOnce();
    expect(navigation.snapshot()?.map).toBeUndefined();
    expect(navigation.snapshot()?.destinationName).toBe('Airport');
    navigation.ingest('Location', location, false);
    expect(navigation.snapshot()?.map).toBeDefined();
    navigation.dispose();
  });

  it('rejects invalid coordinates without clearing navigation or retaining an old marker', () => {
    const navigation = state();
    navigation.ingest('Location', { latitude: '31.19', longitude: '121.32' }, false);
    expect(navigation.snapshot()?.map?.location).toEqual(location);
    navigation.ingest('Location', { latitude: 91, longitude: 121.32 }, false);
    expect(navigation.snapshot()?.map).toBeUndefined();
    expect(navigation.snapshot()?.minutesToArrival).toBe(2);
    navigation.dispose();
  });

  it('clears old destination coordinates on a new route and all coordinates on cancellation', () => {
    const navigation = state();
    vi.advanceTimersByTime(2_001);
    navigation.ingest('DestinationName', 'New destination', false);
    navigation.ingest('MinutesToArrival', 1, false);
    expect(navigation.snapshot()?.map).toBeUndefined();
    navigation.ingest('DestinationLocation', destination, false);
    expect(navigation.snapshot()?.map).toBeDefined();
    navigation.ingest('DestinationName', null, true);
    expect(navigation.snapshot()).toBeNull();
    navigation.ingest('DestinationName', 'Airport', false);
    navigation.ingest('MinutesToArrival', 2, false);
    expect(navigation.snapshot()?.map).toBeUndefined();
    navigation.dispose();
  });

  it('keeps an unrelated route out of the snapshot and clears a cancelled route', () => {
    const navigation = state();
    navigation.ingest('RouteLine', 'd3lzbnpAb3VkbGZGX2xFPz97bUB7e0M/', false);
    expect(navigation.snapshot()?.map?.route).toHaveLength(4);
    navigation.ingest('DestinationLocation', { latitude: 32, longitude: 122 }, false);
    expect(navigation.snapshot()?.map?.route).toBeUndefined();
    navigation.ingest('RouteLine', 'd3lzbnpAb3VkbGZGX2xFPz97bUB7e0M/', false);
    expect(navigation.snapshot()?.map?.route).toBeUndefined();
    navigation.ingest('DestinationLocation', destination, false);
    navigation.ingest('RouteLine', 'd3lzbnpAb3VkbGZGX2xFPz97bUB7e0M/', false);
    expect(navigation.snapshot()?.map?.route).toBeDefined();
    navigation.ingest('RouteLine', null, true);
    expect(navigation.snapshot()?.map?.route).toBeUndefined();
    expect(navigation.snapshot()?.map).toBeDefined();
    navigation.dispose();
  });

  it('does not relabel recently resent old coordinates as a new destination', () => {
    const navigation = state();
    vi.advanceTimersByTime(1_000);
    navigation.ingest('DestinationLocation', destination, false);
    navigation.ingest('DestinationName', 'New destination', false);
    expect(navigation.snapshot()?.map).toBeUndefined();
    navigation.dispose();
  });
});
