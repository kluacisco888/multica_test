import { z } from 'zod';
import { civilDateSchema } from './civil-date.js';
import { colorSchema } from './lists.js';
import { timeOfDaySchema } from './reminders.js';
import { addDays, daysBetween, weekday } from './task-dates.js';

/*
 * 习惯 and 打卡 (spec 用户故事 93–98). A 习惯 is done again and again on a
 * frequency (每天 / 每周固定几天 / 每周 N 次) towards a goal (完成一次, or a
 * 数量型 target such as 喝水 8 杯). An 打卡 records one day; earlier days can
 * be checked in later (补打卡) and a day can be undone (撤销). 习惯 are not
 * 任务 and never show up in 清单.
 *
 * This module holds the pure rules: when a habit is due, 连续打卡, 完成率 and
 * the month grid. Dates are calendar dates (`YYYY-MM-DD`) in the user's time
 * zone; weeks start on 周一.
 */

export const HABIT_NAME_MAX_LENGTH = 64;
export const HABIT_MAX_REMINDERS = 10;
export const HABIT_COUNT_MAX = 99_999;

export const habitFrequencySchema = z.discriminatedUnion('type', [
  /** 每天 */
  z.object({ type: z.literal('daily') }).strict(),
  /** 每周固定的某几天; 0 = 周日 … 6 = 周六. */
  z
    .object({
      type: z.literal('weekdays'),
      days: z
        .array(z.number().int().min(0).max(6))
        .min(1, '至少选择一天')
        .transform((days) => [...new Set(days)].sort((a, b) => a - b)),
    })
    .strict(),
  /** 每周 N 次 (N = 7 is 每天). */
  z.object({ type: z.literal('weekly'), times: z.number().int().min(1).max(6) }).strict(),
]);
export type HabitFrequency = z.infer<typeof habitFrequencySchema>;

export const habitGoalSchema = z.discriminatedUnion('type', [
  /** 当天完成打卡 */
  z.object({ type: z.literal('once') }).strict(),
  /** 当天完成一定量, e.g. 8 杯. */
  z
    .object({
      type: z.literal('count'),
      target: z.number().int().min(1).max(HABIT_COUNT_MAX),
      unit: z.string().trim().min(1).max(8),
    })
    .strict(),
]);
export type HabitGoal = z.infer<typeof habitGoalSchema>;

/** 提醒 times of day (`HH:mm`), distinct, earliest first. */
export const habitRemindersSchema = z
  .array(timeOfDaySchema)
  .max(HABIT_MAX_REMINDERS, `最多 ${HABIT_MAX_REMINDERS} 个提醒`)
  .transform((times) => [...new Set(times)].sort());

const habitNameSchema = z.string().trim().min(1, '名称不能为空').max(HABIT_NAME_MAX_LENGTH, `名称最多 ${HABIT_NAME_MAX_LENGTH} 个字符`);

export const habitCheckinSchema = z.object({
  date: civilDateSchema,
  /** 完成一次: 1; 数量型: the amount done that day. */
  count: z.number().int().min(1),
});
export type HabitCheckin = z.infer<typeof habitCheckinSchema>;

export const habitSchema = z.object({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  revision: z.number().int().nonnegative(),
  name: z.string(),
  color: z.string().nullable(),
  frequency: habitFrequencySchema,
  goal: habitGoalSchema,
  reminders: z.array(z.string()),
  /** 通知渠道 for the reminders; null: the user's default channels. */
  reminderChannelIds: z.array(z.uuid()).nullable(),
  /** The day the habit starts (its creation day unless given). */
  startDate: civilDateSchema,
  /** Set while 已归档. */
  archivedAt: z.iso.datetime().nullable(),
  /** Every 打卡 of the habit, oldest first. */
  checkins: z.array(habitCheckinSchema),
});
export type Habit = z.infer<typeof habitSchema>;

/** `GET /api/habits[?archived=true]`: 坚持中 (or 已归档) habits, oldest first. */
export const habitsResponseSchema = z.object({ habits: z.array(habitSchema) });
export type HabitsResponse = z.infer<typeof habitsResponseSchema>;

export const createHabitRequestSchema = z
  .object({
    id: z.uuid().optional(),
    name: habitNameSchema,
    color: colorSchema.nullable().optional(),
    frequency: habitFrequencySchema.default({ type: 'daily' }),
    goal: habitGoalSchema.default({ type: 'once' }),
    reminders: habitRemindersSchema.default([]),
    reminderChannelIds: z.array(z.uuid()).nullable().optional(),
    startDate: civilDateSchema.optional(),
  })
  .strict();
export type CreateHabitRequest = z.input<typeof createHabitRequestSchema>;

export const updateHabitRequestSchema = z
  .object({
    name: habitNameSchema,
    color: colorSchema.nullable(),
    frequency: habitFrequencySchema,
    goal: habitGoalSchema,
    reminders: habitRemindersSchema,
    reminderChannelIds: z.array(z.uuid()).nullable(),
    /** true: 归档; false: back to 坚持中. */
    archived: z.boolean(),
  })
  .partial()
  .strict();
export type UpdateHabitRequest = z.input<typeof updateHabitRequestSchema>;

/** `PUT /api/habits/:id/checkins/:date`: 打卡 (or 补打卡) with that day's amount. */
export const putCheckinRequestSchema = z.object({ count: z.number().int().min(1).max(HABIT_COUNT_MAX) }).strict();
export type PutCheckinRequest = z.infer<typeof putCheckinRequestSchema>;

/* ---- rules ---- */

/** What the rules need from a habit. */
export interface HabitRule {
  frequency: HabitFrequency;
  goal: HabitGoal;
  startDate: string;
}

export interface Streak {
  value: number;
  /** 每周 N 次 counts weeks, the others count days. */
  unit: 'day' | 'week';
}

export interface Completion {
  done: number;
  planned: number;
  /** done / planned, 0 when nothing is planned. */
  rate: number;
}

export function goalTarget(goal: HabitGoal): number {
  return goal.type === 'count' ? goal.target : 1;
}

function countsByDate(checkins: readonly HabitCheckin[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const c of checkins) map.set(c.date, (map.get(c.date) ?? 0) + c.count);
  return map;
}

/** Amount checked in on `date`. */
export function dayCount(checkins: readonly HabitCheckin[], date: string): number {
  return countsByDate(checkins).get(date) ?? 0;
}

/** Whether the day reached the goal. */
export function isDayDone(rule: HabitRule, checkins: readonly HabitCheckin[], date: string): boolean {
  return dayCount(checkins, date) >= goalTarget(rule.goal);
}

/** 周一 of the week `date` is in. */
export function weekStart(date: string): string {
  return addDays(date, -((weekday(date) + 6) % 7));
}

/** The start date, moved back to the earliest 补打卡 before it. */
export function effectiveStart(rule: HabitRule, checkins: readonly HabitCheckin[]): string {
  let start = rule.startDate;
  for (const c of checkins) if (c.count > 0 && c.date < start) start = c.date;
  return start;
}

const isPlannedDay = (rule: HabitRule, date: string) => rule.frequency.type !== 'weekdays' || rule.frequency.days.includes(weekday(date));

/** Done days of the week `date` is in, within [from, to]. */
function doneDaysInWeek(rule: HabitRule, counts: Map<string, number>, week: string, from = week, to = addDays(week, 6), except?: string): number {
  const target = goalTarget(rule.goal);
  let n = 0;
  for (let i = 0; i < 7; i++) {
    const d = addDays(week, i);
    if (d < from || d > to || d === except) continue;
    if ((counts.get(d) ?? 0) >= target) n += 1;
  }
  return n;
}

/**
 * Whether the habit is to be done on `date`: 每天 every day, 固定几天 on
 * those weekdays, 每周 N 次 until the week has N done days (a day already
 * done stays due). Never before the start.
 */
export function habitDueOn(rule: HabitRule, checkins: readonly HabitCheckin[], date: string): boolean {
  if (date < effectiveStart(rule, checkins)) return false;
  const f = rule.frequency;
  if (f.type === 'daily') return true;
  if (f.type === 'weekdays') return f.days.includes(weekday(date));
  return doneDaysInWeek(rule, countsByDate(checkins), weekStart(date), undefined, undefined, date) < f.times;
}

/**
 * 当前连续: 每天 / 固定几天 count the planned days done in a row up to today
 * (today not done yet does not break it; unplanned days are skipped);
 * 每周 N 次 counts the weeks in a row that reached N (the current week once it has).
 */
export function currentStreak(rule: HabitRule, checkins: readonly HabitCheckin[], today: string): Streak {
  const counts = countsByDate(checkins);
  const start = effectiveStart(rule, checkins);
  const target = goalTarget(rule.goal);
  const f = rule.frequency;
  if (f.type === 'weekly') {
    let value = 0;
    for (let week = weekStart(today); addDays(week, 6) >= start; week = addDays(week, -7)) {
      if (doneDaysInWeek(rule, counts, week) >= f.times) value += 1;
      else if (week !== weekStart(today)) break;
    }
    return { value, unit: 'week' };
  }
  let value = 0;
  for (let d = today; d >= start; d = addDays(d, -1)) {
    if (!isPlannedDay(rule, d)) continue;
    if ((counts.get(d) ?? 0) >= target) value += 1;
    else if (d !== today) break;
  }
  return { value, unit: 'day' };
}

/** 最高连续: the longest run (same units as `currentStreak`). */
export function bestStreak(rule: HabitRule, checkins: readonly HabitCheckin[], today: string): Streak {
  const counts = countsByDate(checkins);
  const start = effectiveStart(rule, checkins);
  const target = goalTarget(rule.goal);
  const f = rule.frequency;
  let best = 0;
  let run = 0;
  if (f.type === 'weekly') {
    for (let week = weekStart(start); week <= today; week = addDays(week, 7)) {
      if (doneDaysInWeek(rule, counts, week) >= f.times) best = Math.max(best, (run += 1));
      else if (week !== weekStart(today)) run = 0;
    }
    return { value: best, unit: 'week' };
  }
  for (let d = start; d <= today; d = addDays(d, 1)) {
    if (!isPlannedDay(rule, d)) continue;
    if ((counts.get(d) ?? 0) >= target) best = Math.max(best, (run += 1));
    else if (d !== today) run = 0;
  }
  return { value: best, unit: 'day' };
}

/**
 * 完成率 over [from, to], cut to the habit's start and today. Today is planned
 * only once it is done, so the rate does not drop in the morning.
 *
 * - 每天 / 固定几天: done planned days / planned days.
 * - 每周 N 次: per week, min(done, N) / N; a week cut by the period (or by
 *   today) plans at most as many times as it has days so far.
 */
export function completionRate(rule: HabitRule, checkins: readonly HabitCheckin[], from: string, to: string, today: string): Completion {
  const counts = countsByDate(checkins);
  const target = goalTarget(rule.goal);
  const start = [from, effectiveStart(rule, checkins)].sort()[1] as string;
  const end = [to, today].sort()[0] as string;
  let done = 0;
  let planned = 0;
  const f = rule.frequency;
  if (start <= end) {
    if (f.type === 'weekly') {
      for (let week = weekStart(start); week <= end; week = addDays(week, 7)) {
        let days = 0;
        let doneDays = 0;
        for (let i = 0; i < 7; i++) {
          const d = addDays(week, i);
          if (d < start || d > end) continue;
          const isDone = (counts.get(d) ?? 0) >= target;
          if (isDone) doneDays += 1;
          if (isDone || d !== today) days += 1;
        }
        done += Math.min(doneDays, f.times);
        planned += Math.min(days, f.times);
      }
    } else {
      for (let d = start; d <= end; d = addDays(d, 1)) {
        if (!isPlannedDay(rule, d)) continue;
        const isDone = (counts.get(d) ?? 0) >= target;
        if (isDone) done += 1;
        if (isDone || d !== today) planned += 1;
      }
    }
  }
  return { done, planned, rate: planned === 0 ? 0 : done / planned };
}

export interface HabitStats {
  currentStreak: Streak;
  bestStreak: Streak;
  /** Days that reached the goal (总打卡 / 总达成目标). */
  totalDays: number;
  /** 完成率 of `month` (`YYYY-MM`). */
  month: Completion;
  /** 完成率 since the start. */
  overall: Completion;
}

export function lastDayOfMonth(month: string): string {
  return addDays(`${nextMonth(month)}-01`, -1);
}

export function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

export function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

export function habitStats(rule: HabitRule, checkins: readonly HabitCheckin[], today: string, month: string): HabitStats {
  const target = goalTarget(rule.goal);
  const counts = countsByDate(checkins);
  return {
    currentStreak: currentStreak(rule, checkins, today),
    bestStreak: bestStreak(rule, checkins, today),
    totalDays: [...counts.values()].filter((n) => n >= target).length,
    month: completionRate(rule, checkins, `${month}-01`, lastDayOfMonth(month), today),
    overall: completionRate(rule, checkins, effectiveStart(rule, checkins), today, today),
  };
}

/** Days shown in the 月度日历 of `month`: whole weeks, 周一 first. */
export function monthGrid(month: string): string[] {
  const first = weekStart(`${month}-01`);
  const last = addDays(weekStart(lastDayOfMonth(month)), 6);
  return Array.from({ length: daysBetween(first, last) + 1 }, (_, i) => addDays(first, i));
}

/* ---- labels ---- */

const WEEKDAY_SHORT = ['日', '一', '二', '三', '四', '五', '六'];

/** 每天 / 每周一、三、五 / 每周 3 天. */
export function describeFrequency(f: HabitFrequency): string {
  if (f.type === 'daily') return '每天';
  if (f.type === 'weekdays') return f.days.length === 7 ? '每天' : `每周${[...f.days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => WEEKDAY_SHORT[d]).join('、')}`;
  return `每周 ${f.times} 天`;
}

export function describeGoal(g: HabitGoal): string {
  return g.type === 'once' ? '当天完成打卡' : `每天 ${g.target} ${g.unit}`;
}

/** The message a 通知渠道 receives for a habit reminder. */
export function habitReminderMessage(habit: { name: string; goal: HabitGoal; frequency: HabitFrequency }) {
  return {
    title: `习惯打卡：${habit.name}`,
    body: `${describeFrequency(habit.frequency)}，${describeGoal(habit.goal)}\n来自勾勾清单`,
  };
}
