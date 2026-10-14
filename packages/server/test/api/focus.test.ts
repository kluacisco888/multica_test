import {
  currentFocusResponseSchema,
  focusRecordsResponseSchema,
  focusStatsSchema,
  taskSchema,
  type CurrentFocusResponse,
  type FocusSession,
} from '@dida/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { fixedClock } from '../../src/clock.js';
import { focusSessions } from '../../src/db/schema/focus.js';
import { FOCUS_TICK_CRON, FOCUS_TICK_QUEUE, startBackgroundJobs } from '../../src/jobs.js';
import { startFakeWebhook, type FakeWebhookServer } from '../fakes/fake-webhook.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/*
 * 番茄专注 (EURO-24, spec 用户故事 86–92). The clock is injected: "refreshing
 * the page" is another `GET /api/focus/current` at a later instant. The
 * page-closed 通知 goes to a fake 飞书 Webhook through the 通知渠道 of EURO-11.
 */

const SEC = 1000;
const MIN = 60 * SEC;
// 2026-10-14 08:00 in Asia/Shanghai (a Wednesday).
const START = '2026-10-14T00:00:00.000Z';
const plus = (iso: string, ms: number) => new Date(new Date(iso).getTime() + ms).toISOString();

describe('focus: 番茄 and 正计时', () => {
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

  function api(user: TestUser, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) {
    return t.app.inject({ method, url, headers: user.headers, ...(payload ? { payload } : {}) });
  }

  async function user(): Promise<TestUser> {
    clock.set(START);
    n += 1;
    return t.createUser(`focus${n}`);
  }

  /** `POST`/`GET` that must succeed, parsed as the current-session response. */
  async function call(u: TestUser, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object): Promise<CurrentFocusResponse> {
    const res = await api(u, method, url, payload);
    expect(res.statusCode, res.body).toBe(200);
    return currentFocusResponseSchema.parse(res.json());
  }

  /** "Refresh the page" at `iso`. */
  async function refreshAt(u: TestUser, iso: string): Promise<FocusSession | null> {
    clock.set(iso);
    return (await call(u, 'GET', '/api/focus/current')).session;
  }

  const start = (u: TestUser, body: object = { mode: 'pomodoro' }) => call(u, 'POST', '/api/focus/start', body);

  async function createTask(u: TestUser, title: string) {
    const res = await api(u, 'POST', '/api/tasks', { title });
    expect(res.statusCode, res.body).toBe(201);
    return taskSchema.parse(res.json());
  }

  describe('番茄 countdown on the server', () => {
    it('a refresh continues the countdown with the right time left', async () => {
      const u = await user();
      const { session, now } = await start(u);
      expect(now).toBe(START);
      expect(session).toMatchObject({
        mode: 'pomodoro',
        phase: 'focus',
        status: 'running',
        plannedMs: 25 * MIN,
        accumulatedMs: 0,
        startedAt: START,
        endsAt: '2026-10-14T00:25:00.000Z',
      });

      const later = await refreshAt(u, plus(START, 10 * MIN));
      expect(later).toMatchObject({ id: session?.id, status: 'running', endsAt: '2026-10-14T00:25:00.000Z' });
    });

    it('pause stops the countdown, 继续 picks it up where it was', async () => {
      const u = await user();
      await start(u);
      clock.set(plus(START, 10 * MIN));
      const paused = (await call(u, 'POST', '/api/focus/current/pause')).session;
      expect(paused).toMatchObject({ status: 'paused', accumulatedMs: 10 * MIN, resumedAt: null, endsAt: null });

      // An hour later, after a refresh: still paused with 15 minutes left.
      expect(await refreshAt(u, plus(START, 70 * MIN))).toMatchObject({ status: 'paused', accumulatedMs: 10 * MIN });
      const resumed = (await call(u, 'POST', '/api/focus/current/resume')).session;
      expect(resumed).toMatchObject({ status: 'running', resumedAt: plus(START, 70 * MIN), endsAt: plus(START, 85 * MIN) });

      expect(await refreshAt(u, plus(START, 84 * MIN))).toMatchObject({ phase: 'focus', status: 'running' });
      // Pausing twice or resuming a running timer is a conflict.
      expect((await api(u, 'POST', '/api/focus/current/resume')).statusCode).toBe(409);
    });

    it('goes into a 短休息 by itself when the 番茄 ends, and a 长休息 after the 4th', async () => {
      const u = await user();
      let now = START;
      const breaks: (FocusSession | null)[] = [];
      for (let i = 0; i < 4; i += 1) {
        clock.set(now);
        await start(u);
        now = plus(now, 25 * MIN);
        breaks.push(await refreshAt(u, now));
        // Skip the rest of the break (结束休息).
        clock.set(plus(now, 1 * MIN));
        expect((await call(u, 'POST', '/api/focus/current/finish')).session).toBeNull();
        now = plus(now, 1 * MIN);
      }
      expect(breaks.map((b) => [b?.phase, b?.status, b?.plannedMs])).toEqual([
        ['shortBreak', 'running', 5 * MIN],
        ['shortBreak', 'running', 5 * MIN],
        ['shortBreak', 'running', 5 * MIN],
        ['longBreak', 'running', 15 * MIN],
      ]);
      // The break starts exactly when the 番茄 ended, not when the page noticed.
      expect(breaks[0]?.startedAt).toBe(plus(START, 25 * MIN));

      // The 5th 番茄 is followed by a 短休息 again; a break that runs out ends the cycle.
      clock.set(now);
      await start(u);
      const fifth = await refreshAt(u, plus(now, 25 * MIN));
      expect(fifth).toMatchObject({ phase: 'shortBreak', endsAt: plus(now, 30 * MIN) });
      expect(await refreshAt(u, plus(now, 30 * MIN))).toBeNull();
    });

    it('a refresh long after the end lands on the right state (番茄 done, break done)', async () => {
      const u = await user();
      await start(u);
      expect(await refreshAt(u, plus(START, 3 * 60 * MIN))).toBeNull();
      const { records } = focusRecordsResponseSchema.parse((await api(u, 'GET', '/api/focus/records')).json());
      expect(records).toEqual([
        expect.objectContaining({ mode: 'pomodoro', startedAt: START, endedAt: plus(START, 25 * MIN), focusMs: 25 * MIN }),
      ]);
    });

    it('uses the 番茄设置 lengths', async () => {
      const u = await user();
      const res = await api(u, 'PATCH', '/api/settings', { pomodoro: { focusMinutes: 50, shortBreakMinutes: 10, longBreakEvery: 2 } });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().pomodoro).toEqual({ focusMinutes: 50, shortBreakMinutes: 10, longBreakMinutes: 15, longBreakEvery: 2 });
      expect((await start(u)).session?.plannedMs).toBe(50 * MIN);
      expect(await refreshAt(u, plus(START, 50 * MIN))).toMatchObject({ phase: 'shortBreak', plannedMs: 10 * MIN });
      clock.set(plus(START, 60 * MIN));
      await start(u);
      expect(await refreshAt(u, plus(START, 110 * MIN))).toMatchObject({ phase: 'longBreak', plannedMs: 15 * MIN });

      for (const pomodoro of [{ focusMinutes: 0 }, { focusMinutes: 181 }, { shortBreakMinutes: 2.5 }, { other: 1 }]) {
        expect((await api(u, 'PATCH', '/api/settings', { pomodoro })).statusCode).toBe(400);
      }
    });

    it('放弃 ends the 番茄 without a record or a break', async () => {
      const u = await user();
      await start(u);
      clock.set(plus(START, 12 * MIN));
      expect((await call(u, 'POST', '/api/focus/current/abandon')).session).toBeNull();
      expect(await refreshAt(u, plus(START, 30 * MIN))).toBeNull();
      expect(focusRecordsResponseSchema.parse((await api(u, 'GET', '/api/focus/records')).json()).records).toEqual([]);
      // A 番茄 cannot be finished early, only abandoned.
      await start(u);
      expect((await api(u, 'POST', '/api/focus/current/finish')).statusCode).toBe(409);
    });

    it('one timer at a time; starting a 番茄 during a break ends the break', async () => {
      const u = await user();
      await start(u);
      const again = await api(u, 'POST', '/api/focus/start', { mode: 'stopwatch' });
      expect(again.statusCode).toBe(409);
      expect(again.json().error.code).toBe('focus_active');

      await refreshAt(u, plus(START, 25 * MIN)); // now in a 短休息
      clock.set(plus(START, 27 * MIN));
      const next = (await start(u)).session;
      expect(next).toMatchObject({ phase: 'focus', startedAt: plus(START, 27 * MIN) });
    });

    it('timer actions without a timer are 404; bad bodies are 400', async () => {
      const u = await user();
      for (const action of ['pause', 'resume', 'abandon', 'finish']) {
        expect((await api(u, 'POST', `/api/focus/current/${action}`)).statusCode).toBe(404);
      }
      expect((await api(u, 'PATCH', '/api/focus/current', { taskId: null })).statusCode).toBe(404);
      expect((await api(u, 'POST', '/api/focus/start', { mode: 'egg' })).statusCode).toBe(400);
      expect((await api(u, 'POST', '/api/focus/start', { mode: 'pomodoro', extra: 1 })).statusCode).toBe(400);
      expect((await api(u, 'GET', '/api/focus/stats?unit=year')).statusCode).toBe(400);
      expect((await api(u, 'GET', '/api/focus/stats?date=2026-02-30')).statusCode).toBe(400);
    });

    it('a client-generated id is kept; a used id is 409', async () => {
      const u = await user();
      const id = '7d1f6f4e-3b1a-4c55-9a6b-1f0f0e0d0c0b';
      expect((await start(u, { id, mode: 'stopwatch' })).session?.id).toBe(id);
      await call(u, 'POST', '/api/focus/current/finish');
      expect((await api(u, 'POST', '/api/focus/start', { id, mode: 'stopwatch' })).statusCode).toBe(409);
    });
  });

  describe('正计时', () => {
    it('counts up until 结束, pauses excluded, and is recorded', async () => {
      const u = await user();
      const { session } = await start(u, { mode: 'stopwatch' });
      expect(session).toMatchObject({ mode: 'stopwatch', phase: 'focus', plannedMs: null, endsAt: null });
      clock.set(plus(START, 20 * MIN));
      await call(u, 'POST', '/api/focus/current/pause');
      // Hours later on another device: still paused at 20 minutes, never ends by itself.
      expect(await refreshAt(u, plus(START, 5 * 60 * MIN))).toMatchObject({ status: 'paused', accumulatedMs: 20 * MIN });
      await call(u, 'POST', '/api/focus/current/resume');
      clock.set(plus(START, 5 * 60 * MIN + 10 * MIN));
      expect((await call(u, 'POST', '/api/focus/current/finish')).session).toBeNull();
      const { records } = focusRecordsResponseSchema.parse((await api(u, 'GET', '/api/focus/records')).json());
      expect(records).toEqual([
        expect.objectContaining({ mode: 'stopwatch', focusMs: 30 * MIN, startedAt: START, endedAt: plus(START, 310 * MIN) }),
      ]);
    });
  });

  describe('关联任务', () => {
    it('links a 任务 at the start or later, and only the user’s own', async () => {
      const u = await user();
      const other = await user();
      const mine = await createTask(u, '写周报');
      const theirs = await createTask(other, '别人的任务');

      expect((await api(u, 'POST', '/api/focus/start', { mode: 'pomodoro', taskId: theirs.id })).statusCode).toBe(404);
      const { session } = await start(u, { mode: 'pomodoro', taskId: mine.id });
      expect(session).toMatchObject({ taskId: mine.id, taskTitle: '写周报' });

      expect((await api(u, 'PATCH', '/api/focus/current', { taskId: theirs.id })).statusCode).toBe(404);
      expect((await call(u, 'PATCH', '/api/focus/current', { taskId: null })).session).toMatchObject({ taskId: null, taskTitle: null });
      expect((await call(u, 'PATCH', '/api/focus/current', { taskId: mine.id })).session).toMatchObject({ taskTitle: '写周报' });

      await refreshAt(u, plus(START, 25 * MIN));
      const { records } = focusRecordsResponseSchema.parse((await api(u, 'GET', '/api/focus/records')).json());
      expect(records[0]).toMatchObject({ taskId: mine.id, taskTitle: '写周报' });
    });

    it('another user sees nothing of it', async () => {
      const u = await user();
      const other = await user();
      await start(u);
      expect(await refreshAt(other, plus(START, 1 * MIN))).toBeNull();
      expect((await api(other, 'POST', '/api/focus/current/pause')).statusCode).toBe(404);
      await refreshAt(u, plus(START, 25 * MIN));
      expect(focusRecordsResponseSchema.parse((await api(other, 'GET', '/api/focus/records')).json()).records).toEqual([]);
      const stats = focusStatsSchema.parse((await api(other, 'GET', '/api/focus/stats?unit=day&date=2026-10-14')).json());
      expect(stats.overview.totalPomodoros).toBe(0);
    });

    it('rejects anonymous requests', async () => {
      for (const [method, url] of [
        ['GET', '/api/focus/current'],
        ['POST', '/api/focus/start'],
        ['GET', '/api/focus/records'],
        ['GET', '/api/focus/stats'],
      ] as const) {
        expect((await t.app.inject({ method, url, payload: method === 'POST' ? { mode: 'pomodoro' } : undefined })).statusCode).toBe(401);
      }
    });
  });

  describe('专注结束的通知', () => {
    async function withChannel(name: string) {
      // Each test starts with no other timer running, so tick counts are its own.
      await t.database.db.update(focusSessions).set({ status: 'abandoned', resumedAt: null }).where(inArray(focusSessions.status, ['running', 'paused']));
      const u = await user();
      const res = await api(u, 'POST', '/api/notification-channels', {
        type: 'feishu',
        name: '飞书',
        isDefault: true,
        config: { webhookUrl: `${hook.url}/hook/${name}` },
      });
      expect(res.statusCode, res.body).toBe(201);
      const texts = () =>
        hook.requests.filter((r) => r.path === `/hook/${name}`).map((r) => (r.json as { content: { text: string } }).content.text);
      return { u, texts };
    }

    it('page closed: the server ends the 番茄 and the fake receiver gets the message', async () => {
      const { u, texts } = await withChannel('closed');
      const task = await createTask(u, '写周报');
      await start(u, { mode: 'pomodoro', taskId: task.id });
      const end = plus(START, 25 * MIN);

      // Nobody refreshes. Until the grace period after the end, the page may still settle it.
      clock.set(plus(end, 14 * SEC));
      expect(await t.app.focus.tick()).toMatchObject({ finished: 0, notified: 0 });
      expect(texts()).toEqual([]);

      clock.set(plus(end, 15 * SEC));
      expect(await t.app.focus.tick()).toMatchObject({ finished: 1, notified: 1 });
      expect(texts()).toEqual(['专注结束：写周报\n完成了 25 分钟专注，短休息开始了\n来自勾勾清单']);
      // Sent once; the break that follows ends silently.
      clock.set(plus(end, 10 * MIN));
      await t.app.focus.tick();
      expect(texts()).toHaveLength(1);
      expect(await refreshAt(u, plus(end, 10 * MIN))).toBeNull();
    });

    it('page open: the page settles the 番茄 at its end, so no message is sent', async () => {
      const { u, texts } = await withChannel('open');
      await start(u);
      const end = plus(START, 25 * MIN);
      expect(await refreshAt(u, end)).toMatchObject({ phase: 'shortBreak' });
      clock.set(plus(end, 1 * MIN));
      expect(await t.app.focus.tick()).toMatchObject({ notified: 0 });
      expect(texts()).toEqual([]);
    });

    it('a paused or abandoned 番茄 sends nothing', async () => {
      const { u, texts } = await withChannel('paused');
      await start(u);
      clock.set(plus(START, 5 * MIN));
      await call(u, 'POST', '/api/focus/current/pause');
      clock.set(plus(START, 60 * MIN));
      expect(await t.app.focus.tick()).toMatchObject({ finished: 0 });
      await call(u, 'POST', '/api/focus/current/abandon');
      await t.app.focus.tick();
      expect(texts()).toEqual([]);
    });

    it('the pg-boss job runs the focus tick at startup and every minute', async () => {
      const { u, texts } = await withChannel('job');
      await start(u);
      clock.set(plus(START, 26 * MIN));
      const jobs = await startBackgroundJobs({
        databaseUrl: t.database.url,
        holidays: t.app.holidays,
        trash: t.app.trash,
        reminders: t.app.reminders,
        focus: t.app.focus,
        timezone: 'Asia/Shanghai',
        log: t.app.log,
      });
      try {
        const deadline = Date.now() + 20_000;
        while (texts().length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
        expect(texts().map((x) => x.split('\n')[0])).toEqual(['专注结束']);
        expect((await jobs.boss.getSchedules(FOCUS_TICK_QUEUE)).map((s) => s.cron)).toEqual([FOCUS_TICK_CRON]);
      } finally {
        await jobs.stop();
      }
    });

    it('nextDueAt tells the job when to look again', async () => {
      const u = await user();
      await start(u);
      const due = await t.app.focus.nextDueAt();
      expect(due).not.toBeNull();
      expect(due!.getTime()).toBeLessThanOrEqual(new Date(plus(START, 25 * MIN + 15 * SEC)).getTime());
    });
  });

  describe('专注统计', () => {
    it('by day, week and month, and per 任务', async () => {
      const u = await user();
      const report = await createTask(u, '写周报');
      const words = await createTask(u, '背单词');
      // Wed 14th: two 番茄 on 写周报, 40 minutes 正计时 on 背单词.
      await start(u, { mode: 'pomodoro', taskId: report.id });
      await refreshAt(u, plus(START, 25 * MIN));
      clock.set(plus(START, 30 * MIN));
      await start(u, { mode: 'pomodoro', taskId: report.id });
      await refreshAt(u, plus(START, 55 * MIN));
      clock.set(plus(START, 60 * MIN));
      await start(u, { mode: 'stopwatch', taskId: words.id });
      clock.set(plus(START, 100 * MIN));
      await call(u, 'POST', '/api/focus/current/finish');
      // Fri 16th: one 番茄 without a task; an abandoned one does not count.
      const fri = '2026-10-16T02:00:00.000Z';
      clock.set(fri);
      await start(u);
      await refreshAt(u, plus(fri, 25 * MIN));
      clock.set(plus(fri, 40 * MIN));
      await start(u);
      clock.set(plus(fri, 50 * MIN));
      await call(u, 'POST', '/api/focus/current/abandon');

      const stats = async (q: string) => {
        const res = await api(u, 'GET', `/api/focus/stats?${q}`);
        expect(res.statusCode, res.body).toBe(200);
        return focusStatsSchema.parse(res.json());
      };
      const day = await stats('unit=day&date=2026-10-14');
      expect(day).toMatchObject({ from: '2026-10-14', to: '2026-10-14', pomodoros: 2, focusMs: 90 * MIN });
      expect(day.tasks).toEqual([
        { taskId: report.id, title: '写周报', pomodoros: 2, focusMs: 50 * MIN },
        { taskId: words.id, title: '背单词', pomodoros: 0, focusMs: 40 * MIN },
      ]);
      const week = await stats('unit=week&date=2026-10-14');
      expect(week).toMatchObject({ from: '2026-10-12', to: '2026-10-18', pomodoros: 3, focusMs: 115 * MIN });
      expect(week.days.map((d) => d.focusMs / MIN)).toEqual([0, 0, 90, 0, 25, 0, 0]);
      const month = await stats('unit=month&date=2026-10-14');
      expect(month).toMatchObject({ from: '2026-10-01', to: '2026-10-31', pomodoros: 3, focusMs: 115 * MIN });
      expect((await stats('unit=month&date=2026-09-01')).focusMs).toBe(0);
      // 概览 is "today" by the injected clock (still Friday the 16th).
      expect(month.overview).toEqual({ todayPomodoros: 1, todayFocusMs: 25 * MIN, totalPomodoros: 3, totalFocusMs: 115 * MIN });
      expect(month.taskTotals.map((x) => [x.title, x.focusMs / MIN])).toEqual([
        ['写周报', 50],
        ['背单词', 40],
      ]);
      // Without a date: the period containing today.
      expect(await stats('unit=week')).toMatchObject({ from: '2026-10-12' });

      const { records } = focusRecordsResponseSchema.parse((await api(u, 'GET', '/api/focus/records')).json());
      expect(records.map((r) => [r.mode, r.taskTitle, r.focusMs / MIN])).toEqual([
        ['pomodoro', null, 25],
        ['stopwatch', '背单词', 40],
        ['pomodoro', '写周报', 25],
        ['pomodoro', '写周报', 25],
      ]);
    });
  });

  it('专注记录 are in the changes feed (ADR-0004)', async () => {
    const u = await user();
    const { session } = await start(u);
    const changes = (await api(u, 'GET', '/api/changes?since=0')).json();
    expect(changes.entities.focusSession.upserts).toEqual([expect.objectContaining({ id: session?.id, status: 'running' })]);
  });
});
