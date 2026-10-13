import { z } from 'zod';
import { sortKeySchema } from './lists.js';
import { taskDatesInputSchema, taskDatesSchema } from './task-dates.js';

/*
 * 任务 basics (spec 用户故事 20、21、27、31、40), dates (23–26, see
 * `task-dates.ts`), 子任务 and 检查清单 mode (用户故事 35–37), 优先级 and 标签
 * (22、18). `abandoned` (放弃) is reserved in the status
 * enum; this version only moves between `open` and `completed`.
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
  sortOrder: z.string(),
  /** null: no date. */
  dates: taskDatesSchema.nullable(),
  priority: prioritySchema,
  /** 标签 ids, in the order they were added. */
  tagIds: z.array(z.uuid()),
});
export type Task = z.infer<typeof taskSchema>;

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
});
export type CreateTaskRequest = z.input<typeof createTaskRequestSchema>;

export const updateTaskRequestSchema = z
  .object({
    title: titleSchema,
    description: descriptionSchema,
    /** `open` ⇄ `completed`. Completing also completes every open 子任务 below. */
    status: z.enum(['open', 'completed']),
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
  })
  .partial()
  .strict();
export type UpdateTaskRequest = z.input<typeof updateTaskRequestSchema>;

/** Either one 清单, or one 标签 across 清单 (a parent 标签 includes its children's tasks). */
export const tasksQuerySchema = z.union([
  z.object({ listId: z.uuid() }).strict(),
  z.object({ tagId: z.uuid() }).strict(),
]);
export type TasksQuery = z.infer<typeof tasksQuerySchema>;

/** `GET /api/tasks?listId=`: open tasks in list order, then completed ones, newest completion first. */
export const tasksResponseSchema = z.object({ tasks: z.array(taskSchema) });
export type TasksResponse = z.infer<typeof tasksResponseSchema>;
