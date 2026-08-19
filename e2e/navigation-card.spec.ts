import { expect, test } from '@playwright/test';

test('renders the navigation destination and arrival metrics', async ({ page }) => {
  await page.goto('/navigation-card-demo');

  await expect(page.getByRole('heading', { name: '到达信息一眼可读' })).toBeVisible();
  const card = page.getByRole('complementary', { name: '当前导航' });
  await expect(card).toContainText('上海虹桥国际机场 T2 航站楼');
  await expect(card).toContainText('12 mi');
  await expect(card).toContainText('预计到达电量');
  await expect(card).toContainText('68%');
});
