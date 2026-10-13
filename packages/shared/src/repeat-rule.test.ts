import { describe, expect, it } from 'vitest';
import {
  describeRepeatRule,
  dueDayOf,
  nextOccurrence,
  repeatRuleSchema,
  shiftTaskDates,
  type RepeatRuleInput,
} from './repeat-rule.js';
import { createWorkdayCalendar, type HolidayYear } from './workday-calendar.js';

/*
 * 重复规则引擎 (spec 用户故事 41–50, Q27). Fixed holiday data, the complete
 * arrangements of a few holidays copied from holiday-cn 2025.json / 2026.json;
 * 2027 has no data (counts as Monday–Friday).
 */

const off = (name: string, ...dates: string[]) => dates.map((date) => ({ name, date, isOffDay: true }));
const makeup = (name: string, ...dates: string[]) => dates.map((date) => ({ name, date, isOffDay: false }));
const range = (from: string, to: string) => {
  const out: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
};

const y2025: HolidayYear = {
  year: 2025,
  days: [
    // 国庆节、中秋节: 10-01…10-08 off; 补班 on Sunday 09-28 and Saturday 10-11.
    ...makeup('国庆节、中秋节', '2025-09-28'),
    ...off('国庆节、中秋节', ...range('2025-10-01', '2025-10-08')),
    ...makeup('国庆节、中秋节', '2025-10-11'),
  ],
};
const y2026: HolidayYear = {
  year: 2026,
  days: [
    // 元旦: 01-01…01-03 off, 补班 on Sunday 01-04.
    ...off('元旦', '2026-01-01', '2026-01-02', '2026-01-03'),
    ...makeup('元旦', '2026-01-04'),
    // 春节: 02-15…02-23 off, 补班 on Saturdays 02-14 and 02-28.
    ...makeup('春节', '2026-02-14'),
    ...off('春节', ...range('2026-02-15', '2026-02-23')),
    ...makeup('春节', '2026-02-28'),
    // 劳动节: 05-01…05-05 off (05-04 is a Monday), 补班 on Saturday 05-09.
    ...off('劳动节', ...range('2026-05-01', '2026-05-05')),
    ...makeup('劳动节', '2026-05-09'),
    // 国庆节: 10-01…10-07 off.
    ...off('国庆节', ...range('2026-10-01', '2026-10-07')),
  ],
};
const calendar = createWorkdayCalendar([y2025, y2026]);

const rule = (input: RepeatRuleInput) => repeatRuleSchema.parse(input);

/** Complete on the due day itself unless told otherwise. */
function next(input: RepeatRuleInput, due: string, options: { today?: string; completedOn?: string; index?: number } = {}) {
  const today = options.today ?? due;
  return nextOccurrence({
    rule: rule(input),
    due,
    today,
    completedOn: options.completedOn ?? today,
    index: options.index ?? 1,
    calendar,
  });
}

describe('repeat rule engine: spec Q27', () => {
  // 2026-10-14 is a Wednesday.
  it('a daily task 6 days overdue: the next instance is today', () => {
    expect(next({ freq: 'daily' }, '2026-10-08', { today: '2026-10-14' })).toBe('2026-10-14');
  });
  it('a daily task due today: the next instance is tomorrow', () => {
    expect(next({ freq: 'daily' }, '2026-10-14')).toBe('2026-10-15');
  });
  it('every Monday, completed on a Wednesday: the next instance is next Monday', () => {
    expect(next({ freq: 'weekly', weekdays: [1] }, '2026-10-12', { today: '2026-10-14' })).toBe('2026-10-19');
  });
});

describe('repeat rule engine: 工作日 / 休息日 with holiday data', () => {
  it.each<[string, RepeatRuleInput, string, string]>([
    // what, rule, due (completed that day), next
    ['工作日: Friday → 调休补班 Sunday', { freq: 'workday' }, '2025-09-26', '2025-09-28'],
    ['工作日: skips the whole 国庆 holiday', { freq: 'workday' }, '2025-09-30', '2025-10-09'],
    ['工作日: Friday → 调休补班 Saturday', { freq: 'workday' }, '2025-10-10', '2025-10-11'],
    ['工作日: 补班 Saturday before 春节', { freq: 'workday' }, '2026-02-13', '2026-02-14'],
    ['工作日: after 春节', { freq: 'workday' }, '2026-02-14', '2026-02-24'],
    ['工作日: a 法定假日 on a Monday', { freq: 'workday' }, '2026-04-30', '2026-05-06'],
    ['工作日: year without data counts Monday–Friday', { freq: 'workday' }, '2026-12-31', '2027-01-01'],
    ['工作日: no-data weekend is skipped', { freq: 'workday' }, '2027-01-01', '2027-01-04'],
    ['休息日: skips the 补班 Sunday, lands on a 法定假日', { freq: 'restday' }, '2025-09-27', '2025-10-01'],
    ['休息日: skips the 补班 Saturday', { freq: 'restday' }, '2025-10-08', '2025-10-12'],
    ['休息日: 补班 Saturday is not a 休息日', { freq: 'restday' }, '2026-02-13', '2026-02-15'],
    ['休息日: a 法定假日 on a weekday', { freq: 'restday' }, '2026-04-26', '2026-05-01'],
    ['每月第一个工作日: after 国庆', { freq: 'month_first_workday' }, '2025-09-01', '2025-10-09'],
    ['每月第一个工作日: a 补班 Sunday', { freq: 'month_first_workday' }, '2025-12-01', '2026-01-04'],
    ['每月第一个工作日: ordinary Monday', { freq: 'month_first_workday' }, '2026-01-04', '2026-02-02'],
    ['每月最后一个工作日: ordinary Friday', { freq: 'month_last_workday' }, '2025-09-30', '2025-10-31'],
    ['每月最后一个工作日: a 补班 Saturday', { freq: 'month_last_workday' }, '2026-01-30', '2026-02-28'],
    ['每月最后一个工作日: before 国庆', { freq: 'month_last_workday' }, '2026-08-31', '2026-09-30'],
  ])('%s', (_what, input, due, expected) => {
    expect(next(input, due)).toBe(expected);
  });
});

describe('repeat rule engine: 跳过法定节假日', () => {
  it.each<[string, RepeatRuleInput, string, string | null]>([
    ['every Monday lands on 劳动节 Monday', { freq: 'weekly', weekdays: [1] }, '2026-04-27', '2026-05-04'],
    ['every Monday skips 劳动节 Monday', { freq: 'weekly', weekdays: [1], skipHolidays: true }, '2026-04-27', '2026-05-11'],
    ['daily skips the 国庆 holiday', { freq: 'daily', skipHolidays: true }, '2025-09-30', '2025-10-09'],
    ['daily keeps ordinary weekends', { freq: 'daily', skipHolidays: true }, '2025-10-10', '2025-10-11'],
    ['monthly on the 1st skips 10-01 (not moved to 10-02)', { freq: 'monthly', skipHolidays: true }, '2025-09-01', '2025-11-01'],
    ['yearly on 10-01 skips to a year without data', { freq: 'yearly', skipHolidays: true }, '2025-10-01', '2027-10-01'],
    ['the skip does not apply to 补班 weekends', { freq: 'weekly', weekdays: [0], skipHolidays: true }, '2025-09-21', '2025-09-28'],
  ])('%s', (_what, input, due, expected) => {
    expect(next(input, due)).toBe(expected);
  });
});

describe('repeat rule engine: intervals, basis and end conditions', () => {
  it.each<[string, RepeatRuleInput, string, { today?: string; completedOn?: string; index?: number }, string | null]>([
    ['every 2 days, overdue: keeps the phase', { freq: 'daily', interval: 2 }, '2026-10-08', { today: '2026-10-14' }, '2026-10-14'],
    ['every 4 days, overdue: next on the phase', { freq: 'daily', interval: 4 }, '2026-10-08', { today: '2026-10-14' }, '2026-10-16'],
    ['every 2 weeks Mon+Fri, same week', { freq: 'weekly', interval: 2, weekdays: [1, 5] }, '2026-10-12', {}, '2026-10-16'],
    ['every 2 weeks Mon+Fri, skips a week', { freq: 'weekly', interval: 2, weekdays: [5, 1] }, '2026-10-16', {}, '2026-10-26'],
    ['weekly without weekdays: the due weekday', { freq: 'weekly' }, '2026-10-14', {}, '2026-10-21'],
    ['monthly on the 31st clamps to February', { freq: 'monthly', monthDay: 31 }, '2026-01-31', {}, '2026-02-28'],
    ['monthly on the 31st returns to the 31st', { freq: 'monthly', monthDay: 31 }, '2026-02-28', {}, '2026-03-31'],
    ['every 3 months', { freq: 'monthly', interval: 3 }, '2026-01-15', {}, '2026-04-15'],
    ['monthly, overdue by months', { freq: 'monthly' }, '2026-06-15', { today: '2026-10-14' }, '2026-10-15'],
    ['yearly on 02-29 clamps', { freq: 'yearly', month: 2, monthDay: 29 }, '2028-02-29', {}, '2029-02-28'],
    ['yearly', { freq: 'yearly' }, '2026-10-13', {}, '2027-10-13'],
    ['按完成日期: every 3 days from completion', { freq: 'daily', interval: 3, basis: 'completion' }, '2026-10-01', { today: '2026-10-14' }, '2026-10-17'],
    ['按完成日期: weekly Monday from a Wednesday', { freq: 'weekly', weekdays: [1], basis: 'completion' }, '2026-10-05', { today: '2026-10-14' }, '2026-10-19'],
    ['按截止日期: completed early keeps the due date chain', { freq: 'daily' }, '2026-10-20', { today: '2026-10-14' }, '2026-10-21'],
    ['ends on a date: still inside', { freq: 'daily', end: { type: 'until', date: '2026-10-15' } }, '2026-10-14', {}, '2026-10-15'],
    ['ends on a date: past the end', { freq: 'daily', end: { type: 'until', date: '2026-10-15' } }, '2026-10-15', {}, null],
    ['repeats 3 times: the 2nd generates the 3rd', { freq: 'daily', end: { type: 'count', count: 3 } }, '2026-10-14', { index: 2 }, '2026-10-15'],
    ['repeats 3 times: the 3rd is the last', { freq: 'daily', end: { type: 'count', count: 3 } }, '2026-10-14', { index: 3 }, null],
  ])('%s', (_what, input, due, options, expected) => {
    expect(next(input, due, options)).toBe(expected);
  });
});

describe('repeat rule schema', () => {
  it('fills defaults and normalizes weekdays', () => {
    expect(rule({ freq: 'weekly', weekdays: [5, 1, 5] })).toEqual({
      freq: 'weekly',
      interval: 1,
      weekdays: [1, 5],
      basis: 'due',
      skipHolidays: false,
      end: { type: 'never' },
    });
  });
  it.each<[string, unknown]>([
    ['interval on a 工作日 rule', { freq: 'workday', interval: 2 }],
    ['weekdays on a daily rule', { freq: 'daily', weekdays: [1] }],
    ['month on a monthly rule', { freq: 'monthly', month: 2 }],
    ['interval 0', { freq: 'daily', interval: 0 }],
    ['count 0', { freq: 'daily', end: { type: 'count', count: 0 } }],
    ['bad until date', { freq: 'daily', end: { type: 'until', date: '2026-02-30' } }],
    ['unknown field', { freq: 'daily', foo: 1 }],
  ])('rejects %s', (_what, input) => {
    expect(repeatRuleSchema.safeParse(input).success).toBe(false);
  });
});

describe('repeat labels', () => {
  it.each<[RepeatRuleInput, string, string]>([
    [{ freq: 'daily' }, '2026-10-13', '每天'],
    [{ freq: 'daily', interval: 3 }, '2026-10-13', '每3天'],
    [{ freq: 'weekly' }, '2026-10-13', '每周二'],
    [{ freq: 'weekly', weekdays: [0, 1, 3] }, '2026-10-13', '每周一、周三、周日'],
    [{ freq: 'weekly', weekdays: [1, 2, 3, 4, 5] }, '2026-10-13', '每周工作日（周一至周五）'],
    [{ freq: 'weekly', interval: 2, weekdays: [1] }, '2026-10-13', '每2周的周一'],
    [{ freq: 'monthly' }, '2026-10-13', '每月13日'],
    [{ freq: 'monthly', interval: 2, monthDay: 31 }, '2026-10-13', '每2个月的31日'],
    [{ freq: 'yearly' }, '2026-10-13', '每年10月13日'],
    [{ freq: 'workday' }, '2026-10-13', '每个工作日'],
    [{ freq: 'restday' }, '2026-10-13', '每个休息日'],
    [{ freq: 'month_first_workday' }, '2026-10-13', '每月第一个工作日'],
    [{ freq: 'month_last_workday' }, '2026-10-13', '每月最后一个工作日'],
    [
      { freq: 'weekly', weekdays: [1], basis: 'completion', skipHolidays: true, end: { type: 'until', date: '2026-12-31' } },
      '2026-10-13',
      '每周一，按完成日期，跳过法定节假日，到2026年12月31日结束',
    ],
    [{ freq: 'daily', end: { type: 'count', count: 5 } }, '2026-10-13', '每天，重复5次'],
  ])('%j → %s', (input, anchor, expected) => {
    expect(describeRepeatRule(rule(input), anchor)).toBe(expected);
  });
});

describe('next instance dates', () => {
  it('all-day: keeps the span length', () => {
    expect(shiftTaskDates({ allDay: true, startDate: '2026-10-12', dueDate: '2026-10-14' }, '2026-10-21')).toEqual({
      allDay: true,
      startDate: '2026-10-19',
      dueDate: '2026-10-21',
    });
    expect(shiftTaskDates({ allDay: true, startDate: null, dueDate: '2026-10-14' }, '2026-10-15')).toEqual({
      allDay: true,
      startDate: null,
      dueDate: '2026-10-15',
    });
  });

  it('timed: same wall-clock time in the task time zone, same duration', () => {
    // 22:00 in Shanghai on 10-14 is 14:00Z.
    const dates = { allDay: false as const, startAt: '2026-10-14T13:00:00.000Z', dueAt: '2026-10-14T14:00:00.000Z', timeZone: 'Asia/Shanghai' };
    expect(dueDayOf(dates)).toBe('2026-10-14');
    expect(shiftTaskDates(dates, '2026-10-15')).toEqual({
      allDay: false,
      startAt: '2026-10-15T13:00:00.000Z',
      dueAt: '2026-10-15T14:00:00.000Z',
    });
  });

  it('timed: the due day is taken in the task time zone, across a DST change', () => {
    // 2026-10-31 20:00 in New York (EDT, -4) → 2026-11-02 20:00 (EST, -5).
    const dates = { allDay: false as const, startAt: null, dueAt: '2026-11-01T00:00:00.000Z', timeZone: 'America/New_York' };
    expect(dueDayOf(dates)).toBe('2026-10-31');
    expect(shiftTaskDates(dates, '2026-11-02')).toEqual({ allDay: false, startAt: null, dueAt: '2026-11-03T01:00:00.000Z' });
  });
});
