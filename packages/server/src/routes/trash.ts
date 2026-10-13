import type { FastifyInstance } from 'fastify';
import type { TrashResponse } from '@dida/shared';
import { sessionUser } from '../auth.js';
import { taskToApi } from '../organize.js';
import { notFound } from './respond.js';

type Params = { Params: { id: string } };

/** 回收站 (spec 用户故事 29、30): list, 还原, 彻底删除, 清空. Deleting goes through `DELETE /api/tasks/:id`. */
export function trashRoutes(app: FastifyInstance) {
  app.get('/api/trash', async (request) => {
    const response: TrashResponse = { tasks: await app.trash.list(sessionUser(request).id) };
    return response;
  });

  app.post<Params>('/api/trash/:id/restore', async (request, reply) => {
    const restored = await app.trash.restore(sessionUser(request).id, request.params.id);
    if (!restored) return notFound(reply);
    return taskToApi(restored);
  });

  app.delete<Params>('/api/trash/:id', async (request, reply) => {
    if (!(await app.trash.purge(sessionUser(request).id, request.params.id))) return notFound(reply);
    return reply.code(204).send();
  });

  app.delete('/api/trash', async (request, reply) => {
    await app.trash.empty(sessionUser(request).id);
    return reply.code(204).send();
  });
}
