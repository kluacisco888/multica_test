import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  compareSortKeys,
  createFilterRequestSchema,
  keyBetween,
  updateFilterRequestSchema,
  type Filter,
  type FilterRules,
} from '@dida/shared';
import { sessionUser } from '../auth.js';
import type { Executor } from '../db/client.js';
import { filters } from '../db/schema/filters.js';
import { lists } from '../db/schema/tasks.js';
import { sendValidationError } from '../http-errors.js';
import { findOwned } from '../sync/sync.js';
import { storedRules, type FilterRow } from '../task-views.js';
import { invalidList, invalidTags, notFound, Rejection, respond } from './respond.js';
import { liveTags } from './tags.js';

type Params = { Params: { id: string } };

export function filterToApi(row: FilterRow): Filter {
  return {
    id: row.id,
    name: row.name,
    rules: storedRules(row),
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    revision: row.revision,
  };
}

async function liveFilters(db: Executor, userId: string): Promise<FilterRow[]> {
  const rows = await db
    .select()
    .from(filters)
    .where(and(eq(filters.userId, userId), isNull(filters.deletedAt)));
  return rows.sort((a, b) => compareSortKeys(a.sortOrder, b.sortOrder) || compareSortKeys(a.id, b.id));
}

/** Rules may only name the user's own live 清单 and 标签. */
async function checkRules(db: Executor, userId: string, rules: FilterRules): Promise<void> {
  if (rules.listIds.length > 0) {
    const own = await db
      .select({ id: lists.id })
      .from(lists)
      .where(and(eq(lists.userId, userId), isNull(lists.deletedAt)));
    const ids = new Set(own.map((l) => l.id));
    if (!rules.listIds.every((id) => ids.has(id))) throw new Rejection(invalidList);
  }
  if (rules.tagIds.length > 0) {
    const ids = new Set((await liveTags(db, userId)).map((t) => t.id));
    if (!rules.tagIds.every((id) => ids.has(id))) throw new Rejection(invalidTags);
  }
}

/** 过滤器 (spec 用户故事 62): create, edit, delete. The tasks are `GET /api/tasks?filterId=`. */
export function filterRoutes(app: FastifyInstance) {
  app.get('/api/filters', async (request) => ({ filters: (await liveFilters(app.db, sessionUser(request).id)).map(filterToApi) }));

  app.post('/api/filters', async (request, reply) => {
    const body = createFilterRequestSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    const userId = sessionUser(request).id;
    const { id, name, rules, sortOrder } = body.data;
    return respond(
      reply,
      () =>
        app.sync.transaction(userId, async (ops, tx) => {
          await checkRules(tx, userId, rules);
          const last = (await liveFilters(tx, userId)).at(-1);
          return ops.insert(filters, {
            ...(id ? { id } : {}),
            name,
            rules,
            sortOrder: sortOrder ?? keyBetween(last?.sortOrder ?? null, null),
          });
        }),
      (row) => reply.code(201).send(filterToApi(row)),
    );
  });

  app.patch<Params>('/api/filters/:id', async (request, reply) => {
    const userId = sessionUser(request).id;
    const filter = await findOwned(app.db, filters, userId, request.params.id);
    if (!filter) return notFound(reply);
    const body = updateFilterRequestSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    const patch = body.data;
    return respond(
      reply,
      () =>
        app.sync.transaction(userId, async (ops, tx) => {
          if (patch.rules) await checkRules(tx, userId, patch.rules);
          const row = await ops.update(filters, filter.id, patch);
          if (!row) throw new Rejection(notFound);
          return row;
        }),
      (row) => filterToApi(row),
    );
  });

  app.delete<Params>('/api/filters/:id', async (request, reply) => {
    const userId = sessionUser(request).id;
    const filter = await findOwned(app.db, filters, userId, request.params.id);
    if (!filter) return notFound(reply);
    const deleted = await app.sync.transaction(userId, (ops) => ops.softDelete(filters, filter.id));
    if (!deleted) return notFound(reply);
    return reply.code(204).send();
  });
}
