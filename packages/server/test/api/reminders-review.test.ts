import { reminderAlertsResponseSchema, taskSchema, type Task } from '@dida/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { fixedClock } from '../../src/clock.js';
import { reminderDeliveries } from '../../src/db/schema/reminders.js';
import { startFakeWebhook, type FakeWebhookServer } from '../fakes/fake-webhook.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/*
 * EURO-17 review: edge cases of 应用内提醒 / 稍后提醒 and reminder input
 * (duplicate submissions, bad input, no session, a channel deleted after the
 * reminder was set, the declared 稍后提醒 trade-off).
 */

const START = '2026-10-14T00:00:00.000Z';
const DUE = '2026-10-14T02:00:00.000Z';

describe('reminders: review edge cases', () => {
  const clock = fixedClock(START);
  let t: TestApp;
  let hook: FakeWebhookServer;
  let n = 0;

  beforeAll(async () => {
    hook = await startFakeWebhook();
    t = await createTestApp({ clock });
  });
  afterAll(async () => {
    await t.close();
    await hook.close();
  });

  function api(user: TestUser | null, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) {
    return t.app.inject({ method, url, headers: user?.headers ?? {}, ...(payload ? { payload } : {}) });
  }

  async function account() {
    clock.set(START);
    await t.database.db
      .update(reminderDeliveries)
      .set({ status: 'cancelled', nextAttemptAt: null })
      .where(inArray(reminderDeliveries.status, ['scheduled', 'delivering']));
    n += 1;
    const name = `rv${n}`;
    const user = await t.createUser(name);
    const res = await api(user, 'POST', '/api/notification-channels', {
      type: 'feishu',
      name: '飞书',
      isDefault: true,
      config: { webhookUrl: `${hook.url}/hook/${name}` },
    });
    expect(res.statusCode, res.body).toBe(201);
    return {
      ...user,
      channelId: res.json().id as string,
      hooks: () => hook.requests.filter((r) => r.path === `/hook/${name}` && r.status === 200),
      sends: () => hook.requests.filter((r) => r.path === `/hook/${name}`),
    };
  }

  async function createTask(user: TestUser, payload: object): Promise<Task> {
    const res = await api(user, 'POST', '/api/tasks', payload);
    expect(res.statusCode, res.body).toBe(201);
    return taskSchema.parse(res.json());
  }

  async function alerts(u: TestUser) {
    return reminderAlertsResponseSchema.parse((await api(u, 'GET', '/api/reminders/alerts')).json()).alerts;
  }

  const timed = (dueAt: string) => ({ allDay: false, startAt: null, dueAt });

  async function firedAlert(u: Awaited<ReturnType<typeof account>>, title: string) {
    await createTask(u, { title, dates: timed(DUE), reminders: [{ type: 'before', minutes: 0 }] });
    clock.set(DUE);
    await t.app.reminders.tick();
    const [alert] = await alerts(u);
    expect(alert).toBeDefined();
    return alert!;
  }

  it('the reminder routes need a session', async () => {
    expect((await api(null, 'GET', '/api/reminders/alerts')).statusCode).toBe(401);
    expect((await api(null, 'GET', '/api/reminders/failures')).statusCode).toBe(401);
    expect((await api(null, 'POST', '/api/reminders/alerts/00000000-0000-4000-8000-000000000000/snooze', { minutes: 5 })).statusCode).toBe(401);
  });

  it('稍后提醒 rejects bad input and other users', async () => {
    const u = await account();
    const other = await account();
    const alert = await firedAlert(u, '坏输入');
    for (const body of [{}, { minutes: 1.5 }, { minutes: 10081 }, { minutes: -1 }, { minutes: '5' }]) {
      expect((await api(u, 'POST', `/api/reminders/alerts/${alert.id}/snooze`, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await api(u, 'POST', '/api/reminders/alerts/not-a-uuid/snooze', { minutes: 5 })).statusCode).toBe(404);
    expect((await api(u, 'POST', '/api/reminders/alerts/not-a-uuid/dismiss')).statusCode).toBe(404);
    expect((await api(other, 'POST', `/api/reminders/alerts/${alert.id}/snooze`, { minutes: 5 })).statusCode).toBe(404);
  });

  it('稍后提醒 sent twice for the same alert reminds only once', async () => {
    const u = await account();
    const alert = await firedAlert(u, '点两次');
    // e.g. a second open tab still shows the card until its next poll.
    const first = await api(u, 'POST', `/api/reminders/alerts/${alert.id}/snooze`, { minutes: 5 });
    expect(first.statusCode).toBe(200);
    await api(u, 'POST', `/api/reminders/alerts/${alert.id}/snooze`, { minutes: 5 });
    clock.set('2026-10-14T02:05:00.000Z');
    await t.app.reminders.tick();
    expect(u.hooks()).toHaveLength(2); // the original + one 稍后提醒
    expect(await alerts(u)).toHaveLength(1);
  });

  it('concurrent 稍后提醒 for the same alert reminds only once', async () => {
    const u = await account();
    const alert = await firedAlert(u, '并发');
    await Promise.all([
      api(u, 'POST', `/api/reminders/alerts/${alert.id}/snooze`, { minutes: 5 }),
      api(u, 'POST', `/api/reminders/alerts/${alert.id}/snooze`, { minutes: 5 }),
      api(u, 'POST', `/api/reminders/alerts/${alert.id}/snooze`, { minutes: 15 }),
    ]);
    clock.set('2026-10-14T02:20:00.000Z');
    await t.app.reminders.tick();
    expect(u.hooks()).toHaveLength(2);
  });

  it('more than 10 reminders, or one over 60 days ahead, is refused', async () => {
    const u = await account();
    const many = Array.from({ length: 11 }, (_, i) => ({ type: 'before', minutes: i }));
    expect((await api(u, 'POST', '/api/tasks', { title: 'x', dates: timed(DUE), reminders: many })).statusCode).toBe(400);
    expect((await api(u, 'POST', '/api/tasks', { title: 'x', dates: timed(DUE), reminders: [{ type: 'before', minutes: 86401 }] })).statusCode).toBe(400);
    expect((await api(u, 'PATCH', '/api/settings', { allDayReminderTime: '25:99' })).statusCode).toBe(400);
    expect((await api(u, 'PATCH', '/api/settings', { allDayReminderTime: '' })).statusCode).toBe(400);
  });

  it('declared trade-off: a 稍后提醒 stays when the task date changes', async () => {
    const u = await account();
    const alert = await firedAlert(u, '改日期');
    expect((await api(u, 'POST', `/api/reminders/alerts/${alert.id}/snooze`, { minutes: 5 })).statusCode).toBe(200);
    const res = await api(u, 'PATCH', `/api/tasks/${alert.taskId}`, { dates: timed('2026-10-20T02:00:00.000Z') });
    expect(res.statusCode, res.body).toBe(200);
    clock.set('2026-10-14T02:05:00.000Z');
    await t.app.reminders.tick();
    expect(u.hooks()).toHaveLength(2);
  });

  it('a task whose only chosen channel was deleted still pops up in the page (no channel send, no failure record)', async () => {
    const u = await account();
    await createTask(u, { title: '渠道被删', dates: timed(DUE), reminders: [{ type: 'before', minutes: 0 }], reminderChannelIds: [u.channelId] });
    expect((await api(u, 'DELETE', `/api/notification-channels/${u.channelId}`)).statusCode).toBeLessThan(300);
    clock.set(DUE);
    expect(await t.app.reminders.tick()).toMatchObject({ fired: 1, sent: 0, failed: 0 });
    expect(u.sends()).toHaveLength(0);
    expect((await api(u, 'GET', '/api/reminders/failures')).json().failures).toEqual([]);
    expect(await alerts(u)).toHaveLength(1);
  });
});
