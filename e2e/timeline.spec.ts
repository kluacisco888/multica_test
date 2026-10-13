import { expect, test, type Locator, type Page } from '@playwright/test';
import { createUser, isMobile, logIn } from './support.js';

/*
 * 时间线视图 (EURO-20, spec 用户故事 68): bars from start to due day, a
 * due-date-only task as a one-day bar, tasks without a date in 待安排;
 * dragging a bar or one of its ends (or the keyboard) saves new dates.
 * The browser clock is pinned to 周二 2026-10-13 12:00 in Shanghai.
 */

const NOW = new Date('2026-10-13T04:00:00.000Z');
const DAY = 108; // day width at the 日 scale

type Dates = { allDay: true; startDate: string | null; dueDate: string } | null;

async function createTask(page: Page, title: string, dates: Dates): Promise<string> {
  const res = await page.request.post('/api/tasks', { data: { title, ...(dates ? { dates } : {}) } });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function datesOf(page: Page, id: string): Promise<Dates> {
  const res = await page.request.get(`/api/tasks/${id}`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { dates: Dates }).dates;
}

const bar = (page: Page, title: string) => page.getByRole('button', { name: new RegExp(`^${title}，`) });

/** Drag from a point inside `target` (fraction of its width, or px from its right edge when negative) by `dx`. */
async function dragBy(page: Page, target: Locator, dx: number, at: number) {
  const box = (await target.boundingBox())!;
  const x = at < 0 ? box.x + box.width + at : box.x + box.width * at;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(x + (dx * i) / 6, y);
  await page.mouse.up();
}

test('drag bars and their ends, keyboard moves, and 待安排', async ({ page }, testInfo) => {
  await page.clock.setFixedTime(NOW);
  const user = createUser('timeline');
  await logIn(page, user.username, user.password);

  const whole = await createTask(page, '整条拖动', { allDay: true, startDate: '2026-10-13', dueDate: '2026-10-14' });
  const ends = await createTask(page, '拖动两端', { allDay: true, startDate: null, dueDate: '2026-10-13' });
  const undated = await createTask(page, '没有日期', null);
  await page.reload();

  // Switch the 收件箱 to the 时间线.
  await page.getByRole('button', { name: '排序和分组' }).click();
  await page.getByRole('menuitemradio', { name: '时间线' }).click();
  await expect(page.getByRole('heading', { level: 1, name: '收件箱' })).toBeVisible();

  // A range spans its days; a due-date-only task is one day; no date: no bar, it waits in 待安排.
  await expect(bar(page, '整条拖动')).toHaveAccessibleName('整条拖动，今天 - 明天');
  await expect(bar(page, '拖动两端')).toHaveAccessibleName('拖动两端，今天');
  expect(Math.round((await bar(page, '整条拖动').boundingBox())!.width)).toBe(2 * DAY);
  expect(Math.round((await bar(page, '拖动两端').boundingBox())!.width)).toBe(DAY);
  // Today's column starts 200px into the pane, like the reference, at both widths.
  const pane = (await page.getByRole('main').boundingBox())!;
  expect(Math.round((await bar(page, '拖动两端').boundingBox())!.x - pane.x)).toBe(200);
  await expect(bar(page, '没有日期')).toHaveCount(0);
  const unscheduled = page.getByRole('region', { name: /待安排/ });
  await expect(unscheduled.getByRole('button', { name: '没有日期' })).toBeVisible();

  await page.screenshot({ path: testInfo.outputPath(`timeline-${testInfo.project.name}.png`) });

  // Whole bar: +1 day, length kept (drags stay inside the 390px viewport).
  await dragBy(page, bar(page, '整条拖动'), DAY, 0.1);
  await expect.poll(() => datesOf(page, whole)).toEqual({ allDay: true, startDate: '2026-10-14', dueDate: '2026-10-15' });
  await expect(bar(page, '整条拖动')).toHaveAccessibleName('整条拖动，明天 - 周四');

  // Start handle: a due-date-only task becomes a range; the end handle shrinks it back to one day.
  await dragBy(page, bar(page, '拖动两端'), -DAY, 0.02);
  await expect.poll(() => datesOf(page, ends)).toEqual({ allDay: true, startDate: '2026-10-12', dueDate: '2026-10-13' });
  await dragBy(page, bar(page, '拖动两端'), -DAY, -3);
  await expect.poll(() => datesOf(page, ends)).toEqual({ allDay: true, startDate: null, dueDate: '2026-10-12' });
  if (!isMobile(page)) {
    // End handle the other way: stretch 2 days.
    await dragBy(page, bar(page, '拖动两端'), 2 * DAY, -3);
    await expect.poll(() => datesOf(page, ends)).toEqual({ allDay: true, startDate: '2026-10-12', dueDate: '2026-10-14' });
  }

  // Keyboard: ←/→ moves, Shift changes the end, Alt the start.
  await bar(page, '整条拖动').focus();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => datesOf(page, whole)).toEqual({ allDay: true, startDate: '2026-10-13', dueDate: '2026-10-14' });
  await bar(page, '整条拖动').focus();
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(() => datesOf(page, whole)).toEqual({ allDay: true, startDate: '2026-10-13', dueDate: '2026-10-15' });
  await bar(page, '整条拖动').focus();
  await page.keyboard.press('Alt+ArrowLeft');
  await expect.poll(() => datesOf(page, whole)).toEqual({ allDay: true, startDate: '2026-10-12', dueDate: '2026-10-15' });
  await expect(page.getByRole('status').filter({ hasText: '整条拖动：' })).toHaveText('整条拖动：昨天 - 周四');
  await expect(page).toHaveURL(/\/$/); // Alt+← did not navigate back

  // 待安排 → drop on today's column: due today.
  const item = unscheduled.getByRole('button', { name: '没有日期' });
  const from = (await item.boundingBox())!;
  const row = (await bar(page, '整条拖动').boundingBox())!;
  await page.mouse.move(from.x + 20, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 40, from.y + from.height / 2, { steps: 3 });
  await page.mouse.move(pane.x + 254, row.y + row.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => datesOf(page, undated)).toEqual({ allDay: true, startDate: null, dueDate: '2026-10-13' });
  await expect(bar(page, '没有日期')).toHaveAccessibleName('没有日期，今天');
  await expect(unscheduled).toHaveCount(0);

  // A click (no drag) opens the task.
  await bar(page, '拖动两端').click();
  await expect(page.getByRole('complementary', { name: '任务详情' }).getByRole('textbox', { name: '任务标题' })).toHaveValue('拖动两端');
  if (isMobile(page)) await page.getByRole('button', { name: '返回列表' }).click();

  // The layout is remembered for the view.
  await page.reload();
  await expect(bar(page, '整条拖动')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`timeline-after-${testInfo.project.name}.png`) });
});

test("cannot move another user's task", async ({ page }) => {
  const alice = createUser('tl-alice');
  const bob = createUser('tl-bob');
  await logIn(page, alice.username, alice.password);
  const id = await createTask(page, '只属于 alice', { allDay: true, startDate: null, dueDate: '2026-10-15' });
  await page.context().clearCookies();
  await logIn(page, bob.username, bob.password);
  const res = await page.request.patch(`/api/tasks/${id}`, { data: { dates: { allDay: true, startDate: null, dueDate: '2026-10-20' } } });
  expect(res.status()).toBe(404);
});
