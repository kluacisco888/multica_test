import { z } from 'zod';

/*
 * Civil (calendar) dates as `YYYY-MM-DD` strings: a day on the wall calendar,
 * with no time and no time zone. Used by the 工作日日历 and the 农历 module.
 */

export interface CivilDate {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parsed parts of a real `YYYY-MM-DD` date, or null (wrong format, 2026-02-30, …). */
export function tryParseCivilDate(date: string): CivilDate | null {
  const match = ISO_DATE.exec(date);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

/** Like `tryParseCivilDate`, but throws a RangeError for an invalid date. */
export function parseCivilDate(date: string): CivilDate {
  const parsed = tryParseCivilDate(date);
  if (!parsed) throw new RangeError(`not a valid YYYY-MM-DD date: ${JSON.stringify(date)}`);
  return parsed;
}

export function formatCivilDate({ year, month, day }: CivilDate): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 0 = Sunday … 6 = Saturday. */
export function dayOfWeek({ year, month, day }: CivilDate): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export const civilDateSchema = z.string().refine((value) => tryParseCivilDate(value) !== null, '日期格式应为 YYYY-MM-DD');
