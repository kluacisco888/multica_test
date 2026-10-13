import type { FastifyBaseLogger } from 'fastify';
import { PgBoss } from 'pg-boss';
import type { HolidayService } from './holidays/service.js';
import type { TrashService } from './trash.js';

/*
 * Background jobs on pg-boss (PostgreSQL as the queue, no Redis). pg-boss keeps
 * its tables in its own `pgboss` schema and installs / upgrades it on start.
 * Only `main.ts` starts the jobs; the API tests run the app without them.
 */

/** 节假日数据: fetch this year and next year (ADR-0006). */
export const HOLIDAY_REFRESH_QUEUE = 'holidays.refresh';
/** Daily at 04:15 in the configured time zone. */
export const HOLIDAY_REFRESH_CRON = '15 4 * * *';

/** 回收站 30-day cleanup (spec 用户故事 29). */
export const TRASH_PURGE_QUEUE = 'trash.purge';
/** Daily at 03:30 in the configured time zone. */
export const TRASH_PURGE_CRON = '30 3 * * *';

export interface BackgroundJobs {
  boss: PgBoss;
  stop(): Promise<void>;
}

export interface BackgroundJobsDeps {
  databaseUrl: string;
  holidays: HolidayService;
  trash: TrashService;
  /** Time zone the daily schedules run in. */
  timezone: string;
  log: FastifyBaseLogger;
}

export async function startBackgroundJobs({ databaseUrl, holidays, trash, timezone, log }: BackgroundJobsDeps): Promise<BackgroundJobs> {
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

  await boss.createQueue(TRASH_PURGE_QUEUE);
  await boss.schedule(TRASH_PURGE_QUEUE, TRASH_PURGE_CRON, null, { tz: timezone });
  await boss.work(TRASH_PURGE_QUEUE, { pollingIntervalSeconds: 2 }, async () => {
    const purged = await trash.purgeExpired();
    if (purged > 0) log.info({ purged }, '回收站: purged tasks deleted 30 days ago');
  });
  // Also at startup: a server that was down at 03:30 catches up.
  await boss.send(TRASH_PURGE_QUEUE, null);

  return {
    boss,
    stop: () => boss.stop({ graceful: true, timeout: 10_000 }),
  };
}
