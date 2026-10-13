import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  compareSortKeys,
  createFilterRequestSchema,
  keyBetween,
  liveRules,
  updateFilterRequestSchema,
  type Filter,
  type FilterRules,
} from '@dida/shared';
import { sessionUser } from '../auth.js';
import type { Executor } from '../db/client.js';
import { filters } from '../db/schema/filters.js';
import { sendValidationError } from '../http-errors.js';
import { findOwned } from '../sync/sync.js';
import { effectiveRules, ruleRefs, storedRules, type FilterRow, type RuleRefs } from '../task-views.js';
import { invalidList, invalidTags, notFound, Rejection, respond } from './respond.js';

type Params = { Params: { id: string } };

/**
 * API form. With `refs` (the HTTP endpoints) the rules leave out deleted
 * 清单 / 标签; the sync feed (`/api/changes`) sends them as stored.
 */
export function filterToApi(row: FilterRow, refs?: RuleRefs): Filter {
  return {
    id: row.id,
    name: row.name,
    rules: refs ? effectiveRules(row, refs) : storedRules(row),
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

/**
 * Rules to store (过滤器 and 四象限): the user's live 清单 and 标签 are kept, the user's deleted
 * ones are dropped (an old dialog may still send them), anything else —
 * another user's or never existing — is a 400.
 */
export function checkRules(rules: FilterRules, refs: RuleRefs): FilterRules {
  if (!rules.listIds.every((id) => refs.liveLists.has(id) || refs.deletedLists.has(id))) throw new Rejection(invalidList);
  if (!rules.tagIds.every((id) => refs.liveTags.has(id) || refs.deletedTags.has(id))) throw new Rejection(invalidTags);
  return liveRules(rules, refs.liveLists, refs.liveTags);
}

/** 过滤器 (spec 用户故事 62): create, edit, delete. The tasks are `GET /api/tasks?filterId=`. */
export function filterRoutes(app: FastifyInstance) {
  app.get('/api/filters', async (request) => {
    const userId = sessionUser(request).id;
    const [rows, refs] = await Promise.all([liveFilters(app.db, userId), ruleRefs(app.db, userId)]);
    return { filters: rows.map((row) => filterToApi(row, refs)) };
  });

  app.post('/api/filters', async (request, reply) => {
    const body = createFilterRequestSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    const userId = sessionUser(request).id;
    const { id, name, rules, sortOrder } = body.data;
    return respond(
      reply,
      () =>
        app.sync.transaction(userId, async (ops, tx) => {
          const refs = await ruleRefs(tx, userId);
          const last = (await liveFilters(tx, userId)).at(-1);
          const row = await ops.insert(filters, {
            ...(id ? { id } : {}),
            name,
            rules: checkRules(rules, refs),
            sortOrder: sortOrder ?? keyBetween(last?.sortOrder ?? null, null),
          });
          return { row, refs };
        }),
      ({ row, refs }) => reply.code(201).send(filterToApi(row, refs)),
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
          const refs = await ruleRefs(tx, userId);
          const current = await findOwned(tx, filters, userId, filter.id);
          if (!current) throw new Rejection(notFound);
          // Any save (a rename too) also drops deleted 清单 / 标签 from the stored rules; the
          // update gets a new revision (ADR-0004) like every write.
          const rules = checkRules(patch.rules ?? storedRules(current), refs);
          const row = await ops.update(filters, filter.id, { ...patch, rules });
          if (!row) throw new Rejection(notFound);
          return { row, refs };
        }),
      ({ row, refs }) => filterToApi(row, refs),
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
