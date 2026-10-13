import { expect, test, type Page } from '@playwright/test';
import { createUser, isMobile, logIn, openAccount } from './support.js';

/*
 * 提醒 (EURO-17, spec 用户故事 78–84). The server runs the real pg-boss jobs
 * and the real clock: a task due a few seconds from now fires its 准时 reminder,
 * and the open page shows the 应用内提醒 with 完成 and 稍后提醒.
 */

const openTasks = (page: Page) => page.getByRole('list', { name: '任务', exact: true });
const completedTasks = (page: Page) => page.getByRole('list', { name: '已完成的任务' });
const detail = (page: Page) => page.getByRole('complementary', { name: '任务详情' });
const picker = (page: Page) => page.getByRole('dialog', { name: '设置日期' });
const alerts = (page: Page) => page.getByRole('region', { name: '提醒' });
const alertCard = (page: Page, title: string) => alerts(page).getByRole('article', { name: title });

/** A task due `seconds` from now with a 准时 reminder, created through the API with the page's session. */
async function taskDueSoon(page: Page, title: string, seconds: number) {
  const dueAt = new Date(Date.now() + seconds * 1000).toISOString();
  const res = await page.request.post('/api/tasks', {
    data: { title, dates: { allDay: false, dueAt }, reminders: [{ type: 'before', minutes: 0 }] },
  });
  expect(res.status()).toBe(201);
}

test('the 应用内提醒 pops up while the page is open; 完成 completes the task', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  const user = createUser('remind');
  await logIn(page, user.username, user.password);
  await taskDueSoon(page, '给妈妈打电话', 3);
  await page.reload();
  await expect(openTasks(page).getByRole('button', { name: '给妈妈打电话', exact: true })).toBeVisible();
  await expect(openTasks(page).getByRole('listitem').filter({ hasText: '给妈妈打电话' }).getByText('有提醒')).toBeAttached();

  const card = alertCard(page, '给妈妈打电话');
  await expect(card).toBeVisible({ timeout: 40_000 });
  await expect(card.getByRole('button', { name: '完成「给妈妈打电话」' })).toBeVisible();
  await expect(card.getByRole('button', { name: '稍后提醒「给妈妈打电话」' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`reminder-alert-${testInfo.project.name}.png`) });

  await card.getByRole('button', { name: '完成「给妈妈打电话」' }).click();
  await expect(card).toHaveCount(0);
  await expect(completedTasks(page).getByRole('checkbox', { name: '给妈妈打电话' })).toBeChecked();
  // Closed for good: the next poll does not bring it back.
  const res = await page.request.get('/api/reminders/alerts');
  expect((await res.json()).alerts).toEqual([]);
});

test('稍后提醒 hides the alert and schedules it again', async ({ page }) => {
  test.setTimeout(60_000);
  const user = createUser('snooze');
  await logIn(page, user.username, user.password);
  await taskDueSoon(page, '取快递', 3);
  await page.reload();

  const card = alertCard(page, '取快递');
  await expect(card).toBeVisible({ timeout: 40_000 });
  await card.getByRole('button', { name: '稍后提醒「取快递」' }).click();
  const menu = card.getByRole('menu', { name: '稍后提醒「取快递」' });
  await expect(menu.getByRole('menuitem')).toHaveText(['5分钟后', '15分钟后', '30分钟后', '1小时后', '3小时后']);
  await menu.getByRole('menuitem', { name: '5分钟后', exact: true }).click();
  await expect(card).toHaveCount(0);
  // The task stays open, and the alert does not come back on the next poll.
  await expect(openTasks(page).getByRole('checkbox', { name: '取快递' })).not.toBeChecked();
  const res = await page.request.get('/api/reminders/alerts');
  expect((await res.json()).alerts).toEqual([]);
});

test('the date picker sets several reminders, a custom one and where they go', async ({ page }, testInfo) => {
  const user = createUser('pick');
  await logIn(page, user.username, user.password);
  await page.request.post('/api/notification-channels', {
    data: { type: 'feishu', name: '我的飞书', isDefault: true, config: { webhookUrl: 'http://127.0.0.1:9/hook' } },
  });
  await page.reload(); // channels are loaded with the page (and again when 设置 closes)
  await page.getByRole('textbox', { name: '添加任务' }).fill('周会');
  await page.getByRole('textbox', { name: '添加任务' }).press('Enter');
  await openTasks(page).getByRole('button', { name: '周会', exact: true }).click();
  await detail(page).getByRole('button', { name: '设置日期' }).click();
  await picker(page).getByRole('button', { name: '明天', exact: true }).click();
  await picker(page).getByLabel('时间', { exact: true }).fill('10:00');

  await picker(page).getByRole('button', { name: '提醒：无' }).click();
  const menu = picker(page).getByRole('menu', { name: '提醒：无' });
  await expect(menu.getByRole('menuitemcheckbox')).toHaveText(['无', '准时', '提前5分钟', '提前30分钟', '提前1小时', '提前1天']);
  await menu.getByRole('menuitemcheckbox', { name: '准时' }).click();
  await picker(page).getByRole('button', { name: '提醒：准时' }).click();
  await picker(page).getByRole('menuitemcheckbox', { name: '提前30分钟' }).click();
  await picker(page).getByRole('button', { name: '提醒：提前30分钟，准时' }).click();
  await picker(page).getByRole('menuitem', { name: '自定义' }).click();
  const custom = picker(page).getByRole('form', { name: '自定义提醒' });
  await custom.getByLabel('提前').fill('2');
  await custom.getByLabel('单位').selectOption('hours');
  await custom.getByRole('button', { name: '确定' }).click();
  await expect(picker(page).getByRole('button', { name: '提醒：提前2小时，提前30分钟，准时' })).toBeVisible();

  await picker(page).getByRole('button', { name: '提醒发送到：默认渠道' }).click();
  await picker(page).getByRole('menuitemcheckbox', { name: '我的飞书' }).click();
  await expect(picker(page).getByRole('button', { name: '提醒发送到：我的飞书' })).toBeVisible();
  await picker(page).getByRole('button', { name: '提醒：提前2小时，提前30分钟，准时' }).click();
  await page.screenshot({ path: testInfo.outputPath(`reminder-picker-${testInfo.project.name}.png`) });
  await page.keyboard.press('Escape');
  await picker(page).getByRole('button', { name: '确定' }).click();

  await expect(detail(page).getByRole('button', { name: /^日期：明天 10:00，提醒：提前2小时，提前30分钟，准时$/ })).toBeVisible();
  const tasks = await (await page.request.get('/api/search?q=周会')).json();
  expect(tasks.tasks[0].reminders).toEqual([
    { type: 'before', minutes: 120 },
    { type: 'before', minutes: 30 },
    { type: 'before', minutes: 0 },
  ]);
  expect(tasks.tasks[0].reminderChannelIds).toHaveLength(1);

  // A 全天 task offers 当天 / 提前 1 天 / 提前 1 周 at the 全天提醒时间.
  await detail(page).getByRole('button', { name: /^日期：/ }).click();
  await picker(page).getByRole('button', { name: '清除时间' }).click();
  await picker(page).getByRole('button', { name: '提醒：无' }).click();
  await expect(picker(page).getByRole('menuitemcheckbox')).toHaveText(['无', '当天（09:00）', '提前1天（09:00）', '提前1周（09:00）']);
  await page.keyboard.press('Escape');
  if (isMobile(page)) await expect(picker(page)).toBeVisible();
});

test('设置: 全天提醒时间 and the list of failed reminders', async ({ page }) => {
  const user = createUser('remset');
  await logIn(page, user.username, user.password);
  const dialog = await openAccount(page, user.username);
  await dialog.getByRole('tab', { name: '提醒与通知' }).click();
  await expect(dialog.getByRole('heading', { name: '发送失败的提醒' })).toBeVisible();
  await expect(dialog.getByText('没有发送失败的提醒。')).toBeVisible();
  const time = dialog.getByLabel('全天任务提醒时间');
  await expect(time).toHaveValue('09:00');
  await time.fill('08:30');
  await expect(dialog.getByRole('status').filter({ hasText: '已保存' })).toBeVisible();
  expect((await (await page.request.get('/api/settings')).json()).allDayReminderTime).toBe('08:30');
});
