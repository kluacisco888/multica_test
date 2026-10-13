import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, min, sql } from 'drizzle-orm';
import {
  countdownReminderMessage,
  nextRetryAt,
  reminderMessage,
  reminderSchedule,
  REMINDER_ALERT_WINDOW_MS,
  todayIn,
  withinCatchUp,
  type ChannelMessage,
  type ReminderAlert,
  type ReminderFailure,
} from '@dida/shared';
import { countdownReminderSchedule, lunarLabel, nextOccurrence } from '@dida/shared/countdown';
import type { FastifyBaseLogger } from 'fastify';
import type { Clock } from '../clock.js';
import type { Db, Executor, Tx } from '../db/client.js';
import { countdowns } from '../db/schema/countdowns.js';
import { reminderDeliveries, type ChannelAttempt } from '../db/schema/reminders.js';
import { notificationChannels } from '../db/schema/channels.js';
import { userSettings } from '../db/schema/settings.js';
import { tasks } from '../db/schema/tasks.js';
import type { Notifier } from '../notify/notifier.js';
import { liveChannels } from '../notify/notifier.js';
import { taskDatesToApi, type TaskRow } from '../organize.js';
import { readSettings } from '../settings.js';
import type { SyncOps, SyncWriter } from '../sync/sync.js';

/*
 * 提醒调度与投递 (spec 用户故事 78–84, ADR-0005).
 *
 * The `reminder_deliveries` table is the schedule. Every write to a 任务 (any
 * route: edit, complete, delete, restore, the next instance of a 重复任务)
 * runs `reconcile` in the same transaction through the sync layer's write
 * hook, so the scheduled rows always match the task's reminders: changed
 * times are replaced, closed or deleted tasks are cancelled.
 *
 * `tick()` sends what is due at the injected clock's "now": it fires
 * scheduled rows (re-checking them against the task), sends to each
 * 通知渠道, and retries failures 1, 5 and 15 minutes later. Reminders that
 * came due more than 24 hours ago (server was down) are marked `missed`
 * instead of sent. pg-boss runs `tick()` (see jobs.ts): at startup, every
 * minute, and at each scheduled instant through the waker.
 */

type DeliveryRow = typeof reminderDeliveries.$inferSelect;
type CountdownRow = typeof countdowns.$inferSelect;
type ScheduleSettings = { timeZone: string; allDayReminderTime: string };

export interface TickResult {
  fired: number;
  sent: number;
  failed: number;
  retrying: number;
  cancelled: number;
  missed: number;
}

export interface ReminderService {
  /** Keep the scheduled deliveries of these tasks in step with them (called by the sync hook). */
  reconcile(ops: SyncOps, tx: Tx, userId: string, taskIds: string[]): Promise<void>;
  /** The same for 倒数日 (called by the sync hook, and after each firing for the next year). */
  reconcileCountdowns(ops: SyncOps, tx: Tx, userId: string, countdownIds: string[]): Promise<void>;
  /** Send everything due now. Runs one at a time. */
  tick(): Promise<TickResult>;
  /** Earliest pending fire or retry instant, if any. */
  nextDueAt(): Promise<Date | null>;
  /** Called with each new instant something becomes due (pg-boss schedules a tick then). */
  setWaker(waker: ((at: Date) => void) | null): void;
  /** 应用内提醒: fired in the last hour, not dismissed, task still open. */
  alerts(userId: string): Promise<ReminderAlert[]>;
  /** false when the alert is not the user's. */
  dismissAlert(userId: string, id: string): Promise<boolean>;
  /** 稍后提醒: dismiss and remind again in `minutes`. Null when the alert is not the user's. */
  /**
   * 稍后提醒: dismiss and remind again in `minutes`. `not_found` when the alert
   * is not the user's, `dismissed` when it was already closed or snoozed.
   */
  snooze(userId: string, id: string, minutes: number): Promise<{ fireAt: Date } | 'not_found' | 'dismissed'>;
  /** Deliveries that failed after their retries, newest first (用户故事 83). */
  failures(userId: string): Promise<ReminderFailure[]>;
}

const ACTIVE = ['scheduled', 'delivering'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MISSED_ERROR = '服务停机超过 24 小时，未能发送';
const CHANNEL_DELETED_ERROR = '渠道已删除';

const isLive = (task: TaskRow | undefined): boolean => task !== undefined && task.deletedAt === null && task.status === 'open';

/** The task's reminders with their fire instants under the user's settings. */
function desiredSchedule(task: TaskRow, settings: { timeZone: string; allDayReminderTime: string }) {
  return reminderSchedule(task.reminders, taskDatesToApi(task), { timeZone: settings.timeZone, allDayTime: settings.allDayReminderTime });
}

const isLiveCountdown = (c: CountdownRow | undefined): c is CountdownRow => c !== undefined && c.deletedAt === null && c.archivedAt === null;

/** The 倒数日's reminders, each at its first instant after `after`. */
function countdownSchedule(c: CountdownRow, after: Date, settings: ScheduleSettings) {
  return countdownReminderSchedule(c, after, { timeZone: settings.timeZone, allDayTime: settings.allDayReminderTime });
}

/** The 任务 or 倒数日 a delivery reminds of. */
interface Subject {
  task?: TaskRow;
  countdown?: CountdownRow;
}

function stillMatches(row: DeliveryRow, subject: Subject, settings: ScheduleSettings): boolean {
  if (row.countdownId) {
    const c = subject.countdown;
    if (!isLiveCountdown(c)) return false;
    if (row.source === 'snooze') return true;
    // Is this instant still the first firing of that reminder after (just before) it?
    return countdownSchedule(c, new Date(row.fireAt.getTime() - 1), settings).some(
      (d) => d.key === row.reminderKey && d.fireAt.getTime() === row.fireAt.getTime(),
    );
  }
  const task = subject.task;
  if (!task || !isLive(task)) return false;
  // A 稍后提醒 was asked for explicitly: it stays while the task is open, whatever its dates.
  if (row.source === 'snooze') return true;
  return desiredSchedule(task, settings).some((d) => d.key === row.reminderKey && d.fireAt.getTime() === row.fireAt.getTime());
}

function earliestPending(channels: ChannelAttempt[]): Date | null {
  const times = channels.filter((c) => c.status === 'pending' && c.nextAttemptAt).map((c) => Date.parse(c.nextAttemptAt as string));
  return times.length > 0 ? new Date(Math.min(...times)) : null;
}

export function createReminderService(deps: {
  db: Db;
  sync: SyncWriter;
  clock: Clock;
  notifier: Notifier;
  log: FastifyBaseLogger;
}): ReminderService {
  const { db, sync, clock, notifier, log } = deps;
  let waker: ((at: Date) => void) | null = null;
  let running: Promise<unknown> = Promise.resolve();

  const wake = (at: Date) => {
    try {
      waker?.(at);
    } catch (err) {
      log.warn({ err }, 'could not schedule a reminder tick');
    }
  };

  async function reconcile(ops: SyncOps, tx: Tx, userId: string, taskIds: string[]) {
    if (taskIds.length === 0) return;
    const now = clock.now();
    const settings = await readSettings(tx, userId);
    const rows = await tx.select().from(tasks).where(and(eq(tasks.userId, userId), inArray(tasks.id, taskIds)));
    const scheduled = await tx
      .select()
      .from(reminderDeliveries)
      .where(and(eq(reminderDeliveries.userId, userId), inArray(reminderDeliveries.taskId, taskIds), eq(reminderDeliveries.status, 'scheduled'), isNull(reminderDeliveries.deletedAt)));

    for (const task of rows) {
      const live = isLive(task);
      const desired = live ? desiredSchedule(task, settings) : [];
      const kept = new Set<string>();
      for (const row of scheduled.filter((r) => r.taskId === task.id)) {
        if (stillMatches(row, { task }, settings)) {
          if (row.reminderKey) kept.add(`${row.reminderKey}|${row.fireAt.getTime()}`);
          continue;
        }
        await ops.update(reminderDeliveries, row.id, { status: 'cancelled', nextAttemptAt: null });
      }
      for (const d of desired) {
        // Only future instants: reminders do not fire for times already past when set.
        if (d.fireAt.getTime() <= now.getTime() || kept.has(`${d.key}|${d.fireAt.getTime()}`)) continue;
        await ops.insert(reminderDeliveries, {
          taskId: task.id,
          source: 'rule',
          reminderKey: d.key,
          fireAt: d.fireAt,
          status: 'scheduled',
          nextAttemptAt: d.fireAt,
          channels: [],
          firedAt: null,
          alertDismissedAt: null,
        });
        wake(d.fireAt);
      }
      if (!live) {
        // A completed or deleted task needs no 应用内提醒 any more.
        const open = await tx
          .select({ id: reminderDeliveries.id })
          .from(reminderDeliveries)
          .where(and(eq(reminderDeliveries.taskId, task.id), isNotNull(reminderDeliveries.firedAt), isNull(reminderDeliveries.alertDismissedAt)));
        for (const a of open) await ops.update(reminderDeliveries, a.id, { alertDismissedAt: now });
      }
    }
  }

  async function reconcileCountdowns(ops: SyncOps, tx: Tx, userId: string, ids: string[]) {
    if (ids.length === 0) return;
    const now = clock.now();
    const settings = await readSettings(tx, userId);
    const rows = await tx.select().from(countdowns).where(and(eq(countdowns.userId, userId), inArray(countdowns.id, ids)));
    const scheduled = await tx
      .select()
      .from(reminderDeliveries)
      .where(
        and(
          eq(reminderDeliveries.userId, userId),
          inArray(reminderDeliveries.countdownId, ids),
          eq(reminderDeliveries.status, 'scheduled'),
          isNull(reminderDeliveries.deletedAt),
        ),
      );
    for (const c of rows) {
      const desired = isLiveCountdown(c) ? countdownSchedule(c, now, settings) : [];
      const kept = new Set<string>();
      for (const row of scheduled.filter((r) => r.countdownId === c.id)) {
        const wanted =
          row.source === 'snooze' ? isLiveCountdown(c) : desired.some((d) => d.key === row.reminderKey && d.fireAt.getTime() === row.fireAt.getTime());
        if (wanted) {
          if (row.reminderKey) kept.add(`${row.reminderKey}|${row.fireAt.getTime()}`);
          continue;
        }
        await ops.update(reminderDeliveries, row.id, { status: 'cancelled', nextAttemptAt: null });
      }
      for (const d of desired) {
        if (kept.has(`${d.key}|${d.fireAt.getTime()}`)) continue;
        await ops.insert(reminderDeliveries, {
          taskId: null,
          countdownId: c.id,
          source: 'rule',
          reminderKey: d.key,
          fireAt: d.fireAt,
          status: 'scheduled',
          nextAttemptAt: d.fireAt,
          channels: [],
          firedAt: null,
          alertDismissedAt: null,
        });
        wake(d.fireAt);
      }
    }
  }

  // Every task write, from any route, reconciles that task's reminders.
  sync.onWrite(tasks, ({ ops, tx, userId, ids }) => reconcile(ops, tx, userId, ids));
  // Likewise every 倒数日 write (edit, 归档, delete).
  sync.onWrite(countdowns, ({ ops, tx, userId, ids }) => reconcileCountdowns(ops, tx, userId, ids));
  // 全天提醒时间 and the time zone move the reminders of 全天 tasks.
  sync.onWrite(userSettings, async ({ ops, tx, userId }) => {
    const withReminders = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.userId, userId), eq(tasks.status, 'open'), isNull(tasks.deletedAt), sql`jsonb_array_length(${tasks.reminders}) > 0`));
    await reconcile(ops, tx, userId, withReminders.map((t) => t.id));
    const countdownsWithReminders = await tx
      .select({ id: countdowns.id })
      .from(countdowns)
      .where(and(eq(countdowns.userId, userId), isNull(countdowns.deletedAt), sql`jsonb_array_length(${countdowns.reminders}) > 0`));
    await reconcileCountdowns(ops, tx, userId, countdownsWithReminders.map((c) => c.id));
  });

  async function lockDelivery(tx: Tx, id: string): Promise<DeliveryRow | undefined> {
    const [row] = await tx.select().from(reminderDeliveries).where(eq(reminderDeliveries.id, id)).for('update');
    return row;
  }

  async function subjectOf(db: Executor, row: DeliveryRow): Promise<Subject> {
    if (row.countdownId) {
      const [countdown] = await db.select().from(countdowns).where(eq(countdowns.id, row.countdownId));
      return { countdown };
    }
    if (!row.taskId) return {};
    const [task] = await db.select().from(tasks).where(eq(tasks.id, row.taskId));
    return { task };
  }

  /** Fire / re-check one due row; returns what to send, or null. */
  async function prepare(id: string, userId: string, result: TickResult) {
    return sync.transaction(userId, async (ops, tx) => {
      const now = clock.now();
      const row = await lockDelivery(tx, id);
      if (!row || !ACTIVE.includes(row.status as (typeof ACTIVE)[number]) || !row.nextAttemptAt || row.nextAttemptAt > now) return null;
      const subject = await subjectOf(tx, row);
      const { task, countdown } = subject;
      const settings = await readSettings(tx, userId);

      if (row.status === 'scheduled') {
        // A yearly 倒数日 goes on to next year's reminder whatever happens to this one.
        const scheduleNext = () => (row.countdownId ? reconcileCountdowns(ops, tx, userId, [row.countdownId]) : Promise.resolve());
        if (!stillMatches(row, subject, settings)) {
          await ops.update(reminderDeliveries, row.id, { status: 'cancelled', nextAttemptAt: null });
          result.cancelled += 1;
          await scheduleNext();
          return null;
        }
        if (!withinCatchUp(row.fireAt, now)) {
          await ops.update(reminderDeliveries, row.id, { status: 'missed', nextAttemptAt: null });
          result.missed += 1;
          await scheduleNext();
          return null;
        }
        const wanted = (task ?? countdown)?.reminderChannelIds ?? null;
        const live = await liveChannels(tx, userId);
        const channels = live.filter((c) => (wanted ? wanted.includes(c.id) : c.isDefault));
        // Channels the task named that were deleted since: one failure each, shown in 发送失败的提醒.
        const goneIds = (wanted ?? []).filter((cid) => !live.some((c) => c.id === cid));
        const goneNames = new Map(
          goneIds.length === 0
            ? []
            : (
                await tx
                  .select({ id: notificationChannels.id, name: notificationChannels.name })
                  .from(notificationChannels)
                  .where(and(eq(notificationChannels.userId, userId), inArray(notificationChannels.id, goneIds)))
              ).map((c) => [c.id, c.name] as const),
        );
        const gone: ChannelAttempt[] = goneIds.map((cid) => ({
          channelId: cid,
          channelName: goneNames.get(cid) ?? '已删除的渠道',
          status: 'failed',
          attempts: 0,
          nextAttemptAt: null,
          lastError: CHANNEL_DELETED_ERROR,
          finishedAt: now.toISOString(),
        }));
        result.failed += gone.length;
        const pending: ChannelAttempt[] = channels.map((c) => ({
          channelId: c.id,
          channelName: c.name,
          status: 'pending',
          attempts: 0,
          nextAttemptAt: now.toISOString(),
          lastError: null,
          finishedAt: null,
        }));
        const fired = await ops.update(reminderDeliveries, row.id, {
          status: pending.length > 0 ? 'delivering' : 'done',
          firedAt: now,
          channels: [...pending, ...gone],
          nextAttemptAt: pending.length > 0 ? now : null,
        });
        result.fired += 1;
        await scheduleNext();
        if (!fired || pending.length === 0) return null;
        return { row: fired, subject, settings };
      }

      // `delivering`: a retry is due. Only a retry that itself came due more than
      // 24 hours ago (the server was down) is given up; live retries of a
      // reminder that fired late still run.
      if (!withinCatchUp(row.nextAttemptAt, now)) {
        const channels = row.channels.map((c) =>
          c.status === 'pending' ? { ...c, status: 'failed' as const, nextAttemptAt: null, lastError: MISSED_ERROR, finishedAt: now.toISOString() } : c,
        );
        result.failed += row.channels.filter((c) => c.status === 'pending').length;
        await ops.update(reminderDeliveries, row.id, { status: 'done', channels, nextAttemptAt: null });
        return null;
      }
      if (!task && !countdown) return null;
      return { row, subject, settings };
    });
  }

  async function deliver(id: string, userId: string, result: TickResult) {
    const plan = await prepare(id, userId, result);
    if (!plan) return;
    const sendAt = clock.now();
    const due = plan.row.channels.filter((c) => c.status === 'pending' && c.nextAttemptAt && Date.parse(c.nextAttemptAt) <= sendAt.getTime());
    const message = messageFor(plan.subject, sendAt, plan.settings.timeZone);
    if (!message) return;
    // Network calls stay outside the transaction.
    const outcomes = new Map<string, Awaited<ReturnType<Notifier['send']>>>();
    for (const c of due) outcomes.set(c.channelId, await notifier.send(userId, c.channelId, message));

    await sync.transaction(userId, async (ops, tx) => {
      const now = clock.now();
      const row = await lockDelivery(tx, id);
      if (!row) return;
      const channels = row.channels.map((c): ChannelAttempt => {
        const outcome = outcomes.get(c.channelId);
        if (!outcome || c.status !== 'pending') return c;
        const attempts = c.attempts + 1;
        if (outcome.ok) {
          result.sent += 1;
          return { ...c, status: 'sent', attempts, nextAttemptAt: null, lastError: null, finishedAt: now.toISOString() };
        }
        // Every failure is retried 1, 5 and 15 minutes later (spec 用户故事 83), even
        // ones that need the user to fix the channel: fixed in time, the retry succeeds.
        const retryAt = nextRetryAt(attempts, now);
        if (retryAt) {
          result.retrying += 1;
          return { ...c, attempts, nextAttemptAt: retryAt.toISOString(), lastError: outcome.error };
        }
        result.failed += 1;
        log.warn({ deliveryId: id, channelId: c.channelId, error: outcome.error }, '提醒 delivery failed for good');
        return { ...c, status: 'failed', attempts, nextAttemptAt: null, lastError: outcome.error, finishedAt: now.toISOString() };
      });
      const next = earliestPending(channels);
      await ops.update(reminderDeliveries, id, { channels, status: next ? 'delivering' : 'done', nextAttemptAt: next });
      if (next) wake(next);
    });
  }

  function messageFor({ task, countdown }: Subject, now: Date, timeZone: string): ChannelMessage | null {
    if (task) return reminderMessage({ title: task.title, dates: taskDatesToApi(task) }, { now, timeZone });
    if (!countdown) return null;
    const next = nextOccurrence(countdown, todayIn(now, timeZone));
    const lunar = countdown.calendar === 'lunar' ? lunarLabel(next.date) : null;
    return countdownReminderMessage({ name: countdown.name, calendar: countdown.calendar, lunar }, next.date, next.days);
  }

  async function runTick(): Promise<TickResult> {
    const result: TickResult = { fired: 0, sent: 0, failed: 0, retrying: 0, cancelled: 0, missed: 0 };
    for (;;) {
      const now = clock.now();
      const due = await db
        .select({ id: reminderDeliveries.id, userId: reminderDeliveries.userId })
        .from(reminderDeliveries)
        .where(and(inArray(reminderDeliveries.status, [...ACTIVE]), isNull(reminderDeliveries.deletedAt), lte(reminderDeliveries.nextAttemptAt, now)))
        .orderBy(asc(reminderDeliveries.nextAttemptAt), asc(reminderDeliveries.id))
        .limit(100);
      for (const { id, userId } of due) {
        try {
          await deliver(id, userId, result);
        } catch (err) {
          log.error({ err, deliveryId: id }, 'reminder delivery crashed');
        }
      }
      if (due.length < 100) break;
    }
    return result;
  }

  return {
    reconcile,
    reconcileCountdowns,
    tick() {
      const next = running.then(runTick, runTick);
      running = next.catch(() => undefined);
      return next;
    },
    async nextDueAt() {
      const [row] = await db
        .select({ at: min(reminderDeliveries.nextAttemptAt) })
        .from(reminderDeliveries)
        .where(and(inArray(reminderDeliveries.status, [...ACTIVE]), isNull(reminderDeliveries.deletedAt)));
      return row?.at ?? null;
    },
    setWaker(fn) {
      waker = fn;
    },

    async alerts(userId) {
      const now = clock.now();
      const rows = await db
        .select({ delivery: reminderDeliveries, task: tasks })
        .from(reminderDeliveries)
        .innerJoin(tasks, eq(tasks.id, reminderDeliveries.taskId))
        .where(
          and(
            eq(reminderDeliveries.userId, userId),
            isNull(reminderDeliveries.deletedAt),
            isNull(reminderDeliveries.alertDismissedAt),
            inArray(reminderDeliveries.status, ['delivering', 'done']),
            gte(reminderDeliveries.firedAt, new Date(now.getTime() - REMINDER_ALERT_WINDOW_MS)),
            eq(tasks.status, 'open'),
            isNull(tasks.deletedAt),
          ),
        )
        .orderBy(asc(reminderDeliveries.firedAt), asc(reminderDeliveries.id));
      return rows.map(({ delivery, task }) => ({
        id: delivery.id,
        taskId: task.id,
        title: task.title,
        dates: taskDatesToApi(task),
        fireAt: delivery.fireAt.toISOString(),
        firedAt: (delivery.firedAt as Date).toISOString(),
      }));
    },

    async dismissAlert(userId, id) {
      if (!UUID.test(id)) return false;
      return sync.transaction(userId, async (ops, tx) => {
        const [row] = await tx
          .select({ id: reminderDeliveries.id })
          .from(reminderDeliveries)
          .where(and(eq(reminderDeliveries.id, id), eq(reminderDeliveries.userId, userId), isNull(reminderDeliveries.deletedAt), isNotNull(reminderDeliveries.firedAt)));
        if (!row) return false;
        await ops.update(reminderDeliveries, row.id, { alertDismissedAt: clock.now() });
        return true;
      });
    },

    async snooze(userId, id, minutes) {
      if (!UUID.test(id)) return 'not_found';
      return sync.transaction(userId, async (ops, tx) => {
        // Locked, so concurrent 稍后提醒 of one alert (two tabs, double click) schedule it once.
        const [row] = await tx
          .select()
          .from(reminderDeliveries)
          .where(and(eq(reminderDeliveries.id, id), eq(reminderDeliveries.userId, userId), isNull(reminderDeliveries.deletedAt), isNotNull(reminderDeliveries.firedAt)))
          .for('update');
        if (!row) return 'not_found' as const;
        if (row.alertDismissedAt) return 'dismissed' as const;
        const now = clock.now();
        const fireAt = new Date(now.getTime() + minutes * 60_000);
        await ops.update(reminderDeliveries, row.id, { alertDismissedAt: now });
        await ops.insert(reminderDeliveries, {
          taskId: row.taskId,
          countdownId: row.countdownId,
          source: 'snooze',
          reminderKey: null,
          fireAt,
          status: 'scheduled',
          nextAttemptAt: fireAt,
          channels: [],
          firedAt: null,
          alertDismissedAt: null,
        });
        wake(fireAt);
        return { fireAt };
      });
    },

    async failures(userId) {
      const rows = await db
        .select({ delivery: reminderDeliveries, taskTitle: tasks.title, countdownName: countdowns.name })
        .from(reminderDeliveries)
        .leftJoin(tasks, eq(tasks.id, reminderDeliveries.taskId))
        .leftJoin(countdowns, eq(countdowns.id, reminderDeliveries.countdownId))
        .where(
          and(
            eq(reminderDeliveries.userId, userId),
            isNull(reminderDeliveries.deletedAt),
            sql`${reminderDeliveries.channels} @> '[{"status":"failed"}]'::jsonb`,
          ),
        )
        .orderBy(desc(reminderDeliveries.fireAt), asc(reminderDeliveries.id))
        .limit(50);
      return rows.flatMap(({ delivery, taskTitle, countdownName }) =>
        delivery.channels
          .filter((c) => c.status === 'failed')
          .map((c) => ({
            id: delivery.id,
            taskId: delivery.taskId,
            countdownId: delivery.countdownId,
            taskTitle: taskTitle ?? countdownName ?? '',
            channelId: c.channelId,
            channelName: c.channelName,
            fireAt: delivery.fireAt.toISOString(),
            failedAt: c.finishedAt ?? delivery.updatedAt.toISOString(),
            attempts: c.attempts,
            error: c.lastError ?? '发送失败',
          })),
      );
    },
  };
}
