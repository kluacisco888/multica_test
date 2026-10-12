import { expect, test } from '@playwright/test';

test('the app shell loads from the server and reaches the API', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('服务正常');
  await page.screenshot({ path: testInfo.outputPath(`smoke-${testInfo.project.name}.png`), fullPage: true });
});

test('client-side routes fall back to the app, API paths do not', async ({ page, request }) => {
  await page.goto('/some/client/route');
  await expect(page.getByRole('status')).toHaveText('服务正常');

  const res = await request.get('/api/does-not-exist');
  expect(res.status()).toBe(404);
  expect(await res.json()).toMatchObject({ error: { code: 'not_found' } });
});
