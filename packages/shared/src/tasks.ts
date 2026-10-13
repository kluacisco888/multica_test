import { z } from 'zod';
import { sortKeySchema } from './lists.js';
import { taskDatesInputSchema, taskDatesSchema } from './task-dates.js';

/*
 * 任务 basics (spec 用户故事 20、21、27、31、40) and dates (23–26, see
 * `task-dates.ts`). Priority, tags and subtasks come with later tasks. `abandoned` (放弃) is reserved in the status
 * enum; this version only moves between `open` and `completed`.
 */

export const TASK_TITLE_MAX_LENGTH = 512;
export const TASK_DESCRIPTION_MAX_LENGTH = 100_000;

export const taskStatusSchema = z.enum(['open', 'completed', 'abandoned']);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskSchema = z.object({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  revision: z.number().int().nonnegative(),
  listId: z.uuid(),
  title: z.string(),
  /** Markdown source. */
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
  title: titleSchema,
  description: descriptionSchema.optional(),
  /** Omitted or null: no date. */
  dates: taskDatesInputSchema.nullable().optional(),
  /** Defaults to the top of the 清单 (new tasks appear first). */
  sortOrder: sortKeySchema.optional(),
});
export type CreateTaskRequest = z.input<typeof createTaskRequestSchema>;

export const updateTaskRequestSchema = z
  .object({
    title: titleSchema,
    description: descriptionSchema,
    /** `open` ⇄ `completed`. */
    status: z.enum(['open', 'completed']),
    /** Move to another 清单; lands at the top unless `sortOrder` is given. */
    listId: z.uuid(),
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
