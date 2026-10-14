import { sql } from 'drizzle-orm';
import { bigint, check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { syncColumns, syncIndex } from '../../sync/columns.js';
import { tasks } from './tasks.js';

/**
 * 专注记录 (spec 用户故事 86–92): one 番茄, break or 正计时 session.
 *
 * - `running`: counting since `resumed_at`, on top of `accumulated_ms`.
 * - `paused`: `accumulated_ms` holds the time so far, `resumed_at` is null.
 * - `completed` / `abandoned`: finished at `ended_at`.
 *
 * At most one running or paused session per user (unique index), so two tabs
 * cannot start two timers. See focus/service.ts for the state machine.
 */
export const focusSessions = pgTable(
  'focus_sessions',
  {
    ...syncColumns(),
    mode: text({ enum: ['pomodoro', 'stopwatch'] }).notNull(),
    phase: text({ enum: ['focus', 'shortBreak', 'longBreak'] }).notNull(),
    status: text({ enum: ['running', 'paused', 'completed', 'abandoned'] }).notNull(),
    taskId: uuid().references(() => tasks.id),
    /** Countdown length; null for 正计时. */
    plannedMs: bigint({ mode: 'number' }),
    accumulatedMs: bigint({ mode: 'number' }).notNull().default(0),
    resumedAt: timestamp({ withTimezone: true }),
    startedAt: timestamp({ withTimezone: true }).notNull(),
    endedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    syncIndex('focus_sessions', t),
    uniqueIndex('focus_sessions_one_active_per_user')
      .on(t.userId)
      .where(sql`${t.status} IN ('running', 'paused') AND ${t.deletedAt} IS NULL`),
    index('focus_sessions_user_started_idx').on(t.userId, t.startedAt),
    check('focus_sessions_mode_check', sql`${t.mode} IN ('pomodoro', 'stopwatch')`),
    check('focus_sessions_phase_check', sql`${t.phase} IN ('focus', 'shortBreak', 'longBreak')`),
    check('focus_sessions_status_check', sql`${t.status} IN ('running', 'paused', 'completed', 'abandoned')`),
  ],
);
