import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  compareColumns,
  createKanbanColumnRequestSchema,
  deleteKanbanColumnQuerySchema,
  kanbanColumnsQuerySchema,
  keyBetween,
  MAX_KANBAN_COLUMNS,
  updateKanbanColumnRequestSchema,
  type KanbanColumnsResponse,
} from '@dida/shared';
import { sessionUser } from '../auth.js';
import type { Executor, Tx } from '../db/client.js';
import { kanbanColumns, lists, tasks } from '../db/schema/tasks.js';
import { sendValidationError } from '../http-errors.js';
import { kanbanColumnToApi, type KanbanColumnRow } from '../organize.js';
import { findOwned, type SyncOps } from '../sync/sync.js';
import { liveTasksOfList, lockTaskTrees } from '../task-tree.js';
import { moveToTrash } from '../trash.js';
import { columnLimit, columnNameTaken, invalidColumn, invalidList, notFound, Rejection, respond } from './respond.js';

type Params = { Params: { id: string } };

/** Advisory-lock namespace for a user's 看板分栏 (second key: hash of the user id): serializes the name check. */
const COLUMN_LOCK = 0x6b61_6e62; // "kanb"

/** Live 看板分栏 of a 清单, left to right. */
export async function liveColumnsOfList(db: Executor, userId: string, listId: string): Promise<KanbanColumnRow[]> {
  const rows = await db
    .select()
    .from(kanbanColumns)
    .where(and(eq(kanbanColumns.userId, userId), eq(kanbanColumns.listId, listId), isNull(kanbanColumns.deletedAt)));
  return rows.sort(compareColumns);
}

/** Throws a 400 rejection unless `columnId` is a live 分栏 of the user in `listId`. */
export async function checkColumn(db: Executor, userId: string, listId: string, columnId: string | null | undefined): Promise<void> {
  if (columnId === null || columnId === undefined) return;
  const column = await findOwned(db, kanbanColumns, userId, columnId);
  if (!column || column.listId !== listId) throw new Rejection(invalidColumn);
}

/** Tombstone every 分栏 of a deleted 清单. */
export async function deleteColumnsOfList(ops: SyncOps, tx: Tx, userId: string, listId: string): Promise<void> {
  for (const column of await liveColumnsOfList(tx, userId, listId)) await ops.softDelete(kanbanColumns, column.id);
}

async function lockColumns(tx: Tx, userId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${COLUMN_LOCK}, hashtext(${userId}))`);
}

/** Reference: 分组名称已存在 — names are unique within a 清单 (case as typed). */
function checkName(columns: readonly KanbanColumnRow[], name: string, self: string | null): void {
  if (columns.some((c) => c.id !== self && c.name === name)) throw new Rejection(columnNameTaken);
}

/** 看板分栏 (spec 用户故事 66): list, add, rename / reorder, delete. Tasks pick theirs with `columnId`. */
export function kanbanRoutes(app: FastifyInstance) {
  app.get('/api/kanban-columns', async (request, reply) => {
    const query = kanbanColumnsQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);
    const userId = sessionUser(request).id;
    const list = await findOwned(app.db, lists, userId, query.data.listId);
    if (!list) return notFound(reply);
    const response: KanbanColumnsResponse = { columns: (await liveColumnsOfList(app.db, userId, list.id)).map(kanbanColumnToApi) };
    return response;
  });

  app.post('/api/kanban-columns', async (request, reply) => {
    const body = createKanbanColumnRequestSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    const userId = sessionUser(request).id;
    const { id, listId, name, sortOrder } = body.data;
    return respond(
      reply,
      () =>
        app.sync.transaction(userId, async (ops, tx) => {
          await lockColumns(tx, userId);
          if (!(await findOwned(tx, lists, userId, listId))) throw new Rejection(invalidList);
          const columns = await liveColumnsOfList(tx, userId, listId);
          if (columns.length >= MAX_KANBAN_COLUMNS) throw new Rejection(columnLimit);
          checkName(columns, name, null);
          return ops.insert(kanbanColumns, {
            ...(id ? { id } : {}),
            listId,
            name,
            sortOrder: sortOrder ?? keyBetween(columns.at(-1)?.sortOrder ?? null, null),
          });
        }),
      (row) => reply.code(201).send(kanbanColumnToApi(row)),
    );
  });

  app.patch<Params>('/api/kanban-columns/:id', async (request, reply) => {
    const userId = sessionUser(request).id;
    if (!(await findOwned(app.db, kanbanColumns, userId, request.params.id))) return notFound(reply);
    const body = updateKanbanColumnRequestSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    return respond(
      reply,
      () =>
        app.sync.transaction(userId, async (ops, tx) => {
          await lockColumns(tx, userId);
          const column = await findOwned(tx, kanbanColumns, userId, request.params.id);
          if (!column) throw new Rejection(notFound);
          if (body.data.name !== undefined) checkName(await liveColumnsOfList(tx, userId, column.listId), body.data.name, column.id);
          const row = await ops.update(kanbanColumns, column.id, body.data);
          if (!row) throw new Rejection(notFound);
          return row;
        }),
      (row) => kanbanColumnToApi(row),
    );
  });

  /**
   * 删除分组 (reference dialog): `tasks=delete` (default) sends the 分栏's tasks
   * and their 子任务 to the 回收站; `tasks=move` moves them to `moveTo` or 未分组.
   */
  app.delete<Params>('/api/kanban-columns/:id', async (request, reply) => {
    const userId = sessionUser(request).id;
    if (!(await findOwned(app.db, kanbanColumns, userId, request.params.id))) return notFound(reply);
    const query = deleteKanbanColumnQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);
    const { tasks: mode, moveTo } = query.data;
    return respond(
      reply,
      () =>
        app.sync.transaction(userId, async (ops, tx) => {
          await lockTaskTrees(tx, userId);
          await lockColumns(tx, userId);
          const column = await findOwned(tx, kanbanColumns, userId, request.params.id);
          if (!column) throw new Rejection(notFound);
          if (moveTo === column.id) throw new Rejection(invalidColumn);
          await checkColumn(tx, userId, column.listId, moveTo);

          const listRows = await liveTasksOfList(tx, userId, column.listId);
          const inColumn = listRows.filter((t) => t.columnId === column.id);
          for (const task of inColumn) {
            if (mode === 'delete' && task.parentId === null) {
              // Re-check: an earlier root of this loop may have taken it along.
              if (await findOwned(tx, tasks, userId, task.id)) await moveToTrash(ops, tx, userId, task, listRows);
            } else {
              // Moved cards, and 子任务 that carried the 分栏 (it only counts for top-level tasks).
              const target = mode === 'move' ? (moveTo ?? null) : null;
              if (await findOwned(tx, tasks, userId, task.id)) await ops.update(tasks, task.id, { columnId: target });
            }
          }
          if (!(await ops.softDelete(kanbanColumns, column.id))) throw new Rejection(notFound);
          return { id: column.id };
        }),
      () => reply.code(204).send(),
    );
  });
}
