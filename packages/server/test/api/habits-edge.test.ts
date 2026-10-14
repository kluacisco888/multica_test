import { habitSchema, type Habit } from '@dida/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/*
 * 习惯打卡 API boundary cases (EURO-25 review): empty / over-long / malformed
 * input, impossible dates, unauthenticated and cross-user access, other users'
 * 通知渠道, and concurrent 打卡 of the same day.
 */

// 2026-10-14 10:00 in Asia/Shanghai (周三).
const START = '2026-10-14T02:00:00.000Z';

describe('habits API boundaries', () => {
  const clock = fixedClock(START);
  let t: TestApp;
  let alice: TestUser;
  let bob: TestUser;

  beforeAll(async () => {
    t = await createTestApp({ clock });
    alice = await t.createUser('alice-edge');
    bob = await t.createUser('bob-edge');
  });
  afterAll(async () => {
    await t.close();
  });

  function api(user: TestUser | null, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) {
    return t.app.inject({ method, url, headers: user?.headers ?? {}, ...(payload ? { payload } : {}) });
  }

  async function create(user: TestUser, payload: object): Promise<Habit> {
    const res = await api(user, 'POST', '/api/habits', payload);
    expect(res.statusCode, res.body).toBe(201);
    return habitSchema.parse(res.json());
  }

  it('rejects empty, blank and over-long names, and malformed frequency / goal / reminders', async () => {
    for (const payload of [
      {},
      { name: '' },
      { name: '   ' },
      { name: 'x'.repeat(65) },
      { name: 'a', frequency: { type: 'weekdays', days: [] } },
      { name: 'a', frequency: { type: 'weekdays', days: [7] } },
      { name: 'a', frequency: { type: 'weekly', times: 0 } },
      { name: 'a', frequency: { type: 'weekly', times: 7 } },
      { name: 'a', goal: { type: 'count', target: 0, unit: '杯' } },
      { name: 'a', goal: { type: 'count', target: -1, unit: '杯' } },
      { name: 'a', goal: { type: 'count', target: 1.5, unit: '杯' } },
      { name: 'a', reminders: ['25:00'] },
      { name: 'a', reminders: ['9:00'] },
      { name: 'a', startDate: '2026-02-30' },
      { name: 'a', unknown: true },
    ]) {
      const res = await api(alice, 'POST', '/api/habits', payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect((await create(alice, { name: 'x'.repeat(64) })).name).toHaveLength(64);
  });

  it('rejects impossible and malformed 打卡 dates and bad counts', async () => {
    const water = await create(alice, { name: '喝水', goal: { type: 'count', target: 8, unit: '杯' } });
    for (const date of ['2026-02-30', '2026-13-01', '20261014', 'today', '2026-10-1']) {
      const res = await api(alice, 'PUT', `/api/habits/${water.id}/checkins/${date}`, { count: 1 });
      expect(res.statusCode, date).toBe(400);
      expect((await api(alice, 'DELETE', `/api/habits/${water.id}/checkins/${date}`)).statusCode, date).toBe(400);
    }
    for (const count of [0, -1, 1.5, 'x']) {
      const res = await api(alice, 'PUT', `/api/habits/${water.id}/checkins/2026-10-14`, { count });
      expect(res.statusCode, String(count)).toBe(400);
    }
    expect((await api(alice, 'PUT', `/api/habits/${water.id}/checkins/2026-10-15`, { count: 1 })).statusCode).toBe(400);
    // Malformed habit id is a 404, not a 500.
    expect((await api(alice, 'PUT', '/api/habits/not-a-uuid/checkins/2026-10-14', { count: 1 })).statusCode).toBe(404);
  });

  it('requires a session and hides other users’ habits on every endpoint', async () => {
    const run = await create(alice, { name: '跑步' });
    expect((await api(null, 'GET', '/api/habits')).statusCode).toBe(401);
    expect((await api(null, 'POST', '/api/habits', { name: 'x' })).statusCode).toBe(401);
    expect((await api(null, 'PUT', `/api/habits/${run.id}/checkins/2026-10-14`, { count: 1 })).statusCode).toBe(401);
    expect((await api(bob, 'GET', `/api/habits/${run.id}`)).statusCode).toBe(404);
    expect((await api(bob, 'PATCH', `/api/habits/${run.id}`, { name: 'hacked' })).statusCode).toBe(404);
    expect((await api(bob, 'PUT', `/api/habits/${run.id}/checkins/2026-10-14`, { count: 1 })).statusCode).toBe(404);
    expect((await api(bob, 'DELETE', `/api/habits/${run.id}/checkins/2026-10-14`)).statusCode).toBe(404);
    expect((await api(bob, 'DELETE', `/api/habits/${run.id}`)).statusCode).toBe(404);
    // Bob cannot take over Alice's habit id either.
    expect((await api(bob, 'POST', '/api/habits', { id: run.id, name: 'mine' })).statusCode).toBe(409);
    const after = habitSchema.parse((await api(alice, 'GET', `/api/habits/${run.id}`)).json());
    expect(after).toMatchObject({ name: '跑步', checkins: [] });
  });

  it('refuses another user’s 通知渠道 as reminderChannelIds', async () => {
    const channel = await api(alice, 'POST', '/api/notification-channels', {
      type: 'feishu',
      name: 'alice',
      isDefault: true,
      config: { webhookUrl: 'http://127.0.0.1:9/hook' },
    });
    expect(channel.statusCode, channel.body).toBe(201);
    const channelId = (channel.json() as { id: string }).id;
    expect((await api(bob, 'POST', '/api/habits', { name: 'x', reminders: ['09:00'], reminderChannelIds: [channelId] })).statusCode).toBe(400);
    const own = await create(bob, { name: 'y' });
    expect((await api(bob, 'PATCH', `/api/habits/${own.id}`, { reminderChannelIds: [channelId] })).statusCode).toBe(400);
  });

  it('concurrent 打卡 of the same day leaves one 打卡 and no server error', async () => {
    const habit = await create(alice, { name: '冥想' });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => api(alice, 'PUT', `/api/habits/${habit.id}/checkins/2026-10-14`, { count: 1 })),
    );
    for (const res of results) expect([200, 409], res.body).toContain(res.statusCode);
    const after = habitSchema.parse((await api(alice, 'GET', `/api/habits/${habit.id}`)).json());
    expect(after.checkins.filter((c) => c.date === '2026-10-14')).toHaveLength(1);
    // Repeating the same 打卡 afterwards is idempotent.
    expect((await api(alice, 'PUT', `/api/habits/${habit.id}/checkins/2026-10-14`, { count: 1 })).statusCode).toBe(200);
    // 撤销 twice is idempotent too.
    expect((await api(alice, 'DELETE', `/api/habits/${habit.id}/checkins/2026-10-14`)).statusCode).toBe(200);
    expect((await api(alice, 'DELETE', `/api/habits/${habit.id}/checkins/2026-10-14`)).statusCode).toBe(200);
  });
});
