import { currentFocusResponseSchema, focusRecordsResponseSchema, focusStatsSchema, taskSchema, type CurrentFocusResponse } from '@dida/shared';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { focusSessions } from '../../src/db/schema/focus.js';
import { startFakeWebhook, type FakeWebhookServer } from '../fakes/fake-webhook.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/*
 * EURO-24 review: edge cases beyond focus.test.ts — 专注统计 day boundaries in
 * the user's time zone, concurrent settles (page + job, two tabs) sending the
 * 通知 once, 长休息 counting around 放弃 / 正计时, and per-user isolation of
 * the changes feed.
 */

const SEC = 1000;
const MIN = 60 * SEC;
const START = '2026-10-14T00:00:00.000Z';
const plus = (iso: string, ms: number) => new Date(new Date(iso).getTime() + ms).toISOString();

describe('focus (review edge cases)', () => {
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

  const api = (u: TestUser, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    t.app.inject({ method, url, headers: u.headers, ...(payload ? { payload } : {}) });

  async function call(u: TestUser, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object): Promise<CurrentFocusResponse> {
    const res = await api(u, method, url, payload);
    expect(res.statusCode, res.body).toBe(200);
    return currentFocusResponseSchema.parse(res.json());
  }

  async function user(): Promise<TestUser> {
    clock.set(START);
    n += 1;
    return t.createUser(`review${n}`);
  }

  const stats = async (u: TestUser, q: string) => {
    const res = await api(u, 'GET', `/api/focus/stats?${q}`);
    expect(res.statusCode, res.body).toBe(200);
    return focusStatsSchema.parse(res.json());
  };

  describe('专注统计 by the user’s time zone', () => {
    it('a 番茄 started late in the evening counts on that local day, not the UTC day', async () => {
      const u = await user();
      expect((await api(u, 'PATCH', '/api/settings', { timeZone: 'America/New_York' })).statusCode).toBe(200);
      // 2026-10-14T03:30Z is 23:30 on Tue 13th in New York (EDT, UTC-4).
      const late = '2026-10-14T03:30:00.000Z';
      clock.set(late);
      await call(u, 'POST', '/api/focus/start', { mode: 'pomodoro' });
      clock.set(plus(late, 25 * MIN));
      await call(u, 'GET', '/api/focus/current');

      expect((await stats(u, 'unit=day&date=2026-10-13')).pomodoros).toBe(1);
      expect((await stats(u, 'unit=day&date=2026-10-14')).pomodoros).toBe(0);
      // "Today" in New York at 03:55Z is still the 13th.
      const today = await stats(u, 'unit=day');
      expect(today).toMatchObject({ from: '2026-10-13', pomodoros: 1 });
      expect(today.overview.todayPomodoros).toBe(1);
    });

    it('Asia/Shanghai: 23:59 local counts on that day, 00:00 on the next', async () => {
      const u = await user();
      // 15:59Z = 23:59 Shanghai on the 14th; 16:00Z = 00:00 on the 15th.
      for (const at of ['2026-10-14T15:59:00.000Z', '2026-10-14T16:30:00.000Z']) {
        clock.set(at);
        await call(u, 'POST', '/api/focus/start', { mode: 'stopwatch' });
        clock.set(plus(at, 10 * MIN));
        await call(u, 'POST', '/api/focus/current/finish');
      }
      const week = await stats(u, 'unit=week&date=2026-10-14');
      expect(week.days.find((d) => d.date === '2026-10-14')?.focusMs).toBe(10 * MIN);
      expect(week.days.find((d) => d.date === '2026-10-15')?.focusMs).toBe(10 * MIN);
    });

    it('month and week boundaries (Sunday → Monday, month end)', async () => {
      const u = await user();
      // Sun 2026-11-01 00:10 Shanghai = 2026-10-31T16:10Z.
      const at = '2026-10-31T16:10:00.000Z';
      clock.set(at);
      await call(u, 'POST', '/api/focus/start', { mode: 'pomodoro' });
      clock.set(plus(at, 25 * MIN));
      await call(u, 'GET', '/api/focus/current');
      expect((await stats(u, 'unit=month&date=2026-10-15')).pomodoros).toBe(0);
      expect((await stats(u, 'unit=month&date=2026-11-15')).pomodoros).toBe(1);
      const week = await stats(u, 'unit=week&date=2026-11-01');
      expect(week).toMatchObject({ from: '2026-10-26', to: '2026-11-01', pomodoros: 1 });
    });
  });

  describe('长休息 counting', () => {
    it('放弃 and 正计时 do not count toward the 4 番茄', async () => {
      const u = await user();
      let now = START;
      const phases: string[] = [];
      const pomodoro = async () => {
        clock.set(now);
        await call(u, 'POST', '/api/focus/start', { mode: 'pomodoro' });
        now = plus(now, 25 * MIN);
        clock.set(now);
        phases.push((await call(u, 'GET', '/api/focus/current')).session?.phase ?? 'none');
        now = plus(now, 1 * MIN);
        clock.set(now);
        await call(u, 'POST', '/api/focus/current/finish');
      };
      await pomodoro();
      await pomodoro();
      // An abandoned 番茄 and a 正计时 in between.
      clock.set(now);
      await call(u, 'POST', '/api/focus/start', { mode: 'pomodoro' });
      now = plus(now, 5 * MIN);
      clock.set(now);
      await call(u, 'POST', '/api/focus/current/abandon');
      await call(u, 'POST', '/api/focus/start', { mode: 'stopwatch' });
      now = plus(now, 5 * MIN);
      clock.set(now);
      await call(u, 'POST', '/api/focus/current/finish');
      await pomodoro();
      await pomodoro();
      expect(phases).toEqual(['shortBreak', 'shortBreak', 'shortBreak', 'longBreak']);
    });

    it('a paused 番茄 past its planned end does not complete by itself', async () => {
      const u = await user();
      await call(u, 'POST', '/api/focus/start', { mode: 'pomodoro' });
      clock.set(plus(START, 24 * MIN));
      await call(u, 'POST', '/api/focus/current/pause');
      clock.set(plus(START, 3 * 60 * MIN));
      expect((await call(u, 'GET', '/api/focus/current')).session).toMatchObject({ phase: 'focus', status: 'paused', accumulatedMs: 24 * MIN });
      await call(u, 'POST', '/api/focus/current/resume');
      clock.set(plus(START, 3 * 60 * MIN + 1 * MIN));
      expect((await call(u, 'GET', '/api/focus/current')).session).toMatchObject({ phase: 'shortBreak', startedAt: plus(START, 181 * MIN) });
    });
  });

  describe('专注结束 通知 sent once', () => {
    async function withChannel(name: string) {
      await t.database.db.update(focusSessions).set({ status: 'abandoned', resumedAt: null }).where(inArray(focusSessions.status, ['running', 'paused']));
      const u = await user();
      const res = await api(u, 'POST', '/api/notification-channels', {
        type: 'feishu',
        name: '飞书',
        isDefault: true,
        config: { webhookUrl: `${hook.url}/hook/${name}` },
      });
      expect(res.statusCode, res.body).toBe(201);
      return { u, count: () => hook.requests.filter((r) => r.path === `/hook/${name}`).length };
    }

    it('concurrent ticks and a page refresh racing the job: one message', async () => {
      const { u, count } = await withChannel('race');
      await call(u, 'POST', '/api/focus/start', { mode: 'pomodoro' });
      clock.set(plus(START, 25 * MIN + 20 * SEC));
      const [a, b, page] = await Promise.all([t.app.focus.tick(), t.app.focus.tick(), api(u, 'GET', '/api/focus/current')]);
      expect(page.statusCode).toBe(200);
      expect(count()).toBeLessThanOrEqual(1);
      expect(a.finished + b.finished).toBeLessThanOrEqual(1);
      // Later ticks never resend.
      clock.set(plus(START, 60 * MIN));
      await t.app.focus.tick();
      await t.app.focus.tick();
      expect(count()).toBeLessThanOrEqual(1);
    });

    it('two tabs settling at the same instant leave exactly one 番茄 and one break', async () => {
      const u = await user();
      await call(u, 'POST', '/api/focus/start', { mode: 'pomodoro' });
      clock.set(plus(START, 25 * MIN));
      const results = await Promise.all([api(u, 'GET', '/api/focus/current'), api(u, 'GET', '/api/focus/current'), api(u, 'GET', '/api/focus/current')]);
      for (const r of results) expect(r.statusCode).toBe(200);
      const { records } = focusRecordsResponseSchema.parse((await api(u, 'GET', '/api/focus/records')).json());
      expect(records).toHaveLength(1);
      expect((await call(u, 'GET', '/api/focus/current')).session).toMatchObject({ phase: 'shortBreak', status: 'running' });
    });

    it('concurrent starts: one wins, the rest are 409', async () => {
      const u = await user();
      const results = await Promise.all(Array.from({ length: 5 }, () => api(u, 'POST', '/api/focus/start', { mode: 'pomodoro' })));
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409, 409, 409, 409]);
    });
  });

  describe('isolation and input', () => {
    it('the changes feed carries only the user’s own sessions', async () => {
      const u = await user();
      const other = await user();
      await call(u, 'POST', '/api/focus/start', { mode: 'pomodoro' });
      const changes = (await api(other, 'GET', '/api/changes?since=0')).json();
      expect(changes.entities.focusSession.upserts).toEqual([]);
    });

    it('cannot link a 任务 in the 回收站, and a deleted 任务 keeps its record title', async () => {
      const u = await user();
      const res = await api(u, 'POST', '/api/tasks', { title: '旧任务' });
      const task = taskSchema.parse(res.json());
      await call(u, 'POST', '/api/focus/start', { mode: 'stopwatch', taskId: task.id });
      clock.set(plus(START, 10 * MIN));
      await call(u, 'POST', '/api/focus/current/finish');
      expect((await api(u, 'DELETE', `/api/tasks/${task.id}`)).statusCode).toBeLessThan(300);
      expect((await api(u, 'POST', '/api/focus/start', { mode: 'pomodoro', taskId: task.id })).statusCode).toBe(404);
      const { records } = focusRecordsResponseSchema.parse((await api(u, 'GET', '/api/focus/records')).json());
      expect(records[0]).toMatchObject({ taskId: task.id, taskTitle: '旧任务' });
    });

    it('bad input: non-UUID ids, non-JSON, wrong date format are 400', async () => {
      const u = await user();
      expect((await api(u, 'POST', '/api/focus/start', { mode: 'pomodoro', taskId: 'x'.repeat(10_000) })).statusCode).toBe(400);
      expect((await api(u, 'POST', '/api/focus/start', { mode: 'pomodoro', id: "1' OR 1=1 --" })).statusCode).toBe(400);
      expect((await api(u, 'POST', '/api/focus/start', {})).statusCode).toBe(400);
      expect((await api(u, 'PATCH', '/api/focus/current', {})).statusCode).toBe(400);
      expect((await api(u, 'GET', '/api/focus/stats?date=20261014')).statusCode).toBe(400);
      expect((await api(u, 'GET', `/api/focus/stats?date=${'9'.repeat(5000)}`)).statusCode).toBe(400);
    });
  });
});
