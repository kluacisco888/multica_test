import type { FastifyBaseLogger } from 'fastify';
import { PgBoss } from 'pg-boss';
import type { HolidayService } from './holidays/service.js';
import type { FocusService } from './focus/service.js';
import type { ReminderService } from './reminders/scheduler.js';
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

/**
 * 提醒 delivery (spec 用户故事 78–84): a tick sends whatever is due. It runs
 * at startup (catching up after a downtime, at most 24 hours back), every
 * minute as a safety net, and at each scheduled instant: the reminder service
 * calls its waker with every new fire / retry time, which queues a tick job
 * with `startAfter` at that instant.
 */
export const REMINDER_TICK_QUEUE = 'reminders.tick';
export const REMINDER_TICK_CRON = '* * * * *';

/**
 * 专注结束 (spec 用户故事 91): settles 番茄 whose page was closed and sends the
 * 通知. Like the reminder tick: at startup, every minute, and at each
 * countdown end (plus the grace period) through the focus service's waker.
 */
export const FOCUS_TICK_QUEUE = 'focus.tick';
export const FOCUS_TICK_CRON = '* * * * *';

export interface BackgroundJobs {
  boss: PgBoss;
  stop(): Promise<void>;
}

export interface BackgroundJobsDeps {
  databaseUrl: string;
  holidays: HolidayService;
  trash: TrashService;
  reminders: ReminderService;
  focus: FocusService;
  /** Time zone the daily schedules run in. */
  timezone: string;
  log: FastifyBaseLogger;
}

export async function startBackgroundJobs({ databaseUrl, holidays, trash, reminders, focus, timezone, log }: BackgroundJobsDeps): Promise<BackgroundJobs> {
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

  await boss.createQueue(REMINDER_TICK_QUEUE);
  await boss.schedule(REMINDER_TICK_QUEUE, REMINDER_TICK_CRON, null, { tz: timezone });
  const wakeReminders = waker(boss, REMINDER_TICK_QUEUE, log);
  await boss.work(REMINDER_TICK_QUEUE, { pollingIntervalSeconds: 1 }, async () => {
    const result = await reminders.tick();
    if (result.fired + result.retrying + result.failed + result.missed > 0) log.info(result, '提醒: tick');
    const next = await reminders.nextDueAt();
    if (next) wakeReminders(next);
  });
  reminders.setWaker(wakeReminders);
  // Also at startup: reminders that came due while the server was down (at most 24 hours ago).
  await boss.send(REMINDER_TICK_QUEUE, null);

  await boss.createQueue(FOCUS_TICK_QUEUE);
  await boss.schedule(FOCUS_TICK_QUEUE, FOCUS_TICK_CRON, null, { tz: timezone });
  const wakeFocus = waker(boss, FOCUS_TICK_QUEUE, log);
  await boss.work(FOCUS_TICK_QUEUE, { pollingIntervalSeconds: 1 }, async () => {
    const result = await focus.tick();
    if (result.finished > 0) log.info(result, '专注: tick');
    const next = await focus.nextDueAt();
    if (next) wakeFocus(next);
  });
  focus.setWaker(wakeFocus);
  await boss.send(FOCUS_TICK_QUEUE, null);

  return {
    boss,
    stop: async () => {
      reminders.setWaker(null);
      focus.setWaker(null);
      await boss.stop({ graceful: true, timeout: 10_000 });
    },
  };
}

/** Queue one tick job per distinct instant (older entries are dropped once past). */
function waker(boss: PgBoss, queue: string, log: FastifyBaseLogger) {
  const queued = new Set<number>();
  return (at: Date) => {
    const now = Date.now();
    for (const t of queued) if (t < now) queued.delete(t);
    if (queued.has(at.getTime())) return;
    queued.add(at.getTime());
    boss.send(queue, null, { startAfter: at }).catch((err: unknown) => log.error({ err, queue }, 'could not queue a tick'));
  };
}
