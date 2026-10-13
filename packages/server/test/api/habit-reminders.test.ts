import { habitSchema, type Habit } from '@dida/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { startFakeWebhook, type FakeWebhookServer } from '../fakes/fake-webhook.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/*
 * 习惯提醒 (spec 用户故事 95): sent at the reminder time of each day the habit
 * is due and not yet done, through the existing 通知渠道 (the shared
 * notifier, EURO-10). The clock is injected; `tick()` is what the pg-boss
 * reminder job runs; messages go to a fake 飞书 Webhook.
 */

const MIN = 60_000;
// 周三 2026-10-14 08:00 in Asia/Shanghai.
const START = '2026-10-14T00:00:00.000Z';
// 09:00 / 21:00 Shanghai on 10-14.
const NINE = '2026-10-14T01:00:00.000Z';
const NINE_PM = '2026-10-14T13:00:00.000Z';

describe('habit reminders', () => {
  const clock = fixedClock(START);
  let t: TestApp;
  let hook: FakeWebhookServer;
  let n = 0;

  interface Account extends TestUser {
    channelId: string;
    otherChannelId: string;
    texts(): string[];
    otherTexts(): string[];
  }

  beforeAll(async () => {
    hook = await startFakeWebhook();
    t = await createTestApp({ clock });
  });
  afterAll(async () => {
    await t.close();
    await hook.close();
  });

  function api(user: TestUser, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) {
    return t.app.inject({ method, url, headers: user.headers, ...(payload ? { payload } : {}) });
  }

  async function channel(user: TestUser, path: string, isDefault: boolean): Promise<string> {
    const res = await api(user, 'POST', '/api/notification-channels', { type: 'feishu', name: path, isDefault, config: { webhookUrl: `${hook.url}/${path}` } });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id;
  }

  /** A fresh user with a default 飞书 channel and a non-default one; the clock back at START. */
  async function account(): Promise<Account> {
    clock.set(START);
    // Older tests' habits must not send in this test's ticks: run them out first.
    await t.app.habitReminders.tick();
    n += 1;
    const user = await t.createUser(`habit${n}`);
    const texts = (path: string) => () =>
      hook.requests.filter((r) => r.path === `/${path}` && r.status === 200).map((r) => (r.json as { content: { text: string } }).content.text);
    return {
      ...user,
      channelId: await channel(user, `h${n}`, true),
      otherChannelId: await channel(user, `h${n}-other`, false),
      texts: texts(`h${n}`),
      otherTexts: texts(`h${n}-other`),
    };
  }

  async function create(user: TestUser, payload: object): Promise<Habit> {
    const res = await api(user, 'POST', '/api/habits', payload);
    expect(res.statusCode, res.body).toBe(201);
    return habitSchema.parse(res.json());
  }

  async function tickAt(iso: string | number) {
    clock.set(new Date(iso));
    return t.app.habitReminders.tick();
  }

  it('sends each reminder time once, at that time, to the default channels', async () => {
    const u = await account();
    await create(u, { name: '喝水', goal: { type: 'count', target: 8, unit: '杯' }, reminders: ['09:00', '21:00'] });

    await tickAt(Date.parse(NINE) - 1000);
    expect(u.texts()).toEqual([]);
    expect(await tickAt(NINE)).toMatchObject({ fired: 1, sent: 1 });
    expect(u.texts()).toEqual(['习惯打卡：喝水\n每天，每天 8 杯\n来自勾勾清单']);
    expect(u.otherTexts()).toEqual([]);
    // Not again at the same time, nor a minute later.
    await tickAt(NINE);
    await tickAt(Date.parse(NINE) + MIN);
    expect(u.texts()).toHaveLength(1);
    await tickAt(NINE_PM);
    expect(u.texts()).toHaveLength(2);
    // Next day, again.
    await tickAt('2026-10-15T01:00:00.000Z');
    expect(u.texts()).toHaveLength(3);
  });

  it('a day already done gets no reminder; a partial 数量型 day still does', async () => {
    const u = await account();
    const once = await create(u, { name: '早起', reminders: ['09:00'] });
    const water = await create(u, { name: '喝水', goal: { type: 'count', target: 8, unit: '杯' }, reminders: ['09:00'] });
    await api(u, 'PUT', `/api/habits/${once.id}/checkins/2026-10-14`, { count: 1 });
    await api(u, 'PUT', `/api/habits/${water.id}/checkins/2026-10-14`, { count: 3 });
    await tickAt(NINE);
    expect(u.texts()).toEqual(['习惯打卡：喝水\n每天，每天 8 杯\n来自勾勾清单']);
  });

  it('固定几天 reminds only on those weekdays; 每周 N 次 stops once the week has N', async () => {
    const u = await account();
    // 10-14 is 周三.
    await create(u, { name: '周末跑步', frequency: { type: 'weekdays', days: [0, 6] }, reminders: ['09:00'] });
    await tickAt(NINE);
    expect(u.texts()).toEqual([]);
    await tickAt('2026-10-17T01:00:00.000Z'); // 周六 09:00
    expect(u.texts()).toEqual(['习惯打卡：周末跑步\n每周六、日，当天完成打卡\n来自勾勾清单']);

    const u2 = await account();
    const w2 = await create(u2, { name: '读书', frequency: { type: 'weekly', times: 2 }, reminders: ['21:00'] });
    await api(u2, 'PUT', `/api/habits/${w2.id}/checkins/2026-10-12`, { count: 1 });
    await api(u2, 'PUT', `/api/habits/${w2.id}/checkins/2026-10-13`, { count: 1 }); // 补打卡: the week has 2
    await tickAt(NINE_PM);
    expect(u2.texts()).toEqual([]);
    // A week short of N is reminded.
    await api(u2, 'DELETE', `/api/habits/${w2.id}/checkins/2026-10-13`);
    // …and a reminder skipped because the week was done fires late once it no longer is.
    await tickAt(Date.parse(NINE_PM) + MIN);
    expect(u2.texts()).toEqual(['习惯打卡：读书\n每周 2 天，当天完成打卡\n来自勾勾清单']);
  });

  it('uses the habit’s own channels when set', async () => {
    const u = await account();
    await create(u, { name: '冥想', reminders: ['09:00'], reminderChannelIds: [u.otherChannelId] });
    await tickAt(NINE);
    expect(u.texts()).toEqual([]);
    expect(u.otherTexts()).toEqual(['习惯打卡：冥想\n每天，当天完成打卡\n来自勾勾清单']);
  });

  it('archived and deleted habits are not reminded', async () => {
    const u = await account();
    const a = await create(u, { name: '归档的', reminders: ['09:00'] });
    const d = await create(u, { name: '删掉的', reminders: ['09:00'] });
    await api(u, 'PATCH', `/api/habits/${a.id}`, { archived: true });
    await api(u, 'DELETE', `/api/habits/${d.id}`);
    expect(await tickAt(NINE)).toMatchObject({ fired: 0 });
    expect(u.texts()).toEqual([]);
  });

  it('a reminder time already past when set does not fire for that day', async () => {
    const u = await account();
    clock.set('2026-10-14T02:00:00.000Z'); // 10:00
    await create(u, { name: '晚到', reminders: ['09:00'] });
    await tickAt('2026-10-14T02:01:00.000Z');
    expect(u.texts()).toEqual([]);
    await tickAt('2026-10-15T01:00:00.000Z');
    expect(u.texts()).toHaveLength(1);
  });

  it('catches up after a downtime of less than 24 hours, not more', async () => {
    const u = await account();
    await create(u, { name: '停机', reminders: ['09:00'] });
    // Server down from 08:59 until 15:00: sent late, once.
    await tickAt('2026-10-14T07:00:00.000Z');
    expect(u.texts()).toHaveLength(1);
    // Down from then until 10-16 12:00: 10-15 09:00 is 27 hours old, 10-16 09:00 is 3 hours old.
    await tickAt('2026-10-16T04:00:00.000Z');
    expect(u.texts()).toHaveLength(2);
  });

  it('retries a failed send 1, 5 and 15 minutes later', async () => {
    const u = await account();
    await create(u, { name: '重试', reminders: ['09:00'] });
    hook.replyNext({ status: 500 }, { status: 500 });
    expect(await tickAt(NINE)).toMatchObject({ fired: 1, sent: 0, retrying: 1 });
    expect(await tickAt(Date.parse(NINE) + 30_000)).toMatchObject({ sent: 0, retrying: 0 });
    expect(await tickAt(Date.parse(NINE) + MIN)).toMatchObject({ retrying: 1 });
    expect(await tickAt(Date.parse(NINE) + 6 * MIN)).toMatchObject({ sent: 1 });
    expect(u.texts()).toHaveLength(1);
  });
});
