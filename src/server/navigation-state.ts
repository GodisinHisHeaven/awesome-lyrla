import type { NavigationCoordinate, NavigationSnapshot } from '../shared/contracts.js';
import {
  coordinateDistanceMeters,
  isNavigationCoordinate,
  NAVIGATION_LOCATION_STALE_MS,
  NAVIGATION_MAP_STALE_MS,
} from '../shared/navigation-map.js';
import { decodeNavigationRoute } from './navigation-route.js';

export const NAVIGATION_STALE_AFTER_MS = 90_000;
const NAVIGATION_BURST_GRACE_MS = 2_000;

export type NavigationField =
  | 'DestinationName'
  | 'MinutesToArrival'
  | 'MilesToArrival'
  | 'ExpectedEnergyPercentAtTripArrival'
  | 'Location'
  | 'DestinationLocation'
  | 'RouteLine';

export interface NavigationUpdate {
  accepted: boolean;
  changed: boolean;
}

type NavigationValue = unknown;

function numericValue(value: NavigationValue): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function locationValue(value: unknown): NavigationCoordinate | null {
  if (!value || typeof value !== 'object') return null;
  const object = value as Record<string, unknown>;
  const latitude = numericValue(object.latitude);
  const longitude = numericValue(object.longitude);
  const point = { latitude, longitude };
  return isNavigationCoordinate(point) ? point : null;
}

/** Owns navigation telemetry state and its freshness timer. */
export class NavigationState {
  private destinationName = '';
  private minutesToArrival: number | null = null;
  private destinationUpdatedAtMs = 0;
  private minutesUpdatedAtMs = 0;
  private distanceToArrivalMiles: number | null = null;
  private distanceUpdatedAtMs = 0;
  private arrivalBatteryPercent: number | null = null;
  private arrivalBatteryUpdatedAtMs = 0;
  private location: NavigationCoordinate | null = null;
  private locationUpdatedAtMs = 0;
  private destinationLocation: NavigationCoordinate | null = null;
  private destinationLocationUpdatedAtMs = 0;
  private route: NavigationCoordinate[] | null = null;
  private routeUpdatedAtMs = 0;
  private routeConfirmedAtMs = 0;
  private encodedRoute = '';
  private expiryTimer?: NodeJS.Timeout;

  constructor(private readonly onExpired: () => void) {}

  snapshot(now = Date.now()): NavigationSnapshot | null {
    if (
      !this.destinationName ||
      this.minutesToArrival === null ||
      now - this.destinationUpdatedAtMs >= NAVIGATION_STALE_AFTER_MS ||
      now - this.minutesUpdatedAtMs >= NAVIGATION_STALE_AFTER_MS
    )
      return null;
    const arrivalBatteryIsFresh =
      this.arrivalBatteryPercent !== null &&
      now - this.arrivalBatteryUpdatedAtMs < NAVIGATION_STALE_AFTER_MS;
    const distanceIsFresh =
      this.distanceToArrivalMiles !== null &&
      now - this.distanceUpdatedAtMs < NAVIGATION_STALE_AFTER_MS;
    const mapIsFresh =
      this.location !== null &&
      this.destinationLocation !== null &&
      now - this.locationUpdatedAtMs < NAVIGATION_LOCATION_STALE_MS &&
      now - this.destinationLocationUpdatedAtMs < NAVIGATION_MAP_STALE_MS;
    // Do not draw a route from the previous destination during a telemetry burst.
    const routeIsFresh =
      this.route !== null &&
      this.destinationLocation !== null &&
      now - Math.max(this.routeUpdatedAtMs, this.routeConfirmedAtMs) < NAVIGATION_MAP_STALE_MS &&
      coordinateDistanceMeters(this.route[this.route.length - 1], this.destinationLocation) <= 250;
    return {
      destinationName: this.destinationName,
      minutesToArrival: this.minutesToArrival,
      updatedAtMs: this.minutesUpdatedAtMs,
      ...(distanceIsFresh ? { distanceToArrivalMiles: this.distanceToArrivalMiles! } : {}),
      ...(arrivalBatteryIsFresh ? { arrivalBatteryPercent: this.arrivalBatteryPercent! } : {}),
      ...(mapIsFresh
        ? {
            map: {
              location: this.location!,
              locationUpdatedAtMs: this.locationUpdatedAtMs,
              destination: this.destinationLocation!,
              destinationUpdatedAtMs: this.destinationLocationUpdatedAtMs,
              ...(routeIsFresh
                ? {
                    route: this.route!,
                    routeUpdatedAtMs: this.routeUpdatedAtMs,
                    ...(this.routeConfirmedAtMs
                      ? { routeConfirmedAtMs: this.routeConfirmedAtMs }
                      : {}),
                  }
                : {}),
            },
          }
        : {}),
    };
  }

  hasCoreState(): boolean {
    return Boolean(this.destinationName || this.minutesToArrival !== null);
  }

  ingest(
    field: NavigationField,
    value: NavigationValue,
    invalid: boolean,
    now = Date.now(),
  ): NavigationUpdate {
    if (field === 'Location' || field === 'DestinationLocation') {
      const point = invalid ? null : locationValue(value);
      if (field === 'Location') {
        this.location = point;
        this.locationUpdatedAtMs = point ? now : 0;
      } else {
        if (
          point &&
          this.destinationLocation &&
          coordinateDistanceMeters(point, this.destinationLocation) > 250
        ) {
          this.clearRoute();
        }
        this.destinationLocation = point;
        this.destinationLocationUpdatedAtMs = point ? now : 0;
        if (!point) this.clearRoute();
      }
      this.confirmRoute(now);
      this.scheduleExpiry();
      return { accepted: true, changed: true };
    }
    if (field === 'RouteLine') {
      if (invalid || typeof value !== 'string') {
        this.clearRoute();
      } else {
        if (value !== this.encodedRoute) {
          this.route = decodeNavigationRoute(value);
          this.encodedRoute = this.route ? value : '';
          this.routeConfirmedAtMs = 0;
        }
        this.routeUpdatedAtMs = this.route ? now : 0;
      }
      this.confirmRoute(now);
      this.scheduleExpiry();
      return { accepted: true, changed: true };
    }
    if (field === 'ExpectedEnergyPercentAtTripArrival') {
      const batteryPercent = numericValue(value);
      const hadBattery = this.arrivalBatteryPercent !== null;
      if (invalid || batteryPercent === null || batteryPercent < 0 || batteryPercent > 100) {
        this.arrivalBatteryPercent = null;
        this.arrivalBatteryUpdatedAtMs = 0;
        return { accepted: true, changed: hadBattery };
      }
      this.arrivalBatteryPercent = batteryPercent;
      this.arrivalBatteryUpdatedAtMs = now;
      return { accepted: true, changed: true };
    }

    if (field === 'MilesToArrival') {
      const distanceToArrivalMiles = numericValue(value);
      const hadDistance = this.distanceToArrivalMiles !== null;
      if (invalid || distanceToArrivalMiles === null || distanceToArrivalMiles < 0) {
        this.distanceToArrivalMiles = null;
        this.distanceUpdatedAtMs = 0;
        return { accepted: true, changed: hadDistance };
      }
      this.distanceToArrivalMiles = distanceToArrivalMiles;
      this.distanceUpdatedAtMs = now;
      return { accepted: true, changed: true };
    }

    const hadCoreState = this.hasCoreState();
    if (invalid) {
      this.clear();
      return { accepted: true, changed: hadCoreState };
    }

    if (field === 'DestinationName') {
      const destinationName = typeof value === 'string' ? value.trim() : '';
      if (!destinationName) return { accepted: false, changed: false };
      if (this.destinationName && destinationName !== this.destinationName) {
        this.arrivalBatteryPercent = null;
        this.arrivalBatteryUpdatedAtMs = 0;
        this.distanceToArrivalMiles = null;
        this.distanceUpdatedAtMs = 0;
        // MQTT fields are independent; a recent resend can still belong to
        // the old destination. Wait for coordinates after the name change.
        this.destinationLocation = null;
        this.destinationLocationUpdatedAtMs = 0;
        this.clearRoute();
        if (now - this.minutesUpdatedAtMs > NAVIGATION_BURST_GRACE_MS) {
          this.minutesToArrival = null;
          this.minutesUpdatedAtMs = 0;
        }
      }
      this.destinationName = destinationName;
      this.destinationUpdatedAtMs = now;
    } else {
      const minutesToArrival = numericValue(value);
      if (minutesToArrival === null || minutesToArrival < 0) {
        return { accepted: false, changed: false };
      }
      this.minutesToArrival = minutesToArrival;
      this.minutesUpdatedAtMs = now;
    }

    this.confirmRoute(now);
    this.scheduleExpiry();
    return { accepted: true, changed: true };
  }

  clear(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    this.destinationName = '';
    this.minutesToArrival = null;
    this.destinationUpdatedAtMs = 0;
    this.minutesUpdatedAtMs = 0;
    this.distanceToArrivalMiles = null;
    this.distanceUpdatedAtMs = 0;
    this.arrivalBatteryPercent = null;
    this.arrivalBatteryUpdatedAtMs = 0;
    this.location = null;
    this.locationUpdatedAtMs = 0;
    this.destinationLocation = null;
    this.destinationLocationUpdatedAtMs = 0;
    this.clearRoute();
  }

  dispose(): void {
    this.clear();
  }

  private confirmRoute(now: number): void {
    if (
      !this.route ||
      !this.location ||
      !this.destinationLocation ||
      !this.destinationName ||
      this.minutesToArrival === null ||
      now - this.locationUpdatedAtMs >= NAVIGATION_LOCATION_STALE_MS ||
      now - this.destinationLocationUpdatedAtMs >= NAVIGATION_MAP_STALE_MS ||
      now - this.destinationUpdatedAtMs >= NAVIGATION_STALE_AFTER_MS ||
      now - this.minutesUpdatedAtMs >= NAVIGATION_STALE_AFTER_MS ||
      coordinateDistanceMeters(this.route[this.route.length - 1], this.destinationLocation) > 250
    )
      return;
    // These observations confirm the same active route without pretending that
    // the vehicle retransmitted its unchanged polyline. Retain the final section
    // before the vehicle reaches it; the renderer checks distance to the road.
    // GET requests do not renew it.
    this.routeConfirmedAtMs = Math.min(
      this.locationUpdatedAtMs,
      this.destinationLocationUpdatedAtMs,
      this.destinationUpdatedAtMs,
      this.minutesUpdatedAtMs,
    );
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    const nextExpiryAtMs = Math.min(
      this.destinationName ? this.destinationUpdatedAtMs + NAVIGATION_STALE_AFTER_MS : Infinity,
      this.minutesToArrival !== null
        ? this.minutesUpdatedAtMs + NAVIGATION_STALE_AFTER_MS
        : Infinity,
      this.location ? this.locationUpdatedAtMs + NAVIGATION_LOCATION_STALE_MS : Infinity,
      this.destinationLocation
        ? this.destinationLocationUpdatedAtMs + NAVIGATION_MAP_STALE_MS
        : Infinity,
      this.route
        ? Math.max(this.routeUpdatedAtMs, this.routeConfirmedAtMs) + NAVIGATION_MAP_STALE_MS
        : Infinity,
    );
    if (!Number.isFinite(nextExpiryAtMs)) return;
    this.expiryTimer = setTimeout(
      () => {
        const now = Date.now();
        if (
          (this.destinationName &&
            now - this.destinationUpdatedAtMs >= NAVIGATION_STALE_AFTER_MS) ||
          (this.minutesToArrival !== null &&
            now - this.minutesUpdatedAtMs >= NAVIGATION_STALE_AFTER_MS)
        ) {
          this.clear();
        } else {
          if (this.location && now - this.locationUpdatedAtMs >= NAVIGATION_LOCATION_STALE_MS) {
            this.location = null;
            this.locationUpdatedAtMs = 0;
          }
          if (
            this.destinationLocation &&
            now - this.destinationLocationUpdatedAtMs >= NAVIGATION_MAP_STALE_MS
          ) {
            this.destinationLocation = null;
            this.destinationLocationUpdatedAtMs = 0;
          }
          if (
            this.route &&
            now - Math.max(this.routeUpdatedAtMs, this.routeConfirmedAtMs) >=
              NAVIGATION_MAP_STALE_MS
          )
            this.clearRoute();
          this.scheduleExpiry();
        }
        this.onExpired();
      },
      Math.max(0, nextExpiryAtMs - Date.now()),
    );
    this.expiryTimer.unref();
  }

  private clearRoute(): void {
    this.route = null;
    this.routeUpdatedAtMs = 0;
    this.routeConfirmedAtMs = 0;
    this.encodedRoute = '';
  }
}
