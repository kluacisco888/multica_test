import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  focusStatsQuerySchema,
  startFocusRequestSchema,
  updateFocusRequestSchema,
  type CurrentFocusResponse,
  type FocusRecordsResponse,
} from '@dida/shared';
import { sessionUser } from '../auth.js';
import type { FocusAction } from '../focus/service.js';
import { sendError, sendValidationError } from '../http-errors.js';
import { idTaken } from './respond.js';

const noTimer = (reply: FastifyReply) => sendError(reply, 404, 'no_active_focus', '没有进行中的专注');
const taskNotFound = (reply: FastifyReply) => sendError(reply, 404, 'not_found', '任务不存在');

/**
 * 番茄专注 (spec 用户故事 86–92). The page shows `GET /api/focus/current` and
 * reads it again when its countdown reaches zero; each answer carries the
 * server's `now`. See focus/service.ts.
 */
export function focusRoutes(app: FastifyInstance) {
  app.get('/api/focus/current', async (request): Promise<CurrentFocusResponse> => app.focus.current(sessionUser(request).id));

  app.post('/api/focus/start', async (request, reply) => {
    const body = startFocusRequestSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    const result = await app.focus.start(sessionUser(request).id, body.data);
    if (result === 'focus_active') return sendError(reply, 409, 'focus_active', '已有进行中的专注');
    if (result === 'task_not_found') return taskNotFound(reply);
    if (result === 'id_taken') return idTaken(reply);
    return result;
  });

  for (const action of ['pause', 'resume', 'abandon', 'finish'] as const satisfies readonly FocusAction[]) {
    app.post(`/api/focus/current/${action}`, async (request, reply) => {
      const result = await app.focus.act(sessionUser(request).id, action);
      if (result === 'none') return noTimer(reply);
      if (result === 'conflict') return sendError(reply, 409, 'focus_state', '当前专注不能这样操作');
      return result;
    });
  }

  app.patch('/api/focus/current', async (request, reply) => {
    const body = updateFocusRequestSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    const result = await app.focus.link(sessionUser(request).id, body.data.taskId);
    if (result === 'none') return noTimer(reply);
    if (result === 'task_not_found') return taskNotFound(reply);
    return result;
  });

  app.get('/api/focus/records', async (request): Promise<FocusRecordsResponse> => ({
    records: await app.focus.records(sessionUser(request).id),
  }));

  app.get('/api/focus/stats', async (request, reply) => {
    const query = focusStatsQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);
    return app.focus.stats(sessionUser(request).id, query.data.unit, query.data.date);
  });
}
