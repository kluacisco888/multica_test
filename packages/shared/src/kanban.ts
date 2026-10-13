import { z } from 'zod';
import { entityNameSchema, sortKeySchema } from './lists.js';
import { compareSortKeys, keyBetween } from './sort-key.js';
import { arrangeTasks, type ArrangeContext, type TaskSection, type ViewOptions } from './task-view.js';
import { PRIORITIES, PRIORITY_LABELS, type Task } from './tasks.js';

/*
 * 看板视图 (spec 用户故事 66、67).
 *
 * A 清单 shown as a board has 看板分栏 the user adds, renames, reorders and
 * deletes; each 任务 remembers its 分栏 (`task.columnId`). Tasks without a live
 * 分栏 of their 清单 sit in the built-in 未分组 column (the reference's
 * `kanban_to_do_column`), which is shown while it holds tasks or the 清单 has
 * no 分栏 yet. Only top-level tasks are cards; 子任务 go with their parent.
 *
 * Deleting a 分栏 (reference dialog 删除分组): either its tasks go into the
 * 回收站 with it (the default choice), or they move to another 分栏 / 未分组.
 *
 * 智能清单 and 过滤器 boards are laid out automatically: one column per date
 * group or per 优先级, nothing to add or delete by hand.
 */

export const UNGROUPED_COLUMN_TITLE = '未分组';
export const NEW_COLUMN_NAME = '新分组';
/** Reference: `column_limit_warn`. */
export const MAX_KANBAN_COLUMNS = 100;

export const kanbanColumnSchema = z.object({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  revision: z.number().int().nonnegative(),
  listId: z.uuid(),
  name: z.string(),
  /** Fractional key among the 分栏 of the 清单 (left to right). */
  sortOrder: z.string(),
});
export type KanbanColumn = z.infer<typeof kanbanColumnSchema>;

/** `GET /api/kanban-columns?listId=`: the 清单's 分栏, left to right. */
export const kanbanColumnsQuerySchema = z.object({ listId: z.uuid() }).strict();
export const kanbanColumnsResponseSchema = z.object({ columns: z.array(kanbanColumnSchema) });
export type KanbanColumnsResponse = z.infer<typeof kanbanColumnsResponseSchema>;

export const createKanbanColumnRequestSchema = z.object({
  id: z.uuid().optional(),
  listId: z.uuid(),
  name: entityNameSchema,
  /** Defaults to the right end. */
  sortOrder: sortKeySchema.optional(),
});
export type CreateKanbanColumnRequest = z.input<typeof createKanbanColumnRequestSchema>;

export const updateKanbanColumnRequestSchema = z.object({ name: entityNameSchema, sortOrder: sortKeySchema }).partial().strict();
export type UpdateKanbanColumnRequest = z.input<typeof updateKanbanColumnRequestSchema>;

/**
 * `DELETE /api/kanban-columns/:id?tasks=delete|move&moveTo=<分栏 id>`.
 * `delete` (default): the 分栏's tasks go into the 回收站. `move`: they go to
 * `moveTo`, another 分栏 of the same 清单, or to 未分组 when it is omitted.
 */
export const deleteKanbanColumnQuerySchema = z
  .object({ tasks: z.enum(['delete', 'move']).default('delete'), moveTo: z.uuid().optional() })
  .strict()
  .refine((q) => q.tasks === 'move' || q.moveTo === undefined, { message: '只有移动任务时才能指定目标分组', path: ['moveTo'] });
export type DeleteKanbanColumnQuery = z.input<typeof deleteKanbanColumnQuerySchema>;

export const compareColumns = (a: { sortOrder: string; id: string }, b: { sortOrder: string; id: string }) =>
  compareSortKeys(a.sortOrder, b.sortOrder) || compareSortKeys(a.id, b.id);

/** One column on screen. */
export interface BoardColumn {
  /** Stable key: `column:<id>`, `ungrouped`, or the section key of an automatic board. */
  key: string;
  /** The 看板分栏 behind it; null for 未分组 and automatic columns. */
  column: KanbanColumn | null;
  title: string;
  /** Number of open cards (the reference counts those in the heading). */
  count: number;
  /** Cards, laid out by the view's 排序 / 分组; the 已完成 section last. */
  sections: TaskSection[];
}

export interface Board {
  /** `manual`: a 清单 with its own 分栏; `auto`: 智能清单 / 过滤器. */
  kind: 'manual' | 'auto';
  columns: BoardColumn[];
}

const openCount = (sections: TaskSection[]) => sections.reduce((n, s) => n + (s.completed ? 0 : s.tasks.length), 0);

/** Top-level cards: tasks whose parent is not on screen. */
function roots(tasks: readonly Task[]): Task[] {
  const ids = new Set(tasks.map((t) => t.id));
  return tasks.filter((t) => t.parentId === null || !ids.has(t.parentId));
}

/** A 清单 board: 未分组 (when needed) then the 分栏 left to right. */
export function arrangeListBoard(
  tasks: readonly Task[],
  columns: readonly KanbanColumn[],
  options: ViewOptions,
  ctx: ArrangeContext,
): Board {
  const ordered = [...columns].sort(compareColumns);
  const live = new Set(ordered.map((c) => c.id));
  const byColumn = new Map<string | null, Task[]>();
  for (const task of roots(tasks)) {
    const key = task.columnId !== null && live.has(task.columnId) ? task.columnId : null;
    byColumn.set(key, [...(byColumn.get(key) ?? []), task]);
  }
  const layout = { sortBy: options.sortBy, groupBy: options.groupBy };
  const out: BoardColumn[] = [];
  const ungrouped = byColumn.get(null) ?? [];
  if (ungrouped.length > 0 || ordered.length === 0) {
    const sections = arrangeTasks(ungrouped, layout, ctx);
    out.push({ key: 'ungrouped', column: null, title: UNGROUPED_COLUMN_TITLE, count: openCount(sections), sections });
  }
  for (const column of ordered) {
    const sections = arrangeTasks(byColumn.get(column.id) ?? [], layout, ctx);
    out.push({ key: `column:${column.id}`, column, title: column.name, count: openCount(sections), sections });
  }
  return { kind: 'manual', columns: out };
}

/**
 * A 智能清单 / 过滤器 board: one column per 优先级 (all four, always) when the
 * view groups by 优先级, otherwise one per date group (已过期, each day, 更远,
 * 无日期) that has tasks; the 已完成 tasks form the last column.
 */
export function arrangeAutoBoard(tasks: readonly Task[], options: ViewOptions, ctx: ArrangeContext): Board {
  const groupBy = options.groupBy === 'priority' ? 'priority' : 'date';
  const sections = arrangeTasks(tasks, { sortBy: options.sortBy, groupBy }, ctx);
  const asColumn = (section: TaskSection): BoardColumn => ({
    key: section.key,
    column: null,
    title: section.title,
    count: section.tasks.length,
    sections: [{ ...section, title: '' }],
  });
  if (groupBy === 'priority' && !ctx.completedView) {
    const columns = PRIORITIES.map((priority) => {
      const key = `priority:${priority}`;
      return asColumn(sections.find((s) => s.key === key) ?? { key, title: PRIORITY_LABELS[priority], tasks: [] });
    });
    const done = sections.find((s) => s.completed);
    return { kind: 'auto', columns: done ? [...columns, asColumn(done)] : columns };
  }
  return { kind: 'auto', columns: sections.map(asColumn) };
}

/**
 * Sort key for a card dropped into a column, in front of `beforeId` (null: at
 * the end). `cards` are the column's open cards in their custom order; the
 * dragged card itself may be among them. Null when the card already sits there.
 */
export function sortKeyForDrop(
  cards: readonly { id: string; sortOrder: string }[],
  draggedId: string,
  beforeId: string | null,
): string | null {
  const ordered = [...cards].sort((a, b) => compareSortKeys(a.sortOrder, b.sortOrder) || compareSortKeys(a.id, b.id));
  const current = ordered.findIndex((c) => c.id === draggedId);
  if (current !== -1 && (ordered[current + 1]?.id ?? null) === beforeId) return null;
  const others = ordered.filter((c) => c.id !== draggedId);
  const index = beforeId === null ? others.length : others.findIndex((c) => c.id === beforeId);
  const at = index === -1 ? others.length : index;
  const before = others[at - 1]?.sortOrder ?? null;
  const after = others[at]?.sortOrder ?? null;
  // Equal neighbours (e.g. a 重复任务 instance took its predecessor's key) leave no room between them.
  if (before !== null && after !== null && compareSortKeys(before, after) >= 0) return keyBetween(before, null);
  return keyBetween(before, after);
}
