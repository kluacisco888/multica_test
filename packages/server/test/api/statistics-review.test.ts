import { statisticsSchema, taskSchema, type Statistics } from '@dida/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/*
 * Review edge cases for `GET /api/statistics` (EURO-28): authentication,
 * malformed queries, concurrent reads, and the paths that change a 任务's
 * dates other than a single PATCH (批量改日期, clearing the dates), which must
 * keep the −2 of a 任务 that was already overdue.
 */

// 2026-10-14 10:00 in Asia/Shanghai.
const START = '2026-10-14T02:00:00.000Z';

describe('statistics (review)', () => {
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
    return t.createUser(`statsreview${n}`);
  }

  const inject = (u: TestUser | null, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    t.app.inject({ method, url, ...(u ? { headers: u.headers } : {}), ...(payload ? { payload } : {}) });

  async function ok(u: TestUser, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) {
    const res = await inject(u, method, url, payload);
    expect(res.statusCode, `${method} ${url}: ${res.body}`).toBeLessThan(300);
    return res;
  }
  const createTask = async (u: TestUser, body: object = {}) => taskSchema.parse((await ok(u, 'POST', '/api/tasks', { title: '任务', ...body })).json());
  const due = (dueDate: string) => ({ allDay: true, dueDate });
  const score = async (u: TestUser) => statisticsSchema.parse((await ok(u, 'GET', '/api/statistics')).json()).achievement.score;

  /** +5 on 10-08, so later −2s are not hidden by the floor at 0. */
  async function seedFive(u: TestUser) {
    clock.set('2026-10-08T02:00:00.000Z');
    const base = await createTask(u);
    await ok(u, 'PATCH', `/api/tasks/${base.id}`, { status: 'completed' });
    clock.set(START);
  }

  it('requires a session (401 without one)', async () => {
    expect((await inject(null, 'GET', '/api/statistics')).statusCode).toBe(401);
    const bad = await t.app.inject({ method: 'GET', url: '/api/statistics', headers: { cookie: 'sid=not-a-session' } });
    expect(bad.statusCode).toBe(401);
  });

  it('rejects malformed queries with 400: empty, impossible, wrong format, overlong, unknown keys', async () => {
    const u = await user();
    for (const q of ['?date=', '?date=2026-02-30', '?date=20261014', '?date=2026-1-4', `?date=${'9'.repeat(5000)}`, '?date=2026-10-14&x=1', '?userId=00000000-0000-0000-0000-000000000000']) {
      const res = await inject(u, 'GET', `/api/statistics${q}`);
      expect(res.statusCode, q.slice(0, 40)).toBe(400);
    }
  });

  it('serves concurrent reads consistently', async () => {
    const u = await user();
    const task = await createTask(u);
    await ok(u, 'PATCH', `/api/tasks/${task.id}`, { status: 'completed' });
    const results = await Promise.all(Array.from({ length: 10 }, () => inject(u, 'GET', '/api/statistics')));
    for (const res of results) expect(res.statusCode).toBe(200);
    const scores = results.map((r) => (r.json() as Statistics).achievement.score);
    expect(new Set(scores)).toEqual(new Set([5]));
  });

  it('批量改日期 keeps the −2 of an overdue 任务', async () => {
    const u = await user();
    await seedFive(u);
    const a = await createTask(u, { dates: due('2026-10-10') });
    const b = await createTask(u, { dates: due('2026-10-11') });
    expect(await score(u)).toBe(1);
    await ok(u, 'POST', '/api/tasks/batch', { ids: [a.id, b.id], action: { op: 'dates', dates: due('2026-10-30') } });
    expect(await score(u)).toBe(1);
  });

  it('clearing the dates (dates: null) keeps the −2', async () => {
    const u = await user();
    await seedFive(u);
    const a = await createTask(u, { dates: due('2026-10-10') });
    expect(await score(u)).toBe(3);
    await ok(u, 'PATCH', `/api/tasks/${a.id}`, { dates: null });
    expect(await score(u)).toBe(3);
    // Completing it afterwards is still late: +2.
    await ok(u, 'PATCH', `/api/tasks/${a.id}`, { status: 'completed' });
    expect(await score(u)).toBe(5);
  });

  it('放弃 → 重新打开 → 完成 counts like a normal completion; 放弃 never enters 完成率', async () => {
    const u = await user();
    const a = await createTask(u, { dates: due('2026-10-14') });
    await ok(u, 'PATCH', `/api/tasks/${a.id}`, { status: 'abandoned' });
    let s = statisticsSchema.parse((await ok(u, 'GET', '/api/statistics')).json());
    expect(s.trends.day.at(-1)!.completion).toEqual({ done: 0, planned: 0 });
    expect(s.achievement.score).toBe(0);
    await ok(u, 'PATCH', `/api/tasks/${a.id}`, { status: 'open' });
    await ok(u, 'PATCH', `/api/tasks/${a.id}`, { status: 'completed' });
    s = statisticsSchema.parse((await ok(u, 'GET', '/api/statistics')).json());
    expect(s.trends.day.at(-1)!.completion).toEqual({ done: 1, planned: 1 });
    expect(s.achievement.score).toBe(5);
  });

  it("another user's 任务 ids cannot be used to move points", async () => {
    const a = await user();
    const b = await user();
    await seedFive(a);
    const overdue = await createTask(a, { dates: due('2026-10-10') });
    expect((await inject(b, 'PATCH', `/api/tasks/${overdue.id}`, { status: 'completed' })).statusCode).toBe(404);
    expect(await score(a)).toBe(3);
    expect(await score(b)).toBe(0);
  });
});
