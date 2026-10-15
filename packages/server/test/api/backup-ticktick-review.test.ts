import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../support/test-app.js';

/*
 * 审查补充 (EURO-30 review, PR #41): the text/csv parser added for 导入滴答清单备份
 * must not raise the body limit of other routes. Public routes (登录) read the
 * body before any session check, so a large limit there lets anyone make the
 * server buffer up to the backup limit per request.
 */

describe('导入滴答清单备份（审查补充）', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  const csvBody = 'a'.repeat(2 * 1024 * 1024);

  // 审查发现的缺陷（PR #41）：修复后把 it.fails 改回 it。
  it.fails('a text/csv body to the public 登录 route keeps the 1MB limit (as JSON does)', async () => {
    const json = await t.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json' }, payload: `"${csvBody}"` });
    expect(json.statusCode).toBe(413);
    const csv = await t.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'text/csv' }, payload: csvBody });
    expect(csv.statusCode).toBe(413);
  });

  it('the 滴答 import itself still accepts a file over 1MB', async () => {
    const u = await t.createUser('ttbig');
    const res = await t.app.inject({ method: 'POST', url: '/api/backup/import-ticktick', headers: { ...u.headers, 'content-type': 'text/csv' }, payload: csvBody });
    // Not a 滴答 backup, but it was read: refused by content, not by size.
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('import_failed');
  });
});
