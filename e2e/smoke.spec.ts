import { expect, test } from '@playwright/test';

test('the app shell loads from the server and asks to log in', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: '登录' })).toBeVisible();
});

test('the product name shows in the page title and on the login page', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('叮叮清单');
  await expect(page.locator('.brand-name')).toHaveText('叮叮清单');
});

test('client-side routes fall back to the app, API paths do not', async ({ page, request }) => {
  await page.goto('/some/client/route');
  await expect(page.getByRole('heading', { level: 1, name: '登录' })).toBeVisible();

  const res = await request.get('/api/does-not-exist');
  expect(res.status()).toBe(404);
  expect(await res.json()).toMatchObject({ error: { code: 'not_found' } });

  const health = await request.get('/api/health');
  expect(health.status()).toBe(200);
});
