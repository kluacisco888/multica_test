import type { FastifyInstance } from 'fastify';
import { snoozeRequestSchema, type ReminderAlertsResponse, type ReminderFailuresResponse } from '@dida/shared';
import { sessionUser } from '../auth.js';
import { sendValidationError } from '../http-errors.js';
import { notFound } from './respond.js';

type Params = { Params: { id: string } };

/**
 * 应用内提醒 (spec 用户故事 82) and 失败记录 (83). The page polls the alerts
 * while it is open; 完成 is a normal task update (which dismisses the alert),
 * 稍后提醒 schedules the reminder again.
 */
export function reminderRoutes(app: FastifyInstance) {
  app.get('/api/reminders/alerts', async (request) => {
    const response: ReminderAlertsResponse = { alerts: await app.reminders.alerts(sessionUser(request).id) };
    return response;
  });

  app.post<Params>('/api/reminders/alerts/:id/dismiss', async (request, reply) => {
    if (!(await app.reminders.dismissAlert(sessionUser(request).id, request.params.id))) return notFound(reply);
    return reply.code(204).send();
  });

  app.post<Params>('/api/reminders/alerts/:id/snooze', async (request, reply) => {
    const body = snoozeRequestSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    const snoozed = await app.reminders.snooze(sessionUser(request).id, request.params.id, body.data.minutes);
    if (!snoozed) return notFound(reply);
    return { fireAt: snoozed.fireAt.toISOString() };
  });

  app.get('/api/reminders/failures', async (request) => {
    const response: ReminderFailuresResponse = { failures: await app.reminders.failures(sessionUser(request).id) };
    return response;
  });
}
