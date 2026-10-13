import { describe, expect, it } from 'vitest';
import { nextOccurrence, repeatRuleSchema, type RepeatRuleInput } from './repeat-rule.js';
import { createWorkdayCalendar, type HolidayYear } from './workday-calendar.js';

/*
 * Review (EURO-14) edge cases for the 重复规则引擎: overdue completion combined
 * with 调休补班 / 跳过法定节假日 / end conditions / intervals, and a worst-case
 * horizon. Fixed holiday data: holiday-cn 2025 国庆 and 2026 劳动节.
 */

const days = (name: string, isOffDay: boolean, ...dates: string[]) => dates.map((date) => ({ name, date, isOffDay }));
const y2025: HolidayYear = {
  year: 2025,
  days: [
    ...days('国庆节、中秋节', false, '2025-09-28'),
    ...days('国庆节、中秋节', true, '2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07', '2025-10-08'),
    ...days('国庆节、中秋节', false, '2025-10-11'),
  ],
};
const y2026: HolidayYear = {
  year: 2026,
  days: [
    ...days('劳动节', true, '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05'),
    ...days('劳动节', false, '2026-05-09'),
  ],
};
const calendar = createWorkdayCalendar([y2025, y2026]);

function next(input: RepeatRuleInput, due: string, today: string, index = 1) {
  return nextOccurrence({ rule: repeatRuleSchema.parse(input), due, today, completedOn: today, index, calendar });
}

describe('overdue completion at the engine boundaries', () => {
  it.each<[string, RepeatRuleInput, string, string, string | null]>([
    // what, rule, due, today, next
    ['daily + 跳过法定节假日, today is in 国庆: skips past the holiday, not today', { freq: 'daily', skipHolidays: true }, '2025-09-25', '2025-10-03', '2025-10-09'],
    ['every Monday + 跳过, overdue, the next Monday is 劳动节: the one after (not moved to Tuesday)', { freq: 'weekly', weekdays: [1], skipHolidays: true }, '2026-04-20', '2026-04-29', '2026-05-11'],
    ['工作日, overdue, today is a 调休补班 Sunday: today', { freq: 'workday' }, '2025-09-22', '2025-09-28', '2025-09-28'],
    ['工作日, overdue, today is a 法定假日: first 工作日 after it', { freq: 'workday' }, '2025-09-29', '2025-10-05', '2025-10-09'],
    ['休息日, overdue, today is a 补班 Saturday: the next day', { freq: 'restday' }, '2025-10-04', '2025-10-11', '2025-10-12'],
    ['每月最后一个工作日, overdue into the next month', { freq: 'month_last_workday' }, '2026-04-30', '2026-05-12', '2026-05-29'],
    ['every 2 weeks, overdue 16 days: keeps the phase of the due date', { freq: 'weekly', interval: 2, weekdays: [3] }, '2026-09-30', '2026-10-16', '2026-10-28'],
    ['overdue past the 到某天结束 date: the series has ended', { freq: 'daily', end: { type: 'until', date: '2026-10-10' } }, '2026-10-05', '2026-10-14', null],
    ['overdue, 到某天结束 is today: today is still allowed', { freq: 'daily', end: { type: 'until', date: '2026-10-14' } }, '2026-10-05', '2026-10-14', '2026-10-14'],
    ['重复 1 次: the first instance is the last', { freq: 'daily', end: { type: 'count', count: 1 } }, '2026-10-14', '2026-10-14', null],
  ])('%s', (_what, input, due, today, expected) => {
    expect(next(input, due, today)).toBe(expected);
  });

  it('never returns a date before today or on/before the original due date', () => {
    const rules: RepeatRuleInput[] = [
      { freq: 'daily', interval: 3 },
      { freq: 'weekly', weekdays: [0, 6], skipHolidays: true },
      { freq: 'monthly', monthDay: 31 },
      { freq: 'workday' },
      { freq: 'restday', skipHolidays: true },
      { freq: 'month_first_workday' },
    ];
    for (const rule of rules) {
      for (const [due, today] of [
        ['2025-09-20', '2025-10-03'],
        ['2025-10-20', '2025-10-03'],
        ['2026-04-30', '2026-04-30'],
      ] as const) {
        const result = next(rule, due, today);
        expect(result, JSON.stringify({ rule, due, today })).not.toBeNull();
        expect(result! >= today && result! > due, JSON.stringify({ rule, due, today, result })).toBe(true);
      }
    }
  });

  it('the worst-case horizon (every 99 years, 跳过法定节假日) stays fast', () => {
    const started = performance.now();
    expect(next({ freq: 'yearly', interval: 99, skipHolidays: true }, '2026-10-14', '2026-10-14')).toBe('2125-10-14');
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('repeat rule schema: malformed input', () => {
  it.each<[string, unknown]>([
    ['interval above the max', { freq: 'daily', interval: 100 }],
    ['fractional interval', { freq: 'daily', interval: 1.5 }],
    ['weekday 7', { freq: 'weekly', weekdays: [7] }],
    ['monthDay 32', { freq: 'monthly', monthDay: 32 }],
    ['unknown freq', { freq: 'hourly' }],
    ['count above the max', { freq: 'daily', end: { type: 'count', count: 1000 } }],
    ['until not a date', { freq: 'daily', end: { type: 'until', date: 'tomorrow' } }],
    ['a string', 'FREQ=DAILY'],
  ])('rejects %s', (_what, input) => {
    expect(repeatRuleSchema.safeParse(input).success).toBe(false);
  });
});
