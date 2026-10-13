import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, min, sql } from 'drizzle-orm';
import {
  nextRetryAt,
  reminderMessage,
  reminderSchedule,
  REMINDER_ALERT_WINDOW_MS,
  withinCatchUp,
  type ChannelMessage,
  type ReminderAlert,
  type ReminderFailure,
} from '@dida/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Clock } from '../clock.js';
import type { Db, Executor, Tx } from '../db/client.js';
import { reminderDeliveries, type ChannelAttempt } from '../db/schema/reminders.js';
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
  snooze(userId: string, id: string, minutes: number): Promise<{ fireAt: Date } | null>;
  /** Deliveries that failed after their retries, newest first (用户故事 83). */
  failures(userId: string): Promise<ReminderFailure[]>;
}

const ACTIVE = ['scheduled', 'delivering'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MISSED_ERROR = '服务停机超过 24 小时，未能发送';

const isLive = (task: TaskRow | undefined): boolean => task !== undefined && task.deletedAt === null && task.status === 'open';

/** The task's reminders with their fire instants under the user's settings. */
function desiredSchedule(task: TaskRow, settings: { timeZone: string; allDayReminderTime: string }) {
  return reminderSchedule(task.reminders, taskDatesToApi(task), { timeZone: settings.timeZone, allDayTime: settings.allDayReminderTime });
}

function stillMatches(row: DeliveryRow, task: TaskRow | undefined, settings: { timeZone: string; allDayReminderTime: string }): boolean {
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
        if (stillMatches(row, task, settings)) {
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

  // Every task write, from any route, reconciles that task's reminders.
  sync.onWrite(tasks, ({ ops, tx, userId, ids }) => reconcile(ops, tx, userId, ids));
  // 全天提醒时间 and the time zone move the reminders of 全天 tasks.
  sync.onWrite(userSettings, async ({ ops, tx, userId }) => {
    const withReminders = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.userId, userId), eq(tasks.status, 'open'), isNull(tasks.deletedAt), sql`jsonb_array_length(${tasks.reminders}) > 0`));
    await reconcile(ops, tx, userId, withReminders.map((t) => t.id));
  });

  async function lockDelivery(tx: Tx, id: string): Promise<DeliveryRow | undefined> {
    const [row] = await tx.select().from(reminderDeliveries).where(eq(reminderDeliveries.id, id)).for('update');
    return row;
  }

  async function taskOf(db: Executor, row: DeliveryRow): Promise<TaskRow | undefined> {
    const [task] = await db.select().from(tasks).where(eq(tasks.id, row.taskId));
    return task;
  }

  /** Fire / re-check one due row; returns what to send, or null. */
  async function prepare(id: string, userId: string, result: TickResult) {
    return sync.transaction(userId, async (ops, tx) => {
      const now = clock.now();
      const row = await lockDelivery(tx, id);
      if (!row || !ACTIVE.includes(row.status as (typeof ACTIVE)[number]) || !row.nextAttemptAt || row.nextAttemptAt > now) return null;
      const task = await taskOf(tx, row);
      const settings = await readSettings(tx, userId);

      if (row.status === 'scheduled') {
        if (!stillMatches(row, task, settings)) {
          await ops.update(reminderDeliveries, row.id, { status: 'cancelled', nextAttemptAt: null });
          result.cancelled += 1;
          return null;
        }
        if (!withinCatchUp(row.fireAt, now)) {
          await ops.update(reminderDeliveries, row.id, { status: 'missed', nextAttemptAt: null });
          result.missed += 1;
          return null;
        }
        const wanted = task?.reminderChannelIds ?? null;
        const channels = (await liveChannels(tx, userId)).filter((c) => (wanted ? wanted.includes(c.id) : c.isDefault));
        const attempts: ChannelAttempt[] = channels.map((c) => ({
          channelId: c.id,
          channelName: c.name,
          status: 'pending',
          attempts: 0,
          nextAttemptAt: now.toISOString(),
          lastError: null,
          finishedAt: null,
        }));
        const fired = await ops.update(reminderDeliveries, row.id, {
          status: attempts.length > 0 ? 'delivering' : 'done',
          firedAt: now,
          channels: attempts,
          nextAttemptAt: attempts.length > 0 ? now : null,
        });
        result.fired += 1;
        if (!fired || attempts.length === 0) return null;
        return { row: fired, task: task as TaskRow, settings };
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
      if (!task) return null;
      return { row, task, settings };
    });
  }

  async function deliver(id: string, userId: string, result: TickResult) {
    const plan = await prepare(id, userId, result);
    if (!plan) return;
    const sendAt = clock.now();
    const due = plan.row.channels.filter((c) => c.status === 'pending' && c.nextAttemptAt && Date.parse(c.nextAttemptAt) <= sendAt.getTime());
    const message: ChannelMessage = reminderMessage(
      { title: plan.task.title, dates: taskDatesToApi(plan.task) },
      { now: sendAt, timeZone: plan.settings.timeZone },
    );
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
        const retryAt = outcome.retryable ? nextRetryAt(attempts, now) : null;
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
      if (!UUID.test(id)) return null;
      return sync.transaction(userId, async (ops, tx) => {
        const [row] = await tx
          .select()
          .from(reminderDeliveries)
          .where(and(eq(reminderDeliveries.id, id), eq(reminderDeliveries.userId, userId), isNull(reminderDeliveries.deletedAt), isNotNull(reminderDeliveries.firedAt)));
        if (!row) return null;
        const now = clock.now();
        const fireAt = new Date(now.getTime() + minutes * 60_000);
        await ops.update(reminderDeliveries, row.id, { alertDismissedAt: now });
        await ops.insert(reminderDeliveries, {
          taskId: row.taskId,
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
        .select({ delivery: reminderDeliveries, title: tasks.title })
        .from(reminderDeliveries)
        .innerJoin(tasks, eq(tasks.id, reminderDeliveries.taskId))
        .where(
          and(
            eq(reminderDeliveries.userId, userId),
            isNull(reminderDeliveries.deletedAt),
            sql`${reminderDeliveries.channels} @> '[{"status":"failed"}]'::jsonb`,
          ),
        )
        .orderBy(desc(reminderDeliveries.fireAt), asc(reminderDeliveries.id))
        .limit(50);
      return rows.flatMap(({ delivery, title }) =>
        delivery.channels
          .filter((c) => c.status === 'failed')
          .map((c) => ({
            id: delivery.id,
            taskId: delivery.taskId,
            taskTitle: title,
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
