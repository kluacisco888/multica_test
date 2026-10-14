import { expect, test, type Page } from '@playwright/test';
import { createUser, isMobile, logIn, openAccount } from './support.js';

/*
 * 智能识别 (EURO-27, spec 用户故事 51–58): the recognised parts are
 * highlighted in 添加任务, a click cancels one, 保留识别文字 keeps the text in
 * the title, and the 总开关 switches it all off. The server uses the real
 * clock, so dates are checked as 明天 (the list's label for tomorrow).
 */

const quickAdd = (page: Page) => page.getByRole('textbox', { name: '添加任务' });
const openTasks = (page: Page) => page.getByRole('list', { name: '任务', exact: true });
const taskButton = (page: Page, title: string) => openTasks(page).getByRole('button', { name: title, exact: true });
const openRow = (page: Page, title: string) =>
  openTasks(page).getByRole('listitem').filter({ has: page.getByRole('button', { name: title, exact: true }) });
const token = (page: Page, name: string) => page.getByRole('button', { name: `取消识别${name}` });

async function openSmartSettings(page: Page, username: string) {
  const dialog = await openAccount(page, username);
  await dialog.getByRole('tab', { name: '更多设置' }).click();
  await expect(dialog.getByRole('heading', { name: '智能识别' })).toBeVisible();
  return dialog;
}

/** Close 设置 (and on mobile the drawer it was opened from). */
async function closeSettings(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '设置' })).toBeHidden();
  const sidebar = page.getByRole('navigation', { name: '侧栏' });
  if (isMobile(page) && (await sidebar.isVisible())) {
    // The scrim right of the drawer closes it.
    await page.mouse.click(385, 420);
    await expect(sidebar).toBeHidden();
  }
}

async function saveSetting(page: Page, action: () => Promise<void>) {
  const saved = page.waitForResponse((r) => r.url().endsWith('/api/settings') && r.request().method() === 'PATCH' && r.ok());
  await action();
  await saved;
}

test('highlights what is recognised and adds the task with it', async ({ page }, testInfo) => {
  const user = createUser('smart');
  await logIn(page, user.username, user.password);

  await quickAdd(page).fill('明天下午3点开会 #工作 !高');
  for (const name of ['日期“明天”', '时间“下午3点”', '标签“#工作”', '优先级“!高”']) await expect(token(page, name)).toBeVisible();

  // Each highlight sits over its own text inside the field.
  const field = (await quickAdd(page).boundingBox())!;
  const date = (await token(page, '日期“明天”').boundingBox())!;
  const time = (await token(page, '时间“下午3点”').boundingBox())!;
  expect(date.x).toBeGreaterThanOrEqual(field.x - 1);
  expect(date.x + date.width).toBeLessThanOrEqual(time.x + 1);
  expect(time.y).toBeGreaterThanOrEqual(field.y - 1);
  expect(time.y + time.height).toBeLessThanOrEqual(field.y + field.height + 1);
  await page.screenshot({ path: testInfo.outputPath(`smart-input-${testInfo.project.name}.png`) });

  await quickAdd(page).press('Enter');
  await expect(taskButton(page, '开会')).toBeVisible();
  await expect(quickAdd(page)).toHaveValue('');
  const row = openRow(page, '开会');
  await expect(row).toContainText('明天');
  await expect(row).toContainText('工作');

  await taskButton(page, '开会').click();
  const detail = page.getByRole('complementary', { name: '任务详情' });
  await expect(detail.getByRole('textbox', { name: '任务标题' })).toHaveValue('开会');
  await expect(detail.getByRole('button', { name: /^日期：明天.*15:00/ })).toBeVisible();
  await expect(detail.getByRole('button', { name: /高优先级/ })).toBeVisible();
});

test('a click on a highlight cancels that part', async ({ page }) => {
  const user = createUser('smart-cancel');
  await logIn(page, user.username, user.password);

  await quickAdd(page).fill('明天上午提醒我去取快递');
  await expect(token(page, '时间“上午”')).toBeVisible();
  await token(page, '时间“上午”').click();
  await expect(token(page, '时间“上午”')).toHaveCount(0);
  await expect(token(page, '日期“明天”')).toBeVisible();
  // Focus stays in the field, so Enter saves.
  await expect(quickAdd(page)).toBeFocused();

  // Keyboard: Tab to a highlight and press Enter to cancel it too.
  if (!isMobile(page)) {
    await page.keyboard.press('Tab');
    await expect(token(page, '日期“明天”')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(token(page, '日期“明天”')).toHaveCount(0);
    await expect(quickAdd(page)).toBeFocused();
  } else {
    await token(page, '日期“明天”').click();
  }

  await quickAdd(page).press('Enter');
  await expect(taskButton(page, '明天上午去取快递')).toBeVisible();
  // 提醒我 still applies: today, with a reminder.
  await expect(openRow(page, '明天上午去取快递')).toContainText('今天');
});

test('保留识别文字 keeps the recognised text in the title', async ({ page }) => {
  const user = createUser('smart-keep');
  await logIn(page, user.username, user.password);

  const dialog = await openSmartSettings(page, user.username);
  const keep = dialog.getByRole('checkbox', { name: '保留识别文字' });
  await expect(keep).not.toBeChecked();
  await saveSetting(page, () => keep.check());
  await closeSettings(page);

  await quickAdd(page).fill('明天买牛奶');
  await expect(token(page, '日期“明天”')).toBeVisible();
  await quickAdd(page).press('Enter');
  await expect(taskButton(page, '明天买牛奶')).toBeVisible();
  await expect(openRow(page, '明天买牛奶')).toContainText('明天');
});

test('the 智能识别 switch turns recognition off', async ({ page }, testInfo) => {
  const user = createUser('smart-off');
  await logIn(page, user.username, user.password);

  const dialog = await openSmartSettings(page, user.username);
  const toggle = dialog.getByRole('switch', { name: '智能识别' });
  await expect(toggle).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath(`smart-input-settings-${testInfo.project.name}.png`) });
  await saveSetting(page, () => toggle.uncheck());
  await expect(dialog.getByRole('checkbox', { name: '保留识别文字' })).toBeDisabled();
  await closeSettings(page);

  await quickAdd(page).fill('明天买牛奶 #购物');
  await expect(page.getByTestId('smart-highlights')).toHaveCount(0);
  await quickAdd(page).press('Enter');
  await expect(taskButton(page, '明天买牛奶 #购物')).toBeVisible();
  await taskButton(page, '明天买牛奶 #购物').click();
  const detail = page.getByRole('complementary', { name: '任务详情' });
  await expect(detail.getByRole('button', { name: '设置日期' })).toBeVisible();
  if (isMobile(page)) await page.getByRole('button', { name: '返回列表' }).click();

  // Back on: recognised again.
  const again = await openSmartSettings(page, user.username);
  await saveSetting(page, () => again.getByRole('switch', { name: '智能识别' }).check());
  await closeSettings(page);
  await quickAdd(page).fill('后天买牛奶');
  await expect(token(page, '日期“后天”')).toBeVisible();
});

test('模糊时间 settings change what 上午 means', async ({ page }) => {
  const user = createUser('smart-fuzzy');
  await logIn(page, user.username, user.password);

  const dialog = await openSmartSettings(page, user.username);
  const morning = dialog.getByLabel('上午', { exact: true });
  await expect(morning).toHaveValue('10:00');
  await saveSetting(page, () => morning.fill('08:30'));
  await closeSettings(page);

  await quickAdd(page).fill('明天上午晨跑');
  await quickAdd(page).press('Enter');
  await taskButton(page, '晨跑').click();
  const detail = page.getByRole('complementary', { name: '任务详情' });
  await expect(detail.getByRole('button', { name: /^日期：明天.*08:30/ })).toBeVisible();
});
