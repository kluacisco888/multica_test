import { expect, test, type Page } from '@playwright/test';
import { createUser, isMobile, logIn, openSidebar } from './support.js';

/*
 * 番茄专注 (EURO-24, spec 用户故事 86–92). The real server keeps the timer:
 * a reload continues it. A 1-minute 番茄 runs out while the page is open and
 * goes into the 短休息 by itself, with the 专注记录 and 概览 updated.
 */

const timer = (page: Page) => page.getByRole('timer');
const main = (page: Page) => page.getByRole('region', { name: '番茄专注' });
const side = (page: Page) => page.getByRole('complementary', { name: '专注概览与记录' });

async function openFocus(page: Page) {
  if (isMobile(page)) {
    await openSidebar(page);
    await page.getByRole('button', { name: '番茄专注' }).click();
  } else {
    await page.getByRole('navigation', { name: '模块' }).getByRole('link', { name: '番茄专注' }).click();
  }
  await expect(page.getByRole('heading', { level: 1, name: '番茄专注' })).toBeVisible();
  await expect(page).toHaveURL(/\/focus$/);
}

async function addTask(page: Page, title: string) {
  const res = await page.request.post('/api/tasks', { data: { title, dates: { allDay: true, dueDate: todayInShanghai() } } });
  expect(res.status()).toBe(201);
}

function todayInShanghai() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

/** `MM:SS` on the timer as seconds. */
async function shownSeconds(page: Page): Promise<number> {
  const text = (await timer(page).locator('.focus-time').textContent()) ?? '';
  const [m, s] = text.split(':').map(Number);
  return (m as number) * 60 + (s as number);
}

test('start a 番茄 for a task, pause, reload, 继续 and 放弃', async ({ page }) => {
  const user = createUser('focus');
  await logIn(page, user.username, user.password);
  await addTask(page, '写周报');
  await openFocus(page);

  await expect(timer(page)).toHaveAccessibleName('未开始，剩余 25:00');
  await expect(main(page).getByRole('radio', { name: '番茄计时' })).toBeChecked();

  await main(page).getByRole('button', { name: '选择关联任务' }).click();
  const picker = page.getByRole('dialog', { name: '选择任务' });
  await picker.getByRole('button', { name: '写周报' }).click();
  await expect(picker).toHaveCount(0);
  await expect(main(page).getByRole('button', { name: '关联任务：写周报' })).toBeVisible();

  await main(page).getByRole('button', { name: '开始' }).click();
  await expect(timer(page)).toHaveAccessibleName(/^专注中，剩余 24:5\d$/, { timeout: 5_000 });
  // While a 番茄 runs the other mode is locked.
  await expect(main(page).getByRole('radio', { name: '正计时' })).toBeDisabled();

  await main(page).getByRole('button', { name: '暂停' }).click();
  await expect(timer(page)).toHaveAccessibleName(/^已暂停/);
  const pausedAt = await shownSeconds(page);

  // Refresh: still paused at the same time, still linked to the task.
  await page.reload();
  await expect(timer(page)).toHaveAccessibleName(/^已暂停/);
  expect(await shownSeconds(page)).toBe(pausedAt);
  await expect(main(page).getByRole('button', { name: '关联任务：写周报' })).toBeVisible();

  await main(page).getByRole('button', { name: '继续' }).click();
  await expect(timer(page)).toHaveAccessibleName(/^专注中/);
  await main(page).getByRole('button', { name: '放弃' }).click();
  await expect(timer(page)).toHaveAccessibleName('未开始，剩余 25:00');
  await expect(side(page).getByText('还没有专注记录')).toBeVisible();
});

test('a 1-minute 番茄 ends while the page is open and the 短休息 starts by itself', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const user = createUser('pomo');
  await logIn(page, user.username, user.password);
  await addTask(page, '背单词');
  await openFocus(page);

  await main(page).getByRole('button', { name: '专注更多操作' }).click();
  await page.getByRole('menuitem', { name: '番茄设置' }).click();
  const settings = page.getByRole('dialog', { name: '番茄设置' });
  await settings.getByLabel('专注时长（分钟）').fill('1');
  await settings.getByLabel('短休息时长（分钟）').fill('3');
  await settings.getByRole('button', { name: '保存' }).click();
  await expect(settings).toHaveCount(0);
  await expect(timer(page)).toHaveAccessibleName('未开始，剩余 01:00');

  await main(page).getByRole('button', { name: '选择关联任务' }).click();
  await page.getByRole('dialog', { name: '选择任务' }).getByRole('button', { name: '背单词' }).click();
  await main(page).getByRole('button', { name: '开始' }).click();

  await expect(timer(page)).toHaveAccessibleName(/^短休息中，剩余 0[23]:\d\d$/, { timeout: 75_000 });
  await expect(page.getByRole('status').filter({ hasText: '专注结束，开始短休息' })).toBeAttached();
  await expect(main(page).getByRole('button', { name: '跳过休息' })).toBeVisible();

  const records = side(page).getByRole('region', { name: '专注记录' });
  await expect(records.getByText('背单词')).toBeVisible();
  await expect(records.getByText('1m', { exact: true })).toBeVisible();
  const overview = side(page).getByRole('region', { name: '概览' });
  await expect(overview.getByRole('definition').first()).toHaveText('1');
  await expect(side(page).getByRole('list', { name: '任务用时' })).toContainText('背单词');

  await page.screenshot({ path: testInfo.outputPath(`focus-${testInfo.project.name}.png`), fullPage: false });

  await main(page).getByRole('button', { name: '跳过休息' }).click();
  await expect(timer(page)).toHaveAccessibleName('未开始，剩余 01:00');
});
