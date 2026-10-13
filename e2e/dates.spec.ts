import { expect, test, type Page } from '@playwright/test';
import { createUser, isMobile, logIn, openAccount } from './support.js';

/*
 * 任务日期 and the time zone setting (EURO-7, spec 用户故事 23–26).
 * The browser clock is pinned to 2026-10-13T04:00Z: Tuesday 12:00 in Shanghai,
 * Tuesday 00:00 in New York, so 今天 / 明天 mean the same days in both zones.
 */

const NOW = new Date('2026-10-13T04:00:00.000Z');

const quickAdd = (page: Page) => page.getByRole('textbox', { name: '添加任务' });
const openTasks = (page: Page) => page.getByRole('list', { name: '任务', exact: true });
const detail = (page: Page) => page.getByRole('complementary', { name: '任务详情' });
const picker = (page: Page) => page.getByRole('dialog', { name: '设置日期' });
const row = (page: Page, title: string) => openTasks(page).getByRole('listitem').filter({ has: page.getByRole('button', { name: title, exact: true }) });
const rowDate = (page: Page, title: string) => row(page, title).locator('.task-row-date');
const day = (page: Page, label: string) => picker(page).getByRole('button', { name: new RegExp(`^${label}`) });

async function addTasks(page: Page, ...titles: string[]) {
  for (const title of titles) {
    await quickAdd(page).fill(title);
    await quickAdd(page).press('Enter');
    await expect(openTasks(page).getByRole('button', { name: title, exact: true })).toBeVisible();
  }
}

async function openTask(page: Page, title: string) {
  await openTasks(page).getByRole('button', { name: title, exact: true }).click();
  await expect(detail(page).getByRole('textbox', { name: '任务标题' })).toHaveValue(title);
}

async function backToList(page: Page) {
  if (isMobile(page)) await page.getByRole('button', { name: '返回列表' }).click();
}

async function openPicker(page: Page) {
  await detail(page).getByRole('button', { name: /^(设置日期|日期：)/ }).click();
  await expect(picker(page)).toBeVisible();
}

async function confirm(page: Page) {
  await picker(page).getByRole('button', { name: '确定' }).click();
  await expect(picker(page)).toBeHidden();
}

test('due date, range, all-day ⇄ timed, clear, overdue, and a time zone change', async ({ page }, testInfo) => {
  await page.clock.setFixedTime(NOW);
  const user = createUser('dates');
  await logIn(page, user.username, user.password);
  await addTasks(page, '没有日期', '清除测试', '过期的', '出差', '开会', '交房租');

  // Due date only, all-day, from the quick picks.
  await openTask(page, '交房租');
  await openPicker(page);
  await expect(picker(page).getByRole('tab', { name: '日期' })).toHaveAttribute('aria-selected', 'true');
  await picker(page).getByRole('button', { name: '明天', exact: true }).click();
  await expect(day(page, '2026年10月14日')).toHaveClass(/date-day-selected/);
  await confirm(page);
  await expect(detail(page).getByRole('button', { name: '日期：明天' })).toBeVisible();
  await backToList(page);
  await expect(rowDate(page, '交房租')).toHaveText('明天');

  // Due date with a time: today 22:00 (Shanghai).
  await openTask(page, '开会');
  await openPicker(page);
  await picker(page).getByRole('button', { name: '今天', exact: true }).click();
  await picker(page).getByLabel('时间', { exact: true }).fill('22:00');
  await confirm(page);
  await backToList(page);
  await expect(rowDate(page, '开会')).toHaveText('22:00');

  // A range, all-day, picked on the calendar; then with times; then back to all-day.
  await openTask(page, '出差');
  await openPicker(page);
  await picker(page).getByRole('tab', { name: '时间段' }).click();
  await day(page, '2026年10月14日').click();
  await day(page, '2026年10月16日').click();
  await expect(day(page, '2026年10月15日')).toHaveClass(/date-day-in-range/);
  await confirm(page);
  await expect(detail(page).getByRole('button', { name: '日期：明天 - 周五' })).toBeVisible();

  await openPicker(page);
  await expect(picker(page).getByRole('tab', { name: '时间段' })).toHaveAttribute('aria-selected', 'true');
  await picker(page).getByLabel('全天').uncheck();
  await picker(page).getByLabel('开始时间').fill('09:00');
  await picker(page).getByLabel('结束时间').fill('18:00');
  await confirm(page);
  await expect(detail(page).getByRole('button', { name: '日期：明天 09:00 - 周五 18:00' })).toBeVisible();

  await openPicker(page);
  await picker(page).getByLabel('全天').check();
  await confirm(page);
  await expect(detail(page).getByRole('button', { name: '日期：明天 - 周五' })).toBeVisible();
  await backToList(page);
  await expect(rowDate(page, '出差')).toHaveText('明天 - 周五');

  // Overdue: yesterday, chosen with the keyboard (← from today, Enter).
  await openTask(page, '过期的');
  await openPicker(page);
  await page.keyboard.press('Tab'); // 日期 tab → first quick pick
  await day(page, '2026年10月13日').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(day(page, '2026年10月12日')).toBeFocused();
  await page.keyboard.press('Enter');
  await confirm(page);
  await expect(detail(page).getByRole('button', { name: '日期：昨天，已过期' })).toHaveClass(/date-overdue/);
  await backToList(page);
  await expect(rowDate(page, '过期的')).toHaveText('昨天，已过期');
  await expect(rowDate(page, '过期的')).toHaveClass(/date-overdue/);
  await expect(rowDate(page, '交房租')).not.toHaveClass(/date-overdue/);

  // Clearing removes the date; Esc closes without saving.
  await openTask(page, '清除测试');
  await openPicker(page);
  await picker(page).getByRole('button', { name: '今天', exact: true }).click();
  await confirm(page);
  await openPicker(page);
  await picker(page).getByRole('button', { name: '明天', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(picker(page)).toBeHidden();
  await expect(detail(page).getByRole('button', { name: '日期：今天' })).toBeFocused();
  await openPicker(page);
  await picker(page).getByRole('button', { name: '清除' }).click();
  await expect(detail(page).getByRole('button', { name: '设置日期' })).toBeVisible();
  await backToList(page);
  await expect(rowDate(page, '清除测试')).toHaveCount(0);
  await expect(rowDate(page, '没有日期')).toHaveCount(0);

  await page.screenshot({ path: testInfo.outputPath(`dates-list-${testInfo.project.name}.png`) });
  await openTask(page, '出差');
  await openPicker(page);
  await page.screenshot({ path: testInfo.outputPath(`dates-picker-${testInfo.project.name}.png`) });
  await page.keyboard.press('Escape');
  await backToList(page);

  // Change the time zone: the timed task moves to New York time, all-day dates stay.
  const settings = await openAccount(page, user.username);
  await settings.getByRole('tab', { name: '日期与时间' }).click();
  const zone = settings.getByLabel('时区');
  await expect(zone).toHaveValue('Asia/Shanghai');
  await zone.selectOption('America/New_York');
  await expect(settings.getByRole('status')).toHaveText('时区已保存');
  await page.screenshot({ path: testInfo.outputPath(`settings-timezone-${testInfo.project.name}.png`) });
  await settings.getByRole('button', { name: '关闭' }).click();

  await expect(rowDate(page, '开会')).toHaveText('10:00');
  await expect(rowDate(page, '交房租')).toHaveText('明天');
  await expect(rowDate(page, '出差')).toHaveText('明天 - 周五');

  // It is stored on the server.
  await page.reload();
  await expect(rowDate(page, '开会')).toHaveText('10:00');
  await expect(rowDate(page, '交房租')).toHaveText('明天');
  await expect(rowDate(page, '过期的')).toHaveText('昨天，已过期');
});
