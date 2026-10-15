import { statisticsSchema, taskSchema, type Statistics } from '@dida/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/*
 * 统计 and 成就分 (EURO-28, spec 用户故事 102、103) through `GET /api/statistics`.
 * The clock is injected; the user's time zone is the default Asia/Shanghai.
 * The 成就分 rules themselves are unit-tested in shared/src/achievement.test.ts;
 * here they are checked against real 任务, 专注 and 打卡 history.
 */

const MIN = 60_000;
// 2026-10-14 10:00 in Asia/Shanghai (周三).
const START = '2026-10-14T02:00:00.000Z';
const TODAY = '2026-10-14';
const plus = (iso: string, ms: number) => new Date(new Date(iso).getTime() + ms).toISOString();

describe('statistics', () => {
  const clock = fixedClock(START);
  let t: TestApp;
  let n = 0;

  beforeAll(async () => {
    t = await createTestApp({ clock });
  });
  afterAll(async () => {
    await t.close();
  });

  async function user(): Promise<TestUser> {
    clock.set(START);
    n += 1;
    return t.createUser(`stats${n}`);
  }

  async function api(u: TestUser, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) {
    const res = await t.app.inject({ method, url, headers: u.headers, ...(payload ? { payload } : {}) });
    expect(res.statusCode, `${method} ${url}: ${res.body}`).toBeLessThan(300);
    return res;
  }

  async function createTask(u: TestUser, body: object = {}) {
    const res = await api(u, 'POST', '/api/tasks', { title: '任务', ...body });
    return taskSchema.parse(res.json());
  }
  const setStatus = (u: TestUser, id: string, status: string) => api(u, 'PATCH', `/api/tasks/${id}`, { status });
  const due = (dueDate: string) => ({ dates: { allDay: true, dueDate } });

  async function stats(u: TestUser, query = ''): Promise<Statistics> {
    const res = await api(u, 'GET', `/api/statistics${query}`);
    return statisticsSchema.parse(res.json());
  }
  const lastDay = (s: Statistics) => s.trends.day.at(-1)!;

  it('放弃的任务不计入完成: neither in 已完成 nor in 完成率, and earns no 成就分', async () => {
    const u = await user();
    const done = await createTask(u, due(TODAY));
    const abandoned = await createTask(u, due(TODAY));
    await createTask(u, due(TODAY)); // still open
    await setStatus(u, done.id, 'completed');
    await setStatus(u, abandoned.id, 'abandoned');

    const s = await stats(u);
    expect(s.today).toBe(TODAY);
    expect(s.summary).toMatchObject({ tasks: 3, completed: 1, days: 1 });
    expect(s.overview).toMatchObject({ todayCompleted: 1, totalCompleted: 1 });
    expect(lastDay(s)).toMatchObject({ from: TODAY, completed: 1, completion: { done: 1, planned: 2 } });
    expect(s.trends.week.at(-1)).toMatchObject({ from: '2026-10-12', to: '2026-10-18', completed: 1 });
    expect(s.trends.month.at(-1)).toMatchObject({ from: '2026-10-01', completed: 1 });
    expect(s.achievement.score).toBe(5);
    expect(s.achievement.level).toMatchObject({ name: '新手', next: 100 });
  });

  it('each user only sees their own numbers', async () => {
    const a = await user();
    const b = await user();
    const task = await createTask(a);
    await setStatus(a, task.id, 'completed');
    const s = await stats(b);
    expect(s.summary).toMatchObject({ tasks: 0, completed: 0 });
    expect(s.overview.totalCompleted).toBe(0);
    expect(s.achievement.score).toBe(0);
  });

  it('a deleted 任务 leaves the numbers but keeps its 成就分', async () => {
    const u = await user();
    const task = await createTask(u);
    await setStatus(u, task.id, 'completed');
    await api(u, 'DELETE', `/api/tasks/${task.id}`);
    const s = await stats(u);
    expect(s.summary).toMatchObject({ tasks: 0, completed: 0 });
    expect(s.achievement.score).toBe(5);
  });

  it('取消完成 takes the points back', async () => {
    const u = await user();
    const task = await createTask(u);
    await setStatus(u, task.id, 'completed');
    expect((await stats(u)).achievement.score).toBe(5);
    await setStatus(u, task.id, 'open');
    const s = await stats(u);
    expect(s.achievement.score).toBe(0);
    expect(s.overview.totalCompleted).toBe(0);
  });

  it('过期 is −2 once: moving the date, 补完成 or 彻底删除 does not give it back', async () => {
    const u = await user();
    // +5 on 10-08, so the later −2s are not hidden by the floor at 0.
    clock.set('2026-10-08T02:00:00.000Z');
    const base = await createTask(u);
    await setStatus(u, base.id, 'completed');
    clock.set(START);
    const late = await createTask(u, due('2026-10-10'));
    expect((await stats(u)).achievement.score).toBe(3);

    // A new date does not undo the −2 …
    await api(u, 'PATCH', `/api/tasks/${late.id}`, due('2026-10-20'));
    expect((await stats(u)).achievement.score).toBe(3);
    // … and completing it is late: +2.
    await setStatus(u, late.id, 'completed');
    expect((await stats(u)).achievement.score).toBe(5);

    // 彻底删除 of an overdue one keeps its −2 too.
    const purged = await createTask(u, due('2026-10-11'));
    expect((await stats(u)).achievement.score).toBe(3);
    await api(u, 'DELETE', `/api/tasks/${purged.id}`);
    await api(u, 'DELETE', `/api/trash/${purged.id}`);
    expect((await stats(u)).achievement.score).toBe(3);
  });

  it('番茄 and 正计时 count for 专注 and the 成就分 (每满 25 分钟一个); 放弃的专注 does not', async () => {
    const u = await user();
    await api(u, 'POST', '/api/focus/start', { mode: 'pomodoro' });
    clock.set(plus(START, 25 * MIN)); // the 番茄 runs out and settles
    await api(u, 'POST', '/api/focus/current/finish'); // end the 短休息
    await api(u, 'POST', '/api/focus/start', { mode: 'stopwatch' });
    clock.set(plus(START, 80 * MIN)); // 正计时 55 minutes: 2 × 25
    await api(u, 'POST', '/api/focus/current/finish');
    await api(u, 'POST', '/api/focus/start', { mode: 'pomodoro' });
    clock.set(plus(START, 90 * MIN));
    await api(u, 'POST', '/api/focus/current/abandon');

    const s = await stats(u);
    expect(s.overview).toMatchObject({ todayPomodoros: 1, todayFocusMs: 80 * MIN, totalPomodoros: 1, totalFocusMs: 80 * MIN });
    expect(lastDay(s)).toMatchObject({ pomodoros: 1, focusMs: 80 * MIN });
    expect(s.achievement.score).toBe(9);
  });

  it('shows 习惯 打卡 per period and 本周打卡进展 (周日 first)', async () => {
    const u = await user();
    const res = await api(u, 'POST', '/api/habits', { name: '跑步', startDate: '2026-10-12' });
    const habit = res.json() as { id: string };
    await api(u, 'PUT', `/api/habits/${habit.id}/checkins/2026-10-12`, { count: 1 });
    await api(u, 'PUT', `/api/habits/${habit.id}/checkins/${TODAY}`, { count: 1 });

    const s = await stats(u);
    expect(lastDay(s).habits).toEqual({ done: 1, planned: 1 });
    expect(s.trends.week.at(-1)!.habits).toEqual({ done: 2, planned: 3 }); // 12, 13 (missed), 14
    expect(s.habitWeek.map((d) => d.date)[0]).toBe('2026-10-11');
    expect(s.habitWeek.map((d) => [d.done, d.due])).toEqual([[0, 0], [1, 1], [0, 1], [1, 1], [0, 1], [0, 1], [0, 1]]);
  });

  it('trends end with the period of `date`, and reject a bad date', async () => {
    const u = await user();
    const s = await stats(u, '?date=2026-09-03');
    expect(lastDay(s).from).toBe('2026-09-03');
    expect(s.trends.day).toHaveLength(7);
    const bad = await t.app.inject({ method: 'GET', url: '/api/statistics?date=2026-13-01', headers: u.headers });
    expect(bad.statusCode).toBe(400);
  });
});
