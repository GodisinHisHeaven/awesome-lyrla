// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import type { NavigationSnapshot } from '../../shared/contracts.js';
import { NavigationCard } from './NavigationCard.js';

function renderCard(distanceToArrivalMiles: number): void {
  const navigation: NavigationSnapshot = {
    destinationName: '上海虹桥国际机场 T2 航站楼',
    minutesToArrival: 18.2,
    updatedAtMs: Date.now(),
    distanceToArrivalMiles,
    arrivalBatteryPercent: 68,
  };
  render(<NavigationCard navigation={navigation} />);
}

describe('NavigationCard distance formatting', () => {
  it('rounds distances above one mile to whole miles', () => {
    renderCard(12.4);
    expect(screen.getByText('12 mi')).toBeInTheDocument();
  });

  it('keeps one decimal place for distances at or below one mile', () => {
    renderCard(0.8);
    expect(screen.getByText('0.8 mi')).toBeInTheDocument();
  });
});
