import { changesResponseSchema, settingsSchema } from '@dida/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/* 主题 (spec 用户故事 104): mode and 颜色系列 in 设置, over HTTP against a real database. */

describe('主题 settings API', () => {
  let t: TestApp;
  let alice: TestUser;
  let bob: TestUser;

  beforeAll(async () => {
    t = await createTestApp();
    alice = await t.createUser('alice');
    bob = await t.createUser('bob');
  });
  afterAll(() => t.close());

  async function settings(user: TestUser) {
    const res = await t.app.inject({ method: 'GET', url: '/api/settings', headers: user.headers });
    expect(res.statusCode).toBe(200);
    return settingsSchema.parse(res.json());
  }

  function patch(user: TestUser, payload: object) {
    return t.app.inject({ method: 'PATCH', url: '/api/settings', headers: user.headers, payload });
  }

  it('defaults to 浅色 + 晴蓝 before anything is saved', async () => {
    expect(await settings(alice)).toMatchObject({ themeMode: 'light', themeColor: 'blue' });
  });

  it('saves mode and colour separately, per user, and syncs them through /api/changes', async () => {
    const before = changesResponseSchema.parse(
      (await t.app.inject({ method: 'GET', url: '/api/changes?since=0', headers: alice.headers })).json(),
    ).revision;

    const dark = await patch(alice, { themeMode: 'dark' });
    expect(dark.statusCode).toBe(200);
    expect(settingsSchema.parse(dark.json())).toMatchObject({ themeMode: 'dark', themeColor: 'blue', timeZone: 'Asia/Shanghai' });

    const peach = settingsSchema.parse((await patch(alice, { themeColor: 'peach' })).json());
    expect(peach).toMatchObject({ themeMode: 'dark', themeColor: 'peach' });

    const system = settingsSchema.parse((await patch(alice, { themeMode: 'system', timeZone: 'Asia/Tokyo' })).json());
    expect(system).toMatchObject({ themeMode: 'system', themeColor: 'peach', timeZone: 'Asia/Tokyo' });
    expect(await settings(alice)).toMatchObject({ themeMode: 'system', themeColor: 'peach' });

    // Other users keep their own theme.
    expect(await settings(bob)).toMatchObject({ themeMode: 'light', themeColor: 'blue' });

    const changes = changesResponseSchema.parse(
      (await t.app.inject({ method: 'GET', url: `/api/changes?since=${before}`, headers: alice.headers })).json(),
    );
    expect(changes.entities.settings?.upserts).toEqual([expect.objectContaining({ themeMode: 'system', themeColor: 'peach' })]);
  });

  it('rejects unknown modes and colours', async () => {
    for (const payload of [{ themeMode: 'sepia' }, { themeColor: 'red' }, { themeColor: '' }, { themeMode: null }]) {
      expect((await patch(bob, payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(await settings(bob)).toMatchObject({ themeMode: 'light', themeColor: 'blue' });
  });

  it('requires a session', async () => {
    expect((await t.app.inject({ method: 'PATCH', url: '/api/settings', payload: { themeMode: 'dark' } })).statusCode).toBe(401);
  });
});
