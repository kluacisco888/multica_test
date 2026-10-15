import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, ne, or } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { TRASH_RETENTION_DAYS, type TrashedTask } from '@dida/shared';
import type { AttachmentStore } from './attachments/store.js';
import type { Clock } from './clock.js';
import type { Db, Executor, Tx } from './db/client.js';
import { attachments, comments } from './db/schema/attachments.js';
import { checklistItems, kanbanColumns, lists, tasks } from './db/schema/tasks.js';
import { ensureInbox, taskToApi, type TaskRow } from './organize.js';
import { readSettings } from './settings.js';
import { rememberOverdue } from './statistics.js';
import { topOfList } from './task-order.js';
import type { SyncOps, SyncWriter } from './sync/sync.js';
import { descendantsOf, exceedsDepth, liveTasksOfList, lockTaskTrees } from './task-tree.js';

/*
 * 回收站 (spec 用户故事 29、30; ADR-0004). Deleting a 任务 tombstones it, its
 * live 子任务 and their 检查项 in one batch marked with `trash_root_id` = the
 * deleted task. 还原 revives the batch; 彻底删除 and the 30-day cleanup clear
 * the batch's content but keep the tombstones, so `/api/changes` still reports
 * the deletion. Every write goes through the sync layer and gets a revision.
 *
 * Purging also tombstones the batch's 附件 and 评论 and clears their file
 * names and text. The files on the data volume are deleted after the commit:
 * a 附件 row that is a tombstone while its file still exists is the "to be
 * deleted" mark, so a failed delete is retried by the next cleanup run
 * (`sweepFiles`) and never rolls the purge back.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Move `root` and its live 子任务 (found in `listRows`) into the 回收站. */
export async function moveToTrash(ops: SyncOps, tx: Tx, userId: string, root: TaskRow, listRows: readonly TaskRow[]): Promise<void> {
  const batch = [root, ...descendantsOf(listRows, root.id)];
  const ids = batch.map((r) => r.id);
  const items = await tx
    .select({ id: checklistItems.id })
    .from(checklistItems)
    .where(and(eq(checklistItems.userId, userId), inArray(checklistItems.taskId, ids), isNull(checklistItems.deletedAt)));
  for (const item of items) await ops.softDelete(checklistItems, item.id, { trashRootId: root.id });
  for (const row of batch) await ops.softDelete(tasks, row.id, { trashRootId: root.id });
}

/** Tasks the user deleted that are still restorable (the batch roots). */
function trashRoots(userId: string) {
  return and(
    eq(tasks.userId, userId),
    isNotNull(tasks.deletedAt),
    isNull(tasks.purgedAt),
    eq(tasks.trashRootId, tasks.id),
  );
}

async function findRoot(db: Executor, userId: string, id: string): Promise<TaskRow | null> {
  if (!UUID.test(id)) return null;
  const [row] = await db.select().from(tasks).where(and(trashRoots(userId), eq(tasks.id, id)));
  return row ?? null;
}

async function batchOf(db: Executor, userId: string, rootId: string): Promise<TaskRow[]> {
  return db
    .select()
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.trashRootId, rootId), isNotNull(tasks.deletedAt), isNull(tasks.purgedAt)));
}

/**
 * Tombstone the 附件 and 评论 of `taskIds` (purged tasks) and clear their
 * content; ones already cleared are skipped. Returns how many rows changed.
 */
async function clearExtras(ops: SyncOps, tx: Tx, userId: string, taskIds: readonly string[]): Promise<number> {
  if (taskIds.length === 0) return 0;
  let changed = 0;
  const attachmentRows = await tx
    .select({ id: attachments.id, deletedAt: attachments.deletedAt })
    .from(attachments)
    .where(
      and(
        eq(attachments.userId, userId),
        inArray(attachments.taskId, [...taskIds]),
        or(isNull(attachments.deletedAt), ne(attachments.fileName, '')),
      ),
    );
  for (const row of attachmentRows) {
    if (row.deletedAt) await ops.updateTombstone(attachments, row.id, { fileName: '' });
    else await ops.softDelete(attachments, row.id, { fileName: '' });
    changed += 1;
  }
  const commentRows = await tx
    .select({ id: comments.id, deletedAt: comments.deletedAt })
    .from(comments)
    .where(
      and(
        eq(comments.userId, userId),
        inArray(comments.taskId, [...taskIds]),
        or(isNull(comments.deletedAt), ne(comments.content, '')),
      ),
    );
  for (const row of commentRows) {
    if (row.deletedAt) await ops.updateTombstone(comments, row.id, { content: '', editedAt: null });
    else await ops.softDelete(comments, row.id, { content: '', editedAt: null });
    changed += 1;
  }
  return changed;
}

/** Clear the content of one batch; its tombstones stay. */
async function purgeBatch(ops: SyncOps, tx: Tx, userId: string, rootId: string, now: Date): Promise<void> {
  const batch = await batchOf(tx, userId, rootId);
  const ids = batch.map((r) => r.id);
  if (ids.length === 0) return;
  // Every 检查项 of these tasks: the batch's own and ones deleted one by one earlier.
  const items = await tx
    .select({ id: checklistItems.id })
    .from(checklistItems)
    .where(and(eq(checklistItems.userId, userId), inArray(checklistItems.taskId, ids), isNotNull(checklistItems.deletedAt)));
  for (const item of items) await ops.updateTombstone(checklistItems, item.id, { title: '', completed: false, trashRootId: null });
  const { timeZone } = await readSettings(tx, userId);
  for (const row of batch) {
    await ops.updateTombstone(tasks, row.id, {
      // 成就分: clearing the dates must not take back the −2 of an overdue 任务.
      ...rememberOverdue(row, timeZone, now),
      title: '',
      description: '',
      kind: 'text',
      priority: 'none',
      tagIds: [],
      allDay: null,
      startDate: null,
      dueDate: null,
      startAt: null,
      dueAt: null,
      timeZone: null,
      trashRootId: null,
      purgedAt: now,
    });
  }
  await clearExtras(ops, tx, userId, ids);
}

export interface TrashService {
  /** The 回收站 of a user, most recently deleted first. */
  list(userId: string): Promise<TrashedTask[]>;
  /** 还原; null when `id` is not in the user's 回收站. */
  restore(userId: string, id: string): Promise<TaskRow | null>;
  /** 彻底删除 one task (with its 子任务); false when it is not in the user's 回收站. */
  purge(userId: string, id: string): Promise<boolean>;
  /** 清空回收站. */
  empty(userId: string): Promise<void>;
  /** Background cleanup: purge everything deleted at least 30 days ago (by the injected clock). Returns how many deleted tasks were purged. */
  purgeExpired(): Promise<number>;
  /**
   * Clear 附件 and 评论 that earlier purges (before EURO-32) left on purged
   * tasks, then delete leftover files. Idempotent; run at startup. Returns
   * how many 附件 / 评论 rows it cleared.
   */
  cleanUpPurged(): Promise<number>;
}

export interface TrashServiceDeps {
  db: Db;
  sync: SyncWriter;
  clock: Clock;
  files: AttachmentStore;
  log: FastifyBaseLogger;
}

export function createTrashService({ db, sync, clock, files, log }: TrashServiceDeps): TrashService {
  /**
   * Delete the files of tombstoned 附件 (all users, or only `userId`'s). Runs
   * after the purge committed; a failure is logged and left for the next run.
   */
  async function sweepFiles(userId?: string): Promise<void> {
    try {
      const stored = await files.list(userId);
      const CHUNK = 500;
      for (let i = 0; i < stored.length; i += CHUNK) {
        const chunk = stored.slice(i, i + CHUNK);
        const onDisk = new Set(chunk.map((f) => `${f.userId}/${f.id}`));
        const dead = await db
          .select({ id: attachments.id, userId: attachments.userId })
          .from(attachments)
          .where(and(inArray(attachments.id, chunk.map((f) => f.id)), isNotNull(attachments.deletedAt)));
        for (const row of dead) {
          // Only the owner's directory: a file name is the id, the row says whose it is.
          if (!onDisk.has(`${row.userId.toLowerCase()}/${row.id.toLowerCase()}`)) continue;
          await files.remove(row.userId, row.id).catch((err: unknown) => {
            log.error({ err, attachmentId: row.id }, '回收站: deleting an attachment file failed; retried by the next cleanup');
          });
        }
      }
    } catch (err) {
      log.error({ err }, '回收站: scanning attachment files failed; retried by the next cleanup');
    }
  }

  return {
    async list(userId) {
      const rows = await db
        .select()
        .from(tasks)
        .where(trashRoots(userId))
        .orderBy(desc(tasks.deletedAt), asc(tasks.id));
      return rows.map((row) => ({ ...taskToApi(row), deletedAt: (row.deletedAt as Date).toISOString() }));
    },

    async restore(userId, id) {
      if (!(await findRoot(db, userId, id))) return null;
      // Outside the transaction below: creating the 收件箱 runs its own.
      const inbox = await ensureInbox(db, sync, userId);
      return sync.transaction(userId, async (ops, tx) => {
        await lockTaskTrees(tx, userId);
        const root = await findRoot(tx, userId, id);
        if (!root) return null;
        const batch = await batchOf(tx, userId, root.id);

        // Back into its 清单, or the 收件箱 when that 清单 was deleted.
        const [list] = await tx
          .select({ id: lists.id })
          .from(lists)
          .where(and(eq(lists.id, root.listId), eq(lists.userId, userId), isNull(lists.deletedAt)));
        const listId = list?.id ?? inbox.id;
        const listRows = await liveTasksOfList(tx, userId, listId);

        // Under its parent when that is still there (and the depth limit allows), else top level.
        const parent = root.parentId ? listRows.find((r) => r.id === root.parentId) : undefined;
        const keepParent = parent !== undefined && !exceedsDepth(listRows, parent.id, batch, root.id);
        const moved = listId !== root.listId || (root.parentId !== null && !keepParent);

        // Its 看板分栏 may be gone (deleting a 分栏 sends its tasks here): then 未分组.
        const [column] = root.columnId
          ? await tx
              .select({ id: kanbanColumns.id })
              .from(kanbanColumns)
              .where(
                and(
                  eq(kanbanColumns.id, root.columnId),
                  eq(kanbanColumns.userId, userId),
                  eq(kanbanColumns.listId, listId),
                  isNull(kanbanColumns.deletedAt),
                ),
              )
          : [];

        const restored = await ops.restore(tasks, root.id, {
          trashRootId: null,
          listId,
          columnId: column?.id ?? null,
          parentId: keepParent ? root.parentId : null,
          ...(moved ? { sortOrder: await topOfList(ops, tx, userId, listId) } : {}),
        });
        for (const row of batch) {
          if (row.id !== root.id) await ops.restore(tasks, row.id, { trashRootId: null, listId });
        }
        const items = await tx
          .select({ id: checklistItems.id })
          .from(checklistItems)
          .where(and(eq(checklistItems.userId, userId), eq(checklistItems.trashRootId, root.id), isNotNull(checklistItems.deletedAt)));
        for (const item of items) await ops.restore(checklistItems, item.id, { trashRootId: null });
        return restored;
      });
    },

    async purge(userId, id) {
      if (!(await findRoot(db, userId, id))) return false;
      const purged = await sync.transaction(userId, async (ops, tx) => {
        // Same lock as 还原, so a concurrent restore and purge of one task cannot interleave.
        await lockTaskTrees(tx, userId);
        if (!(await findRoot(tx, userId, id))) return false;
        await purgeBatch(ops, tx, userId, id, clock.now());
        return true;
      });
      if (purged) await sweepFiles(userId);
      return purged;
    },

    async empty(userId) {
      await sync.transaction(userId, async (ops, tx) => {
        await lockTaskTrees(tx, userId);
        const roots = await tx.select({ id: tasks.id }).from(tasks).where(trashRoots(userId));
        const now = clock.now();
        for (const root of roots) await purgeBatch(ops, tx, userId, root.id, now);
      });
      await sweepFiles(userId);
    },

    async purgeExpired() {
      const cutoff = new Date(clock.now().getTime() - TRASH_RETENTION_DAYS * DAY_MS);
      const expired = await db
        .select({ id: tasks.id, userId: tasks.userId })
        .from(tasks)
        .where(and(isNotNull(tasks.deletedAt), isNull(tasks.purgedAt), eq(tasks.trashRootId, tasks.id), lte(tasks.deletedAt, cutoff)));
      const byUser = new Map<string, string[]>();
      for (const r of expired) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r.id]);
      let purged = 0;
      for (const [userId, rootIds] of byUser) {
        purged += await sync.transaction(userId, async (ops, tx) => {
          await lockTaskTrees(tx, userId);
          let n = 0;
          const now = clock.now();
          for (const rootId of rootIds) {
            // Skip a task restored or purged since the scan above.
            const [still] = await tx
              .select({ id: tasks.id })
              .from(tasks)
              .where(and(trashRoots(userId), eq(tasks.id, rootId), lte(tasks.deletedAt, cutoff)));
            if (!still) continue;
            await purgeBatch(ops, tx, userId, rootId, now);
            n += 1;
          }
          return n;
        });
      }
      // Also retries files earlier runs failed to delete.
      await sweepFiles();
      return purged;
    },

    async cleanUpPurged() {
      const purgedTasks = db.select({ id: tasks.id }).from(tasks).where(isNotNull(tasks.purgedAt));
      const leftovers = [
        ...(await db
          .selectDistinct({ userId: attachments.userId, taskId: attachments.taskId })
          .from(attachments)
          .where(and(inArray(attachments.taskId, purgedTasks), or(isNull(attachments.deletedAt), ne(attachments.fileName, ''))))),
        ...(await db
          .selectDistinct({ userId: comments.userId, taskId: comments.taskId })
          .from(comments)
          .where(and(inArray(comments.taskId, purgedTasks), or(isNull(comments.deletedAt), ne(comments.content, ''))))),
      ];
      const byUser = new Map<string, Set<string>>();
      for (const r of leftovers) byUser.set(r.userId, (byUser.get(r.userId) ?? new Set()).add(r.taskId));
      let cleared = 0;
      for (const [userId, taskIds] of byUser) {
        cleared += await sync.transaction(userId, async (ops, tx) => {
          // Only tasks of this user that are purged (a purge is final, so this stays true).
          const own = await tx
            .select({ id: tasks.id })
            .from(tasks)
            .where(and(eq(tasks.userId, userId), inArray(tasks.id, [...taskIds]), isNotNull(tasks.purgedAt)));
          return clearExtras(
            ops,
            tx,
            userId,
            own.map((r) => r.id),
          );
        });
      }
      await sweepFiles();
      return cleared;
    },
  };
}
