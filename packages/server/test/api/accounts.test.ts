import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/admin-cli.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

/** CLI io double: answers password prompts from a queue, records output. */
function fakeIo(passwords: string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const prompts: string[] = [];
  const io: CliIo = {
    async readPassword(prompt) {
      prompts.push(prompt);
      return passwords.shift() ?? '';
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return { io, out, err, prompts };
}

describe('first administrator from .env', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it('does nothing when .env has no initial admin', async () => {
    expect(await t.app.accounts.bootstrapAdmin({ username: 'admin', password: undefined })).toBe('not_configured');
    expect(await t.app.accounts.list()).toEqual([]);
  });

  it('creates the admin on first start only, never twice and never overwriting the password', async () => {
    const initial = { username: 'admin', password: 'initial-admin-pw' };
    // Two app instances starting at the same time still create exactly one admin.
    const results = await Promise.all([t.app.accounts.bootstrapAdmin(initial), t.app.accounts.bootstrapAdmin(initial)]);
    expect(results.sort()).toEqual(['created', 'users_exist']);

    const accounts = await t.app.accounts.list();
    expect(accounts).toEqual([expect.objectContaining({ username: 'admin', isAdmin: true, disabled: false })]);
    expect((await t.login('admin', 'initial-admin-pw')).statusCode).toBe(200);

    // Restart with a changed .env password: the existing admin keeps the real password.
    expect(await t.app.accounts.bootstrapAdmin({ username: 'admin', password: 'changed-in-env' })).toBe('users_exist');
    expect(await t.app.accounts.list()).toHaveLength(1);
    expect((await t.login('admin', 'changed-in-env')).statusCode).toBe(401);
    expect((await t.login('admin', 'initial-admin-pw')).statusCode).toBe(200);
  });
});

describe('admin CLI', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  const run = (argv: string[], passwords?: string[]) => {
    const f = fakeIo(passwords);
    return runCli(argv, t.app.accounts, f.io).then((code) => ({ code, ...f }));
  };

  it('create-user creates a user or an admin with a prompted password', async () => {
    const admin = await run(['create-user', 'root', '--admin'], ['root-password']);
    expect(admin).toMatchObject({ code: 0, out: ['已创建管理员 root'] });
    const user = await run(['create-user', 'gus'], ['gus-password']);
    expect(user).toMatchObject({ code: 0, out: ['已创建用户 gus'] });

    const login = await t.login('root', 'root-password');
    expect(login.statusCode).toBe(200);
    expect(login.body).toMatchObject({ user: { username: 'root', isAdmin: true } });
  });

  it('create-user refuses duplicates and weak passwords', async () => {
    expect(await run(['create-user', 'gus'], ['another-password'])).toMatchObject({ code: 1, err: ['错误：账号已存在：gus'] });
    expect(await run(['create-user', 'hal'], ['short'])).toMatchObject({ code: 1, err: ['错误：密码至少 8 位'] });
    expect(await t.app.accounts.findByUsername('hal')).toBeNull();
  });

  it('reset-password sets a new password and logs the user out everywhere', async () => {
    const ivy = await t.createUser('ivy');
    const res = await run(['reset-password', 'ivy'], ['ivy-reset-password']);
    expect(res).toMatchObject({ code: 0, out: ['已重置 ivy 的密码，该用户的所有会话已失效'] });

    expect((await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: ivy.headers })).statusCode).toBe(401);
    expect((await t.login('ivy', ivy.password)).statusCode).toBe(401);
    expect((await t.login('ivy', 'ivy-reset-password')).statusCode).toBe(200);
  });

  it('reset-password of an unknown user fails before asking for a password', async () => {
    const res = await run(['reset-password', 'ghost'], ['whatever-pass']);
    expect(res).toMatchObject({ code: 1, err: ['错误：用户不存在：ghost'], prompts: [] });
  });

  it('disable-user blocks login and kills sessions; enable-user lifts it', async () => {
    const jo = await t.createUser('jo');
    expect((await run(['disable-user', 'jo'])).code).toBe(0);
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: jo.headers })).statusCode).toBe(401);
    expect((await t.login('jo', jo.password)).statusCode).toBe(403);

    const listed = await run(['list-users']);
    expect(listed.out.find((l) => l.startsWith('jo\t'))).toContain('已停用');

    expect((await run(['enable-user', 'jo'])).code).toBe(0);
    expect((await t.login('jo', jo.password)).statusCode).toBe(200);
  });

  it('prints usage with exit code 2 on bad invocations', async () => {
    for (const argv of [[], ['frobnicate'], ['reset-password'], ['create-user', 'a', 'b'], ['create-user', 'kim', '--root']]) {
      const res = await run(argv);
      expect(res.code, argv.join(' ')).toBe(2);
      expect([...res.out, ...res.err].join('\n')).toContain('用法: dida');
    }
    expect(await t.app.accounts.findByUsername('kim')).toBeNull();
  });
});
