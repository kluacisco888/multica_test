import type { FastifyBaseLogger } from 'fastify';
import { PgBoss } from 'pg-boss';
import type { HolidayService } from './holidays/service.js';

/*
 * Background jobs on pg-boss (PostgreSQL as the queue, no Redis). pg-boss keeps
 * its tables in its own `pgboss` schema and installs / upgrades it on start.
 * Only `main.ts` starts the jobs; the API tests run the app without them.
 */

/** 节假日数据: fetch this year and next year (ADR-0006). */
export const HOLIDAY_REFRESH_QUEUE = 'holidays.refresh';
/** Daily at 04:15 in the configured time zone. */
export const HOLIDAY_REFRESH_CRON = '15 4 * * *';

export interface BackgroundJobs {
  boss: PgBoss;
  stop(): Promise<void>;
}

export interface BackgroundJobsDeps {
  databaseUrl: string;
  holidays: HolidayService;
  /** Time zone the daily schedules run in. */
  timezone: string;
  log: FastifyBaseLogger;
}

export async function startBackgroundJobs({ databaseUrl, holidays, timezone, log }: BackgroundJobsDeps): Promise<BackgroundJobs> {
  const boss = new PgBoss({ connectionString: databaseUrl, max: 4 });
  boss.on('error', (err) => log.error({ err }, 'pg-boss error'));
  await boss.start();

  await boss.createQueue(HOLIDAY_REFRESH_QUEUE);
  await boss.schedule(HOLIDAY_REFRESH_QUEUE, HOLIDAY_REFRESH_CRON, null, { tz: timezone });
  await boss.work(HOLIDAY_REFRESH_QUEUE, { pollingIntervalSeconds: 2 }, async () => {
    // Fetch failures are logged inside and fall back to stored / built-in data; never retried here.
    await holidays.refresh();
  });
  // Also once at startup, so a fresh deployment does not wait until tomorrow.
  await boss.send(HOLIDAY_REFRESH_QUEUE, null);

  return {
    boss,
    stop: () => boss.stop({ graceful: true, timeout: 10_000 }),
  };
}
