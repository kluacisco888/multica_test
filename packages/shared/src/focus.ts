import { z } from 'zod';
import { calendarDateSchema, addDays, todayIn, weekday, zonedDateTime } from './task-dates.js';
import { daysInMonth, parseCivilDate, formatCivilDate } from './civil-date.js';
import type { ChannelMessage } from './channels.js';

/*
 * 专注 (spec 用户故事 86–92): 番茄 and 正计时. The timer lives on the server
 * (ADR-0004 record `focus_sessions`); the page only displays it, so a refresh
 * or another device continues the same countdown.
 *
 * A session's time is `accumulatedMs` (running time before the last pause)
 * plus, while running, the time since `resumedAt`.
 */

export const FOCUS_MODES = ['pomodoro', 'stopwatch'] as const;
export const focusModeSchema = z.enum(FOCUS_MODES);
export type FocusMode = z.infer<typeof focusModeSchema>;

/** `focus` is the 专注 itself; a 番茄 is followed by a 短休息 or 长休息. */
export const FOCUS_PHASES = ['focus', 'shortBreak', 'longBreak'] as const;
export const focusPhaseSchema = z.enum(FOCUS_PHASES);
export type FocusPhase = z.infer<typeof focusPhaseSchema>;
export type BreakPhase = Exclude<FocusPhase, 'focus'>;

export const FOCUS_STATUSES = ['running', 'paused', 'completed', 'abandoned'] as const;
export const focusStatusSchema = z.enum(FOCUS_STATUSES);
export type FocusStatus = z.infer<typeof focusStatusSchema>;

export const FOCUS_PHASE_LABELS: Record<FocusPhase, string> = { focus: '专注', shortBreak: '短休息', longBreak: '长休息' };

/** 番茄设置 (spec 用户故事 86): lengths in minutes, 长休息 after every `longBreakEvery` 番茄. */
export const DEFAULT_POMODORO_SETTINGS = { focusMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, longBreakEvery: 4 } as const;
const minutes = (max: number) => z.number().int().min(1).max(max);
export const pomodoroSettingsSchema = z.object({
  focusMinutes: minutes(180).default(DEFAULT_POMODORO_SETTINGS.focusMinutes),
  shortBreakMinutes: minutes(60).default(DEFAULT_POMODORO_SETTINGS.shortBreakMinutes),
  longBreakMinutes: minutes(60).default(DEFAULT_POMODORO_SETTINGS.longBreakMinutes),
  longBreakEvery: z.number().int().min(1).max(10).default(DEFAULT_POMODORO_SETTINGS.longBreakEvery),
});
export type PomodoroSettings = z.infer<typeof pomodoroSettingsSchema>;
/** `PATCH /api/settings` `{ pomodoro: {...} }`: any subset. */
export const pomodoroSettingsPatchSchema = z
  .object({
    focusMinutes: minutes(180),
    shortBreakMinutes: minutes(60),
    longBreakMinutes: minutes(60),
    longBreakEvery: z.number().int().min(1).max(10),
  })
  .partial()
  .strict();

/**
 * A finished 专注 the server completed while nobody had the page open is
 * reported through the 通知渠道. An open page settles its own session when the
 * countdown ends; the server waits this long before treating the page as closed.
 */
export const FOCUS_NOTIFY_GRACE_MS = 15_000;

/* ---- timer arithmetic ---- */

export interface FocusClock {
  plannedMs: number | null;
  accumulatedMs: number;
  /** ISO instant or Date the current running stretch began; null while paused or finished. */
  resumedAt: string | Date | null;
}

export function focusElapsedMs(s: FocusClock, now: Date): number {
  if (!s.resumedAt) return s.accumulatedMs;
  return s.accumulatedMs + Math.max(0, now.getTime() - new Date(s.resumedAt).getTime());
}

/** When a running countdown reaches zero; null for 正计时 and paused sessions. */
export function focusEndsAt(s: FocusClock): Date | null {
  if (s.plannedMs === null || !s.resumedAt) return null;
  return new Date(new Date(s.resumedAt).getTime() + s.plannedMs - s.accumulatedMs);
}

/** Countdown left; null for 正计时. */
export function focusRemainingMs(s: FocusClock, now: Date): number | null {
  if (s.plannedMs === null) return null;
  return Math.max(0, s.plannedMs - focusElapsedMs(s, now));
}

/** The break after a 番茄: `completed` is the number of 番茄 since the last 长休息, this one included. */
export function nextBreakPhase(completed: number, longBreakEvery: number): BreakPhase {
  return completed > 0 && completed % longBreakEvery === 0 ? 'longBreak' : 'shortBreak';
}

/* ---- statistics ---- */

export const FOCUS_STAT_UNITS = ['day', 'week', 'month'] as const;
export const focusStatUnitSchema = z.enum(FOCUS_STAT_UNITS);
export type FocusStatUnit = z.infer<typeof focusStatUnitSchema>;
export const FOCUS_STAT_UNIT_LABELS: Record<FocusStatUnit, string> = { day: '日', week: '周', month: '月' };

/** The day, week (Monday first) or month containing `date`. */
export function focusPeriod(unit: FocusStatUnit, date: string): { from: string; to: string } {
  if (unit === 'day') return { from: date, to: date };
  if (unit === 'week') {
    const from = addDays(date, -((weekday(date) + 6) % 7));
    return { from, to: addDays(from, 6) };
  }
  const { year, month } = parseCivilDate(date);
  return { from: formatCivilDate({ year, month, day: 1 }), to: formatCivilDate({ year, month, day: daysInMonth(year, month) }) };
}

/** A date in the previous / next period. */
export function stepFocusPeriod(unit: FocusStatUnit, date: string, direction: 1 | -1): string {
  if (unit === 'day') return addDays(date, direction);
  if (unit === 'week') return addDays(date, 7 * direction);
  const { year, month } = parseCivilDate(date);
  const m = year * 12 + (month - 1) + direction;
  return formatCivilDate({ year: Math.floor(m / 12), month: (m % 12) + 1, day: 1 });
}

/** One finished 专注 as the statistics see it. */
export interface FocusRecordInput {
  startedAt: string;
  focusMs: number;
  /** A 番茄 (counts towards 番茄); false for 正计时. */
  pomodoro: boolean;
  taskId: string | null;
  taskTitle: string | null;
}

const focusTotalsSchema = z.object({ pomodoros: z.number().int(), focusMs: z.number().int() });
const focusTaskTotalSchema = focusTotalsSchema.extend({ taskId: z.uuid(), title: z.string() });
export type FocusTaskTotal = z.infer<typeof focusTaskTotalSchema>;

export const focusStatsSchema = z.object({
  unit: focusStatUnitSchema,
  from: calendarDateSchema,
  to: calendarDateSchema,
  pomodoros: z.number().int(),
  focusMs: z.number().int(),
  /** Every day of the period, empty days included. */
  days: z.array(focusTotalsSchema.extend({ date: calendarDateSchema })),
  /** Per 任务 in the period, most time first. */
  tasks: z.array(focusTaskTotalSchema),
  /** 概览. */
  overview: z.object({
    todayPomodoros: z.number().int(),
    todayFocusMs: z.number().int(),
    totalPomodoros: z.number().int(),
    totalFocusMs: z.number().int(),
  }),
  /** 每个任务累计用时: per 任务 over all time, most time first. */
  taskTotals: z.array(focusTaskTotalSchema),
});
export type FocusStats = z.infer<typeof focusStatsSchema>;

export const focusStatsQuerySchema = z.object({ unit: focusStatUnitSchema.default('day'), date: calendarDateSchema.optional() }).strict();

function perTask(records: FocusRecordInput[]): FocusTaskTotal[] {
  const byTask = new Map<string, FocusTaskTotal>();
  for (const r of records) {
    if (!r.taskId) continue;
    const t = byTask.get(r.taskId) ?? { taskId: r.taskId, title: r.taskTitle ?? '', pomodoros: 0, focusMs: 0 };
    t.pomodoros += r.pomodoro ? 1 : 0;
    t.focusMs += r.focusMs;
    byTask.set(r.taskId, t);
  }
  return [...byTask.values()].sort((a, b) => b.focusMs - a.focusMs || a.title.localeCompare(b.title) || a.taskId.localeCompare(b.taskId));
}

const total = (records: FocusRecordInput[]) => ({
  pomodoros: records.filter((r) => r.pomodoro).length,
  focusMs: records.reduce((sum, r) => sum + r.focusMs, 0),
});

/** 专注统计 (spec 用户故事 92): a 专注 counts on the day it started, in the user's time zone. */
export function summarizeFocus(
  records: readonly FocusRecordInput[],
  { unit, date, timeZone, now }: { unit: FocusStatUnit; date: string; timeZone: string; now: Date },
): FocusStats {
  const { from, to } = focusPeriod(unit, date);
  const today = todayIn(now, timeZone);
  const dated = records.map((r) => ({ ...r, day: zonedDateTime(r.startedAt, timeZone).date }));
  const inPeriod = dated.filter((r) => r.day >= from && r.day <= to);
  const days: FocusStats['days'] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push({ date: d, ...total(inPeriod.filter((r) => r.day === d)) });
  const todays = total(dated.filter((r) => r.day === today));
  const all = total([...records]);
  return {
    unit,
    from,
    to,
    ...total(inPeriod),
    days,
    tasks: perTask(inPeriod),
    overview: { todayPomodoros: todays.pomodoros, todayFocusMs: todays.focusMs, totalPomodoros: all.pomodoros, totalFocusMs: all.focusMs },
    taskTotals: perTask([...records]),
  };
}

/* ---- labels ---- */

/** `25m`, `1h 5m`, `2h` as in the reference's 概览 and 专注记录. */
export function formatFocusDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** `MM:SS` (or `H:MM:SS`) on the timer. */
export function formatTimer(ms: number): string {
  const s = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const rest = `${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  return h > 0 ? `${h}:${rest}` : rest;
}

/** What a 通知渠道 receives when a 番茄 ended while the page was closed. */
export function focusMessage({ taskTitle, focusMs, breakPhase }: { taskTitle: string | null; focusMs: number; breakPhase: BreakPhase }): ChannelMessage {
  return {
    title: taskTitle ? `专注结束：${taskTitle}` : '专注结束',
    body: `完成了 ${Math.round(focusMs / 60_000)} 分钟专注，${FOCUS_PHASE_LABELS[breakPhase]}开始了\n来自勾勾清单`,
  };
}

/* ---- API ---- */

/** The current (running or paused) session, or a finished one in 专注记录. */
export const focusSessionSchema = z.object({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  revision: z.number().int(),
  mode: focusModeSchema,
  phase: focusPhaseSchema,
  status: focusStatusSchema,
  taskId: z.uuid().nullable(),
  /** Title of the linked 任务 (kept for 专注记录 even after it was deleted). */
  taskTitle: z.string().nullable(),
  /** Countdown length; null for 正计时. */
  plannedMs: z.number().int().nullable(),
  accumulatedMs: z.number().int(),
  resumedAt: z.iso.datetime().nullable(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  /** When the running countdown reaches zero. */
  endsAt: z.iso.datetime().nullable(),
});
export type FocusSession = z.infer<typeof focusSessionSchema>;

/** `GET /api/focus/current` (and every timer action): `now` lets the page correct its clock. */
export const currentFocusResponseSchema = z.object({ session: focusSessionSchema.nullable(), now: z.iso.datetime() });
export type CurrentFocusResponse = z.infer<typeof currentFocusResponseSchema>;

/** `POST /api/focus/start`: a 番茄 (`pomodoro`) or 正计时 (`stopwatch`), optionally for a 任务. */
export const startFocusRequestSchema = z
  .object({ id: z.uuid().optional(), mode: focusModeSchema, taskId: z.uuid().nullable().optional() })
  .strict();
export type StartFocusRequest = z.infer<typeof startFocusRequestSchema>;

/** `PATCH /api/focus/current`: link or unlink a 任务. */
export const updateFocusRequestSchema = z.object({ taskId: z.uuid().nullable() }).strict();
export type UpdateFocusRequest = z.infer<typeof updateFocusRequestSchema>;

/** `GET /api/focus/records`: finished 专注 (番茄 and 正计时), newest first. */
export const focusRecordSchema = z.object({
  id: z.uuid(),
  mode: focusModeSchema,
  taskId: z.uuid().nullable(),
  taskTitle: z.string().nullable(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
  focusMs: z.number().int(),
});
export type FocusRecord = z.infer<typeof focusRecordSchema>;
export const focusRecordsResponseSchema = z.object({ records: z.array(focusRecordSchema) });
export type FocusRecordsResponse = z.infer<typeof focusRecordsResponseSchema>;
export const FOCUS_RECORDS_LIMIT = 100;
