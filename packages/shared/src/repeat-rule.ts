import { z } from 'zod';
import { civilDateSchema, daysInMonth, parseCivilDate } from './civil-date.js';
import { addDays, daysBetween, weekday, zonedDateTime, zonedToInstant, type TaskDates, type TaskDatesInput } from './task-dates.js';
import type { WorkdayCalendar } from './workday-calendar.js';

/*
 * 重复规则引擎 (spec 用户故事 41–50). Pure: no clock, no database. The caller
 * passes "today", the due date of the instance being completed, the day it
 * was completed and a 工作日日历 (holiday data injected, see ADR-0006).
 *
 * Rules:
 *   - daily / weekly (some weekdays) / monthly / yearly, every N units;
 *   - every 工作日, every 休息日, the first or last 工作日 of each month;
 *   - 跳过法定节假日: rule dates that are 法定假日 are skipped (not moved);
 *   - basis `due` (按截止日期) or `completion` (按完成日期);
 *   - ends never, after a date (inclusive), or after N instances.
 *
 * Next instance (spec Q27): the first rule date that is not before today and
 * after the original due date. Missed dates in between are not generated.
 */

export const REPEAT_FREQUENCIES = [
  'daily',
  'weekly',
  'monthly',
  'yearly',
  'workday',
  'restday',
  'month_first_workday',
  'month_last_workday',
] as const;
export type RepeatFrequency = (typeof REPEAT_FREQUENCIES)[number];

/** Frequencies that take an interval ("every N units"). */
const INTERVAL_FREQUENCIES: readonly RepeatFrequency[] = ['daily', 'weekly', 'monthly', 'yearly'];

export const REPEAT_MAX_INTERVAL = 99;
export const REPEAT_MAX_COUNT = 999;

export const repeatEndSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('never') }).strict(),
  /** The last allowed date, inclusive. */
  z.object({ type: z.literal('until'), date: civilDateSchema }).strict(),
  /** Total number of instances in the series, the first one included. */
  z.object({ type: z.literal('count'), count: z.number().int().min(1).max(REPEAT_MAX_COUNT) }).strict(),
]);
export type RepeatEnd = z.infer<typeof repeatEndSchema>;

export const repeatRuleSchema = z
  .object({
    freq: z.enum(REPEAT_FREQUENCIES),
    /** Every N days / weeks / months / years; always 1 for the 工作日 kinds. */
    interval: z.number().int().min(1).max(REPEAT_MAX_INTERVAL).default(1),
    /** weekly only: 0 = Sunday … 6 = Saturday. Empty: the weekday of the anchor date. */
    weekdays: z
      .array(z.number().int().min(0).max(6))
      .max(7)
      .default([])
      .transform((days) => [...new Set(days)].sort((a, b) => a - b)),
    /** monthly / yearly: day of month (clamped to short months). Absent: the anchor's day. */
    monthDay: z.number().int().min(1).max(31).optional(),
    /** yearly: month 1–12. Absent: the anchor's month. */
    month: z.number().int().min(1).max(12).optional(),
    /** 按截止日期 (`due`) or 按完成日期 (`completion`). */
    basis: z.enum(['due', 'completion']).default('due'),
    /** 跳过法定节假日 */
    skipHolidays: z.boolean().default(false),
    end: repeatEndSchema.default({ type: 'never' }),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (!INTERVAL_FREQUENCIES.includes(rule.freq) && rule.interval !== 1) {
      ctx.addIssue({ code: 'custom', path: ['interval'], message: '这种重复规则不能设置间隔' });
    }
    if (rule.freq !== 'weekly' && rule.weekdays.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['weekdays'], message: '只有每周重复可以选择星期' });
    }
    if (rule.monthDay !== undefined && rule.freq !== 'monthly' && rule.freq !== 'yearly') {
      ctx.addIssue({ code: 'custom', path: ['monthDay'], message: '只有每月或每年重复可以选择日期' });
    }
    if (rule.month !== undefined && rule.freq !== 'yearly') {
      ctx.addIssue({ code: 'custom', path: ['month'], message: '只有每年重复可以选择月份' });
    }
  });
export type RepeatRule = z.output<typeof repeatRuleSchema>;
export type RepeatRuleInput = z.input<typeof repeatRuleSchema>;

/**
 * What a generated instance's date was computed from (stored with it), so it
 * can be recomputed when the 工作日日历 changes (节假日数据更新, 用户故事 50).
 */
export interface RepeatBasis {
  prevDue: string;
  completedOn: string;
  today: string;
  /** The computed due day; a different current due day means the user moved it. */
  nextDue: string;
}

export interface NextOccurrenceInput {
  rule: RepeatRule;
  /** Due date (`YYYY-MM-DD`) of the instance being completed. */
  due: string;
  /** The day it was completed on. */
  completedOn: string;
  today: string;
  /** 1-based position of the instance being completed in its series. */
  index: number;
  calendar: WorkdayCalendar;
}

/** Whole months from `from` to `to` (calendar months, ignoring days). */
function monthsBetween(from: string, to: string): number {
  const a = parseCivilDate(from);
  const b = parseCivilDate(to);
  return (b.year - a.year) * 12 + (b.month - a.month);
}

/** Monday of the week containing `date` (weeks start on Monday, as in China). */
function mondayOf(date: string): string {
  return addDays(date, -((weekday(date) + 6) % 7));
}

const mod = (n: number, m: number) => ((n % m) + m) % m;

/** Is `date` a date of `rule`, for a series whose phase is set by `anchor`? */
function isRuleDate(rule: RepeatRule, anchor: string, date: string, calendar: WorkdayCalendar): boolean {
  const day = parseCivilDate(date);
  const base = parseCivilDate(anchor);
  switch (rule.freq) {
    case 'daily':
      return mod(daysBetween(anchor, date), rule.interval) === 0;
    case 'weekly': {
      const days = rule.weekdays.length > 0 ? rule.weekdays : [weekday(anchor)];
      if (!days.includes(weekday(date))) return false;
      return mod(daysBetween(mondayOf(anchor), mondayOf(date)) / 7, rule.interval) === 0;
    }
    case 'monthly': {
      if (mod(monthsBetween(anchor, date), rule.interval) !== 0) return false;
      return day.day === Math.min(rule.monthDay ?? base.day, daysInMonth(day.year, day.month));
    }
    case 'yearly': {
      if (mod(day.year - base.year, rule.interval) !== 0) return false;
      if (day.month !== (rule.month ?? base.month)) return false;
      return day.day === Math.min(rule.monthDay ?? base.day, daysInMonth(day.year, day.month));
    }
    case 'workday':
      return calendar.isWorkday(date);
    case 'restday':
      return calendar.isRestDay(date);
    case 'month_first_workday': {
      if (!calendar.isWorkday(date)) return false;
      for (let d = addDays(date, -1); parseCivilDate(d).month === day.month; d = addDays(d, -1)) {
        if (calendar.isWorkday(d)) return false;
      }
      return true;
    }
    case 'month_last_workday': {
      if (!calendar.isWorkday(date)) return false;
      for (let d = addDays(date, 1); parseCivilDate(d).month === day.month; d = addDays(d, 1)) {
        if (calendar.isWorkday(d)) return false;
      }
      return true;
    }
  }
}

/** How many days to scan before giving up (a rule whose dates are all skipped). */
function horizonDays(rule: RepeatRule): number {
  const unitDays: Partial<Record<RepeatFrequency, number>> = { daily: 1, weekly: 7, monthly: 31, yearly: 366 };
  const unit = unitDays[rule.freq] ?? 31;
  return unit * rule.interval * 3 + 400;
}

/**
 * Date of the next instance, or null when the series has ended (or no rule
 * date exists within a reasonable horizon, e.g. every date is a skipped 法定假日).
 */
export function nextOccurrence({ rule, due, completedOn, today, index, calendar }: NextOccurrenceInput): string | null {
  if (rule.end.type === 'count' && index + 1 > rule.end.count) return null;
  // The series' phase (every N units) counts from the anchor, and the next date comes after it.
  const anchor = rule.basis === 'completion' ? completedOn : due;
  // Never before today: missed dates are not generated.
  let date = addDays(anchor, 1);
  if (date < today) date = today;
  const last = addDays(date, horizonDays(rule));
  for (; date <= last; date = addDays(date, 1)) {
    if (rule.end.type === 'until' && date > rule.end.date) return null;
    if (!isRuleDate(rule, anchor, date, calendar)) continue;
    if (rule.skipHolidays && calendar.isHoliday(date)) continue;
    return date;
  }
  return null;
}

// --- task dates of the next instance ---------------------------------------

/** The due day of a task's dates: the calendar date, or the timed due's date in its own time zone. */
export function dueDayOf(dates: TaskDates): string {
  return dates.allDay ? dates.dueDate : zonedDateTime(dates.dueAt, dates.timeZone).date;
}

/**
 * Dates of the next instance due on `nextDue`: all-day spans keep their
 * length; timed dates keep the wall-clock time in the task's own time zone
 * and the same duration.
 */
export function shiftTaskDates(dates: TaskDates, nextDue: string): TaskDatesInput {
  if (dates.allDay) {
    const span = dates.startDate ? daysBetween(dates.startDate, dates.dueDate) : null;
    return { allDay: true, startDate: span === null ? null : addDays(nextDue, -span), dueDate: nextDue };
  }
  const { time } = zonedDateTime(dates.dueAt, dates.timeZone);
  const dueAt = zonedToInstant(nextDue, time, dates.timeZone);
  const startAt = dates.startAt
    ? new Date(Date.parse(dueAt) - (Date.parse(dates.dueAt) - Date.parse(dates.startAt))).toISOString()
    : null;
  return { allDay: false, startAt, dueAt };
}

// --- labels ------------------------------------------------------------------

const WEEKDAY_SHORT = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

function fullDate(date: string): string {
  const { year, month, day } = parseCivilDate(date);
  return `${year}年${month}月${day}日`;
}

/** Monday-first order, like the weekday chips in the editor. */
const mondayFirst = (days: readonly number[]) => [...days].sort((a, b) => mod(a - 1, 7) - mod(b - 1, 7));

/** The main part of a rule's label, e.g. 每天, 每2周的周一、周五, 每月13日, 每个工作日. */
export function describeRepeatFrequency(rule: RepeatRule, anchor: string): string {
  const base = parseCivilDate(anchor);
  const n = rule.interval;
  switch (rule.freq) {
    case 'daily':
      return n === 1 ? '每天' : `每${n}天`;
    case 'weekly': {
      const days = rule.weekdays.length > 0 ? rule.weekdays : [weekday(anchor)];
      const names = mondayFirst(days).map((d) => WEEKDAY_SHORT[d]).join('、');
      if (n === 1 && days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))) return '每周工作日（周一至周五）';
      return n === 1 ? `每${names}` : `每${n}周的${names}`;
    }
    case 'monthly': {
      const day = `${rule.monthDay ?? base.day}日`;
      return n === 1 ? `每月${day}` : `每${n}个月的${day}`;
    }
    case 'yearly': {
      const day = `${rule.month ?? base.month}月${rule.monthDay ?? base.day}日`;
      return n === 1 ? `每年${day}` : `每${n}年的${day}`;
    }
    case 'workday':
      return '每个工作日';
    case 'restday':
      return '每个休息日';
    case 'month_first_workday':
      return '每月第一个工作日';
    case 'month_last_workday':
      return '每月最后一个工作日';
  }
}

/** Full label: frequency plus 按完成日期 / 跳过法定节假日 / end condition. */
export function describeRepeatRule(rule: RepeatRule, anchor: string): string {
  const parts = [describeRepeatFrequency(rule, anchor)];
  if (rule.basis === 'completion') parts.push('按完成日期');
  if (rule.skipHolidays) parts.push('跳过法定节假日');
  if (rule.end.type === 'until') parts.push(`到${fullDate(rule.end.date)}结束`);
  if (rule.end.type === 'count') parts.push(`重复${rule.end.count}次`);
  return parts.join('，');
}
