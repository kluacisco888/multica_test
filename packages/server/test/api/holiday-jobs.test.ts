import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import {
  HOLIDAY_REFRESH_CRON,
  HOLIDAY_REFRESH_QUEUE,
  startBackgroundJobs,
  TRASH_PURGE_CRON,
  TRASH_PURGE_QUEUE,
  type BackgroundJobs,
} from '../../src/jobs.js';
import { startFakeHolidayCn, type FakeHolidayCn } from '../support/fake-holiday-cn.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

/*
 * Background jobs through pg-boss (spec: background jobs use pg-boss): the daily
 * 节假日数据 fetch (ADR-0006) and the daily 回收站 cleanup (spec 用户故事 29).
 */

describe('background jobs: daily holiday refresh and 回收站 cleanup', () => {
  let fake: FakeHolidayCn;
  let t: TestApp;
  let jobs: BackgroundJobs;
  let expiredTaskId: string;
  let userHeaders: Record<string, string>;

  beforeAll(async () => {
    fake = await startFakeHolidayCn();
    fake.set(2026, { json: JSON.parse(readFileSync(new URL('../../holidays/2026.json', import.meta.url), 'utf8')) });
    const clock = fixedClock('2026-10-13T00:30:00.000Z');
    t = await createTestApp({ clock, env: { HOLIDAY_DATA_URL: fake.url } });
    // A task deleted 31 days before the jobs start: the startup cleanup run purges it.
    const user = await t.createUser('jobs');
    userHeaders = user.headers;
    const created = await t.app.inject({ method: 'POST', url: '/api/tasks', headers: userHeaders, payload: { title: 'old' } });
    expiredTaskId = created.json().id as string;
    await t.app.inject({ method: 'DELETE', url: `/api/tasks/${expiredTaskId}`, headers: userHeaders });
    clock.advance(31 * 24 * 60 * 60 * 1000);
    userHeaders = (await t.login(user.username, user.password)).headers; // the old session has expired by now
    jobs = await startBackgroundJobs({
      databaseUrl: t.database.url,
      holidays: t.app.holidays,
      trash: t.app.trash,
      reminders: t.app.reminders,
      timezone: 'Asia/Shanghai',
      log: t.app.log,
    });
  });
  afterAll(async () => {
    await jobs?.stop();
    await t.close();
    await fake.close();
  });

  it('fetches once at startup', async () => {
    const deadline = Date.now() + 20_000;
    while ((await t.app.holidays.status()).lastUpdatedAt === null) {
      if (Date.now() > deadline) throw new Error('startup refresh did not run');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(fake.requests).toEqual(['/2026.json', '/2027.json']);
    expect((await t.app.holidays.status()).years[0]).toMatchObject({ year: 2026, source: 'remote' });
  });

  it('is scheduled every day in the configured time zone', async () => {
    const schedules = await jobs.boss.getSchedules(HOLIDAY_REFRESH_QUEUE);
    expect(schedules.map((s) => ({ name: s.name, cron: s.cron, tz: s.timezone }))).toEqual([
      { name: HOLIDAY_REFRESH_QUEUE, cron: HOLIDAY_REFRESH_CRON, tz: 'Asia/Shanghai' },
    ]);
  });

  it('cleans up the 回收站 at startup and schedules it every day', async () => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const trash = await t.app.inject({ method: 'GET', url: '/api/trash', headers: userHeaders });
      if (trash.json().tasks.length === 0) break;
      if (Date.now() > deadline) throw new Error('startup 回收站 cleanup did not run');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const changes = await t.app.inject({ method: 'GET', url: '/api/changes?since=0', headers: userHeaders });
    expect(changes.json().entities.task.tombstones.map((x: { id: string }) => x.id)).toEqual([expiredTaskId]);
    const schedules = await jobs.boss.getSchedules(TRASH_PURGE_QUEUE);
    expect(schedules.map((s) => ({ name: s.name, cron: s.cron, tz: s.timezone }))).toEqual([
      { name: TRASH_PURGE_QUEUE, cron: TRASH_PURGE_CRON, tz: 'Asia/Shanghai' },
    ]);
  });

  it('starting again (an app restart) keeps a single schedule', async () => {
    await jobs.stop();
    jobs = await startBackgroundJobs({
      databaseUrl: t.database.url,
      holidays: t.app.holidays,
      trash: t.app.trash,
      reminders: t.app.reminders,
      timezone: 'Asia/Shanghai',
      log: t.app.log,
    });
    expect(await jobs.boss.getSchedules(HOLIDAY_REFRESH_QUEUE)).toHaveLength(1);
    expect(await jobs.boss.getSchedules(TRASH_PURGE_QUEUE)).toHaveLength(1);
  });
});
