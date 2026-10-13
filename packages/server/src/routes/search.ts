import type { FastifyInstance } from 'fastify';
import { searchQuerySchema, type SmartListCountsResponse } from '@dida/shared';
import { sessionUser } from '../auth.js';
import { sendValidationError } from '../http-errors.js';
import { searchTasks } from '../search.js';
import { smartListCounts } from '../task-views.js';

/** 全局搜索 and the sidebar counts of 智能清单 (spec 用户故事 59、63). */
export function searchRoutes(app: FastifyInstance) {
  app.get('/api/search', async (request, reply) => {
    const query = searchQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);
    return searchTasks(app.db, sessionUser(request).id, query.data.q);
  });

  app.get('/api/smart-lists', async (request) => {
    const response: SmartListCountsResponse = { counts: await smartListCounts(app.db, sessionUser(request).id, app.clock.now()) };
    return response;
  });
}
