import { z } from 'zod';
import { addDays } from './task-dates.js';
import type { FocusMode } from './focus.js';

/*
 * 成就分 (spec 用户故事 103), the rules the maintainer settled on EURO-28:
 *
 * | 事件                                               | 分数 |
 * | 按时完成任务（截止日当天或之前，或没设日期）         | +5   |
 * | 过期后才完成任务                                    | +2   |
 * | 完成一个番茄（正计时每满 25 分钟也算一个）           | +3   |
 * | 任务过期（每个任务只扣一次，补完成也不退回）         | −2   |
 * | 放弃、删除任务                                      | 0    |
 * | 取消完成                                            | 收回 |
 *
 * At most +100 a day (the day's −2s still count), and the total never goes
 * below 0. Nothing is stored: the score is recomputed from the 任务 and 专注
 * history every time, so changing a value here re-scores old data too.
 *
 * Everything is in calendar days of the user's time zone.
 */

export const ACHIEVEMENT_POINTS = { onTime: 5, late: 2, pomodoro: 3, overdue: -2 } as const;
export const ACHIEVEMENT_DAILY_GAIN_CAP = 100;
/** 正计时 earns one 番茄 for every full stretch this long. */
export const STOPWATCH_POMODORO_MS = 25 * 60_000;
export const ACHIEVEMENT_HISTORY_DAYS = 7;

/** One 任务 as the 成就分 sees it. */
export interface AchievementTaskInput {
  /** 截止日; null without a date. */
  dueDay: string | null;
  /**
   * First day the 任务 was overdue, remembered when its date was changed or
   * cleared afterwards (so the −2 stays); null when nothing was remembered.
   */
  overdueDay: string | null;
  /** Day it was 完成; null while not completed (取消完成 clears it). */
  completedDay: string | null;
  /** Day it was 放弃 or 删除 without being completed; null otherwise. */
  closedDay: string | null;
}

/** 番茄 finished on one day (正计时 already converted, see `focusPomodoroCount`). */
export interface AchievementFocusInput {
  day: string;
  pomodoros: number;
}

/** How many 番茄 a finished 专注 is worth: a 番茄钟 is one, 正计时 one per full 25 minutes. */
export function focusPomodoroCount({ mode, focusMs }: { mode: FocusMode; focusMs: number }): number {
  return mode === 'pomodoro' ? 1 : Math.floor(focusMs / STOPWATCH_POMODORO_MS);
}

/**
 * The day the 任务 became overdue, or null if it has not (by `today`): the day
 * after its 截止日, if that day came before it was completed, 放弃 or 删除.
 */
export function taskOverdueDay(task: AchievementTaskInput, today: string): string | null {
  if (task.overdueDay) return task.overdueDay;
  if (!task.dueDay) return null;
  const overdue = addDays(task.dueDay, 1);
  const end = task.completedDay ?? task.closedDay ?? today;
  return overdue <= end ? overdue : null;
}

export const ACHIEVEMENT_LEVELS = [
  { level: 1, name: '新手', min: 0 },
  { level: 2, name: '初级', min: 100 },
  { level: 3, name: '勤奋者', min: 300 },
  { level: 4, name: '挑战者', min: 700 },
  { level: 5, name: '新星', min: 1400 },
  { level: 6, name: '自由者', min: 3000 },
  { level: 7, name: '飞跃者', min: 6000 },
  { level: 8, name: '超级英雄', min: 10000 },
  { level: 9, name: '传奇', min: 20000 },
  { level: 10, name: '黄金', min: 50000 },
] as const;

export const achievementLevelSchema = z.object({
  level: z.number().int(),
  name: z.string(),
  min: z.number().int(),
  /** Score of the next level; null at the top. */
  next: z.number().int().nullable(),
});
export type AchievementLevel = z.infer<typeof achievementLevelSchema>;

export function achievementLevel(score: number): AchievementLevel {
  let i = 0;
  while (i + 1 < ACHIEVEMENT_LEVELS.length && score >= ACHIEVEMENT_LEVELS[i + 1]!.min) i += 1;
  const current = ACHIEVEMENT_LEVELS[i]!;
  return { level: current.level, name: current.name, min: current.min, next: ACHIEVEMENT_LEVELS[i + 1]?.min ?? null };
}

export const achievementSchema = z.object({
  score: z.number().int(),
  level: achievementLevelSchema,
  /** Score at the end of each of the last 7 days, today last. */
  history: z.array(z.object({ date: z.string(), score: z.number().int() })),
});
export type Achievement = z.infer<typeof achievementSchema>;

export function achievementScore(tasks: readonly AchievementTaskInput[], focus: readonly AchievementFocusInput[], today: string): Achievement {
  const gains = new Map<string, number>();
  const losses = new Map<string, number>();
  const add = (map: Map<string, number>, day: string, points: number) => {
    if (day <= today) map.set(day, (map.get(day) ?? 0) + points);
  };
  for (const t of tasks) {
    const overdue = taskOverdueDay(t, today);
    if (overdue) add(losses, overdue, ACHIEVEMENT_POINTS.overdue);
    if (t.completedDay) {
      const late = overdue !== null && overdue <= t.completedDay;
      add(gains, t.completedDay, late ? ACHIEVEMENT_POINTS.late : ACHIEVEMENT_POINTS.onTime);
    }
  }
  for (const f of focus) if (f.pomodoros > 0) add(gains, f.day, f.pomodoros * ACHIEVEMENT_POINTS.pomodoro);

  const historyFrom = addDays(today, -(ACHIEVEMENT_HISTORY_DAYS - 1));
  const days = [...new Set([...gains.keys(), ...losses.keys()])].sort();
  let score = 0;
  let i = 0;
  const step = (day: string) => {
    const gain = Math.min(ACHIEVEMENT_DAILY_GAIN_CAP, gains.get(day) ?? 0);
    score = Math.max(0, score + gain + (losses.get(day) ?? 0));
  };
  for (; i < days.length && days[i]! < historyFrom; i++) step(days[i]!);
  const history: Achievement['history'] = [];
  for (let d = historyFrom; d <= today; d = addDays(d, 1)) {
    if (days[i] === d) {
      step(d);
      i += 1;
    }
    history.push({ date: d, score });
  }
  return { score, level: achievementLevel(score), history };
}
