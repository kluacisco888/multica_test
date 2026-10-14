import { randomBytes } from 'node:crypto';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { createUser, dida, logIn, openAccount } from './support.js';

/*
 * 后台 (spec 用户故事 9): a 管理员 manages 用户 in 设置 →「用户管理」.
 * Ordinary users have no entry and get 403 from the API.
 */

function createAdmin(): { username: string; password: string } {
  const username = `boss-${randomBytes(4).toString('hex')}`;
  const password = `pw-${randomBytes(6).toString('hex')}`;
  dida(['create-user', username, '--admin'], `${password}\n`);
  return { username, password };
}

/** 设置 → 用户管理, as a signed-in 管理员. */
async function openUserAdmin(page: Page, username: string): Promise<Locator> {
  const dialog = await openAccount(page, username);
  await dialog.getByRole('tab', { name: '用户管理' }).click();
  const panel = dialog.getByRole('tabpanel');
  await expect(panel.getByRole('heading', { name: '用户管理' })).toBeVisible();
  return panel;
}

const userRow = (panel: Locator, username: string) => panel.getByRole('listitem', { name: username, exact: true });

/** A second, independent browser (own cookies) for the managed user. */
async function otherBrowser(browser: Browser, page: Page) {
  const context = await browser.newContext({ viewport: page.viewportSize(), baseURL: new URL(page.url()).origin });
  return { context, page: await context.newPage() };
}

test('管理员 adds a user, disables, enables and resets their password', async ({ page, browser }, testInfo) => {
  const admin = createAdmin();
  await logIn(page, admin.username, admin.password);
  const panel = await openUserAdmin(page, admin.username);

  // Their own row: marked, and cannot be disabled.
  const self = userRow(panel, admin.username);
  await expect(self.getByText('当前账户')).toBeVisible();
  await expect(self.getByRole('button', { name: /^停用/ })).toHaveCount(0);

  // 添加用户
  const name = `newbie-${randomBytes(3).toString('hex')}`;
  await panel.getByRole('button', { name: '+ 添加用户' }).click();
  const add = page.getByRole('dialog', { name: '添加用户' });
  await add.getByLabel('账号').fill(name);
  await add.getByLabel('初始密码').fill('short');
  await add.getByLabel('确认密码').fill('short');
  await add.getByRole('button', { name: '添加' }).click();
  await expect(add.getByRole('alert')).toHaveText('密码至少 8 位');
  await add.getByLabel('初始密码').fill('first-password');
  // Editing clears the message.
  await expect(add.getByRole('alert')).toHaveCount(0);
  await add.getByLabel('确认密码').fill('first-password');
  await page.screenshot({ path: testInfo.outputPath(`admin-add-user-${testInfo.project.name}.png`) });
  await add.getByRole('button', { name: '添加' }).click();
  await expect(add).toBeHidden();
  await expect(panel.getByRole('status')).toHaveText(`已添加用户 ${name}`);
  const row = userRow(panel, name);
  await expect(row).toBeVisible();

  // The new user can log in in another browser.
  const other = await otherBrowser(browser, page);
  await logIn(other.page, name, 'first-password');

  // 停用: their open page loses its session.
  await row.getByRole('button', { name: `停用「${name}」` }).click();
  const confirm = page.getByRole('dialog', { name: '停用用户' });
  await confirm.getByRole('button', { name: '停用' }).click();
  await expect(row.getByText('已停用')).toBeVisible();
  await panel.getByRole('heading', { name: '用户管理' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath(`admin-users-${testInfo.project.name}.png`) });

  await other.page.reload();
  await expect(other.page.getByRole('heading', { level: 1, name: '登录' })).toBeVisible();
  await other.page.getByLabel('账号').fill(name);
  await other.page.getByLabel('密码', { exact: true }).fill('first-password');
  await other.page.getByRole('button', { name: '登录' }).click();
  await expect(other.page.getByRole('alert')).toHaveText('该账户已停用，请联系管理员');

  // 启用, then 重置密码: only the new password works.
  await row.getByRole('button', { name: `启用「${name}」` }).click();
  await expect(row.getByText('已停用')).toHaveCount(0);
  await row.getByRole('button', { name: `重置「${name}」的密码` }).click();
  const reset = page.getByRole('dialog', { name: `重置「${name}」的密码` });
  await reset.getByLabel('新密码', { exact: true }).fill('second-password');
  await reset.getByLabel('确认新密码').fill('second-password');
  await reset.getByRole('button', { name: '重置密码' }).click();
  await expect(reset).toBeHidden();
  await expect(panel.getByRole('status')).toHaveText(`已重置 ${name} 的密码`);

  await other.page.getByLabel('密码', { exact: true }).fill('first-password');
  await other.page.getByRole('button', { name: '登录' }).click();
  await expect(other.page.getByRole('alert')).toHaveText('账号或密码错误');
  await logIn(other.page, name, 'second-password');
  await other.context.close();
});

test('ordinary users see no 用户管理 entry and the API answers 403', async ({ page }) => {
  const user = createUser('plain');
  await logIn(page, user.username, user.password);
  const dialog = await openAccount(page, user.username);
  await expect(dialog.getByRole('tab')).toHaveText(['账户与安全', '日期与时间', '提醒与通知', '智能清单', '外观', '更多设置', '关联与导入', '快捷键']);
  await expect(dialog.getByRole('tab', { name: '用户管理' })).toHaveCount(0);

  const list = await page.request.get('/api/admin/users');
  expect(list.status()).toBe(403);
  expect(await list.json()).toEqual({ error: { code: 'forbidden', message: '需要管理员权限' } });
  const create = await page.request.post('/api/admin/users', { data: { username: `sneaky-${user.username}`, password: 'sneaky-password' } });
  expect(create.status()).toBe(403);
});

test('keyboard: the 用户管理 tab is reachable with the arrow keys', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1440) < 768, 'desktop keyboard path');
  const admin = createAdmin();
  await logIn(page, admin.username, admin.password);
  const dialog = await openAccount(page, admin.username);
  await dialog.getByRole('tab', { name: '账户与安全' }).focus();
  await page.keyboard.press('End');
  await expect(dialog.getByRole('tab', { name: '用户管理' })).toBeFocused();
  await expect(dialog.getByRole('tab', { name: '用户管理' })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByRole('heading', { name: '用户管理' })).toBeVisible();
});
