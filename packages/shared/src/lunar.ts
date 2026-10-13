// lunar-javascript ships no types. The reference (not a tsconfig include) makes ours visible to
// every program that compiles this file through the `source` export condition (server, web).
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./lunar-javascript.d.ts" />
import lunarLib from 'lunar-javascript';
import { formatCivilDate, parseCivilDate } from './civil-date.js';

/*
 * 农历 (Chinese lunisolar calendar) and 传统节日, wrapping lunar-javascript.
 * Exported as `@dida/shared/lunar` rather than from the package index so the
 * ~400 KB library only lands in bundles that actually use it.
 */

const { Solar, Lunar, LunarYear } = lunarLib;

/** A 农历 date. `month` is 1–12; a leap month (闰月) repeats the month number with `isLeapMonth`. */
export interface LunarDate {
  year: number;
  month: number;
  day: number;
  isLeapMonth: boolean;
}

export interface LunarDayInfo extends LunarDate {
  /** 正月, 二月 … 冬月, 腊月, 闰六月 */
  monthName: string;
  /** 初一 … 三十 */
  dayName: string;
  /** 干支纪年 of the 农历 year, e.g. 丙午 */
  yearGanZhi: string;
  /** 生肖 of the 农历 year, e.g. 马 */
  zodiac: string;
  /** 节气 that starts on this day, e.g. 清明; null on other days. */
  solarTerm: string | null;
  /** 传统节日 on this day (see `traditionalFestivals`). */
  festivals: string[];
}

/** 公历 `YYYY-MM-DD` → 农历. Throws RangeError for an invalid date. */
export function solarToLunar(date: string): LunarDayInfo {
  const { year, month, day } = parseCivilDate(date);
  const lunar = Solar.fromYmd(year, month, day).getLunar();
  const rawMonth = lunar.getMonth();
  const solarTerm = lunar.getJieQi() || null;
  return {
    year: lunar.getYear(),
    month: Math.abs(rawMonth),
    day: lunar.getDay(),
    isLeapMonth: rawMonth < 0,
    monthName: `${lunar.getMonthInChinese()}月`,
    dayName: lunar.getDayInChinese(),
    yearGanZhi: lunar.getYearInGanZhi(),
    zodiac: lunar.getYearShengXiao(),
    solarTerm,
    festivals: festivalsOf(lunar.getFestivals(), solarTerm),
  };
}

/** 农历 → 公历 `YYYY-MM-DD`; null when that 农历 date does not exist (no such leap month, day 30 of a short month, …). */
export function lunarToSolar({ year, month, day, isLeapMonth }: LunarDate): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 30) return null;
  const lunarYear = LunarYear.fromYear(year);
  if (isLeapMonth && lunarYear.getLeapMonth() !== month) return null;
  const lunarMonth = lunarYear.getMonth(isLeapMonth ? -month : month);
  if (!lunarMonth || day > lunarMonth.getDayCount()) return null;
  const solar = Lunar.fromYmd(year, isLeapMonth ? -month : month, day).getSolar();
  return formatCivilDate({ year: solar.getYear(), month: solar.getMonth(), day: solar.getDay() });
}

/**
 * 传统节日 on a 公历 date: the lunar festivals (春节, 元宵节, 端午节, 七夕节,
 * 中秋节, 重阳节, 腊八节, 除夕 …) plus 清明节, which follows the solar term.
 */
export function traditionalFestivals(date: string): string[] {
  return solarToLunar(date).festivals;
}

function festivalsOf(lunarFestivals: string[], solarTerm: string | null): string[] {
  return solarTerm === '清明' ? [...lunarFestivals, '清明节'] : [...lunarFestivals];
}

/**
 * 公历节日 the 日历 shows (元旦, 国庆节, 圣诞节 …), named like the reference.
 * lunar-javascript also lists 纪念日 such as 世界住房日; the reference leaves
 * those out (checked on 2026-10-05), so only these are kept.
 */
const SOLAR_FESTIVAL_NAMES: Readonly<Record<string, string>> = {
  元旦节: '元旦',
  情人节: '情人节',
  妇女节: '妇女节',
  植树节: '植树节',
  愚人节: '愚人节',
  劳动节: '劳动节',
  青年节: '青年节',
  母亲节: '母亲节',
  儿童节: '儿童节',
  父亲节: '父亲节',
  建党节: '建党节',
  建军节: '建军节',
  教师节: '教师节',
  国庆节: '国庆节',
  万圣节前夜: '万圣夜',
  万圣节: '万圣节',
  感恩节: '感恩节',
  平安夜: '平安夜',
  圣诞节: '圣诞节',
};

/** 公历节日 on a `YYYY-MM-DD` date. Throws RangeError for an invalid date. */
export function solarFestivals(date: string): string[] {
  const { year, month, day } = parseCivilDate(date);
  return Solar.fromYmd(year, month, day)
    .getFestivals()
    .flatMap((name: string) => SOLAR_FESTIVAL_NAMES[name] ?? []);
}
