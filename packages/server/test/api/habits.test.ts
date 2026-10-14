import { changesResponseSchema, habitSchema, habitsResponseSchema, type Habit } from '@dida/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/*
 * 习惯打卡 API (spec 用户故事 93–98): create with the three frequencies and
 * both goals, 打卡 / 补打卡 / 撤销, 归档, 删除, isolation between users, and
 * habits staying out of the 任务 lists.
 */

// 2026-10-14 10:00 in Asia/Shanghai (周三).
const START = '2026-10-14T02:00:00.000Z';

describe('habits API', () => {
  const clock = fixedClock(START);
  let t: TestApp;
  let alice: TestUser;
  let bob: TestUser;

  beforeAll(async () => {
    t = await createTestApp({ clock });
    alice = await t.createUser('alice');
    bob = await t.createUser('bob');
  });
  afterAll(async () => {
    await t.close();
  });

  function api(user: TestUser, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) {
    return t.app.inject({ method, url, headers: user.headers, ...(payload ? { payload } : {}) });
  }

  async function create(user: TestUser, payload: object): Promise<Habit> {
    const res = await api(user, 'POST', '/api/habits', payload);
    expect(res.statusCode, res.body).toBe(201);
    return habitSchema.parse(res.json());
  }

  async function checkIn(user: TestUser, id: string, date: string, count = 1) {
    return api(user, 'PUT', `/api/habits/${id}/checkins/${date}`, { count });
  }

  it('creates habits with each frequency and goal; defaults are 每天 and 完成一次', async () => {
    const plain = await create(alice, { name: '早起' });
    expect(plain).toMatchObject({
      name: '早起',
      frequency: { type: 'daily' },
      goal: { type: 'once' },
      reminders: [],
      reminderChannelIds: null,
      startDate: '2026-10-14',
      archivedAt: null,
      checkins: [],
    });
    const mwf = await create(alice, { name: '跑步', frequency: { type: 'weekdays', days: [5, 1, 3] } });
    expect(mwf.frequency).toEqual({ type: 'weekdays', days: [1, 3, 5] });
    const weekly = await create(alice, { name: '读书', frequency: { type: 'weekly', times: 3 } });
    expect(weekly.frequency).toEqual({ type: 'weekly', times: 3 });
    const water = await create(alice, { name: '喝水', goal: { type: 'count', target: 8, unit: '杯' }, reminders: ['20:00', '09:00'] });
    expect(water.goal).toEqual({ type: 'count', target: 8, unit: '杯' });
    expect(water.reminders).toEqual(['09:00', '20:00']);
  });

  it('a client-generated id is kept', async () => {
    const id = '0f0f0f0f-0000-4000-8000-000000000001';
    expect((await create(alice, { id, name: '冥想' })).id).toBe(id);
    expect((await api(alice, 'POST', '/api/habits', { id, name: '冥想' })).statusCode).toBe(409);
  });

  it('rejects bad input', async () => {
    expect((await api(alice, 'POST', '/api/habits', { name: '' })).statusCode).toBe(400);
    expect((await api(alice, 'POST', '/api/habits', { name: 'x', frequency: { type: 'weekly', times: 9 } })).statusCode).toBe(400);
    const res = await api(alice, 'POST', '/api/habits', { name: 'x', reminderChannelIds: ['0f0f0f0f-0000-4000-8000-0000000000ff'] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_channels');
  });

  it('打卡 today, 补打卡 an earlier day, 撤销 a day', async () => {
    const h = await create(alice, { name: '背单词' });
    let res = await checkIn(alice, h.id, '2026-10-14');
    expect(res.statusCode, res.body).toBe(200);
    res = await checkIn(alice, h.id, '2026-10-12'); // 补打卡
    expect(res.statusCode).toBe(200);
    expect(habitSchema.parse(res.json()).checkins).toEqual([
      { date: '2026-10-12', count: 1 },
      { date: '2026-10-14', count: 1 },
    ]);
    res = await api(alice, 'DELETE', `/api/habits/${h.id}/checkins/2026-10-14`);
    expect(res.statusCode).toBe(200);
    expect(habitSchema.parse(res.json()).checkins).toEqual([{ date: '2026-10-12', count: 1 }]);
    // Checking in the undone day again revives it.
    res = await checkIn(alice, h.id, '2026-10-14');
    expect(habitSchema.parse(res.json()).checkins).toHaveLength(2);
  });

  it('a 完成一次 habit always records 1; a 数量型 habit records the amount', async () => {
    const once = await create(alice, { name: '吃早饭' });
    expect(habitSchema.parse((await checkIn(alice, once.id, '2026-10-14', 5)).json()).checkins).toEqual([{ date: '2026-10-14', count: 1 }]);
    const water = await create(alice, { name: '喝水2', goal: { type: 'count', target: 8, unit: '杯' } });
    await checkIn(alice, water.id, '2026-10-14', 3);
    const res = await checkIn(alice, water.id, '2026-10-14', 6);
    expect(habitSchema.parse(res.json()).checkins).toEqual([{ date: '2026-10-14', count: 6 }]);
  });

  it('days after today (in the user time zone) cannot be checked in', async () => {
    const h = await create(alice, { name: '散步' });
    // 2026-10-14 23:30 in Shanghai is still the 14th; the 15th is tomorrow.
    clock.set('2026-10-14T15:30:00.000Z');
    expect((await checkIn(alice, h.id, '2026-10-15')).statusCode).toBe(400);
    expect((await checkIn(alice, h.id, '2026-10-14')).statusCode).toBe(200);
    expect((await checkIn(alice, h.id, '2026-02-30')).statusCode).toBe(400);
    clock.set(START);
  });

  it('归档 moves a habit to 已归档; it cannot be checked in until restored', async () => {
    const h = await create(alice, { name: '练字' });
    let res = await api(alice, 'PATCH', `/api/habits/${h.id}`, { archived: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().archivedAt).toBe(START);
    const active = habitsResponseSchema.parse((await api(alice, 'GET', '/api/habits')).json()).habits;
    expect(active.map((x) => x.id)).not.toContain(h.id);
    const archived = habitsResponseSchema.parse((await api(alice, 'GET', '/api/habits?archived=true')).json()).habits;
    expect(archived.map((x) => x.id)).toEqual([h.id]);
    res = await checkIn(alice, h.id, '2026-10-14');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('habit_archived');
    res = await api(alice, 'PATCH', `/api/habits/${h.id}`, { archived: false });
    expect(res.json().archivedAt).toBeNull();
  });

  it('edits name, frequency, goal and reminders', async () => {
    const h = await create(alice, { name: '旧名' });
    const res = await api(alice, 'PATCH', `/api/habits/${h.id}`, {
      name: '新名',
      frequency: { type: 'weekly', times: 2 },
      goal: { type: 'count', target: 3, unit: '次' },
      reminders: ['07:30'],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ name: '新名', frequency: { type: 'weekly', times: 2 }, goal: { target: 3 }, reminders: ['07:30'] });
  });

  it('删除 soft-deletes the habit and its 打卡 (tombstones in /api/changes)', async () => {
    const h = await create(alice, { name: '要删的' });
    await checkIn(alice, h.id, '2026-10-14');
    const before = changesResponseSchema.parse((await api(alice, 'GET', '/api/changes?since=0')).json()).revision;
    expect((await api(alice, 'DELETE', `/api/habits/${h.id}`)).statusCode).toBe(204);
    expect((await api(alice, 'GET', `/api/habits/${h.id}`)).statusCode).toBe(404);
    expect((await checkIn(alice, h.id, '2026-10-14')).statusCode).toBe(404);
    const changes = changesResponseSchema.parse((await api(alice, 'GET', `/api/changes?since=${before}`)).json());
    expect(changes.entities.habit?.tombstones.map((x) => x.id)).toEqual([h.id]);
    expect(changes.entities.habitCheckin?.tombstones).toHaveLength(1);
  });

  it("another user's habits are 404 and never listed", async () => {
    const h = await create(alice, { name: '私有' });
    expect((await api(bob, 'GET', `/api/habits/${h.id}`)).statusCode).toBe(404);
    expect((await api(bob, 'PATCH', `/api/habits/${h.id}`, { name: 'x' })).statusCode).toBe(404);
    expect((await api(bob, 'DELETE', `/api/habits/${h.id}`)).statusCode).toBe(404);
    expect((await checkIn(bob, h.id, '2026-10-14')).statusCode).toBe(404);
    expect((await api(bob, 'DELETE', `/api/habits/${h.id}/checkins/2026-10-14`)).statusCode).toBe(404);
    expect(habitsResponseSchema.parse((await api(bob, 'GET', '/api/habits')).json()).habits).toEqual([]);
    expect((await t.app.inject({ method: 'GET', url: '/api/habits' })).statusCode).toBe(401);
  });

  it('habits are not 任务: the task lists stay empty', async () => {
    const carol = await t.createUser('carol');
    await create(carol, { name: '只是习惯' });
    for (const url of ['/api/tasks?smart=today', '/api/tasks?smart=week', '/api/search?q=只是习惯', '/api/smart-lists']) {
      const res = await api(carol, 'GET', encodeURI(url));
      expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
      expect(JSON.stringify(res.json())).not.toContain('只是习惯');
    }
    expect(habitsResponseSchema.parse((await api(carol, 'GET', '/api/habits')).json()).habits).toHaveLength(1);
  });
});
