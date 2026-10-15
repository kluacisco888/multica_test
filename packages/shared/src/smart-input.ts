import { z } from 'zod';
import { daysInMonth } from './civil-date.js';
import type { RepeatRuleInput } from './repeat-rule.js';
import { reminderFits, sortReminders, timeOfDaySchema, type Reminder } from './reminders.js';
import { addDays, todayIn, weekday, zonedDateTime, zonedToInstant, type TaskDates, type TaskDatesInput } from './task-dates.js';
import { TAG_NAME_MAX_LENGTH } from './tags.js';
import type { CreateTaskRequest, Priority } from './tasks.js';

/*
 * 智能识别解析器 (spec 用户故事 51–58, Q45). Pure: the caller passes the raw
 * title, "now", the time zone, the 模糊时间 settings and the user's 清单.
 * Out come the recognised parts, each with its place in the original text
 * (for highlighting and 取消识别), what they set on the task, and the title
 * with the recognised text taken out (unless 保留识别文字).
 *
 * The rules follow what 滴答 does with the same text (EURO-39 核对表: typed
 * into 滴答's 添加任务 field on 2026-10-15). Recognised:
 *   - dates: 今天 / 明天 / 后天 / 大后天, 周X / 星期X / 礼拜X (the next one,
 *     today included), 本周X / 这周X / 下周X / 下下周X (weeks start on
 *     Monday), 下周 (next Monday), 周末 (the coming Saturday), 下周末 /
 *     下个周末 (next week's Saturday), 下个月 (the 1st), M月D日, YYYY年M月D日,
 *     D号 (this month, next month once passed), N天后; N小时后 / N分钟后 set
 *     the time (now + N, to the minute; a second time after 下午3点 …);
 *   - times: 上午, 下午, 晚上 (模糊时间, 滴答: 09:00 / 15:00 / 20:00),
 *     早上 07:00, 中午 12:00, 傍晚 17:00, 凌晨, a clock time after them
 *     (下午3点, 晚上8点半, 上午九点一刻), N点 (digits or Chinese) / HH:mm.
 *     A time without a date is today, or tomorrow once it has passed; a bare
 *     N点 (1–12) without a date is the next such hour, morning or evening
 *     (14:45: 9点 → 21:00, 十二点 → 00:00);
 *   - 重复规则: 每天, 每N天, 每周, 每周X(和周X), 每N周, 每个周末, 每个工作日,
 *     每月, 每月D号, 每年, 每年M月D日. Without a date the first instance is
 *     the first rule date from today on, and with a time one whose time has
 *     not passed yet;
 *   - 提醒: 提醒我 (准时 / 当天; only with a date, time or 重复; once),
 *     *提前N分钟 / 小时 / 天 (minutes or hours on a date without a time make
 *     it 00:00 that day);
 *   - #标签 (up to the next space), ~清单 (one of the user's 清单, longest
 *     name first), !高 / !中 / !低.
 *
 * 设置 → 智能识别: 日期识别 (`dateParse`) switches dates, times, 重复 and 提醒
 * on or off, 标签识别 (`tagParse`) #标签, ~清单 and !优先级; 移除文本中的日期
 * (`removeDate`) and 移除任务标题中的标签 (`removeTag`) take their text out of
 * the title.
 *
 * Each kind is set once: a second date (time, 重复, 优先级, 清单) stays text.
 *
 * The view's own date (`defaultDates`: the clicked day or slot in the 日历,
 * tomorrow in 明天 …) is the anchor when no date is written: a time alone
 * goes on that day, a 提醒 alone keeps the day or slot, a 重复规则 starts
 * from it. Without an anchor it is today.
 *
 * Not recognised (stays text): a #标签 longer than TAG_NAME_MAX_LENGTH, and
 * *提前N分钟 / 小时 when the task ends up 全天 (it could not hold them).
 */

/** 滴答's defaults: everything on, recognised text removed; 模糊时间 as 滴答 reads 上午 / 下午 / 晚上. */
export const DEFAULT_SMART_INPUT_SETTINGS = {
  dateParse: true,
  removeDate: true,
  tagParse: true,
  removeTag: true,
  urlParse: true,
  morning: '09:00',
  afternoon: '15:00',
  evening: '20:00',
} as const;

/**
 * EURO-27 stored a 总开关 (`enabled`) and 保留识别文字 (`keepText`). Read as
 * the new switches: 总开关 off turns all three off, 保留识别文字 unticks both
 * 移除. Fields of the new shape win when both are there.
 */
function migrateSmartInputSettings(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const { enabled, keepText, ...rest } = raw as Record<string, unknown>;
  const old: Record<string, boolean> = {};
  if (typeof enabled === 'boolean') Object.assign(old, { dateParse: enabled, tagParse: enabled, urlParse: enabled });
  if (typeof keepText === 'boolean') Object.assign(old, { removeDate: !keepText, removeTag: !keepText });
  return { ...old, ...rest };
}

/** 设置 → 智能识别, laid out as 滴答's. Missing fields take their defaults. */
export const smartInputSettingsSchema = z.preprocess(
  migrateSmartInputSettings,
  z.object({
    /** 日期识别: dates, times, 重复 and 提醒. */
    dateParse: z.boolean().default(DEFAULT_SMART_INPUT_SETTINGS.dateParse),
    /** 移除文本中的日期: take the recognised date text out of the title. */
    removeDate: z.boolean().default(DEFAULT_SMART_INPUT_SETTINGS.removeDate),
    /** 标签识别: #标签, ~清单 and !优先级. */
    tagParse: z.boolean().default(DEFAULT_SMART_INPUT_SETTINGS.tagParse),
    /** 移除任务标题中的标签: take them out of the title. */
    removeTag: z.boolean().default(DEFAULT_SMART_INPUT_SETTINGS.removeTag),
    /** 网址解析: a title that is a web address. */
    urlParse: z.boolean().default(DEFAULT_SMART_INPUT_SETTINGS.urlParse),
    /** 模糊时间 (spec 用户故事 58): 上午 / 下午 / 晚上, `HH:mm`. */
    morning: timeOfDaySchema.default(DEFAULT_SMART_INPUT_SETTINGS.morning),
    afternoon: timeOfDaySchema.default(DEFAULT_SMART_INPUT_SETTINGS.afternoon),
    evening: timeOfDaySchema.default(DEFAULT_SMART_INPUT_SETTINGS.evening),
  }),
);
export type SmartInputSettings = z.infer<typeof smartInputSettingsSchema>;

/** `PATCH /api/settings` `{ smartInput: {...} }`: any subset. */
export const smartInputSettingsPatchSchema = z
  .object({
    dateParse: z.boolean(),
    removeDate: z.boolean(),
    tagParse: z.boolean(),
    removeTag: z.boolean(),
    urlParse: z.boolean(),
    morning: timeOfDaySchema,
    afternoon: timeOfDaySchema,
    evening: timeOfDaySchema,
  })
  .partial()
  .strict();

export type SmartTokenKind = 'date' | 'time' | 'repeat' | 'reminder' | 'tag' | 'list' | 'priority';

export interface SmartToken {
  kind: SmartTokenKind;
  /** The recognised text, `text.slice(start, end)` of the input. */
  text: string;
  start: number;
  end: number;
}

export interface SmartParseContext {
  now: Date;
  timeZone: string;
  fuzzyTimes: { morning: string; afternoon: string; evening: string };
  /** The user's 清单, for ~清单. */
  lists?: readonly { id: string; name: string }[];
  /** 工作日 test for the first instance of 每个工作日 / 每个休息日; default Monday–Friday. */
  isWorkday?: (date: string) => boolean;
  /** 日期识别 (default on): dates, times, 重复 and 提醒. */
  dateParse?: boolean;
  /** 标签识别 (default on): #标签, ~清单 and !优先级. */
  tagParse?: boolean;
  /** 移除文本中的日期 (default on). */
  removeDate?: boolean;
  /** 移除任务标题中的标签 (default on). */
  removeTag?: boolean;
  /** Texts the user cancelled (点一下取消识别): they stay plain text. */
  ignored?: readonly string[];
  /** The view's date or slot, used when no date is written (see above). */
  defaultDates?: TaskDatesInput | null;
}

export interface SmartParseResult {
  tokens: SmartToken[];
  title: string;
  dates: TaskDatesInput | null;
  repeat: RepeatRuleInput | null;
  reminders: Reminder[];
  priority: Priority | null;
  tagNames: string[];
  listId: string | null;
}

// --- numbers ----------------------------------------------------------------

const CN_DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN = '[零〇一二两三四五六七八九十]{1,3}';
const NUM = `(?:\\d{1,2}|${CN})`;

/** 1–99 in digits or Chinese (九, 十二, 二十, 三十一); NaN otherwise. */
function toNumber(s: string): number {
  if (/^\d+$/.test(s)) return Number(s);
  const ten = s.indexOf('十');
  if (ten === -1) return s.length === 1 ? (CN_DIGITS[s] ?? NaN) : NaN;
  const tens = ten === 0 ? 1 : (CN_DIGITS[s.slice(0, ten)] ?? NaN);
  const ones = ten === s.length - 1 ? 0 : (CN_DIGITS[s.slice(ten + 1)] ?? NaN);
  return s.length > 3 ? NaN : tens * 10 + ones;
}

const WEEKDAY_CHARS: Record<string, number> = { 日: 0, 天: 0, 七: 0, 7: 0, 一: 1, 1: 1, 二: 2, 2: 2, 三: 3, 3: 3, 四: 4, 4: 4, 五: 5, 5: 5, 六: 6, 6: 6 };
const WD = '[一二三四五六日天1-7]';
const WEEK = '(?:周|星期|礼拜)';

const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (h: number, m: number) => `${pad(h)}:${pad(m)}`;

function realDate(y: number, m: number, d: number): string | null {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m))) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** The given weekday on or after `today`. */
function nextWeekday(today: string, day: number): string {
  return addDays(today, (day - weekday(today) + 7) % 7);
}

/** Monday of the week of `date`. */
function mondayOf(date: string): string {
  return addDays(date, -((weekday(date) + 6) % 7));
}

// --- matchers -----------------------------------------------------------------

type Period = 'morning' | 'early' | 'noon' | 'afternoon' | 'dusk' | 'evening' | 'night';
/** 滴答 does not know 早晨. */
const PERIODS: [string, Period][] = [
  ['上午', 'morning'],
  ['早上', 'early'],
  ['中午', 'noon'],
  ['下午', 'afternoon'],
  ['傍晚', 'dusk'],
  ['晚上', 'evening'],
  ['凌晨', 'night'],
];
const PERIOD_RE = PERIODS.map(([w]) => w).join('|');

interface Found {
  kind: SmartTokenKind;
  length: number;
  apply: (draft: Draft) => void;
}

interface Draft {
  date?: string;
  time?: string;
  /** A bare N点 (1–12): without a date it is the next such hour, morning or evening. */
  bareHour?: boolean;
  repeat?: RepeatRuleInput;
  /** The rule's first date when no date is written. */
  repeatAnchor?: string;
  /** The rule's dates, to move the first instance past a time already gone today; absent: it stays. */
  repeatOn?: (date: string) => boolean;
  /** Index of the 提醒我 token, dropped when nothing gives the task a date. */
  remindMe?: number;
  /** `token`: index of its token, dropped when the lead does not fit the dates. */
  before: { minutes?: number; days: number; unit: 'minute' | 'day'; token?: number }[];
  priority?: Priority;
  tagNames: string[];
  listId?: string;
}

interface Env {
  today: string;
  /** Where 重复规则 without a date start: the anchor's day, else today. */
  startDay: string;
  ctx: SmartParseContext;
  isWorkday: (date: string) => boolean;
}

function periodTime(period: Period, env: Env): string {
  const f = env.ctx.fuzzyTimes;
  if (period === 'morning') return f.morning;
  if (period === 'afternoon') return f.afternoon;
  if (period === 'evening') return f.evening;
  if (period === 'early') return '07:00';
  if (period === 'dusk') return '17:00';
  if (period === 'noon') return '12:00';
  return '01:00';
}

function clockTime(period: Period | undefined, hour: number, minute: number): string | null {
  if (!(hour >= 0 && hour <= 24 && minute >= 0 && minute < 60)) return null;
  let h = hour === 24 ? 0 : hour;
  if ((period === 'afternoon' || period === 'dusk' || period === 'evening') && h < 12) h += 12;
  if (period === 'noon' && h < 11) h += 12;
  if (period === 'morning' && h === 12) h = 0;
  return hhmm(h, minute);
}

function minuteOf(s: string | undefined): number {
  if (!s) return 0;
  if (s === '半') return 30;
  if (s === '一刻') return 15;
  if (s === '三刻') return 45;
  return toNumber(s.replace(/分$/, ''));
}

const re = (source: string) => new RegExp(source, 'y');

const DATE_WORDS: [string, number][] = [
  ['大后天', 3],
  ['后天', 2],
  ['明天', 1],
  ['明日', 1],
  ['今天', 0],
  ['今日', 0],
];

const DATE_RES = {
  week: re(`(下下|下个?|本|这个?)?${WEEK}(${WD})`),
  nextWeekend: re('下个?周末'),
  weekend: re('周末'),
  nextWeek: re(`下个?${WEEK}(?!末)`),
  nextMonth: re('下个?月(?!\\d|[零〇一二两三四五六七八九十])'),
  fromNow: re(`(${NUM})\\s*(小时|分钟)后`),
  ymd: re(`(?:(\\d{4})年)?(${NUM})月(${NUM})[日号]`),
  day: re(`(\\d{1,2})[日号]`),
  later: re(`(${NUM})天后`),
  tonight: re('(今|明)晚'),
};

function matchDate(text: string, i: number, env: Env): Found | null {
  for (const [word, offset] of DATE_WORDS) {
    if (text.startsWith(word, i)) return { kind: 'date', length: word.length, apply: (d) => void (d.date = addDays(env.today, offset)) };
  }
  let m = exec(DATE_RES.tonight, text, i);
  if (m) {
    const date = addDays(env.today, m[1] === '明' ? 1 : 0);
    return { kind: 'date', length: m[0].length, apply: (d) => Object.assign(d, { date, time: d.time ?? env.ctx.fuzzyTimes.evening }) };
  }
  m = exec(DATE_RES.nextMonth, text, i);
  if (m) {
    const [y, mo] = env.today.split('-').map(Number) as [number, number];
    const date = mo === 12 ? `${y + 1}-01-01` : `${y}-${pad(mo + 1)}-01`;
    return { kind: 'date', length: m[0].length, apply: (d) => void (d.date = date) };
  }
  // Numbers start at a digit boundary: 13月5日 is not 3月5日, 2月30日 not 30日.
  if (afterDigit(text, i) || text[i - 1] === '月') return null;
  m = exec(DATE_RES.fromNow, text, i);
  if (m) {
    const n = toNumber(m[1] as string);
    if (Number.isNaN(n)) return null;
    const minutes = m[2] === '小时' ? n * 60 : n;
    const at = new Date(Math.floor(env.ctx.now.getTime() / 60_000) * 60_000 + minutes * 60_000);
    const { date, time } = zonedDateTime(at.toISOString(), env.ctx.timeZone);
    // A time of its own: after 下午3点 it stays text, as in 滴答 (a time is set once).
    return { kind: 'time', length: m[0].length, apply: (d) => Object.assign(d, { date: d.date ?? date, time }) };
  }
  // 下周末 / 下个周末: next week's Saturday; 周末 (also in 这周末, whose 这 stays text in 滴答): the coming Saturday.
  m = exec(DATE_RES.nextWeekend, text, i);
  if (m) {
    const date = addDays(mondayOf(env.today), 12);
    return { kind: 'date', length: m[0].length, apply: (d) => void (d.date = date) };
  }
  m = exec(DATE_RES.weekend, text, i);
  if (m) {
    const date = nextWeekday(env.today, 6);
    return { kind: 'date', length: m[0].length, apply: (d) => void (d.date = date) };
  }
  m = exec(DATE_RES.week, text, i);
  if (m) {
    const day = WEEKDAY_CHARS[m[2] as string] as number;
    const prefix = m[1];
    let date: string;
    if (!prefix) date = nextWeekday(env.today, day);
    else {
      const weeks = prefix === '下下' ? 2 : prefix.startsWith('下') ? 1 : 0;
      date = addDays(mondayOf(env.today), weeks * 7 + ((day + 6) % 7));
    }
    return { kind: 'date', length: m[0].length, apply: (d) => void (d.date = date) };
  }
  m = exec(DATE_RES.nextWeek, text, i);
  if (m) {
    const date = addDays(mondayOf(env.today), 7);
    return { kind: 'date', length: m[0].length, apply: (d) => void (d.date = date) };
  }
  m = exec(DATE_RES.ymd, text, i);
  if (m) {
    const thisYear = Number(env.today.slice(0, 4));
    const [month, day] = [toNumber(m[2] as string), toNumber(m[3] as string)];
    let date = realDate(m[1] ? Number(m[1]) : thisYear, month, day);
    if (date && !m[1] && date < env.today) date = realDate(thisYear + 1, month, day);
    if (!date) return null;
    const found = date;
    return { kind: 'date', length: m[0].length, apply: (d) => void (d.date = found) };
  }
  m = exec(DATE_RES.day, text, i);
  if (m) {
    const day = Number(m[1]);
    const [y, mo] = env.today.split('-').map(Number) as [number, number];
    let date = realDate(y, mo, day);
    if (!date || date < env.today) date = mo === 12 ? realDate(y + 1, 1, day) : realDate(y, mo + 1, day);
    if (!date) return null;
    const found = date;
    return { kind: 'date', length: m[0].length, apply: (d) => void (d.date = found) };
  }
  m = exec(DATE_RES.later, text, i);
  if (m) {
    const n = toNumber(m[1] as string);
    if (Number.isNaN(n)) return null;
    return { kind: 'date', length: m[0].length, apply: (d) => void (d.date = addDays(env.today, n)) };
  }
  return null;
}

/** Minutes after N点: 半, 一刻, 三刻, digits (15 / 15分) or Chinese with 分 (十五分). */
const MINUTES = `(半|一刻|三刻|\\d{1,2}分?|${CN}分)?`;
const TIME_RES = {
  periodClock: re(`(${PERIOD_RE})\\s*(${NUM})[点时]${MINUTES}`),
  // 滴答 takes a bare Chinese number + 点 too (快一点 → 01:00); 时 only after digits (一时 is "for a while").
  clock: re(`(\\d{1,2}(?=[点时])|${CN}(?=点))[点时]${MINUTES}`),
  colon: re('(\\d{1,2})[:：](\\d{2})(?!\\d)'),
  period: re(`(${PERIOD_RE})`),
};

function matchTime(text: string, i: number, env: Env): Found | null {
  const set = (length: number, time: string | null): Found | null =>
    time ? { kind: 'time', length, apply: (d) => void (d.time = time) } : null;
  let m = exec(TIME_RES.periodClock, text, i);
  if (m) {
    const period = PERIODS.find(([w]) => w === m?.[1])?.[1];
    return set(m[0].length, clockTime(period, toNumber(m[2] as string), minuteOf(m[3])));
  }
  if (afterDigit(text, i)) return null;
  m = exec(TIME_RES.clock, text, i);
  if (m) {
    const hour = toNumber(m[1] as string);
    const time = clockTime(undefined, hour, minuteOf(m[2]));
    if (!time) return null;
    const bare = hour >= 1 && hour <= 12;
    return { kind: 'time', length: m[0].length, apply: (d) => Object.assign(d, { time, bareHour: bare }) };
  }
  m = exec(TIME_RES.colon, text, i);
  if (m) return set(m[0].length, clockTime(undefined, Number(m[1]), Number(m[2])));
  m = exec(TIME_RES.period, text, i);
  if (m) {
    const period = PERIODS.find(([w]) => w === m?.[1])?.[1] as Period;
    return set(m[0].length, periodTime(period, env));
  }
  return null;
}

/* 滴答 knows no 每个休息日 or 每隔N天, and joins weekdays only as 每周一和周三. */
const REPEAT_RES = {
  workday: re('每个?工作日'),
  weekend: re('每个?周末'),
  weekdays: re(`每${WEEK}(${WD}(?:和${WEEK}${WD})*)`),
  everyN: re(`每(${NUM})?个?(天|日|周|星期|礼拜|月|年)`),
  monthDay: re(`每个?月(${NUM})[日号]`),
  yearDay: re(`每年(${NUM})月(${NUM})[日号]`),
};

function firstFrom(today: string, test: (date: string) => boolean, limit = 400): string {
  for (let k = 0; k < limit; k++) {
    const date = addDays(today, k);
    if (test(date)) return date;
  }
  return today;
}

function matchRepeat(text: string, i: number, env: Env): Found | null {
  if (text[i] !== '每') return null;
  /** `on`: the rule's dates, when they are fixed by the rule itself (not by the first date). */
  const found = (length: number, repeat: RepeatRuleInput, anchor: string, on?: (date: string) => boolean): Found => ({
    kind: 'repeat',
    length,
    apply: (d) => Object.assign(d, { repeat, repeatAnchor: anchor, repeatOn: on }),
  });
  const today = env.startDay;
  const ruled = (on: (date: string) => boolean) => [firstFrom(today, on), on] as const;
  let m = exec(REPEAT_RES.workday, text, i);
  if (m) return found(m[0].length, { freq: 'workday' }, ...ruled(env.isWorkday));
  m = exec(REPEAT_RES.weekend, text, i);
  if (m) return found(m[0].length, { freq: 'weekly', weekdays: [0, 6] }, ...ruled((d) => [0, 6].includes(weekday(d))));
  m = exec(REPEAT_RES.weekdays, text, i);
  if (m) {
    const days = [...new Set([...(m[1] as string)].flatMap((c) => (c in WEEKDAY_CHARS ? [WEEKDAY_CHARS[c] as number] : [])))].sort((a, b) => a - b);
    return found(m[0].length, { freq: 'weekly', weekdays: days }, ...ruled((d) => days.includes(weekday(d))));
  }
  m = exec(REPEAT_RES.yearDay, text, i);
  if (m) {
    const [month, day] = [toNumber(m[1] as string), toNumber(m[2] as string)];
    const y = Number(today.slice(0, 4));
    if (!realDate(2024, month, day)) return null; // 2024: a leap year, so 2月29日 is allowed
    const anchor = [y, y + 1, y + 2, y + 3, y + 4].map((year) => realDate(year, month, day)).find((d): d is string => d !== null && d >= today);
    return found(m[0].length, { freq: 'yearly', month, monthDay: day }, anchor ?? today);
  }
  m = exec(REPEAT_RES.monthDay, text, i);
  if (m) {
    const day = toNumber(m[1] as string);
    if (!(day >= 1 && day <= 31)) return null;
    return found(m[0].length, { freq: 'monthly', monthDay: day }, ...ruled((d) => Number(d.slice(8)) === day));
  }
  m = exec(REPEAT_RES.everyN, text, i);
  if (m) {
    const interval = m[1] ? toNumber(m[1]) : 1;
    if (!(interval >= 1 && interval <= 99)) return null;
    const unit = m[2] as string;
    const freq = unit === '天' || unit === '日' ? 'daily' : unit === '月' ? 'monthly' : unit === '年' ? 'yearly' : 'weekly';
    // 每天: every day is a rule date; 每周 / 每月 / 每N天 … repeat from the first date, which stays.
    return found(m[0].length, interval === 1 ? { freq } : { freq, interval }, today, freq === 'daily' && interval === 1 ? () => true : undefined);
  }
  return null;
}

const REMIND_RES = {
  before: re('[*＊]\\s*提前\\s*(\\d{1,3}|' + CN + ')\\s*(分钟|小时|天)'),
};

function matchReminder(text: string, i: number, token: number): Found | null {
  if (text.startsWith('提醒我', i)) return { kind: 'reminder', length: 3, apply: (d) => void (d.remindMe = token) };
  const m = exec(REMIND_RES.before, text, i);
  if (!m) return null;
  const n = toNumber(m[1] as string);
  if (Number.isNaN(n)) return null;
  const unit = m[2] as string;
  const lead = unit === '天' ? { minutes: n * 1440, days: n, unit: 'day' as const } : { minutes: unit === '小时' ? n * 60 : n, days: 0, unit: 'minute' as const };
  return { kind: 'reminder', length: m[0].length, apply: (d) => void d.before.push(lead) };
}

const PRIORITY_MARKS: Record<string, Priority> = { 高: 'high', 中: 'medium', 低: 'low' };

function matchSymbol(text: string, i: number, env: Env): Found | null {
  const c = text[i];
  if (c === '#' || c === '＃') {
    const m = exec(re('[#＃]([^\\s#＃]+)'), text, i);
    if (!m) return null;
    const name = m[1] as string;
    if (name.length > TAG_NAME_MAX_LENGTH) return null;
    return { kind: 'tag', length: m[0].length, apply: (d) => void (d.tagNames.includes(name) || d.tagNames.push(name)) };
  }
  if (c === '~' || c === '～') {
    const rest = text.slice(i + 1).toLowerCase();
    const list = [...(env.ctx.lists ?? [])]
      .filter((l) => l.name && rest.startsWith(l.name.toLowerCase()))
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (!list) return null;
    return { kind: 'list', length: list.name.length + 1, apply: (d) => void (d.listId = list.id) };
  }
  if (c === '!' || c === '！') {
    const priority = PRIORITY_MARKS[text[i + 1] ?? ''];
    if (!priority) return null;
    return { kind: 'priority', length: 2, apply: (d) => void (d.priority = priority) };
  }
  return null;
}

function afterDigit(text: string, i: number): boolean {
  return i > 0 && /\d/.test(text[i - 1] as string);
}

function exec(regex: RegExp, text: string, i: number): RegExpExecArray | null {
  regex.lastIndex = i;
  return regex.exec(text);
}

/** Kinds that are set once: later ones stay text. */
const SINGLE: readonly SmartTokenKind[] = ['date', 'time', 'repeat', 'priority', 'list'];
/** What 标签识别 / 移除任务标题中的标签 cover; the rest is 日期识别 / 移除文本中的日期. */
const TAG_KINDS: readonly SmartTokenKind[] = ['tag', 'list', 'priority'];

export function parseSmartInput(text: string, ctx: SmartParseContext): SmartParseResult {
  const today = todayIn(ctx.now, ctx.timeZone);
  const anchor = ctx.defaultDates ?? null;
  const env: Env = {
    today,
    startDay: anchor ? anchorDay(anchor, ctx.timeZone) : today,
    ctx,
    isWorkday: ctx.isWorkday ?? ((date) => weekday(date) !== 0 && weekday(date) !== 6),
  };
  const ignored = new Set(ctx.ignored ?? []);
  const draft: Draft = { before: [], tagNames: [] };
  const tokens: SmartToken[] = [];
  const seen = new Set<SmartTokenKind>();

  const dateParse = ctx.dateParse ?? true;
  const tagParse = ctx.tagParse ?? true;
  let i = 0;
  while (i < text.length) {
    const found =
      (dateParse ? (matchRepeat(text, i, env) ?? matchDate(text, i, env) ?? matchTime(text, i, env) ?? matchReminder(text, i, tokens.length)) : null) ??
      (tagParse ? matchSymbol(text, i, env) : null);
    if (!found) {
      i++;
      continue;
    }
    const token: SmartToken = { kind: found.kind, text: text.slice(i, i + found.length), start: i, end: i + found.length };
    i = token.end;
    // A cancelled phrase stays text as a whole: none of its pieces are matched.
    if (ignored.has(token.text)) continue;
    if (SINGLE.includes(token.kind) && seen.has(token.kind)) continue;
    // 提醒我 counts once: a second one stays text.
    if (token.kind === 'reminder' && token.text === '提醒我' && draft.remindMe !== undefined) continue;
    seen.add(token.kind);
    const leads = draft.before.length;
    found.apply(draft);
    if (draft.before.length > leads) (draft.before[leads] as Draft['before'][number]).token = tokens.length;
    tokens.push(token);
  }

  const { dropped, ...settled } = settle(draft, env);
  const kept = tokens.filter((_, index) => !dropped.has(index));
  const removed = kept.filter((t) => (TAG_KINDS.includes(t.kind) ? (ctx.removeTag ?? true) : (ctx.removeDate ?? true)));
  return { tokens: kept, title: cleanTitle(text, removed), ...settled };
}

function anchorDay(dates: TaskDatesInput, timeZone: string): string {
  return dates.allDay ? dates.dueDate : zonedDateTime(dates.dueAt, timeZone).date;
}

/** The title without the text of `tokens` (the ones to take out). */
function cleanTitle(text: string, tokens: SmartToken[]): string {
  const whole = text.trim().replace(/\s+/g, ' ');
  if (tokens.length === 0) return whole;
  let rest = '';
  let at = 0;
  for (const t of tokens) {
    rest += text.slice(at, t.start);
    at = t.end;
  }
  rest += text.slice(at);
  const title = rest.trim().replace(/\s+/g, ' ');
  return title || whole;
}

function settle(d: Draft, env: Env): Omit<SmartParseResult, 'tokens' | 'title'> & { dropped: Set<number> } {
  const { ctx, today } = env;
  const anchor = ctx.defaultDates ?? null;
  const timedAt = (date: string, time: string): TaskDatesInput => ({ allDay: false, startAt: null, dueAt: zonedToInstant(date, time, ctx.timeZone) });
  const allDayOn = (date: string): TaskDatesInput => ({ allDay: true, startDate: null, dueDate: date });
  const remindMe = d.remindMe !== undefined;
  // Leads an all-day task can hold: 提醒我 and *提前N天.
  const allDayReminder = remindMe || d.before.some((b) => b.unit === 'day');
  const passed = (date: string, time: string) => Date.parse(zonedToInstant(date, time, ctx.timeZone)) <= ctx.now.getTime();
  const dropped = new Set<number>();

  let dates: TaskDatesInput | null = null;
  let time = d.time;
  let written = d.date ?? d.repeatAnchor;
  // *提前N分钟 / 小时 on a written date without a time: 00:00 that day (滴答).
  if (written && !time && d.before.some((b) => b.unit === 'minute')) time = '00:00';
  if (written && time && !d.date && !anchor && d.repeatOn && passed(written, time)) {
    // The rule's first date whose time is still to come.
    written = firstFrom(addDays(written, 1), d.repeatOn);
  }
  if (written) dates = time ? timedAt(written, time) : allDayOn(written);
  else if (time) {
    // On the anchor's day; without one the next such time: today, or tomorrow once it has passed.
    let day = anchor ? anchorDay(anchor, ctx.timeZone) : today;
    if (!anchor) {
      // A bare 9点 is 09:00 or 21:00, whichever comes first; 十二点: 12:00 or midnight.
      if (d.bareHour && passed(today, time)) {
        const evening = time.startsWith('12') ? null : hhmm(Number(time.slice(0, 2)) + 12, Number(time.slice(3)));
        if (!evening) [day, time] = [addDays(today, 1), `00${time.slice(2)}`];
        else if (!passed(today, evening)) time = evening;
        else day = addDays(today, 1);
      } else if (passed(today, time)) day = addDays(today, 1);
    }
    dates = timedAt(day, time);
  } else if (anchor) {
    // Only 提醒: they go on the view's own day or slot.
    if (anchor.allDay ? allDayReminder : remindMe || d.before.length > 0) dates = anchor;
  }
  // 提醒我 alone sets nothing (滴答): it needs a date, a time, a 重复 or the view's own date.
  if (remindMe && !dates) dropped.add(d.remindMe as number);

  const reminders: Reminder[] = [];
  const timed = dates !== null && !dates.allDay;
  for (const b of d.before) if (!dates || (!timed && b.unit === 'minute')) dropped.add(b.token ?? -1);
  if (dates) {
    const stored: TaskDates = dates.allDay
      ? { allDay: true, startDate: dates.startDate ?? null, dueDate: dates.dueDate }
      : { allDay: false, startAt: dates.startAt ?? null, dueAt: dates.dueAt, timeZone: ctx.timeZone };
    const wanted: Reminder[] = [
      ...(remindMe ? [timed ? { type: 'before' as const, minutes: 0 } : { type: 'day' as const, daysBefore: 0, time: null }] : []),
      ...d.before.flatMap((b): Reminder[] => {
        if (timed) return [{ type: 'before', minutes: b.minutes ?? 0 }];
        return b.unit === 'day' ? [{ type: 'day', daysBefore: b.days, time: null }] : [];
      }),
    ];
    const keys = new Set<string>();
    for (const r of wanted) {
      const key = JSON.stringify(r);
      if (keys.has(key) || !reminderFits(r, stored)) continue;
      keys.add(key);
      reminders.push(r);
    }
  }

  return {
    dates,
    repeat: d.repeat ?? null,
    reminders: sortReminders(reminders),
    priority: d.priority ?? null,
    tagNames: d.tagNames,
    listId: d.listId ?? null,
    dropped,
  };
}

/**
 * The new task: what the 添加任务 field of the view adds by itself (`base`:
 * the 清单, the 标签, today in 今天 …) with what 智能识别 found on top. A
 * recognised date, 清单 or 优先级 wins; 标签 are added. `tagIds`: the ids of
 * `parsed.tagNames`, found or created by the caller.
 */
export function smartCreateRequest(base: Omit<CreateTaskRequest, 'title'>, parsed: SmartParseResult, tagIds: readonly string[]): CreateTaskRequest {
  const request: CreateTaskRequest = { ...base, title: parsed.title };
  if (parsed.listId) request.listId = parsed.listId;
  if (parsed.dates) request.dates = parsed.dates;
  if (parsed.repeat) request.repeat = parsed.repeat;
  if (parsed.reminders.length > 0) request.reminders = parsed.reminders;
  if (parsed.priority) request.priority = parsed.priority;
  if (tagIds.length > 0) request.tagIds = [...new Set([...(base.tagIds ?? []), ...tagIds])];
  return request;
}
