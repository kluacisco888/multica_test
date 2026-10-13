import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { HOLIDAY_REFRESH_CRON, HOLIDAY_REFRESH_QUEUE, startBackgroundJobs, type BackgroundJobs } from '../../src/jobs.js';
import { startFakeHolidayCn, type FakeHolidayCn } from '../support/fake-holiday-cn.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

/* Daily 节假日数据 fetch through pg-boss (spec: background jobs use pg-boss, ADR-0006). */

describe('background jobs: daily holiday refresh', () => {
  let fake: FakeHolidayCn;
  let t: TestApp;
  let jobs: BackgroundJobs;

  beforeAll(async () => {
    fake = await startFakeHolidayCn();
    fake.set(2026, { json: JSON.parse(readFileSync(new URL('../../holidays/2026.json', import.meta.url), 'utf8')) });
    t = await createTestApp({ clock: fixedClock('2026-10-13T00:30:00.000Z'), env: { HOLIDAY_DATA_URL: fake.url } });
    jobs = await startBackgroundJobs({
      databaseUrl: t.database.url,
      holidays: t.app.holidays,
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

  it('starting again (an app restart) keeps a single schedule', async () => {
    await jobs.stop();
    jobs = await startBackgroundJobs({
      databaseUrl: t.database.url,
      holidays: t.app.holidays,
      timezone: 'Asia/Shanghai',
      log: t.app.log,
    });
    expect(await jobs.boss.getSchedules(HOLIDAY_REFRESH_QUEUE)).toHaveLength(1);
  });
});
