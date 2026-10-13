import { z } from 'zod';
import { civilDateSchema, dayOfWeek, parseCivilDate } from './civil-date.js';

/*
 * 工作日日历 (ADR-0006): answers whether a day is a 工作日, a rest day, a
 * statutory holiday (法定假日) or a 调休补班 weekend, from the per-year
 * NateScarlet/holiday-cn data. A year without data falls back to plain
 * Monday–Friday. Pure: the server and the web app feed it whatever years they have.
 */

/** One day listed in a holiday-cn year file. */
export const holidayDaySchema = z.object({
  /** Holiday the arrangement belongs to, e.g. 春节, 国庆节、中秋节. */
  name: z.string(),
  date: civilDateSchema,
  /** true: 法定假日 (day off); false: 调休补班 (a weekend that is a 工作日). */
  isOffDay: z.boolean(),
});
export type HolidayDay = z.infer<typeof holidayDaySchema>;

/** A holiday-cn `<year>.json` file (unknown fields such as `$schema` are dropped). */
export const holidayYearSchema = z.object({
  year: z.number().int().min(1900).max(9999),
  /** Links to the State Council notices; optional in our own fixtures. */
  papers: z.array(z.string()).optional(),
  days: z.array(holidayDaySchema),
});
export type HolidayYear = z.infer<typeof holidayYearSchema>;

/**
 * - `workday`: an ordinary Monday–Friday
 * - `weekend`: an ordinary Saturday/Sunday
 * - `holiday`: 法定假日 (may fall on any weekday)
 * - `makeup_workday`: 调休补班, a weekend day that is a 工作日
 */
export type DayKind = 'workday' | 'weekend' | 'holiday' | 'makeup_workday';

export interface DayInfo {
  date: string;
  kind: DayKind;
  /** 工作日: workday or makeup_workday. */
  isWorkday: boolean;
  /** 休息日: weekend or holiday. */
  isRestDay: boolean;
  isHoliday: boolean;
  isMakeupWorkday: boolean;
  /** Holiday a 法定假日 / 调休补班 belongs to; null for ordinary days. */
  holidayName: string | null;
  /** Whether holiday data exists for this day's year (false: Monday–Friday guess). */
  hasData: boolean;
}

export interface WorkdayCalendar {
  /** Throws RangeError for anything but a real `YYYY-MM-DD` date. */
  dayInfo(date: string): DayInfo;
  isWorkday(date: string): boolean;
  isRestDay(date: string): boolean;
  isHoliday(date: string): boolean;
  isMakeupWorkday(date: string): boolean;
  hasYear(year: number): boolean;
  /** Years with data, ascending. */
  readonly years: readonly number[];
}

/**
 * Build a calendar from holiday-cn year data. A year whose file lists no days
 * (the next year before the State Council announces it) counts as no data.
 */
export function createWorkdayCalendar(years: readonly HolidayYear[]): WorkdayCalendar {
  const listed = new Map<string, HolidayDay>();
  const covered = new Set<number>();
  for (const { year, days } of years) {
    const own = days.filter((d) => parseCivilDate(d.date).year === year);
    if (own.length === 0) continue;
    covered.add(year);
    for (const day of own) listed.set(day.date, day);
  }

  function dayInfo(date: string): DayInfo {
    const parts = parseCivilDate(date);
    const entry = listed.get(date);
    const weekday = dayOfWeek(parts);
    const isWeekend = weekday === 0 || weekday === 6;
    const kind: DayKind = entry ? (entry.isOffDay ? 'holiday' : 'makeup_workday') : isWeekend ? 'weekend' : 'workday';
    const isWorkday = kind === 'workday' || kind === 'makeup_workday';
    return {
      date,
      kind,
      isWorkday,
      isRestDay: !isWorkday,
      isHoliday: kind === 'holiday',
      isMakeupWorkday: kind === 'makeup_workday',
      holidayName: entry?.name ?? null,
      hasData: covered.has(parts.year),
    };
  }

  return {
    dayInfo,
    isWorkday: (date) => dayInfo(date).isWorkday,
    isRestDay: (date) => dayInfo(date).isRestDay,
    isHoliday: (date) => dayInfo(date).isHoliday,
    isMakeupWorkday: (date) => dayInfo(date).isMakeupWorkday,
    hasYear: (year) => covered.has(year),
    years: [...covered].sort((a, b) => a - b),
  };
}
