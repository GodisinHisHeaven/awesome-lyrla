import type { NavigationSnapshot } from '../../shared/contracts.js';
import { NavigationCard } from '../components/NavigationCard.js';

const demoNavigation: NavigationSnapshot = {
  destinationName: '上海虹桥国际机场 T2 航站楼',
  minutesToArrival: 18.2,
  updatedAtMs: Date.now(),
  distanceToArrivalMiles: 12.4,
  arrivalBatteryPercent: 68,
};

export function NavigationCardDemoPage() {
  return (
    <main className="navigation-demo-shell">
      <div className="navigation-demo-copy">
        <span className="navigation-demo-eyebrow">NAVIGATION CARD · DEMO</span>
        <h1>到达信息一眼可读</h1>
        <p>演示数据 · 到达时间与预计到达电量</p>
      </div>
      <div className="navigation-demo-lyrics" aria-hidden="true">
        <span>夜色沿着道路慢慢展开</span>
        <span>玻璃把远处的光折进此刻</span>
        <span>下一段旋律正在靠近</span>
      </div>
      <NavigationCard navigation={demoNavigation} />
    </main>
  );
}
