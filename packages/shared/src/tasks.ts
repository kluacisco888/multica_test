import { z } from 'zod';
import { sortKeySchema } from './lists.js';
import { taskDatesInputSchema, taskDatesSchema } from './task-dates.js';

/*
 * 任务 basics (spec 用户故事 20、21、27、31、40), dates (23–26, see
 * `task-dates.ts`) and 子任务 and 检查清单 mode (用户故事 35–37). Priority and
 * tags come with later tasks. `abandoned` (放弃) is reserved in the status
 * enum; this version only moves between `open` and `completed`.
 *
 * 子任务 rules (see task-tree.ts): a 子任务 lives in its parent's 清单, trees
 * are at most 5 levels deep counting the root as level 1, completing a task
 * completes its whole subtree, re-opening a 子任务 re-opens its completed
 * ancestors.
 */

export const TASK_TITLE_MAX_LENGTH = 512;
export const TASK_DESCRIPTION_MAX_LENGTH = 100_000;

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
  })
  .partial()
  .strict();
export type UpdateTaskRequest = z.input<typeof updateTaskRequestSchema>;

export const tasksQuerySchema = z.object({ listId: z.uuid() });

/** `GET /api/tasks?listId=`: open tasks in list order, then completed ones, newest completion first. */
export const tasksResponseSchema = z.object({ tasks: z.array(taskSchema) });
export type TasksResponse = z.infer<typeof tasksResponseSchema>;
