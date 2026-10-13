import { z } from 'zod';
import { sortKeySchema } from './lists.js';
import { CHECKLIST_ITEM_TITLE_MAX_LENGTH } from './task-tree.js';

/*
 * 检查项 (spec 用户故事 37): the parts of a 任务 in 检查清单 mode. A 检查项 has
 * only a title and a checked state; it is not a 任务. Synced entity
 * (ADR-0004): UUID, revision, soft delete, served by `/api/changes` as
 * `checklistItem`.
 */

export const checklistItemSchema = z.object({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  revision: z.number().int().nonnegative(),
  taskId: z.uuid(),
  title: z.string(),
  completed: z.boolean(),
  sortOrder: z.string(),
});
export type ChecklistItem = z.infer<typeof checklistItemSchema>;

const itemTitleSchema = z
  .string()
  .trim()
  .min(1, '检查项不能为空')
  .max(CHECKLIST_ITEM_TITLE_MAX_LENGTH, `检查项最多 ${CHECKLIST_ITEM_TITLE_MAX_LENGTH} 个字符`);

export const createChecklistItemRequestSchema = z
  .object({
    id: z.uuid().optional(),
    title: itemTitleSchema,
    completed: z.boolean().optional(),
    /** Defaults to after the last 检查项. */
    sortOrder: sortKeySchema.optional(),
  })
  .strict();
export type CreateChecklistItemRequest = z.input<typeof createChecklistItemRequestSchema>;

export const updateChecklistItemRequestSchema = z
  .object({
    title: itemTitleSchema,
    completed: z.boolean(),
    sortOrder: sortKeySchema,
  })
  .partial()
  .strict();
export type UpdateChecklistItemRequest = z.input<typeof updateChecklistItemRequestSchema>;

/** `GET /api/tasks/:id/checklist-items`: live 检查项 in sort-key order. */
export const checklistItemsResponseSchema = z.object({ items: z.array(checklistItemSchema) });
export type ChecklistItemsResponse = z.infer<typeof checklistItemsResponseSchema>;
