import { expect, test, type Page } from '@playwright/test';
import { createUser, isMobile, logIn, openSidebar } from './support.js';

/*
 * 日历视图 (EURO-19, spec 用户故事 69–71): 月 / 周 / 日 / 多日, 农历 and 休 / 班,
 * click an empty day or slot to add a task, drag a task to another day or time.
 * The browser clock is pinned to 2026-10-13T04:00Z: Tuesday 12:00 in Shanghai.
 */

const NOW = new Date('2026-10-13T04:00:00.000Z');

const calendar = (page: Page) => page.getByRole('main');
const cell = (page: Page, label: string) => page.getByRole('button', { name: new RegExp(`^${label} .*，新建任务$`) });
const taskButton = (page: Page, title: string) => calendar(page).getByRole('button', { name: new RegExp(title) });

async function openCalendar(page: Page) {
  if (isMobile(page)) {
    const sidebar = await openSidebar(page);
    await sidebar.getByRole('button', { name: '日历' }).click();
  } else {
    await page.getByRole('navigation', { name: '模块' }).getByRole('link', { name: '日历' }).click();
  }
  await expect(page.getByRole('heading', { level: 1, name: '2026年10月' })).toBeVisible();
}

async function api<T>(page: Page, method: 'GET' | 'POST' | 'PATCH', url: string, data?: object): Promise<T> {
  const res = await page.request.fetch(url, { method, ...(data ? { data } : {}) });
  expect(res.ok(), `${method} ${url}: ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

type ApiTask = { id: string; title: string; dates: Record<string, unknown> | null };

async function taskByTitle(page: Page, title: string, from = '2026-09-28', to = '2026-11-08'): Promise<ApiTask> {
  const { tasks } = await api<{ tasks: ApiTask[] }>(page, 'GET', `/api/tasks?from=${from}&to=${to}`);
  const task = tasks.find((t) => t.title === title);
  expect(task, title).toBeTruthy();
  return task as ApiTask;
}

async function quickAdd(page: Page, title: string) {
  const input = page.getByRole('textbox', { name: '新任务标题' });
  await expect(input).toBeFocused();
  await input.fill(title);
  await input.press('Enter');
  await expect(taskButton(page, title)).toBeVisible();
  await page.keyboard.press('Escape');
}

test('月视图: 农历 and 休 / 班, add on a day, drag a 日期区间 and a timed task set in another time zone', async ({ page }, testInfo) => {
  await page.clock.setFixedTime(NOW);
  const user = createUser('calendar');
  await logIn(page, user.username, user.password);

  // A 日期区间 and a timed task created while the user was in New York:
  // 20:30 on 10-13 there = 08:30 on 10-14 in Shanghai.
  await api(page, 'POST', '/api/tasks', { title: '出差', dates: { allDay: true, startDate: '2026-10-14', dueDate: '2026-10-16' } });
  await api(page, 'PATCH', '/api/settings', { timeZone: 'America/New_York' });
  await api(page, 'POST', '/api/tasks', { title: '纽约电话会', dates: { allDay: false, dueAt: '2026-10-14T00:30:00.000Z' } });
  await api(page, 'PATCH', '/api/settings', { timeZone: 'Asia/Shanghai' });

  await openCalendar(page);
  await expect(page.getByRole('group', { name: '日历视图' }).getByRole('button', { name: '月', exact: true })).toHaveAttribute('aria-pressed', 'true');

  // 农历, 传统节日, 法定假日 and 调休补班 (same data as the 工作日日历, EURO-10).
  await expect(cell(page, '10月1日')).toHaveAccessibleName(/国庆节休息/);
  await expect(cell(page, '10月10日')).toHaveAccessibleName(/九月 国庆节补班/);
  await expect(cell(page, '10月18日')).toHaveAccessibleName(/重阳节/);
  await expect(cell(page, '10月13日')).toHaveAccessibleName(/初四/);

  // The timed task sits on 10-14 at 08:30 Shanghai time.
  await expect(taskButton(page, '纽约电话会')).toHaveText(/08:30/);

  // Click an empty day: a task due that day.
  await cell(page, '10月22日').click();
  await quickAdd(page, '交周报');
  expect((await taskByTitle(page, '交周报')).dates).toEqual({ allDay: true, startDate: null, dueDate: '2026-10-22' });

  await page.screenshot({ path: testInfo.outputPath(`calendar-month-${testInfo.project.name}.png`) });

  // Drag and drop is a mouse gesture; touch users change dates in the detail.
  if (isMobile(page)) return;

  // Drag the 日期区间 by its first day (10-14) to 10-20: it moves as a whole.
  await taskButton(page, '出差').dragTo(cell(page, '10月20日'), { sourcePosition: { x: 8, y: 8 }, targetPosition: { x: 60, y: 60 } });
  await expect.poll(async () => (await taskByTitle(page, '出差')).dates).toEqual({ allDay: true, startDate: '2026-10-20', dueDate: '2026-10-22' });

  // Drag the New York task from 10-14 to 10-16: still 08:30 Shanghai, now stamped with Shanghai.
  await taskButton(page, '纽约电话会').dragTo(cell(page, '10月16日'), { targetPosition: { x: 60, y: 60 } });
  await expect
    .poll(async () => (await taskByTitle(page, '纽约电话会')).dates)
    .toEqual({ allDay: false, startAt: null, dueAt: '2026-10-16T00:30:00.000Z', timeZone: 'Asia/Shanghai' });

  // Opening a task shows its detail beside the calendar.
  await taskButton(page, '出差').click();
  await expect(page.getByRole('complementary', { name: '任务详情' }).getByRole('textbox', { name: '任务标题' })).toHaveValue('出差');
});

test('周 / 日 / 多日: add at a time slot, drag to another time and onto the 全天 row', async ({ page }, testInfo) => {
  await page.clock.setFixedTime(NOW);
  const user = createUser('calendar-week');
  await logIn(page, user.username, user.password);
  // 09:00–10:30 in Shanghai on 10-13.
  await api(page, 'POST', '/api/tasks', {
    title: '评审会',
    dates: { allDay: false, startAt: '2026-10-13T01:00:00.000Z', dueAt: '2026-10-13T02:30:00.000Z' },
  });
  await openCalendar(page);

  await page.getByRole('group', { name: '日历视图' }).getByRole('button', { name: '周' }).click();
  await expect(page).toHaveURL(/\/calendar\/week\/2026-10-13$/);
  await expect(page.getByRole('list', { name: '10月13日的任务' }).getByRole('button', { name: /评审会/ })).toHaveText(/09:00 - 10:30/);

  // Click an empty slot: a timed task at that hour.
  await page.getByRole('button', { name: '10月16日 15:00，新建任务' }).click({ position: { x: 10, y: 5 } });
  await quickAdd(page, '写周报');
  expect((await taskByTitle(page, '写周报')).dates).toMatchObject({ allDay: false, startAt: null, dueAt: '2026-10-16T07:00:00.000Z' });

  await page.screenshot({ path: testInfo.outputPath(`calendar-week-${testInfo.project.name}.png`) });

  // 日 and 多日.
  await page.getByRole('group', { name: '日历视图' }).getByRole('button', { name: '日', exact: true }).click();
  await expect(page.getByRole('list', { name: '10月13日的任务' })).toBeVisible();
  await expect(page.getByRole('list', { name: '10月14日的任务' })).toHaveCount(0);
  await page.getByRole('group', { name: '日历视图' }).getByRole('button', { name: '多日' }).click();
  await expect(page).toHaveURL(/\/calendar\/multiDay\/2026-10-13$/);
  await expect(page.getByRole('list', { name: '10月15日的任务' })).toBeVisible();
  await expect(page.getByRole('list', { name: '10月16日的任务' })).toHaveCount(0);
  await page.getByRole('button', { name: '下一页' }).click();
  await expect(page).toHaveURL(/\/calendar\/multiDay\/2026-10-16$/);
  await page.getByRole('button', { name: '今天' }).click();
  await page.getByRole('group', { name: '日历视图' }).getByRole('button', { name: '周' }).click();

  if (isMobile(page)) return;

  // Drag the 09:00 block by its top to 10-15 14:00: same 1.5 h.
  const block = page.getByRole('list', { name: '10月13日的任务' }).getByRole('button', { name: /评审会/ });
  await block.dragTo(page.getByRole('button', { name: '10月15日 14:00，新建任务' }), { sourcePosition: { x: 10, y: 2 }, targetPosition: { x: 10, y: 2 } });
  await expect
    .poll(async () => (await taskByTitle(page, '评审会')).dates)
    .toEqual({ allDay: false, startAt: '2026-10-15T06:00:00.000Z', dueAt: '2026-10-15T07:30:00.000Z', timeZone: 'Asia/Shanghai' });

  // Onto the 全天 row of 10-17: an all-day task that day.
  await page
    .getByRole('list', { name: '10月15日的任务' })
    .getByRole('button', { name: /评审会/ })
    .dragTo(page.getByRole('button', { name: /^10月17日 .*，新建全天任务$/ }));
  await expect.poll(async () => (await taskByTitle(page, '评审会')).dates).toEqual({ allDay: true, startDate: null, dueDate: '2026-10-17' });
  await expect(page.getByRole('list', { name: '全天任务' }).getByRole('button', { name: '评审会' })).toBeVisible();
});
