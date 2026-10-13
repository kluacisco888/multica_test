import type { FastifyInstance } from 'fastify';
import { changesQuerySchema } from '@dida/shared';
import { sessionUser } from '../auth.js';
import type { Db } from '../db/client.js';
import { sendValidationError } from '../http-errors.js';
import type { SyncEntity } from '../sync/columns.js';
import { readChanges } from '../sync/sync.js';

export function changesRoutes(
  app: FastifyInstance,
  deps: { db: Db; syncEntities: readonly SyncEntity[] },
) {
  app.get('/api/changes', async (request, reply) => {
    const query = changesQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);
    const user = sessionUser(request);
    return readChanges(deps.db, deps.syncEntities, user.id, query.data.since);
  });
}
