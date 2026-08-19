import type { NavigationSnapshot } from '../../shared/contracts.js';

function arrivalTimeFor(navigation: NavigationSnapshot): { date: Date; label: string } {
  const date = new Date(
    navigation.updatedAtMs + navigation.minutesToArrival * 60_000,
  );
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

export function NavigationCard({ navigation }: { navigation: NavigationSnapshot }) {
  const roundedMinutes = Math.max(0, Math.ceil(navigation.minutesToArrival));
  const arrival = arrivalTimeFor(navigation);
  const distanceToArrivalMiles = navigation.distanceToArrivalMiles;
  const arrivalBatteryPercent = navigation.arrivalBatteryPercent;

  return (
    <aside className="am-navigation-card" aria-label="当前导航">
      <div className="am-navigation-content">
        <div className="am-navigation-destination">
          <div className="am-navigation-destination-meta">
            <span>目的地</span>
          </div>
          <strong title={navigation.destinationName}>{navigation.destinationName}</strong>
        </div>
        <div className="am-navigation-metrics">
          <div className="am-navigation-eta">
            <span className="am-navigation-metric-label">预计到达</span>
            <time
              className="am-navigation-arrival-time"
              dateTime={arrival.date.toISOString()}
            >
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
