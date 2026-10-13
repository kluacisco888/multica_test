import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sessionUser, type ApiRoute } from '../../src/auth.js';
import { sendError } from '../../src/http-errors.js';
import { syncColumns, syncIndex } from '../../src/sync/columns.js';
import { findOwned } from '../../src/sync/sync.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/*
 * Access control for every resource endpoint (spec 用户故事 11):
 *   - no session            → 401 on every /api route except the public ones
 *   - another user's record → 404, indistinguishable from a missing id
 * No feature resource exists yet, so a fixture resource is registered exactly
 * the way feature routes will be (no explicit preHandler, `findOwned` for reads).
 */

/** Changing this list is a security decision: review it. */
const PUBLIC_API_ROUTES = ['GET /api/health', 'POST /api/auth/login', 'POST /api/auth/logout'];

const notes = pgTable('acl_fixture_notes', { ...syncColumns(), title: text().notNull() }, (t) => [
  syncIndex('acl_fixture_notes', t),
]);

function fixtureRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/api/fixture-notes/:id', async (request, reply) => {
    const note = await findOwned(app.db, notes, sessionUser(request).id, request.params.id);
    if (!note) return sendError(reply, 404, 'not_found', '资源不存在');
    return { id: note.id, title: note.title };
  });
  app.patch<{ Params: { id: string }; Body: { title: string } }>('/api/fixture-notes/:id', async (request, reply) => {
    const updated = await app.sync.transaction(sessionUser(request).id, (ops) =>
      ops.update(notes, request.params.id, { title: request.body.title }),
    );
    if (!updated) return sendError(reply, 404, 'not_found', '资源不存在');
    return { id: updated.id, title: updated.title };
  });
}

describe('access control', () => {
  let t: TestApp;
  let alice: TestUser;
  let bob: TestUser;
  let routes: readonly ApiRoute[] = [];

  beforeAll(async () => {
    t = await createTestApp({
      prepare: async ({ db }) => {
        await db.execute(sql`
          CREATE TABLE acl_fixture_notes (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at timestamptz NOT NULL,
            updated_at timestamptz NOT NULL,
            revision bigint NOT NULL,
            deleted_at timestamptz,
            title text NOT NULL
          )`);
      },
      routes: fixtureRoutes,
    });
    routes = t.app.apiRoutes;
    alice = await t.createUser('alice');
    bob = await t.createUser('bob');
  });
  afterAll(() => t.close());

  it('has no registration endpoint', async () => {
    expect(routes.map((r) => r.url).filter((u) => /regist|signup|sign-up/i.test(u))).toEqual([]);
    for (const url of ['/api/auth/register', '/api/auth/signup', '/api/register', '/api/users']) {
      const res = await t.app.inject({ method: 'POST', url, payload: { username: 'mallory', password: 'mallory-pass' } });
      expect(res.statusCode, url).toBe(404);
    }
    expect(await t.app.accounts.findByUsername('mallory')).toBeNull();
  });

  it('answers 401 on every non-public /api route without a valid session', async () => {
    // Sanity: the fixture routes were captured alongside the built-in ones.
    expect(routes.map((r) => `${r.method} ${r.url}`)).toEqual(
      expect.arrayContaining(['GET /api/changes', 'GET /api/auth/me', 'POST /api/auth/password', 'GET /api/fixture-notes/:id']),
    );
    expect(routes.filter((r) => r.public).map((r) => `${r.method} ${r.url}`).sort()).toEqual([...PUBLIC_API_ROUTES].sort());
    const protectedRoutes = routes.filter((r) => !r.public);
    expect(protectedRoutes.length).toBeGreaterThanOrEqual(5);

    for (const { method, url } of protectedRoutes) {
      const concrete = url.replace(/:[^/]+/g, randomUUID());
      for (const headers of [{}, { cookie: 'dida_session=forged' }]) {
        const res = await t.app.inject({ method: method as 'GET', url: concrete, headers, payload: method === 'GET' ? undefined : {} });
        expect(res.statusCode, `${method} ${url} ${JSON.stringify(headers)}`).toBe(401);
        expect(res.json()).toEqual({ error: { code: 'unauthorized', message: '未登录或会话已过期' } });
      }
    }
  });

  it("answers 404 for another user's resource, exactly like a missing one", async () => {
    const bobNote = await t.app.sync.transaction(bob.id, (ops) => ops.insert(notes, { title: "bob's secret" }));

    const own = await t.app.inject({ method: 'GET', url: `/api/fixture-notes/${bobNote.id}`, headers: bob.headers });
    expect(own.statusCode).toBe(200);
    expect(own.json().title).toBe("bob's secret");

    const foreign = await t.app.inject({ method: 'GET', url: `/api/fixture-notes/${bobNote.id}`, headers: alice.headers });
    const missing = await t.app.inject({ method: 'GET', url: `/api/fixture-notes/${randomUUID()}`, headers: alice.headers });
    const malformed = await t.app.inject({ method: 'GET', url: '/api/fixture-notes/not-a-uuid', headers: alice.headers });
    for (const res of [foreign, missing, malformed]) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: { code: 'not_found', message: '资源不存在' } });
    }

    const write = await t.app.inject({
      method: 'PATCH',
      url: `/api/fixture-notes/${bobNote.id}`,
      headers: alice.headers,
      payload: { title: 'hacked' },
    });
    expect(write.statusCode).toBe(404);
    const after = await t.app.inject({ method: 'GET', url: `/api/fixture-notes/${bobNote.id}`, headers: bob.headers });
    expect(after.json().title).toBe("bob's secret");
  });
});
