import { z } from 'zod';

/*
 * 任务日期 (spec 用户故事 23–26). A task has no date, a due date, or a range
 * (start → due). Two kinds of storage, chosen so that changing the user's
 * time zone does the right thing:
 *
 *   - all-day: calendar dates (`YYYY-MM-DD`), never converted between zones;
 *   - timed: UTC instants plus the time zone the user had when setting them.
 *     They are always *displayed* in the user's current time zone.
 */

export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export const timeZoneSchema = z.string().max(64).refine(isValidTimeZone, '不支持的时区');

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isRealDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** A calendar date `YYYY-MM-DD` with no time zone. */
export const calendarDateSchema = z.string().refine(isRealDate, '日期格式应为 YYYY-MM-DD');
const instantSchema = z.iso.datetime();

const allDaySchema = z.object({
  allDay: z.literal(true),
  startDate: calendarDateSchema.nullable(),
  dueDate: calendarDateSchema,
});
const timedSchema = z.object({
  allDay: z.literal(false),
  startAt: instantSchema.nullable(),
  dueAt: instantSchema,
  /** The user's time zone when the dates were set (for later repeat / reminder rules). */
  timeZone: z.string(),
});

/** Dates as the API returns them; `null` on the task means "no date". */
export const taskDatesSchema = z.discriminatedUnion('allDay', [allDaySchema, timedSchema]);
export type TaskDates = z.infer<typeof taskDatesSchema>;

const startNotAfterDue = (d: { allDay: boolean; startDate?: string | null; dueDate?: string; startAt?: string | null; dueAt?: string }) =>
  d.allDay
    ? !d.startDate || d.startDate <= (d.dueDate as string)
    : !d.startAt || Date.parse(d.startAt) <= Date.parse(d.dueAt as string);

/**
 * Dates as clients send them. Timed dates carry no time zone: the server
 * stamps the user's current setting.
 */
export const taskDatesInputSchema = z
  .discriminatedUnion('allDay', [
    allDaySchema.extend({ startDate: calendarDateSchema.nullable().default(null) }).strict(),
    timedSchema.omit({ timeZone: true }).extend({ startAt: instantSchema.nullable().default(null) }).strict(),
  ])
  .refine(startNotAfterDue, { message: '开始时间不能晚于截止时间' });
export type TaskDatesInput = z.input<typeof taskDatesInputSchema>;

// --- time-zone arithmetic -------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

function wallClock(instant: Date, timeZone: string) {
  const parts: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(instant)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Calendar date and `HH:mm` of an instant as seen in `timeZone`. */
export function zonedDateTime(instant: string | Date, timeZone: string): { date: string; time: string } {
  const w = wallClock(new Date(instant), timeZone);
  return { date: `${w.year}-${pad(w.month)}-${pad(w.day)}`, time: `${pad(w.hour)}:${pad(w.minute)}` };
}

/** Today's calendar date in `timeZone`. */
export function todayIn(now: Date, timeZone: string): string {
  return zonedDateTime(now, timeZone).date;
}

/** Offset of `timeZone` from UTC at `instant`, in milliseconds. */
function offsetAt(instant: number, timeZone: string): number {
  const w = wallClock(new Date(instant), timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  // The wall clock has whole seconds, so drop the instant's milliseconds too.
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** The UTC instant (ISO string) of wall-clock `date` + `time` (`HH:mm`) in `timeZone`. */
export function zonedToInstant(date: string, time: string, timeZone: string): string {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi] = time.split(':').map(Number) as [number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  // Two passes settle the offset, including around DST changes.
  let instant = wall - offsetAt(wall, timeZone);
  instant = wall - offsetAt(instant, timeZone);
  return new Date(instant).toISOString();
}

function dayNumber(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

export function addDays(date: string, days: number): string {
  const t = new Date((dayNumber(date) + days) * 86_400_000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Day of week of a calendar date, 0 = Sunday. */
export function weekday(date: string): number {
  return new Date(dayNumber(date) * 86_400_000).getUTCDay();
}

/** Whole days from `from` to `to`. */
export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

// --- labels -----------------------------------------------------------------

export const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

/** 今天 / 明天 / 昨天 / 周几 (the next 6 days) / M月D日 / YYYY年M月D日, like 滴答's list. */
export function relativeDayLabel(date: string, today: string): string {
  const diff = daysBetween(today, date);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === -1) return '昨天';
  if (diff > 1 && diff < 7) return WEEKDAY_NAMES[weekday(date)] as string;
  const [y, m, d] = date.split('-').map(Number);
  return y === Number(today.slice(0, 4)) ? `${m}月${d}日` : `${y}年${m}月${d}日`;
}

export interface TaskDateLabel {
  text: string;
  overdue: boolean;
}

/**
 * The date label shown in task lists and the detail header. Timed dates are
 * shown in `timeZone` (the user's current setting); all-day dates as stored.
 */
export function describeTaskDates(dates: TaskDates, { now, timeZone }: { now: Date; timeZone: string }): TaskDateLabel {
  const today = todayIn(now, timeZone);
  if (dates.allDay) {
    const due = relativeDayLabel(dates.dueDate, today);
    const text = dates.startDate ? `${relativeDayLabel(dates.startDate, today)} - ${due}` : due;
    return { text, overdue: dates.dueDate < today };
  }
  const point = (instant: string) => {
    const { date, time } = zonedDateTime(instant, timeZone);
    return { date, time, day: date === today ? null : relativeDayLabel(date, today) };
  };
  const due = point(dates.dueAt);
  const join = (p: { day: string | null; time: string }) => (p.day ? `${p.day} ${p.time}` : p.time);
  let text = join(due);
  if (dates.startAt) {
    const start = point(dates.startAt);
    text = start.date === due.date ? `${join(start)} - ${due.time}` : `${join(start)} - ${join(due)}`;
  }
  return { text, overdue: Date.parse(dates.dueAt) < now.getTime() };
}
