import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { compareSortKeys, placeAt } from '@dida/shared';
import type { Executor } from './db/client.js';
import { tasks } from './db/schema/tasks.js';
import type { TaskRow } from './organize.js';
import type { SyncOps } from './sync/sync.js';

/*
 * Where tasks sit in their group (拖拽排序 and 置顶, spec 用户故事 32、33).
 *
 * Two key spaces: `sort_order` orders a task among its siblings (same 清单
 * and parent; pinned roots keep theirs), `pin_order` orders the user's pinned
 * tasks in 已置顶. A placement normally writes one key; when the keys around
 * the spot have grown too long (`placeAt`), every task of the group gets a
 * fresh key in the same order — each rewrite goes through the sync layer and
 * gets a revision like any other change.
 */

export type OrderField = 'sortOrder' | 'pinOrder';

const keyOf = (row: TaskRow, field: OrderField) => (field === 'sortOrder' ? row.sortOrder : (row.pinOrder ?? ''));

/** `rows` ordered by `field` (ties by id, like every task list). */
export function inKeyOrder(rows: readonly TaskRow[], field: OrderField): TaskRow[] {
  return [...rows].sort((a, b) => compareSortKeys(keyOf(a, field), keyOf(b, field)) || compareSortKeys(a.id, b.id));
}

/**
 * A key for a task going to `index` of `group` (in key order, without the
 * task itself). Rebalancing re-keys the other tasks of `group` right here;
 * the caller writes the returned key to the placed task. Returns the
 * re-keyed rows too, so a response can include them.
 */
export async function placeTask(
  ops: SyncOps,
  group: readonly TaskRow[],
  index: number,
  field: OrderField,
): Promise<{ key: string; rekeyed: TaskRow[] }> {
  const plan = placeAt(
    group.map((r) => keyOf(r, field)),
    index,
  );
  if ('key' in plan) return { key: plan.key, rekeyed: [] };
  const rekeyed: TaskRow[] = [];
  for (const [i, row] of group.entries()) {
    const key = plan.rebalance[i < index ? i : i + 1] as string;
    const updated = await ops.update(tasks, row.id, { [field]: key });
    if (updated) rekeyed.push(updated);
  }
  return { key: plan.rebalance[index] as string, rekeyed };
}

/** Live top-level tasks of a 清单 (the group new and moved-in tasks join). */
export async function topLevelOfList(db: Executor, userId: string, listId: string): Promise<TaskRow[]> {
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.listId, listId), isNull(tasks.parentId), isNull(tasks.deletedAt)));
  return inKeyOrder(rows, 'sortOrder');
}

/** The user's live pinned tasks, in 已置顶 order. */
export async function pinnedTasks(db: Executor, userId: string): Promise<TaskRow[]> {
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.userId, userId), isNotNull(tasks.pinOrder), isNull(tasks.deletedAt)));
  return inKeyOrder(rows, 'pinOrder');
}

/** Key at the top of a 清单 (new and moved-in tasks land first); `excludeId` is the task being placed. */
export async function topOfList(ops: SyncOps, db: Executor, userId: string, listId: string, excludeId?: string): Promise<string> {
  const group = (await topLevelOfList(db, userId, listId)).filter((r) => r.id !== excludeId);
  return (await placeTask(ops, group, 0, 'sortOrder')).key;
}

/** Key after the last live child of `parentId` (from `rows`, the 清单's tasks). */
export async function endOfChildren(ops: SyncOps, rows: readonly TaskRow[], parentId: string, excludeId?: string): Promise<string> {
  const group = inKeyOrder(
    rows.filter((r) => r.parentId === parentId && r.id !== excludeId),
    'sortOrder',
  );
  return (await placeTask(ops, group, group.length, 'sortOrder')).key;
}

/** Key at the top of 已置顶 (a newly pinned task comes first, like the reference). */
export async function topOfPinned(ops: SyncOps, db: Executor, userId: string, excludeId?: string): Promise<string> {
  const group = (await pinnedTasks(db, userId)).filter((r) => r.id !== excludeId);
  return (await placeTask(ops, group, 0, 'pinOrder')).key;
}
