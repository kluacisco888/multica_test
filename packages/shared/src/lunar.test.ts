import { describe, expect, it } from 'vitest';
import { lunarToSolar, solarFestivals, solarToLunar, traditionalFestivals } from './lunar.js';

/*
 * 农历 module (spec 用户故事 70、100). Expected values come from the published
 * Chinese calendar (e.g. 2026 春节 is 2026-02-17, 2025 has a 闰六月, 2023 a 闰二月).
 */

describe('solarToLunar', () => {
  it.each([
    // date, year, month, day, leap, monthName, dayName, ganZhi, zodiac
    ['2026-02-17', 2026, 1, 1, false, '正月', '初一', '丙午', '马'],
    ['2026-02-16', 2025, 12, 29, false, '腊月', '廿九', '乙巳', '蛇'],
    ['2026-09-25', 2026, 8, 15, false, '八月', '十五', '丙午', '马'],
    ['2025-07-25', 2025, 6, 1, true, '闰六月', '初一', '乙巳', '蛇'],
    ['2025-06-25', 2025, 6, 1, false, '六月', '初一', '乙巳', '蛇'],
    ['2023-03-22', 2023, 2, 1, true, '闰二月', '初一', '癸卯', '兔'],
    ['2020-05-23', 2020, 4, 1, true, '闰四月', '初一', '庚子', '鼠'],
    ['2024-02-09', 2023, 12, 30, false, '腊月', '三十', '癸卯', '兔'],
  ])('%s → 农历 %i 年 %i 月 %i 日（闰月 %s）', (date, year, month, day, isLeapMonth, monthName, dayName, yearGanZhi, zodiac) => {
    expect(solarToLunar(date)).toMatchObject({ year, month, day, isLeapMonth, monthName, dayName, yearGanZhi, zodiac });
  });

  it('names the solar term (节气) of the day', () => {
    expect(solarToLunar('2026-04-05').solarTerm).toBe('清明');
    expect(solarToLunar('2026-12-22').solarTerm).toBe('冬至');
    expect(solarToLunar('2026-04-06').solarTerm).toBeNull();
  });

  it('rejects invalid dates', () => {
    expect(() => solarToLunar('2026-02-30')).toThrow(RangeError);
    expect(() => solarToLunar('20260217')).toThrow(RangeError);
  });
});

describe('lunarToSolar', () => {
  it.each([
    [{ year: 2026, month: 1, day: 1, isLeapMonth: false }, '2026-02-17'],
    [{ year: 2026, month: 8, day: 15, isLeapMonth: false }, '2026-09-25'],
    [{ year: 2025, month: 12, day: 29, isLeapMonth: false }, '2026-02-16'],
    [{ year: 2025, month: 6, day: 1, isLeapMonth: true }, '2025-07-25'],
    [{ year: 2025, month: 6, day: 1, isLeapMonth: false }, '2025-06-25'],
    [{ year: 2023, month: 2, day: 15, isLeapMonth: true }, '2023-04-05'],
    [{ year: 2023, month: 12, day: 30, isLeapMonth: false }, '2024-02-09'],
  ])('%o → %s', (lunar, expected) => {
    expect(lunarToSolar(lunar)).toBe(expected);
  });

  it('round-trips every day of a year with a leap month', () => {
    for (let t = Date.UTC(2025, 0, 1); t <= Date.UTC(2025, 11, 31); t += 86_400_000) {
      const date = new Date(t).toISOString().slice(0, 10);
      expect(lunarToSolar(solarToLunar(date))).toBe(date);
    }
  });

  it.each([
    ['a leap month the year does not have', { year: 2026, month: 6, day: 1, isLeapMonth: true }],
    ['day 30 of a 29-day month (2025 腊月 ends on 廿九)', { year: 2025, month: 12, day: 30, isLeapMonth: false }],
    ['month 13', { year: 2026, month: 13, day: 1, isLeapMonth: false }],
    ['day 0', { year: 2026, month: 1, day: 0, isLeapMonth: false }],
  ])('is null for %s', (_what, lunar) => {
    expect(lunarToSolar(lunar)).toBeNull();
  });
});

describe('traditionalFestivals', () => {
  it.each([
    ['2026-02-16', '除夕'],
    ['2026-02-17', '春节'],
    ['2026-03-03', '元宵节'],
    ['2026-04-05', '清明节'],
    ['2026-06-19', '端午节'],
    ['2026-08-19', '七夕节'],
    ['2026-09-25', '中秋节'],
    ['2026-10-18', '重阳节'],
    ['2026-01-26', '腊八节'],
    // 腊月 of 2023 has 30 days: 除夕 is the 30th, not the 29th.
    ['2024-02-09', '除夕'],
  ])('%s is %s', (date, festival) => {
    expect(traditionalFestivals(date)).toContain(festival);
  });

  it('is empty on an ordinary day', () => {
    expect(traditionalFestivals('2026-10-13')).toEqual([]);
    expect(traditionalFestivals('2024-02-08')).toEqual([]);
  });

  it('comes with solarToLunar too', () => {
    expect(solarToLunar('2026-09-25').festivals).toEqual(['中秋节']);
  });
});

describe('solarFestivals', () => {
  // The reference 日历 (2026-10, ADR-0008) labels 10-01 国庆节 and 10-31 万圣夜, but not 10-05 世界住房日.
  it.each([
    ['2026-10-01', ['国庆节']],
    ['2026-10-31', ['万圣夜']],
    ['2026-10-05', []],
    ['2026-01-01', ['元旦']],
    ['2026-12-25', ['圣诞节']],
    ['2026-03-15', []],
    ['2026-10-13', []],
  ])('%s → %j', (date, expected) => {
    expect(solarFestivals(date)).toEqual(expected);
  });
});
