import { and, arrayContains, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  compareSortKeys,
  createTagRequestSchema,
  nestingProblem,
  orderTags,
  sortKeysBetween,
  updateTagRequestSchema,
  type NestingProblem,
  type TagsResponse,
} from '@dida/shared';
import { sessionUser } from '../auth.js';
import type { Executor } from '../db/client.js';
import { isUniqueViolation } from '../db/errors.js';
import { tags } from '../db/schema/tags.js';
import { tasks } from '../db/schema/tasks.js';
import { sendValidationError } from '../http-errors.js';
import { endOfTagLevel, tagToApi, type TagRow } from '../organize.js';
import { findOwned } from '../sync/sync.js';
import { invalidParentTag, notFound, Rejection, respond, tagNameTaken } from './respond.js';

type Params = { Params: { id: string } };

const NESTING_MESSAGES: Record<NestingProblem, string> = {
  self: '标签不能放在自己下面',
  parent_missing: '父标签不存在',
  parent_is_child: '子标签下面不能再放标签',
  has_children: '有子标签的标签不能放进其他标签',
};

/** Every live 标签 of the user. */
export async function liveTags(db: Executor, userId: string): Promise<TagRow[]> {
  return db
    .select()
    .from(tags)
    .where(and(eq(tags.userId, userId), isNull(tags.deletedAt)));
}

/** Another live 标签 of the user with this name (case-insensitive). */
async function nameTaken(db: Executor, userId: string, name: string, exceptId: string | null): Promise<boolean> {
  const rows = await db
    .select({ id: tags.id })
    .from(tags)
    .where(
      and(
        eq(tags.userId, userId),
        isNull(tags.deletedAt),
        sql`lower(${tags.name}) = lower(${name})`,
        ...(exceptId ? [ne(tags.id, exceptId)] : []),
      ),
    );
  return rows.length > 0;
}

/** Name collisions that slip past the pre-check (concurrent writes) still answer 409 tag_name_taken. */
function rejectDuplicateName(error: unknown): never {
  if (isUniqueViolation(error) && String((error as { cause?: { constraint?: string } }).cause?.constraint) === 'tags_user_name_unique') {
    throw new Rejection(tagNameTaken);
  }
  throw error;
}

/** 标签: create, rename, recolour, nest, delete (spec 用户故事 18、19). */
export function tagRoutes(app: FastifyInstance) {
  app.get('/api/tags', async (request) => {
    const response: TagsResponse = { tags: orderTags(await liveTags(app.db, sessionUser(request).id)).map(tagToApi) };
    return response;
  });

  app.post('/api/tags', async (request, reply) => {
    const body = createTagRequestSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    const userId = sessionUser(request).id;
    const { id, name, color = null, parentId = null, sortOrder } = body.data;
    return respond(
      reply,
      () =>
        app.sync.transaction(userId, async (ops, tx) => {
          const problem = nestingProblem(await liveTags(tx, userId), null, parentId);
          if (problem) throw new Rejection((r) => invalidParentTag(r, NESTING_MESSAGES[problem]));
          if (await nameTaken(tx, userId, name, null)) throw new Rejection(tagNameTaken);
          return ops
            .insert(tags, {
              ...(id ? { id } : {}),
              name,
              color,
              parentId,
              sortOrder: sortOrder ?? (await endOfTagLevel(tx, userId, parentId)),
            })
            .catch(rejectDuplicateName);
        }),
      (row) => reply.code(201).send(tagToApi(row)),
    );
  });

  app.patch<Params>('/api/tags/:id', async (request, reply) => {
    const userId = sessionUser(request).id;
    const tag = await findOwned(app.db, tags, userId, request.params.id);
    if (!tag) return notFound(reply);
    const body = updateTagRequestSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    const patch = body.data;
    return respond(
      reply,
      () =>
        app.sync.transaction(userId, async (ops, tx) => {
          const parentChanged = patch.parentId !== undefined && patch.parentId !== tag.parentId;
          if (parentChanged) {
            const problem = nestingProblem(await liveTags(tx, userId), tag.id, patch.parentId ?? null);
            if (problem) throw new Rejection((r) => invalidParentTag(r, NESTING_MESSAGES[problem]));
          }
          if (patch.name !== undefined && (await nameTaken(tx, userId, patch.name, tag.id))) {
            throw new Rejection(tagNameTaken);
          }
          const sortOrder =
            patch.sortOrder ?? (parentChanged ? await endOfTagLevel(tx, userId, patch.parentId ?? null) : undefined);
          const row = await ops
            .update(tags, tag.id, { ...patch, ...(sortOrder ? { sortOrder } : {}) })
            .catch(rejectDuplicateName);
          if (!row) throw new Rejection(notFound);
          return row;
        }),
      (row) => tagToApi(row),
    );
  });

  /**
   * Deleting a 标签 removes it from every 任务 (the tasks themselves stay)
   * and moves its children to the top level where it was.
   */
  app.delete<Params>('/api/tags/:id', async (request, reply) => {
    const userId = sessionUser(request).id;
    const tag = await findOwned(app.db, tags, userId, request.params.id);
    if (!tag) return notFound(reply);
    return respond(
      reply,
      () =>
        app.sync.transaction(userId, async (ops, tx) => {
          const tagged = await tx
            .select({ id: tasks.id, tagIds: tasks.tagIds })
            .from(tasks)
            .where(and(eq(tasks.userId, userId), isNull(tasks.deletedAt), arrayContains(tasks.tagIds, [tag.id])));
          for (const task of tagged) {
            await ops.update(tasks, task.id, { tagIds: task.tagIds.filter((t) => t !== tag.id) });
          }
          // Tombstones are not served with their fields, but keep them clean for a later 回收站 restore.
          await tx
            .update(tasks)
            .set({ tagIds: sql`array_remove(${tasks.tagIds}, ${tag.id}::uuid)` })
            .where(and(eq(tasks.userId, userId), isNotNull(tasks.deletedAt), arrayContains(tasks.tagIds, [tag.id])));

          const all = await liveTags(tx, userId);
          const children = all.filter((t) => t.parentId === tag.id).sort((a, b) => compareSortKeys(a.sortOrder, b.sortOrder));
          if (children.length > 0) {
            const next = all
              .filter((t) => t.parentId === null && compareSortKeys(t.sortOrder, tag.sortOrder) > 0)
              .map((t) => t.sortOrder)
              .sort(compareSortKeys)[0];
            const keys = sortKeysBetween(tag.sortOrder, next ?? null, children.length);
            for (const [i, child] of children.entries()) {
              await ops.update(tags, child.id, { parentId: null, sortOrder: keys[i] as string });
            }
          }
          if (!(await ops.softDelete(tags, tag.id))) throw new Rejection(notFound);
          return { id: tag.id };
        }),
      () => reply.code(204).send(),
    );
  });
}
