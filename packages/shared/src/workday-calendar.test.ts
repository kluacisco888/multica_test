import { describe, expect, it } from 'vitest';
import { createWorkdayCalendar, holidayYearSchema, type DayKind, type HolidayYear } from './workday-calendar.js';

/*
 * 工作日日历 (ADR-0006, spec 用户故事 45–50、114、115). Fixed data in the
 * NateScarlet/holiday-cn format, excerpted from its published 2025.json / 2026.json.
 */

const y2025: HolidayYear = {
  year: 2025,
  days: [
    { name: '元旦', date: '2025-01-01', isOffDay: true },
    { name: '春节', date: '2025-01-26', isOffDay: false },
    { name: '春节', date: '2025-01-28', isOffDay: true },
    { name: '春节', date: '2025-01-29', isOffDay: true },
    { name: '春节', date: '2025-01-30', isOffDay: true },
    { name: '春节', date: '2025-01-31', isOffDay: true },
    { name: '春节', date: '2025-02-01', isOffDay: true },
    { name: '春节', date: '2025-02-02', isOffDay: true },
    { name: '春节', date: '2025-02-03', isOffDay: true },
    { name: '春节', date: '2025-02-04', isOffDay: true },
    { name: '春节', date: '2025-02-08', isOffDay: false },
    { name: '国庆节、中秋节', date: '2025-09-28', isOffDay: false },
    { name: '国庆节、中秋节', date: '2025-10-01', isOffDay: true },
    { name: '国庆节、中秋节', date: '2025-10-08', isOffDay: true },
    { name: '国庆节、中秋节', date: '2025-10-11', isOffDay: false },
  ],
};

const y2026: HolidayYear = {
  year: 2026,
  days: [
    { name: '元旦', date: '2026-01-01', isOffDay: true },
    { name: '元旦', date: '2026-01-02', isOffDay: true },
    { name: '元旦', date: '2026-01-03', isOffDay: true },
    { name: '元旦', date: '2026-01-04', isOffDay: false },
    { name: '劳动节', date: '2026-05-01', isOffDay: true },
    { name: '劳动节', date: '2026-05-04', isOffDay: true },
    { name: '劳动节', date: '2026-05-09', isOffDay: false },
    { name: '国庆节', date: '2026-10-01', isOffDay: true },
    { name: '国庆节', date: '2026-10-03', isOffDay: true },
    { name: '国庆节', date: '2026-10-10', isOffDay: false },
  ],
};

const calendar = createWorkdayCalendar([y2025, y2026]);

describe('workday calendar', () => {
  it.each<[string, string, DayKind, boolean, string | null]>([
    // date, what it is, kind, isWorkday, holidayName
    ['2025-10-01', '法定假日（周三）', 'holiday', false, '国庆节、中秋节'],
    ['2025-01-28', '春节（周二）', 'holiday', false, '春节'],
    ['2026-01-03', '落在周六的法定假日', 'holiday', false, '元旦'],
    ['2026-05-04', '法定假日（周一）', 'holiday', false, '劳动节'],
    ['2025-01-26', '调休补班的周日', 'makeup_workday', true, '春节'],
    ['2025-02-08', '调休补班的周六', 'makeup_workday', true, '春节'],
    ['2025-09-28', '调休补班的周日', 'makeup_workday', true, '国庆节、中秋节'],
    ['2026-01-04', '调休补班的周日', 'makeup_workday', true, '元旦'],
    ['2026-10-10', '调休补班的周六', 'makeup_workday', true, '国庆节'],
    ['2025-10-09', '假期后的普通周四', 'workday', true, null],
    ['2026-05-06', '普通周三', 'workday', true, null],
    ['2026-05-10', '补班后的普通周日', 'weekend', false, null],
    ['2025-10-12', '普通周日', 'weekend', false, null],
    // 2027 has no data yet: plain Monday–Friday.
    ['2027-02-08', '没有数据的年份：周一', 'workday', true, null],
    ['2027-02-12', '没有数据的年份：周五', 'workday', true, null],
    ['2027-02-13', '没有数据的年份：周六', 'weekend', false, null],
    ['2027-01-01', '没有数据的年份：元旦（周五）照常上班', 'workday', true, null],
    ['2024-10-01', '更早的没有数据的年份：周二', 'workday', true, null],
  ])('%s %s', (date, _what, kind, isWorkday, holidayName) => {
    const info = calendar.dayInfo(date);
    expect(info.kind).toBe(kind);
    expect(info.isWorkday).toBe(isWorkday);
    expect(info.isRestDay).toBe(!isWorkday);
    expect(info.holidayName).toBe(holidayName);
    expect(calendar.isWorkday(date)).toBe(isWorkday);
    expect(calendar.isRestDay(date)).toBe(!isWorkday);
    expect(calendar.isHoliday(date)).toBe(kind === 'holiday');
    expect(calendar.isMakeupWorkday(date)).toBe(kind === 'makeup_workday');
  });

  it('tells which years have data', () => {
    expect(calendar.hasYear(2025)).toBe(true);
    expect(calendar.hasYear(2026)).toBe(true);
    expect(calendar.hasYear(2027)).toBe(false);
    expect(calendar.dayInfo('2026-03-02').hasData).toBe(true);
    expect(calendar.dayInfo('2027-03-01').hasData).toBe(false);
    expect(calendar.years).toEqual([2025, 2026]);
  });

  it('treats a published file without days (next year not announced yet) as no data', () => {
    const cal = createWorkdayCalendar([{ year: 2027, days: [] }]);
    expect(cal.hasYear(2027)).toBe(false);
    expect(cal.years).toEqual([]);
  });

  it('with no data at all is plain Monday–Friday', () => {
    const empty = createWorkdayCalendar([]);
    expect(empty.isWorkday('2026-10-01')).toBe(true);
    expect(empty.isWorkday('2026-10-10')).toBe(false);
  });

  it('ignores days filed under another year', () => {
    // holiday-cn lists each day under the year it falls in; a stray entry must not leak.
    const cal = createWorkdayCalendar([{ year: 2026, days: [{ name: '元旦', date: '2027-01-01', isOffDay: true }] }]);
    expect(cal.isHoliday('2027-01-01')).toBe(false);
  });

  it.each(['2026-02-30', '2026-13-01', '2026-1-1', 'tomorrow', ''])('rejects the invalid date %j', (date) => {
    expect(() => calendar.dayInfo(date)).toThrow(RangeError);
  });
});

describe('holiday-cn year file schema', () => {
  it('accepts the published format and drops the extra fields', () => {
    const parsed = holidayYearSchema.parse({
      $schema: 'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/schema.json',
      year: 2026,
      papers: ['https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm'],
      days: [{ name: '元旦', date: '2026-01-01', isOffDay: true }],
    });
    expect(parsed).toEqual({
      year: 2026,
      papers: ['https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm'],
      days: [{ name: '元旦', date: '2026-01-01', isOffDay: true }],
    });
  });

  it.each([
    ['a bad date', { year: 2026, days: [{ name: '元旦', date: '2026/01/01', isOffDay: true }] }],
    ['a missing flag', { year: 2026, days: [{ name: '元旦', date: '2026-01-01' }] }],
    ['no year', { days: [] }],
  ])('rejects %s', (_what, value) => {
    expect(holidayYearSchema.safeParse(value).success).toBe(false);
  });
});
