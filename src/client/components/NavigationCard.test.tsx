// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react';
import type { NavigationSnapshot } from '../../shared/contracts.js';
import { NavigationCard } from './NavigationCard.js';

vi.mock('./NavigationMap.js', () => ({
  default: () => <div role="img" aria-label="导航地图测试" />,
}));

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

describe('arrival map expansion', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
  });
  afterEach(() => vi.useRealTimers());
  function navigation(minutes = 2, miles = 0.5): NavigationSnapshot {
    return {
      destinationName: 'Airport',
      minutesToArrival: minutes,
      distanceToArrivalMiles: miles,
      updatedAtMs: Date.now(),
      map: {
        location: { latitude: 31.19, longitude: 121.32 },
        locationUpdatedAtMs: Date.now(),
        destination: { latitude: 31.195, longitude: 121.327 },
        destinationUpdatedAtMs: Date.now(),
      },
    };
  }

  it.each([
    [3, 10],
    [8, 1_000 / 1_609.344],
  ])('automatically expands at either arrival threshold', async (minutes, miles) => {
    render(<NavigationCard navigation={navigation(minutes, miles)} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: '收起地图' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('keeps a manual collapse through telemetry refresh and re-arms for a new destination', () => {
    const initial = navigation();
    const { rerender } = render(<NavigationCard navigation={initial} />);
    fireEvent.click(screen.getByRole('button', { name: '收起地图' }));
    rerender(<NavigationCard navigation={{ ...initial, minutesToArrival: 1 }} />);
    expect(screen.getByRole('button', { name: '展开地图' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    rerender(<NavigationCard navigation={{ ...initial, destinationName: 'New destination' }} />);
    expect(screen.getByRole('button', { name: '收起地图' })).toBeInTheDocument();
  });

  it('collapses on local GPS expiry even when no subsequent SSE event arrives', () => {
    render(<NavigationCard navigation={navigation()} />);
    expect(screen.getByRole('button', { name: '收起地图' })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.queryByRole('button', { name: '收起地图' })).toBeNull();
    expect(screen.queryByRole('button', { name: '展开地图' })).toBeNull();
    expect(screen.getByRole('complementary', { name: '当前导航' })).toHaveTextContent('Airport');
  });

  it('keeps the text card when coordinates are absent and supports manual expansion while cruising', () => {
    const { rerender } = render(
      <NavigationCard navigation={{ ...navigation(), map: undefined }} />,
    );
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<NavigationCard navigation={navigation(8, 5)} />);
    fireEvent.click(screen.getByRole('button', { name: '展开地图' }));
    expect(screen.getByRole('button', { name: '收起地图' })).toBeInTheDocument();
    rerender(<NavigationCard navigation={navigation(7.5, 4.5)} />);
    expect(screen.getByRole('button', { name: '收起地图' })).toBeInTheDocument();
  });

  it('does not auto-reopen around the threshold until the car clearly leaves the arrival zone', () => {
    const { rerender } = render(<NavigationCard navigation={navigation()} />);
    fireEvent.click(screen.getByRole('button', { name: '收起地图' }));
    rerender(<NavigationCard navigation={navigation(3.2, 0.7)} />);
    rerender(<NavigationCard navigation={navigation(2.8, 0.6)} />);
    expect(screen.getByRole('button', { name: '展开地图' })).toBeInTheDocument();
    rerender(<NavigationCard navigation={navigation(8, 5)} />);
    rerender(<NavigationCard navigation={navigation()} />);
    expect(screen.getByRole('button', { name: '收起地图' })).toBeInTheDocument();
  });
});
