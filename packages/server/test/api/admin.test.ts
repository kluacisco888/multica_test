import { randomUUID } from 'node:crypto';
import { adminUsersResponseSchema } from '@dida/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/admin-cli.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/*
 * 后台 (spec 用户故事 9、11): a 管理员 adds, disables, enables 用户 and
 * resets their password over `/api/admin/*`. Everyone else gets 403.
 */

const FORBIDDEN = { error: { code: 'forbidden', message: '需要管理员权限' } };

describe('admin console API', () => {
  let t: TestApp;
  let root: TestUser;
  let alice: TestUser;

  beforeAll(async () => {
    t = await createTestApp();
    root = await t.createUser('root', { isAdmin: true });
    alice = await t.createUser('alice');
  });
  afterAll(() => t.close());

  const as = (user: TestUser) => ({
    get: (url: string) => t.app.inject({ method: 'GET', url, headers: user.headers }),
    post: (url: string, payload: unknown) => t.app.inject({ method: 'POST', url, headers: user.headers, payload: payload as object }),
    patch: (url: string, payload: unknown) => t.app.inject({ method: 'PATCH', url, headers: user.headers, payload: payload as object }),
  });
  const me = (user: TestUser) => t.app.inject({ method: 'GET', url: '/api/auth/me', headers: user.headers });
  const idOf = async (username: string) => (await t.app.accounts.findByUsername(username))?.id as string;

  it('lists every user without credentials', async () => {
    const res = await as(root).get('/api/admin/users');
    expect(res.statusCode).toBe(200);
    const body = adminUsersResponseSchema.parse(res.json());
    expect(body.users.map((u) => [u.username, u.isAdmin, u.disabled])).toEqual([
      ['root', true, false],
      ['alice', false, false],
    ]);
    expect(res.body).not.toMatch(/password|argon2/i);
  });

  it('adds a user who can then log in, optionally as a 管理员', async () => {
    const res = await as(root).post('/api/admin/users', { username: 'bob', password: 'bob-password-1' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ username: 'bob', isAdmin: false, disabled: false });
    expect(res.json().id).toBe(await idOf('bob'));
    const login = await t.login('bob', 'bob-password-1');
    expect(login.statusCode).toBe(200);
    expect(login.body).toMatchObject({ user: { username: 'bob', isAdmin: false } });

    const admin = await as(root).post('/api/admin/users', { username: 'carol', password: 'carol-password', isAdmin: true });
    expect(admin.statusCode).toBe(201);
    expect((await t.login('carol', 'carol-password')).body).toMatchObject({ user: { isAdmin: true } });

    // The new user starts with their own empty data (收件箱 only).
    const sidebar = await t.app.inject({ method: 'GET', url: '/api/lists', headers: login.headers });
    expect(sidebar.json().lists).toEqual([expect.objectContaining({ isInbox: true })]);
  });

  it('refuses duplicate usernames and invalid input', async () => {
    const dup = await as(root).post('/api/admin/users', { username: 'Bob ', password: 'another-password' });
    // Usernames are trimmed; case is significant (same as login).
    expect(dup.statusCode).toBe(201);
    const same = await as(root).post('/api/admin/users', { username: ' bob', password: 'another-password' });
    expect(same.statusCode).toBe(409);
    expect(same.json()).toMatchObject({ error: { code: 'username_taken' } });

    for (const payload of [
      { username: 'dave', password: 'short' },
      { username: 'has space', password: 'long-enough-pw' },
      { username: '', password: 'long-enough-pw' },
      { username: 'dave', password: 'long-enough-pw', isAdmin: 'yes' },
      { username: 'dave', password: 'long-enough-pw', role: 'root' },
    ]) {
      const res = await as(root).post('/api/admin/users', payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error.code).toBe('invalid_request');
    }
    expect(await t.app.accounts.findByUsername('dave')).toBeNull();
  });

  it('disabling a user ends their sessions and blocks login; enabling lets them log in again', async () => {
    const erin = await t.createUser('erin');
    const second = await t.login('erin', erin.password);
    const id = await idOf('erin');

    const off = await as(root).patch(`/api/admin/users/${id}`, { disabled: true });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ id, username: 'erin', disabled: true });
    for (const headers of [erin.headers, second.headers]) {
      expect((await t.app.inject({ method: 'GET', url: '/api/auth/me', headers })).statusCode).toBe(401);
    }
    expect((await t.login('erin', erin.password)).statusCode).toBe(403);
    const listed = adminUsersResponseSchema.parse((await as(root).get('/api/admin/users')).json());
    expect(listed.users.find((u) => u.id === id)?.disabled).toBe(true);

    // Disabling twice is harmless.
    expect((await as(root).patch(`/api/admin/users/${id}`, { disabled: true })).statusCode).toBe(200);

    const on = await as(root).patch(`/api/admin/users/${id}`, { disabled: false });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({ disabled: false });
    // Old sessions stay dead; a fresh login works.
    expect((await me(erin)).statusCode).toBe(401);
    expect((await t.login('erin', erin.password)).statusCode).toBe(200);
  });

  it('resets a password: the user is logged out everywhere and only the new password works', async () => {
    const finn = await t.createUser('finn');
    const id = await idOf('finn');
    const res = await as(root).post(`/api/admin/users/${id}/password`, { password: 'finn-new-password' });
    expect(res.statusCode).toBe(204);
    expect((await me(finn)).statusCode).toBe(401);
    expect((await t.login('finn', finn.password)).statusCode).toBe(401);
    expect((await t.login('finn', 'finn-new-password')).statusCode).toBe(200);

    const weak = await as(root).post(`/api/admin/users/${id}/password`, { password: 'short' });
    expect(weak.statusCode).toBe(400);
    expect((await t.login('finn', 'finn-new-password')).statusCode).toBe(200);
  });

  it("resetting one's own password keeps the current session, ends the others", async () => {
    const other = await t.login('root', root.password);
    const res = await as(root).post(`/api/admin/users/${root.id}/password`, { password: 'root-new-password' });
    expect(res.statusCode).toBe(204);
    expect((await me(root)).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: other.headers })).statusCode).toBe(401);
    root.password = 'root-new-password';
  });

  it('cannot disable oneself', async () => {
    const res = await as(root).patch(`/api/admin/users/${root.id}`, { disabled: true });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: 'cannot_disable_self', message: '不能停用自己的账户' } });
    expect((await me(root)).statusCode).toBe(200);
    // Enabling oneself is a no-op, not an error.
    expect((await as(root).patch(`/api/admin/users/${root.id}`, { disabled: false })).statusCode).toBe(200);
  });

  it('answers 404 for unknown or malformed user ids, 400 for bad bodies', async () => {
    for (const id of [randomUUID(), 'not-a-uuid']) {
      const patch = await as(root).patch(`/api/admin/users/${id}`, { disabled: true });
      const reset = await as(root).post(`/api/admin/users/${id}/password`, { password: 'whatever-pass' });
      for (const res of [patch, reset]) {
        expect(res.statusCode, id).toBe(404);
        expect(res.json()).toEqual({ error: { code: 'not_found', message: '资源不存在' } });
      }
    }
    const bad = await as(root).patch(`/api/admin/users/${alice.id}`, { disabled: 'yes' });
    expect(bad.statusCode).toBe(400);
    const extra = await as(root).patch(`/api/admin/users/${alice.id}`, { disabled: true, isAdmin: true });
    expect(extra.statusCode).toBe(400);
  });

  it('answers 403 on every /api/admin route to a signed-in non-admin, and changes nothing', async () => {
    const adminRoutes = t.app.apiRoutes.filter((r) => r.url.startsWith('/api/admin/'));
    expect(adminRoutes.map((r) => `${r.method} ${r.url}`).sort()).toEqual([
      'GET /api/admin/users',
      'PATCH /api/admin/users/:id',
      'POST /api/admin/users',
      'POST /api/admin/users/:id/password',
    ]);
    expect(adminRoutes.every((r) => r.admin && !r.public)).toBe(true);

    for (const { method, url } of adminRoutes) {
      const concrete = url.replace(':id', root.id);
      const payloads = [undefined, { disabled: true }, { password: 'hijacked-password' }, { username: 'mallory', password: 'mallory-pass' }];
      for (const payload of method === 'GET' ? [undefined] : payloads) {
        const res = await t.app.inject({ method: method as 'POST', url: concrete, headers: alice.headers, payload });
        expect(res.statusCode, `${method} ${url} ${JSON.stringify(payload)}`).toBe(403);
        expect(res.json()).toEqual(FORBIDDEN);
      }
      // No session at all is still 401, not 403.
      const anonymous = await t.app.inject({ method: method as 'POST', url: concrete, payload: method === 'GET' ? undefined : {} });
      expect(anonymous.statusCode).toBe(401);
    }
    expect(await t.app.accounts.findByUsername('mallory')).toBeNull();
    expect((await me(root)).statusCode).toBe(200);
    expect((await t.login('root', root.password)).statusCode).toBe(200);
  });

  it('a 管理员 who is demoted loses access on the next request', async () => {
    const gina = await t.createUser('gina', { isAdmin: true });
    expect((await as(gina).get('/api/admin/users')).statusCode).toBe(200);
    await t.database.pool.query('UPDATE users SET is_admin = false WHERE id = $1', [gina.id]);
    expect((await as(gina).get('/api/admin/users')).statusCode).toBe(403);
  });
});

describe('the last 管理员', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  const silentIo = (): CliIo & { err: (line: string) => void; errors: string[] } => {
    const errors: string[] = [];
    return { readPassword: async () => '', out: () => {}, err: (line) => errors.push(line), errors };
  };

  it('cannot be disabled, from the CLI either', async () => {
    await t.createUser('solo', { isAdmin: true });
    const io = silentIo();
    expect(await runCli(['disable-user', 'solo'], t.app.accounts, io)).toBe(1);
    expect(io.errors).toEqual(['错误：不能停用最后一个管理员']);
    expect((await t.login('solo', 'pw-solo-12345')).statusCode).toBe(200);

    // A disabled 管理员 does not count: with one enabled admin left, it is still the last.
    await t.createUser('spare', { isAdmin: true });
    expect(await runCli(['disable-user', 'spare'], t.app.accounts, silentIo())).toBe(0);
    expect(await runCli(['disable-user', 'solo'], t.app.accounts, silentIo())).toBe(1);
    // Ordinary users can always be disabled.
    await t.createUser('plain');
    expect(await runCli(['disable-user', 'plain'], t.app.accounts, silentIo())).toBe(0);
  });

  it('survives two 管理员 disabling each other at the same time', async () => {
    const a = await t.createUser('admin-a', { isAdmin: true });
    const b = await t.createUser('admin-b', { isAdmin: true });
    // Leave exactly these two enabled admins.
    await t.database.pool.query("UPDATE users SET disabled_at = now() WHERE is_admin AND username NOT IN ('admin-a', 'admin-b')");

    const [ab, ba] = await Promise.all([
      t.app.inject({ method: 'PATCH', url: `/api/admin/users/${b.id}`, headers: a.headers, payload: { disabled: true } }),
      t.app.inject({ method: 'PATCH', url: `/api/admin/users/${a.id}`, headers: b.headers, payload: { disabled: true } }),
    ]);
    // The loser is refused either by the rule (400 last_admin) or, if the winner
    // committed before it was authenticated, because it is already disabled (401).
    const codes = [ab.statusCode, ba.statusCode].sort();
    expect(codes[0]).toBe(200);
    expect([400, 401]).toContain(codes[1]);
    const refused = [ab, ba].find((r) => r.statusCode === 400);
    if (refused) expect(refused.json()).toEqual({ error: { code: 'last_admin', message: '不能停用最后一个管理员' } });
    const enabledAdmins = (await t.app.accounts.list()).filter((u) => u.isAdmin && !u.disabled);
    expect(enabledAdmins).toHaveLength(1);
  });

  it('serializes the last-admin check (concurrent disables of the last two admins, repeated)', async () => {
    await t.createUser('admin-c', { isAdmin: true });
    await t.createUser('admin-d', { isAdmin: true });
    for (let round = 0; round < 20; round++) {
      await t.database.pool.query(
        "UPDATE users SET disabled_at = CASE WHEN username IN ('admin-c', 'admin-d') THEN NULL ELSE now() END WHERE is_admin",
      );
      const results = await Promise.allSettled([
        t.app.accounts.setDisabled('admin-c', true, { actorId: 'someone-else' }),
        t.app.accounts.setDisabled('admin-d', true, { actorId: 'someone-else' }),
      ]);
      expect(results.map((r) => r.status).sort(), `round ${round}`).toEqual(['fulfilled', 'rejected']);
      expect(results.find((r) => r.status === 'rejected')?.reason).toMatchObject({ code: 'last_admin' });
      expect((await t.app.accounts.list()).filter((u) => u.isAdmin && !u.disabled)).toHaveLength(1);
    }
  });
});
