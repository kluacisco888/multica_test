import { meResponseSchema } from '@dida/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { sessions, users } from '../../src/db/schema/index.js';
import { SESSION_TTL_MS } from '../../src/sessions.js';
import { createTestApp, sessionCookieHeader, type TestApp } from '../support/test-app.js';

const DAY = 24 * 60 * 60 * 1000;

describe('login, logout, current user', () => {
  const clock = fixedClock('2026-05-01T00:00:00.000Z');
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ clock });
    await t.app.accounts.create({ username: 'alice', password: 'alice-password' });
  });
  afterAll(() => t.close());

  const me = (headers: Record<string, string>) => t.app.inject({ method: 'GET', url: '/api/auth/me', headers });

  it('logs in with username and password and sets an httpOnly session cookie', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'alice', password: 'alice-password' },
    });
    expect(res.statusCode).toBe(200);
    expect(meResponseSchema.parse(res.json()).user).toMatchObject({ username: 'alice', isAdmin: false });

    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/^dida_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`);
    // PUBLIC_URL is http here (ssh -L), so the cookie must not be Secure.
    expect(cookie).not.toContain('Secure');

    const current = await me(sessionCookieHeader(res.headers['set-cookie']));
    expect(current.statusCode).toBe(200);
    expect(current.json().user.username).toBe('alice');
  });

  it('stores only a hash of the session token and an argon2id hash of the password', async () => {
    const res = await t.login('alice', 'alice-password');
    const token = res.headers.cookie?.split('=')[1] as string;
    const rows = await t.database.db.select().from(sessions);
    expect(rows.some((r) => r.tokenHash === token)).toBe(false);
    const [alice] = await t.database.db.select().from(users).where(eq(users.username, 'alice'));
    expect(alice?.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it.each([
    ['wrong password', 'alice', 'not-the-password'],
    ['unknown user', 'nobody', 'alice-password'],
  ])('rejects a %s with the same 401 message and no cookie', async (_case, username, password) => {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: 'invalid_credentials', message: '账号或密码错误' } });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('rejects malformed login bodies with 400', async () => {
    for (const payload of [{}, { username: 'alice' }, { username: '', password: 'x' }]) {
      const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload });
      expect(res.statusCode).toBe(400);
    }
  });

  it('logout revokes the session on the server and clears the cookie', async () => {
    const { headers } = await t.login('alice', 'alice-password');
    expect((await me(headers)).statusCode).toBe(200);

    const out = await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers['set-cookie'])).toMatch(/^dida_session=;/);

    // Replaying the old cookie no longer works.
    expect((await me(headers)).statusCode).toBe(401);
  });

  it('logout without a session is harmless', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/logout' });
    expect(res.statusCode).toBe(204);
  });

  it('keeps a used session alive (sliding 30 days) and expires an idle one', async () => {
    const { headers } = await t.login('alice', 'alice-password');
    clock.advance(20 * DAY);
    const renewed = await me(headers);
    expect(renewed.statusCode).toBe(200);
    // Renewal re-issues the cookie so the browser keeps it too.
    expect(String(renewed.headers['set-cookie'])).toMatch(/^dida_session=/);

    clock.advance(20 * DAY); // 40 days after login, 20 after last use
    expect((await me(headers)).statusCode).toBe(200);

    clock.advance(31 * DAY);
    expect((await me(headers)).statusCode).toBe(401);
  });

  it('answers garbage or forged cookies with 401', async () => {
    for (const cookie of ['dida_session=', 'dida_session=forged', 'other=1']) {
      const res = await me({ cookie });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('unauthorized');
    }
  });

  it('marks the cookie Secure when PUBLIC_URL is https', async () => {
    const https = await createTestApp({ env: { PUBLIC_URL: 'https://todo.example.com' } });
    try {
      await https.app.accounts.create({ username: 'sam', password: 'sam-password' });
      const res = await https.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'sam', password: 'sam-password' },
      });
      expect(String(res.headers['set-cookie'])).toContain('Secure');
    } finally {
      await https.close();
    }
  });
});

describe('changing my password', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  const change = (headers: Record<string, string>, payload: object) =>
    t.app.inject({ method: 'POST', url: '/api/auth/password', headers, payload });

  it('requires a session', async () => {
    const res = await change({}, { currentPassword: 'x', newPassword: 'y-long-enough' });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a wrong current password and a too-short new one', async () => {
    const bob = await t.createUser('bob');
    const wrong = await change(bob.headers, { currentPassword: 'nope', newPassword: 'brand-new-pass' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toEqual({ code: 'wrong_password', message: '当前密码不正确' });

    const short = await change(bob.headers, { currentPassword: bob.password, newPassword: 'short' });
    expect(short.statusCode).toBe(400);
    expect(short.json().error.code).toBe('invalid_request');

    expect((await t.login('bob', bob.password)).statusCode).toBe(200);
  });

  it('switches to the new password, keeps this session and logs out the others', async () => {
    const carol = await t.createUser('carol');
    const otherDevice = (await t.login('carol', carol.password)).headers;

    const res = await change(carol.headers, { currentPassword: carol.password, newPassword: 'carol-new-pass' });
    expect(res.statusCode).toBe(204);

    expect((await t.login('carol', carol.password)).statusCode).toBe(401);
    expect((await t.login('carol', 'carol-new-pass')).statusCode).toBe(200);

    const meWith = (headers: Record<string, string>) => t.app.inject({ method: 'GET', url: '/api/auth/me', headers });
    expect((await meWith(carol.headers)).statusCode).toBe(200);
    expect((await meWith(otherDevice)).statusCode).toBe(401);
  });
});

describe('disabled users', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  const me = (headers: Record<string, string>) => t.app.inject({ method: 'GET', url: '/api/auth/me', headers });

  it('cannot log in, and their existing sessions stop working at once', async () => {
    const dan = await t.createUser('dan');
    expect((await me(dan.headers)).statusCode).toBe(200);

    await t.app.accounts.setDisabled('dan', true);

    expect((await me(dan.headers)).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/api/changes', headers: dan.headers })).statusCode).toBe(401);
    const login = await t.login('dan', dan.password);
    expect(login.statusCode).toBe(403);
    expect(login.body).toEqual({ error: { code: 'account_disabled', message: '该账户已停用，请联系管理员' } });
    expect(login.headers).toEqual({});

    // Re-enabling allows a fresh login, but the revoked sessions stay dead.
    await t.app.accounts.setDisabled('dan', false);
    expect((await me(dan.headers)).statusCode).toBe(401);
    expect((await t.login('dan', dan.password)).statusCode).toBe(200);
  });

  it('stops resolving sessions even if only the disabled flag is set', async () => {
    const eve = await t.createUser('eve');
    await t.database.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, eve.id));
    expect((await me(eve.headers)).statusCode).toBe(401);
  });

  it('only reveals "disabled" to someone who knows the password', async () => {
    await t.createUser('fay');
    await t.app.accounts.setDisabled('fay', true);
    expect((await t.login('fay', 'wrong-password')).statusCode).toBe(401);
  });
});
