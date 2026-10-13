import { randomUUID } from 'node:crypto';
import { filterSchema, filtersResponseSchema, listSchema, searchResponseSchema, taskSchema, tasksResponseSchema } from '@dida/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/*
 * Review edge cases for EURO-13 (过滤器, 全局搜索, 智能清单): input limits,
 * duplicate / concurrent submits, cross-user ids and unauthenticated access.
 */

describe('过滤器 / 搜索 / 智能清单 edge cases', () => {
  let t: TestApp;
  let alice: TestUser;
  let bob: TestUser;

  beforeAll(async () => {
    t = await createTestApp({ clock: fixedClock('2026-10-13T02:00:00.000Z') });
    alice = await t.createUser('edge-alice');
    bob = await t.createUser('edge-bob');
  });
  afterAll(() => t.close());

  const api = (user: TestUser | null, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    t.app.inject({ method, url, headers: user?.headers ?? {}, ...(payload ? { payload } : {}) });

  async function createFilter(user: TestUser, payload: object) {
    const res = await api(user, 'POST', '/api/filters', payload);
    expect(res.statusCode, res.body).toBe(201);
    return filterSchema.parse(res.json());
  }
  const filterNames = async (user: TestUser) =>
    filtersResponseSchema.parse((await api(user, 'GET', '/api/filters')).json()).filters.map((f) => f.name);

  it('requires a session for every new endpoint', async () => {
    for (const url of ['/api/filters', '/api/search?q=a', '/api/smart-lists', '/api/tasks?smart=today', `/api/tasks?filterId=${randomUUID()}`]) {
      expect((await api(null, 'GET', url)).statusCode, url).toBe(401);
    }
    expect((await api(null, 'POST', '/api/filters', { name: 'x', rules: {} })).statusCode).toBe(401);
  });

  it('validates filter names: empty, blank, over 64 characters', async () => {
    for (const name of ['', '   ', 'x'.repeat(65)]) {
      expect((await api(alice, 'POST', '/api/filters', { name, rules: {} })).statusCode, JSON.stringify(name)).toBe(400);
    }
    const trimmed = await createFilter(alice, { name: `  ${'名'.repeat(64)}  `, rules: {} });
    expect(trimmed.name).toBe('名'.repeat(64));
  });

  it('rejects malformed rules and query strings', async () => {
    const bad = [
      { listIds: ['not-a-uuid'] },
      { dates: ['yesterday'] },
      { priorities: ['urgent'] },
      { untagged: 'yes' },
      { listIds: Array.from({ length: 201 }, () => randomUUID()) },
    ];
    for (const rules of bad) {
      expect((await api(alice, 'POST', '/api/filters', { name: 'bad', rules })).statusCode, JSON.stringify(rules).slice(0, 60)).toBe(400);
    }
    expect((await api(alice, 'GET', '/api/tasks?filterId=not-a-uuid')).statusCode).toBe(400);
    expect((await api(alice, 'GET', '/api/tasks?smart=trash')).statusCode).toBe(400);
    expect((await api(alice, 'GET', `/api/tasks?smart=today&filterId=${randomUUID()}`)).statusCode).toBe(400);
  });

  it('a client id reused (same user twice, or another user) is 409 and never overwrites', async () => {
    const id = randomUUID();
    await createFilter(alice, { id, name: '原来的', rules: {} });
    const again = await api(alice, 'POST', '/api/filters', { id, name: '重复提交', rules: {} });
    expect(again.statusCode).toBe(409);
    const stolen = await api(bob, 'POST', '/api/filters', { id, name: '别人的', rules: {} });
    expect(stolen.statusCode).toBe(409);
    expect(await filterNames(alice)).toContain('原来的');
    expect(await filterNames(alice)).not.toContain('重复提交');
    expect(await filterNames(bob)).toEqual([]);
  });

  it('concurrent creates all land', async () => {
    const user = await t.createUser('edge-concurrent');
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => api(user, 'POST', '/api/filters', { name: `并发 ${i}`, rules: {} })),
    );
    expect(results.map((r) => r.statusCode)).toEqual([201, 201, 201, 201, 201]);
    const list = filtersResponseSchema.parse((await api(user, 'GET', '/api/filters')).json()).filters;
    expect(list).toHaveLength(5);
    expect(new Set(list.map((f) => f.id)).size).toBe(5);
    // Note: sort keys can collide under concurrency (same pattern as 清单); order still falls back to id.
  });

  it('another user’s filter is 404 for view, edit and delete; a deleted one is 404 too', async () => {
    const filter = await createFilter(alice, { name: '私有', rules: {} });
    expect((await api(bob, 'GET', `/api/tasks?filterId=${filter.id}`)).statusCode).toBe(404);
    expect((await api(bob, 'PATCH', `/api/filters/${filter.id}`, { name: '改掉' })).statusCode).toBe(404);
    expect((await api(bob, 'DELETE', `/api/filters/${filter.id}`)).statusCode).toBe(404);
    expect(await filterNames(alice)).toContain('私有');

    expect((await api(alice, 'DELETE', `/api/filters/${filter.id}`)).statusCode).toBe(204);
    expect((await api(alice, 'DELETE', `/api/filters/${filter.id}`)).statusCode).toBe(404);
    expect((await api(alice, 'PATCH', `/api/filters/${filter.id}`, { name: '复活' })).statusCode).toBe(404);
    expect((await api(alice, 'GET', `/api/tasks?filterId=${filter.id}`)).statusCode).toBe(404);
  });

  it('a filter naming a 清单 that is later deleted still opens', async () => {
    const user = await t.createUser('edge-deleted-list');
    const list = listSchema.parse((await api(user, 'POST', '/api/lists', { name: '临时' })).json());
    const task = taskSchema.parse((await api(user, 'POST', '/api/tasks', { title: '临时任务', listId: list.id })).json());
    const filter = await createFilter(user, { name: '临时清单', rules: { listIds: [list.id] } });
    expect((await api(user, 'DELETE', `/api/lists/${list.id}`)).statusCode).toBe(204);
    const res = await api(user, 'GET', `/api/tasks?filterId=${filter.id}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(tasksResponseSchema.parse(res.json()).tasks.map((x) => x.id)).not.toContain(task.id);
    expect((await api(user, 'PATCH', `/api/filters/${filter.id}`, { name: '改名' })).statusCode).toBe(200);
  });

  it('search: blank, 100 vs 101 characters, unknown params, regex/SQL-looking input', async () => {
    expect((await api(alice, 'GET', '/api/search?q=%20%20%20')).statusCode).toBe(400);
    expect((await api(alice, 'GET', '/api/search')).statusCode).toBe(400);
    expect((await api(alice, 'GET', `/api/search?q=${encodeURIComponent('杭'.repeat(100))}`)).statusCode).toBe(200);
    expect((await api(alice, 'GET', `/api/search?q=${encodeURIComponent('杭'.repeat(101))}`)).statusCode).toBe(400);
    expect((await api(alice, 'GET', '/api/search?q=a&limit=5')).statusCode).toBe(400);

    await api(alice, 'POST', '/api/tasks', { title: "it's (a) [test] .* \\ 路径" });
    for (const q of ["'; DROP TABLE tasks; --", '.*', '\\', "it's", '[test]']) {
      const res = await api(alice, 'GET', `/api/search?q=${encodeURIComponent(q)}`);
      expect(res.statusCode, q).toBe(200);
      const titles = searchResponseSchema.parse(res.json()).tasks.map((x) => x.title);
      if (q === "'; DROP TABLE tasks; --") expect(titles).toEqual([]);
      else expect(titles, q).toContain("it's (a) [test] .* \\ 路径");
    }
    expect((await api(alice, 'GET', '/api/tasks?smart=today')).statusCode).toBe(200);
  });

  it('settings: unknown smart list ids and bad view keys are rejected', async () => {
    expect((await api(alice, 'PATCH', '/api/settings', { hiddenSmartLists: ['trash'] })).statusCode).toBe(400);
    expect((await api(alice, 'PATCH', '/api/settings', { viewOptions: { 'list:nope': { sortBy: 'title', groupBy: 'none' } } })).statusCode).toBe(400);
    expect((await api(alice, 'PATCH', '/api/settings', { viewOptions: { inbox: { sortBy: 'random', groupBy: 'none' } } })).statusCode).toBe(400);
  });
});
