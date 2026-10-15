import { expect, test, type Page } from '@playwright/test';
import { todayIn } from '../packages/shared/src/index.js';
import { createUser, isMobile, logIn } from './support.js';

/*
 * 统计 (EURO-28, spec 用户故事 102、103): the summary bar, 概览, 我的成就值 and
 * the trends, with a 放弃 任务 that must not count as 完成. The server counts
 * from its real today, so dates are relative to it.
 */

const TIME_ZONE = 'Asia/Shanghai';

async function post(page: Page, url: string, data: object) {
  const res = await page.request.post(url, { data });
  expect(res.ok(), await res.text()).toBe(true);
  return res.json() as Promise<{ id: string }>;
}

async function openStatistics(page: Page) {
  if (isMobile(page)) {
    await page.getByRole('button', { name: '更多' }).click();
    await page.getByRole('dialog', { name: '更多' }).getByRole('button', { name: '统计' }).click();
  } else {
    await page.getByRole('link', { name: '统计' }).click();
  }
  await expect(page).toHaveURL(/\/statistics$/);
}

test('统计: 完成数 without 放弃, 成就值, trends by 日 / 周 and 本周打卡进展', async ({ page }, testInfo) => {
  const today = todayIn(new Date(), TIME_ZONE);
  const user = createUser('stats');
  await logIn(page, user.username, user.password);
  const dates = { allDay: true, dueDate: today };
  const done = await post(page, '/api/tasks', { title: '写周报', dates });
  const abandoned = await post(page, '/api/tasks', { title: '不做了', dates });
  await post(page, '/api/tasks', { title: '还没做', dates });
  expect((await page.request.patch(`/api/tasks/${done.id}`, { data: { status: 'completed' } })).ok()).toBe(true);
  expect((await page.request.patch(`/api/tasks/${abandoned.id}`, { data: { status: 'abandoned' } })).ok()).toBe(true);
  const habit = await post(page, '/api/habits', { name: '跑步', startDate: today });
  expect((await page.request.put(`/api/habits/${habit.id}/checkins/${today}`, { data: { count: 1 } })).ok()).toBe(true);

  await openStatistics(page);
  await expect(page.getByRole('heading', { level: 1, name: '统计' })).toBeVisible();

  const summary = page.getByRole('region', { name: '总计' });
  await expect(summary.getByRole('term').filter({ hasText: /^任务$/ }).locator('xpath=following-sibling::dd')).toHaveText('3');
  await expect(summary.getByRole('term').filter({ hasText: /^已完成$/ }).locator('xpath=following-sibling::dd')).toHaveText('1');
  await expect(summary).toContainText('当前等级 新手');

  const overview = page.getByRole('region', { name: '概览' });
  await expect(overview.getByRole('term').filter({ hasText: '今日已完成' }).locator('xpath=following-sibling::dd')).toHaveText('1');
  await expect(overview.getByRole('term').filter({ hasText: '总已完成' }).locator('xpath=following-sibling::dd')).toHaveText('1');

  const achievement = page.getByRole('region', { name: '我的成就值' });
  await expect(achievement.getByLabel('成就值 5')).toBeVisible();
  await expect(achievement.getByRole('img', { name: /成就值趋势：.*今天 5$/ })).toBeVisible();

  const completed = page.getByRole('region', { name: '最近已完成趋势' });
  await expect(completed.getByRole('img', { name: /今天 1$/ })).toBeVisible();
  await completed.getByLabel('最近已完成趋势的统计周期').selectOption('week');
  await expect(completed.getByRole('img', { name: /本周 1$/ })).toBeVisible();

  // 完成率: 1 of the 2 任务 due today that were not 放弃.
  await expect(page.getByRole('region', { name: '最近完成率趋势' }).getByRole('img', { name: /今天 50%$/ })).toBeVisible();
  await expect(page.getByRole('region', { name: '最近打卡完成率趋势' }).getByRole('img', { name: /今天 100%$/ })).toBeVisible();
  await expect(page.getByRole('region', { name: '本周打卡进展' }).getByRole('img', { name: /完成 1\/1/ })).toBeVisible();

  await page.screenshot({ path: testInfo.outputPath(`statistics-${testInfo.project.name}.png`) });
});
