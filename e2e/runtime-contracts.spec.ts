import { expect, test } from '@playwright/test';

test('exposes the running revision and demo mode through healthz', async ({ request }) => {
  await expect
    .poll(
      async () => {
        try {
          return (await request.get('http://127.0.0.1:8791/healthz')).ok();
        } catch {
          return false;
        }
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  const response = await request.get('http://127.0.0.1:8791/healthz');
  expect(response.ok()).toBe(true);
  const health = await response.json();
  expect(health).toMatchObject({
    status: 'ok',
    revision: 'development',
    mode: 'demo',
    processRole: 'web',
  });
});

test('renders the demo player through the real API and SSE server', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('link', { name: '打开歌词设置' })).toBeVisible();
  await expect(page.getByText('Streetlights draw a silver line')).toBeAttached();
  await expect(page.getByRole('status')).toContainText('演示模式');
});

test('keeps the owner setup console behind the administrator PIN', async ({ page }) => {
  await page.goto('/setup');

  await expect(page.getByRole('heading', { name: '打开 Awesome Lyrla 设置' })).toBeVisible();
  await expect(page.getByLabel('管理员 PIN')).toBeVisible();
  await expect(page.getByRole('button', { name: '解锁设置' })).toBeVisible();
});

test('keeps demo actions and player snapshots on the same server contract', async ({ request }) => {
  const beforeResponse = await request.get('/api/player');
  expect(beforeResponse.ok()).toBe(true);
  const before = (await beforeResponse.json()) as { elapsedMs: number; snapshotRevision?: number };

  const actionResponse = await request.post('/api/demo/action', {
    data: { action: 'forward' },
  });
  expect(actionResponse.ok()).toBe(true);
  const after = (await actionResponse.json()) as { elapsedMs: number; snapshotRevision?: number };

  expect(after.elapsedMs).toBeGreaterThan(before.elapsedMs);
  expect(after.snapshotRevision).toBeGreaterThan(before.snapshotRevision ?? 0);
});
