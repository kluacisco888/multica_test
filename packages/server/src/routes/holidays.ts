import type { FastifyInstance } from 'fastify';
import { sendError } from '../http-errors.js';

/*
 * 节假日数据 (spec 用户故事 114、115). The data is public and the same for every
 * 用户; any logged-in 用户 may read it and press 立即更新 (it only re-fetches
 * from the configured holiday-cn source, concurrent presses share one fetch).
 */
export function holidayRoutes(app: FastifyInstance) {
  app.get('/api/holidays/status', () => app.holidays.status());

  app.post('/api/holidays/refresh', () => app.holidays.refresh());

  app.get<{ Params: { year: string } }>('/api/holidays/:year', async (request, reply) => {
    if (!/^\d{4}$/.test(request.params.year)) return sendError(reply, 400, 'invalid_request', '年份应为四位数字');
    return app.holidays.year(Number(request.params.year));
  });
}
