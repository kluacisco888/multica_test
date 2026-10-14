import { and, asc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import {
  addDays,
  habitDueOn,
  habitReminderMessage,
  isDayDone,
  nextRetryAt,
  todayIn,
  withinCatchUp,
  zonedToInstant,
  type HabitRule,
} from '@dida/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Clock } from '../clock.js';
import type { Db, Executor, Tx } from '../db/client.js';
import { isUniqueViolation } from '../db/errors.js';
import { habitReminderDeliveries, habits } from '../db/schema/habits.js';
import type { ChannelAttempt } from '../db/schema/reminders.js';
import type { Notifier } from '../notify/notifier.js';
import { liveChannels } from '../notify/notifier.js';
import { liveCheckins } from '../routes/habits.js';
import { readSettings } from '../settings.js';
import type { SyncOps, SyncWriter } from '../sync/sync.js';

/*
 * 习惯提醒 (spec 用户故事 95, ADR-0005). Each reminder time of a 坚持中 习惯
 * fires on every day the habit is due (see `habitDueOn`) and not yet done,
 * at that wall-clock time in the user's time zone. Messages go through the
 * shared notifier to the habit's 通知渠道 (the default ones unless it names
 * some), with the 提醒 retries 1, 5 and 15 minutes after a failure.
 *
 * `tick()` runs in the 提醒 job (jobs.ts, every minute and at startup). It
 * looks at today and yesterday, so after a downtime reminders up to 24 hours
 * old are still sent; a row per (habit, instant) makes each fire once.
 * Reminder times that were already past when the habit was last edited do
 * not fire for that day.
 */

export interface HabitTickResult {
  fired: number;
  sent: number;
  retrying: number;
  failed: number;
}

export interface HabitReminderService {
  tick(): Promise<HabitTickResult>;
  /**
   * Record the reminder times of these habits that are already past (within
   * the catch-up window) as done without sending them, so a 习惯 that just
   * arrived (导入) does not fire for times it was never live at.
   */
  skipPast(ops: SyncOps, tx: Tx, userId: string, habitIds: string[]): Promise<number>;
}

type HabitRow = typeof habits.$inferSelect;

export function createHabitReminderService(deps: { db: Db; sync: SyncWriter; clock: Clock; notifier: Notifier; log: FastifyBaseLogger }): HabitReminderService {
  const { db, sync, clock, notifier, log } = deps;
  let running: Promise<unknown> = Promise.resolve();

  /** Fire instants due now for one habit. */
  async function dueInstants(habit: HabitRow, timeZone: string, now: Date, executor: Executor = db): Promise<Date[]> {
    const checkins = (await liveCheckins(executor, habit.userId, [habit.id])).map((c) => ({ date: c.date, count: c.count }));
    const rule: HabitRule = { frequency: habit.frequency, goal: habit.goal, startDate: habit.startDate };
    const today = todayIn(now, timeZone);
    const out: Date[] = [];
    for (const date of [addDays(today, -1), today]) {
      if (!habitDueOn(rule, checkins, date) || isDayDone(rule, checkins, date)) continue;
      for (const time of habit.reminders) {
        const fireAt = new Date(zonedToInstant(date, time, timeZone));
        if (fireAt > now || fireAt <= habit.updatedAt || !withinCatchUp(fireAt, now)) continue;
        out.push(fireAt);
      }
    }
    return out;
  }

  async function fire(habit: HabitRow, fireAt: Date, result: HabitTickResult) {
    await sync.transaction(habit.userId, async (ops, tx) => {
      const [existing] = await tx
        .select({ id: habitReminderDeliveries.id })
        .from(habitReminderDeliveries)
        .where(and(eq(habitReminderDeliveries.habitId, habit.id), eq(habitReminderDeliveries.fireAt, fireAt)));
      if (existing) return;
      const now = clock.now();
      const wanted = habit.reminderChannelIds;
      const channels = (await liveChannels(tx, habit.userId)).filter((c) => (wanted ? wanted.includes(c.id) : c.isDefault));
      const pending: ChannelAttempt[] = channels.map((c) => ({
        channelId: c.id,
        channelName: c.name,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: now.toISOString(),
        lastError: null,
        finishedAt: null,
      }));
      await ops.insert(habitReminderDeliveries, {
        habitId: habit.id,
        fireAt,
        status: pending.length > 0 ? 'delivering' : 'done',
        nextAttemptAt: pending.length > 0 ? now : null,
        channels: pending,
      });
      result.fired += 1;
    });
  }

  async function deliver(id: string, userId: string, result: HabitTickResult) {
    const [row] = await db.select().from(habitReminderDeliveries).where(eq(habitReminderDeliveries.id, id));
    if (!row) return;
    const [habit] = await db.select().from(habits).where(eq(habits.id, row.habitId));
    const sendAt = clock.now();
    const due = row.channels.filter((c) => c.status === 'pending' && c.nextAttemptAt && Date.parse(c.nextAttemptAt) <= sendAt.getTime());
    // A habit deleted or archived since it fired is not sent any more.
    const live = habit && habit.deletedAt === null && habit.archivedAt === null;
    const outcomes = new Map<string, Awaited<ReturnType<Notifier['send']>>>();
    if (live) {
      const message = habitReminderMessage(habit);
      for (const c of due) outcomes.set(c.channelId, await notifier.send(userId, c.channelId, message));
    }
    await sync.transaction(userId, async (ops) => {
      const now = clock.now();
      const channels = row.channels.map((c): ChannelAttempt => {
        if (c.status !== 'pending') return c;
        const outcome = outcomes.get(c.channelId);
        if (!live) return { ...c, status: 'failed', nextAttemptAt: null, lastError: '习惯已删除或归档', finishedAt: now.toISOString() };
        if (!outcome) return c;
        const attempts = c.attempts + 1;
        if (outcome.ok) {
          result.sent += 1;
          return { ...c, status: 'sent', attempts, nextAttemptAt: null, lastError: null, finishedAt: now.toISOString() };
        }
        const retryAt = nextRetryAt(attempts, now);
        if (retryAt) {
          result.retrying += 1;
          return { ...c, attempts, nextAttemptAt: retryAt.toISOString(), lastError: outcome.error };
        }
        result.failed += 1;
        log.warn({ deliveryId: id, channelId: c.channelId, error: outcome.error }, '习惯提醒 delivery failed for good');
        return { ...c, status: 'failed', attempts, nextAttemptAt: null, lastError: outcome.error, finishedAt: now.toISOString() };
      });
      const times = channels.filter((c) => c.status === 'pending' && c.nextAttemptAt).map((c) => Date.parse(c.nextAttemptAt as string));
      const next = times.length > 0 ? new Date(Math.min(...times)) : null;
      await ops.update(habitReminderDeliveries, id, { channels, status: next ? 'delivering' : 'done', nextAttemptAt: next });
    });
  }

  async function runTick(): Promise<HabitTickResult> {
    const result: HabitTickResult = { fired: 0, sent: 0, retrying: 0, failed: 0 };
    const now = clock.now();
    const withReminders = await db
      .select()
      .from(habits)
      .where(and(isNull(habits.deletedAt), isNull(habits.archivedAt), sql`jsonb_array_length(${habits.reminders}) > 0`))
      .orderBy(asc(habits.userId));
    const zones = new Map<string, string>();
    for (const habit of withReminders) {
      try {
        let tz = zones.get(habit.userId);
        if (!tz) zones.set(habit.userId, (tz = (await readSettings(db, habit.userId)).timeZone));
        for (const at of await dueInstants(habit, tz, now)) await fire(habit, at, result);
      } catch (err) {
        if (!isUniqueViolation(err)) log.error({ err, habitId: habit.id }, 'habit reminder crashed');
      }
    }
    const due = await db
      .select({ id: habitReminderDeliveries.id, userId: habitReminderDeliveries.userId })
      .from(habitReminderDeliveries)
      .where(and(inArray(habitReminderDeliveries.status, ['delivering']), isNull(habitReminderDeliveries.deletedAt), lte(habitReminderDeliveries.nextAttemptAt, now)))
      .orderBy(asc(habitReminderDeliveries.nextAttemptAt));
    for (const { id, userId } of due) {
      try {
        await deliver(id, userId, result);
      } catch (err) {
        log.error({ err, deliveryId: id }, 'habit reminder delivery crashed');
      }
    }
    return result;
  }

  return {
    async skipPast(ops, tx, userId, habitIds) {
      if (habitIds.length === 0) return 0;
      const now = clock.now();
      const { timeZone } = await readSettings(tx, userId);
      let skipped = 0;
      for (const habit of await tx.select().from(habits).where(and(eq(habits.userId, userId), inArray(habits.id, habitIds)))) {
        if (habit.deletedAt || habit.archivedAt || habit.reminders.length === 0) continue;
        for (const fireAt of await dueInstants(habit, timeZone, now, tx)) {
          await ops.insert(habitReminderDeliveries, { habitId: habit.id, fireAt, status: 'done', nextAttemptAt: null, channels: [] });
          skipped += 1;
        }
      }
      return skipped;
    },
    tick() {
      const next = running.then(runTick, runTick);
      running = next.catch(() => undefined);
      return next;
    },
  };
}
