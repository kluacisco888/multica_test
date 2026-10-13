import { and, eq, isNull, sql } from 'drizzle-orm';
import { checklistToDescription, compareSortKeys, descriptionToChecklist, keyBetween, MAX_TASK_DEPTH, sortKeysBetween, subtreeHeight, taskDepth } from '@dida/shared';
import type { Executor, Tx } from './db/client.js';
import { checklistItems, tasks } from './db/schema/tasks.js';
import type { TaskRow } from './organize.js';
import type { SyncOps } from './sync/sync.js';

/*
 * 子任务 trees and 检查清单 mode on the server side. Rules live in
 * `@dida/shared` (task-tree.ts); this module loads rows and applies cascades
 * through the sync layer so every touched row gets a revision (ADR-0004).
 *
 * A whole tree always lives in one 清单, so loading a 清单's tasks is enough
 * to answer depth / descendant questions.
 */

/** Advisory-lock namespace for re-shaping a user's task trees (second key: hash of the user id). */
const TREE_LOCK = 0x7472_6565; // "tree"

/** Serialize tree changes of one user, so two concurrent moves cannot build a cycle or pass the depth limit. */
export async function lockTaskTrees(tx: Tx, userId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${TREE_LOCK}, hashtext(${userId}))`);
}

export async function liveTasksOfList(db: Executor, userId: string, listId: string): Promise<TaskRow[]> {
  return db
    .select()
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.listId, listId), isNull(tasks.deletedAt)));
}

/** Every task below `id` (not including it), parents before children. */
export function descendantsOf(rows: readonly TaskRow[], id: string): TaskRow[] {
  const out: TaskRow[] = [];
  const seen = new Set([id]);
  let frontier = [id];
  while (frontier.length > 0) {
    const next = rows.filter((r) => r.parentId !== null && frontier.includes(r.parentId) && !seen.has(r.id));
    for (const r of next) seen.add(r.id);
    out.push(...next);
    frontier = next.map((r) => r.id);
  }
  return out;
}

/** Ancestors of `id`, nearest first. */
export function ancestorsOf(rows: readonly TaskRow[], id: string): TaskRow[] {
  const index = new Map(rows.map((r) => [r.id, r]));
  const out: TaskRow[] = [];
  const seen = new Set([id]);
  let current = index.get(id);
  while (current?.parentId && !seen.has(current.parentId)) {
    const parent = index.get(current.parentId);
    if (!parent) break;
    seen.add(parent.id);
    out.push(parent);
    current = parent;
  }
  return out;
}

const asTree = (rows: readonly TaskRow[]) => rows.map((r) => ({ id: r.id, parentId: r.parentId, sortOrder: r.sortOrder, status: r.status }));

/** Would putting the subtree of `taskId` (from `subtreeRows`) under `parentId` (from `parentRows`) pass the depth limit? */
export function exceedsDepth(parentRows: readonly TaskRow[], parentId: string, subtreeRows: readonly TaskRow[] | null, taskId: string | null): boolean {
  const height = taskId && subtreeRows ? subtreeHeight(asTree(subtreeRows), taskId) : 1;
  return taskDepth(asTree(parentRows), parentId) + height > MAX_TASK_DEPTH;
}

/** Key after the last current child of `parentId`. */
export function endOfChildren(rows: readonly TaskRow[], parentId: string, excludeId?: string): string {
  const keys = rows.filter((r) => r.parentId === parentId && r.id !== excludeId).map((r) => r.sortOrder);
  const last = keys.reduce<string | null>((max, k) => (max === null || compareSortKeys(k, max) > 0 ? k : max), null);
  return keyBetween(last, null);
}

/** Live 检查项 of a task, in sort-key order (code-unit order, not the database collation). */
export async function liveChecklistItems(db: Executor, userId: string, taskId: string) {
  const rows = await db
    .select()
    .from(checklistItems)
    .where(and(eq(checklistItems.userId, userId), eq(checklistItems.taskId, taskId), isNull(checklistItems.deletedAt)));
  return rows.sort((a, b) => compareSortKeys(a.sortOrder, b.sortOrder) || compareSortKeys(a.id, b.id));
}

/** 描述 → 检查清单: append one 检查项 per non-empty line of `description`. */
export async function checklistFromDescription(ops: SyncOps, tx: Tx, userId: string, taskId: string, description: string): Promise<void> {
  const parsed = descriptionToChecklist(description);
  if (parsed.length === 0) return;
  const existing = await liveChecklistItems(tx, userId, taskId);
  const keys = sortKeysBetween(existing.at(-1)?.sortOrder ?? null, null, parsed.length);
  for (const [i, item] of parsed.entries()) {
    await ops.insert(checklistItems, { taskId, title: item.title, completed: item.completed, sortOrder: keys[i] as string });
  }
}

/** 检查清单 → 描述: tombstone the 检查项 and return their text, one line each. */
export async function descriptionFromChecklist(ops: SyncOps, tx: Tx, userId: string, taskId: string): Promise<string> {
  const items = await liveChecklistItems(tx, userId, taskId);
  for (const item of items) await ops.softDelete(checklistItems, item.id);
  return checklistToDescription(items);
}
