import { and, desc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  FOCUS_NOTIFY_GRACE_MS,
  FOCUS_RECORDS_LIMIT,
  focusEndsAt,
  focusElapsedMs,
  focusMessage,
  nextBreakPhase,
  summarizeFocus,
  todayIn,
  withinCatchUp,
  type BreakPhase,
  type CurrentFocusResponse,
  type FocusRecord,
  type FocusSession,
  type FocusStats,
  type FocusStatUnit,
  type PomodoroSettings,
  type StartFocusRequest,
} from '@dida/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Clock } from '../clock.js';
import type { Db, Executor, Tx } from '../db/client.js';
import { focusSessions } from '../db/schema/focus.js';
import { tasks } from '../db/schema/tasks.js';
import type { Notifier } from '../notify/notifier.js';
import { readSettings } from '../settings.js';
import { findOwned, type SyncOps, type SyncWriter } from '../sync/sync.js';

/*
 * 专注 state machine (spec 用户故事 86–92). The timer is server state: every
 * read and every action first "settles" the user's session at the injected
 * clock's now — a 番茄 whose countdown ran out is completed at its end
 * instant and the 短休息 / 长休息 starts right then (and may itself have run
 * out). So a refresh, another device, or a page opened hours later all see
 * the same, correct state.
 *
 * An open page settles its own 番茄 when the countdown hits zero (it reads
 * the current session). `tick()` (pg-boss, see jobs.ts) settles 番茄 nobody
 * settled within FOCUS_NOTIFY_GRACE_MS of their end: the page was closed, so
 * the user hears about it through their default 通知渠道 (EURO-11's notifier).
 */

type Row = typeof focusSessions.$inferSelect;
const MIN = 60_000;

export interface FocusTickResult {
  /** 番茄 completed by the job (page closed). */
  finished: number;
  /** Messages delivered to 通知渠道. */
  notified: number;
  /** Messages a 通知渠道 refused. */
  failed: number;
}

export type FocusAction = 'pause' | 'resume' | 'abandon' | 'finish';

export interface FocusService {
  current(userId: string): Promise<CurrentFocusResponse>;
  start(userId: string, request: StartFocusRequest): Promise<CurrentFocusResponse | 'focus_active' | 'task_not_found' | 'id_taken'>;
  act(userId: string, action: FocusAction): Promise<CurrentFocusResponse | 'none' | 'conflict'>;
  link(userId: string, taskId: string | null): Promise<CurrentFocusResponse | 'none' | 'task_not_found'>;
  records(userId: string): Promise<FocusRecord[]>;
  stats(userId: string, unit: FocusStatUnit, date: string | undefined): Promise<FocusStats>;
  /** Settle 番茄 that ended unnoticed and notify about them. Runs one at a time. */
  tick(): Promise<FocusTickResult>;
  /** Earliest instant a running countdown is due for the job. */
  nextDueAt(): Promise<Date | null>;
  setWaker(waker: ((at: Date) => void) | null): void;
}

const ACTIVE = ['running', 'paused'] as const;

/** Postgres unique_violation on a given index (drizzle wraps the pg error). */
function uniqueViolationOn(error: unknown): string | null {
  const cause = ((error as { cause?: unknown }).cause ?? error) as { code?: string; constraint?: string };
  return cause.code === '23505' ? (cause.constraint ?? '') : null;
}

function breakMinutes(settings: PomodoroSettings, phase: BreakPhase): number {
  return phase === 'longBreak' ? settings.longBreakMinutes : settings.shortBreakMinutes;
}

export function createFocusService(deps: { db: Db; sync: SyncWriter; clock: Clock; notifier: Notifier; log: FastifyBaseLogger }): FocusService {
  const { db, sync, clock, notifier, log } = deps;
  let waker: ((at: Date) => void) | null = null;
  let running: Promise<unknown> = Promise.resolve();

  const wakeFor = (row: Row | null) => {
    const ends = row ? focusEndsAt(row) : null;
    if (!ends) return;
    try {
      waker?.(new Date(ends.getTime() + FOCUS_NOTIFY_GRACE_MS));
    } catch (err) {
      log.warn({ err }, 'could not schedule a focus tick');
    }
  };

  async function titleOf(ex: Executor, taskId: string | null): Promise<string | null> {
    if (!taskId) return null;
    const [task] = await ex.select({ title: tasks.title }).from(tasks).where(eq(tasks.id, taskId));
    return task?.title ?? null;
  }

  async function toApi(ex: Executor, row: Row | null, now: Date): Promise<CurrentFocusResponse> {
    if (!row) return { session: null, now: now.toISOString() };
    const ends = focusEndsAt(row);
    const session: FocusSession = {
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      revision: row.revision,
      mode: row.mode,
      phase: row.phase,
      status: row.status,
      taskId: row.taskId,
      taskTitle: await titleOf(ex, row.taskId),
      plannedMs: row.plannedMs,
      accumulatedMs: row.accumulatedMs,
      resumedAt: row.resumedAt?.toISOString() ?? null,
      startedAt: row.startedAt.toISOString(),
      endedAt: row.endedAt?.toISOString() ?? null,
      endsAt: ends?.toISOString() ?? null,
    };
    return { session, now: now.toISOString() };
  }

  async function lockActive(tx: Tx, userId: string): Promise<Row | null> {
    const [row] = await tx
      .select()
      .from(focusSessions)
      .where(and(eq(focusSessions.userId, userId), inArray(focusSessions.status, [...ACTIVE]), isNull(focusSessions.deletedAt)))
      .for('update');
    return row ?? null;
  }

  /** 番茄 completed since the last 长休息 began, the one just completed included. */
  async function pomodorosSinceLongBreak(tx: Tx, userId: string): Promise<number> {
    const [last] = await tx
      .select({ startedAt: focusSessions.startedAt })
      .from(focusSessions)
      .where(and(eq(focusSessions.userId, userId), eq(focusSessions.phase, 'longBreak'), isNull(focusSessions.deletedAt)))
      .orderBy(desc(focusSessions.startedAt))
      .limit(1);
    const [row] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(focusSessions)
      .where(
        and(
          eq(focusSessions.userId, userId),
          eq(focusSessions.mode, 'pomodoro'),
          eq(focusSessions.phase, 'focus'),
          eq(focusSessions.status, 'completed'),
          isNull(focusSessions.deletedAt),
          ...(last ? [gt(focusSessions.startedAt, last.startedAt)] : []),
        ),
      );
    return row?.count ?? 0;
  }

  /**
   * Bring the user's session up to `now`. Returns the active session (if
   * any) and the 番茄 that were completed on the way, with their break.
   */
  async function settle(ops: SyncOps, tx: Tx, userId: string, now: Date) {
    const finished: { session: Row; breakPhase: BreakPhase }[] = [];
    let settings: PomodoroSettings | null = null;
    for (;;) {
      const row = await lockActive(tx, userId);
      const ends = row ? focusEndsAt(row) : null;
      if (!row || row.status !== 'running' || !ends || ends > now) return { active: row, finished };
      const done = await ops.update(focusSessions, row.id, {
        status: 'completed',
        accumulatedMs: row.plannedMs ?? row.accumulatedMs,
        resumedAt: null,
        endedAt: ends,
      });
      if (!done || row.phase !== 'focus') continue;
      settings ??= (await readSettings(tx, userId)).pomodoro;
      const breakPhase = nextBreakPhase(await pomodorosSinceLongBreak(tx, userId), settings.longBreakEvery);
      const pause = await ops.insert(focusSessions, {
        mode: 'pomodoro',
        phase: breakPhase,
        status: 'running',
        taskId: row.taskId,
        plannedMs: breakMinutes(settings, breakPhase) * MIN,
        accumulatedMs: 0,
        resumedAt: ends,
        startedAt: ends,
        endedAt: null,
      });
      wakeFor(pause);
      finished.push({ session: done, breakPhase });
    }
  }

  /** Settle, then run `fn` on the active session in the same transaction. */
  function withActive<R>(userId: string, fn: (ctx: { ops: SyncOps; tx: Tx; now: Date; active: Row | null }) => Promise<R>) {
    return sync.transaction(userId, async (ops, tx) => {
      const now = clock.now();
      const { active } = await settle(ops, tx, userId, now);
      return fn({ ops, tx, now, active });
    });
  }

  async function finishedFocus(ex: Executor, userId: string) {
    return ex
      .select({ session: focusSessions, title: tasks.title })
      .from(focusSessions)
      .leftJoin(tasks, eq(tasks.id, focusSessions.taskId))
      .where(
        and(
          eq(focusSessions.userId, userId),
          eq(focusSessions.phase, 'focus'),
          eq(focusSessions.status, 'completed'),
          isNull(focusSessions.deletedAt),
          isNotNull(focusSessions.endedAt),
        ),
      )
      .orderBy(desc(focusSessions.startedAt), desc(focusSessions.id));
  }

  async function notify(userId: string, item: { session: Row; breakPhase: BreakPhase }, result: FocusTickResult) {
    const message = focusMessage({
      taskTitle: await titleOf(db, item.session.taskId),
      focusMs: item.session.accumulatedMs,
      breakPhase: item.breakPhase,
    });
    // Network calls stay outside the transaction.
    for (const channelId of await notifier.defaultChannelIds(userId)) {
      const outcome = await notifier.send(userId, channelId, message);
      if (outcome.ok) result.notified += 1;
      else {
        result.failed += 1;
        log.warn({ userId, channelId, error: outcome.error }, '专注结束 notification failed');
      }
    }
  }

  async function runTick(): Promise<FocusTickResult> {
    const result: FocusTickResult = { finished: 0, notified: 0, failed: 0 };
    const now = clock.now();
    const cutoff = new Date(now.getTime() - FOCUS_NOTIFY_GRACE_MS);
    const due = await db
      .selectDistinct({ userId: focusSessions.userId })
      .from(focusSessions)
      .where(
        and(
          eq(focusSessions.status, 'running'),
          isNull(focusSessions.deletedAt),
          isNotNull(focusSessions.plannedMs),
          sql`${focusSessions.resumedAt} + (${focusSessions.plannedMs} - ${focusSessions.accumulatedMs}) * interval '1 millisecond' <= ${cutoff}`,
        ),
      );
    for (const { userId } of due) {
      try {
        const { finished } = await sync.transaction(userId, (ops, tx) => settle(ops, tx, userId, now));
        for (const item of finished) {
          result.finished += 1;
          // After a downtime of more than a day the message is stale; just record the 番茄.
          if (withinCatchUp(item.session.endedAt as Date, now)) await notify(userId, item, result);
        }
      } catch (err) {
        log.error({ err, userId }, 'focus tick crashed');
      }
    }
    return result;
  }

  return {
    async current(userId) {
      return withActive(userId, ({ tx, now, active }) => toApi(tx, active, now));
    },

    async start(userId, request) {
      try {
        return await withActive(userId, async ({ ops, tx, now, active }) => {
          if (active && active.phase === 'focus') return 'focus_active' as const;
          if (request.taskId && !(await findOwned(tx, tasks, userId, request.taskId))) return 'task_not_found' as const;
          // Starting a 番茄 during a break ends the break (结束休息).
          if (active) {
            await ops.update(focusSessions, active.id, { status: 'completed', accumulatedMs: focusElapsedMs(active, now), resumedAt: null, endedAt: now });
          }
          const settings = (await readSettings(tx, userId)).pomodoro;
          const row = await ops.insert(focusSessions, {
            ...(request.id ? { id: request.id } : {}),
            mode: request.mode,
            phase: 'focus',
            status: 'running',
            taskId: request.taskId ?? null,
            plannedMs: request.mode === 'pomodoro' ? settings.focusMinutes * MIN : null,
            accumulatedMs: 0,
            resumedAt: now,
            startedAt: now,
            endedAt: null,
          });
          wakeFor(row);
          return toApi(tx, row, now);
        });
      } catch (error) {
        const constraint = uniqueViolationOn(error);
        if (constraint === 'focus_sessions_one_active_per_user') return 'focus_active';
        if (constraint !== null) return 'id_taken';
        throw error;
      }
    },

    async act(userId, action) {
      return withActive(userId, async ({ ops, tx, now, active }) => {
        if (!active) return 'none' as const;
        let patch: Partial<Row>;
        switch (action) {
          case 'pause':
            if (active.status !== 'running') return 'conflict' as const;
            patch = { status: 'paused', accumulatedMs: focusElapsedMs(active, now), resumedAt: null };
            break;
          case 'resume':
            if (active.status !== 'paused') return 'conflict' as const;
            patch = { status: 'running', resumedAt: now };
            break;
          case 'abandon':
            patch = { status: 'abandoned', accumulatedMs: focusElapsedMs(active, now), resumedAt: null, endedAt: now };
            break;
          case 'finish':
            // A 番茄 runs its full length (or is abandoned); 正计时 and breaks end on request.
            if (active.mode === 'pomodoro' && active.phase === 'focus') return 'conflict' as const;
            patch = { status: 'completed', accumulatedMs: focusElapsedMs(active, now), resumedAt: null, endedAt: now };
            break;
        }
        const row = await ops.update(focusSessions, active.id, patch);
        const stillActive = row && (row.status === 'running' || row.status === 'paused') ? row : null;
        wakeFor(stillActive);
        return toApi(tx, stillActive, now);
      });
    },

    async link(userId, taskId) {
      return withActive(userId, async ({ ops, tx, now, active }) => {
        if (!active) return 'none' as const;
        if (taskId && !(await findOwned(tx, tasks, userId, taskId))) return 'task_not_found' as const;
        return toApi(tx, await ops.update(focusSessions, active.id, { taskId }), now);
      });
    },

    async records(userId) {
      const rows = (await finishedFocus(db, userId)).slice(0, FOCUS_RECORDS_LIMIT);
      return rows.map(({ session, title }) => ({
        id: session.id,
        mode: session.mode,
        taskId: session.taskId,
        taskTitle: session.taskId ? (title ?? null) : null,
        startedAt: session.startedAt.toISOString(),
        endedAt: (session.endedAt as Date).toISOString(),
        focusMs: session.accumulatedMs,
      }));
    },

    async stats(userId, unit, date) {
      // Settle first so a 番茄 that just ran out is counted.
      await sync.transaction(userId, (ops, tx) => settle(ops, tx, userId, clock.now()));
      const now = clock.now();
      const { timeZone } = await readSettings(db, userId);
      const rows = await finishedFocus(db, userId);
      return summarizeFocus(
        rows.map(({ session, title }) => ({
          startedAt: session.startedAt.toISOString(),
          focusMs: session.accumulatedMs,
          pomodoro: session.mode === 'pomodoro',
          taskId: session.taskId,
          taskTitle: title ?? null,
        })),
        { unit, date: date ?? todayIn(now, timeZone), timeZone, now },
      );
    },

    tick() {
      const next = running.then(runTick, runTick);
      running = next.catch(() => undefined);
      return next;
    },

    async nextDueAt() {
      const [row] = await db
        .select({
          at: sql<string | null>`min(${focusSessions.resumedAt} + (${focusSessions.plannedMs} - ${focusSessions.accumulatedMs}) * interval '1 millisecond')`,
        })
        .from(focusSessions)
        .where(and(eq(focusSessions.status, 'running'), isNull(focusSessions.deletedAt), isNotNull(focusSessions.plannedMs)));
      return row?.at ? new Date(new Date(row.at).getTime() + FOCUS_NOTIFY_GRACE_MS) : null;
    },

    setWaker(fn) {
      waker = fn;
    },
  };
}
