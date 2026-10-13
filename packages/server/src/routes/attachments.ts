import { and, asc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Readable } from 'node:stream';
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TOO_LARGE_MESSAGE,
  attachmentPreview,
  normalizeMimeType,
  uploadAttachmentQuerySchema,
  type Attachment,
  type AttachmentsResponse,
} from '@dida/shared';
import { AttachmentExistsError, FileTooLargeError } from '../attachments/store.js';
import { sessionUser } from '../auth.js';
import { isUniqueViolation } from '../db/errors.js';
import { attachments } from '../db/schema/attachments.js';
import { tasks } from '../db/schema/tasks.js';
import { sendError, sendValidationError } from '../http-errors.js';
import { findOwned } from '../sync/sync.js';
import { lockTaskTrees } from '../task-tree.js';
import { idTaken, notFound } from './respond.js';

type Params = { Params: { id: string } };
export type AttachmentRow = typeof attachments.$inferSelect;

export function attachmentToApi(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    taskId: row.taskId,
    fileName: row.fileName,
    mimeType: row.mimeType,
    size: row.size,
    preview: attachmentPreview(row.mimeType),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    revision: row.revision,
  };
}

const tooLarge = (reply: FastifyReply) => sendError(reply, 413, 'file_too_large', ATTACHMENT_TOO_LARGE_MESSAGE);

/** RFC 6266 / 5987 Content-Disposition carrying a UTF-8 file name. */
function contentDisposition(kind: 'inline' | 'attachment', fileName: string): string {
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename*=UTF-8''${encoded}`;
}

/**
 * 附件 (spec 用户故事 38): upload (raw body, at most 50MB), list, owner-only
 * download with inline preview for images and PDF, soft delete.
 */
export function attachmentRoutes(app: FastifyInstance) {
  app.get<Params>('/api/tasks/:id/attachments', async (request, reply) => {
    const userId = sessionUser(request).id;
    const task = await findOwned(app.db, tasks, userId, request.params.id);
    if (!task) return notFound(reply);
    const rows = await app.db
      .select()
      .from(attachments)
      .where(and(eq(attachments.userId, userId), eq(attachments.taskId, task.id), isNull(attachments.deletedAt)))
      .orderBy(asc(attachments.createdAt), asc(attachments.id));
    const response: AttachmentsResponse = { attachments: rows.map(attachmentToApi) };
    return response;
  });

  // The upload body is the file itself, streamed to disk: this scope takes any
  // Content-Type as a raw stream instead of parsing JSON.
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_request, payload, done) => done(null, payload));

    scope.post<Params & { Querystring: Record<string, string> }>('/api/tasks/:id/attachments', async (request, reply) => {
      const userId = sessionUser(request).id;
      const task = await findOwned(app.db, tasks, userId, request.params.id);
      if (!task) return notFound(reply);
      const query = uploadAttachmentQuerySchema.safeParse(request.query);
      if (!query.success) return sendValidationError(reply, query.error);
      const declared = Number([request.headers['content-length'] ?? 0].flat()[0]);
      if (declared > ATTACHMENT_MAX_BYTES) {
        // Refuse before reading; the unread body makes the connection unusable.
        reply.header('connection', 'close');
        return tooLarge(reply);
      }
      const body = request.body as Readable | undefined;
      if (!body) return sendError(reply, 400, 'invalid_request', '缺少文件内容');

      const id = query.data.id ?? crypto.randomUUID();
      if (query.data.id && (await app.db.select({ id: attachments.id }).from(attachments).where(eq(attachments.id, id))).length > 0) {
        return idTaken(reply);
      }
      let size: number;
      try {
        size = await app.attachmentStore.write(userId, id, body, ATTACHMENT_MAX_BYTES);
      } catch (error) {
        if (error instanceof FileTooLargeError) return tooLarge(reply);
        // Same client id uploading concurrently: the other request owns the file.
        if (error instanceof AttachmentExistsError) return idTaken(reply);
        throw error;
      }
      // From here on the file at (userId, id) was created by this request.
      try {
        const row = await app.sync.transaction(userId, async (ops, tx) => {
          // The 任务 may have been deleted while the file was uploading; the
          // lock (same as 删除 / 彻底删除) keeps it from being purged under us.
          await lockTaskTrees(tx, userId);
          if (!(await findOwned(tx, tasks, userId, task.id))) return null;
          return ops.insert(attachments, {
            id,
            taskId: task.id,
            fileName: query.data.name,
            mimeType: normalizeMimeType(request.headers['content-type']),
            size,
          });
        });
        if (!row) {
          await app.attachmentStore.remove(userId, id);
          return notFound(reply);
        }
        return reply.code(201).send(attachmentToApi(row));
      } catch (error) {
        // Only this request's own file (link succeeded above) is removed.
        await app.attachmentStore.remove(userId, id);
        if (isUniqueViolation(error)) return idTaken(reply);
        throw error;
      }
    });
  });

  app.get<Params & { Querystring: { download?: string } }>('/api/attachments/:id/content', async (request, reply) => {
    const userId = sessionUser(request).id;
    const row = await findOwned(app.db, attachments, userId, request.params.id);
    // A 附件 of a deleted 任务 is gone with it (the 任务's tombstone covers it in /api/changes).
    if (!row || !(await findOwned(app.db, tasks, userId, row.taskId))) return notFound(reply);
    const file = await app.attachmentStore.open(userId, row.id);
    if (!file) {
      request.log.error({ attachmentId: row.id }, 'attachment file missing on the data volume');
      return notFound(reply);
    }
    // Only allowlisted types are shown in the browser; the rest is a plain download.
    const inline = attachmentPreview(row.mimeType) !== null && request.query.download === undefined;
    return reply
      .header('content-type', attachmentPreview(row.mimeType) ? row.mimeType : 'application/octet-stream')
      .header('content-length', String(file.size))
      .header('content-disposition', contentDisposition(inline ? 'inline' : 'attachment', row.fileName))
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-cache')
      .send(file.stream);
  });

  app.delete<Params>('/api/attachments/:id', async (request, reply) => {
    const userId = sessionUser(request).id;
    const row = await findOwned(app.db, attachments, userId, request.params.id);
    if (!row) return notFound(reply);
    const deleted = await app.sync.transaction(userId, (ops) => ops.softDelete(attachments, row.id));
    if (!deleted) return notFound(reply);
    // The tombstone stays (ADR-0004); the file's content is cleared.
    await app.attachmentStore.remove(userId, row.id);
    return reply.code(204).send();
  });
}
