import { z } from 'zod';
import { achievementSchema } from './achievement.js';
import { focusPeriod, stepFocusPeriod, type FocusStatUnit } from './focus.js';
import { completionRate, habitDueOn, isDayDone, type HabitCheckin, type HabitRule } from './habits.js';
import { addDays, calendarDateSchema, weekday } from './task-dates.js';

/*
 * 统计 (spec 用户故事 102、103): 完成数, 完成率, 专注 and 习惯 per day, week
 * (周一 first, like the 专注统计) or month, for the last 7 periods.
 *
 * - 完成数: 任务 completed in the period. 放弃 is not 完成, and deleted 任务
 *   (回收站) are left out.
 * - 完成率: of the 任务 whose 截止日 is in the period (not 放弃, not deleted),
 *   the share completed.
 * - 专注: 番茄 (番茄钟 only, as on the 专注 page) and 专注时长, on the day each started.
 * - 习惯: 打卡完成率 of the habits (坚持中) over the period, as on the habit page.
 */

export const STAT_TREND_LENGTH = 7;
export const STAT_UNITS = ['day', 'week', 'month'] as const satisfies readonly FocusStatUnit[];

/** One 任务 as the statistics see it. Deleted 任务 are not passed in. */
export interface StatTaskInput {
  status: 'open' | 'completed' | 'abandoned';
  dueDay: string | null;
  completedDay: string | null;
}

export interface StatFocusInput {
  day: string;
  pomodoro: boolean;
  focusMs: number;
}

export interface StatHabitInput {
  rule: HabitRule;
  checkins: readonly HabitCheckin[];
}

const ratioSchema = z.object({ done: z.number().int(), planned: z.number().int() });

export const statBucketSchema = z.object({
  from: calendarDateSchema,
  to: calendarDateSchema,
  completed: z.number().int(),
  /** 完成率: `done` of the `planned` 任务 due in the period. */
  completion: ratioSchema,
  pomodoros: z.number().int(),
  focusMs: z.number().int(),
  /** 习惯 打卡: planned / done days (每周 N 次 counts times). */
  habits: ratioSchema,
});
export type StatBucket = z.infer<typeof statBucketSchema>;

export const statisticsSchema = z.object({
  today: calendarDateSchema,
  /** The bar at the top: 任务, 已完成, 清单, 使用天数. */
  summary: z.object({ tasks: z.number().int(), completed: z.number().int(), lists: z.number().int(), days: z.number().int() }),
  overview: z.object({
    todayCompleted: z.number().int(),
    todayPomodoros: z.number().int(),
    todayFocusMs: z.number().int(),
    totalCompleted: z.number().int(),
    totalPomodoros: z.number().int(),
    totalFocusMs: z.number().int(),
  }),
  achievement: achievementSchema,
  /** The last 7 days / weeks / months up to the one containing `date`, oldest first. */
  trends: z.object({ day: z.array(statBucketSchema), week: z.array(statBucketSchema), month: z.array(statBucketSchema) }),
  /** 本周打卡进展: 周日 … 周六 of this week, habits done / due each day. */
  habitWeek: z.array(z.object({ date: calendarDateSchema, done: z.number().int(), due: z.number().int() })),
});
export type Statistics = z.infer<typeof statisticsSchema>;

export const statisticsQuerySchema = z.object({ date: calendarDateSchema.optional() }).strict();

const inRange = (day: string | null, from: string, to: string) => day !== null && day >= from && day <= to;

/** The 7 periods of `unit` ending with the one containing `date`. */
export function statPeriods(unit: FocusStatUnit, date: string): { from: string; to: string }[] {
  const periods = [];
  let d = date;
  for (let i = 0; i < STAT_TREND_LENGTH; i++) {
    periods.unshift(focusPeriod(unit, d));
    d = stepFocusPeriod(unit, d, -1);
  }
  return periods;
}

export function statBucket(
  { from, to }: { from: string; to: string },
  data: { tasks: readonly StatTaskInput[]; focus: readonly StatFocusInput[]; habits: readonly StatHabitInput[]; today: string },
): StatBucket {
  let completed = 0;
  const completion = { done: 0, planned: 0 };
  for (const t of data.tasks) {
    const isDone = t.status === 'completed';
    if (isDone && inRange(t.completedDay, from, to)) completed += 1;
    if (t.status !== 'abandoned' && inRange(t.dueDay, from, to)) {
      completion.planned += 1;
      if (isDone) completion.done += 1;
    }
  }
  let pomodoros = 0;
  let focusMs = 0;
  for (const f of data.focus) {
    if (!inRange(f.day, from, to)) continue;
    if (f.pomodoro) pomodoros += 1;
    focusMs += f.focusMs;
  }
  const habits = { done: 0, planned: 0 };
  for (const h of data.habits) {
    const rate = completionRate(h.rule, h.checkins, from, to, data.today);
    habits.done += rate.done;
    habits.planned += rate.planned;
  }
  return { from, to, completed, completion, pomodoros, focusMs, habits };
}

/** 本周打卡进展: the week (周日 first, as in the reference) containing `today`. */
export function habitWeek(habits: readonly StatHabitInput[], today: string): Statistics['habitWeek'] {
  const sunday = addDays(today, -weekday(today));
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(sunday, i);
    let done = 0;
    let due = 0;
    for (const h of habits) {
      if (!habitDueOn(h.rule, h.checkins, date)) continue;
      due += 1;
      if (isDayDone(h.rule, h.checkins, date)) done += 1;
    }
    return { date, done, due };
  });
}

/** Chart label of a bucket: `9日` / `今天`, `10/5` (week start), `10月`. */
export function statBucketLabel(unit: FocusStatUnit, bucket: { from: string; to: string }, today: string): string {
  const [, m, d] = bucket.from.split('-').map(Number) as [number, number, number];
  if (unit === 'day') return bucket.from === today ? '今天' : `${d}日`;
  if (unit === 'week') return bucket.from <= today && today <= bucket.to ? '本周' : `${m}/${d}`;
  return bucket.from <= today && today <= bucket.to ? '本月' : `${m}月`;
}
