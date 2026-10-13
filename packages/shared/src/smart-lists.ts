import { z } from 'zod';
import { addDays, todayIn, zonedDateTime, type TaskDates } from './task-dates.js';
import type { Priority, TaskStatus } from './tasks.js';

/*
 * 智能清单 (spec 用户故事 59–61). Built-in views with fixed rules; they own no
 * tasks. 回收站 is the sixth one and comes with the trash work (13a).
 *
 * Rules, checked against the reference (ADR-0007 screenshots of 今天 / 明天 /
 * 最近7天):
 *   - 今天: open tasks whose dates reach today, plus overdue ones (shown as
 *     their own 已过期 group), plus tasks completed today or dated today.
 *   - 明天: the same for tomorrow, without overdue tasks.
 *   - 最近 7 天: today … today + 6, plus overdue ones.
 *   - 已完成: every completed task.
 *   - 不重要的: open tasks with 低优先级 (not visible in the reference account;
 *     the rule lives in `matchesSmartList` only, so it is a one-line change).
 * A task "reaches" a day when the day lies between its start and due day; a
 * task with only a due date reaches its due day. Timed dates count in the
 * user's current time zone. 放弃 tasks never show.
 *
 * Which 清单 take part is decided by `listInSmartLists` alone: 清单 with
 * 不进智能清单 switched on are left out (用户故事 17). 归档 (EURO-15) adds its
 * condition there.
 */

export const SMART_LIST_IDS = ['today', 'tomorrow', 'week', 'completed', 'notImportant'] as const;
export const smartListIdSchema = z.enum(SMART_LIST_IDS);
export type SmartListId = z.infer<typeof smartListIdSchema>;

export const SMART_LIST_NAMES: Record<SmartListId, string> = {
  today: '今天',
  tomorrow: '明天',
  week: '最近7天',
  completed: '已完成',
  notImportant: '不重要的',
};

/** Smart lists whose sidebar entry shows a count of open tasks. */
export const COUNTED_SMART_LISTS: readonly SmartListId[] = ['today', 'tomorrow', 'week'];

export interface ViewClock {
  now: Date;
  timeZone: string;
}

/** What the rules read from a 任务. */
export interface SmartTask {
  status: TaskStatus;
  completedAt: string | null;
  dates: TaskDates | null;
  priority: Priority;
}

/** First and last calendar day a task's dates cover, in `timeZone`; null without dates. */
export function taskDaySpan(dates: TaskDates | null, timeZone: string): { start: string; due: string } | null {
  if (!dates) return null;
  if (dates.allDay) return { start: dates.startDate ?? dates.dueDate, due: dates.dueDate };
  const due = zonedDateTime(dates.dueAt, timeZone).date;
  return { start: dates.startAt ? zonedDateTime(dates.startAt, timeZone).date : due, due };
}

/** Does a 清单 take part in 智能清单? */
export function listInSmartLists(list: { excludeFromSmartLists: boolean }): boolean {
  return !list.excludeFromSmartLists;
}

function window(id: 'today' | 'tomorrow' | 'week', today: string): { from: string; to: string; overdue: boolean } {
  if (id === 'today') return { from: today, to: today, overdue: true };
  if (id === 'tomorrow') return { from: addDays(today, 1), to: addDays(today, 1), overdue: false };
  return { from: today, to: addDays(today, 6), overdue: true };
}

/** Does `task` belong to the smart list `id`? (Its 清单 is checked separately, see `listInSmartLists`.) */
export function matchesSmartList(id: SmartListId, task: SmartTask, clock: ViewClock): boolean {
  if (task.status === 'abandoned') return false;
  if (id === 'completed') return task.status === 'completed';
  if (id === 'notImportant') return task.status === 'open' && task.priority === 'low';

  const today = todayIn(clock.now, clock.timeZone);
  const { from, to, overdue } = window(id, today);
  const span = taskDaySpan(task.dates, clock.timeZone);
  const reaches = span !== null && span.start <= to && span.due >= from;
  if (task.status === 'open') return reaches || (overdue && span !== null && span.due < today);
  // Completed: dated inside the window, or completed inside it.
  if (reaches) return true;
  if (!task.completedAt) return false;
  const done = todayIn(new Date(task.completedAt), clock.timeZone);
  return done >= from && done <= to;
}

/** 侧栏: smart lists the user has hidden (用户故事 60). */
export const hiddenSmartListsSchema = z
  .array(smartListIdSchema)
  .max(SMART_LIST_IDS.length)
  .transform((ids) => [...new Set(ids)]);

/** `GET /api/smart-lists`: open-task counts for the counted smart lists. */
export const smartListCountsResponseSchema = z.object({
  counts: z.record(z.string(), z.number().int().nonnegative()),
});
export type SmartListCountsResponse = z.infer<typeof smartListCountsResponseSchema>;
