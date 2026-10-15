import { describe, expect, it } from 'vitest';
import { habitWeek, statBucket, statBucketLabel, statPeriods, type StatHabitInput, type StatTaskInput } from './statistics.js';

const today = '2026-10-15'; // 周四
const none = { tasks: [], focus: [], habits: [], today };

describe('statPeriods', () => {
  it('gives the last 7 days, weeks (周一 first) or months, oldest first', () => {
    expect(statPeriods('day', today).map((p) => p.from)).toEqual([
      '2026-10-09',
      '2026-10-10',
      '2026-10-11',
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
    ]);
    expect(statPeriods('week', today).at(-1)).toEqual({ from: '2026-10-12', to: '2026-10-18' });
    expect(statPeriods('week', today)[0]).toEqual({ from: '2026-08-31', to: '2026-09-06' });
    expect(statPeriods('month', today).map((p) => p.from.slice(0, 7))).toEqual(['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
  });
});

describe('statBucket', () => {
  const period = { from: '2026-10-12', to: '2026-10-18' };

  it('counts 任务 completed in the period; 放弃 is not 完成', () => {
    const tasks: StatTaskInput[] = [
      { status: 'completed', dueDay: null, completedDay: '2026-10-12' },
      { status: 'completed', dueDay: null, completedDay: '2026-10-11' },
      { status: 'abandoned', dueDay: '2026-10-13', completedDay: null },
    ];
    expect(statBucket(period, { ...none, tasks }).completed).toBe(1);
  });

  it('完成率 is the share of 任务 due in the period that were completed, without 放弃', () => {
    const tasks: StatTaskInput[] = [
      { status: 'completed', dueDay: '2026-10-13', completedDay: '2026-10-13' },
      { status: 'open', dueDay: '2026-10-14', completedDay: null },
      { status: 'abandoned', dueDay: '2026-10-14', completedDay: null },
      { status: 'open', dueDay: '2026-10-30', completedDay: null },
    ];
    expect(statBucket(period, { ...none, tasks }).completion).toEqual({ done: 1, planned: 2 });
  });

  it('sums 番茄 (番茄钟 only) and 专注时长 by the day they started', () => {
    const focus = [
      { day: '2026-10-12', pomodoro: true, focusMs: 25 * 60_000 },
      { day: '2026-10-13', pomodoro: false, focusMs: 40 * 60_000 },
      { day: '2026-10-19', pomodoro: true, focusMs: 25 * 60_000 },
    ];
    expect(statBucket(period, { ...none, focus })).toMatchObject({ pomodoros: 1, focusMs: 65 * 60_000 });
  });

  it('adds the 习惯 打卡 of every habit', () => {
    const habits: StatHabitInput[] = [
      { rule: { frequency: { type: 'daily' }, goal: { type: 'once' }, startDate: '2026-10-01' }, checkins: [{ date: '2026-10-12', count: 1 }] },
    ];
    // 10-12 … 10-14 planned (today not done yet does not count), 1 done.
    expect(statBucket(period, { ...none, habits }).habits).toEqual({ done: 1, planned: 3 });
  });
});

describe('habitWeek', () => {
  it('runs 周日 … 周六 with habits done / due each day', () => {
    const habits: StatHabitInput[] = [
      { rule: { frequency: { type: 'daily' }, goal: { type: 'once' }, startDate: '2026-10-13' }, checkins: [{ date: '2026-10-13', count: 1 }] },
    ];
    const week = habitWeek(habits, today);
    expect(week.map((d) => d.date)).toEqual(['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17']);
    expect(week.map((d) => [d.done, d.due])).toEqual([[0, 0], [0, 0], [1, 1], [0, 1], [0, 1], [0, 1], [0, 1]]);
  });
});

describe('statBucketLabel', () => {
  it('labels days like the reference (9日 … 今天)', () => {
    expect(statBucketLabel('day', { from: '2026-10-09', to: '2026-10-09' }, today)).toBe('9日');
    expect(statBucketLabel('day', { from: today, to: today }, today)).toBe('今天');
    expect(statBucketLabel('week', { from: '2026-10-05', to: '2026-10-11' }, today)).toBe('10/5');
    expect(statBucketLabel('week', { from: '2026-10-12', to: '2026-10-18' }, today)).toBe('本周');
    expect(statBucketLabel('month', { from: '2026-09-01', to: '2026-09-30' }, today)).toBe('9月');
  });
});
