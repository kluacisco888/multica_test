import { z } from 'zod';
import {
  addDays,
  calendarDateSchema,
  daysBetween,
  weekday,
  zonedDateTime,
  zonedToInstant,
  type TaskDates,
  type TaskDatesInput,
} from './task-dates.js';

/*
 * 日历视图 (spec 用户故事 69–71). Pure: which days a 月 / 周 / 日 / 多日 view
 * shows, where a task sits on them, how 日期区间 长条 stack, and what a task's
 * dates become when it is dragged to another day or time.
 *
 * Every position is read in the user's *current* time zone, like the task
 * list (task-dates.ts): all-day dates as stored, timed dates converted. A drag
 * keeps the wall-clock time the user sees, so a move across a DST change or of
 * a task set in another zone still lands where it was dropped.
 */

export const CALENDAR_MODES = ['month', 'week', 'day', 'multiDay'] as const;
export const calendarModeSchema = z.enum(CALENDAR_MODES);
export type CalendarMode = z.infer<typeof calendarModeSchema>;

export const CALENDAR_MODE_LABELS: Record<CalendarMode, string> = { month: '月', week: '周', day: '日', multiDay: '多日' };

/** Days shown by 多日. */
export const MULTI_DAY_COUNT = 3;

/** Longest range the calendar endpoints accept (a 6-week month plus slack). */
export const CALENDAR_MAX_DAYS = 62;

/** `from`–`to` inclusive calendar dates, at most `CALENDAR_MAX_DAYS` days. */
export const calendarRangeSchema = z
  .object({ from: calendarDateSchema, to: calendarDateSchema })
  .strict()
  .refine((r) => r.from <= r.to, { message: '开始日期不能晚于结束日期' })
  .refine((r) => r.from > r.to || daysBetween(r.from, r.to) < CALENDAR_MAX_DAYS, { message: `最多 ${CALENDAR_MAX_DAYS} 天` });
export type CalendarRange = z.infer<typeof calendarRangeSchema>;

/** Monday of the week containing `date` (weeks start on Monday, as in China). */
function weekStart(date: string): string {
  return addDays(date, -((weekday(date) + 6) % 7));
}

function firstOfMonth(date: string): string {
  return `${date.slice(0, 8)}01`;
}

function lastOfMonth(date: string): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  return addDays(m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`, -1);
}

function range(from: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addDays(from, i));
}

/** The days a view shows around `anchor`, in order. */
export function calendarDays(mode: CalendarMode, anchor: string): string[] {
  switch (mode) {
    case 'month': {
      const from = weekStart(firstOfMonth(anchor));
      const to = addDays(weekStart(lastOfMonth(anchor)), 6);
      return range(from, daysBetween(from, to) + 1);
    }
    case 'week':
      return range(weekStart(anchor), 7);
    case 'day':
      return [anchor];
    case 'multiDay':
      return range(anchor, MULTI_DAY_COUNT);
  }
}

/** The anchor of the previous (`-1`) or next (`1`) page. A month page is anchored on its 1st. */
export function stepCalendar(mode: CalendarMode, anchor: string, direction: 1 | -1): string {
  switch (mode) {
    case 'month': {
      const [y, m] = anchor.split('-').map(Number) as [number, number];
      const index = y * 12 + (m - 1) + direction;
      return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}-01`;
    }
    case 'week':
      return addDays(anchor, 7 * direction);
    case 'day':
      return addDays(anchor, direction);
    case 'multiDay':
      return addDays(anchor, MULTI_DAY_COUNT * direction);
  }
}

/** Header title: 2026年10月. */
export function calendarTitle(_mode: CalendarMode, anchor: string): string {
  const [y, m] = anchor.split('-').map(Number);
  return `${y}年${m}月`;
}

// --- where a task sits -------------------------------------------------------

export type TaskSpan =
  | { allDay: true; start: string; end: string }
  | { allDay: false; start: string; end: string; startTime: string; endTime: string };

/** First and last day (and clock times) of a task's dates as seen in `timeZone`. */
export function taskSpan(dates: TaskDates, timeZone: string): TaskSpan {
  if (dates.allDay) return { allDay: true, start: dates.startDate ?? dates.dueDate, end: dates.dueDate };
  const due = zonedDateTime(dates.dueAt, timeZone);
  const start = dates.startAt ? zonedDateTime(dates.startAt, timeZone) : due;
  return { allDay: false, start: start.date, end: due.date, startTime: start.time, endTime: due.time };
}

/** Does a task with `dates` show on any day of `range`? */
export function taskInRange(dates: TaskDates | null, { from, to }: CalendarRange, timeZone: string): boolean {
  if (!dates) return false;
  const span = taskSpan(dates, timeZone);
  return span.start <= to && span.end >= from;
}

export interface DayBar {
  id: string;
  /** Row inside the day cells, 0 at the top. */
  lane: number;
  /** Columns (indexes into the row's days) the bar covers, inclusive. */
  startColumn: number;
  endColumn: number;
  /** The task starts before / ends after this row (draw a cut end). */
  continuesBefore: boolean;
  continuesAfter: boolean;
}

/**
 * Lay out 长条 over one row of consecutive `days` (a week of the 月视图 or
 * the 全天 row): earlier, then longer bars first, each in the first lane free
 * over all its columns. Items not on the row are left out.
 */
export function layoutDayBars(days: readonly string[], items: readonly { id: string; start: string; end: string }[]): DayBar[] {
  const first = days[0];
  const last = days.at(-1);
  if (!first || !last) return [];
  const visible = items
    .filter((item) => item.start <= last && item.end >= first)
    .map((item) => {
      const startColumn = Math.max(0, daysBetween(first, item.start));
      const endColumn = Math.min(days.length - 1, daysBetween(first, item.end));
      return { item, startColumn, endColumn };
    })
    .sort((a, b) => a.startColumn - b.startColumn || b.endColumn - a.endColumn);
  const lanes: number[] = []; // last occupied column per lane
  return visible.map(({ item, startColumn, endColumn }) => {
    let lane = lanes.findIndex((end) => end < startColumn);
    if (lane === -1) lane = lanes.length;
    lanes[lane] = endColumn;
    return {
      id: item.id,
      lane,
      startColumn,
      endColumn,
      continuesBefore: item.start < first,
      continuesAfter: item.end > last,
    };
  });
}

// --- dragging ----------------------------------------------------------------

function shiftInstant(instant: string, days: number, timeZone: string): string {
  const { date, time } = zonedDateTime(instant, timeZone);
  return zonedToInstant(addDays(date, days), time, timeZone);
}

/**
 * Dates after moving a task by `days` (dragged to another day in the 月视图):
 * a 日期区间 moves as a whole; timed dates keep the clock time shown in `timeZone`.
 */
export function moveTaskByDays(dates: TaskDates, days: number, timeZone: string): TaskDatesInput {
  if (dates.allDay) {
    return { allDay: true, startDate: dates.startDate ? addDays(dates.startDate, days) : null, dueDate: addDays(dates.dueDate, days) };
  }
  return {
    allDay: false,
    startAt: dates.startAt ? shiftInstant(dates.startAt, days, timeZone) : null,
    dueAt: shiftInstant(dates.dueAt, days, timeZone),
  };
}

/** Dates after dropping a task on day `date` of the 全天 row: all-day, starting there, as many days long as before. */
export function placeTaskOnDay(dates: TaskDates, date: string, timeZone: string): TaskDatesInput {
  const span = taskSpan(dates, timeZone);
  const length = daysBetween(span.start, span.end);
  return { allDay: true, startDate: length > 0 ? date : null, dueDate: addDays(date, length) };
}

/**
 * Dates after dropping a task on a time slot (`date` at `time`, in `timeZone`):
 * a timed range starts there and keeps its duration, a timed point moves
 * there, and an all-day task becomes a timed point.
 */
export function placeTaskAt(dates: TaskDates, date: string, time: string, timeZone: string): TaskDatesInput {
  const at = zonedToInstant(date, time, timeZone);
  if (dates.allDay || !dates.startAt) return { allDay: false, startAt: null, dueAt: at };
  const duration = Date.parse(dates.dueAt) - Date.parse(dates.startAt);
  return { allDay: false, startAt: at, dueAt: new Date(Date.parse(at) + duration).toISOString() };
}

// --- 农历, 节日, 休 / 班 ---------------------------------------------------

/** Kind of a day in the 工作日日历 that the calendar marks: 休 (法定假日) or 班 (调休补班). */
export const calendarDayMarkSchema = z.enum(['holiday', 'makeup_workday']);

/** `GET /api/calendar/days`: one entry per day, from the 农历 module and the 节假日数据. */
export const calendarDaySchema = z.object({
  date: calendarDateSchema,
  /** 正月 … 腊月, 闰六月 */
  lunarMonthName: z.string(),
  /** 初一 … 三十 */
  lunarDayName: z.string(),
  lunarDay: z.number().int().min(1).max(30),
  /** 传统节日 (春节, 中秋节, 清明节 …). */
  festivals: z.array(z.string()),
  /** 节气 starting this day. */
  solarTerm: z.string().nullable(),
  /** What the cell shows under the date (see `calendarDayLabel`). */
  label: z.string(),
  /** 休 / 班 badge; null on ordinary days. */
  mark: calendarDayMarkSchema.nullable(),
  /** Holiday a 休 / 班 day belongs to, e.g. 国庆节. */
  holidayName: z.string().nullable(),
});
export type CalendarDay = z.infer<typeof calendarDaySchema>;

export const calendarDaysResponseSchema = z.object({ days: z.array(calendarDaySchema) });
export type CalendarDaysResponse = z.infer<typeof calendarDaysResponseSchema>;

/** Label under the date: 传统节日, else 节气, else the 农历 month on 初一, else the 农历 day. */
export function calendarDayLabel(day: Pick<CalendarDay, 'festivals' | 'solarTerm' | 'lunarDay' | 'lunarMonthName' | 'lunarDayName'>): string {
  return day.festivals[0] ?? day.solarTerm ?? (day.lunarDay === 1 ? day.lunarMonthName : day.lunarDayName);
}
