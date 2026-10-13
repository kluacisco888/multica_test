import { and, eq, isNull, sql } from 'drizzle-orm';
import { compareSortKeys, INBOX_NAME, keyBetween, type Folder, type Task, type TaskList } from '@dida/shared';
import type { Executor } from './db/client.js';
import { folders, lists, tasks } from './db/schema/tasks.js';
import type { SyncWriter } from './sync/sync.js';

/*
 * Shared rules for 清单 / 文件夹 / 任务 routes: the 收件箱, default sort keys,
 * and the API representation of each row.
 */

export type ListRow = typeof lists.$inferSelect;
export type FolderRow = typeof folders.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;

/** Advisory-lock namespace for creating a user's 收件箱 (second key: hash of the user id). */
const INBOX_LOCK = 0x696e_6278; // "inbx"

function liveInboxWhere(userId: string) {
  return and(eq(lists.userId, userId), eq(lists.isInbox, true), isNull(lists.deletedAt));
}

/** The user's 收件箱, created on first use. Safe under concurrent first requests. */
export async function ensureInbox(db: Executor, sync: SyncWriter, userId: string): Promise<ListRow> {
  const [existing] = await db.select().from(lists).where(liveInboxWhere(userId));
  if (existing) return existing;
  return sync.transaction(userId, async (ops, tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${INBOX_LOCK}, hashtext(${userId}))`);
    const [raced] = await tx.select().from(lists).where(liveInboxWhere(userId));
    if (raced) return raced;
    return ops.insert(lists, { name: INBOX_NAME, isInbox: true, sortOrder: 'V', folderId: null, color: null, icon: null });
  });
}

function maxKey(keys: string[]): string | null {
  return keys.reduce<string | null>((max, k) => (max === null || compareSortKeys(k, max) > 0 ? k : max), null);
}

function minKey(keys: string[]): string | null {
  return keys.reduce<string | null>((min, k) => (min === null || compareSortKeys(k, min) < 0 ? k : min), null);
}

/** Sort keys of the top-level sidebar: 文件夹 plus 清单 outside folders (not the 收件箱). */
export async function topLevelKeys(db: Executor, userId: string): Promise<string[]> {
  const folderKeys = await db
    .select({ key: folders.sortOrder })
    .from(folders)
    .where(and(eq(folders.userId, userId), isNull(folders.deletedAt)));
  const listKeys = await db
    .select({ key: lists.sortOrder })
    .from(lists)
    .where(and(eq(lists.userId, userId), isNull(lists.deletedAt), isNull(lists.folderId), eq(lists.isInbox, false)));
  return [...folderKeys, ...listKeys].map((r) => r.key);
}

/** Key at the end of a sidebar level: the top level (`folderId` null) or inside a 文件夹. */
export async function endOfSidebarLevel(db: Executor, userId: string, folderId: string | null): Promise<string> {
  if (folderId === null) return keyBetween(maxKey(await topLevelKeys(db, userId)), null);
  const rows = await db
    .select({ key: lists.sortOrder })
    .from(lists)
    .where(and(eq(lists.userId, userId), eq(lists.folderId, folderId), isNull(lists.deletedAt)));
  return keyBetween(maxKey(rows.map((r) => r.key)), null);
}

/** Key above every task of a 清单 (new and moved tasks land on top). */
export async function topOfList(db: Executor, userId: string, listId: string): Promise<string> {
  const rows = await db
    .select({ key: tasks.sortOrder })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.listId, listId), isNull(tasks.deletedAt)));
  return keyBetween(null, minKey(rows.map((r) => r.key)));
}

const iso = (d: Date) => d.toISOString();

export function folderToApi(row: FolderRow): Folder {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sortOrder,
    collapsed: row.collapsed,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    revision: row.revision,
  };
}

export function listToApi(row: ListRow): TaskList {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    icon: row.icon,
    folderId: row.folderId,
    sortOrder: row.sortOrder,
    isInbox: row.isInbox,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    revision: row.revision,
  };
}

export function taskToApi(row: TaskRow): Task {
  return {
    id: row.id,
    listId: row.listId,
    title: row.title,
    description: row.description,
    status: row.status,
    completedAt: row.completedAt ? iso(row.completedAt) : null,
    sortOrder: row.sortOrder,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    revision: row.revision,
  };
}

/** List order: open tasks by sort key, then completed ones, most recently completed first. */
export function compareTasks(a: TaskRow, b: TaskRow): number {
  const doneA = a.status === 'completed';
  const doneB = b.status === 'completed';
  if (doneA !== doneB) return doneA ? 1 : -1;
  if (doneA) return (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0);
  return compareSortKeys(a.sortOrder, b.sortOrder) || compareSortKeys(a.id, b.id);
}
