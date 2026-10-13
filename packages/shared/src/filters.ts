import { z } from 'zod';
import { entityNameSchema, sortKeySchema } from './lists.js';
import { taskDaySpan, type SmartTask, type ViewClock } from './smart-lists.js';
import { addDays, todayIn } from './task-dates.js';
import { prioritySchema, type Priority } from './tasks.js';

/*
 * 过滤器 (spec 用户故事 62): a user-defined view over 清单, 标签, 日期 and
 * 优先级. Within one condition any chosen value matches (OR); across
 * conditions all must match (AND); an empty condition matches everything.
 * Unlike 智能清单 a 过滤器 also selects tasks of 清单 with 不进智能清单 on.
 * 放弃 tasks never show; completed ones show in the 已完成 section.
 */

export const FILTER_DATE_OPTIONS = ['overdue', 'today', 'tomorrow', 'week', 'noDate'] as const;
export const filterDateSchema = z.enum(FILTER_DATE_OPTIONS);
export type FilterDate = z.infer<typeof filterDateSchema>;
export const FILTER_DATE_LABELS: Record<FilterDate, string> = {
  overdue: '已过期',
  today: '今天',
  tomorrow: '明天',
  week: '最近7天',
  noDate: '无日期',
};

const MAX_VALUES = 200;
const distinct = <T>(values: T[]) => [...new Set(values)];
const idsSchema = z
  .array(z.uuid())
  .max(MAX_VALUES)
  .transform((ids) => distinct(ids.map((id) => id.toLowerCase())));

export const filterRulesSchema = z
  .object({
    /** Any of these 清单; empty: every 清单. */
    listIds: idsSchema.default([]),
    /** Any of these 标签 (a parent 标签 includes its children). */
    tagIds: idsSchema.default([]),
    /** Also match tasks without 标签. */
    untagged: z.boolean().default(false),
    dates: z.array(filterDateSchema).max(FILTER_DATE_OPTIONS.length).transform(distinct).default([]),
    priorities: z.array(prioritySchema).max(4).transform(distinct).default([]),
  })
  .strict();
export type FilterRules = z.output<typeof filterRulesSchema>;
export type FilterRulesInput = z.input<typeof filterRulesSchema>;

export const filterSchema = z.object({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  revision: z.number().int().nonnegative(),
  name: z.string(),
  rules: filterRulesSchema,
  sortOrder: z.string(),
});
export type Filter = z.infer<typeof filterSchema>;

export const filtersResponseSchema = z.object({ filters: z.array(filterSchema) });

export const createFilterRequestSchema = z
  .object({
    id: z.uuid().optional(),
    name: entityNameSchema,
    rules: filterRulesSchema,
    /** Defaults to the end of the 过滤器 section. */
    sortOrder: sortKeySchema.optional(),
  })
  .strict();
export type CreateFilterRequest = z.input<typeof createFilterRequestSchema>;

export const updateFilterRequestSchema = z
  .object({ name: entityNameSchema, rules: filterRulesSchema, sortOrder: sortKeySchema })
  .partial()
  .strict();
export type UpdateFilterRequest = z.input<typeof updateFilterRequestSchema>;

/** What the matcher reads from a 任务. */
export interface FilterTask extends SmartTask {
  listId: string;
  tagIds: string[];
}

/** True when no condition is set: the 过滤器 shows every task. */
export function isEmptyFilter(rules: FilterRules): boolean {
  return rules.listIds.length === 0 && rules.tagIds.length === 0 && !rules.untagged && rules.dates.length === 0 && rules.priorities.length === 0;
}

function matchesDate(option: FilterDate, task: FilterTask, today: string, timeZone: string): boolean {
  const span = taskDaySpan(task.dates, timeZone);
  if (option === 'noDate') return span === null;
  if (span === null) return false;
  if (option === 'overdue') return task.status === 'open' && span.due < today;
  const from = option === 'tomorrow' ? addDays(today, 1) : today;
  const to = option === 'week' ? addDays(today, 6) : from;
  return span.start <= to && span.due >= from;
}

/**
 * Does `task` pass `rules`? `tagScope` is `rules.tagIds` plus the children of
 * every chosen parent 标签 (see `tagWithChildren`).
 */
export function matchesFilter(rules: FilterRules, task: FilterTask, clock: ViewClock, tagScope: ReadonlySet<string>): boolean {
  if (task.status === 'abandoned') return false;
  if (rules.listIds.length > 0 && !rules.listIds.includes(task.listId)) return false;
  if (rules.tagIds.length > 0 || rules.untagged) {
    const tagged = task.tagIds.some((id) => tagScope.has(id));
    if (!tagged && !(rules.untagged && task.tagIds.length === 0)) return false;
  }
  if (rules.priorities.length > 0 && !rules.priorities.includes(task.priority as Priority)) return false;
  if (rules.dates.length > 0) {
    const today = todayIn(clock.now, clock.timeZone);
    if (!rules.dates.some((d) => matchesDate(d, task, today, clock.timeZone))) return false;
  }
  return true;
}
