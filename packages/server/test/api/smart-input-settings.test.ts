import { settingsSchema } from '@dida/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/* 智能识别 settings (spec 用户故事 57–58): 总开关, 保留识别文字, 模糊时间, over HTTP against a real database. */

describe('智能识别 settings API', () => {
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

  it('defaults: on, recognised text removed, 上午 10:00 / 下午 14:00 / 晚上 20:00', async () => {
    expect((await settings(alice)).smartInput).toEqual({ enabled: true, keepText: false, morning: '10:00', afternoon: '14:00', evening: '20:00' });
  });

  it('merges a partial change, per user', async () => {
    const res = await patch(alice, { smartInput: { keepText: true, morning: '08:30' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(settingsSchema.parse(res.json()).smartInput).toEqual({ enabled: true, keepText: true, morning: '08:30', afternoon: '14:00', evening: '20:00' });

    const off = settingsSchema.parse((await patch(alice, { smartInput: { enabled: false } })).json());
    expect(off.smartInput).toEqual({ enabled: false, keepText: true, morning: '08:30', afternoon: '14:00', evening: '20:00' });
    expect((await settings(alice)).smartInput.enabled).toBe(false);

    // Bob keeps the defaults.
    expect((await settings(bob)).smartInput).toMatchObject({ enabled: true, keepText: false, morning: '10:00' });
  });

  it('rejects broken values', async () => {
    for (const smartInput of [{ morning: '25:00' }, { evening: '8点' }, { enabled: 'yes' }, { other: true }, null]) {
      expect((await patch(bob, { smartInput })).statusCode, JSON.stringify(smartInput)).toBe(400);
    }
  });
});
