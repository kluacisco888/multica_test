import { z } from 'zod';
import { addDays, describeTaskDates, taskDatesSchema, zonedToInstant, type TaskDates } from './task-dates.js';
import { PRODUCT_NAME } from './product.js';

/*
 * 提醒 (spec 用户故事 78–84, ADR-0005): trigger points on a 任务. A task with
 * a time takes "N minutes before" reminders (准时 = 0); an all-day task takes
 * "N days before, at a time" reminders, the time defaulting to the user's
 * 全天提醒时间 (09:00). Each reminder of each open task becomes a scheduled
 * 提醒投递记录 on the server; this module holds the pure rules: which instant
 * a reminder fires at, retry delays, the 24-hour catch-up window, labels.
 */

/** 准时 / 提前 5 分钟 / 30 分钟 / 1 小时 / 1 天 (用户故事 79). */
export const TIMED_REMINDER_PRESETS = [0, 5, 30, 60, 1440] as const;
/** 当天 / 提前 1 天 / 提前 1 周 (用户故事 80). */
export const ALL_DAY_REMINDER_PRESETS = [0, 1, 7] as const;
export const DEFAULT_ALL_DAY_REMINDER_TIME = '09:00';
/** Custom reminders go up to 60 days ahead. */
export const REMINDER_MAX_MINUTES = 60 * 24 * 60;
export const REMINDER_MAX_DAYS = 60;
export const TASK_MAX_REMINDERS = 10;

/** Delays before the 1st, 2nd and 3rd retry of a failed delivery (用户故事 83). */
export const REMINDER_RETRY_DELAYS_MINUTES = [1, 5, 15] as const;
/** After a downtime, reminders that came due at most this long ago are still sent (用户故事 84). */
export const REMINDER_CATCH_UP_MS = 24 * 60 * 60 * 1000;
/** 稍后提醒 choices in the 应用内提醒, in minutes. */
export const SNOOZE_OPTIONS_MINUTES = [5, 15, 30, 60, 180] as const;
/** The 应用内提醒 shows reminders that fired at most this long ago. */
export const REMINDER_ALERT_WINDOW_MS = 60 * 60 * 1000;

const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时间格式应为 HH:mm');
export { timeOfDaySchema };

const timedReminderSchema = z
  .object({ type: z.literal('before'), minutes: z.number().int().min(0).max(REMINDER_MAX_MINUTES, '提醒最多提前 60 天') })
  .strict();
const allDayReminderSchema = z
  .object({
    type: z.literal('day'),
    daysBefore: z.number().int().min(0).max(REMINDER_MAX_DAYS, '提醒最多提前 60 天'),
    /** null: the user's 全天提醒时间 setting. */
    time: timeOfDaySchema.nullable(),
  })
  .strict();

export const reminderSchema = z.discriminatedUnion('type', [timedReminderSchema, allDayReminderSchema]);
export type Reminder = z.infer<typeof reminderSchema>;

/** Stable identity of a reminder on its task. */
export function reminderKey(r: Reminder): string {
  return r.type === 'before' ? `before:${r.minutes}` : `day:${r.daysBefore}@${r.time ?? 'default'}`;
}

/** A task's reminders: distinct, at most `TASK_MAX_REMINDERS`, earliest first. */
export const remindersSchema = z
  .array(reminderSchema)
  .max(TASK_MAX_REMINDERS, `最多 ${TASK_MAX_REMINDERS} 个提醒`)
  .transform((list) => {
    const seen = new Map<string, Reminder>();
    for (const r of list) seen.set(reminderKey(r), r);
    return sortReminders([...seen.values()]);
  });

/** Largest lead first (提前 1 天 before 准时), like 滴答's list. */
export function sortReminders(list: Reminder[]): Reminder[] {
  const lead = (r: Reminder) => (r.type === 'before' ? r.minutes : r.daysBefore * 1440);
  return [...list].sort((a, b) => lead(b) - lead(a) || reminderKey(a).localeCompare(reminderKey(b)));
}

/** Whether a reminder fits the task's kind of date (timed vs 全天). */
export function reminderFits(r: Reminder, dates: TaskDates | null): boolean {
  if (!dates) return false;
  return dates.allDay ? r.type === 'day' : r.type === 'before';
}

export interface ReminderContext {
  /** The user's current time zone: all-day reminders fire at wall-clock time there. */
  timeZone: string;
  /** 全天提醒时间 setting, `HH:mm`. */
  allDayTime: string;
}

/**
 * The instant a reminder fires. Relative to the start of a 时间段 (滴答 reminds
 * at the start of an event), otherwise to the due date. Null when the
 * reminder does not fit the dates.
 */
export function reminderFireAt(r: Reminder, dates: TaskDates | null, ctx: ReminderContext): Date | null {
  if (!dates || !reminderFits(r, dates)) return null;
  if (!dates.allDay && r.type === 'before') {
    const anchor = Date.parse(dates.startAt ?? dates.dueAt);
    return new Date(anchor - r.minutes * 60_000);
  }
  if (dates.allDay && r.type === 'day') {
    const day = addDays(dates.startDate ?? dates.dueDate, -r.daysBefore);
    return new Date(zonedToInstant(day, r.time ?? ctx.allDayTime, ctx.timeZone));
  }
  return null;
}

/** Every reminder of a task with its fire instant (reminders that do not fit are skipped). */
export function reminderSchedule(reminders: Reminder[], dates: TaskDates | null, ctx: ReminderContext): { key: string; fireAt: Date }[] {
  return reminders.flatMap((r) => {
    const fireAt = reminderFireAt(r, dates, ctx);
    return fireAt ? [{ key: reminderKey(r), fireAt }] : [];
  });
}

/**
 * When to try again after the `failures`-th failed attempt (1-based), or
 * null when the three retries are used up: 1, 5, then 15 minutes later.
 */
export function nextRetryAt(failures: number, now: Date): Date | null {
  const delay = REMINDER_RETRY_DELAYS_MINUTES[failures - 1];
  return delay === undefined ? null : new Date(now.getTime() + delay * 60_000);
}

/** Whether a reminder due at `fireAt` is still sent at `now` (at most 24 hours late). */
export function withinCatchUp(fireAt: Date, now: Date): boolean {
  return now.getTime() - fireAt.getTime() <= REMINDER_CATCH_UP_MS;
}

function durationLabel(minutes: number): string {
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (minutes % 10080 === 0) return `${minutes / 10080}周`;
  return [days ? `${days}天` : '', hours ? `${hours}小时` : '', mins ? `${mins}分钟` : ''].join('');
}

/** 准时 / 提前30分钟 / 提前1天 / 当天（09:00）/ 提前1周（09:00）. */
export function describeReminder(r: Reminder, allDayTime: string): string {
  if (r.type === 'before') return r.minutes === 0 ? '准时' : `提前${durationLabel(r.minutes)}`;
  const time = r.time ?? allDayTime;
  const day = r.daysBefore === 0 ? '当天' : r.daysBefore % 7 === 0 ? `提前${r.daysBefore / 7}周` : `提前${r.daysBefore}天`;
  return `${day}（${time}）`;
}

/** The message a 通知渠道 receives for a reminder. */
export function reminderMessage(task: { title: string; dates: TaskDates | null }, ctx: { now: Date; timeZone: string }) {
  const when = task.dates ? describeTaskDates(task.dates, ctx).text : null;
  return {
    title: `提醒：${task.title}`,
    body: when ? `时间：${when}\n来自${PRODUCT_NAME}` : `来自${PRODUCT_NAME}`,
  };
}

/* ---- API ---- */

/** A reminder that fired while the page may be open: the 应用内提醒 (用户故事 82). */
export const reminderAlertSchema = z.object({
  /** The 提醒投递记录 id. */
  id: z.uuid(),
  taskId: z.uuid(),
  title: z.string(),
  dates: taskDatesSchema.nullable(),
  fireAt: z.iso.datetime(),
  firedAt: z.iso.datetime(),
});
export type ReminderAlert = z.infer<typeof reminderAlertSchema>;
export const reminderAlertsResponseSchema = z.object({ alerts: z.array(reminderAlertSchema) });
export type ReminderAlertsResponse = z.infer<typeof reminderAlertsResponseSchema>;

/** `POST /api/reminders/alerts/:id/snooze`: 稍后提醒. */
export const snoozeRequestSchema = z
  .object({ minutes: z.number().int().min(1).max(7 * 24 * 60) })
  .strict();
export type SnoozeRequest = z.infer<typeof snoozeRequestSchema>;

/** One delivery to one 通知渠道 that failed after its retries (用户故事 83). */
export const reminderFailureSchema = z.object({
  /** The 提醒投递记录 id. */
  id: z.uuid(),
  taskId: z.uuid(),
  taskTitle: z.string(),
  channelId: z.uuid(),
  channelName: z.string(),
  fireAt: z.iso.datetime(),
  failedAt: z.iso.datetime(),
  attempts: z.number().int(),
  error: z.string(),
});
export type ReminderFailure = z.infer<typeof reminderFailureSchema>;
export const reminderFailuresResponseSchema = z.object({ failures: z.array(reminderFailureSchema) });
export type ReminderFailuresResponse = z.infer<typeof reminderFailuresResponseSchema>;
