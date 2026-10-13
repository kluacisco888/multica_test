import { expect, test, type Page } from '@playwright/test';
import { createUser, isMobile, logIn, openSidebar } from './support.js';

/*
 * 习惯打卡 (EURO-25, spec 用户故事 93–98): the empty page, create a 数量型
 * habit and a 每周固定几天 habit, 打卡 today, 补打卡 an earlier day from the
 * 7-day strip and from the 月度日历, 撤销, the 连续 / 完成率 statistics,
 * 归档 and 删除. The browser clock is pinned to 2026-10-13T04:00Z: 周二
 * 12:00 in Shanghai (the reference screenshots were taken that day).
 */

const NOW = new Date('2026-10-13T04:00:00.000Z');

async function openHabits(page: Page) {
  if (isMobile(page)) {
    const sidebar = await openSidebar(page);
    await sidebar.getByRole('button', { name: '习惯打卡' }).click();
  } else {
    await page.getByRole('navigation', { name: '模块' }).getByRole('link', { name: '习惯打卡' }).click();
  }
  await expect(page.getByRole('heading', { level: 1, name: '习惯' })).toBeVisible();
}

async function addHabit(page: Page, name: string, setup: (dialog: ReturnType<Page['getByRole']>) => Promise<void> = async () => {}) {
  await page.getByRole('button', { name: '添加习惯' }).click();
  const dialog = page.getByRole('dialog', { name: '添加习惯' });
  await dialog.getByLabel('名称').fill(name);
  await setup(dialog);
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog).toBeHidden();
}

test('empty 习惯 page (reference screenshot comparison)', async ({ page }, testInfo) => {
  await page.clock.setFixedTime(NOW);
  const user = createUser('habits-empty');
  await logIn(page, user.username, user.password);
  await openHabits(page);
  await expect(page).toHaveURL(/\/habits$/);
  await expect(page.getByText('来一起养成习惯吧')).toBeVisible();
  const week = page.getByRole('list', { name: '最近 7 天' });
  await expect(week.getByRole('button')).toHaveCount(7);
  await expect(week.getByRole('button', { name: /^今天/ })).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: testInfo.outputPath(`habits-empty-${testInfo.project.name}.png`) });
});

test('打卡, 补打卡, 撤销, 连续 and 完成率, 归档 and 删除', async ({ page }, testInfo) => {
  await page.clock.setFixedTime(NOW);
  const user = createUser('habits');
  await logIn(page, user.username, user.password);
  await openHabits(page);

  // A 数量型 habit with a reminder, and a 每周固定几天 habit (周一、周二).
  await addHabit(page, '喝水', async (dialog) => {
    await dialog.getByLabel('当天完成一定量').check();
    await dialog.getByLabel('每天目标数量').fill('3');
    await dialog.getByLabel('单位').fill('杯');
    await dialog.getByRole('button', { name: '添加提醒' }).click();
    await expect(dialog.getByText('09:00')).toBeVisible();
  });
  if (isMobile(page)) await page.getByRole('button', { name: '返回' }).click();
  await addHabit(page, '跑步', async (dialog) => {
    await dialog.getByLabel('每周固定几天').check();
    const days = dialog.getByRole('group', { name: '在这些天' });
    for (const d of ['三', '四', '五']) {
      await days.getByText(d, { exact: true }).click();
      await expect(days.getByRole('checkbox', { name: d, exact: true })).not.toBeChecked();
    }
  });
  if (isMobile(page)) await page.getByRole('button', { name: '返回' }).click();

  const habits = page.getByRole('list', { name: '坚持中的习惯' });
  await expect(habits.getByRole('listitem')).toHaveCount(2);

  // 打卡 today: 喝水 counts up to the target, 跑步 is done at once.
  const water = page.getByRole('button', { name: '打卡：喝水（今天）' });
  await water.click();
  await expect(habits.getByText('1/3 杯')).toBeVisible();
  await water.click();
  await water.click();
  await expect(page.getByRole('button', { name: '撤销打卡：喝水（今天）' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '打卡：跑步（今天）' }).click();

  // 补打卡 yesterday (周一) from the 7-day strip.
  await page.getByRole('list', { name: '最近 7 天' }).getByRole('button', { name: /^2026-10-12/ }).click();
  await page.getByRole('button', { name: '打卡：跑步（2026-10-12）' }).click();
  await expect(page.getByRole('button', { name: '撤销打卡：跑步（2026-10-12）' })).toBeVisible();
  await expect(page.getByRole('list', { name: '最近 7 天' }).getByRole('button', { name: /^2026-10-12，完成 1\/1/ })).toBeVisible();

  // The detail: 连续 2 天 (周一、周二), 完成率 100%; 补打卡 last 周二 in the 月度日历 too.
  await habits.getByRole('button', { name: /^跑步/ }).click();
  await expect(page).toHaveURL(/\/habits\/[0-9a-f-]+$/);
  const detail = page.getByRole('complementary', { name: '习惯详情' });
  await expect(detail.getByRole('heading', { name: '跑步' })).toBeVisible();
  await expect(detail.getByText('当前连续').locator('..')).toContainText('2 天');
  await expect(detail.getByText('10月完成率').locator('..')).toContainText('100%');
  await detail.getByRole('button', { name: '10月6日' }).click();
  await expect(detail.getByRole('button', { name: '10月6日，已打卡' })).toBeVisible();
  await expect(detail.getByText('最高连续').locator('..')).toContainText('3 天');
  await expect(detail.getByText('总打卡').locator('..')).toContainText('3 天');
  await page.screenshot({ path: testInfo.outputPath(`habits-detail-${testInfo.project.name}.png`) });

  // 撤销 in the calendar.
  await detail.getByRole('button', { name: '10月6日，已打卡' }).click();
  await expect(detail.getByRole('button', { name: '10月6日', exact: true })).toBeVisible();
  // Future days cannot be checked in.
  await expect(detail.getByRole('button', { name: '10月20日' })).toBeDisabled();

  // 归档: gone from 坚持中, listed under 已归档.
  await detail.getByRole('button', { name: '习惯操作：跑步' }).click();
  await page.getByRole('menuitem', { name: '归档', exact: true }).click();
  await expect(habits.getByRole('listitem')).toHaveCount(1);
  await page.getByRole('button', { name: '习惯分类' }).click();
  await page.getByRole('menuitemradio', { name: '已归档' }).click();
  const archived = page.getByRole('list', { name: '已归档的习惯' });
  await expect(archived.getByText('跑步')).toBeVisible();

  // 删除 from 已归档.
  await archived.getByRole('button', { name: /^跑步/ }).click();
  await page.getByRole('button', { name: '习惯操作：跑步' }).click();
  await page.getByRole('menuitem', { name: '删除', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '删除习惯' });
  await expect(confirm).toContainText('以前辛苦累积的数据都会被删掉');
  await confirm.getByRole('button', { name: '删除' }).click();
  await expect(page.getByText('还没有已归档的习惯')).toBeVisible();

  // Habits never show up in the 任务 lists.
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: '收件箱' })).toBeVisible();
  await expect(page.getByText('喝水')).toHaveCount(0);
});

test('习惯 list with habits (screenshots)', async ({ page }, testInfo) => {
  await page.clock.setFixedTime(NOW);
  const user = createUser('habits-shot');
  await logIn(page, user.username, user.password);
  for (const [name, extra] of [
    ['早起', {}],
    ['喝水', { goal: { type: 'count', target: 8, unit: '杯' } }],
    ['阅读', { frequency: { type: 'weekly', times: 3 } }],
  ] as const) {
    const res = await page.request.post('/api/habits', { data: { name, startDate: '2026-10-01', ...extra } });
    expect(res.ok()).toBe(true);
    const habit = (await res.json()) as { id: string };
    for (const date of ['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12']) {
      await page.request.put(`/api/habits/${habit.id}/checkins/${date}`, { data: { count: name === '喝水' ? 8 : 1 } });
    }
  }
  await openHabits(page);
  await expect(page.getByRole('list', { name: '坚持中的习惯' }).getByRole('listitem')).toHaveCount(3);
  await expect(page.getByText('已连续 4 天').first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`habits-list-${testInfo.project.name}.png`) });
});
