import { and, asc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  createCommentRequestSchema,
  updateCommentRequestSchema,
  type Comment,
  type CommentsResponse,
} from '@dida/shared';
import { sessionUser } from '../auth.js';
import { comments } from '../db/schema/attachments.js';
import { tasks } from '../db/schema/tasks.js';
import { sendValidationError } from '../http-errors.js';
import { findOwned } from '../sync/sync.js';
import { lockTaskTrees } from '../task-tree.js';
import { notFound, Rejection, respond } from './respond.js';

type Params = { Params: { id: string } };
export type CommentRow = typeof comments.$inferSelect;

export function commentToApi(row: CommentRow): Comment {
  return {
    id: row.id,
    taskId: row.taskId,
    content: row.content,
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    revision: row.revision,
  };
}

/** 评论 (spec 用户故事 39): write, edit and delete notes on a 任务. */
export function commentRoutes(app: FastifyInstance) {
  app.get<Params>('/api/tasks/:id/comments', async (request, reply) => {
    const userId = sessionUser(request).id;
    const task = await findOwned(app.db, tasks, userId, request.params.id);
    if (!task) return notFound(reply);
    const rows = await app.db
      .select()
      .from(comments)
      .where(and(eq(comments.userId, userId), eq(comments.taskId, task.id), isNull(comments.deletedAt)))
      .orderBy(asc(comments.createdAt), asc(comments.id));
    const response: CommentsResponse = { comments: rows.map(commentToApi) };
    return response;
  });

  app.post<Params>('/api/tasks/:id/comments', async (request, reply) => {
    const userId = sessionUser(request).id;
    const task = await findOwned(app.db, tasks, userId, request.params.id);
    if (!task) return notFound(reply);
    const body = createCommentRequestSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    const { id, content } = body.data;
    return respond(
      reply,
      () =>
        app.sync.transaction(userId, async (ops, tx) => {
          // Same lock as 删除 / 彻底删除: a 评论 never lands on a task purged meanwhile.
          await lockTaskTrees(tx, userId);
          if (!(await findOwned(tx, tasks, userId, task.id))) throw new Rejection(notFound);
          return ops.insert(comments, { ...(id ? { id } : {}), taskId: task.id, content, editedAt: null });
        }),
      (row) => reply.code(201).send(commentToApi(row)),
    );
  });

  app.patch<Params>('/api/comments/:id', async (request, reply) => {
    const userId = sessionUser(request).id;
    const comment = await findOwned(app.db, comments, userId, request.params.id);
    if (!comment) return notFound(reply);
    const body = updateCommentRequestSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    return respond(
      reply,
      () =>
        app.sync.transaction(userId, async (ops) => {
          const row = await ops.update(comments, comment.id, { content: body.data.content, editedAt: app.clock.now() });
          if (!row) throw new Rejection(notFound);
          return row;
        }),
      (row) => commentToApi(row),
    );
  });

  app.delete<Params>('/api/comments/:id', async (request, reply) => {
    const userId = sessionUser(request).id;
    const comment = await findOwned(app.db, comments, userId, request.params.id);
    if (!comment) return notFound(reply);
    return respond(
      reply,
      () =>
        app.sync.transaction(userId, async (ops) => {
          if (!(await ops.softDelete(comments, comment.id))) throw new Rejection(notFound);
          return comment.id;
        }),
      () => reply.code(204).send(),
    );
  });
}
