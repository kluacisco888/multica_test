import type { FastifyInstance } from 'fastify';
import { changePasswordRequestSchema, loginRequestSchema, type MeResponse } from '@dida/shared';
import { AccountError, type Accounts } from '../accounts.js';
import { clearSessionCookie, sessionToken, sessionUser, setSessionCookie } from '../auth.js';
import type { AppConfig } from '../config.js';
import { sendError, sendValidationError } from '../http-errors.js';
import type { SessionStore } from '../sessions.js';

/** Login, logout, current user and password change. No registration endpoint exists. */
export function authRoutes(
  app: FastifyInstance,
  deps: { accounts: Accounts; sessions: SessionStore; config: AppConfig },
) {
  const { accounts, sessions, config } = deps;

  app.post('/api/auth/login', { config: { public: true } }, async (request, reply) => {
    const body = loginRequestSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    const result = await accounts.verifyLogin(body.data.username, body.data.password);
    if (!result.ok) {
      return result.reason === 'disabled'
        ? sendError(reply, 403, 'account_disabled', '该账户已停用，请联系管理员')
        : sendError(reply, 401, 'invalid_credentials', '账号或密码错误');
    }
    // Replace any session this browser already had.
    await sessions.revoke(sessionToken(request) ?? '');
    const { token, expiresAt } = await sessions.create(result.account.id);
    setSessionCookie(reply, config, token, expiresAt);
    const { id, username, isAdmin } = result.account;
    const response: MeResponse = { user: { id, username, isAdmin } };
    return response;
  });

  app.post('/api/auth/logout', { config: { public: true } }, async (request, reply) => {
    await sessions.revoke(sessionToken(request) ?? '');
    clearSessionCookie(reply, config);
    return reply.code(204).send();
  });

  app.get('/api/auth/me', async (request) => {
    const { id, username, isAdmin } = sessionUser(request);
    const response: MeResponse = { user: { id, username, isAdmin } };
    return response;
  });

  app.post('/api/auth/password', async (request, reply) => {
    const body = changePasswordRequestSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    const user = sessionUser(request);
    try {
      await accounts.changePassword(user.id, body.data.currentPassword, body.data.newPassword, user.sessionId);
    } catch (error) {
      if (error instanceof AccountError && error.code === 'wrong_password') {
        return sendError(reply, 400, 'wrong_password', error.message);
      }
      if (error instanceof AccountError && error.code === 'invalid_password') {
        return sendError(reply, 400, 'invalid_request', error.message);
      }
      throw error;
    }
    return reply.code(204).send();
  });
}
