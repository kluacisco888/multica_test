import { settingsSchema } from '@dida/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/* 智能识别 settings as 滴答 lays them out (EURO-39): 日期识别 / 标签识别 / 网址解析, the two 移除, 模糊时间; over HTTP against a real database. */

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

  const DEFAULTS = {
    dateParse: true,
    removeDate: true,
    tagParse: true,
    removeTag: true,
    urlParse: true,
    morning: '09:00',
    afternoon: '15:00',
    evening: '20:00',
  };

  it('defaults (滴答): 日期识别 / 标签识别 / 网址解析 on, recognised text removed, 上午 09:00 / 下午 15:00 / 晚上 20:00', async () => {
    expect((await settings(alice)).smartInput).toEqual(DEFAULTS);
  });

  it('merges a partial change, per user', async () => {
    const res = await patch(alice, { smartInput: { removeDate: false, morning: '08:30' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(settingsSchema.parse(res.json()).smartInput).toEqual({ ...DEFAULTS, removeDate: false, morning: '08:30' });

    const off = settingsSchema.parse((await patch(alice, { smartInput: { dateParse: false, urlParse: false } })).json());
    expect(off.smartInput).toEqual({ ...DEFAULTS, removeDate: false, morning: '08:30', dateParse: false, urlParse: false });
    expect((await settings(alice)).smartInput).toMatchObject({ dateParse: false, tagParse: true, urlParse: false });

    // Bob keeps the defaults.
    expect((await settings(bob)).smartInput).toEqual(DEFAULTS);
  });

  it('reads settings saved before EURO-39 (总开关 / 保留识别文字) as the new switches, and rewrites them on the next change', async () => {
    const carol = await t.createUser('carol');
    const dave = await t.createUser('dave');
    // Create the rows, then put the old shape back the way EURO-27 stored it.
    for (const user of [carol, dave]) expect((await patch(user, { smartInput: { morning: '08:30' } })).statusCode).toBe(200);
    const old = (user: TestUser, value: object) =>
      t.database.db.execute(sql`UPDATE user_settings SET smart_input = ${JSON.stringify(value)}::jsonb WHERE user_id = ${user.id}`);
    await old(carol, { enabled: false, keepText: false, morning: '08:30', afternoon: '14:00', evening: '20:00' });
    await old(dave, { enabled: true, keepText: true, morning: '10:00', afternoon: '14:00', evening: '20:00' });

    expect((await settings(carol)).smartInput).toEqual({
      ...DEFAULTS,
      dateParse: false,
      tagParse: false,
      urlParse: false,
      morning: '08:30',
      afternoon: '14:00',
    });
    expect((await settings(dave)).smartInput).toEqual({ ...DEFAULTS, removeDate: false, removeTag: false, morning: '10:00', afternoon: '14:00' });

    // The next change stores the new shape only.
    expect((await patch(carol, { smartInput: { tagParse: true } })).statusCode).toBe(200);
    const [row] = (await t.database.db.execute<{ smart_input: Record<string, unknown> }>(sql`SELECT smart_input FROM user_settings WHERE user_id = ${carol.id}`)).rows;
    expect(row?.smart_input).toEqual({ ...DEFAULTS, dateParse: false, tagParse: true, urlParse: false, morning: '08:30', afternoon: '14:00' });
  });

  it('rejects broken values', async () => {
    for (const smartInput of [{ morning: '25:00' }, { evening: '8点' }, { dateParse: 'yes' }, { enabled: false }, { keepText: true }, { other: true }, null]) {
      expect((await patch(bob, { smartInput })).statusCode, JSON.stringify(smartInput)).toBe(400);
    }
  });
});
