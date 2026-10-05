import { expect, test } from '@playwright/test';
import type { PlayerSnapshot } from '../src/shared/contracts.js';

// Synthetic map coordinates and local tiles: never contact a real vehicle or tile provider.
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
  { width: 960, height: 480 },
]) {
  test(`keeps lyrics usable through map expansion and expiry at ${viewport.width}x${viewport.height}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const now = Date.UTC(2026, 0, 1);
    await page.clock.install({ time: now });
    const snapshot: PlayerSnapshot = {
      mode: 'demo',
      connection: 'demo',
      playbackStatus: 'paused',
      capturedAtMs: now,
      elapsedMs: 4000,
      manualOffsetMs: 0,
      artworkPalette: null,
      track: {
        title: 'Synthetic track',
        artist: 'Test artist',
        album: 'Test album',
        durationMs: 180000,
        source: 'demo',
      },
      lyrics: {
        kind: 'synced',
        provider: 'demo',
        lines: [
          { id: '0', startMs: 0, text: 'Map fallback keeps these lyrics' },
          { id: '1', startMs: 12000, text: 'The next line stays available' },
        ],
      },
      navigation: {
        destinationName: 'Synthetic destination',
        minutesToArrival: 2,
        distanceToArrivalMiles: 0.4,
        arrivalBatteryPercent: 60,
        updatedAtMs: now,
        map: {
          location: { latitude: 0, longitude: 0 },
          locationUpdatedAtMs: now,
          destination: { latitude: 0.003, longitude: 0.002 },
          destinationUpdatedAtMs: now,
          route: [
            { latitude: 0, longitude: 0 },
            { latitude: 0.002, longitude: 0 },
            { latitude: 0.003, longitude: 0.002 },
          ],
          routeUpdatedAtMs: now,
        },
      },
    };
    await page.route('**/api/player', (route) => route.fulfill({ json: snapshot }));
    await page.route('**/api/events', (route) =>
      route.fulfill({
        contentType: 'text/event-stream',
        body: `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`,
      }),
    );
    await page.route('https://tile.openstreetmap.org/**', (route) =>
      route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#ddd"/></svg>',
      }),
    );
    await page.goto('/');
    await expect(page.getByRole('button', { name: '收起地图' })).toBeVisible();
    await page.clock.runFor(500);
    const card = page.getByRole('complementary', { name: '当前导航' });
    const lyrics = page.locator('.am-lyrics-shell');
    await expect(page.getByText('Map fallback keeps these lyrics')).toBeAttached();
    await expect(page.locator('polyline[stroke="#3e6ae1"]')).toBeVisible();
    await expect(page.getByRole('link', { name: '© OpenStreetMap contributors' })).toBeVisible();
    const cardBox = await card.boundingBox();
    const lyricsBox = await lyrics.boundingBox();
    expect(cardBox).not.toBeNull();
    expect(lyricsBox).not.toBeNull();
    expect(cardBox!.x).toBeGreaterThanOrEqual(0);
    expect(cardBox!.y).toBeGreaterThanOrEqual(0);
    expect(cardBox!.x + cardBox!.width).toBeLessThanOrEqual(viewport.width);
    expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(viewport.height);
    if (viewport.width >= 600)
      expect(lyricsBox!.x + lyricsBox!.width).toBeLessThanOrEqual(cardBox!.x);
    else expect(lyricsBox!.y + lyricsBox!.height).toBeLessThanOrEqual(cardBox!.y);
    await page.screenshot({ path: testInfo.outputPath('arrival-map.png') });
    await page.getByRole('button', { name: '收起地图' }).click();
    await expect(page.locator('.am-navigation-map')).toHaveCount(0);
    await expect(page.locator('main')).not.toHaveClass(/am-player--navigation-expanded/);
    await page.getByRole('button', { name: '展开地图' }).click();
    await expect(page.locator('.am-navigation-map')).toBeVisible();
    await page.clock.fastForward(30000);
    await expect(page.locator('.am-navigation-map')).toHaveCount(0);
    await expect(card).toContainText('Synthetic destination');
    await expect(page.getByText('Map fallback keeps these lyrics')).toBeAttached();
    await expect(page.locator('main')).not.toHaveClass(/am-player--navigation-expanded/);
  });
}
