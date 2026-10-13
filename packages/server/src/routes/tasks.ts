import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { createTaskRequestSchema, tasksQuerySchema, updateTaskRequestSchema, type TasksResponse } from '@dida/shared';
import { sessionUser } from '../auth.js';
import { lists, tasks } from '../db/schema/tasks.js';
import { sendValidationError } from '../http-errors.js';
import { compareTasks, ensureInbox, taskToApi, topOfList } from '../organize.js';
import { findOwned } from '../sync/sync.js';
import { invalidList, notFound, Rejection, respond } from './respond.js';

type Params = { Params: { id: string } };

/** 任务 basics: quick add, edit, Markdown description, complete, move (spec 用户故事 20、21、27、31、40). */
export function taskRoutes(app: FastifyInstance) {
  app.get('/api/tasks', async (request, reply) => {
    const query = tasksQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);
    const userId = sessionUser(request).id;
    const list = await findOwned(app.db, lists, userId, query.data.listId);
    if (!list) return notFound(reply);
    const rows = await app.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.userId, userId), eq(tasks.listId, list.id), isNull(tasks.deletedAt)));
    const response: TasksResponse = { tasks: rows.sort(compareTasks).map(taskToApi) };
    return response;
  });

  app.get<Params>('/api/tasks/:id', async (request, reply) => {
    const task = await findOwned(app.db, tasks, sessionUser(request).id, request.params.id);
    if (!task) return notFound(reply);
    return taskToApi(task);
  });

  app.post('/api/tasks', async (request, reply) => {
    const body = createTaskRequestSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    const userId = sessionUser(request).id;
    const { id, listId, title, description = '', sortOrder } = body.data;
    // No 清单 given: the 收件箱.
    const list = listId ? await findOwned(app.db, lists, userId, listId) : await ensureInbox(app.db, app.sync, userId);
    if (!list) return invalidList(reply);
    return respond(
      reply,
      () =>
        app.sync.transaction(userId, async (ops, tx) =>
          ops.insert(tasks, {
            ...(id ? { id } : {}),
            listId: list.id,
            title,
            description,
            status: 'open',
            completedAt: null,
            sortOrder: sortOrder ?? (await topOfList(tx, userId, list.id)),
          }),
        ),
      (row) => reply.code(201).send(taskToApi(row)),
    );
  });

  app.patch<Params>('/api/tasks/:id', async (request, reply) => {
    const userId = sessionUser(request).id;
    const task = await findOwned(app.db, tasks, userId, request.params.id);
    if (!task) return notFound(reply);
    const body = updateTaskRequestSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    const { status, listId, sortOrder, ...fields } = body.data;
    return respond(
      reply,
      () =>
        app.sync.transaction(userId, async (ops, tx) => {
          const moved = listId !== undefined && listId !== task.listId;
          if (moved && !(await findOwned(tx, lists, userId, listId))) throw new Rejection(invalidList);
          const target = listId ?? task.listId;
          const row = await ops.update(tasks, task.id, {
            ...fields,
            ...(moved ? { listId: target } : {}),
            ...(sortOrder ? { sortOrder } : moved ? { sortOrder: await topOfList(tx, userId, target) } : {}),
            ...(status === 'completed' ? { status, completedAt: task.completedAt ?? app.clock.now() } : {}),
            ...(status === 'open' ? { status, completedAt: null } : {}),
          });
          if (!row) throw new Rejection(notFound);
          return row;
        }),
      (row) => taskToApi(row),
    );
  });
}
