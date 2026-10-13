import { taskSchema, tasksResponseSchema, type HolidayYear, type Task } from '@dida/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { startFakeHolidayCn, type FakeHolidayCn } from '../support/fake-holiday-cn.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/*
 * Review (EURO-14) edge cases for 重复任务 over HTTP: malformed rules,
 * concurrent completion, and per-user isolation of the 节假日数据更新 recompute.
 */

// 2026-10-14 (Wednesday) 10:00 in Asia/Shanghai.
const WEDNESDAY = '2026-10-14T02:00:00.000Z';
const announced2027: HolidayYear = { year: 2027, days: [{ name: '元旦', date: '2027-01-01', isOffDay: true }] };

type Changes = { entities: { task?: { upserts: { id: string; userId?: string }[] } } };

describe('repeat tasks API: review edge cases', () => {
  const clock = fixedClock(WEDNESDAY);
  let fake: FakeHolidayCn;
  let t: TestApp;
  let alice: TestUser;
  let bob: TestUser;

  beforeAll(async () => {
    fake = await startFakeHolidayCn();
    t = await createTestApp({ clock, env: { HOLIDAY_DATA_URL: fake.url } });
    alice = await t.createUser('alice');
    bob = await t.createUser('bob');
  });
  afterAll(async () => {
    await t.close();
    await fake.close();
  });

  function api(user: TestUser, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) {
    return t.app.inject({ method, url, headers: user.headers, ...(payload ? { payload } : {}) });
  }
  async function createTask(user: TestUser, payload: object): Promise<Task> {
    const res = await api(user, 'POST', '/api/tasks', { listId: null, ...payload });
    expect(res.statusCode, res.body).toBe(201);
    return taskSchema.parse(res.json());
  }
  async function tasksOf(user: TestUser, listId: string): Promise<Task[]> {
    return tasksResponseSchema.parse((await api(user, 'GET', `/api/tasks?listId=${listId}`)).json()).tasks;
  }
  async function completeAndGetNext(user: TestUser, task: Task): Promise<Task> {
    const res = await api(user, 'PATCH', `/api/tasks/${task.id}`, { status: 'completed' });
    expect(res.statusCode, res.body).toBe(200);
    const next = (await tasksOf(user, task.listId)).find((x) => x.status === 'open' && x.title === task.title && x.id !== task.id);
    expect(next).toBeDefined();
    return next as Task;
  }

  it.each<[string, unknown]>([
    ['interval 0', { freq: 'daily', interval: 0 }],
    ['interval 100', { freq: 'daily', interval: 100 }],
    ['weekday 7', { freq: 'weekly', weekdays: [7] }],
    ['unknown field', { freq: 'daily', rrule: 'FREQ=DAILY' }],
    ['a string', 'FREQ=DAILY'],
    ['until not a date', { freq: 'daily', end: { type: 'until', date: '2026-13-01' } }],
  ])('rejects a malformed rule: %s', async (_what, repeat) => {
    const res = await api(alice, 'POST', '/api/tasks', { listId: null, title: '坏规则', dates: { allDay: true, dueDate: '2026-10-14' }, repeat });
    expect(res.statusCode, res.body).toBe(400);
  });

  it("cannot set a rule on another user's task", async () => {
    const bobs = await createTask(bob, { title: 'bob 的任务', dates: { allDay: true, dueDate: '2026-10-14' } });
    const res = await api(alice, 'PATCH', `/api/tasks/${bobs.id}`, { repeat: { freq: 'daily' } });
    expect(res.statusCode).toBe(404);
    expect(taskSchema.parse((await api(bob, 'GET', `/api/tasks/${bobs.id}`)).json()).repeat).toBeNull();
  });

  it('two concurrent completions generate exactly one next instance', async () => {
    const task = await createTask(alice, { title: '并发完成', dates: { allDay: true, dueDate: '2026-10-14' }, repeat: { freq: 'daily' } });
    const results = await Promise.all([
      api(alice, 'PATCH', `/api/tasks/${task.id}`, { status: 'completed' }),
      api(alice, 'PATCH', `/api/tasks/${task.id}`, { status: 'completed' }),
    ]);
    for (const res of results) expect(res.statusCode, res.body).toBe(200);
    const series = (await tasksOf(alice, task.listId)).filter((x) => x.title === '并发完成');
    expect(series.filter((x) => x.status === 'open')).toHaveLength(1);
    expect(series).toHaveLength(2);
  });

  it('the recompute moves each user only their own instances, attributed to that user; stopped repeats stay', async () => {
    const due = { allDay: true, dueDate: '2026-12-31' };
    const alices = await completeAndGetNext(alice, await createTask(alice, { title: 'alice 日报', dates: due, repeat: { freq: 'workday' } }));
    const bobs = await completeAndGetNext(bob, await createTask(bob, { title: 'bob 日报', dates: due, repeat: { freq: 'workday' } }));
    const stopped = await completeAndGetNext(alice, await createTask(alice, { title: '不再重复', dates: due, repeat: { freq: 'workday' } }));
    expect(stopped.dates).toMatchObject({ dueDate: '2027-01-01' });
    expect((await api(alice, 'PATCH', `/api/tasks/${stopped.id}`, { repeat: null })).statusCode).toBe(200);
    expect([alices.dates, bobs.dates]).toEqual([expect.objectContaining({ dueDate: '2027-01-01' }), expect.objectContaining({ dueDate: '2027-01-01' })]);

    fake.set(2027, { json: announced2027 });
    // Triggered by alice, but holiday data is global: bob's instance is corrected too.
    expect((await api(alice, 'POST', '/api/holidays/refresh')).statusCode).toBe(200);

    expect((await tasksOf(alice, alices.listId)).find((x) => x.id === alices.id)?.dates).toMatchObject({ dueDate: '2027-01-04' });
    expect((await tasksOf(bob, bobs.listId)).find((x) => x.id === bobs.id)?.dates).toMatchObject({ dueDate: '2027-01-04' });
    expect((await tasksOf(alice, stopped.listId)).find((x) => x.id === stopped.id)?.dates).toMatchObject({ dueDate: '2027-01-01' });

    // Isolation: bob's corrected task is only in bob's feed; alice never sees it.
    const aliceFeed = (await api(alice, 'GET', '/api/changes?since=0')).json() as Changes;
    const bobFeed = (await api(bob, 'GET', '/api/changes?since=0')).json() as Changes;
    expect(aliceFeed.entities.task?.upserts.map((x) => x.id)).not.toContain(bobs.id);
    expect(bobFeed.entities.task?.upserts.map((x) => x.id)).toContain(bobs.id);
    expect(bobFeed.entities.task?.upserts.map((x) => x.id)).not.toContain(alices.id);
    expect((await api(alice, 'GET', `/api/tasks/${bobs.id}`)).statusCode).toBe(404);
  });
});
