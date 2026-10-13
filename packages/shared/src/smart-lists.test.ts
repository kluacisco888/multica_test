import { describe, expect, it } from 'vitest';
import { matchesSmartList, taskDaySpan, type SmartListId, type SmartTask } from './smart-lists.js';

// 2026-10-13 is a 周二; 10:00 in Shanghai.
const clock = { now: new Date('2026-10-13T02:00:00.000Z'), timeZone: 'Asia/Shanghai' };

const open = (dates: SmartTask['dates'], extra: Partial<SmartTask> = {}): SmartTask => ({
  status: 'open',
  completedAt: null,
  dates,
  priority: 'none',
  ...extra,
});
const due = (dueDate: string, startDate: string | null = null) => ({ allDay: true as const, startDate, dueDate });
const timed = (dueAt: string, startAt: string | null = null) => ({ allDay: false as const, startAt, dueAt, timeZone: 'Asia/Shanghai' });

function lists(task: SmartTask): SmartListId[] {
  return (['today', 'tomorrow', 'week', 'completed', 'notImportant'] as const).filter((id) => matchesSmartList(id, task, clock));
}

describe('smart list rules', () => {
  it.each([
    ['no date', open(null), []],
    ['due today', open(due('2026-10-13')), ['today', 'week']],
    ['overdue', open(due('2026-10-01')), ['today', 'week']],
    ['due tomorrow', open(due('2026-10-14')), ['tomorrow', 'week']],
    ['due in 6 days (last day of the week)', open(due('2026-10-19')), ['week']],
    ['due in 7 days', open(due('2026-10-20')), []],
    ['range covering today', open(due('2026-10-15', '2026-10-10')), ['today', 'tomorrow', 'week']],
    ['range starting the day after tomorrow', open(due('2026-10-17', '2026-10-15')), ['week']],
    // 23:30 on the 13th in Shanghai is 15:30 UTC: still today there.
    ['timed today, late evening', open(timed('2026-10-13T15:30:00.000Z')), ['today', 'week']],
    // 00:30 on the 14th in Shanghai is 16:30 UTC on the 13th.
    ['timed just after midnight', open(timed('2026-10-13T16:30:00.000Z')), ['tomorrow', 'week']],
    ['timed earlier today (passed, still today)', open(timed('2026-10-13T00:00:00.000Z')), ['today', 'week']],
    ['low priority, no date', open(null, { priority: 'low' }), ['notImportant']],
    ['medium priority', open(null, { priority: 'medium' }), []],
  ] as const)('%s', (_name, task, expected) => {
    expect(lists(task)).toEqual(expected);
  });

  it('completed tasks: 已完成, plus date lists by date or completion day', () => {
    const doneToday = { status: 'completed' as const, completedAt: '2026-10-13T01:00:00.000Z' };
    expect(lists(open(null, doneToday))).toEqual(['today', 'week', 'completed']);
    expect(lists(open(due('2026-10-14'), { ...doneToday, completedAt: '2026-10-10T01:00:00.000Z' }))).toEqual([
      'tomorrow',
      'week',
      'completed',
    ]);
    // Completed long ago, overdue date: only 已完成 (completed tasks are never "overdue").
    expect(lists(open(due('2026-10-01'), { ...doneToday, completedAt: '2026-10-02T01:00:00.000Z' }))).toEqual(['completed']);
    // A completed low-priority task is not 不重要的.
    expect(lists(open(null, { ...doneToday, priority: 'low', completedAt: '2026-10-01T00:00:00.000Z' }))).toEqual(['completed']);
  });

  it('放弃 tasks show nowhere', () => {
    expect(lists(open(due('2026-10-13'), { status: 'abandoned', priority: 'low' }))).toEqual([]);
  });

  it('day spans use the given time zone for timed dates', () => {
    const dates = timed('2026-10-13T16:30:00.000Z', '2026-10-12T20:00:00.000Z');
    expect(taskDaySpan(dates, 'Asia/Shanghai')).toEqual({ start: '2026-10-13', due: '2026-10-14' });
    expect(taskDaySpan(dates, 'UTC')).toEqual({ start: '2026-10-12', due: '2026-10-13' });
  });
});
