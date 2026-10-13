import { taskDaySpan } from './smart-lists.js';
import { addDays, zonedDateTime, zonedToInstant, type TaskDates, type TaskDatesInput } from './task-dates.js';

/*
 * 时间线 (spec 用户故事 68): each dated task is a bar from its start day to
 * its due day (both included); a task with only a due date is a one-day bar on
 * that day; a task without a date has no bar and waits in 待安排 until it is
 * dragged onto a day. Dragging the bar moves both dates, dragging an end moves
 * that date only. Days are calendar days in the user's current time zone;
 * timed dates keep their wall-clock time when moved by whole days.
 */

/** What a drag changes: the whole bar, its start or its end. */
export type TimelineDrag = 'move' | 'start' | 'end';

export interface TimelineBar {
  /** First day, `YYYY-MM-DD`. */
  start: string;
  /** Last day (the due day), `YYYY-MM-DD`. */
  end: string;
}

/** The days a task's bar covers; null: no date, no bar. */
export function timelineBar(dates: TaskDates | null, timeZone: string): TimelineBar | null {
  const span = taskDaySpan(dates, timeZone);
  return span && { start: span.start, end: span.due };
}

/** The same wall-clock time `days` calendar days later, in `timeZone`. */
function shiftInstant(instant: string, days: number, timeZone: string): string {
  const { date, time } = zonedDateTime(instant, timeZone);
  return zonedToInstant(addDays(date, days), time, timeZone);
}

function sameDates(a: TaskDates, b: TaskDatesInput): boolean {
  if (a.allDay && b.allDay) return a.startDate === (b.startDate ?? null) && a.dueDate === b.dueDate;
  if (!a.allDay && !b.allDay) {
    const same = (x: string | null | undefined, y: string | null | undefined) => (x ? Date.parse(x) : null) === (y ? Date.parse(y) : null);
    return same(a.startAt, b.startAt) && same(a.dueAt, b.dueAt);
  }
  return false;
}

/**
 * New dates after dragging `drag` by `days` whole days, as `PATCH
 * /api/tasks/:id` takes them; null when nothing changes. An end never passes
 * the other one: the bar shrinks to a single due date instead.
 */
export function dragTaskDates(dates: TaskDates, drag: TimelineDrag, days: number, timeZone: string): TaskDatesInput | null {
  let next: TaskDatesInput;
  if (dates.allDay) {
    const start = dates.startDate ?? dates.dueDate;
    let s = start;
    let e = dates.dueDate;
    if (drag === 'move') {
      next = { allDay: true, startDate: dates.startDate && addDays(dates.startDate, days), dueDate: addDays(e, days) };
    } else {
      if (drag === 'start') s = addDays(start, days) > e ? e : addDays(start, days);
      else e = addDays(e, days) < s ? s : addDays(e, days);
      next = { allDay: true, startDate: s === e ? null : s, dueDate: e };
    }
  } else {
    const start = dates.startAt ?? dates.dueAt;
    let s = start;
    let e = dates.dueAt;
    if (drag === 'move') {
      next = { allDay: false, startAt: dates.startAt && shiftInstant(dates.startAt, days, timeZone), dueAt: shiftInstant(e, days, timeZone) };
    } else {
      if (drag === 'start') {
        const moved = shiftInstant(start, days, timeZone);
        s = Date.parse(moved) > Date.parse(e) ? e : moved;
      } else {
        const moved = shiftInstant(e, days, timeZone);
        e = Date.parse(moved) < Date.parse(s) ? s : moved;
      }
      next = { allDay: false, startAt: Date.parse(s) === Date.parse(e) ? null : s, dueAt: e };
    }
  }
  return sameDates(dates, next) ? null : next;
}

/** Input dates (as just saved) in the stored shape, to show them before the server answers. */
export function datesAsStored(dates: TaskDatesInput, timeZone: string): TaskDates {
  return dates.allDay
    ? { allDay: true, startDate: dates.startDate ?? null, dueDate: dates.dueDate }
    : { allDay: false, startAt: dates.startAt ?? null, dueAt: dates.dueAt, timeZone };
}

/** Dates of a task without a date dropped on `day`: due that day, all day. */
export function scheduleOnDay(day: string): TaskDatesInput {
  return { allDay: true, startDate: null, dueDate: day };
}

/** First day shown when the timeline opens or jumps to 今天: two days before today, like the reference. */
export function timelineStart(today: string): string {
  return addDays(today, -2);
}

/** `count` consecutive days from `first`. */
export function timelineDays(first: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addDays(first, i));
}
