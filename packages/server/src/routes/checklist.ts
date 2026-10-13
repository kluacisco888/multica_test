import type { FastifyInstance } from 'fastify';
import {
  createChecklistItemRequestSchema,
  keyBetween,
  updateChecklistItemRequestSchema,
  type ChecklistItemsResponse,
} from '@dida/shared';
import { sessionUser } from '../auth.js';
import { checklistItems, tasks } from '../db/schema/tasks.js';
import { sendValidationError } from '../http-errors.js';
import { checklistItemToApi } from '../organize.js';
import { findOwned } from '../sync/sync.js';
import { liveChecklistItems } from '../task-tree.js';
import { notChecklist, notFound, Rejection, respond } from './respond.js';

type Params = { Params: { id: string } };

/** 检查项 of a 任务 in 检查清单 mode (spec 用户故事 37): add, check, rename, reorder, delete. */
export function checklistRoutes(app: FastifyInstance) {
  app.get<Params>('/api/tasks/:id/checklist-items', async (request, reply) => {
    const userId = sessionUser(request).id;
    const task = await findOwned(app.db, tasks, userId, request.params.id);
    if (!task) return notFound(reply);
    const response: ChecklistItemsResponse = { items: (await liveChecklistItems(app.db, userId, task.id)).map(checklistItemToApi) };
    return response;
  });

  app.post<Params>('/api/tasks/:id/checklist-items', async (request, reply) => {
    const userId = sessionUser(request).id;
    const task = await findOwned(app.db, tasks, userId, request.params.id);
    if (!task) return notFound(reply);
    const body = createChecklistItemRequestSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    if (task.kind !== 'checklist') return notChecklist(reply);
    const { id, title, completed = false, sortOrder } = body.data;
    return respond(
      reply,
      () =>
        app.sync.transaction(userId, async (ops, tx) => {
          const existing = await liveChecklistItems(tx, userId, task.id);
          return ops.insert(checklistItems, {
            ...(id ? { id } : {}),
            taskId: task.id,
            title,
            completed,
            sortOrder: sortOrder ?? keyBetween(existing.at(-1)?.sortOrder ?? null, null),
          });
        }),
      (row) => reply.code(201).send(checklistItemToApi(row)),
    );
  });

  app.patch<Params>('/api/checklist-items/:id', async (request, reply) => {
    const userId = sessionUser(request).id;
    const item = await findOwned(app.db, checklistItems, userId, request.params.id);
    if (!item) return notFound(reply);
    const body = updateChecklistItemRequestSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    return respond(
      reply,
      () =>
        app.sync.transaction(userId, async (ops) => {
          const row = await ops.update(checklistItems, item.id, body.data);
          if (!row) throw new Rejection(notFound);
          return row;
        }),
      (row) => checklistItemToApi(row),
    );
  });

  app.delete<Params>('/api/checklist-items/:id', async (request, reply) => {
    const userId = sessionUser(request).id;
    const item = await findOwned(app.db, checklistItems, userId, request.params.id);
    if (!item) return notFound(reply);
    return respond(
      reply,
      () =>
        app.sync.transaction(userId, async (ops) => {
          if (!(await ops.softDelete(checklistItems, item.id))) throw new Rejection(notFound);
          return item.id;
        }),
      () => reply.code(204).send(),
    );
  });
}
