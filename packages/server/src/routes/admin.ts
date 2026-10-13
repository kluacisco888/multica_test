import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  createUserRequestSchema,
  resetPasswordRequestSchema,
  updateUserRequestSchema,
  type AdminUser,
  type AdminUsersResponse,
} from '@dida/shared';
import { z } from 'zod';
import { AccountError, type Account, type Accounts } from '../accounts.js';
import { sessionUser } from '../auth.js';
import { sendError, sendValidationError } from '../http-errors.js';
import { notFound } from './respond.js';

/*
 * 后台 (spec 用户故事 9): 管理员 manage 用户. Everything under `/api/admin/`
 * is admin-only by `registerAuthentication`, so these handlers never check
 * the role themselves.
 */

type Params = { Params: { id: string } };

const uuid = z.uuid();

function toApi(account: Account): AdminUser {
  const { id, username, isAdmin, disabled, createdAt } = account;
  return { id, username, isAdmin, disabled, createdAt: createdAt.toISOString() };
}

/** Map account rule violations to HTTP answers; anything else is a bug. */
function accountError(reply: FastifyReply, error: unknown): FastifyReply {
  if (!(error instanceof AccountError)) throw error;
  switch (error.code) {
    case 'username_taken':
      return sendError(reply, 409, 'username_taken', error.message);
    case 'invalid_username':
    case 'invalid_password':
      return sendError(reply, 400, 'invalid_request', error.message);
    case 'cannot_disable_self':
    case 'last_admin':
      return sendError(reply, 400, error.code, error.message);
    case 'user_not_found':
      return notFound(reply);
    case 'wrong_password':
      throw error;
  }
}

export function adminRoutes(app: FastifyInstance, deps: { accounts: Accounts }) {
  const { accounts } = deps;

  /** The 用户 named by `:id`, or null (malformed ids look missing too). */
  const target = async (id: string) => (uuid.safeParse(id).success ? accounts.findById(id) : null);

  app.get('/api/admin/users', async () => {
    const response: AdminUsersResponse = { users: (await accounts.list()).map(toApi) };
    return response;
  });

  app.post('/api/admin/users', async (request, reply) => {
    const body = createUserRequestSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      const account = await accounts.create(body.data);
      return reply.code(201).send(toApi(account));
    } catch (error) {
      return accountError(reply, error);
    }
  });

  app.patch<Params>('/api/admin/users/:id', async (request, reply) => {
    const user = await target(request.params.id);
    if (!user) return notFound(reply);
    const body = updateUserRequestSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    try {
      return toApi(await accounts.setDisabled(user.username, body.data.disabled, { actorId: sessionUser(request).id }));
    } catch (error) {
      return accountError(reply, error);
    }
  });

  app.post<Params>('/api/admin/users/:id/password', async (request, reply) => {
    const user = await target(request.params.id);
    if (!user) return notFound(reply);
    const body = resetPasswordRequestSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    const actor = sessionUser(request);
    try {
      // Resetting one's own password keeps this browser signed in.
      await accounts.resetPassword(user.username, body.data.password, actor.id === user.id ? { keepSessionId: actor.sessionId } : {});
    } catch (error) {
      return accountError(reply, error);
    }
    return reply.code(204).send();
  });
}
