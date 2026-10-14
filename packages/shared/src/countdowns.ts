import { z } from 'zod';
import { civilDateSchema } from './civil-date.js';
import { entityNameSchema, iconSchema, sortKeySchema } from './lists.js';
import { reminderKey, reminderSchema, sortReminders, type Reminder } from './reminders.js';
import { compareSortKeys } from './sort-key.js';

/*
 * 倒数日 (spec 用户故事 99–101): a target date shown as "还有 N 天" before it
 * and "已经 N 天" after it (纪念日). It can repeat every year, and its date
 * can be a 农历 date (the 农历 day of `date` is what repeats). The rules that
 * need the 农历 library are in `@dida/shared/countdown` (countdown-dates.ts),
 * which only the server loads; this module is the API shape.
 */

export const COUNTDOWN_CALENDARS = ['solar', 'lunar'] as const;
export const countdownCalendarSchema = z.enum(COUNTDOWN_CALENDARS);
export type CountdownCalendar = z.infer<typeof countdownCalendarSchema>;

export const COUNTDOWN_REPEATS = ['none', 'yearly'] as const;
export const countdownRepeatSchema = z.enum(COUNTDOWN_REPEATS);
export type CountdownRepeat = z.infer<typeof countdownRepeatSchema>;

/** Icons offered by the picker (any short emoji is accepted). */
export const COUNTDOWN_ICONS = ['⏳', '🧧', '🎂', '❤️', '🎉', '🎓', '✈️', '🏠', '💼', '📅', '⭐', '🌙'] as const;
export const DEFAULT_COUNTDOWN_ICON = '⏳';
export const COUNTDOWN_MAX_REMINDERS = 5;

/** 当天 / 提前 1 天 / 提前 3 天 / 提前 1 周 (`daysBefore`). */
export const COUNTDOWN_REMINDER_PRESETS = [0, 1, 3, 7] as const;

/**
 * Reminders of a 倒数日: "N days before the next occurrence, at a time"
 * (time null: the 全天提醒时间 setting), the same shape as a 全天任务's.
 */
export const countdownRemindersSchema = z
  .array(reminderSchema)
  .max(COUNTDOWN_MAX_REMINDERS, `最多 ${COUNTDOWN_MAX_REMINDERS} 个提醒`)
  .refine((list) => list.every((r) => r.type === 'day'), '倒数日的提醒只能按天设置')
  .transform((list) => {
    const seen = new Map<string, Reminder>();
    for (const r of list) seen.set(reminderKey(r), r);
    return sortReminders([...seen.values()]);
  });

/** Where today stands relative to the next occurrence. */
export const COUNTDOWN_STATUSES = ['upcoming', 'today', 'passed'] as const;
export type CountdownStatus = (typeof COUNTDOWN_STATUSES)[number];

export const countdownOccurrenceSchema = z.object({
  /** 公历 date of the occurrence that is shown: the next one, or the date itself once passed. */
  date: civilDateSchema,
  /** Whole days between today and `date` (never negative). */
  days: z.number().int().nonnegative(),
  status: z.enum(COUNTDOWN_STATUSES),
});
export type CountdownOccurrence = z.infer<typeof countdownOccurrenceSchema>;

export const countdownSchema = z.object({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  revision: z.number().int().nonnegative(),
  name: z.string(),
  icon: z.string(),
  /** 公历 date as entered; for a 农历 倒数日 its 农历 day is the one that counts. */
  date: civilDateSchema,
  calendar: countdownCalendarSchema,
  repeat: countdownRepeatSchema,
  reminders: z.array(reminderSchema),
  /** null: the default 通知渠道. */
  reminderChannelIds: z.array(z.uuid()).nullable(),
  pinned: z.boolean(),
  archivedAt: z.iso.datetime().nullable(),
  sortOrder: z.string(),
  /** 农历 of `date` (正月 / 初一), for 农历 倒数日 only. */
  lunar: z.object({ monthName: z.string(), dayName: z.string() }).nullable(),
  /** Computed for today in the user's time zone. */
  next: countdownOccurrenceSchema,
});
export type Countdown = z.infer<typeof countdownSchema>;

export const countdownsResponseSchema = z.object({ countdowns: z.array(countdownSchema) });
export type CountdownsResponse = z.infer<typeof countdownsResponseSchema>;

const channelIdsSchema = z
  .array(z.uuid())
  .max(20)
  .transform((ids) => [...new Set(ids.map((id) => id.toLowerCase()))])
  .nullable();

export const createCountdownRequestSchema = z
  .object({
    id: z.uuid().optional(),
    name: entityNameSchema,
    icon: iconSchema.default(DEFAULT_COUNTDOWN_ICON),
    date: civilDateSchema,
    calendar: countdownCalendarSchema.default('solar'),
    repeat: countdownRepeatSchema.default('none'),
    reminders: countdownRemindersSchema.default([]),
    reminderChannelIds: channelIdsSchema.default(null),
    pinned: z.boolean().default(false),
    /** Defaults to the end. */
    sortOrder: sortKeySchema.optional(),
  })
  .strict();
export type CreateCountdownRequest = z.input<typeof createCountdownRequestSchema>;

export const updateCountdownRequestSchema = z
  .object({
    name: entityNameSchema,
    icon: iconSchema,
    date: civilDateSchema,
    calendar: countdownCalendarSchema,
    repeat: countdownRepeatSchema,
    reminders: countdownRemindersSchema,
    reminderChannelIds: channelIdsSchema,
    pinned: z.boolean(),
    /** true: 归档; false: back to 记录中. */
    archived: z.boolean(),
    sortOrder: sortKeySchema,
  })
  .partial()
  .strict();
export type UpdateCountdownRequest = z.input<typeof updateCountdownRequestSchema>;

/** `GET /api/countdowns?archived=` : 记录中 (default) or 已归档. */
export const countdownsQuerySchema = z.object({ archived: z.enum(['true', 'false']).optional() });

/** "2026年10月17日" */
export function formatChineseDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return `${y}年${m}月${d}日`;
}

/**
 * The span between two dates as years, months and days (the card's 年月日
 * format): whole months first, counting from the earlier date; a month end
 * that the shorter month lacks falls on its last day.
 */
export function ymdBetween(a: string, b: string): { years: number; months: number; days: number } {
  const [from, to] = a <= b ? [a, b] : [b, a];
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number];
  let months = (ty - fy) * 12 + (tm - fm);
  const dayIn = (y: number, m: number) => Math.min(fd, new Date(Date.UTC(y, m, 0)).getUTCDate());
  if (td < dayIn(ty, tm)) months -= 1;
  const anchorY = fy + Math.floor((fm - 1 + months) / 12);
  const anchorM = ((fm - 1 + months) % 12) + 1;
  const anchor = Date.UTC(anchorY, anchorM - 1, dayIn(anchorY, anchorM));
  const days = Math.round((Date.UTC(ty, tm - 1, td) - anchor) / 86_400_000);
  return { years: Math.floor(months / 12), months: months % 12, days };
}

/** "1年2个月3天", leaving out zero parts ("0天" for the same day). */
export function formatYmd({ years, months, days }: { years: number; months: number; days: number }): string {
  const text = `${years ? `${years}年` : ''}${months ? `${months}个月` : ''}${days ? `${days}天` : ''}`;
  return text || '0天';
}

/**
 * The caption under the number, like 滴答: "距离 2026年10月17日 还有",
 * "距离 正月初一 (2027年2月6日) 还有", "距离 2014年12月8日 已经".
 */
export function countdownCaption(c: Pick<Countdown, 'calendar' | 'lunar' | 'next'>): string {
  const solar = formatChineseDate(c.next.date);
  const target = c.calendar === 'lunar' && c.lunar ? `${c.lunar.monthName}${c.lunar.dayName} (${solar})` : solar;
  if (c.next.status === 'today') return `${target} 就是今天`;
  return `距离 ${target} ${c.next.status === 'upcoming' ? '还有' : '已经'}`;
}

/** Order on the page: 置顶 first, then the user's order. */
export function compareCountdowns(a: Pick<Countdown, 'pinned' | 'sortOrder' | 'id'>, b: Pick<Countdown, 'pinned' | 'sortOrder' | 'id'>): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  return compareSortKeys(a.sortOrder, b.sortOrder) || compareSortKeys(a.id, b.id);
}

/** The message a 通知渠道 receives for a 倒数日 reminder. */
export function countdownReminderMessage(c: { name: string; calendar: CountdownCalendar; lunar: Countdown['lunar'] }, occurrence: string, daysLeft: number) {
  const solar = formatChineseDate(occurrence);
  const when = c.calendar === 'lunar' && c.lunar ? `${c.lunar.monthName}${c.lunar.dayName}（${solar}）` : solar;
  return {
    title: `倒数日：${c.name}`,
    body: `${daysLeft === 0 ? '就是今天' : `还有 ${daysLeft} 天`}：${when}\n来自勾勾清单`,
  };
}
