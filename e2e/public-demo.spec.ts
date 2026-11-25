import { expect, test } from '@playwright/test';

const demoCases = [
  { role: 'admin', title: 'Platform overview', metrics: 6 },
  { role: 'supplier', title: 'Distributor dashboard', metrics: 4 },
  { role: 'medical_shop', title: 'Retailer dashboard', metrics: 4 }
];

for (const { role, title, metrics } of demoCases) {
  test(`${role} public demo stays sample-only`, async ({ page }) => {
    const apiRequests: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url());
    });

    await page.goto(`/demo.html?role=${role}`);

    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await expect(page.locator('#demo-metrics article')).toHaveCount(metrics);
    await expect(page.locator('.cp-demo-notice')).toContainText('Sample information only');
    await expect(page.locator('#demo-content')).toBeVisible();
    await expect(page.locator('#demo-content a[href^="/admin/"], #demo-content a[href^="/supplier/"], #demo-content a[href^="/medical-shop/"]'))
      .toHaveCount(0);
    expect(apiRequests).toEqual([]);
  });
}

test('invalid public demo role shows a clear error', async ({ page }) => {
  await page.goto('/demo.html?role=unknown');

  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('#demo-content')).toBeHidden();
});
