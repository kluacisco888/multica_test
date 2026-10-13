import { and, count, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  compareSortKeys,
  createFolderRequestSchema,
  createListRequestSchema,
  sortKeysBetween,
  updateFolderRequestSchema,
  updateListRequestSchema,
  type SidebarResponse,
} from '@dida/shared';
import { sessionUser } from '../auth.js';
import type { Executor } from '../db/client.js';
import { folders, lists, tasks } from '../db/schema/tasks.js';
import { sendValidationError } from '../http-errors.js';
import { endOfSidebarLevel, ensureInbox, folderToApi, listToApi, topLevelKeys, type FolderRow } from '../organize.js';
import { findOwned } from '../sync/sync.js';
import { liveTasksOfList, lockTaskTrees } from '../task-tree.js';
import { moveToTrash } from '../trash.js';
import { inboxProtected, invalidFolder, notFound, Rejection, respond } from './respond.js';

type Params = { Params: { id: string } };

/** A live 文件夹 of the user, or null. */
async function ownFolder(db: Executor, userId: string, id: string): Promise<FolderRow | null> {
  const [row] = await db
    .select()
    .from(folders)
    .where(and(eq(folders.id, id), eq(folders.userId, userId), isNull(folders.deletedAt)));
  return row ?? null;
}

/** 清单 and 文件夹 (spec 用户故事 12–15), 清单归档 (16). */
export function listRoutes(app: FastifyInstance) {
  app.get('/api/lists', async (request) => {
    const userId = sessionUser(request).id;
    const inbox = await ensureInbox(app.db, app.sync, userId);
    const listRows = await app.db
      .select()
      .from(lists)
      .where(and(eq(lists.userId, userId), isNull(lists.deletedAt), eq(lists.isInbox, false)));
    const folderRows = await app.db
      .select()
      .from(folders)
      .where(and(eq(folders.userId, userId), isNull(folders.deletedAt)));
    const counts = await app.db
      .select({ listId: tasks.listId, n: count() })
      .from(tasks)
      .where(and(eq(tasks.userId, userId), isNull(tasks.deletedAt), eq(tasks.status, 'open')))
      .groupBy(tasks.listId);
    const response: SidebarResponse = {
      lists: [inbox, ...listRows.sort((a, b) => compareSortKeys(a.sortOrder, b.sortOrder))].map(listToApi),
      folders: folderRows.sort((a, b) => compareSortKeys(a.sortOrder, b.sortOrder)).map(folderToApi),
      openTaskCounts: Object.fromEntries(counts.map((c) => [c.listId, c.n])),
    };
    return response;
  });

  app.post('/api/lists', async (request, reply) => {
    const body = createListRequestSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    const userId = sessionUser(request).id;
    const { id, name, color = null, icon = null, folderId = null, sortOrder } = body.data;
    return respond(
      reply,
      () =>
        app.sync.transaction(userId, async (ops, tx) => {
          if (folderId && !(await ownFolder(tx, userId, folderId))) throw new Rejection(invalidFolder);
          return ops.insert(lists, {
            ...(id ? { id } : {}),
            name,
            color,
            icon,
            folderId,
            isInbox: false,
            sortOrder: sortOrder ?? (await endOfSidebarLevel(tx, userId, folderId)),
          });
        }),
      (row) => reply.code(201).send(listToApi(row)),
    );
  });

  app.patch<Params>('/api/lists/:id', async (request, reply) => {
    const userId = sessionUser(request).id;
    const list = await findOwned(app.db, lists, userId, request.params.id);
    if (!list) return notFound(reply);
    const body = updateListRequestSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    if (list.isInbox) return inboxProtected(reply, '修改');
    const { archived, ...patch } = body.data;
    return respond(
      reply,
      () =>
        app.sync.transaction(userId, async (ops, tx) => {
          const folderChanged = patch.folderId !== undefined && patch.folderId !== list.folderId;
          if (patch.folderId && folderChanged && !(await ownFolder(tx, userId, patch.folderId))) {
            throw new Rejection(invalidFolder);
          }
          const sortOrder =
            patch.sortOrder ?? (folderChanged ? await endOfSidebarLevel(tx, userId, patch.folderId ?? null) : undefined);
          const archive = archived === undefined || archived === (list.archivedAt !== null) ? {} : { archivedAt: archived ? app.clock.now() : null };
          const row = await ops.update(lists, list.id, { ...patch, ...archive, ...(sortOrder ? { sortOrder } : {}) });
          if (!row) throw new Rejection(notFound);
          return row;
        }),
      (row) => listToApi(row),
    );
  });

  app.delete<Params>('/api/lists/:id', async (request, reply) => {
    const userId = sessionUser(request).id;
    const list = await findOwned(app.db, lists, userId, request.params.id);
    if (!list) return notFound(reply);
    if (list.isInbox) return inboxProtected(reply, '删除');
    return respond(
      reply,
      () =>
        app.sync.transaction(userId, async (ops, tx) => {
          // The 清单's tasks go into the 回收站, one batch per task tree (tombstones, so
          // offline clients drop them too); restoring one later puts it into the 收件箱.
          await lockTaskTrees(tx, userId);
          const owned = await liveTasksOfList(tx, userId, list.id);
          const ids = new Set(owned.map((task) => task.id));
          for (const root of owned.filter((task) => task.parentId === null || !ids.has(task.parentId))) {
            await moveToTrash(ops, tx, userId, root, owned);
          }
          if (!(await ops.softDelete(lists, list.id))) throw new Rejection(notFound);
          return { id: list.id };
        }),
      () => reply.code(204).send(),
    );
  });

  app.post('/api/folders', async (request, reply) => {
    const body = createFolderRequestSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    const userId = sessionUser(request).id;
    const { id, name, sortOrder } = body.data;
    return respond(
      reply,
      () =>
        app.sync.transaction(userId, async (ops, tx) =>
          ops.insert(folders, {
            ...(id ? { id } : {}),
            name,
            collapsed: false,
            sortOrder: sortOrder ?? (await endOfSidebarLevel(tx, userId, null)),
          }),
        ),
      (row) => reply.code(201).send(folderToApi(row)),
    );
  });

  app.patch<Params>('/api/folders/:id', async (request, reply) => {
    const userId = sessionUser(request).id;
    const folder = await findOwned(app.db, folders, userId, request.params.id);
    if (!folder) return notFound(reply);
    const body = updateFolderRequestSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    const updated = await app.sync.transaction(userId, (ops) => ops.update(folders, folder.id, body.data));
    if (!updated) return notFound(reply);
    return folderToApi(updated);
  });

  /** Deleting a 文件夹 keeps its 清单: they move to the top level where the folder was. */
  app.delete<Params>('/api/folders/:id', async (request, reply) => {
    const userId = sessionUser(request).id;
    const folder = await findOwned(app.db, folders, userId, request.params.id);
    if (!folder) return notFound(reply);
    return respond(
      reply,
      () =>
        app.sync.transaction(userId, async (ops, tx) => {
          const children = (
            await tx
              .select()
              .from(lists)
              .where(and(eq(lists.userId, userId), eq(lists.folderId, folder.id), isNull(lists.deletedAt)))
          ).sort((a, b) => compareSortKeys(a.sortOrder, b.sortOrder));
          const after = (await topLevelKeys(tx, userId))
            .filter((k) => compareSortKeys(k, folder.sortOrder) > 0)
            .sort(compareSortKeys)[0];
          const keys = sortKeysBetween(folder.sortOrder, after ?? null, children.length);
          for (const [i, child] of children.entries()) {
            await ops.update(lists, child.id, { folderId: null, sortOrder: keys[i] as string });
          }
          if (!(await ops.softDelete(folders, folder.id))) throw new Rejection(notFound);
          return { id: folder.id };
        }),
      () => reply.code(204).send(),
    );
  });
}
