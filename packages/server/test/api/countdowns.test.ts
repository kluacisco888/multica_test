import { countdownSchema, countdownsResponseSchema, reminderFailuresResponseSchema, type Countdown } from '@dida/shared';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { reminderDeliveries } from '../../src/db/schema/reminders.js';
import { decodeMail, startFakeSmtp, type FakeSmtpServer } from '../fakes/fake-smtp.js';
import { startFakeWebhook, type FakeWebhookServer } from '../fakes/fake-webhook.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/*
 * 倒数日 (spec 用户故事 99–101): the API, per-user isolation, and reminders
 * sent on time to a fake 飞书 Webhook and a fake SMTP server. The clock is
 * injected; `tick()` is what pg-boss runs.
 */

// 2026-10-14 08:00 in Asia/Shanghai.
const START = '2026-10-14T00:00:00.000Z';

describe('countdowns', () => {
  const clock = fixedClock(START);
  let t: TestApp;
  let hook: FakeWebhookServer;
  let smtp: FakeSmtpServer;
  let n = 0;

  interface Account extends TestUser {
    feishuId: string;
    hooks(): string[];
    mails(): { subject: string | undefined; text: string }[];
  }

  beforeAll(async () => {
    hook = await startFakeWebhook();
    smtp = await startFakeSmtp();
    t = await createTestApp({ clock });
  });
  afterAll(async () => {
    await t.close();
    await hook.close();
    await smtp.close();
  });

  function api(user: TestUser, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) {
    return t.app.inject({ method, url, headers: user.headers, ...(payload ? { payload } : {}) });
  }

  /** A fresh user with default 飞书 and 邮件 channels; the clock back at START, nothing else scheduled. */
  async function account(): Promise<Account> {
    clock.set(START);
    await t.database.db
      .update(reminderDeliveries)
      .set({ status: 'cancelled', nextAttemptAt: null })
      .where(inArray(reminderDeliveries.status, ['scheduled', 'delivering']));
    n += 1;
    const name = `cd${n}`;
    const user = await t.createUser(name);
    const feishu = await api(user, 'POST', '/api/notification-channels', {
      type: 'feishu',
      name: '飞书',
      isDefault: true,
      config: { webhookUrl: `${hook.url}/hook/${name}` },
    });
    expect(feishu.statusCode, feishu.body).toBe(201);
    const email = await api(user, 'POST', '/api/notification-channels', {
      type: 'email',
      name: 'QQ 邮箱',
      isDefault: true,
      config: { host: smtp.host, port: smtp.port, security: 'none', username: `${name}@qq.com`, password: 'code', to: `${name}@qq.com` },
    });
    expect(email.statusCode, email.body).toBe(201);
    return {
      ...user,
      feishuId: feishu.json().id,
      hooks: () =>
        hook.requests
          .filter((r) => r.path === `/hook/${name}` && r.status === 200)
          .map((r) => (r.json as { content: { text: string } }).content.text),
      mails: () => smtp.messages.filter((m) => m.to.includes(`${name}@qq.com`)).map((m) => decodeMail(m.raw)),
    };
  }

  async function create(user: TestUser, payload: object): Promise<Countdown> {
    const res = await api(user, 'POST', '/api/countdowns', payload);
    expect(res.statusCode, res.body).toBe(201);
    return countdownSchema.parse(res.json());
  }

  async function list(user: TestUser, query = ''): Promise<Countdown[]> {
    const res = await api(user, 'GET', `/api/countdowns${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return countdownsResponseSchema.parse(res.json()).countdowns;
  }

  async function tickAt(iso: string) {
    clock.set(iso);
    return t.app.reminders.tick();
  }

  async function scheduled(countdownId: string) {
    return t.database.db
      .select({ fireAt: reminderDeliveries.fireAt, key: reminderDeliveries.reminderKey })
      .from(reminderDeliveries)
      .where(and(eq(reminderDeliveries.countdownId, countdownId), eq(reminderDeliveries.status, 'scheduled')));
  }

  describe('API', () => {
    it('creates 倒数日 and 纪念日 and shows how many days are left or have passed', async () => {
      const u = await account();
      await create(u, { name: '周末', date: '2026-10-17' });
      await create(u, { name: '春节', icon: '🧧', date: '2026-02-17', calendar: 'lunar', repeat: 'yearly' });
      await create(u, { name: '使用滴答清单', date: '2014-12-08' });
      const all = await list(u);
      expect(all.map((c) => [c.name, c.next])).toEqual([
        ['周末', { date: '2026-10-17', days: 3, status: 'upcoming' }],
        ['春节', { date: '2027-02-06', days: 115, status: 'upcoming' }],
        ['使用滴答清单', { date: '2014-12-08', days: 4328, status: 'passed' }],
      ]);
      expect(all[1]).toMatchObject({ icon: '🧧', calendar: 'lunar', lunar: { monthName: '正月', dayName: '初一' } });
      expect(all[0]).toMatchObject({ icon: '⏳', calendar: 'solar', repeat: 'none', lunar: null, pinned: false, archivedAt: null });
    });

    it('counts in the user’s time zone', async () => {
      const u = await account();
      await create(u, { name: '周末', date: '2026-10-17' });
      // 2026-10-14 08:00 in Shanghai is still 2026-10-13 in New York.
      expect((await api(u, 'PATCH', '/api/settings', { timeZone: 'America/New_York' })).statusCode).toBe(200);
      expect((await list(u))[0]?.next.days).toBe(4);
    });

    it('edits, pins (置顶 first), archives and deletes', async () => {
      const u = await account();
      const a = await create(u, { name: 'A', date: '2026-11-01' });
      const b = await create(u, { name: 'B', date: '2026-12-01' });
      const pinned = await api(u, 'PATCH', `/api/countdowns/${b.id}`, { pinned: true, name: 'B2' });
      expect(pinned.statusCode, pinned.body).toBe(200);
      expect(pinned.json().revision).toBeGreaterThan(b.revision);
      expect((await list(u)).map((c) => c.name)).toEqual(['B2', 'A']);

      const archived = await api(u, 'PATCH', `/api/countdowns/${a.id}`, { archived: true });
      expect(archived.json().archivedAt).toBe(START);
      expect((await list(u)).map((c) => c.name)).toEqual(['B2']);
      expect((await list(u, '?archived=true')).map((c) => c.name)).toEqual(['A']);
      await api(u, 'PATCH', `/api/countdowns/${a.id}`, { archived: false });
      expect((await list(u)).map((c) => c.name)).toEqual(['B2', 'A']);

      expect((await api(u, 'DELETE', `/api/countdowns/${a.id}`)).statusCode).toBe(204);
      expect((await api(u, 'GET', `/api/countdowns/${a.id}`)).statusCode).toBe(404);
      expect((await list(u)).map((c) => c.name)).toEqual(['B2']);
    });

    it('keeps tombstones and revisions for sync (ADR-0004)', async () => {
      const u = await account();
      const before = (await api(u, 'GET', '/api/changes?since=0')).json().revision as number;
      const c = await create(u, { id: '0b9f6a52-8d3e-4c55-9a41-3f0b2a1c7d10', name: 'X', date: '2026-11-01' });
      expect(c.id).toBe('0b9f6a52-8d3e-4c55-9a41-3f0b2a1c7d10');
      await api(u, 'DELETE', `/api/countdowns/${c.id}`);
      const changes = (await api(u, 'GET', `/api/changes?since=${before}`)).json();
      expect(changes.entities.countdown.tombstones).toEqual([expect.objectContaining({ id: c.id })]);
      // The same client id again is a conflict, not a second record.
      expect((await api(u, 'POST', '/api/countdowns', { id: c.id, name: 'Y', date: '2026-11-01' })).statusCode).toBe(409);
    });

    it('rejects bad input', async () => {
      const u = await account();
      const bad = [
        { name: '', date: '2026-11-01' },
        { name: 'x', date: '2026-02-30' },
        { name: 'x', date: '2026-11-01', calendar: 'hebrew' },
        { name: 'x', date: '2026-11-01', repeat: 'monthly' },
        { name: 'x', date: '2026-11-01', reminders: [{ type: 'before', minutes: 5 }] },
        { name: 'x', date: '2026-11-01', extra: 1 },
      ];
      for (const payload of bad) expect((await api(u, 'POST', '/api/countdowns', payload)).statusCode, JSON.stringify(payload)).toBe(400);
      const res = await api(u, 'POST', '/api/countdowns', { name: 'x', date: '2026-11-01', reminderChannelIds: ['6a1f0f2e-1d8b-4b6e-9a5c-0d1e2f3a4b5c'] });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('invalid_channels');
    });

    it('isolates users: others’ 倒数日 are invisible and untouchable', async () => {
      const owner = await account();
      const other = await account();
      const c = await create(owner, { name: '私密', date: '2026-11-01' });
      expect(await list(other)).toEqual([]);
      for (const [method, payload] of [['GET'], ['PATCH', { name: 'hacked' }], ['DELETE']] as const) {
        expect((await api(other, method, `/api/countdowns/${c.id}`, payload)).statusCode, method).toBe(404);
      }
      // Another user's channel cannot be used either.
      const res = await api(other, 'PATCH', `/api/countdowns/${c.id}`, { reminderChannelIds: [owner.feishuId] });
      expect(res.statusCode).toBe(404);
      const own = await create(other, { name: 'mine', date: '2026-11-01' });
      expect((await api(other, 'PATCH', `/api/countdowns/${own.id}`, { reminderChannelIds: [owner.feishuId] })).json().error.code).toBe('invalid_channels');
      expect((await list(owner))[0]?.name).toBe('私密');
    });

    it('requires a session', async () => {
      expect((await t.app.inject({ method: 'GET', url: '/api/countdowns' })).statusCode).toBe(401);
      expect((await t.app.inject({ method: 'POST', url: '/api/countdowns', payload: { name: 'x', date: '2026-11-01' } })).statusCode).toBe(401);
    });
  });

  describe('reminders', () => {
    it('sends a reminder on time to every default channel, then schedules next year’s', async () => {
      const u = await account();
      const c = await create(u, {
        name: '春节',
        date: '2026-02-17',
        calendar: 'lunar',
        repeat: 'yearly',
        reminders: [{ type: 'day', daysBefore: 1, time: '20:00' }],
      });
      // 农历 正月初一 2027 is 2027-02-06: the day before at 20:00 Shanghai = 12:00 UTC.
      expect(await scheduled(c.id)).toEqual([{ fireAt: new Date('2027-02-05T12:00:00Z'), key: 'day:1@20:00' }]);

      expect(await tickAt('2027-02-05T11:59:59Z')).toMatchObject({ fired: 0, sent: 0 });
      expect(u.hooks()).toEqual([]);

      expect(await tickAt('2027-02-05T12:00:00Z')).toMatchObject({ fired: 1, sent: 2, failed: 0 });
      expect(u.hooks()).toEqual(['倒数日：春节\n还有 1 天：正月初一（2027年2月6日）\n来自勾勾清单']);
      expect(u.mails()).toEqual([expect.objectContaining({ subject: '倒数日：春节' })]);
      expect(u.mails()[0]?.text).toContain('还有 1 天：正月初一（2027年2月6日）');

      // Next 春节 is 2028-01-26.
      expect(await scheduled(c.id)).toEqual([{ fireAt: new Date('2028-01-25T12:00:00Z'), key: 'day:1@20:00' }]);
      // A second tick sends nothing more.
      expect(await tickAt('2027-02-05T12:05:00Z')).toMatchObject({ fired: 0, sent: 0 });
      expect(u.hooks()).toHaveLength(1);
    });

    it('uses the 全天提醒时间 setting when the reminder has no time, and follows changes to it', async () => {
      const u = await account();
      const c = await create(u, { name: '周末', date: '2026-10-17', reminders: [{ type: 'day', daysBefore: 0, time: null }] });
      expect(await scheduled(c.id)).toEqual([{ fireAt: new Date('2026-10-17T01:00:00Z'), key: 'day:0@default' }]);
      await api(u, 'PATCH', '/api/settings', { allDayReminderTime: '07:30' });
      expect(await scheduled(c.id)).toEqual([{ fireAt: new Date('2026-10-16T23:30:00Z'), key: 'day:0@default' }]);
      await tickAt('2026-10-16T23:30:00Z');
      expect(u.hooks()).toEqual(['倒数日：周末\n就是今天：2026年10月17日\n来自勾勾清单']);
      // One-off: nothing left to schedule.
      expect(await scheduled(c.id)).toEqual([]);
    });

    it('sends only to the chosen channels', async () => {
      const u = await account();
      await create(u, { name: 'X', date: '2026-10-20', reminders: [{ type: 'day', daysBefore: 1, time: '09:00' }], reminderChannelIds: [u.feishuId] });
      await tickAt('2026-10-19T01:00:00Z');
      expect(u.hooks()).toHaveLength(1);
      expect(u.mails()).toHaveLength(0);
    });

    it('reschedules on edit and cancels on 归档 and delete', async () => {
      const u = await account();
      const c = await create(u, { name: 'X', date: '2026-10-20', reminders: [{ type: 'day', daysBefore: 1, time: '09:00' }] });
      await api(u, 'PATCH', `/api/countdowns/${c.id}`, { date: '2026-10-25' });
      expect(await scheduled(c.id)).toEqual([{ fireAt: new Date('2026-10-24T01:00:00Z'), key: 'day:1@09:00' }]);
      await api(u, 'PATCH', `/api/countdowns/${c.id}`, { archived: true });
      expect(await scheduled(c.id)).toEqual([]);
      await api(u, 'PATCH', `/api/countdowns/${c.id}`, { archived: false });
      expect(await scheduled(c.id)).toHaveLength(1);
      await api(u, 'DELETE', `/api/countdowns/${c.id}`);
      expect(await scheduled(c.id)).toEqual([]);
      expect(await tickAt('2026-10-24T01:00:00Z')).toMatchObject({ fired: 0 });
      expect(u.hooks()).toEqual([]);
    });

    it('does not send a reminder whose 倒数日 was deleted after it was scheduled', async () => {
      const u = await account();
      const c = await create(u, { name: 'X', date: '2026-10-20', reminders: [{ type: 'day', daysBefore: 1, time: '09:00' }] });
      // Delete behind the API's back (no hook): the tick re-checks the 倒数日 itself.
      const { countdowns } = await import('../../src/db/schema/countdowns.js');
      await t.database.db.update(countdowns).set({ deletedAt: new Date(START) }).where(eq(countdowns.id, c.id));
      expect(await tickAt('2026-10-19T01:00:00Z')).toMatchObject({ fired: 0, cancelled: 1 });
      expect(u.hooks()).toEqual([]);
    });

    it('retries a failing channel and lists the final failure under the 倒数日 name', async () => {
      const u = await account();
      await create(u, { name: '纪念日', date: '2026-10-20', reminders: [{ type: 'day', daysBefore: 0, time: '09:00' }], reminderChannelIds: [u.feishuId] });
      hook.replyNext({ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 });
      await tickAt('2026-10-20T01:00:00Z');
      await tickAt('2026-10-20T01:01:00Z');
      await tickAt('2026-10-20T01:06:00Z');
      await tickAt('2026-10-20T01:21:00Z');
      const failures = reminderFailuresResponseSchema.parse((await api(u, 'GET', '/api/reminders/failures')).json()).failures;
      expect(failures).toEqual([expect.objectContaining({ taskId: null, taskTitle: '纪念日', attempts: 4, channelId: u.feishuId })]);
      expect(failures[0]?.countdownId).toBeTruthy();
    });

    it('does not show 倒数日 reminders as task alerts', async () => {
      const u = await account();
      await create(u, { name: 'X', date: '2026-10-20', reminders: [{ type: 'day', daysBefore: 0, time: '09:00' }] });
      await tickAt('2026-10-20T01:00:00Z');
      const fired = await t.database.db.select().from(reminderDeliveries).where(and(eq(reminderDeliveries.userId, u.id), isNotNull(reminderDeliveries.firedAt)));
      expect(fired).toHaveLength(1);
      expect((await api(u, 'GET', '/api/reminders/alerts')).json().alerts).toEqual([]);
    });
  });
});
