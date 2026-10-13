import { describe, expect, it } from 'vitest';
import {
  focusElapsedMs,
  focusEndsAt,
  focusMessage,
  focusPeriod,
  focusRemainingMs,
  formatFocusDuration,
  nextBreakPhase,
  pomodoroSettingsSchema,
  stepFocusPeriod,
  summarizeFocus,
  type FocusRecordInput,
} from './focus.js';

const MIN = 60_000;
const at = (iso: string) => new Date(iso);

describe('focus timer arithmetic', () => {
  const running = { plannedMs: 25 * MIN, accumulatedMs: 0, resumedAt: '2026-10-14T01:00:00.000Z' };

  it('a running 番茄 ends its planned time after it (re)started', () => {
    expect(focusEndsAt(running)?.toISOString()).toBe('2026-10-14T01:25:00.000Z');
    expect(focusElapsedMs(running, at('2026-10-14T01:10:00.000Z'))).toBe(10 * MIN);
    expect(focusRemainingMs(running, at('2026-10-14T01:10:00.000Z'))).toBe(15 * MIN);
  });

  it('time spent before a pause counts, the pause itself does not', () => {
    const paused = { plannedMs: 25 * MIN, accumulatedMs: 10 * MIN, resumedAt: null };
    expect(focusEndsAt(paused)).toBeNull();
    expect(focusElapsedMs(paused, at('2026-10-14T05:00:00.000Z'))).toBe(10 * MIN);
    expect(focusRemainingMs(paused, at('2026-10-14T05:00:00.000Z'))).toBe(15 * MIN);
    const resumed = { ...paused, resumedAt: '2026-10-14T05:00:00.000Z' };
    expect(focusEndsAt(resumed)?.toISOString()).toBe('2026-10-14T05:15:00.000Z');
  });

  it('remaining never goes below zero; 正计时 has no end', () => {
    expect(focusRemainingMs(running, at('2026-10-14T03:00:00.000Z'))).toBe(0);
    const stopwatch = { plannedMs: null, accumulatedMs: 0, resumedAt: '2026-10-14T01:00:00.000Z' };
    expect(focusEndsAt(stopwatch)).toBeNull();
    expect(focusRemainingMs(stopwatch, at('2026-10-14T01:30:00.000Z'))).toBeNull();
    expect(focusElapsedMs(stopwatch, at('2026-10-14T01:30:00.000Z'))).toBe(30 * MIN);
  });
});

describe('nextBreakPhase', () => {
  it('长休息 after every 4th 番茄 (by default), 短休息 otherwise', () => {
    expect([1, 2, 3, 4, 5, 8].map((n) => nextBreakPhase(n, 4))).toEqual([
      'shortBreak',
      'shortBreak',
      'shortBreak',
      'longBreak',
      'shortBreak',
      'longBreak',
    ]);
    expect(nextBreakPhase(2, 2)).toBe('longBreak');
  });
});

describe('pomodoroSettingsSchema', () => {
  it('defaults to 25 / 5 / 15 and a 长休息 every 4', () => {
    expect(pomodoroSettingsSchema.parse({})).toEqual({ focusMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, longBreakEvery: 4 });
  });
  it('rejects out-of-range lengths', () => {
    expect(pomodoroSettingsSchema.safeParse({ focusMinutes: 0 }).success).toBe(false);
    expect(pomodoroSettingsSchema.safeParse({ focusMinutes: 181 }).success).toBe(false);
    expect(pomodoroSettingsSchema.safeParse({ longBreakEvery: 1.5 }).success).toBe(false);
  });
});

describe('focusPeriod', () => {
  it('a day, a week starting Monday, a month', () => {
    expect(focusPeriod('day', '2026-10-14')).toEqual({ from: '2026-10-14', to: '2026-10-14' });
    expect(focusPeriod('week', '2026-10-14')).toEqual({ from: '2026-10-12', to: '2026-10-18' });
    expect(focusPeriod('week', '2026-10-18')).toEqual({ from: '2026-10-12', to: '2026-10-18' });
    expect(focusPeriod('month', '2026-02-10')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });
  it('steps back and forth', () => {
    expect(stepFocusPeriod('day', '2026-10-01', -1)).toBe('2026-09-30');
    expect(stepFocusPeriod('week', '2026-10-14', 1)).toBe('2026-10-21');
    expect(stepFocusPeriod('month', '2026-01-31', 1)).toBe('2026-02-01');
  });
});

describe('summarizeFocus', () => {
  const tz = 'Asia/Shanghai';
  const rec = (startedAt: string, minutes: number, extra: Partial<FocusRecordInput> = {}): FocusRecordInput => ({
    startedAt,
    focusMs: minutes * MIN,
    pomodoro: true,
    taskId: null,
    taskTitle: null,
    ...extra,
  });
  const A = { taskId: '00000000-0000-4000-8000-00000000000a', taskTitle: '写周报' };
  const B = { taskId: '00000000-0000-4000-8000-00000000000b', taskTitle: '背单词' };
  const records = [
    // 2026-10-14 08:00 北京 (Wed)
    rec('2026-10-14T00:00:00.000Z', 25, A),
    rec('2026-10-14T01:00:00.000Z', 25, A),
    rec('2026-10-14T02:00:00.000Z', 40, { ...B, pomodoro: false }), // 正计时
    // 2026-10-13 23:30 北京: the 13th
    rec('2026-10-13T15:30:00.000Z', 25),
    // 2026-10-13 16:30Z is 2026-10-14 00:30 北京 — counts for the 14th
    rec('2026-10-13T16:30:00.000Z', 25, B),
    // Monday of the previous week
    rec('2026-10-05T02:00:00.000Z', 25, A),
    // 2026-09-30
    rec('2026-09-30T02:00:00.000Z', 50, B),
  ];
  const now = at('2026-10-14T06:00:00.000Z');

  it('by day, in the user time zone', () => {
    const s = summarizeFocus(records, { unit: 'day', date: '2026-10-14', timeZone: tz, now });
    expect(s).toMatchObject({ from: '2026-10-14', to: '2026-10-14', pomodoros: 3, focusMs: 115 * MIN });
    expect(s.days).toEqual([{ date: '2026-10-14', pomodoros: 3, focusMs: 115 * MIN }]);
    expect(s.tasks).toEqual([
      { taskId: B.taskId, title: '背单词', pomodoros: 1, focusMs: 65 * MIN },
      { taskId: A.taskId, title: '写周报', pomodoros: 2, focusMs: 50 * MIN },
    ]);
  });

  it('by week: one entry per day, Monday first', () => {
    const s = summarizeFocus(records, { unit: 'week', date: '2026-10-14', timeZone: tz, now });
    expect(s).toMatchObject({ from: '2026-10-12', to: '2026-10-18', pomodoros: 4, focusMs: 140 * MIN });
    expect(s.days.map((d) => [d.date, d.focusMs / MIN])).toEqual([
      ['2026-10-12', 0],
      ['2026-10-13', 25],
      ['2026-10-14', 115],
      ['2026-10-15', 0],
      ['2026-10-16', 0],
      ['2026-10-17', 0],
      ['2026-10-18', 0],
    ]);
    // Focus without a task is left out of the per-task list.
    expect(s.tasks.map((t) => t.title)).toEqual(['背单词', '写周报']);
  });

  it('by month', () => {
    const s = summarizeFocus(records, { unit: 'month', date: '2026-10-01', timeZone: tz, now });
    expect(s).toMatchObject({ from: '2026-10-01', to: '2026-10-31', pomodoros: 5, focusMs: 165 * MIN });
    expect(s.days).toHaveLength(31);
    const sept = summarizeFocus(records, { unit: 'month', date: '2026-09-15', timeZone: tz, now });
    expect(sept).toMatchObject({ pomodoros: 1, focusMs: 50 * MIN });
  });

  it('概览: today and all time; per-task totals over all time', () => {
    const s = summarizeFocus(records, { unit: 'month', date: '2026-09-15', timeZone: tz, now });
    expect(s.overview).toEqual({ todayPomodoros: 3, todayFocusMs: 115 * MIN, totalPomodoros: 6, totalFocusMs: 215 * MIN });
    expect(s.taskTotals).toEqual([
      { taskId: B.taskId, title: '背单词', pomodoros: 2, focusMs: 115 * MIN },
      { taskId: A.taskId, title: '写周报', pomodoros: 3, focusMs: 75 * MIN },
    ]);
  });

  it('nothing recorded', () => {
    const s = summarizeFocus([], { unit: 'day', date: '2026-10-14', timeZone: tz, now });
    expect(s).toMatchObject({ pomodoros: 0, focusMs: 0, tasks: [], taskTotals: [] });
    expect(s.overview).toEqual({ todayPomodoros: 0, todayFocusMs: 0, totalPomodoros: 0, totalFocusMs: 0 });
  });
});

describe('labels', () => {
  it('formatFocusDuration like the reference: 25m, 1h 5m, 0m', () => {
    expect(formatFocusDuration(0)).toBe('0m');
    expect(formatFocusDuration(25 * MIN + 59_000)).toBe('25m');
    expect(formatFocusDuration(65 * MIN)).toBe('1h 5m');
    expect(formatFocusDuration(120 * MIN)).toBe('2h');
  });
  it('focusMessage for a 通知渠道', () => {
    expect(focusMessage({ taskTitle: '写周报', focusMs: 25 * MIN, breakPhase: 'shortBreak' })).toEqual({
      title: '专注结束：写周报',
      body: '完成了 25 分钟专注，短休息开始了\n来自勾勾清单',
    });
    expect(focusMessage({ taskTitle: null, focusMs: 25 * MIN, breakPhase: 'longBreak' })).toEqual({
      title: '专注结束',
      body: '完成了 25 分钟专注，长休息开始了\n来自勾勾清单',
    });
  });
});
