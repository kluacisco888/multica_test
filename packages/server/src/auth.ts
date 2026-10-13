import type { FastifyInstance, FastifyReply, FastifyRequest, onRouteHookHandler, preHandlerHookHandler } from 'fastify';
import type { AppConfig } from './config.js';
import { sendError } from './http-errors.js';
import { SESSION_TTL_MS, type SessionStore, type SessionUser } from './sessions.js';

export type { SessionUser } from './sessions.js';

export const SESSION_COOKIE = 'dida_session';

export interface ApiRoute {
  method: string;
  url: string;
  public: boolean;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Opt this `/api` route out of the default session requirement (health, login, logout). */
    public?: boolean;
  }
  interface FastifyRequest {
    /** Set by the `authenticate` preHandler; null on public routes. */
    user: SessionUser | null;
  }
  interface FastifyInstance {
    /** preHandler: 401 unless the session cookie resolves to an enabled user. */
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
    /** Every registered `/api` route and whether it is public (the access-control test walks this). */
    apiRoutes: readonly ApiRoute[];
  }
}

/** The session user of an authenticated route. */
export function sessionUser(request: FastifyRequest): SessionUser {
  if (!request.user) throw new Error('sessionUser() used on a route without authenticate');
  return request.user;
}

export function sessionToken(request: FastifyRequest): string | undefined {
  return request.cookies[SESSION_COOKIE] || undefined;
}

export function setSessionCookie(reply: FastifyReply, config: AppConfig, token: string, expiresAt: Date) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    // Over plain http (ssh -L to 127.0.0.1) a Secure cookie would never be sent back.
    secure: config.publicUrl.startsWith('https://'),
    expires: expiresAt,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function clearSessionCookie(reply: FastifyReply, config: AppConfig) {
  reply.clearCookie(SESSION_COOKIE, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.publicUrl.startsWith('https://'),
  });
}

function isApiRoute(url: string) {
  return url === '/api' || url.startsWith('/api/');
}

/**
 * Install session authentication. Every `/api` route requires a session unless
 * it declares `config: { public: true }` — new resource routes are protected by
 * default and cannot forget it.
 */
export function registerAuthentication(app: FastifyInstance, deps: { sessions: SessionStore; config: AppConfig }) {
  app.decorateRequest('user', null);
  app.decorate('authenticate', async function authenticate(request: FastifyRequest, reply: FastifyReply) {
    const resolved = await deps.sessions.resolve(sessionToken(request) ?? '');
    if (!resolved) {
      if (sessionToken(request)) clearSessionCookie(reply, deps.config);
      await sendError(reply, 401, 'unauthorized', '未登录或会话已过期');
      return;
    }
    request.user = resolved.user;
    if (resolved.renewed) {
      setSessionCookie(reply, deps.config, sessionToken(request) as string, resolved.expiresAt);
    }
  });

  const apiRoutes: ApiRoute[] = [];
  app.decorate('apiRoutes', apiRoutes);

  const requireSession: onRouteHookHandler = (route) => {
    if (!isApiRoute(route.url)) return;
    for (const method of [route.method].flat()) {
      if (method !== 'HEAD') apiRoutes.push({ method, url: route.url, public: route.config?.public === true });
    }
    if (route.config?.public) return;
    const existing = route.preHandler;
    const handlers: preHandlerHookHandler[] = existing === undefined ? [] : Array.isArray(existing) ? existing : [existing];
    if (handlers.includes(app.authenticate as preHandlerHookHandler)) return;
    route.preHandler = [app.authenticate as preHandlerHookHandler, ...handlers];
  };
  app.addHook('onRoute', requireSession);
}
