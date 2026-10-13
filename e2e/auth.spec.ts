import { expect, test, type Page } from '@playwright/test';
import { createUser, dida } from './support.js';

async function logIn(page: Page, username: string, password: string) {
  await page.getByLabel('账号').fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录' }).click();
}

const loginHeading = (page: Page) => page.getByRole('heading', { level: 1, name: '登录' });
const signedInAs = (page: Page, username: string) => page.getByText(`已登录：${username}`);

test('log in: wrong password shows a message, then the right one signs in and survives a reload', async ({ page }, testInfo) => {
  const user = createUser('login');
  await page.goto('/');
  await expect(loginHeading(page)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`login-${testInfo.project.name}.png`), fullPage: true });

  await logIn(page, user.username, 'definitely-wrong');
  await expect(page.getByRole('alert')).toHaveText('账号或密码错误');
  await expect(page.getByLabel('密码', { exact: true })).toHaveValue('');
  await page.screenshot({ path: testInfo.outputPath(`login-error-${testInfo.project.name}.png`), fullPage: true });

  await logIn(page, user.username, user.password);
  await expect(signedInAs(page, user.username)).toBeVisible();

  const cookies = await page.context().cookies();
  expect(cookies.find((c) => c.name === 'dida_session')).toMatchObject({ httpOnly: true, sameSite: 'Lax' });
  // httpOnly: page scripts cannot read the session.
  expect(await page.evaluate(() => (globalThis as unknown as { document: { cookie: string } }).document.cookie)).not.toContain('dida_session');

  await page.reload();
  await expect(signedInAs(page, user.username)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`home-${testInfo.project.name}.png`), fullPage: true });
});

test('log in with the administrator created from .env on first start', async ({ page }) => {
  await page.goto('/');
  await logIn(page, 'admin', 'e2e-admin-password');
  await expect(signedInAs(page, 'admin')).toBeVisible();
  await expect(page.getByText('管理员', { exact: true })).toBeVisible();
});

test('log out returns to the login page and the session is gone', async ({ page }) => {
  const user = createUser('logout');
  await page.goto('/');
  await logIn(page, user.username, user.password);
  await expect(signedInAs(page, user.username)).toBeVisible();

  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(loginHeading(page)).toBeVisible();

  await page.reload();
  await expect(loginHeading(page)).toBeVisible();
  expect((await page.request.get('/api/auth/me')).status()).toBe(401);
});

test('change password: wrong current password is refused, then the new password works', async ({ page }, testInfo) => {
  const user = createUser('passwd');
  const newPassword = `${user.password}-new`;
  await page.goto('/');
  await logIn(page, user.username, user.password);
  await expect(signedInAs(page, user.username)).toBeVisible();

  const form = page.getByRole('region', { name: '修改密码' });
  await form.getByLabel('当前密码').fill('not-my-password');
  await form.getByLabel('新密码', { exact: true }).fill(newPassword);
  await form.getByLabel('确认新密码').fill(newPassword);
  await form.getByRole('button', { name: '修改密码' }).click();
  await expect(form.getByRole('alert')).toHaveText('当前密码不正确');

  await form.getByLabel('当前密码').fill(user.password);
  await form.getByRole('button', { name: '修改密码' }).click();
  await expect(form.getByRole('status')).toHaveText('密码已修改');
  await page.screenshot({ path: testInfo.outputPath(`password-changed-${testInfo.project.name}.png`), fullPage: true });

  // Still logged in here; now log out and back in with the new password only.
  await page.getByRole('button', { name: '退出登录' }).click();
  await logIn(page, user.username, user.password);
  await expect(page.getByRole('alert')).toHaveText('账号或密码错误');
  await logIn(page, user.username, newPassword);
  await expect(signedInAs(page, user.username)).toBeVisible();
});

test('a disabled user is logged out at once and cannot log in again', async ({ page }) => {
  const user = createUser('disabled');
  await page.goto('/');
  await logIn(page, user.username, user.password);
  await expect(signedInAs(page, user.username)).toBeVisible();

  expect(dida(['disable-user', user.username])).toContain(`已停用 ${user.username}`);

  await page.reload();
  await expect(loginHeading(page)).toBeVisible();
  await logIn(page, user.username, user.password);
  await expect(page.getByRole('alert')).toHaveText('该账户已停用，请联系管理员');
});

test('reset-password from the CLI logs the user out and sets the new password', async ({ page }) => {
  const user = createUser('reset');
  await page.goto('/');
  await logIn(page, user.username, user.password);
  await expect(signedInAs(page, user.username)).toBeVisible();

  expect(dida(['reset-password', user.username], 'reset-by-cli-123\n')).toContain('已重置');

  await page.reload();
  await expect(loginHeading(page)).toBeVisible();
  await logIn(page, user.username, 'reset-by-cli-123');
  await expect(signedInAs(page, user.username)).toBeVisible();
});

test('the login form works with the keyboard only', async ({ page }) => {
  const user = createUser('keyboard');
  await page.goto('/');
  await page.getByLabel('账号').focus();
  await page.keyboard.type(user.username);
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('密码', { exact: true })).toBeFocused();
  await page.keyboard.type(user.password);
  await page.keyboard.press('Enter');
  await expect(signedInAs(page, user.username)).toBeVisible();
});
