import { describe, expect, it } from 'vitest';
import { datesAsStored, dragTaskDates, scheduleOnDay, timelineBar, timelineDays, timelineStart } from './timeline.js';
import { taskDatesInputSchema, type TaskDates } from './task-dates.js';

const SH = 'Asia/Shanghai';
const allDay = (startDate: string | null, dueDate: string): TaskDates => ({ allDay: true, startDate, dueDate });
const timed = (startAt: string | null, dueAt: string, timeZone = SH): TaskDates => ({ allDay: false, startAt, dueAt, timeZone });

describe('timelineBar', () => {
  it('has no bar without a date', () => {
    expect(timelineBar(null, SH)).toBeNull();
  });

  it('draws a due-date-only task as one day on its due date', () => {
    expect(timelineBar(allDay(null, '2026-10-15'), SH)).toEqual({ start: '2026-10-15', end: '2026-10-15' });
  });

  it('draws a range from its start to its due date, both included', () => {
    expect(timelineBar(allDay('2026-10-13', '2026-10-16'), SH)).toEqual({ start: '2026-10-13', end: '2026-10-16' });
  });

  it('places timed dates on the days they fall on in the current time zone', () => {
    // 2026-10-13 23:30 and 2026-10-15 08:00 in Shanghai
    const dates = timed('2026-10-13T15:30:00.000Z', '2026-10-15T00:00:00.000Z');
    expect(timelineBar(dates, SH)).toEqual({ start: '2026-10-13', end: '2026-10-15' });
    expect(timelineBar(dates, 'UTC')).toEqual({ start: '2026-10-13', end: '2026-10-15' });
    expect(timelineBar(dates, 'America/Los_Angeles')).toEqual({ start: '2026-10-13', end: '2026-10-14' });
  });
});

describe('dragTaskDates: all-day', () => {
  it('moves the whole bar, keeping its length', () => {
    expect(dragTaskDates(allDay('2026-10-13', '2026-10-15'), 'move', 3, SH)).toEqual(allDay('2026-10-16', '2026-10-18'));
    expect(dragTaskDates(allDay('2026-10-13', '2026-10-15'), 'move', -13, SH)).toEqual(allDay('2026-09-30', '2026-10-02'));
  });

  it('moves a due-date-only task and keeps it due-date-only', () => {
    expect(dragTaskDates(allDay(null, '2026-10-15'), 'move', 1, SH)).toEqual(allDay(null, '2026-10-16'));
  });

  it('drags the end: changes the due date only', () => {
    expect(dragTaskDates(allDay('2026-10-13', '2026-10-15'), 'end', 2, SH)).toEqual(allDay('2026-10-13', '2026-10-17'));
    expect(dragTaskDates(allDay('2026-10-13', '2026-10-15'), 'end', -1, SH)).toEqual(allDay('2026-10-13', '2026-10-14'));
  });

  it('drags the start: changes the start date only', () => {
    expect(dragTaskDates(allDay('2026-10-13', '2026-10-15'), 'start', -2, SH)).toEqual(allDay('2026-10-11', '2026-10-15'));
    expect(dragTaskDates(allDay('2026-10-13', '2026-10-15'), 'start', 1, SH)).toEqual(allDay('2026-10-14', '2026-10-15'));
  });

  it('stretches a due-date-only task into a range from either end', () => {
    expect(dragTaskDates(allDay(null, '2026-10-15'), 'end', 2, SH)).toEqual(allDay('2026-10-15', '2026-10-17'));
    expect(dragTaskDates(allDay(null, '2026-10-15'), 'start', -2, SH)).toEqual(allDay('2026-10-13', '2026-10-15'));
  });

  it('never lets an end pass the other one: the bar shrinks to one day', () => {
    expect(dragTaskDates(allDay('2026-10-13', '2026-10-15'), 'end', -5, SH)).toEqual(allDay(null, '2026-10-13'));
    expect(dragTaskDates(allDay('2026-10-13', '2026-10-15'), 'start', 5, SH)).toEqual(allDay(null, '2026-10-15'));
  });

  it('returns null when nothing changes', () => {
    expect(dragTaskDates(allDay('2026-10-13', '2026-10-15'), 'move', 0, SH)).toBeNull();
    expect(dragTaskDates(allDay(null, '2026-10-15'), 'end', -1, SH)).toBeNull();
    expect(dragTaskDates(allDay(null, '2026-10-15'), 'start', 1, SH)).toBeNull();
  });
});

describe('dragTaskDates: timed', () => {
  // 2026-10-13 09:00 → 2026-10-14 18:00 in Shanghai
  const range = timed('2026-10-13T01:00:00.000Z', '2026-10-14T10:00:00.000Z');

  it('moves by whole days, keeping the wall-clock times', () => {
    expect(dragTaskDates(range, 'move', 2, SH)).toEqual({
      allDay: false,
      startAt: '2026-10-15T01:00:00.000Z',
      dueAt: '2026-10-16T10:00:00.000Z',
    });
  });

  it('keeps wall-clock times across a DST change in the current time zone', () => {
    // 2026-10-30 09:00 in New York (EDT, UTC-4); DST ends 2026-11-01.
    const ny = timed(null, '2026-10-30T13:00:00.000Z', 'America/New_York');
    expect(dragTaskDates(ny, 'move', 3, 'America/New_York')).toEqual({ allDay: false, startAt: null, dueAt: '2026-11-02T14:00:00.000Z' });
  });

  it('drags either end', () => {
    expect(dragTaskDates(range, 'end', 1, SH)).toEqual({ allDay: false, startAt: '2026-10-13T01:00:00.000Z', dueAt: '2026-10-15T10:00:00.000Z' });
    expect(dragTaskDates(range, 'start', -1, SH)).toEqual({ allDay: false, startAt: '2026-10-12T01:00:00.000Z', dueAt: '2026-10-14T10:00:00.000Z' });
  });

  it('stretches a due-time-only task: the old due time becomes the start, or the start takes the due time of day', () => {
    const due = timed(null, '2026-10-14T10:00:00.000Z');
    expect(dragTaskDates(due, 'end', 1, SH)).toEqual({ allDay: false, startAt: '2026-10-14T10:00:00.000Z', dueAt: '2026-10-15T10:00:00.000Z' });
    expect(dragTaskDates(due, 'start', -1, SH)).toEqual({ allDay: false, startAt: '2026-10-13T10:00:00.000Z', dueAt: '2026-10-14T10:00:00.000Z' });
  });

  it('clamps the start to the due time instead of passing it', () => {
    // 09:00 on day 1 → 18:00 on day 2; dragging the start 1 day keeps 09:00 (before 18:00), 2 days clamps.
    expect(dragTaskDates(range, 'start', 1, SH)).toEqual({ allDay: false, startAt: '2026-10-14T01:00:00.000Z', dueAt: '2026-10-14T10:00:00.000Z' });
    expect(dragTaskDates(range, 'start', 3, SH)).toEqual({ allDay: false, startAt: null, dueAt: '2026-10-14T10:00:00.000Z' });
    expect(dragTaskDates(range, 'end', -3, SH)).toEqual({ allDay: false, startAt: null, dueAt: '2026-10-13T01:00:00.000Z' });
  });

  it('produces dates the API accepts', () => {
    for (const edge of ['move', 'start', 'end'] as const) {
      for (const days of [-3, -1, 1, 3]) {
        const next = dragTaskDates(range, edge, days, SH);
        if (next) expect(taskDatesInputSchema.safeParse(next).success, `${edge} ${days}`).toBe(true);
        const nextAllDay = dragTaskDates(allDay('2026-10-13', '2026-10-15'), edge, days, SH);
        if (nextAllDay) expect(taskDatesInputSchema.safeParse(nextAllDay).success, `${edge} ${days}`).toBe(true);
      }
    }
  });
});

describe('scheduling and the visible days', () => {
  it('schedules a task without a date as an all-day task due that day', () => {
    expect(scheduleOnDay('2026-10-20')).toEqual(allDay(null, '2026-10-20'));
  });

  it('starts two days before today, like the reference', () => {
    expect(timelineStart('2026-10-13')).toBe('2026-10-11');
  });

  it('lists consecutive days', () => {
    expect(timelineDays('2026-10-30', 4)).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  });
});

describe('datesAsStored', () => {
  it('fills the missing start and the time zone', () => {
    expect(datesAsStored({ allDay: true, dueDate: '2026-10-13' }, SH)).toEqual(allDay(null, '2026-10-13'));
    expect(datesAsStored({ allDay: false, dueAt: '2026-10-13T01:00:00.000Z' }, SH)).toEqual(timed(null, '2026-10-13T01:00:00.000Z'));
  });
});
