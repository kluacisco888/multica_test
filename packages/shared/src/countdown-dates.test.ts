import { describe, expect, it } from 'vitest';
import { countdownReminderSchedule, lunarLabel, nextOccurrence, occurrencesFrom } from './countdown-dates.js';

/*
 * 倒数日 dates (spec 用户故事 99–101). Expected 农历 dates come from the
 * published Chinese calendar: 春节 2027-02-06 and 2028-01-26; 除夕 is
 * 腊月三十 in 2023 (2024-02-09) and 2026 (2027-02-05) but 腊月廿九 in 2024
 * (2025-01-28) and 2025 (2026-02-16); 2023 had a 闰二月, 2025 a 闰六月.
 */

const solar = (date: string, repeat: 'none' | 'yearly' = 'yearly') => ({ date, calendar: 'solar' as const, repeat });
const lunar = (date: string, repeat: 'none' | 'yearly' = 'yearly') => ({ date, calendar: 'lunar' as const, repeat });
const take = (gen: Iterable<string>, n: number) => {
  const out: string[] = [];
  for (const d of gen) {
    out.push(d);
    if (out.length === n) break;
  }
  return out;
};

describe('nextOccurrence', () => {
  it('counts down to a one-off date and up from it once passed (纪念日)', () => {
    expect(nextOccurrence(solar('2026-10-17', 'none'), '2026-10-14')).toEqual({ date: '2026-10-17', days: 3, status: 'upcoming' });
    expect(nextOccurrence(solar('2014-12-08', 'none'), '2026-10-14')).toEqual({ date: '2014-12-08', days: 4328, status: 'passed' });
    expect(nextOccurrence(solar('2026-10-14', 'none'), '2026-10-14')).toEqual({ date: '2026-10-14', days: 0, status: 'today' });
  });

  it('repeats a 公历 date every year: today counts, otherwise the next one', () => {
    expect(nextOccurrence(solar('2000-10-14'), '2026-10-14')).toEqual({ date: '2026-10-14', days: 0, status: 'today' });
    expect(nextOccurrence(solar('2000-10-13'), '2026-10-14')).toEqual({ date: '2027-10-13', days: 364, status: 'upcoming' });
    expect(nextOccurrence(solar('2000-01-01'), '2026-12-31')).toEqual({ date: '2027-01-01', days: 1, status: 'upcoming' });
  });

  it('does not repeat before the first date', () => {
    expect(nextOccurrence(solar('2030-05-01'), '2026-10-14')).toMatchObject({ date: '2030-05-01', status: 'upcoming' });
  });

  it('moves 2月29日 to 2月28日 in common years', () => {
    expect(take(occurrencesFrom(solar('2024-02-29'), '2024-01-01'), 5)).toEqual(['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29']);
  });

  it('repeats a 农历 date on its 农历 day (春节, like the reference card)', () => {
    expect(nextOccurrence(lunar('2026-02-17'), '2026-10-14')).toEqual({ date: '2027-02-06', days: 115, status: 'upcoming' });
    expect(nextOccurrence(lunar('2026-02-17'), '2027-02-06')).toEqual({ date: '2027-02-06', days: 0, status: 'today' });
    expect(nextOccurrence(lunar('2026-02-17'), '2027-02-07')).toMatchObject({ date: '2028-01-26' });
  });

  it('crosses the 公历 new year: a 腊月 date of 农历 year N falls in 公历 year N+1', () => {
    const lateLunar = lunar('2025-01-14'); // 农历 2024 腊月十五
    expect(lunarLabel('2025-01-14')).toEqual({ monthName: '腊月', dayName: '十五' });
    // On 2025-12-31 the next one is 农历 2025 腊月十五, already in 公历 2026.
    expect(nextOccurrence(lateLunar, '2025-12-31')).toEqual({ date: '2026-02-02', days: 33, status: 'upcoming' });
    // After it, the next is 农历 2026 腊月十五, in January 2027: 公历 2026 has no other occurrence.
    expect(nextOccurrence(lateLunar, '2026-02-03')).toEqual({ date: '2027-01-22', days: 353, status: 'upcoming' });
    expect(nextOccurrence(lateLunar, '2026-12-31')).toEqual({ date: '2027-01-22', days: 22, status: 'upcoming' });
    expect(lunarLabel('2027-01-22')).toEqual({ monthName: '腊月', dayName: '十五' });
  });

  it('keeps 腊月三十 (除夕) on the last day of 腊月 in years where 腊月 has 29 days', () => {
    expect(take(occurrencesFrom(lunar('2024-02-09'), '2024-01-01'), 4)).toEqual(['2024-02-09', '2025-01-28', '2026-02-16', '2027-02-05']);
    expect(nextOccurrence(lunar('2024-02-09'), '2025-12-31')).toEqual({ date: '2026-02-16', days: 47, status: 'upcoming' });
  });

  it('repeats a 闰月 date in the ordinary month of years without that 闰月', () => {
    // 2023 闰二月十五 (2023-04-05) → 2024 二月十五 (2024-03-24; 二月二 2024 was 2024-03-11).
    expect(take(occurrencesFrom(lunar('2023-04-05'), '2023-01-01'), 2)).toEqual(['2023-04-05', '2024-03-24']);
    // 2025 闰六月初一 (2025-07-25) → 2026 has no 闰六月: 六月初一 (2026-07-14).
    expect(take(occurrencesFrom(lunar('2025-07-25'), '2025-01-01'), 2)).toEqual(['2025-07-25', '2026-07-14']);
    expect(lunarLabel('2026-07-14')).toEqual({ monthName: '六月', dayName: '初一' });
    // 2036 has a 闰六月 again: the date goes back to it (2036-07-23), not 六月初一 (2036-06-24).
    expect(nextOccurrence(lunar('2025-07-25'), '2036-01-01').date).toBe('2036-07-23');
    expect(lunarLabel('2036-07-23')).toEqual({ monthName: '闰六月', dayName: '初一' });
  });

  it('keeps the ordinary month for an ordinary-month date in a year with that 闰月', () => {
    // 2025 六月初一 (2025-06-25), not 闰六月初一.
    expect(take(occurrencesFrom(lunar('2025-06-25'), '2025-01-01'), 1)).toEqual(['2025-06-25']);
    expect(nextOccurrence(lunar('2025-06-25'), '2036-01-01').date).toBe('2036-06-24');
  });

  it('a one-off 农历 倒数日 is just its 公历 date', () => {
    expect(nextOccurrence(lunar('2026-02-17', 'none'), '2026-10-14')).toEqual({ date: '2026-02-17', days: 239, status: 'passed' });
  });
});

describe('countdownReminderSchedule', () => {
  const ctx = { timeZone: 'Asia/Shanghai', allDayTime: '09:00' };
  const springFestival = { ...lunar('2026-02-17'), reminders: [{ type: 'day' as const, daysBefore: 1, time: null }] };

  it('fires N days before the next occurrence at the time of day in the user time zone', () => {
    expect(countdownReminderSchedule(springFestival, new Date('2026-10-14T00:00:00Z'), ctx)).toEqual([
      { key: 'day:1@default', fireAt: new Date('2027-02-05T01:00:00Z'), occurrence: '2027-02-06' },
    ]);
  });

  it('moves on to the next year once this year’s reminder has fired', () => {
    expect(countdownReminderSchedule(springFestival, new Date('2027-02-05T01:00:00Z'), ctx)).toEqual([
      { key: 'day:1@default', fireAt: new Date('2028-01-25T01:00:00Z'), occurrence: '2028-01-26' },
    ]);
  });

  it('skips to the next occurrence when the lead time is already past', () => {
    const c = { ...solar('2000-10-17'), reminders: [{ type: 'day' as const, daysBefore: 7, time: '20:30' }] };
    expect(countdownReminderSchedule(c, new Date('2026-10-14T00:00:00Z'), ctx)).toEqual([
      { key: 'day:7@20:30', fireAt: new Date('2027-10-10T12:30:00Z'), occurrence: '2027-10-17' },
    ]);
  });

  it('has nothing left for a one-off date once its reminders are past', () => {
    const c = { ...solar('2026-10-17', 'none'), reminders: [{ type: 'day' as const, daysBefore: 0, time: '09:00' }] };
    expect(countdownReminderSchedule(c, new Date('2026-10-17T00:59:00Z'), ctx)).toHaveLength(1);
    expect(countdownReminderSchedule(c, new Date('2026-10-17T01:00:00Z'), ctx)).toEqual([]);
  });

  it('ignores reminders that are not day reminders', () => {
    const c = { ...solar('2026-10-17', 'none'), reminders: [{ type: 'before' as const, minutes: 5 }] };
    expect(countdownReminderSchedule(c, new Date('2026-10-01T00:00:00Z'), ctx)).toEqual([]);
  });
});
