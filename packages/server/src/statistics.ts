import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  achievementScore,
  focusPomodoroCount,
  habitWeek,
  statBucket,
  statPeriods,
  STAT_UNITS,
  taskOverdueDay,
  todayIn,
  zonedDateTime,
  type AchievementTaskInput,
  type StatFocusInput,
  type StatHabitInput,
  type Statistics,
  type StatTaskInput,
} from '@dida/shared';
import type { Executor } from './db/client.js';
import { focusSessions } from './db/schema/focus.js';
import { habitCheckins, habits } from './db/schema/habits.js';
import { lists, tasks } from './db/schema/tasks.js';
import { users } from './db/schema/users.js';
import { readSettings } from './settings.js';

/*
 * 统计 and 成就分 (spec 用户故事 102、103). Everything is recomputed from the
 * user's 任务, 专注 and 打卡 on each request (the 成就分 is never stored);
 * the rules are the pure functions in @dida/shared (statistics.ts,
 * achievement.ts). Days are calendar days in the user's current time zone.
 */

type TaskRow = typeof tasks.$inferSelect;
type TaskDayColumns = Pick<TaskRow, 'allDay' | 'dueDate' | 'dueAt' | 'status' | 'completedAt' | 'abandonedAt' | 'deletedAt' | 'overdueOn'>;

const dayOf = (instant: Date | null, timeZone: string) => (instant ? zonedDateTime(instant, timeZone).date : null);

function dueDayOf(row: Pick<TaskRow, 'allDay' | 'dueDate' | 'dueAt'>, timeZone: string): string | null {
  if (row.allDay === null) return null;
  return row.allDay ? row.dueDate : dayOf(row.dueAt, timeZone);
}

function achievementTask(row: TaskDayColumns, timeZone: string): AchievementTaskInput {
  const completedDay = row.status === 'completed' ? dayOf(row.completedAt, timeZone) : null;
  return {
    dueDay: dueDayOf(row, timeZone),
    overdueDay: row.overdueOn,
    completedDay,
    // 放弃 or 删除 (a completed 任务 that is deleted keeps its completion).
    closedDay: completedDay ? null : (dayOf(row.abandonedAt, timeZone) ?? dayOf(row.deletedAt, timeZone)),
  };
}

/**
 * `{ overdueOn }` to write before a change that loses what made the 任务
 * overdue (new or cleared dates, 彻底删除), so its −2 stays; `{}` when there
 * is nothing to remember.
 */
export function rememberOverdue(row: TaskDayColumns, timeZone: string, now: Date): { overdueOn?: string } {
  if (row.overdueOn) return {};
  const day = taskOverdueDay(achievementTask(row, timeZone), todayIn(now, timeZone));
  return day ? { overdueOn: day } : {};
}

export async function statistics(db: Executor, userId: string, now: Date, date?: string): Promise<Statistics> {
  const { timeZone } = await readSettings(db, userId);
  const today = todayIn(now, timeZone);
  const [taskRows, focusRows, habitRows, listRows, [user]] = await Promise.all([
    db
      .select({
        allDay: tasks.allDay,
        dueDate: tasks.dueDate,
        dueAt: tasks.dueAt,
        status: tasks.status,
        completedAt: tasks.completedAt,
        abandonedAt: tasks.abandonedAt,
        deletedAt: tasks.deletedAt,
        overdueOn: tasks.overdueOn,
      })
      .from(tasks)
      .where(eq(tasks.userId, userId)),
    db
      .select({ mode: focusSessions.mode, startedAt: focusSessions.startedAt, focusMs: focusSessions.accumulatedMs })
      .from(focusSessions)
      .where(
        and(eq(focusSessions.userId, userId), eq(focusSessions.phase, 'focus'), eq(focusSessions.status, 'completed'), isNull(focusSessions.deletedAt)),
      ),
    db
      .select()
      .from(habits)
      .where(and(eq(habits.userId, userId), isNull(habits.deletedAt), isNull(habits.archivedAt))),
    db
      .select({ id: lists.id })
      .from(lists)
      .where(and(eq(lists.userId, userId), isNull(lists.deletedAt))),
    db.select({ createdAt: users.createdAt }).from(users).where(eq(users.id, userId)),
  ]);

  // Deleted 任务 (回收站) count for the 成就分 only; 放弃 never counts as 完成.
  const live = taskRows.filter((r) => r.deletedAt === null);
  const statTasks: StatTaskInput[] = live.map((r) => ({
    status: r.status,
    dueDay: dueDayOf(r, timeZone),
    completedDay: r.status === 'completed' ? dayOf(r.completedAt, timeZone) : null,
  }));
  const focus: StatFocusInput[] = focusRows.map((r) => ({ day: dayOf(r.startedAt, timeZone)!, pomodoro: r.mode === 'pomodoro', focusMs: r.focusMs }));
  const habitIds = habitRows.map((h) => h.id);
  const checkins =
    habitIds.length === 0
      ? []
      : await db
          .select({ habitId: habitCheckins.habitId, date: habitCheckins.date, count: habitCheckins.count })
          .from(habitCheckins)
          .where(and(eq(habitCheckins.userId, userId), inArray(habitCheckins.habitId, habitIds), isNull(habitCheckins.deletedAt)));
  const habitInputs: StatHabitInput[] = habitRows.map((h) => ({
    rule: { frequency: h.frequency, goal: h.goal, startDate: h.startDate },
    checkins: checkins.filter((c) => c.habitId === h.id).map((c) => ({ date: c.date, count: c.count })),
  }));

  const pomodorosByDay = new Map<string, number>();
  for (const r of focusRows) {
    const day = dayOf(r.startedAt, timeZone)!;
    pomodorosByDay.set(day, (pomodorosByDay.get(day) ?? 0) + focusPomodoroCount(r));
  }
  const achievement = achievementScore(
    taskRows.map((r) => achievementTask(r, timeZone)),
    [...pomodorosByDay].map(([day, pomodoros]) => ({ day, pomodoros })),
    today,
  );

  const data = { tasks: statTasks, focus, habits: habitInputs, today };
  const all = statBucket({ from: '0000-01-01', to: '9999-12-31' }, data);
  const todays = statBucket({ from: today, to: today }, data);
  const trends = Object.fromEntries(
    STAT_UNITS.map((unit) => [unit, statPeriods(unit, date ?? today).map((p) => statBucket(p, data))]),
  ) as Statistics['trends'];
  const firstDay = user ? zonedDateTime(user.createdAt, timeZone).date : today;

  return {
    today,
    summary: {
      tasks: live.length,
      completed: all.completed,
      lists: listRows.length,
      days: Math.max(1, Math.round((Date.parse(today) - Date.parse(firstDay)) / 86_400_000) + 1),
    },
    overview: {
      todayCompleted: todays.completed,
      todayPomodoros: todays.pomodoros,
      todayFocusMs: todays.focusMs,
      totalCompleted: all.completed,
      totalPomodoros: all.pomodoros,
      totalFocusMs: all.focusMs,
    },
    achievement,
    trends,
    habitWeek: habitWeek(habitInputs, today),
  };
}
