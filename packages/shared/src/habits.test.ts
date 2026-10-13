import { describe, expect, it } from 'vitest';
import {
  completionRate,
  createHabitRequestSchema,
  currentStreak,
  bestStreak,
  habitDueOn,
  habitStats,
  isDayDone,
  monthGrid,
  weekStart,
  type HabitCheckin,
  type HabitRule,
} from './habits.js';

/*
 * 习惯 rules (spec 用户故事 93–98): 连续打卡 and 完成率 under the three
 * frequencies, including 补打卡 (a check-in on an earlier day added later)
 * and 撤销 (a day removed again).
 */

const daily: HabitRule = { frequency: { type: 'daily' }, goal: { type: 'once' }, startDate: '2026-10-01' };
// 周一、三、五
const mwf: HabitRule = { frequency: { type: 'weekdays', days: [1, 3, 5] }, goal: { type: 'once' }, startDate: '2026-10-01' };
// 每周 3 次
const weekly3: HabitRule = { frequency: { type: 'weekly', times: 3 }, goal: { type: 'once' }, startDate: '2026-10-01' };
// 喝水 8 杯
const water: HabitRule = { frequency: { type: 'daily' }, goal: { type: 'count', target: 8, unit: '杯' }, startDate: '2026-10-01' };

const done = (...dates: string[]): HabitCheckin[] => dates.map((date) => ({ date, count: 1 }));

describe('isDayDone', () => {
  it('a 完成一次 habit is done with any check-in', () => {
    expect(isDayDone(daily, done('2026-10-05'), '2026-10-05')).toBe(true);
    expect(isDayDone(daily, done('2026-10-05'), '2026-10-06')).toBe(false);
  });
  it('a 数量型 habit is done only when the day reaches the target', () => {
    expect(isDayDone(water, [{ date: '2026-10-05', count: 7 }], '2026-10-05')).toBe(false);
    expect(isDayDone(water, [{ date: '2026-10-05', count: 8 }], '2026-10-05')).toBe(true);
    expect(isDayDone(water, [{ date: '2026-10-05', count: 9 }], '2026-10-05')).toBe(true);
  });
});

describe('habitDueOn', () => {
  it('每天 is due every day from its start', () => {
    expect(habitDueOn(daily, [], '2026-10-09')).toBe(true);
    expect(habitDueOn(daily, [], '2026-09-30')).toBe(false);
  });
  it('固定几天 is due on those weekdays only', () => {
    expect(habitDueOn(mwf, [], '2026-10-12')).toBe(true); // 周一
    expect(habitDueOn(mwf, [], '2026-10-13')).toBe(false); // 周二
  });
  it('每周 N 次 is due until the week has N check-ins', () => {
    // Week of 周一 2026-10-12
    expect(habitDueOn(weekly3, done('2026-10-12', '2026-10-13'), '2026-10-14')).toBe(true);
    expect(habitDueOn(weekly3, done('2026-10-12', '2026-10-13', '2026-10-14'), '2026-10-15')).toBe(false);
    // …but a day already checked in stays due (its own check-in counts).
    expect(habitDueOn(weekly3, done('2026-10-12', '2026-10-13', '2026-10-14'), '2026-10-14')).toBe(true);
  });
});

describe('currentStreak', () => {
  it('每天: consecutive done days ending today', () => {
    expect(currentStreak(daily, done('2026-10-10', '2026-10-11', '2026-10-12'), '2026-10-12')).toEqual({ value: 3, unit: 'day' });
  });
  it('每天: today not done yet does not break the streak', () => {
    expect(currentStreak(daily, done('2026-10-10', '2026-10-11'), '2026-10-12')).toEqual({ value: 2, unit: 'day' });
  });
  it('每天: a missed day breaks it', () => {
    expect(currentStreak(daily, done('2026-10-08', '2026-10-10', '2026-10-11'), '2026-10-12').value).toBe(2);
    expect(currentStreak(daily, done('2026-10-08', '2026-10-09'), '2026-10-12').value).toBe(0);
  });
  it('每天: 补打卡 of the missing day joins the streak back up', () => {
    const before = done('2026-10-08', '2026-10-10', '2026-10-11');
    expect(currentStreak(daily, before, '2026-10-11').value).toBe(2);
    expect(currentStreak(daily, [...before, ...done('2026-10-09')], '2026-10-11').value).toBe(4);
  });
  it('每天: 撤销 a day in the middle breaks it again', () => {
    const all = done('2026-10-09', '2026-10-10', '2026-10-11');
    expect(currentStreak(daily, all.filter((c) => c.date !== '2026-10-10'), '2026-10-11').value).toBe(1);
  });
  it('数量型: a day under the target does not count and breaks the streak', () => {
    const checkins = [
      { date: '2026-10-09', count: 8 },
      { date: '2026-10-10', count: 3 },
      { date: '2026-10-11', count: 8 },
    ];
    expect(currentStreak(water, checkins, '2026-10-11').value).toBe(1);
    expect(currentStreak(water, checkins.map((c) => ({ ...c, count: 8 })), '2026-10-11').value).toBe(3);
  });
  it('固定几天: only those weekdays count; days in between do not break it', () => {
    // 周一 10-05, 周三 10-07, 周五 10-09, 周一 10-12; today 周二 10-13 (not due)
    expect(currentStreak(mwf, done('2026-10-05', '2026-10-07', '2026-10-09', '2026-10-12'), '2026-10-13')).toEqual({ value: 4, unit: 'day' });
  });
  it('固定几天: a missed due day breaks it, 补打卡 mends it', () => {
    const missed = done('2026-10-05', '2026-10-09', '2026-10-12');
    expect(currentStreak(mwf, missed, '2026-10-13').value).toBe(2);
    expect(currentStreak(mwf, [...missed, ...done('2026-10-07')], '2026-10-13').value).toBe(4);
  });
  it('固定几天: a check-in on a day that is not due neither counts nor breaks', () => {
    expect(currentStreak(mwf, done('2026-10-09', '2026-10-10', '2026-10-12'), '2026-10-12').value).toBe(2);
  });
  it('每周 N 次: counts consecutive weeks that reached N; the current week only once it has', () => {
    const w1 = done('2026-09-28', '2026-09-29', '2026-09-30'); // week of 09-28 (before start: still counted, see below)
    const w2 = done('2026-10-05', '2026-10-07', '2026-10-09');
    const w3 = done('2026-10-12', '2026-10-13');
    expect(currentStreak(weekly3, [...w2, ...w3], '2026-10-14')).toEqual({ value: 1, unit: 'week' });
    expect(currentStreak(weekly3, [...w2, ...w3, ...done('2026-10-14')], '2026-10-14')).toEqual({ value: 2, unit: 'week' });
    expect(currentStreak({ ...weekly3, startDate: '2026-09-28' }, [...w1, ...w2], '2026-10-14').value).toBe(2);
  });
  it('每周 N 次: a week short of N breaks it; 补打卡 into that week mends it', () => {
    const w1 = done('2026-09-28', '2026-09-29', '2026-09-30');
    const w2 = done('2026-10-05', '2026-10-07');
    const rule = { ...weekly3, startDate: '2026-09-28' };
    expect(currentStreak(rule, [...w1, ...w2], '2026-10-14').value).toBe(0);
    expect(currentStreak(rule, [...w1, ...w2, ...done('2026-10-08')], '2026-10-14').value).toBe(2);
  });
});

describe('bestStreak', () => {
  it('每天: the longest run anywhere', () => {
    const c = done('2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-06', '2026-10-07');
    expect(bestStreak(daily, c, '2026-10-12')).toEqual({ value: 4, unit: 'day' });
  });
  it('固定几天 and 每周 N 次', () => {
    expect(bestStreak(mwf, done('2026-10-02', '2026-10-05', '2026-10-07', '2026-10-12'), '2026-10-13').value).toBe(3);
    expect(bestStreak(weekly3, done('2026-10-05', '2026-10-06', '2026-10-07', '2026-10-12'), '2026-10-13').value).toBe(1);
  });
});

describe('completionRate', () => {
  it('每天: done days / days so far in the period', () => {
    // 10-01 … 10-10: 10 days, 5 done
    const c = done('2026-10-01', '2026-10-02', '2026-10-04', '2026-10-06', '2026-10-10');
    expect(completionRate(daily, c, '2026-10-01', '2026-10-31', '2026-10-10')).toEqual({ done: 5, planned: 10, rate: 0.5 });
  });
  it('每天: today counts only once it is done', () => {
    expect(completionRate(daily, done('2026-10-01'), '2026-10-01', '2026-10-31', '2026-10-02')).toEqual({ done: 1, planned: 1, rate: 1 });
    expect(completionRate(daily, done('2026-10-01', '2026-10-02'), '2026-10-01', '2026-10-31', '2026-10-02')).toEqual({ done: 2, planned: 2, rate: 1 });
  });
  it('starts at the habit start date, and 补打卡 before it moves the start back', () => {
    const rule = { ...daily, startDate: '2026-10-08' };
    expect(completionRate(rule, done('2026-10-08', '2026-10-09'), '2026-10-01', '2026-10-31', '2026-10-10')).toEqual({ done: 2, planned: 2, rate: 1 });
    expect(completionRate(rule, done('2026-10-06', '2026-10-08', '2026-10-09'), '2026-10-01', '2026-10-31', '2026-10-10')).toEqual({ done: 3, planned: 4, rate: 0.75 });
  });
  it('数量型: partial days do not count as done', () => {
    const c = [
      { date: '2026-10-01', count: 8 },
      { date: '2026-10-02', count: 4 },
    ];
    expect(completionRate(water, c, '2026-10-01', '2026-10-31', '2026-10-03')).toEqual({ done: 1, planned: 2, rate: 0.5 });
    // While it is still today, a partial day is not planned yet.
    expect(completionRate(water, c, '2026-10-01', '2026-10-31', '2026-10-02')).toEqual({ done: 1, planned: 1, rate: 1 });
  });
  it('固定几天: only due days are planned; check-ins on other days are not counted', () => {
    // 10-01 (周四) … 10-14 (周三) are past on 10-15: due 10-02, 05, 07, 09, 12, 14 = 6
    const c = done('2026-10-02', '2026-10-03', '2026-10-05', '2026-10-09');
    expect(completionRate(mwf, c, '2026-10-01', '2026-10-31', '2026-10-15')).toEqual({ done: 3, planned: 6, rate: 0.5 });
  });
  it('固定几天: 补打卡 and 撤销 change the rate', () => {
    const c = done('2026-10-02', '2026-10-05');
    // On 10-08 the due days so far are 10-02, 05, 07.
    expect(completionRate(mwf, c, '2026-10-01', '2026-10-31', '2026-10-08').rate).toBeCloseTo(2 / 3);
    expect(completionRate(mwf, [...c, ...done('2026-10-07')], '2026-10-01', '2026-10-31', '2026-10-08').rate).toBe(1);
    expect(completionRate(mwf, c.slice(1), '2026-10-01', '2026-10-31', '2026-10-08').rate).toBeCloseTo(1 / 3);
  });
  it('每周 N 次: N per full week, fewer for weeks cut by the period, extras not counted', () => {
    // Period 10-01 (周四) … 10-18 (周日): week 09-28 has 4 days in it (10-01…10-04) → plan 3;
    // weeks 10-05 and 10-12 → 3 each. Plan 9.
    const c = done('2026-10-01', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-12');
    expect(completionRate(weekly3, c, '2026-10-01', '2026-10-31', '2026-10-18')).toEqual({ done: 5, planned: 9, rate: 5 / 9 });
  });
  it('每周 N 次: a short tail week plans at most its days so far, once they are done or past', () => {
    // Up to 周二 10-13: week 10-12 has 10-12 (past) and 10-13 (today, not done) → plan 1.
    const c = done('2026-10-05', '2026-10-06', '2026-10-07', '2026-10-12');
    const rule = { ...weekly3, startDate: '2026-10-05' };
    expect(completionRate(rule, c, '2026-10-01', '2026-10-31', '2026-10-13')).toEqual({ done: 4, planned: 4, rate: 1 });
    // 补打卡 into the tail week adds to both.
    expect(completionRate(rule, [...c, ...done('2026-10-13')], '2026-10-01', '2026-10-31', '2026-10-13')).toEqual({ done: 5, planned: 5, rate: 1 });
  });
  it('a period with nothing planned yet has rate 0', () => {
    expect(completionRate(daily, [], '2026-11-01', '2026-11-30', '2026-10-10')).toEqual({ done: 0, planned: 0, rate: 0 });
  });
});

describe('habitStats', () => {
  it('sums up streaks, total and this month', () => {
    const s = habitStats(daily, done('2026-10-10', '2026-10-11', '2026-10-12'), '2026-10-12', '2026-10');
    expect(s).toMatchObject({
      currentStreak: { value: 3, unit: 'day' },
      bestStreak: { value: 3, unit: 'day' },
      totalDays: 3,
      month: { done: 3, planned: 12 },
    });
  });
});

describe('weekStart and monthGrid', () => {
  it('weeks start on 周一', () => {
    expect(weekStart('2026-10-14')).toBe('2026-10-12');
    expect(weekStart('2026-10-18')).toBe('2026-10-12');
    expect(weekStart('2026-10-12')).toBe('2026-10-12');
  });
  it('month grid covers whole weeks', () => {
    const g = monthGrid('2026-10');
    expect(g[0]).toBe('2026-09-28');
    expect(g.length % 7).toBe(0);
    expect(g.at(-1)).toBe('2026-11-01');
  });
});

describe('createHabitRequestSchema', () => {
  it('accepts the three frequencies and both goals', () => {
    expect(createHabitRequestSchema.safeParse({ name: '跑步', frequency: { type: 'weekdays', days: [5, 1, 1] } }).data?.frequency).toEqual({
      type: 'weekdays',
      days: [1, 5],
    });
    expect(createHabitRequestSchema.safeParse({ name: '喝水', goal: { type: 'count', target: 8, unit: '杯' } }).success).toBe(true);
    expect(createHabitRequestSchema.safeParse({ name: '读书', frequency: { type: 'weekly', times: 3 } }).success).toBe(true);
  });
  it('rejects bad input', () => {
    expect(createHabitRequestSchema.safeParse({ name: '' }).success).toBe(false);
    expect(createHabitRequestSchema.safeParse({ name: 'x', frequency: { type: 'weekdays', days: [] } }).success).toBe(false);
    expect(createHabitRequestSchema.safeParse({ name: 'x', frequency: { type: 'weekly', times: 7 } }).success).toBe(false);
    expect(createHabitRequestSchema.safeParse({ name: 'x', goal: { type: 'count', target: 0, unit: '杯' } }).success).toBe(false);
    expect(createHabitRequestSchema.safeParse({ name: 'x', reminders: ['25:00'] }).success).toBe(false);
  });
  it('reminders: distinct and sorted, at most 10', () => {
    expect(createHabitRequestSchema.parse({ name: 'x', reminders: ['21:00', '08:00', '21:00'] }).reminders).toEqual(['08:00', '21:00']);
    const many = Array.from({ length: 11 }, (_, i) => `${String(i + 8).padStart(2, '0')}:00`);
    expect(createHabitRequestSchema.safeParse({ name: 'x', reminders: many }).success).toBe(false);
  });
});
