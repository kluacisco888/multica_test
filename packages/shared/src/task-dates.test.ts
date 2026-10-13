import { describe, expect, it } from 'vitest';
import {
  addDays,
  DEFAULT_TIME_ZONE,
  describeTaskDates,
  isValidTimeZone,
  taskDatesInputSchema,
  todayIn,
  zonedDateTime,
  zonedToInstant,
  type TaskDates,
} from './task-dates.js';

/* 任务日期 (spec 用户故事 23–26): validation, time-zone conversion and the list label. */

const SH = 'Asia/Shanghai';
const NY = 'America/New_York';
// Tuesday 2026-10-13 10:00 in Shanghai.
const now = new Date('2026-10-13T02:00:00.000Z');

const allDay = (dueDate: string, startDate: string | null = null): TaskDates => ({ allDay: true, startDate, dueDate });
const timed = (dueAt: string, startAt: string | null = null, timeZone = SH): TaskDates => ({
  allDay: false,
  startAt,
  dueAt,
  timeZone,
});

describe('time zones', () => {
  it('defaults to Asia/Shanghai and validates IANA names', () => {
    expect(DEFAULT_TIME_ZONE).toBe('Asia/Shanghai');
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });

  it('reads the calendar date and clock time of an instant in a zone', () => {
    expect(zonedDateTime('2026-10-13T14:00:00.000Z', SH)).toEqual({ date: '2026-10-13', time: '22:00' });
    expect(zonedDateTime('2026-10-13T14:00:00.000Z', NY)).toEqual({ date: '2026-10-13', time: '10:00' });
    expect(zonedDateTime('2026-10-13T17:30:00.000Z', SH)).toEqual({ date: '2026-10-14', time: '01:30' });
    expect(todayIn(new Date('2026-10-13T17:00:00.000Z'), SH)).toBe('2026-10-14');
    expect(todayIn(new Date('2026-10-13T17:00:00.000Z'), NY)).toBe('2026-10-13');
  });

  it('turns a wall-clock date and time in a zone into a UTC instant, across DST', () => {
    expect(zonedToInstant('2026-10-13', '22:00', SH)).toBe('2026-10-13T14:00:00.000Z');
    // New York: EDT (UTC-4) before 2026-11-01, EST (UTC-5) after.
    expect(zonedToInstant('2026-10-31', '09:00', NY)).toBe('2026-10-31T13:00:00.000Z');
    expect(zonedToInstant('2026-11-02', '09:00', NY)).toBe('2026-11-02T14:00:00.000Z');
  });

  it('adds days to a calendar date', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });
});

describe('taskDatesInputSchema', () => {
  it('accepts a due date only, a range, all-day or timed', () => {
    for (const input of [
      { allDay: true, dueDate: '2026-10-13' },
      { allDay: true, startDate: '2026-10-13', dueDate: '2026-10-15' },
      { allDay: false, dueAt: '2026-10-13T14:00:00.000Z' },
      { allDay: false, startAt: '2026-10-13T14:00:00.000Z', dueAt: '2026-10-13T15:00:00.000Z' },
    ]) {
      expect(taskDatesInputSchema.safeParse(input).success, JSON.stringify(input)).toBe(true);
    }
  });

  it('rejects impossible dates, mixed fields and ranges that end before they start', () => {
    for (const input of [
      { allDay: true, dueDate: '2026-02-30' },
      { allDay: true, dueDate: '2026-1-5' },
      { allDay: true, dueAt: '2026-10-13T14:00:00.000Z' },
      { allDay: false, dueDate: '2026-10-13' },
      { allDay: true, startDate: '2026-10-16', dueDate: '2026-10-15' },
      { allDay: false, startAt: '2026-10-13T16:00:00.000Z', dueAt: '2026-10-13T15:00:00.000Z' },
      // The time zone is the user's setting, stamped by the server.
      { allDay: false, dueAt: '2026-10-13T14:00:00.000Z', timeZone: 'UTC' },
      {},
    ]) {
      expect(taskDatesInputSchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
  });
});

describe('describeTaskDates (list label, same words as 滴答)', () => {
  const label = (dates: TaskDates, timeZone = SH, at = now) => describeTaskDates(dates, { now: at, timeZone });

  it('uses 今天 / 明天 / 昨天 / 周几 for nearby all-day dates, then the date', () => {
    expect(label(allDay('2026-10-13')).text).toBe('今天');
    expect(label(allDay('2026-10-14')).text).toBe('明天');
    expect(label(allDay('2026-10-12')).text).toBe('昨天');
    expect(label(allDay('2026-10-15')).text).toBe('周四');
    expect(label(allDay('2026-10-18')).text).toBe('周日');
    expect(label(allDay('2026-10-19')).text).toBe('周一');
    expect(label(allDay('2026-10-20')).text).toBe('10月20日');
    expect(label(allDay('2026-05-12')).text).toBe('5月12日');
    expect(label(allDay('2027-01-03')).text).toBe('2027年1月3日');
  });

  it('shows only the time for a timed task due today, day and time otherwise', () => {
    expect(label(timed('2026-10-13T14:00:00.000Z')).text).toBe('22:00');
    expect(label(timed('2026-10-14T01:30:00.000Z')).text).toBe('明天 09:30');
    expect(label(timed('2026-10-22T01:00:00.000Z')).text).toBe('10月22日 09:00');
  });

  it('labels a range with both ends', () => {
    expect(label(allDay('2026-10-16', '2026-10-13')).text).toBe('今天 - 周五');
    expect(label(timed('2026-10-13T03:00:00.000Z', '2026-10-13T01:00:00.000Z')).text).toBe('09:00 - 11:00');
    expect(label(timed('2026-10-15T03:00:00.000Z', '2026-10-14T01:00:00.000Z')).text).toBe('明天 09:00 - 周四 11:00');
  });

  it('marks overdue: an all-day task after its day, a timed task after its moment', () => {
    expect(label(allDay('2026-10-12')).overdue).toBe(true);
    expect(label(allDay('2026-10-13')).overdue).toBe(false);
    expect(label(allDay('2026-10-14', '2026-10-01')).overdue).toBe(false);
    expect(label(timed('2026-10-13T01:59:00.000Z')).overdue).toBe(true);
    expect(label(timed('2026-10-13T02:01:00.000Z')).overdue).toBe(false);
  });

  it('shows a timed task in the given zone; an all-day task keeps its calendar date', () => {
    const meeting = timed('2026-10-13T14:00:00.000Z');
    expect(label(meeting, SH).text).toBe('22:00');
    // Same instant, 10:00 on 2026-10-13 in New York, where it is still 2026-10-12.
    expect(label(meeting, NY).text).toBe('明天 10:00');
    expect(label(meeting, NY, new Date('2026-10-13T12:00:00.000Z')).text).toBe('10:00');
    // 2026-10-13 10:00 Shanghai is 2026-10-12 22:00 in New York: "today" moves, the all-day date does not.
    expect(label(allDay('2026-10-13'), NY).text).toBe('明天');
    expect(label(allDay('2026-10-13'), SH).text).toBe('今天');
  });
});

describe('time zone changes across daylight saving time (review)', () => {
  const label = (dates: TaskDates, timeZone: string, at: Date) => describeTaskDates(dates, { now: at, timeZone });

  it('keeps the instant and moves the shown time by the offset on each side of the New York change', () => {
    // 2026-11-01 02:00 EDT -> 01:00 EST. Before: UTC-4, after: UTC-5; Shanghai is UTC+8 all year.
    const beforeChange = timed(zonedToInstant('2026-10-31', '09:00', NY), null, NY);
    const afterChange = timed(zonedToInstant('2026-11-02', '09:00', NY), null, NY);
    const at = new Date('2026-10-30T16:00:00.000Z'); // 2026-10-31 00:00 Shanghai, 10-30 12:00 New York
    expect(label(beforeChange, NY, at).text).toBe('明天 09:00');
    expect(label(beforeChange, SH, at).text).toBe('21:00');
    expect(label(afterChange, NY, at).text).toBe('周一 09:00');
    expect(label(afterChange, SH, at).text).toBe('周一 22:00');
  });

  it('keeps all-day dates unchanged when switching to and from a zone on its DST change day', () => {
    const day = allDay('2026-11-01');
    const at = new Date('2026-11-01T05:30:00.000Z'); // 01:30 EST (second 01:30) in New York, 13:30 in Shanghai
    expect(label(day, NY, at).text).toBe('今天');
    expect(label(day, SH, at).text).toBe('今天');
    expect(label(day, 'Europe/London', at).text).toBe('今天');
  });

  it('resolves wall-clock times on the change days to real instants', () => {
    // Repeated hour (fall back): the earlier occurrence, 01:30 EDT.
    expect(zonedToInstant('2026-11-01', '01:30', NY)).toBe('2026-11-01T05:30:00.000Z');
    // Hours after the change use the new offset.
    expect(zonedToInstant('2026-11-01', '03:00', NY)).toBe('2026-11-01T08:00:00.000Z');
    expect(zonedToInstant('2026-03-08', '03:30', NY)).toBe('2026-03-08T07:30:00.000Z');
    // Skipped hour (spring forward, 02:00-03:00 does not exist): lands on a real
    // instant one hour away from the typed time and round-trips to a valid wall clock.
    const gap = zonedToInstant('2026-03-08', '02:30', NY);
    expect(['2026-03-08T06:30:00.000Z', '2026-03-08T07:30:00.000Z']).toContain(gap);
    expect(zonedToInstant(zonedDateTime(gap, NY).date, zonedDateTime(gap, NY).time, NY)).toBe(gap);
  });
});
