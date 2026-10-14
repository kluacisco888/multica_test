import { z } from 'zod';
import { daysInMonth } from './civil-date.js';
import type { RepeatRuleInput } from './repeat-rule.js';
import { reminderFits, sortReminders, timeOfDaySchema, type Reminder } from './reminders.js';
import { addDays, todayIn, weekday, zonedToInstant, type TaskDatesInput } from './task-dates.js';
import type { CreateTaskRequest, Priority } from './tasks.js';

/*
 * 智能识别解析器 (spec 用户故事 51–58, Q45). Pure: the caller passes the raw
 * title, "now", the time zone, the 模糊时间 settings and the user's 清单.
 * Out come the recognised parts, each with its place in the original text
 * (for highlighting and 取消识别), what they set on the task, and the title
 * with the recognised text taken out (unless 保留识别文字).
 *
 * Recognised:
 *   - dates: 今天 / 明天 / 后天 / 大后天, 周X / 星期X / 礼拜X (the next one,
 *     today included), 本周X / 下周X / 下下周X (weeks start on Monday),
 *     M月D日, YYYY年M月D日, D号 (this month, next month once passed), N天后;
 *   - times: 上午 / 早上, 中午, 下午, 晚上 (模糊时间), a clock time after
 *     them (下午3点, 晚上8点半, 上午九点一刻), N点 / HH:mm with digits;
 *     今晚 / 明晚 set the day and 晚上. A time without a date is today, or
 *     tomorrow once it has passed;
 *   - 重复规则: 每天, 每N天, 每周, 每周X(、X), 每N周, 每个周末, 每个工作日,
 *     每个休息日, 每月, 每月D号, 每年, 每年M月D日. Without a date the first
 *     instance is the first rule date from today on;
 *   - 提醒: 提醒我 (准时 / 当天), *提前N分钟 / 小时 / 天;
 *   - #标签 (up to the next space), ~清单 (one of the user's 清单, longest
 *     name first), !高 / !中 / !低.
 *
 * Each kind is set once: a second date (time, 重复, 优先级, 清单) stays text.
 */

export const DEFAULT_SMART_INPUT_SETTINGS = {
  enabled: true,
  keepText: false,
  morning: '10:00',
  afternoon: '14:00',
  evening: '20:00',
} as const;

/** 设置 → 智能识别 (spec 用户故事 57–58). Missing fields take their defaults. */
export const smartInputSettingsSchema = z.object({
  /** 智能识别 on / off. */
  enabled: z.boolean().default(DEFAULT_SMART_INPUT_SETTINGS.enabled),
  /** 保留识别文字: keep the recognised text in the title. */
  keepText: z.boolean().default(DEFAULT_SMART_INPUT_SETTINGS.keepText),
  /** 模糊时间: 上午 / 下午 / 晚上, `HH:mm`. */
  morning: timeOfDaySchema.default(DEFAULT_SMART_INPUT_SETTINGS.morning),
  afternoon: timeOfDaySchema.default(DEFAULT_SMART_INPUT_SETTINGS.afternoon),
  evening: timeOfDaySchema.default(DEFAULT_SMART_INPUT_SETTINGS.evening),
});
export type SmartInputSettings = z.infer<typeof smartInputSettingsSchema>;

/** `PATCH /api/settings` `{ smartInput: {...} }`: any subset. */
export const smartInputSettingsPatchSchema = z
  .object({
    enabled: z.boolean(),
    keepText: z.boolean(),
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
  /** 保留识别文字. */
  keepText?: boolean;
  /** Texts the user cancelled (点一下取消识别): they stay plain text. */
  ignored?: readonly string[];
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

type Period = 'morning' | 'noon' | 'afternoon' | 'evening' | 'night';
const PERIODS: [string, Period][] = [
  ['上午', 'morning'],
  ['早上', 'morning'],
  ['早晨', 'morning'],
  ['中午', 'noon'],
  ['下午', 'afternoon'],
  ['傍晚', 'evening'],
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
  repeat?: RepeatRuleInput;
  /** The rule's first date when no date is written. */
  repeatAnchor?: string;
  remindMe?: boolean;
  before: { minutes?: number; days: number; unit: 'minute' | 'day' }[];
  priority?: Priority;
  tagNames: string[];
  listId?: string;
}

interface Env {
  today: string;
  ctx: SmartParseContext;
  isWorkday: (date: string) => boolean;
}

function periodTime(period: Period, env: Env): string {
  const f = env.ctx.fuzzyTimes;
  if (period === 'morning') return f.morning;
  if (period === 'afternoon') return f.afternoon;
  if (period === 'evening') return f.evening;
  if (period === 'noon') return '12:00';
  return '01:00';
}

function clockTime(period: Period | undefined, hour: number, minute: number): string | null {
  if (!(hour >= 0 && hour <= 24 && minute >= 0 && minute < 60)) return null;
  let h = hour === 24 ? 0 : hour;
  if ((period === 'afternoon' || period === 'evening') && h < 12) h += 12;
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
  // Numbers start at a digit boundary: 13月5日 is not 3月5日, 2月30日 not 30日.
  if (afterDigit(text, i) || text[i - 1] === '月') return null;
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
  digitClock: re(`(\\d{1,2})[点时]${MINUTES}`),
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
  // A bare Chinese number + 点 (快一点) is no time: digits only without a period.
  if (afterDigit(text, i)) return null;
  m = exec(TIME_RES.digitClock, text, i);
  if (m) return set(m[0].length, clockTime(undefined, Number(m[1]), minuteOf(m[2])));
  m = exec(TIME_RES.colon, text, i);
  if (m) return set(m[0].length, clockTime(undefined, Number(m[1]), Number(m[2])));
  m = exec(TIME_RES.period, text, i);
  if (m) {
    const period = PERIODS.find(([w]) => w === m?.[1])?.[1] as Period;
    return set(m[0].length, periodTime(period, env));
  }
  return null;
}

const REPEAT_RES = {
  workday: re('每个?工作日'),
  restday: re('每个?休息日'),
  weekend: re('每个?周末'),
  weekdays: re(`每${WEEK}(${WD}(?:\\s*(?:、|，|,|和|及)?\\s*${WEEK}?${WD})*)`),
  everyN: re(`每(?:隔)?(${NUM})?个?(天|日|周|星期|礼拜|月|年)`),
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
  const found = (length: number, repeat: RepeatRuleInput, anchor: string): Found => ({
    kind: 'repeat',
    length,
    apply: (d) => Object.assign(d, { repeat, repeatAnchor: anchor }),
  });
  const { today } = env;
  let m = exec(REPEAT_RES.workday, text, i);
  if (m) return found(m[0].length, { freq: 'workday' }, firstFrom(today, env.isWorkday));
  m = exec(REPEAT_RES.restday, text, i);
  if (m) return found(m[0].length, { freq: 'restday' }, firstFrom(today, (d) => !env.isWorkday(d)));
  m = exec(REPEAT_RES.weekend, text, i);
  if (m) return found(m[0].length, { freq: 'weekly', weekdays: [0, 6] }, firstFrom(today, (d) => [0, 6].includes(weekday(d))));
  m = exec(REPEAT_RES.weekdays, text, i);
  if (m) {
    const days = [...new Set([...(m[1] as string)].flatMap((c) => (c in WEEKDAY_CHARS ? [WEEKDAY_CHARS[c] as number] : [])))].sort((a, b) => a - b);
    return found(m[0].length, { freq: 'weekly', weekdays: days }, firstFrom(today, (d) => days.includes(weekday(d))));
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
    return found(m[0].length, { freq: 'monthly', monthDay: day }, firstFrom(today, (d) => Number(d.slice(8)) === day));
  }
  m = exec(REPEAT_RES.everyN, text, i);
  if (m) {
    const interval = m[1] ? toNumber(m[1]) : 1;
    if (!(interval >= 1 && interval <= 99)) return null;
    const unit = m[2] as string;
    const freq = unit === '天' || unit === '日' ? 'daily' : unit === '月' ? 'monthly' : unit === '年' ? 'yearly' : 'weekly';
    return found(m[0].length, interval === 1 ? { freq } : { freq, interval }, today);
  }
  return null;
}

const REMIND_RES = {
  before: re('[*＊]\\s*提前\\s*(\\d{1,3}|' + CN + ')\\s*(分钟|小时|天)'),
};

function matchReminder(text: string, i: number): Found | null {
  if (text.startsWith('提醒我', i)) return { kind: 'reminder', length: 3, apply: (d) => void (d.remindMe = true) };
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

export function parseSmartInput(text: string, ctx: SmartParseContext): SmartParseResult {
  const env: Env = {
    today: todayIn(ctx.now, ctx.timeZone),
    ctx,
    isWorkday: ctx.isWorkday ?? ((date) => weekday(date) !== 0 && weekday(date) !== 6),
  };
  const ignored = new Set(ctx.ignored ?? []);
  const draft: Draft = { before: [], tagNames: [] };
  const tokens: SmartToken[] = [];
  const seen = new Set<SmartTokenKind>();

  let i = 0;
  while (i < text.length) {
    const found = matchRepeat(text, i, env) ?? matchDate(text, i, env) ?? matchTime(text, i, env) ?? matchReminder(text, i) ?? matchSymbol(text, i, env);
    if (!found) {
      i++;
      continue;
    }
    const token: SmartToken = { kind: found.kind, text: text.slice(i, i + found.length), start: i, end: i + found.length };
    i = token.end;
    // A cancelled phrase stays text as a whole: none of its pieces are matched.
    if (ignored.has(token.text)) continue;
    if (SINGLE.includes(token.kind) && seen.has(token.kind)) continue;
    seen.add(token.kind);
    found.apply(draft);
    tokens.push(token);
  }

  return { tokens, title: cleanTitle(text, tokens, ctx.keepText ?? false), ...settle(draft, env) };
}

function cleanTitle(text: string, tokens: SmartToken[], keepText: boolean): string {
  const whole = text.trim().replace(/\s+/g, ' ');
  if (keepText || tokens.length === 0) return whole;
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

function settle(d: Draft, env: Env): Omit<SmartParseResult, 'tokens' | 'title'> {
  const { ctx, today } = env;
  const hasReminder = d.remindMe || d.before.length > 0;
  let date = d.date ?? d.repeatAnchor;
  if (!date && d.time) {
    // Today, or tomorrow once the time has passed.
    date = Date.parse(zonedToInstant(today, d.time, ctx.timeZone)) <= ctx.now.getTime() ? addDays(today, 1) : today;
  }
  if (!date && hasReminder) date = today;

  let dates: TaskDatesInput | null = null;
  if (date) dates = d.time ? { allDay: false, startAt: null, dueAt: zonedToInstant(date, d.time, ctx.timeZone) } : { allDay: true, startDate: null, dueDate: date };

  const reminders: Reminder[] = [];
  if (dates) {
    const timed = !dates.allDay;
    const stored = timed ? { allDay: false as const, startAt: null, dueAt: (dates as { dueAt: string }).dueAt, timeZone: ctx.timeZone } : { allDay: true as const, startDate: null, dueDate: date as string };
    const wanted: Reminder[] = [
      ...(d.remindMe ? [timed ? { type: 'before' as const, minutes: 0 } : { type: 'day' as const, daysBefore: 0, time: null }] : []),
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
