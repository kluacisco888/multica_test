import { checklistItemsResponseSchema, statisticsSchema, taskSchema, tasksResponseSchema, type HolidayYear, type Task } from '@dida/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { startFakeHolidayCn, type FakeHolidayCn } from '../support/fake-holiday-cn.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/*
 * 重复任务 (spec 用户故事 41–50): completing an instance generates the next
 * one (dates from the 重复规则引擎 with the stored / built-in 节假日数据), and
 * 节假日数据更新 corrects next instances that are still open.
 * holiday-cn is a local fake; until a refresh the built-in data is used.
 */

// 2026-10-14 is a Wednesday; 10:00 in Asia/Shanghai.
const WEDNESDAY = '2026-10-14T02:00:00.000Z';

const announced2027: HolidayYear = {
  year: 2027,
  days: [
    { name: '元旦', date: '2027-01-01', isOffDay: true },
    { name: '春节', date: '2027-02-07', isOffDay: false },
    { name: '春节', date: '2027-02-08', isOffDay: true },
  ],
};

describe('repeat tasks API', () => {
  const clock = fixedClock(WEDNESDAY);
  let fake: FakeHolidayCn;
  let t: TestApp;
  let alice: TestUser;
  let bob: TestUser;
  let listId: string;

  beforeAll(async () => {
    fake = await startFakeHolidayCn();
    t = await createTestApp({ clock, env: { HOLIDAY_DATA_URL: fake.url } });
    alice = await t.createUser('alice');
    bob = await t.createUser('bob');
    const res = await api(alice, 'POST', '/api/lists', { name: '重复' });
    expect(res.statusCode, res.body).toBe(201);
    listId = (res.json() as { id: string }).id;
  });
  afterAll(async () => {
    await t.close();
    await fake.close();
  });
  beforeEach(() => clock.set(WEDNESDAY));

  function api(user: TestUser, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) {
    return t.app.inject({ method, url, headers: user.headers, ...(payload ? { payload } : {}) });
  }

  async function createTask(payload: object, user = alice): Promise<Task> {
    const res = await api(user, 'POST', '/api/tasks', { listId, ...payload });
    expect(res.statusCode, res.body).toBe(201);
    return taskSchema.parse(res.json());
  }

  async function patchTask(id: string, patch: object): Promise<Task> {
    const res = await api(alice, 'PATCH', `/api/tasks/${id}`, patch);
    expect(res.statusCode, res.body).toBe(200);
    return taskSchema.parse(res.json());
  }

  async function listTasks(): Promise<Task[]> {
    const res = await api(alice, 'GET', `/api/tasks?listId=${listId}`);
    return tasksResponseSchema.parse(res.json()).tasks;
  }

  /** Complete `task` and return the open instance generated from it (or undefined). */
  async function complete(task: Task): Promise<Task | undefined> {
    const done = await patchTask(task.id, { status: 'completed' });
    expect(done.status).toBe('completed');
    return (await listTasks()).find((x) => x.status === 'open' && x.id !== task.id && x.title === task.title);
  }

  const allDay = (dueDate: string) => ({ allDay: true, dueDate });

  describe('spec Q27', () => {
    it('a daily task 6 days overdue: the next instance is today', async () => {
      const task = await createTask({ title: 'Q27 每天过期', dates: allDay('2026-10-08'), repeat: { freq: 'daily' } });
      const next = await complete(task);
      expect(next?.dates).toEqual({ allDay: true, startDate: null, dueDate: '2026-10-14' });
    });

    it('a daily task due today: the next instance is tomorrow', async () => {
      const task = await createTask({ title: 'Q27 每天今天', dates: allDay('2026-10-14'), repeat: { freq: 'daily' } });
      expect((await complete(task))?.dates).toEqual({ allDay: true, startDate: null, dueDate: '2026-10-15' });
    });

    it('every Monday, completed on a Wednesday: the next instance is next Monday', async () => {
      const task = await createTask({ title: 'Q27 每周一', dates: allDay('2026-10-12'), repeat: { freq: 'weekly', weekdays: [1] } });
      expect((await complete(task))?.dates).toEqual({ allDay: true, startDate: null, dueDate: '2026-10-19' });
    });
  });

  it('the next instance copies the task and keeps its place; the completed one stays completed', async () => {
    const tag = (await api(alice, 'POST', '/api/tags', { name: '习惯' })).json() as { id: string };
    const task = await createTask({
      title: '背单词',
      description: '每天 20 个',
      priority: 'high',
      tagIds: [tag.id],
      dates: allDay('2026-10-14'),
      repeat: { freq: 'daily', interval: 2 },
    });
    const next = await complete(task);
    expect(next).toMatchObject({
      title: '背单词',
      description: '每天 20 个',
      priority: 'high',
      tagIds: [tag.id],
      listId,
      parentId: null,
      sortOrder: task.sortOrder,
      status: 'open',
      repeat: { freq: 'daily', interval: 2, weekdays: [], basis: 'due', skipHolidays: false, end: { type: 'never' } },
      dates: { allDay: true, startDate: null, dueDate: '2026-10-16' },
    });
    const old = taskSchema.parse((await api(alice, 'GET', `/api/tasks/${task.id}`)).json());
    expect(old).toMatchObject({ status: 'completed', dates: task.dates, repeat: task.repeat });
  });

  it('a timed task keeps its time of day; a range keeps its length', async () => {
    // 21:00–22:00 in Shanghai.
    const timed = await createTask({
      title: '晚上跑步',
      dates: { allDay: false, startAt: '2026-10-14T13:00:00.000Z', dueAt: '2026-10-14T14:00:00.000Z' },
      repeat: { freq: 'daily' },
    });
    expect((await complete(timed))?.dates).toEqual({
      allDay: false,
      startAt: '2026-10-15T13:00:00.000Z',
      dueAt: '2026-10-15T14:00:00.000Z',
      timeZone: 'Asia/Shanghai',
    });
    const span = await createTask({ title: '周报', dates: { allDay: true, startDate: '2026-10-12', dueDate: '2026-10-14' }, repeat: { freq: 'weekly' } });
    expect((await complete(span))?.dates).toEqual({ allDay: true, startDate: '2026-10-19', dueDate: '2026-10-21' });
  });

  it('按完成日期 counts from the day it was completed', async () => {
    const task = await createTask({ title: '理发', dates: allDay('2026-10-01'), repeat: { freq: 'daily', interval: 3, basis: 'completion' } });
    expect((await complete(task))?.dates).toMatchObject({ dueDate: '2026-10-17' });
  });

  it('every 工作日 uses the built-in holiday data (国庆 2026)', async () => {
    clock.set('2026-09-30T02:00:00.000Z');
    const task = await createTask({ title: '日报', dates: allDay('2026-09-30'), repeat: { freq: 'workday' } });
    expect((await complete(task))?.dates).toMatchObject({ dueDate: '2026-10-08' });
  });

  it('completing, re-opening and completing again generates only one next instance', async () => {
    const task = await createTask({ title: '只生成一次', dates: allDay('2026-10-14'), repeat: { freq: 'daily' } });
    await complete(task);
    await patchTask(task.id, { status: 'open' });
    await patchTask(task.id, { status: 'completed' });
    expect((await listTasks()).filter((x) => x.title === '只生成一次')).toHaveLength(2);
  });

  it('重复 N 次 stops after the N-th instance; 到某天结束 stops after that day', async () => {
    const first = await createTask({ title: '三次', dates: allDay('2026-10-14'), repeat: { freq: 'daily', end: { type: 'count', count: 2 } } });
    const second = await complete(first);
    expect(second?.dates).toMatchObject({ dueDate: '2026-10-15' });
    expect(await complete(second as Task)).toBeUndefined();

    const until = await createTask({ title: '到明天', dates: allDay('2026-10-15'), repeat: { freq: 'daily', end: { type: 'until', date: '2026-10-15' } } });
    expect(await complete(until)).toBeUndefined();
  });

  it('a 检查清单 instance starts with the same 检查项, none checked', async () => {
    const task = await createTask({ title: '出门检查', dates: allDay('2026-10-14'), repeat: { freq: 'daily' } });
    await patchTask(task.id, { kind: 'checklist' });
    for (const title of ['钥匙', '钱包']) {
      const res = await api(alice, 'POST', `/api/tasks/${task.id}/checklist-items`, { title });
      expect(res.statusCode, res.body).toBe(201);
    }
    const items = checklistItemsResponseSchema.parse((await api(alice, 'GET', `/api/tasks/${task.id}/checklist-items`)).json()).items;
    await api(alice, 'PATCH', `/api/checklist-items/${items[0]?.id}`, { completed: true });
    const next = await complete({ ...task, kind: 'checklist' });
    expect(next?.kind).toBe('checklist');
    const copied = checklistItemsResponseSchema.parse((await api(alice, 'GET', `/api/tasks/${next?.id}/checklist-items`)).json()).items;
    expect(copied.map((i) => [i.title, i.completed])).toEqual([
      ['钥匙', false],
      ['钱包', false],
    ]);
  });

  it('validates the rule and needs a date; clearing the dates stops the repeat', async () => {
    let res = await api(alice, 'POST', '/api/tasks', { listId, title: '无日期', repeat: { freq: 'daily' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'repeat_needs_date' } });
    res = await api(alice, 'POST', '/api/tasks', { listId, title: '坏规则', dates: allDay('2026-10-14'), repeat: { freq: 'workday', interval: 2 } });
    expect(res.statusCode).toBe(400);

    const plain = await createTask({ title: '后来加重复' });
    res = await api(alice, 'PATCH', `/api/tasks/${plain.id}`, { repeat: { freq: 'daily' } });
    expect(res.json()).toMatchObject({ error: { code: 'repeat_needs_date' } });
    const withRule = await patchTask(plain.id, { dates: allDay('2026-10-20'), repeat: { freq: 'monthly', monthDay: 20 } });
    expect(withRule.repeat).toMatchObject({ freq: 'monthly', monthDay: 20 });
    expect((await patchTask(plain.id, { dates: null })).repeat).toBeNull();

    const stopped = await createTask({ title: '不再重复', dates: allDay('2026-10-14'), repeat: { freq: 'daily' } });
    await patchTask(stopped.id, { repeat: null });
    expect(await complete(stopped)).toBeUndefined();
  });

  it("another user's 重复任务 cannot be completed or read", async () => {
    const task = await createTask({ listId: null, title: 'bob 的', dates: allDay('2026-10-14'), repeat: { freq: 'daily' } }, bob);
    expect((await api(alice, 'PATCH', `/api/tasks/${task.id}`, { status: 'completed' })).statusCode).toBe(404);
    const bobs = await api(bob, 'GET', `/api/tasks?listId=${task.listId}`);
    expect(tasksResponseSchema.parse(bobs.json()).tasks.map((x) => x.status)).toEqual(['open']);
  });

  it('节假日数据更新 moves open next instances to the corrected 工作日', async () => {
    // 2027 is not published yet: 工作日 counts Monday–Friday.
    const newYear = await complete(await createTask({ title: '元旦前', dates: allDay('2026-12-31'), repeat: { freq: 'workday' } }));
    const springFestival = await complete(await createTask({ title: '春节前', dates: allDay('2027-02-05'), repeat: { freq: 'workday' } }));
    // 09:00 in Shanghai.
    const timed = await complete(
      await createTask({ title: '定时', dates: { allDay: false, startAt: null, dueAt: '2026-12-31T01:00:00.000Z' }, repeat: { freq: 'workday' } }),
    );
    const byHand = await complete(await createTask({ title: '手动改过', dates: allDay('2026-12-31'), repeat: { freq: 'workday' } }));
    const finished = await complete(await createTask({ title: '已完成的', dates: allDay('2026-12-31'), repeat: { freq: 'workday' } }));
    expect(newYear?.dates).toMatchObject({ dueDate: '2027-01-01' });
    expect(springFestival?.dates).toMatchObject({ dueDate: '2027-02-08' });
    expect(timed?.dates).toMatchObject({ dueAt: '2027-01-01T01:00:00.000Z' });
    await patchTask((byHand as Task).id, { dates: allDay('2027-01-02') });
    await patchTask((finished as Task).id, { status: 'completed' });

    fake.set(2027, { json: announced2027 });
    const refresh = await api(alice, 'POST', '/api/holidays/refresh');
    expect(refresh.statusCode, refresh.body).toBe(200);
    expect(refresh.json()).toMatchObject({ results: expect.arrayContaining([{ year: 2027, outcome: 'updated' }]) });

    const after = new Map((await listTasks()).map((x) => [x.id, x]));
    // 2027-01-01 is 元旦 → the next 工作日 is Monday 01-04.
    expect(after.get((newYear as Task).id)?.dates).toMatchObject({ dueDate: '2027-01-04' });
    // Sunday 02-07 is a 调休补班 day → it comes before Monday 02-08 (now 春节).
    expect(after.get((springFestival as Task).id)?.dates).toMatchObject({ dueDate: '2027-02-07' });
    expect(after.get((timed as Task).id)?.dates).toMatchObject({ dueAt: '2027-01-04T01:00:00.000Z' });
    // Moved by hand, or already completed: left alone.
    expect(after.get((byHand as Task).id)?.dates).toMatchObject({ dueDate: '2027-01-02' });
    expect(after.get((finished as Task).id)).toMatchObject({ status: 'completed', dates: { dueDate: '2027-01-01' } });

    // The correction is a normal change: it shows up in the sync feed.
    const changes = (await api(alice, 'GET', '/api/changes?since=0')).json() as { entities: { task?: { upserts: { id: string; dueDate: string }[] } } };
    expect(changes.entities.task?.upserts.find((x) => x.id === (newYear as Task).id)?.dueDate).toBe('2027-01-04');
  });

  it('节假日数据更新 that moves an overdue next instance keeps its −2 on the day it became overdue', async () => {
    // Wednesday 2027-12-29, and a user of its own: other users' tasks are overdue by then.
    clock.set('2027-12-29T02:00:00.000Z');
    const carol = await t.createUser('carol');
    const created = await api(carol, 'POST', '/api/tasks', { title: '跨年日报', dates: allDay('2027-12-31'), repeat: { freq: 'workday' } });
    expect(created.statusCode, created.body).toBe(201);
    const first = taskSchema.parse(created.json());
    const carolTasks = async () => tasksResponseSchema.parse((await api(carol, 'GET', `/api/tasks?listId=${first.listId}`)).json()).tasks;
    const completed = await api(carol, 'PATCH', `/api/tasks/${first.id}`, { status: 'completed' });
    expect(completed.statusCode, completed.body).toBe(200);
    // 2028 is not published yet: the 工作日 after Friday 2027-12-31 is Monday 2028-01-03.
    const open = (await carolTasks()).find((x) => x.status === 'open');
    expect(open?.dates).toMatchObject({ dueDate: '2028-01-03' });

    // A week later, Wednesday 2028-01-05: overdue since 01-04, −2 on that day (+5 from completing on time).
    clock.set('2028-01-05T02:00:00.000Z');
    const history = async () => {
      const res = await api(carol, 'GET', '/api/statistics');
      expect(res.statusCode, res.body).toBe(200);
      return Object.fromEntries(statisticsSchema.parse(res.json()).achievement.history.map((d) => [d.date, d.score]));
    };
    expect(await history()).toMatchObject({ '2028-01-03': 5, '2028-01-04': 3, '2028-01-05': 3 });

    // 01-03 becomes a holiday: the instance moves to 01-04, which alone would make it overdue only from 01-05.
    fake.set(2028, { json: { year: 2028, days: [{ name: '元旦', date: '2028-01-03', isOffDay: true }] } satisfies HolidayYear });
    const refresh = await api(carol, 'POST', '/api/holidays/refresh');
    expect(refresh.statusCode, refresh.body).toBe(200);
    expect(refresh.json()).toMatchObject({ results: expect.arrayContaining([{ year: 2028, outcome: 'updated' }]) });
    const moved = (await carolTasks()).find((x) => x.id === open?.id);
    expect(moved?.dates).toMatchObject({ dueDate: '2028-01-04' });

    // The −2 already taken stays on 01-04.
    expect(await history()).toMatchObject({ '2028-01-03': 5, '2028-01-04': 3, '2028-01-05': 3 });
  });
});
