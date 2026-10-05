import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, MapPin } from 'lucide-react';
import type { NavigationSnapshot } from '../../shared/contracts.js';
import {
  isNearArrival,
  navigationMapIsFresh,
  NAVIGATION_LOCATION_STALE_MS,
  NAVIGATION_MAP_STALE_MS,
} from '../../shared/navigation-map.js';

import NavigationMap from './NavigationMap.js';

function arrivalTimeFor(navigation: NavigationSnapshot): { date: Date; label: string } {
  const date = new Date(navigation.updatedAtMs + navigation.minutesToArrival * 60_000);
  const label = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
  return { date, label };
}

function formatDistance(distanceMiles: number): string {
  const maximumFractionDigits = distanceMiles > 1 ? 0 : 1;
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(distanceMiles)} mi`;
}

export function NavigationCard({
  navigation,
  onExpandedChange,
}: {
  navigation: NavigationSnapshot;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const [, refreshFreshness] = useState(0);
  const [manual, setManual] = useState<{ key: string; expanded: boolean } | null>(null);
  const now = Date.now();
  const map = navigation.map;
  const routeKey = `${navigation.destinationName}:${map?.destination.latitude.toFixed(4) ?? ''}:${map?.destination.longitude.toFixed(4) ?? ''}`;
  const fresh =
    navigationMapIsFresh(map, now) && now - navigation.updatedAtMs < NAVIGATION_MAP_STALE_MS;
  const nearArrival = isNearArrival(navigation);
  const outsideArrivalZone =
    navigation.minutesToArrival > 5 &&
    (navigation.distanceToArrivalMiles === undefined ||
      navigation.distanceToArrivalMiles * 1_609.344 > 1_500);
  const expanded = fresh && (manual?.key === routeKey ? manual.expanded : nearArrival);
  useEffect(() => {
    onExpandedChange?.(expanded);
  }, [expanded, onExpandedChange]);
  useEffect(() => {
    if (!map) return;
    const expiresAt = Math.min(
      map.locationUpdatedAtMs + NAVIGATION_LOCATION_STALE_MS,
      map.destinationUpdatedAtMs + NAVIGATION_MAP_STALE_MS,
      navigation.updatedAtMs + NAVIGATION_MAP_STALE_MS,
    );
    const timer = window.setTimeout(
      () => refreshFreshness((value) => value + 1),
      Math.max(0, expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [map, navigation.updatedAtMs]);
  useEffect(() => {
    // Re-arm automatic expansion only after clearly leaving the arrival zone.
    if (outsideArrivalZone) setManual(null);
  }, [outsideArrivalZone]);
  const roundedMinutes = Math.max(0, Math.ceil(navigation.minutesToArrival));
  const arrival = arrivalTimeFor(navigation);
  const distanceToArrivalMiles = navigation.distanceToArrivalMiles;
  const arrivalBatteryPercent = navigation.arrivalBatteryPercent;

  return (
    <aside
      className={`am-navigation-card${expanded ? ' am-navigation-card--expanded' : ''}`}
      aria-label="当前导航"
      data-map-expanded={expanded}
    >
      <div className="am-navigation-content">
        <header className="am-navigation-header">
          <div className="am-navigation-destination">
            <div className="am-navigation-destination-meta">
              <span>
                {expanded && <MapPin size={12} />}
                {expanded && nearArrival ? '即将到达' : '目的地'}
              </span>
            </div>
            <strong title={navigation.destinationName}>{navigation.destinationName}</strong>
          </div>
          {fresh && (
            <button
              className="am-navigation-toggle"
              type="button"
              aria-label={expanded ? '收起地图' : '展开地图'}
              aria-expanded={expanded}
              onClick={() => setManual({ key: routeKey, expanded: !expanded })}
            >
              {expanded ? <ChevronDown size={20} /> : <ChevronUp size={20} />}
            </button>
          )}
        </header>
        {expanded && map && <NavigationMap map={map} now={now} />}
        <div className="am-navigation-metrics">
          <div className="am-navigation-eta">
            <span className="am-navigation-metric-label">预计到达</span>
            <time className="am-navigation-arrival-time" dateTime={arrival.date.toISOString()}>
              {arrival.label}
            </time>
            <span className="am-navigation-remaining">
              {roundedMinutes === 0 ? '即将到达' : `${roundedMinutes} 分钟`}
            </span>
          </div>
          {distanceToArrivalMiles !== undefined && (
            <div className="am-navigation-distance">
              <span className="am-navigation-metric-label">剩余距离</span>
              <strong>{formatDistance(distanceToArrivalMiles)}</strong>
            </div>
          )}
          {arrivalBatteryPercent !== undefined && (
            <div className="am-navigation-battery">
              <span className="am-navigation-metric-label">预计到达电量</span>
              <strong>{Math.round(arrivalBatteryPercent)}%</strong>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
