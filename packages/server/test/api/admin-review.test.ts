import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/*
 * Review tests for EURO-12 (审查测试员): attempts to get around the
 * `/api/admin/` guard, and checks that 停用 / 重置密码 really end sessions.
 */

describe('admin guard cannot be bypassed', () => {
  let t: TestApp;
  let root: TestUser;
  let alice: TestUser;

  beforeAll(async () => {
    t = await createTestApp({
      // Fixture routes as a future developer might add them: inside a prefixed
      // plugin, and with their own preHandler. Both must still be admin-only.
      routes: (app) => {
        void app.register(
          async (scoped) => {
            scoped.get('/fixture-prefixed', async () => ({ secret: 'prefixed' }));
          },
          { prefix: '/api/admin' },
        );
        app.get('/api/admin/fixture-prehandler', { preHandler: [async () => {}] }, async () => ({ secret: 'prehandler' }));
        app.route({ method: ['GET', 'POST'], url: '/api/admin/fixture-multi', handler: async () => ({ secret: 'multi' }) });
      },
    });
    root = await t.createUser('root', { isAdmin: true });
    alice = await t.createUser('alice');
  });
  afterAll(() => t.close());

  it('a non-admin gets no user list through path variants or HEAD', async () => {
    const variants = [
      '/api/admin/users',
      '/api/admin/users?x=1',
      '/api/admin/users/',
      '/api//admin/users',
      '/api/admin//users',
      '/api/%61dmin/users',
      '/api/admin/%75sers',
      '/API/admin/users',
      '/api/Admin/users',
      '/api/admin/users#frag',
      '/api/./admin/users',
      '/api/x/../admin/users',
    ];
    for (const url of variants) {
      for (const method of ['GET', 'HEAD'] as const) {
        const res = await t.app.inject({ method, url, headers: alice.headers });
        expect(res.statusCode, `${method} ${url}`).not.toBe(200);
        expect(res.body, `${method} ${url}`).not.toContain('root');
      }
    }
  });

  it('method override headers do not reach a handler as a non-admin', async () => {
    for (const header of ['x-http-method-override', 'x-http-method', 'x-method-override']) {
      const res = await t.app.inject({
        method: 'POST',
        url: `/api/admin/users/${root.id}`,
        headers: { ...alice.headers, [header]: 'PATCH' },
        payload: { disabled: true },
      });
      expect(res.statusCode, header).not.toBe(200);
    }
    expect((await t.login('root', root.password)).statusCode).toBe(200);
  });

  it('routes added later under the prefix (plugin prefix, own preHandler, multi-method) are admin-only', async () => {
    const routes = [
      { method: 'GET', url: '/api/admin/fixture-prefixed' },
      { method: 'GET', url: '/api/admin/fixture-prehandler' },
      { method: 'GET', url: '/api/admin/fixture-multi' },
      { method: 'POST', url: '/api/admin/fixture-multi' },
    ] as const;
    for (const { method, url } of routes) {
      expect((await t.app.inject({ method, url })).statusCode, `anon ${method} ${url}`).toBe(401);
      const asAlice = await t.app.inject({ method, url, headers: alice.headers });
      expect(asAlice.statusCode, `alice ${method} ${url}`).toBe(403);
      expect(asAlice.body).not.toContain('secret');
      expect((await t.app.inject({ method, url, headers: root.headers })).statusCode, `root ${method} ${url}`).toBe(200);
    }
    const registered = t.app.apiRoutes.filter((r) => r.url.startsWith('/api/admin/fixture'));
    expect(registered.every((r) => r.admin && !r.public)).toBe(true);
  });

  it('a forged or garbage session cookie is 401 on admin routes', async () => {
    for (const cookie of ['dida_session=', 'dida_session=forged', `dida_session=${'a'.repeat(4096)}`, 'dida_session=%00']) {
      const res = await t.app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie } });
      expect(res.statusCode, cookie.slice(0, 30)).toBe(401);
    }
  });
});

describe('admin route registration rules', () => {
  it('refuses to build an app with a public admin route', async () => {
    await expect(
      createTestApp({
        routes: (app) => {
          app.get('/api/admin/open', { config: { public: true } }, async () => ({}));
        },
      }),
    ).rejects.toThrow(/admin routes cannot be public/);
  });
});

describe('停用 and 重置密码 really end sessions', () => {
  let t: TestApp;
  let root: TestUser;

  beforeAll(async () => {
    t = await createTestApp();
    root = await t.createUser('root', { isAdmin: true });
  });
  afterAll(() => t.close());

  const get = (url: string, headers: Record<string, string>) => t.app.inject({ method: 'GET', url, headers });

  it('a disabled 管理员 loses every session, including on /api/admin, and enabling does not revive them', async () => {
    const boss = await t.createUser('boss', { isAdmin: true });
    const bossPhone = await t.login('boss', boss.password);
    expect((await get('/api/admin/users', boss.headers)).statusCode).toBe(200);

    const off = await t.app.inject({ method: 'PATCH', url: `/api/admin/users/${boss.id}`, headers: root.headers, payload: { disabled: true } });
    expect(off.statusCode).toBe(200);
    for (const headers of [boss.headers, bossPhone.headers]) {
      expect((await get('/api/admin/users', headers)).statusCode).toBe(401);
      expect((await get('/api/lists', headers)).statusCode).toBe(401);
      const write = await t.app.inject({ method: 'POST', url: '/api/admin/users', headers, payload: { username: 'x1', password: 'xxxxxxxx1' } });
      expect(write.statusCode).toBe(401);
    }
    expect((await t.login('boss', boss.password)).statusCode).toBe(403);

    await t.app.inject({ method: 'PATCH', url: `/api/admin/users/${boss.id}`, headers: root.headers, payload: { disabled: false } });
    for (const headers of [boss.headers, bossPhone.headers]) {
      expect((await get('/api/auth/me', headers)).statusCode).toBe(401);
    }
    // The revoked rows stay revoked in the database.
    const { rows } = await t.database.pool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL', [boss.id]);
    expect(rows[0].n).toBe(0);
  });

  it('after a reset, old sessions are dead everywhere and the old password never works', async () => {
    const kim = await t.createUser('kim');
    const tablet = await t.login('kim', kim.password);
    const res = await t.app.inject({ method: 'POST', url: `/api/admin/users/${kim.id}/password`, headers: root.headers, payload: { password: 'kim-new-pass' } });
    expect(res.statusCode).toBe(204);
    for (const headers of [kim.headers, tablet.headers]) {
      expect((await get('/api/auth/me', headers)).statusCode).toBe(401);
      expect((await get('/api/lists', headers)).statusCode).toBe(401);
    }
    const { rows } = await t.database.pool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL', [kim.id]);
    expect(rows[0].n).toBe(0);
    expect((await t.login('kim', kim.password)).statusCode).toBe(401);
    expect((await t.login('kim', 'kim-new-pass')).statusCode).toBe(200);
  });

  it("an admin resetting someone else's password does not lose their own session", async () => {
    const lee = await t.createUser('lee');
    const res = await t.app.inject({ method: 'POST', url: `/api/admin/users/${lee.id}/password`, headers: root.headers, payload: { password: 'lee-new-pass' } });
    expect(res.statusCode).toBe(204);
    expect((await get('/api/auth/me', root.headers)).statusCode).toBe(200);
  });

  it('resetting the password of a disabled user does not let them log in', async () => {
    const max = await t.createUser('max');
    await t.app.inject({ method: 'PATCH', url: `/api/admin/users/${max.id}`, headers: root.headers, payload: { disabled: true } });
    const res = await t.app.inject({ method: 'POST', url: `/api/admin/users/${max.id}/password`, headers: root.headers, payload: { password: 'max-new-pass' } });
    expect(res.statusCode).toBe(204);
    expect((await t.login('max', 'max-new-pass')).statusCode).toBe(403);
  });
});

describe('admin input edge cases', () => {
  let t: TestApp;
  let root: TestUser;

  beforeAll(async () => {
    t = await createTestApp();
    root = await t.createUser('root', { isAdmin: true });
  });
  afterAll(() => t.close());

  const post = (url: string, payload: unknown, contentType = 'application/json') =>
    t.app.inject({ method: 'POST', url, headers: { ...root.headers, 'content-type': contentType }, payload: payload as string });

  it('rejects empty, oversized and malformed bodies with 4xx and creates nothing', async () => {
    const cases: [unknown, string?][] = [
      [''],
      ['not json'],
      ['[]'],
      ['null'],
      [JSON.stringify({ username: 'u'.repeat(65), password: 'long-enough' })],
      [JSON.stringify({ username: 'big', password: 'p'.repeat(100_000) })],
      ['username=x&password=yyyyyyyy', 'application/x-www-form-urlencoded'],
    ];
    for (const [payload, type] of cases) {
      const res = await post('/api/admin/users', payload, type);
      expect(res.statusCode, String(payload).slice(0, 40)).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, String(payload).slice(0, 40)).toBeLessThan(500);
    }
    const users = (await t.app.accounts.list()).map((u) => u.username);
    expect(users.filter((u) => u !== 'root')).toEqual([]);
  });

  it('concurrent creation of the same username yields exactly one user', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => post('/api/admin/users', JSON.stringify({ username: 'twin', password: 'twin-password' }))),
    );
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([201, 409, 409, 409, 409]);
  });

  it('SQL-looking usernames are stored literally', async () => {
    const name = "o'neil;drop-table-users--";
    const res = await post('/api/admin/users', JSON.stringify({ username: name, password: 'long-enough' }));
    expect(res.statusCode).toBe(201);
    expect((await t.login(name, 'long-enough')).statusCode).toBe(200);
  });
});
