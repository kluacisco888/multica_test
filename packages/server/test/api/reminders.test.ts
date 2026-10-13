import { reminderAlertsResponseSchema, reminderFailuresResponseSchema, taskSchema, type Task } from '@dida/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { fixedClock } from '../../src/clock.js';
import { reminderDeliveries } from '../../src/db/schema/reminders.js';
import { REMINDER_TICK_CRON, REMINDER_TICK_QUEUE, startBackgroundJobs } from '../../src/jobs.js';
import { decodeMail, startFakeSmtp, type FakeSmtpServer } from '../fakes/fake-smtp.js';
import { startFakeWebhook, type FakeWebhookServer } from '../fakes/fake-webhook.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/*
 * 提醒调度与投递 (spec 用户故事 78–84). The clock is injected and `tick()` is
 * what pg-boss runs; messages go to a fake 飞书 Webhook and a fake SMTP
 * server, never to the internet.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
// 2026-10-14 08:00 in Asia/Shanghai (a Wednesday).
const START = '2026-10-14T00:00:00.000Z';
const at = (iso: string) => new Date(iso);

describe('reminders: scheduling and delivery', () => {
  const clock = fixedClock(START);
  let t: TestApp;
  let hook: FakeWebhookServer;
  let smtp: FakeSmtpServer;
  let n = 0;

  interface Account extends TestUser {
    feishuId: string;
    emailId: string;
    /** Requests the fake Webhook received for this user. */
    hooks(): { text: string }[];
    /** Mails the fake SMTP server accepted for this user. */
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

  /** A fresh user with a default 飞书 channel and a default 邮件 channel; the clock back at START. */
  async function account(options: { channels?: boolean } = {}): Promise<Account> {
    clock.set(START);
    // Each test starts with nothing scheduled, so tick counts are its own.
    await t.database.db
      .update(reminderDeliveries)
      .set({ status: 'cancelled', nextAttemptAt: null })
      .where(inArray(reminderDeliveries.status, ['scheduled', 'delivering']));
    n += 1;
    const name = `user${n}`;
    const user = await t.createUser(name);
    let feishuId = '';
    let emailId = '';
    if (options.channels !== false) {
      const feishu = await api(user, 'POST', '/api/notification-channels', {
        type: 'feishu',
        name: '飞书',
        isDefault: true,
        config: { webhookUrl: `${hook.url}/hook/${name}` },
      });
      expect(feishu.statusCode, feishu.body).toBe(201);
      feishuId = feishu.json().id;
      const email = await api(user, 'POST', '/api/notification-channels', {
        type: 'email',
        name: 'QQ 邮箱',
        isDefault: true,
        config: { host: smtp.host, port: smtp.port, security: 'none', username: `${name}@qq.com`, password: 'code', to: `${name}@qq.com` },
      });
      expect(email.statusCode, email.body).toBe(201);
      emailId = email.json().id;
    }
    return {
      ...user,
      feishuId,
      emailId,
      hooks: () =>
        hook.requests
          .filter((r) => r.path === `/hook/${name}` && r.status === 200)
          .map((r) => ({ text: (r.json as { content: { text: string } }).content.text })),
      mails: () => smtp.messages.filter((m) => m.to.includes(`${name}@qq.com`)).map((m) => decodeMail(m.raw)),
    };
  }

  async function createTask(user: TestUser, payload: object): Promise<Task> {
    const res = await api(user, 'POST', '/api/tasks', payload);
    expect(res.statusCode, res.body).toBe(201);
    return taskSchema.parse(res.json());
  }

  async function patchTask(user: TestUser, id: string, patch: object): Promise<Task> {
    const res = await api(user, 'PATCH', `/api/tasks/${id}`, patch);
    expect(res.statusCode, res.body).toBe(200);
    return taskSchema.parse(res.json());
  }

  /** Move the clock and run the delivery job once. */
  async function tickAt(iso: string | Date) {
    clock.set(iso);
    return t.app.reminders.tick();
  }

  const timed = (dueAt: string, startAt: string | null = null) => ({ allDay: false, startAt, dueAt });

  describe('on-time delivery', () => {
    it('sends each reminder of a timed task at its instant, to every default channel', async () => {
      const u = await account();
      await createTask(u, {
        title: '开会',
        dates: timed('2026-10-14T02:00:00.000Z'), // 10:00
        reminders: [{ type: 'before', minutes: 0 }, { type: 'before', minutes: 30 }],
      });

      await tickAt(new Date(at('2026-10-14T01:30:00.000Z').getTime() - 1000));
      expect(u.hooks()).toEqual([]);
      expect(u.mails()).toEqual([]);

      expect(await tickAt('2026-10-14T01:30:00.000Z')).toMatchObject({ fired: 1, sent: 2 });
      expect(u.hooks()).toEqual([{ text: '提醒：开会\n时间：10:00\n来自勾勾清单' }]);
      expect(u.mails()).toEqual([{ subject: '提醒：开会', text: '时间：10:00\n来自勾勾清单' }]);

      // Running again at the same instant sends nothing twice.
      expect(await tickAt('2026-10-14T01:30:30.000Z')).toMatchObject({ fired: 0, sent: 0 });
      await tickAt('2026-10-14T02:00:00.000Z');
      expect(u.hooks()).toHaveLength(2);
      expect(u.mails()).toHaveLength(2);
    });

    it('reminds an all-day task at the 全天提醒时间 (09:00, changeable in 设置)', async () => {
      const u = await account();
      await createTask(u, {
        title: '交房租',
        dates: { allDay: true, dueDate: '2026-10-16' },
        reminders: [{ type: 'day', daysBefore: 0, time: null }, { type: 'day', daysBefore: 1, time: null }],
      });
      await tickAt('2026-10-15T00:59:00.000Z');
      expect(u.hooks()).toHaveLength(0);
      await tickAt('2026-10-15T01:00:00.000Z'); // 15th 09:00 北京: 提前 1 天
      expect(u.hooks()).toHaveLength(1);

      const settings = await api(u, 'PATCH', '/api/settings', { allDayReminderTime: '08:00' });
      expect(settings.statusCode, settings.body).toBe(200);
      expect(settings.json().allDayReminderTime).toBe('08:00');
      await tickAt('2026-10-16T00:00:00.000Z'); // 16th 08:00 北京: 当天, at the new time
      expect(u.hooks()).toHaveLength(2);
      await tickAt('2026-10-16T01:00:00.000Z'); // the old 09:00 slot was moved, not kept
      expect(u.hooks()).toHaveLength(2);
    });

    it('sends only to the channels chosen for the task', async () => {
      const u = await account();
      await createTask(u, { title: '只发邮件', dates: timed('2026-10-14T02:00:00.000Z'), reminders: [{ type: 'before', minutes: 0 }], reminderChannelIds: [u.emailId] });
      await tickAt('2026-10-14T02:00:00.000Z');
      expect(u.hooks()).toHaveLength(0);
      expect(u.mails()).toHaveLength(1);
    });

    it('a reminder with no channel at all still fires (for the 应用内提醒)', async () => {
      const u = await account({ channels: false });
      await createTask(u, { title: '只在页面里', dates: timed('2026-10-14T02:00:00.000Z'), reminders: [{ type: 'before', minutes: 0 }] });
      expect(await tickAt('2026-10-14T02:00:00.000Z')).toMatchObject({ fired: 1, sent: 0 });
      const alerts = reminderAlertsResponseSchema.parse((await api(u, 'GET', '/api/reminders/alerts')).json()).alerts;
      expect(alerts.map((a) => a.title)).toEqual(['只在页面里']);
    });
  });

  describe('retries and failure records', () => {
    it('retries 1, 5 and 15 minutes after a failure, then records the failure', async () => {
      const u = await account();
      await createTask(u, { title: '会失败', dates: timed('2026-10-14T02:00:00.000Z'), reminders: [{ type: 'before', minutes: 0 }], reminderChannelIds: [u.feishuId] });
      const fails = () => hook.requests.filter((r) => r.path.endsWith(u.username) && r.status === 500).length;
      hook.replyNext({ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 });

      const fire = at('2026-10-14T02:00:00.000Z').getTime();
      await tickAt(new Date(fire));
      expect(fails()).toBe(1);
      await tickAt(new Date(fire + MIN - 1000));
      expect(fails()).toBe(1);
      await tickAt(new Date(fire + MIN)); // 1st retry
      expect(fails()).toBe(2);
      await tickAt(new Date(fire + 6 * MIN - 1000));
      expect(fails()).toBe(2);
      await tickAt(new Date(fire + 6 * MIN)); // 2nd retry, 5 minutes later
      expect(fails()).toBe(3);
      await tickAt(new Date(fire + 21 * MIN - 1000));
      expect(fails()).toBe(3);
      const last = await tickAt(new Date(fire + 21 * MIN)); // 3rd retry, 15 minutes later
      expect(fails()).toBe(4);
      expect(last).toMatchObject({ failed: 1, retrying: 0 });
      await tickAt(new Date(fire + 3 * HOUR)); // no 4th retry
      expect(fails()).toBe(4);

      const failures = reminderFailuresResponseSchema.parse((await api(u, 'GET', '/api/reminders/failures')).json()).failures;
      expect(failures).toEqual([
        expect.objectContaining({
          taskTitle: '会失败',
          channelId: u.feishuId,
          channelName: '飞书',
          attempts: 4,
          fireAt: '2026-10-14T02:00:00.000Z',
          failedAt: new Date(fire + 21 * MIN).toISOString(),
          error: expect.stringContaining('HTTP 500'),
        }),
      ]);
      // Another user sees none of it.
      const other = await account({ channels: false });
      expect((await api(other, 'GET', '/api/reminders/failures')).json()).toEqual({ failures: [] });
    });

    it('a retry that succeeds is not a failure; other channels are not sent twice', async () => {
      const u = await account();
      await createTask(u, { title: '邮件重试', dates: timed('2026-10-14T02:00:00.000Z'), reminders: [{ type: 'before', minutes: 0 }] });
      smtp.failNext(451);
      const fire = at('2026-10-14T02:00:00.000Z').getTime();
      expect(await tickAt(new Date(fire))).toMatchObject({ sent: 1, retrying: 1 });
      expect(u.hooks()).toHaveLength(1);
      expect(u.mails()).toHaveLength(0);
      expect(await tickAt(new Date(fire + MIN))).toMatchObject({ sent: 1, retrying: 0, failed: 0 });
      expect(u.hooks()).toHaveLength(1);
      expect(u.mails()).toHaveLength(1);
      expect((await api(u, 'GET', '/api/reminders/failures')).json()).toEqual({ failures: [] });
    });

    it('a failure that needs the user to fix the channel is recorded at once', async () => {
      const u = await account();
      await createTask(u, { title: '签名错', dates: timed('2026-10-14T02:00:00.000Z'), reminders: [{ type: 'before', minutes: 0 }], reminderChannelIds: [u.feishuId] });
      hook.replyNext({ status: 200, body: { code: 19021, msg: 'sign match fail or timestamp is not within one hour from current time' } });
      expect(await tickAt('2026-10-14T02:00:00.000Z')).toMatchObject({ failed: 1, retrying: 0 });
      const failures = reminderFailuresResponseSchema.parse((await api(u, 'GET', '/api/reminders/failures')).json()).failures;
      expect(failures).toEqual([expect.objectContaining({ attempts: 1, error: expect.stringContaining('19021') })]);
    });
  });

  describe('catch-up after a downtime', () => {
    it('sends reminders due at most 24 hours ago and skips older ones', async () => {
      const u = await account();
      const restart = at('2026-10-16T02:00:00.000Z').getTime();
      const iso = (ms: number) => new Date(ms).toISOString();
      await createTask(u, { title: '24小时零1分钟前', dates: timed(iso(restart - 24 * HOUR - MIN)), reminders: [{ type: 'before', minutes: 0 }] });
      await createTask(u, { title: '正好24小时前', dates: timed(iso(restart - 24 * HOUR)), reminders: [{ type: 'before', minutes: 0 }] });
      await createTask(u, { title: '1小时前', dates: timed(iso(restart - HOUR)), reminders: [{ type: 'before', minutes: 0 }] });

      // The server was down from START until `restart`; this is the first tick after it.
      expect(await tickAt(new Date(restart))).toMatchObject({ fired: 2, missed: 1 });
      expect(u.hooks().map((h) => h.text.split('\n')[0])).toEqual(['提醒：正好24小时前', '提醒：1小时前']);
      expect(u.mails()).toHaveLength(2);
    });

    it('a retry is given up only when it came due more than 24 hours ago', async () => {
      const u = await account();
      await createTask(u, { title: '重试时停机', dates: timed('2026-10-14T02:00:00.000Z'), reminders: [{ type: 'before', minutes: 0 }], reminderChannelIds: [u.feishuId] });
      const sent = () => hook.requests.filter((r) => r.path.endsWith(u.username)).length;
      hook.replyNext({ status: 503 }, { status: 503 });
      await tickAt('2026-10-14T02:00:00.000Z'); // fails; retry due 02:01 on the 14th
      await tickAt('2026-10-15T02:01:00.000Z'); // down for exactly 24 hours: the retry still runs (and fails again)
      expect(sent()).toBe(2);
      await tickAt('2026-10-16T02:07:00.000Z'); // the next retry (due 02:06 on the 15th) is over 24 hours late
      expect(sent()).toBe(2);
      const failures = reminderFailuresResponseSchema.parse((await api(u, 'GET', '/api/reminders/failures')).json()).failures;
      expect(failures).toEqual([expect.objectContaining({ attempts: 2, error: '服务停机超过 24 小时，未能发送' })]);
    });

    it('the pg-boss jobs run a tick at startup and every minute', async () => {
      const u = await account();
      await createTask(u, { title: '停机期间', dates: timed('2026-10-14T02:00:00.000Z'), reminders: [{ type: 'before', minutes: 0 }] });
      clock.set('2026-10-14T05:00:00.000Z');
      const jobs = await startBackgroundJobs({
        databaseUrl: t.database.url,
        holidays: t.app.holidays,
        trash: t.app.trash,
        reminders: t.app.reminders,
        timezone: 'Asia/Shanghai',
        log: t.app.log,
      });
      try {
        const deadline = Date.now() + 20_000;
        while (u.hooks().length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
        expect(u.hooks().map((h) => h.text.split('\n')[0])).toEqual(['提醒：停机期间']);
        const schedules = await jobs.boss.getSchedules(REMINDER_TICK_QUEUE);
        expect(schedules.map((s) => s.cron)).toEqual([REMINDER_TICK_CRON]);
      } finally {
        await jobs.stop();
      }
    });
  });

  describe('kept in step with the task', () => {
    const due = '2026-10-14T02:00:00.000Z';
    const onTime = [{ type: 'before', minutes: 0 }];

    it('changing the time moves the reminder', async () => {
      const u = await account();
      const task = await createTask(u, { title: '改时间', dates: timed(due), reminders: onTime });
      await patchTask(u, task.id, { dates: timed('2026-10-14T03:00:00.000Z') });
      await tickAt(due);
      expect(u.hooks()).toHaveLength(0);
      await tickAt('2026-10-14T03:00:00.000Z');
      expect(u.hooks()).toHaveLength(1);
    });

    it('changing or clearing the reminders replaces the scheduled ones', async () => {
      const u = await account();
      const task = await createTask(u, { title: '改提醒', dates: timed(due), reminders: onTime });
      await patchTask(u, task.id, { reminders: [{ type: 'before', minutes: 5 }] });
      await tickAt('2026-10-14T01:55:00.000Z');
      expect(u.hooks()).toHaveLength(1);
      await tickAt(due);
      expect(u.hooks()).toHaveLength(1);

      const other = await createTask(u, { title: '清空提醒', dates: timed(due), reminders: onTime });
      clock.set(START);
      await patchTask(u, other.id, { reminders: [] });
      await tickAt(due);
      expect(u.hooks()).toHaveLength(1);
    });

    it('clearing the dates clears the reminders; switching to 全天 drops the timed ones', async () => {
      const u = await account();
      const a = await createTask(u, { title: '清日期', dates: timed(due), reminders: onTime });
      expect((await patchTask(u, a.id, { dates: null })).reminders).toEqual([]);
      const b = await createTask(u, { title: '改全天', dates: timed(due), reminders: onTime });
      expect((await patchTask(u, b.id, { dates: { allDay: true, dueDate: '2026-10-14' } })).reminders).toEqual([]);
      await tickAt(due);
      expect(u.hooks()).toHaveLength(0);
    });

    it('deleting the task cancels its reminders; restoring it from the 回收站 brings them back', async () => {
      const u = await account();
      const a = await createTask(u, { title: '删掉', dates: timed(due), reminders: onTime });
      const b = await createTask(u, { title: '删了又还原', dates: timed(due), reminders: onTime });
      expect((await api(u, 'DELETE', `/api/tasks/${a.id}`)).statusCode).toBe(204);
      expect((await api(u, 'DELETE', `/api/tasks/${b.id}`)).statusCode).toBe(204);
      expect((await api(u, 'POST', `/api/trash/${b.id}/restore`)).statusCode).toBe(200);
      await tickAt(due);
      expect(u.hooks().map((h) => h.text.split('\n')[0])).toEqual(['提醒：删了又还原']);
    });

    it('completing (also through the parent) or 放弃 cancels; re-opening schedules again', async () => {
      const u = await account();
      const done = await createTask(u, { title: '完成了', dates: timed(due), reminders: onTime });
      const parent = await createTask(u, { title: '父任务' });
      await createTask(u, { title: '子任务', parentId: parent.id, dates: timed(due), reminders: onTime });
      const abandoned = await createTask(u, { title: '放弃了', dates: timed(due), reminders: onTime });
      const reopened = await createTask(u, { title: '又打开', dates: timed(due), reminders: onTime });
      await patchTask(u, done.id, { status: 'completed' });
      await patchTask(u, parent.id, { status: 'completed' });
      await patchTask(u, abandoned.id, { status: 'abandoned' });
      await patchTask(u, reopened.id, { status: 'completed' });
      await patchTask(u, reopened.id, { status: 'open' });
      await tickAt(due);
      expect(u.hooks().map((h) => h.text.split('\n')[0])).toEqual(['提醒：又打开']);
    });

    it('the next instance of a 重复任务 reminds by the same rules', async () => {
      const u = await account();
      const task = await createTask(u, { title: '每天背单词', dates: timed(due), repeat: { freq: 'daily' }, reminders: onTime });
      await patchTask(u, task.id, { status: 'completed' }); // 08:00 on the 14th
      const list = await api(u, 'GET', `/api/tasks?listId=${task.listId}`);
      const next = taskSchema.array().parse(list.json().tasks).find((x) => x.status === 'open' && x.title === '每天背单词');
      expect(next?.dates).toMatchObject({ dueAt: '2026-10-15T02:00:00.000Z' });
      expect(next?.reminders).toEqual(onTime);

      await tickAt(due); // the completed instance does not remind
      expect(u.hooks()).toHaveLength(0);
      await tickAt('2026-10-15T02:00:00.000Z');
      expect(u.hooks()).toHaveLength(1);
    });

    it('reminders for times already past are not sent', async () => {
      const u = await account();
      clock.set('2026-10-14T03:00:00.000Z');
      await createTask(u, { title: '过去的', dates: timed(due), reminders: onTime });
      expect(await t.app.reminders.tick()).toMatchObject({ fired: 0 });
      expect(u.hooks()).toHaveLength(0);
    });
  });

  describe('validation', () => {
    it('rejects reminders without a date or of the wrong kind, and unknown channels', async () => {
      const u = await account();
      const other = await account();
      const cases: [object, string][] = [
        [{ title: 'x', reminders: [{ type: 'before', minutes: 0 }] }, 'invalid_reminders'],
        [{ title: 'x', dates: timed('2026-10-14T02:00:00.000Z'), reminders: [{ type: 'day', daysBefore: 0, time: null }] }, 'invalid_reminders'],
        [{ title: 'x', dates: { allDay: true, dueDate: '2026-10-14' }, reminders: [{ type: 'before', minutes: 0 }] }, 'invalid_reminders'],
        [{ title: 'x', reminderChannelIds: [other.feishuId] }, 'invalid_channels'],
        [{ title: 'x', reminderChannelIds: ['00000000-0000-4000-8000-000000000000'] }, 'invalid_channels'],
        [{ title: 'x', dates: timed('2026-10-14T02:00:00.000Z'), reminders: [{ type: 'before', minutes: -5 }] }, 'invalid_request'],
      ];
      for (const [payload, code] of cases) {
        const res = await api(u, 'POST', '/api/tasks', payload);
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
        expect(res.json().error.code).toBe(code);
      }
      const task = await createTask(u, { title: 'y', dates: { allDay: true, dueDate: '2026-10-14' } });
      const res = await api(u, 'PATCH', `/api/tasks/${task.id}`, { reminders: [{ type: 'before', minutes: 0 }] });
      expect(res.json().error.code).toBe('invalid_reminders');
      expect((await api(u, 'PATCH', '/api/settings', { allDayReminderTime: '9:00' })).statusCode).toBe(400);
    });
  });

  describe('应用内提醒', () => {
    const due = '2026-10-14T02:00:00.000Z';

    async function alerts(u: TestUser) {
      return reminderAlertsResponseSchema.parse((await api(u, 'GET', '/api/reminders/alerts')).json()).alerts;
    }

    it('lists fired reminders until dismissed; only for their own user', async () => {
      const u = await account();
      const other = await account({ channels: false });
      const task = await createTask(u, { title: '弹窗', dates: timed(due), reminders: [{ type: 'before', minutes: 0 }] });
      clock.set('2026-10-14T01:59:00.000Z');
      expect(await alerts(u)).toEqual([]);
      await tickAt(due);
      const [alert] = await alerts(u);
      expect(alert).toMatchObject({ taskId: task.id, title: '弹窗', fireAt: due, firedAt: due });
      expect(await alerts(other)).toEqual([]);
      expect((await api(other, 'POST', `/api/reminders/alerts/${alert?.id}/dismiss`)).statusCode).toBe(404);
      expect((await api(u, 'POST', `/api/reminders/alerts/${alert?.id}/dismiss`)).statusCode).toBe(204);
      expect(await alerts(u)).toEqual([]);
    });

    it('stops showing an hour after it fired', async () => {
      const u = await account({ channels: false });
      await createTask(u, { title: '过时', dates: timed(due), reminders: [{ type: 'before', minutes: 0 }] });
      await tickAt(due);
      clock.set(new Date(at(due).getTime() + HOUR));
      expect(await alerts(u)).toHaveLength(1);
      clock.set(new Date(at(due).getTime() + HOUR + 1000));
      expect(await alerts(u)).toEqual([]);
    });

    it('completing the task dismisses it', async () => {
      const u = await account({ channels: false });
      const task = await createTask(u, { title: '直接完成', dates: timed(due), reminders: [{ type: 'before', minutes: 0 }] });
      await tickAt(due);
      expect(await alerts(u)).toHaveLength(1);
      await patchTask(u, task.id, { status: 'completed' });
      expect(await alerts(u)).toEqual([]);
    });

    it('稍后提醒 reminds again (channels and page) after the chosen minutes', async () => {
      const u = await account();
      await createTask(u, { title: '稍后', dates: timed(due), reminders: [{ type: 'before', minutes: 0 }] });
      await tickAt(due);
      const [alert] = await alerts(u);
      const snoozed = await api(u, 'POST', `/api/reminders/alerts/${alert?.id}/snooze`, { minutes: 5 });
      expect(snoozed.statusCode, snoozed.body).toBe(200);
      expect(snoozed.json()).toEqual({ fireAt: '2026-10-14T02:05:00.000Z' });
      expect(await alerts(u)).toEqual([]);
      await tickAt('2026-10-14T02:04:59.000Z');
      expect(u.hooks()).toHaveLength(1);
      await tickAt('2026-10-14T02:05:00.000Z');
      expect(u.hooks()).toHaveLength(2);
      expect((await alerts(u)).map((a) => a.title)).toEqual(['稍后']);
      expect((await api(u, 'POST', `/api/reminders/alerts/${alert?.id}/snooze`, { minutes: 0 })).statusCode).toBe(400);
    });
  });
});
