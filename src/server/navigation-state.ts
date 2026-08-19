import type { NavigationSnapshot } from '../shared/contracts.js';

export const NAVIGATION_STALE_AFTER_MS = 90_000;
const NAVIGATION_BURST_GRACE_MS = 2_000;

export type NavigationField =
  | 'DestinationName'
  | 'MinutesToArrival'
  | 'MilesToArrival'
  | 'ExpectedEnergyPercentAtTripArrival';

export interface NavigationUpdate {
  accepted: boolean;
  changed: boolean;
}

type NavigationValue = string | number | null;

function numericValue(value: NavigationValue): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
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
  private expiryTimer?: NodeJS.Timeout;

  constructor(private readonly onExpired: () => void) {}

  snapshot(now = Date.now()): NavigationSnapshot | null {
    if (
      !this.destinationName
      || this.minutesToArrival === null
      || now - this.destinationUpdatedAtMs >= NAVIGATION_STALE_AFTER_MS
      || now - this.minutesUpdatedAtMs >= NAVIGATION_STALE_AFTER_MS
    ) return null;
    const arrivalBatteryIsFresh = this.arrivalBatteryPercent !== null
      && now - this.arrivalBatteryUpdatedAtMs < NAVIGATION_STALE_AFTER_MS;
    const distanceIsFresh = this.distanceToArrivalMiles !== null
      && now - this.distanceUpdatedAtMs < NAVIGATION_STALE_AFTER_MS;
    return {
      destinationName: this.destinationName,
      minutesToArrival: this.minutesToArrival,
      updatedAtMs: this.minutesUpdatedAtMs,
      ...(distanceIsFresh ? { distanceToArrivalMiles: this.distanceToArrivalMiles! } : {}),
      ...(arrivalBatteryIsFresh ? { arrivalBatteryPercent: this.arrivalBatteryPercent! } : {}),
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
  }

  dispose(): void {
    this.clear();
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    const oldestUpdateAtMs = Math.min(
      this.destinationUpdatedAtMs || Number.POSITIVE_INFINITY,
      this.minutesUpdatedAtMs || Number.POSITIVE_INFINITY,
    );
    if (!Number.isFinite(oldestUpdateAtMs)) return;
    this.expiryTimer = setTimeout(() => {
      const wasVisible = this.hasCoreState();
      this.clear();
      if (wasVisible) this.onExpired();
    }, Math.max(0, oldestUpdateAtMs + NAVIGATION_STALE_AFTER_MS - Date.now()));
    this.expiryTimer.unref();
  }
}
