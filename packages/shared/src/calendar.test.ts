import { describe, expect, it } from 'vitest';
import {
  calendarDays,
  calendarDayLabel,
  calendarTitle,
  layoutDayBars,
  placeTaskAt,
  placeTaskOnDay,
  moveTaskByDays,
  stepCalendar,
  taskSpan,
  taskInRange,
  calendarRangeSchema,
} from './calendar.js';
import type { TaskDates } from './task-dates.js';

/*
 * 日历视图 (spec 用户故事 69–71): visible days of 月 / 周 / 日 / 多日, where
 * a task sits on them in the user's time zone, the 长条 lanes of 日期区间
 * tasks, and the new dates after dragging a task to another day or time.
 */

const SH = 'Asia/Shanghai';
const NY = 'America/New_York';

const allDay = (dueDate: string, startDate: string | null = null): TaskDates => ({ allDay: true, startDate, dueDate });
const timed = (dueAt: string, startAt: string | null = null, timeZone = SH): TaskDates => ({ allDay: false, startAt, dueAt, timeZone });

describe('visible days', () => {
  it('month: whole weeks (Monday first) covering the month', () => {
    const days = calendarDays('month', '2026-10-13');
    // 2026-10-01 is a Thursday, 10-31 a Saturday.
    expect(days[0]).toBe('2026-09-28');
    expect(days.at(-1)).toBe('2026-11-01');
    expect(days).toHaveLength(35);
  });

  it('month: a month starting on Monday starts on its first day', () => {
    // 2026-06-01 is a Monday, 06-30 a Tuesday.
    const days = calendarDays('month', '2026-06-20');
    expect(days[0]).toBe('2026-06-01');
    expect(days.at(-1)).toBe('2026-07-05');
  });

  it('week: Monday to Sunday around the anchor', () => {
    expect(calendarDays('week', '2026-10-18')).toEqual([
      '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18',
    ]);
  });

  it('day and 多日 (3 days) start at the anchor', () => {
    expect(calendarDays('day', '2026-10-13')).toEqual(['2026-10-13']);
    expect(calendarDays('multiDay', '2026-10-31')).toEqual(['2026-10-31', '2026-11-01', '2026-11-02']);
  });

  it('steps by a month, a week, a day or 3 days', () => {
    expect(stepCalendar('month', '2026-01-31', 1)).toBe('2026-02-01');
    expect(stepCalendar('month', '2026-01-15', -1)).toBe('2025-12-01');
    expect(stepCalendar('week', '2026-10-13', 1)).toBe('2026-10-20');
    expect(stepCalendar('day', '2026-10-13', -1)).toBe('2026-10-12');
    expect(stepCalendar('multiDay', '2026-10-13', 1)).toBe('2026-10-16');
  });

  it('titles the header with the year and month of the anchor', () => {
    expect(calendarTitle('month', '2026-10-13')).toBe('2026年10月');
    expect(calendarTitle('day', '2026-01-02')).toBe('2026年1月');
  });

  it('accepts ranges of up to 62 days, from before to', () => {
    expect(calendarRangeSchema.safeParse({ from: '2026-09-28', to: '2026-11-08' }).success).toBe(true);
    expect(calendarRangeSchema.safeParse({ from: '2026-10-02', to: '2026-10-01' }).success).toBe(false);
    expect(calendarRangeSchema.safeParse({ from: '2026-01-01', to: '2026-03-15' }).success).toBe(false);
    expect(calendarRangeSchema.safeParse({ from: '2026-02-30', to: '2026-03-01' }).success).toBe(false);
  });
});

describe('where a task sits', () => {
  it('all-day dates are the stored calendar dates in any time zone', () => {
    expect(taskSpan(allDay('2026-10-16', '2026-10-14'), NY)).toEqual({ allDay: true, start: '2026-10-14', end: '2026-10-16' });
    expect(taskSpan(allDay('2026-10-16'), SH)).toEqual({ allDay: true, start: '2026-10-16', end: '2026-10-16' });
  });

  it('timed dates are read in the user’s current time zone', () => {
    // 23:00–01:00 in Shanghai spans two days there, one day in New York (11:00–13:00).
    const dates = timed('2026-10-13T17:00:00.000Z', '2026-10-13T15:00:00.000Z');
    expect(taskSpan(dates, SH)).toEqual({ allDay: false, start: '2026-10-13', end: '2026-10-14', startTime: '23:00', endTime: '01:00' });
    expect(taskSpan(dates, NY)).toEqual({ allDay: false, start: '2026-10-13', end: '2026-10-13', startTime: '11:00', endTime: '13:00' });
  });

  it('a timed task set in New York lands on the Shanghai day it falls on', () => {
    // 20:30 on 10-13 in New York = 08:30 on 10-14 in Shanghai.
    const dates = timed('2026-10-14T00:30:00.000Z', null, NY);
    expect(taskSpan(dates, SH)).toMatchObject({ start: '2026-10-14', end: '2026-10-14', startTime: '08:30' });
    expect(taskInRange(dates, { from: '2026-10-14', to: '2026-10-14' }, SH)).toBe(true);
    expect(taskInRange(dates, { from: '2026-10-13', to: '2026-10-13' }, SH)).toBe(false);
    expect(taskInRange(dates, { from: '2026-10-13', to: '2026-10-13' }, NY)).toBe(true);
  });

  it('a 日期区间 is in every range it overlaps', () => {
    const range = allDay('2026-10-16', '2026-10-14');
    expect(taskInRange(range, { from: '2026-10-16', to: '2026-10-20' }, SH)).toBe(true);
    expect(taskInRange(range, { from: '2026-10-10', to: '2026-10-14' }, SH)).toBe(true);
    expect(taskInRange(range, { from: '2026-10-17', to: '2026-10-20' }, SH)).toBe(false);
    expect(taskInRange(null, { from: '2026-10-01', to: '2026-10-31' }, SH)).toBe(false);
  });
});

describe('长条 lanes', () => {
  const week = calendarDays('week', '2026-10-13'); // 10-12 … 10-18

  it('puts overlapping bars in separate lanes and reuses free lanes', () => {
    const bars = layoutDayBars(week, [
      { id: 'a', start: '2026-10-13', end: '2026-10-15' },
      { id: 'b', start: '2026-10-14', end: '2026-10-14' },
      { id: 'c', start: '2026-10-16', end: '2026-10-17' },
    ]);
    expect(bars).toEqual([
      { id: 'a', lane: 0, startColumn: 1, endColumn: 3, continuesBefore: false, continuesAfter: false },
      { id: 'b', lane: 1, startColumn: 2, endColumn: 2, continuesBefore: false, continuesAfter: false },
      { id: 'c', lane: 0, startColumn: 4, endColumn: 5, continuesBefore: false, continuesAfter: false },
    ]);
  });

  it('clips bars to the row and marks the cut ends; longer bars go first', () => {
    const bars = layoutDayBars(week, [
      { id: 'short', start: '2026-10-12', end: '2026-10-12' },
      { id: 'long', start: '2026-10-01', end: '2026-10-30' },
      { id: 'outside', start: '2026-10-19', end: '2026-10-20' },
    ]);
    expect(bars).toEqual([
      { id: 'long', lane: 0, startColumn: 0, endColumn: 6, continuesBefore: true, continuesAfter: true },
      { id: 'short', lane: 1, startColumn: 0, endColumn: 0, continuesBefore: false, continuesAfter: false },
    ]);
  });
});

describe('dragging to another day (月视图, 全天栏)', () => {
  it('moves a 日期区间 as a whole', () => {
    expect(moveTaskByDays(allDay('2026-10-16', '2026-10-14'), 3, SH)).toEqual({ allDay: true, startDate: '2026-10-17', dueDate: '2026-10-19' });
    expect(moveTaskByDays(allDay('2026-10-01'), -2, NY)).toEqual({ allDay: true, startDate: null, dueDate: '2026-09-29' });
  });

  it('keeps the clock time of a timed task in the user’s zone, across a DST change', () => {
    // 09:00 EDT on Saturday 10-31; New York leaves DST on 11-01. Two days later is 09:00 EST.
    const dates = timed('2026-10-31T13:00:00.000Z', null, NY);
    expect(moveTaskByDays(dates, 2, NY)).toEqual({ allDay: false, startAt: null, dueAt: '2026-11-02T14:00:00.000Z' });
    // The same task seen from Shanghai (21:00) keeps 21:00 Shanghai time.
    expect(moveTaskByDays(dates, 2, SH)).toEqual({ allDay: false, startAt: null, dueAt: '2026-11-02T13:00:00.000Z' });
  });

  it('moves a timed range that crosses midnight with both ends', () => {
    const dates = timed('2026-10-13T17:00:00.000Z', '2026-10-13T15:00:00.000Z');
    expect(moveTaskByDays(dates, 1, SH)).toEqual({
      allDay: false,
      startAt: '2026-10-14T15:00:00.000Z',
      dueAt: '2026-10-14T17:00:00.000Z',
    });
  });

  it('dropping a timed task on the 全天 row makes it all-day, keeping its length in days', () => {
    const dates = timed('2026-10-13T17:00:00.000Z', '2026-10-13T15:00:00.000Z'); // 10-13 23:00 → 10-14 01:00 in Shanghai
    expect(placeTaskOnDay(dates, '2026-10-20', SH)).toEqual({ allDay: true, startDate: '2026-10-20', dueDate: '2026-10-21' });
    expect(placeTaskOnDay(dates, '2026-10-20', NY)).toEqual({ allDay: true, startDate: null, dueDate: '2026-10-20' });
    expect(placeTaskOnDay(allDay('2026-10-16', '2026-10-14'), '2026-10-01', SH)).toEqual({
      allDay: true,
      startDate: '2026-10-01',
      dueDate: '2026-10-03',
    });
  });
});

describe('dragging to a time (周 / 日 / 多日视图)', () => {
  it('starts a timed range at the slot in the user’s zone and keeps its duration', () => {
    const dates = timed('2026-10-13T02:30:00.000Z', '2026-10-13T01:00:00.000Z'); // 09:00–10:30 Shanghai
    expect(placeTaskAt(dates, '2026-10-15', '14:00', NY)).toEqual({
      allDay: false,
      startAt: '2026-10-15T18:00:00.000Z',
      dueAt: '2026-10-15T19:30:00.000Z',
    });
    expect(placeTaskAt(dates, '2026-10-15', '14:00', SH)).toEqual({
      allDay: false,
      startAt: '2026-10-15T06:00:00.000Z',
      dueAt: '2026-10-15T07:30:00.000Z',
    });
  });

  it('moves a timed point; an all-day task becomes a timed point', () => {
    expect(placeTaskAt(timed('2026-10-13T02:00:00.000Z', null, NY), '2026-11-02', '09:15', NY)).toEqual({
      allDay: false,
      startAt: null,
      dueAt: '2026-11-02T14:15:00.000Z',
    });
    expect(placeTaskAt(allDay('2026-10-16', '2026-10-14'), '2026-10-13', '08:00', SH)).toEqual({
      allDay: false,
      startAt: null,
      dueAt: '2026-10-13T00:00:00.000Z',
    });
  });
});

describe('农历 label of a day', () => {
  const base = { lunarMonthName: '九月', lunarDayName: '初三', lunarDay: 3, festivals: [] as string[], solarTerm: null as string | null };

  it('shows 传统节日 first, then 节气, then 农历 month on 初一, else the 农历 day', () => {
    expect(calendarDayLabel({ ...base, festivals: ['中秋节'], solarTerm: '白露' })).toBe('中秋节');
    expect(calendarDayLabel({ ...base, solarTerm: '寒露' })).toBe('寒露');
    expect(calendarDayLabel({ ...base, lunarDay: 1, lunarDayName: '初一' })).toBe('九月');
    expect(calendarDayLabel(base)).toBe('初三');
  });
});
