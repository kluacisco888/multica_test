import type { FastifyInstance } from 'fastify';
import { updateSettingsRequestSchema } from '@dida/shared';
import { sessionUser } from '../auth.js';
import { sendValidationError } from '../http-errors.js';
import { readSettings, writeSettings } from '../settings.js';

/** 设置 (spec 用户故事 26: the time zone). */
export function settingsRoutes(app: FastifyInstance) {
  app.get('/api/settings', async (request) => readSettings(app.db, sessionUser(request).id));

  app.patch('/api/settings', async (request, reply) => {
    const body = updateSettingsRequestSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    const userId = sessionUser(request).id;
    return app.sync.transaction(userId, (ops, tx) => writeSettings(ops, tx, userId, body.data));
  });
}
