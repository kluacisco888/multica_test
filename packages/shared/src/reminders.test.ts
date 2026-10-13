import { describe, expect, it } from 'vitest';
import {
  describeReminder,
  nextRetryAt,
  reminderFireAt,
  reminderMessage,
  remindersSchema,
  reminderSchedule,
  withinCatchUp,
  type Reminder,
} from './reminders.js';
import type { TaskDates } from './task-dates.js';

const ctx = { timeZone: 'Asia/Shanghai', allDayTime: '09:00' };
const timed: TaskDates = { allDay: false, startAt: null, dueAt: '2026-10-14T02:00:00.000Z', timeZone: 'Asia/Shanghai' }; // 10:00 北京
const allDay: TaskDates = { allDay: true, startDate: null, dueDate: '2026-10-14' };
const before = (minutes: number): Reminder => ({ type: 'before', minutes });
const day = (daysBefore: number, time: string | null = null): Reminder => ({ type: 'day', daysBefore, time });

describe('reminderFireAt', () => {
  it.each([
    [0, '2026-10-14T02:00:00.000Z'],
    [5, '2026-10-14T01:55:00.000Z'],
    [30, '2026-10-14T01:30:00.000Z'],
    [60, '2026-10-14T01:00:00.000Z'],
    [1440, '2026-10-13T02:00:00.000Z'],
  ])('timed task, %i minutes before', (minutes, expected) => {
    expect(reminderFireAt(before(minutes), timed, ctx)?.toISOString()).toBe(expected);
  });

  it('a 时间段 reminds relative to its start', () => {
    const range: TaskDates = { ...timed, startAt: '2026-10-14T01:00:00.000Z' };
    expect(reminderFireAt(before(0), range, ctx)?.toISOString()).toBe('2026-10-14T01:00:00.000Z');
  });

  it.each([
    [day(0), '2026-10-14T01:00:00.000Z'],
    [day(1), '2026-10-13T01:00:00.000Z'],
    [day(7), '2026-10-07T01:00:00.000Z'],
    [day(0, '20:30'), '2026-10-14T12:30:00.000Z'],
  ])('all-day task: %j at the 全天提醒时间 in the user time zone', (r, expected) => {
    expect(reminderFireAt(r, allDay, ctx)?.toISOString()).toBe(expected);
  });

  it('follows the 全天提醒时间 setting and the time zone', () => {
    expect(reminderFireAt(day(0), allDay, { timeZone: 'Asia/Shanghai', allDayTime: '08:15' })?.toISOString()).toBe('2026-10-14T00:15:00.000Z');
    expect(reminderFireAt(day(0), allDay, { timeZone: 'Europe/London', allDayTime: '09:00' })?.toISOString()).toBe('2026-10-14T08:00:00.000Z');
  });

  it('is null when the reminder does not fit the dates', () => {
    expect(reminderFireAt(day(0), timed, ctx)).toBeNull();
    expect(reminderFireAt(before(0), allDay, ctx)).toBeNull();
    expect(reminderFireAt(before(0), null, ctx)).toBeNull();
  });

  it('reminderSchedule keys every fitting reminder', () => {
    expect(reminderSchedule([before(0), day(1), before(30)], timed, ctx)).toEqual([
      { key: 'before:0', fireAt: new Date('2026-10-14T02:00:00.000Z') },
      { key: 'before:30', fireAt: new Date('2026-10-14T01:30:00.000Z') },
    ]);
  });
});

describe('remindersSchema', () => {
  it('drops duplicates and sorts the largest lead first', () => {
    expect(remindersSchema.parse([before(0), before(60), before(0), before(5)])).toEqual([before(60), before(5), before(0)]);
  });

  it('rejects more than 10 reminders and leads over 60 days', () => {
    expect(remindersSchema.safeParse(Array.from({ length: 11 }, (_, i) => before(i))).success).toBe(false);
    expect(remindersSchema.safeParse([before(60 * 24 * 60 + 1)]).success).toBe(false);
    expect(remindersSchema.safeParse([day(61)]).success).toBe(false);
    expect(remindersSchema.safeParse([day(0, '25:00')]).success).toBe(false);
  });
});

describe('retries and catch-up', () => {
  const now = new Date('2026-10-14T02:00:00.000Z');

  it('retries 1, 5 and 15 minutes after the 1st, 2nd and 3rd failure, then gives up', () => {
    expect(nextRetryAt(1, now)?.toISOString()).toBe('2026-10-14T02:01:00.000Z');
    expect(nextRetryAt(2, now)?.toISOString()).toBe('2026-10-14T02:05:00.000Z');
    expect(nextRetryAt(3, now)?.toISOString()).toBe('2026-10-14T02:15:00.000Z');
    expect(nextRetryAt(4, now)).toBeNull();
  });

  it('sends reminders at most 24 hours late', () => {
    const fireAt = new Date('2026-10-13T02:00:00.000Z');
    expect(withinCatchUp(fireAt, now)).toBe(true); // exactly 24 hours
    expect(withinCatchUp(fireAt, new Date(now.getTime() + 1))).toBe(false);
  });
});

describe('labels and message', () => {
  it.each([
    [before(0), '准时'],
    [before(5), '提前5分钟'],
    [before(30), '提前30分钟'],
    [before(60), '提前1小时'],
    [before(90), '提前1小时30分钟'],
    [before(1440), '提前1天'],
    [before(10080), '提前1周'],
    [day(0), '当天（09:00）'],
    [day(1), '提前1天（09:00）'],
    [day(7), '提前1周（09:00）'],
    [day(3, '20:00'), '提前3天（20:00）'],
  ])('%j → %s', (r, label) => {
    expect(describeReminder(r, '09:00')).toBe(label);
  });

  it('names the task and its time', () => {
    expect(reminderMessage({ title: '开会', dates: timed }, { now: new Date('2026-10-14T01:00:00.000Z'), timeZone: 'Asia/Shanghai' })).toEqual({
      title: '提醒：开会',
      body: '时间：10:00\n来自勾勾清单',
    });
  });
});
