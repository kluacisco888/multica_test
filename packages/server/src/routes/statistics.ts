import type { FastifyInstance, FastifyReply } from 'fastify';
import { statisticsQuerySchema, type Statistics } from '@dida/shared';
import { sessionUser } from '../auth.js';
import { sendValidationError } from '../http-errors.js';
import { statistics } from '../statistics.js';

/** 统计 and 成就分 (spec 用户故事 102、103) of the session user. */
export function statisticsRoutes(app: FastifyInstance) {
  app.get('/api/statistics', async (request, reply): Promise<Statistics | FastifyReply> => {
    const query = statisticsQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);
    const userId = sessionUser(request).id;
    // Settle the 专注 first so a 番茄 that just ran out is counted.
    await app.focus.current(userId);
    return statistics(app.db, userId, app.clock.now(), query.data.date);
  });
}
