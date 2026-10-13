import { expect, test, type Page } from '@playwright/test';
import { createUser, isMobile, logIn } from './support.js';

/*
 * 重复任务 (EURO-14, spec 用户故事 41–49): set a 重复规则 from the date
 * picker's 重复 menu or the 自定义重复 editor; completing an instance shows the
 * next one in the list. The server uses the real clock, so the browser does
 * too and dates are checked relative to today.
 */

const quickAdd = (page: Page) => page.getByRole('textbox', { name: '添加任务' });
const openTasks = (page: Page) => page.getByRole('list', { name: '任务', exact: true });
const completedTasks = (page: Page) => page.getByRole('list', { name: '已完成的任务' });
const detail = (page: Page) => page.getByRole('complementary', { name: '任务详情' });
const picker = (page: Page) => page.getByRole('dialog', { name: '设置日期' });
const editor = (page: Page) => picker(page).getByRole('group', { name: '自定义重复' });
const openRow = (page: Page, title: string) =>
  openTasks(page).getByRole('listitem').filter({ has: page.getByRole('button', { name: title, exact: true }) });

/** 周X of today + `days` in Asia/Shanghai, as the list labels days 2–6 ahead. */
function weekdayIn(days: number): string {
  const name = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'short' }).format(new Date(Date.now() + days * 86_400_000));
  return name.replace('星期', '周');
}

async function addTask(page: Page, title: string) {
  await quickAdd(page).fill(title);
  await quickAdd(page).press('Enter');
  await expect(openTasks(page).getByRole('button', { name: title, exact: true })).toBeVisible();
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

test('a daily 重复任务 from the 重复 menu: completing it shows the next instance', async ({ page }, testInfo) => {
  const user = createUser('repeat');
  await logIn(page, user.username, user.password);
  await addTask(page, '背单词');

  await openTask(page, '背单词');
  await openPicker(page);
  await picker(page).getByRole('button', { name: '今天', exact: true }).click();
  await picker(page).getByRole('button', { name: '重复：无' }).click();
  const menu = picker(page).getByRole('menu', { name: '重复：无' });
  await expect(menu.getByRole('menuitemradio')).toHaveText([
    '无',
    '每天',
    /^每周（周.）$/,
    /^每月（\d+日）$/,
    /^每年（\d+月\d+日）$/,
    '每周工作日（周一至周五）',
    '法定工作日',
    '自定义',
  ]);
  await page.screenshot({ path: testInfo.outputPath(`repeat-menu-${testInfo.project.name}.png`) });
  await menu.getByRole('menuitemradio', { name: '每天' }).click();
  await expect(picker(page).getByRole('button', { name: '重复：每天' })).toBeVisible();
  await picker(page).getByRole('button', { name: '确定' }).click();
  await expect(detail(page).getByRole('button', { name: '日期：今天，重复：每天' })).toBeVisible();

  await backToList(page);
  await expect(openRow(page, '背单词').getByText('重复：每天')).toBeAttached();
  await openTasks(page).getByRole('checkbox', { name: '背单词' }).click();

  // The completed instance moves to 已完成; the next one is due tomorrow.
  await expect(completedTasks(page).getByRole('checkbox', { name: '背单词' })).toBeChecked();
  await expect(openRow(page, '背单词').locator('.task-row-date')).toHaveText('明天');
  await expect(openTasks(page).getByRole('checkbox', { name: '背单词' })).toHaveCount(1);
});

test('自定义重复: every 2 days 按完成日期, 3 times; Esc returns to the date panel', async ({ page }, testInfo) => {
  const user = createUser('repeat-custom');
  await logIn(page, user.username, user.password);
  await addTask(page, '浇花');
  await openTask(page, '浇花');
  await openPicker(page);

  // No date yet: choosing a rule starts the series today.
  await picker(page).getByRole('button', { name: '重复：无' }).click();
  await picker(page).getByRole('menuitemradio', { name: '自定义' }).click();
  await expect(editor(page)).toBeVisible();
  await expect(editor(page).getByRole('radio', { name: '按截止日期' })).toBeFocused();

  // Weekly shows the weekday chips (screenshot), then switch to every 2 days.
  await editor(page).getByLabel('重复单位').selectOption('weekly');
  await editor(page).getByRole('button', { name: '周一', exact: true }).click();
  await editor(page).getByLabel('跳过法定节假日').check();
  await expect(editor(page).getByRole('button', { name: '周一', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: testInfo.outputPath(`repeat-custom-${testInfo.project.name}.png`) });

  await editor(page).getByLabel('重复单位').selectOption('daily');
  await editor(page).getByLabel('间隔').fill('2');
  await editor(page).getByLabel('跳过法定节假日').uncheck();
  await editor(page).getByRole('radio', { name: '按完成日期' }).click();
  await editor(page).getByLabel('结束重复').selectOption('count');
  await editor(page).getByLabel('重复次数').fill('3');
  await expect(editor(page).getByText('每2天，按完成日期，重复3次')).toBeVisible();

  // Esc leaves the editor without saving, the picker stays open.
  await page.keyboard.press('Escape');
  await expect(editor(page)).toBeHidden();
  await expect(picker(page)).toBeVisible();
  await expect(picker(page).getByRole('button', { name: '重复：无' })).toBeFocused();

  await picker(page).getByRole('button', { name: '重复：无' }).click();
  await picker(page).getByRole('menuitemradio', { name: '自定义' }).click();
  await editor(page).getByLabel('间隔').fill('2');
  await editor(page).getByRole('radio', { name: '按完成日期' }).click();
  await editor(page).getByLabel('结束重复').selectOption('count');
  await editor(page).getByLabel('重复次数').fill('3');
  await editor(page).getByRole('button', { name: '确定' }).click();
  await expect(picker(page).getByRole('button', { name: '重复：每2天，按完成日期，重复3次' })).toBeVisible();
  await picker(page).getByRole('button', { name: '确定' }).click();
  await expect(detail(page).getByRole('button', { name: '日期：今天，重复：每2天' })).toBeVisible();

  await backToList(page);
  await openTasks(page).getByRole('checkbox', { name: '浇花' }).click();
  await expect(completedTasks(page).getByRole('checkbox', { name: '浇花' })).toBeChecked();
  await expect(openRow(page, '浇花').locator('.task-row-date')).toHaveText(weekdayIn(2));
  await page.screenshot({ path: testInfo.outputPath(`repeat-list-${testInfo.project.name}.png`) });
});
