import type { CountdownCalendar, CountdownOccurrence, CountdownRepeat } from './countdowns.js';
import { daysInMonth, formatCivilDate, parseCivilDate } from './civil-date.js';
import { lunarToSolar, solarToLunar } from './lunar.js';
import { reminderKey, type Reminder, type ReminderContext } from './reminders.js';
import { addDays, daysBetween, zonedToInstant } from './task-dates.js';

/*
 * 倒数日 dates (spec 用户故事 99–101): which 公历 day a 倒数日 falls on each
 * year, the next occurrence from today, and when its reminders fire.
 * Exported as `@dida/shared/countdown` because it loads the 农历 module
 * (`@dida/shared/lunar`), which stays out of the web bundle.
 *
 * Yearly repeat:
 * - 公历: the same month and day; 2月29日 falls on 2月28日 in common years.
 * - 农历: the same 农历 month and day of every 农历 year. Days past the end of
 *   a short month (三十 of a 29-day month, e.g. 除夕 on 腊月廿九) fall on the
 *   month's last day. A 闰月 date repeats in that 闰月 in years that have it
 *   and in the ordinary month of the same number otherwise; an ordinary-month
 *   date always stays in the ordinary month.
 */

export interface CountdownDate {
  /** 公历 date as entered. */
  date: string;
  calendar: CountdownCalendar;
  repeat: CountdownRepeat;
}

/** The 公历 date of the `year`-th occurrence (公历 year, or 农历 year for 农历). */
function occurrenceInYear(c: CountdownDate, year: number): string {
  if (c.calendar === 'solar') {
    const { month, day } = parseCivilDate(c.date);
    return formatCivilDate({ year, month, day: Math.min(day, daysInMonth(year, month)) });
  }
  const { month, day, isLeapMonth } = solarToLunar(c.date);
  // 三十 → 廿九 when the month is short; a 闰月 the year lacks gives null for every day.
  const days = day === 30 ? [30, 29] : [day];
  for (const leap of isLeapMonth ? [true, false] : [false]) {
    for (const d of days) {
      const solar = lunarToSolar({ year, month, day: d, isLeapMonth: leap });
      if (solar) return solar;
    }
  }
  // Every 农历 month has at least 29 days, so the ordinary month always resolves.
  throw new RangeError(`no occurrence of ${c.date} in 农历 ${year}`);
}

function yearOf(c: CountdownDate, date: string): number {
  return c.calendar === 'solar' ? parseCivilDate(date).year : solarToLunar(date).year;
}

/**
 * Occurrences on or after `from`, earliest first: just `date` for a one-off
 * 倒数日 (if not before `from`), every year from `date` on for a yearly one.
 */
export function* occurrencesFrom(c: CountdownDate, from: string): Generator<string> {
  if (c.repeat === 'none') {
    if (c.date >= from) yield c.date;
    return;
  }
  const start = from > c.date ? from : c.date;
  // The occurrence of the previous year can still be ahead (a 农历 腊月 date
  // falls in the next 公历 year), so start one year back.
  for (let year = yearOf(c, start) - 1; ; year += 1) {
    const date = occurrenceInYear(c, year);
    if (date >= start) yield date;
  }
}

/** What the card shows today: the next occurrence, or the passed one-off date (纪念日). */
export function nextOccurrence(c: CountdownDate, today: string): CountdownOccurrence {
  const next = occurrencesFrom(c, today).next();
  const date = next.done ? c.date : next.value;
  const diff = daysBetween(today, date);
  return { date, days: Math.abs(diff), status: diff === 0 ? 'today' : diff > 0 ? 'upcoming' : 'passed' };
}

/** 农历 month and day names of a 公历 date (正月, 初一). */
export function lunarLabel(date: string): { monthName: string; dayName: string } {
  const info = solarToLunar(date);
  return { monthName: info.monthName, dayName: info.dayName };
}

export interface CountdownReminderTarget extends CountdownDate {
  reminders: Reminder[];
}

/**
 * For each reminder, the first instant after `after` it fires at: N days
 * before an occurrence, at its time (or the 全天提醒时间) in the user's time
 * zone. A one-off 倒数日 has none once they are past; a yearly one moves on
 * to the next year.
 */
export function countdownReminderSchedule(
  c: CountdownReminderTarget,
  after: Date,
  ctx: ReminderContext,
): { key: string; fireAt: Date; occurrence: string }[] {
  // No reminder fires after its occurrence, so occurrences before (the user's) yesterday never matter.
  const from = addDays(after.toISOString().slice(0, 10), -1);
  return c.reminders.flatMap((r) => {
    if (r.type !== 'day') return [];
    let n = 0;
    for (const occurrence of occurrencesFrom(c, from)) {
      const fireAt = new Date(zonedToInstant(addDays(occurrence, -r.daysBefore), r.time ?? ctx.allDayTime, ctx.timeZone));
      if (fireAt.getTime() > after.getTime()) return [{ key: reminderKey(r), fireAt, occurrence }];
      // A reminder at most 60 days ahead: the second or third occurrence always fires later.
      if ((n += 1) >= 3) break;
    }
    return [];
  });
}
