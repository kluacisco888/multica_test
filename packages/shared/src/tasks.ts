import { z } from 'zod';
import { calendarRangeSchema } from './calendar.js';
import { sortKeySchema } from './lists.js';
import { reminderSchema, remindersSchema } from './reminders.js';
import { repeatRuleSchema } from './repeat-rule.js';
import { smartListIdSchema } from './smart-lists.js';
import { taskDatesInputSchema, taskDatesSchema } from './task-dates.js';

/*
 * 任务 basics (spec 用户故事 20、21、27、31、40), dates (23–26, see
 * `task-dates.ts`), 子任务 and 检查清单 mode (用户故事 35–37), 优先级 and 标签
 * (22、18), 放弃 and the 回收站 (28–30).
 *
 * Status: `open`, `completed` (完成, counts as done) or `abandoned` (放弃: kept,
 * but never counted as done). `completedAt` is set only while completed,
 * `abandonedAt` only while abandoned.
 *
 * 子任务 rules (see task-tree.ts): a 子任务 lives in its parent's 清单, trees
 * are at most 5 levels deep counting the root as level 1, completing a task
 * completes its whole subtree, re-opening a 子任务 re-opens its completed
 * ancestors.
 */

export const TASK_TITLE_MAX_LENGTH = 512;
export const TASK_DESCRIPTION_MAX_LENGTH = 100_000;

/** 优先级 (spec 用户故事 22). */
export const PRIORITIES = ['high', 'medium', 'low', 'none'] as const;
export const prioritySchema = z.enum(PRIORITIES);
export type Priority = z.infer<typeof prioritySchema>;
export const PRIORITY_LABELS: Record<Priority, string> = { high: '高优先级', medium: '中优先级', low: '低优先级', none: '无优先级' };

/** A 任务's 标签 ids: distinct, at most 50. */
export const TASK_MAX_TAGS = 50;
const tagIdsSchema = z
  .array(z.uuid())
  .max(TASK_MAX_TAGS, `最多 ${TASK_MAX_TAGS} 个标签`)
  // Lower-case like PostgreSQL prints uuids, so duplicates differing in case collapse too.
  .transform((ids) => [...new Set(ids.map((id) => id.toLowerCase()))]);

export const taskStatusSchema = z.enum(['open', 'completed', 'abandoned']);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

/** `text`: Markdown 描述; `checklist`: the content is a list of 检查项. */
export const taskKindSchema = z.enum(['text', 'checklist']);
export type TaskKind = z.infer<typeof taskKindSchema>;

export const taskSchema = z.object({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  revision: z.number().int().nonnegative(),
  listId: z.uuid(),
  /** Parent 任务 for a 子任务, null for a top-level task. */
  parentId: z.uuid().nullable(),
  title: z.string(),
  kind: taskKindSchema,
  /** Markdown source; always empty in `checklist` mode. */
  description: z.string(),
  status: taskStatusSchema,
  completedAt: z.iso.datetime().nullable(),
  /** When it was 放弃; null unless `status` is `abandoned`. */
  abandonedAt: z.iso.datetime().nullable(),
  sortOrder: z.string(),
  /** null: no date. */
  dates: taskDatesSchema.nullable(),
  priority: prioritySchema,
  /** 标签 ids, in the order they were added. */
  tagIds: z.array(z.uuid()),
  /** 重复规则; null: not a 重复任务. Always null when the task has no date. */
  repeat: repeatRuleSchema.nullable(),
  /** 提醒 (see reminders.ts); empty without a date. Each fits the kind of date (timed / 全天). */
  reminders: z.array(reminderSchema),
  /** 通知渠道 the reminders go to; null: the user's default channels (用户故事 78). */
  reminderChannelIds: z.array(z.uuid()).nullable(),
});
export type Task = z.infer<typeof taskSchema>;

/** A task's 通知渠道 ids: distinct, at most 20. */
const reminderChannelIdsSchema = z
  .array(z.uuid())
  .max(20, '最多 20 个通知渠道')
  .transform((ids) => [...new Set(ids.map((id) => id.toLowerCase()))])
  .nullable();

const titleSchema = z.string().trim().min(1, '标题不能为空').max(TASK_TITLE_MAX_LENGTH, `标题最多 ${TASK_TITLE_MAX_LENGTH} 个字符`);
const descriptionSchema = z.string().max(TASK_DESCRIPTION_MAX_LENGTH, '描述太长');

export const createTaskRequestSchema = z.object({
  id: z.uuid().optional(),
  /** Omitted or null: the 收件箱. */
  listId: z.uuid().nullable().optional(),
  /** Create a 子任务; it goes into the parent's 清单 (`listId`, if given, must match). */
  parentId: z.uuid().nullable().optional(),
  title: titleSchema,
  description: descriptionSchema.optional(),
  /** Omitted or null: no date. */
  dates: taskDatesInputSchema.nullable().optional(),
  /** Defaults to the top of the 清单 (new tasks appear first), or after the last sibling for a 子任务. */
  sortOrder: sortKeySchema.optional(),
  priority: prioritySchema.optional(),
  tagIds: tagIdsSchema.optional(),
  /** 重复规则; needs `dates`. */
  repeat: repeatRuleSchema.nullable().optional(),
  /** 提醒; need `dates` and must fit them (timed: `before`, 全天: `day`). */
  reminders: remindersSchema.optional(),
  reminderChannelIds: reminderChannelIdsSchema.optional(),
});
export type CreateTaskRequest = z.input<typeof createTaskRequestSchema>;

export const updateTaskRequestSchema = z
  .object({
    title: titleSchema,
    description: descriptionSchema,
    /**
     * `open`, `completed` or `abandoned` (放弃). Completing / abandoning also
     * completes / abandons every open 子任务 below; re-opening re-opens closed ancestors.
     */
    status: taskStatusSchema,
    /**
     * Move to another 清单 (with all 子任务); lands at the top unless
     * `sortOrder` is given. A 子任务 moved this way becomes a top-level task.
     */
    listId: z.uuid(),
    /** Re-parent (Tab / Shift+Tab); null makes it a top-level task. */
    parentId: z.uuid().nullable(),
    /**
     * Switch between 描述 and 检查清单: each non-empty 描述 line becomes a
     * 检查项, and back each 检查项 becomes one line (see task-tree.ts).
     */
    kind: taskKindSchema,
    sortOrder: sortKeySchema,
    /** Replace the dates; null clears them. */
    dates: taskDatesInputSchema.nullable(),
    priority: prioritySchema,
    /** Replaces the 任务's 标签. */
    tagIds: tagIdsSchema,
    /**
     * Replace the 重复规则; null stops repeating. Needs a date; clearing the
     * dates also clears the rule. Completing a 重复任务 generates its next instance.
     */
    repeat: repeatRuleSchema.nullable(),
    /**
     * Replace the 提醒. They must fit the (new) dates; changing the dates
     * between timed and 全天 drops the reminders that no longer fit, and
     * clearing the dates clears them.
     */
    reminders: remindersSchema,
    /** Replace the 通知渠道 of the reminders; null: the default channels. */
    reminderChannelIds: reminderChannelIdsSchema,
  })
  .partial()
  .strict();
export type UpdateTaskRequest = z.input<typeof updateTaskRequestSchema>;

/**
 * One 清单, one 标签 across 清单 (a parent 标签 includes its children's
 * tasks), one 智能清单 (see smart-lists.ts) or one 过滤器 (see filters.ts).
 */
export const tasksQuerySchema = z.union([
  z.object({ listId: z.uuid() }).strict(),
  z.object({ tagId: z.uuid() }).strict(),
  z.object({ smart: smartListIdSchema }).strict(),
  z.object({ filterId: z.uuid() }).strict(),
  /** 日历视图: open and completed tasks on any day `from`–`to` in the user's time zone (spec 用户故事 69). */
  calendarRangeSchema,
]);
export type TasksQuery = z.infer<typeof tasksQuerySchema>;

/** `GET /api/tasks?listId=`: open tasks in list order, then completed ones, newest completion first. */
export const tasksResponseSchema = z.object({ tasks: z.array(taskSchema) });
export type TasksResponse = z.infer<typeof tasksResponseSchema>;

/** 回收站 (spec 用户故事 29、30): deleted tasks stay restorable this many days, then their content is purged. */
export const TRASH_RETENTION_DAYS = 30;

/** A task in the 回收站: the task as it was, plus when it was deleted. */
export const trashedTaskSchema = taskSchema.extend({ deletedAt: z.iso.datetime() });
export type TrashedTask = z.infer<typeof trashedTaskSchema>;

/**
 * `GET /api/trash`: deleted tasks, most recently deleted first. Only the task
 * the user deleted is listed; its 子任务 went with it and come back with it.
 */
export const trashResponseSchema = z.object({ tasks: z.array(trashedTaskSchema) });
export type TrashResponse = z.infer<typeof trashResponseSchema>;
