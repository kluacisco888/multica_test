import type { FastifyReply, FastifyRequest } from 'fastify';

/** The user a request acts on behalf of. */
export interface SessionUser {
  id: string;
}

/**
 * Resolves the session user of a request, or null when not logged in.
 * EURO-5 provides the cookie-session implementation; until then the default
 * resolver logs nobody in, so every protected endpoint answers 401.
 */
export type ResolveUser = (request: FastifyRequest) => Promise<SessionUser | null>;

export const noSessionResolver: ResolveUser = async () => null;

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the `authenticate` preHandler; null on public routes. */
    user: SessionUser | null;
  }
  interface FastifyInstance {
    /** preHandler for every resource route: 401 unless a session user resolves. */
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  }
}

/** The session user of an authenticated route (call after the `authenticate` preHandler). */
export function sessionUser(request: FastifyRequest): SessionUser {
  if (!request.user) throw new Error('sessionUser() used on a route without authenticate');
  return request.user;
}
