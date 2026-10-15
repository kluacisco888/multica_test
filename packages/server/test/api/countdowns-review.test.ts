import { reminderFailuresResponseSchema } from '@dida/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { rollbackLastMigration, runMigrations } from '../../src/db/migrations.js';
import { startFakeWebhook, type FakeWebhookServer } from '../fakes/fake-webhook.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/*
 * EURO-26 review: edge cases of the 倒数日 API, task reminders next to
 * 倒数日 reminders in the failure list, and migration 0018 rolled back with
 * data in `reminder_deliveries`.
 */

const START = '2026-10-14T00:00:00.000Z';

describe('countdowns (review)', () => {
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

  function api(user: TestUser, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) {
    return t.app.inject({ method, url, headers: user.headers, ...(payload ? { payload } : {}) });
  }

  async function account() {
    clock.set(START);
    n += 1;
    const name = `rv${n}`;
    const user = await t.createUser(name);
    const feishu = await api(user, 'POST', '/api/notification-channels', {
      type: 'feishu',
      name: '飞书',
      isDefault: true,
      config: { webhookUrl: `${hook.url}/hook/${name}` },
    });
    expect(feishu.statusCode, feishu.body).toBe(201);
    return { ...user, feishuId: feishu.json().id as string };
  }

  describe('edge input', () => {
    it('rejects an overlong name and too many reminders', async () => {
      const u = await account();
      expect((await api(u, 'POST', '/api/countdowns', { name: 'x'.repeat(10_000), date: '2026-11-01' })).statusCode).toBe(400);
      const six = [0, 1, 2, 3, 4, 5].map((d) => ({ type: 'day', daysBefore: d, time: '09:00' }));
      expect((await api(u, 'POST', '/api/countdowns', { name: 'x', date: '2026-11-01', reminders: six })).statusCode).toBe(400);
      expect((await api(u, 'POST', '/api/countdowns', {})).statusCode).toBe(400);
      expect((await api(u, 'POST', '/api/countdowns', { name: 'x', date: '20261101' })).statusCode).toBe(400);
    });

    it('rejects a PATCH with bad fields and a non-uuid id', async () => {
      const u = await account();
      const c = (await api(u, 'POST', '/api/countdowns', { name: 'x', date: '2026-11-01' })).json();
      expect((await api(u, 'PATCH', `/api/countdowns/${c.id}`, { repeat: 'weekly' })).statusCode).toBe(400);
      expect((await api(u, 'PATCH', '/api/countdowns/not-a-uuid', { name: 'y' })).statusCode).toBe(404);
      expect((await api(u, 'DELETE', '/api/countdowns/not-a-uuid')).statusCode).toBe(404);
    });

    it('does not let a user take another user’s client id', async () => {
      const owner = await account();
      const other = await account();
      const id = '1c3e5a7b-9d2f-4a6b-8c0d-2e4f6a8b0c1d';
      expect((await api(owner, 'POST', '/api/countdowns', { id, name: 'mine', date: '2026-11-01' })).statusCode).toBe(201);
      expect((await api(other, 'POST', '/api/countdowns', { id, name: 'theirs', date: '2026-11-01' })).statusCode).toBe(409);
      expect((await api(owner, 'GET', `/api/countdowns/${id}`)).json().name).toBe('mine');
    });

    it('handles 农历 yearly 倒数日 at the ends of the supported range without breaking the list', async () => {
      const u = await account();
      for (const date of ['1901-02-19', '2099-12-31', '2100-12-31']) {
        const res = await api(u, 'POST', '/api/countdowns', { name: date, date, calendar: 'lunar', repeat: 'yearly' });
        expect([201, 400], `${date}: ${res.body}`).toContain(res.statusCode);
      }
      const list = await api(u, 'GET', '/api/countdowns');
      expect(list.statusCode, list.body).toBe(200);
    });
  });

  describe('task reminders next to 倒数日 reminders', () => {
    it('lists failed task and 倒数日 reminders together; task rows keep their taskId', async () => {
      const u = await account();
      const task = await api(u, 'POST', '/api/tasks', {
        title: '任务提醒',
        dates: { allDay: false, startAt: null, dueAt: '2026-10-20T01:00:00.000Z' },
        reminders: [{ type: 'before', minutes: 0 }],
      });
      expect(task.statusCode, task.body).toBe(201);
      await api(u, 'POST', '/api/countdowns', { name: '倒数日提醒', date: '2026-10-20', reminders: [{ type: 'day', daysBefore: 0, time: '09:00' }] });
      hook.replyNext(...Array.from({ length: 8 }, () => ({ status: 500 })));
      for (const at of ['2026-10-20T01:00:00Z', '2026-10-20T01:01:00Z', '2026-10-20T01:06:00Z', '2026-10-20T01:21:00Z']) {
        clock.set(at);
        await t.app.reminders.tick();
      }
      const res = await api(u, 'GET', '/api/reminders/failures');
      const failures = reminderFailuresResponseSchema.parse(res.json()).failures;
      expect(failures).toHaveLength(2);
      const byTitle = Object.fromEntries(failures.map((f) => [f.taskTitle, f]));
      expect(byTitle['任务提醒']).toMatchObject({ taskId: task.json().id, countdownId: null, attempts: 4 });
      expect(byTitle['倒数日提醒']).toMatchObject({ taskId: null, attempts: 4 });
      // In-app alerts only show the task.
      const alerts = (await api(u, 'GET', '/api/reminders/alerts')).json().alerts as { taskId: string }[];
      expect(alerts.map((a) => a.taskId)).toEqual([task.json().id]);
    });
  });

  describe('migration 0018 rollback with data', () => {
    it('drops 倒数日 reminders, keeps task reminders, restores NOT NULL, and migrates up again', async () => {
      const db = t.database.db;
      const count = async (where: string) =>
        Number((await db.execute<{ n: string }>(sql.raw(`SELECT count(*) AS n FROM reminder_deliveries WHERE ${where}`))).rows[0]?.n);
      const taskRows = await count('task_id IS NOT NULL');
      expect(taskRows).toBeGreaterThan(0);
      expect(await count('countdown_id IS NOT NULL')).toBeGreaterThan(0);

      // 0022_task_overdue_on (EURO-28), 0021_smart_input (EURO-27) and 0019_habits (EURO-25) are newer and come off first.
      expect(await rollbackLastMigration(t.database.pool)).toBe('0022_task_overdue_on');
      expect(await rollbackLastMigration(t.database.pool)).toBe('0021_smart_input');
      expect(await rollbackLastMigration(t.database.pool)).toBe('0019_habits');
      expect(await rollbackLastMigration(t.database.pool)).toBe('0018_countdowns');
      expect(await count('true')).toBe(taskRows);
      const col = await db.execute<{ is_nullable: string }>(
        sql`SELECT is_nullable FROM information_schema.columns WHERE table_name = 'reminder_deliveries' AND column_name = 'task_id'`,
      );
      expect(col.rows[0]?.is_nullable).toBe('NO');
      const gone = await db.execute<{ present: boolean }>(sql`SELECT to_regclass('countdowns') IS NOT NULL AS present`);
      expect(gone.rows[0]?.present).toBe(false);

      await runMigrations(db);
      expect(await count('true')).toBe(taskRows);
      const back = await db.execute<{ present: boolean }>(sql`SELECT to_regclass('countdowns') IS NOT NULL AS present`);
      expect(back.rows[0]?.present).toBe(true);
    });

    it('leaves the data of 0015_pinned_tasks, 0016_matrix_quadrants and 0017_focus alone', async () => {
      const db = t.database.db;
      const u = await account();
      const task = await api(u, 'POST', '/api/tasks', { title: '置顶任务' });
      expect(task.statusCode, task.body).toBe(201);
      expect((await api(u, 'PATCH', `/api/tasks/${task.json().id}`, { pinned: true })).statusCode).toBe(200);
      expect((await api(u, 'POST', '/api/focus/start', { mode: 'pomodoro', taskId: task.json().id })).statusCode).toBeLessThan(300);
      expect((await api(u, 'PATCH', '/api/settings', { allDayReminderTime: '08:00' })).statusCode).toBe(200);
      await db.execute(sql`UPDATE user_settings SET matrix_quadrants = '[{"probe":1}]'::jsonb WHERE user_id = ${u.id}`);
      await api(u, 'POST', '/api/countdowns', { name: 'x', date: '2026-11-01', reminders: [{ type: 'day', daysBefore: 0, time: '09:00' }] });

      const snapshot = async () => ({
        pin: (await db.execute(sql`SELECT id, pin_order FROM tasks WHERE user_id = ${u.id} ORDER BY id`)).rows,
        matrix: (await db.execute(sql`SELECT matrix_quadrants, pomodoro FROM user_settings WHERE user_id = ${u.id}`)).rows,
        focus: (await db.execute(sql`SELECT id, task_id, status, mode FROM focus_sessions WHERE user_id = ${u.id} ORDER BY id`)).rows,
      });
      const before = await snapshot();
      expect(before.pin[0]).toMatchObject({ pin_order: expect.any(String) });
      expect(before.matrix[0]).toMatchObject({ matrix_quadrants: [{ probe: 1 }] });
      expect(before.focus).toHaveLength(1);

      // 0022_task_overdue_on (EURO-28), 0021_smart_input (EURO-27) and 0019_habits (EURO-25) are newer and come off first.
      expect(await rollbackLastMigration(t.database.pool)).toBe('0022_task_overdue_on');
      expect(await rollbackLastMigration(t.database.pool)).toBe('0021_smart_input');
      expect(await rollbackLastMigration(t.database.pool)).toBe('0019_habits');
      expect(await rollbackLastMigration(t.database.pool)).toBe('0018_countdowns');
      expect(await snapshot()).toEqual(before);
      await runMigrations(db);
      expect(await snapshot()).toEqual(before);
      // The app still works on the re-migrated schema.
      expect((await api(u, 'GET', '/api/countdowns')).statusCode).toBe(200);
      expect((await api(u, 'GET', '/api/focus/current')).statusCode).toBeLessThan(500);
    });
  });
});
