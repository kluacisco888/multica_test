/// <reference lib="dom" />
// locator.evaluate callbacks below run in the browser.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { createUser, isMobile, logIn, openSidebar } from './support.js';

/*
 * Background colours checked against the reference (EURO-40, measured again
 * with tools/reference-env in 1440×900 screenshots of the 滴答 小号):
 *
 * - 日历 月 / 周 / 多日: 周六 and 周日 cells are #f5f7fc, the other days
 *   #f8faff (the reference's background has a ±1 gradient; these are the
 *   values at the top of the grid). The weekday label row is not darkened.
 * - 时间线: the name column is #ffffff.
 * - 习惯打卡 with no habit selected: the right-hand pane is the page's
 *   #f8faff, not white.
 *
 * In 深色 the weekend still differs from the other days.
 * The browser clock is pinned to 2026-10-13T04:00Z: 周二 12:00 in Shanghai.
 */

const NOW = new Date('2026-10-13T04:00:00.000Z');
const WEEKDAY_BG = 'rgb(248, 250, 255)'; // #f8faff
const WEEKEND_BG = 'rgb(245, 247, 252)'; // #f5f7fc
const WHITE = 'rgb(255, 255, 255)';

/** The colour an element shows: its own background, or the first non-transparent one behind it. */
const bg = (target: Locator) =>
  target.evaluate((el) => {
    for (let node: Element | null = el; node; node = node.parentElement) {
      const colour = getComputedStyle(node).backgroundColor;
      if (colour !== 'rgba(0, 0, 0, 0)' && colour !== 'transparent') return colour;
    }
    return 'rgba(0, 0, 0, 0)';
  });
/** The month cell of a day: the button's parent carries the background. */
const monthCell = (page: Page, label: string) =>
  page.getByRole('button', { name: new RegExp(`^${label} .*，新建任务$`) }).locator('..');
/** A time-grid day column: the parent of that day's task list. */
const dayColumn = (page: Page, label: string) => page.getByRole('list', { name: `${label}的任务` }).locator('..');
const allDayCell = (page: Page, label: string) => page.getByRole('button', { name: new RegExp(`^${label} .*，新建全天任务$`) });

async function openModule(page: Page, name: '日历' | '习惯打卡') {
  if (isMobile(page)) {
    const sidebar = await openSidebar(page);
    await sidebar.getByRole('button', { name }).click();
  } else {
    await page.getByRole('navigation', { name: '模块' }).getByRole('link', { name }).click();
  }
}

async function setTheme(page: Page, themeMode: 'light' | 'dark') {
  const res = await page.request.patch('/api/settings', { data: { themeMode } });
  expect(res.ok(), await res.text()).toBe(true);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', themeMode);
}

test('日历: 周六 and 周日 are darker than the other days in 月, 周 and 多日', async ({ page }, testInfo) => {
  await page.clock.setFixedTime(NOW);
  const user = createUser('backgrounds-calendar');
  await logIn(page, user.username, user.password);
  await openModule(page, '日历');
  await expect(page.getByRole('heading', { level: 1, name: '2026年10月' })).toBeVisible();

  // 月: 10-17 is a Saturday, 10-18 a Sunday, 10-14 a Wednesday.
  expect(await bg(monthCell(page, '10月14日'))).toBe(WEEKDAY_BG);
  expect(await bg(monthCell(page, '10月17日'))).toBe(WEEKEND_BG);
  expect(await bg(monthCell(page, '10月18日'))).toBe(WEEKEND_BG);
  await page.screenshot({ path: testInfo.outputPath(`backgrounds-month-${testInfo.project.name}.png`) });

  // 周 (Sunday 10-11 … Saturday 10-17): the columns, and the 全天 row above them.
  await page.goto('/calendar/week/2026-10-13');
  expect(await bg(dayColumn(page, '10月14日'))).toBe(WEEKDAY_BG);
  expect(await bg(dayColumn(page, '10月11日'))).toBe(WEEKEND_BG);
  expect(await bg(dayColumn(page, '10月17日'))).toBe(WEEKEND_BG);
  expect(await bg(allDayCell(page, '10月17日'))).toBe(WEEKEND_BG);
  expect(await bg(allDayCell(page, '10月14日'))).toBe(WEEKDAY_BG);
  await page.screenshot({ path: testInfo.outputPath(`backgrounds-week-${testInfo.project.name}.png`) });

  // 多日 from 10-16: 周五, 周六, 周日.
  await page.goto('/calendar/multiDay/2026-10-16');
  expect(await bg(dayColumn(page, '10月16日'))).toBe(WEEKDAY_BG);
  expect(await bg(dayColumn(page, '10月17日'))).toBe(WEEKEND_BG);
  expect(await bg(dayColumn(page, '10月18日'))).toBe(WEEKEND_BG);

  // 深色: still two different colours, neither of them the 浅色 ones.
  await setTheme(page, 'dark');
  await page.goto('/calendar/month/2026-10-13');
  const darkWeekday = await bg(monthCell(page, '10月14日'));
  const darkWeekend = await bg(monthCell(page, '10月17日'));
  expect(darkWeekend).not.toBe(darkWeekday);
  expect([WEEKDAY_BG, WEEKEND_BG]).not.toContain(darkWeekend);
  await page.goto('/calendar/week/2026-10-13');
  expect(await bg(dayColumn(page, '10月17日'))).toBe(darkWeekend);
});

test('时间线 name column is white, like the reference', async ({ page }) => {
  await page.clock.setFixedTime(NOW);
  const user = createUser('backgrounds-timeline');
  await logIn(page, user.username, user.password);
  const res = await page.request.post('/api/tasks', { data: { title: '整理周报', dates: { allDay: true, startDate: '2026-10-13', dueDate: '2026-10-14' } } });
  expect(res.ok()).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: '排序和分组' }).click();
  await page.getByRole('menuitemradio', { name: '时间线' }).click();
  const name = page.getByRole('main').getByRole('button', { name: '整理周报', exact: true });
  await expect(name).toBeVisible();
  expect(await bg(name)).toBe(WHITE);
  // The empty part of the column below the rows too.
  expect(await bg(page.locator('.timeline-name-rail'))).toBe(WHITE);
});

test('习惯打卡: the right-hand pane has the page background while no habit is selected', async ({ page }, testInfo) => {
  test.skip(isMobile(page), 'the right-hand pane only shows on desktop');
  await page.clock.setFixedTime(NOW);
  const user = createUser('backgrounds-habits');
  await logIn(page, user.username, user.password);
  await openModule(page, '习惯打卡');
  const detail = page.getByRole('complementary', { name: '习惯详情' });
  await expect(detail.getByText('点击习惯标题查看详情')).toBeVisible();
  expect(await bg(detail)).toBe(WEEKDAY_BG);
  await page.screenshot({ path: testInfo.outputPath(`backgrounds-habits-${testInfo.project.name}.png`) });

  await setTheme(page, 'dark');
  expect(await bg(page.getByRole('complementary', { name: '习惯详情' }))).not.toBe(WEEKDAY_BG);
});
