import { changesResponseSchema, taskSchema, trashResponseSchema, type Task } from '@dida/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sessionUser } from '../../src/auth.js';
import { fixedClock } from '../../src/clock.js';
import { smartListCandidates } from '../../src/smart-lists.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/*
 * Review edge cases for EURO-15 (放弃、回收站、清单归档): invalid ids, partial
 * batches, concurrent submissions, depth limit on 还原, moving into an
 * archived 清单, and the sync feed after 彻底删除.
 */

function smartFixture(app: FastifyInstance) {
  app.get('/api/test/smart-candidates', async (request) => {
    const rows = await smartListCandidates(app.db, sessionUser(request).id);
    return { ids: rows.map((r) => r.id) };
  });
}

describe('EURO-15 review: 回收站 and 归档 edge cases', () => {
  const clock = fixedClock('2026-10-13T02:00:00.000Z');
  let t: TestApp;
  let erin: TestUser;

  beforeAll(async () => {
    t = await createTestApp({ clock, routes: smartFixture });
    erin = await t.createUser('erin');
  });
  afterAll(() => t.close());

  function api(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) {
    return t.app.inject({ method, url, headers: erin.headers, ...(payload ? { payload } : {}) });
  }
  async function createTask(payload: object): Promise<Task> {
    const res = await api('POST', '/api/tasks', payload);
    expect(res.statusCode, res.body).toBe(201);
    return taskSchema.parse(res.json());
  }
  async function newList(name: string): Promise<string> {
    const res = await api('POST', '/api/lists', { name });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  }
  async function trashIds() {
    return trashResponseSchema.parse((await api('GET', '/api/trash')).json()).tasks.map((x) => x.id);
  }
  async function smartIds(): Promise<string[]> {
    return (await api('GET', '/api/test/smart-candidates')).json().ids as string[];
  }

  it('requires a session for every 回收站 route', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    for (const [method, url] of [
      ['GET', '/api/trash'],
      ['POST', `/api/trash/${id}/restore`],
      ['DELETE', `/api/trash/${id}`],
      ['DELETE', '/api/trash'],
      ['DELETE', `/api/tasks/${id}`],
    ] as const) {
      expect((await t.app.inject({ method, url })).statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('answers 404 (not 500) for malformed or unknown ids', async () => {
    for (const id of ['not-a-uuid', "1' OR '1'='1", '00000000-0000-4000-8000-000000000000']) {
      const enc = encodeURIComponent(id);
      expect((await api('POST', `/api/trash/${enc}/restore`)).statusCode, id).toBe(404);
      expect((await api('DELETE', `/api/trash/${enc}`)).statusCode, id).toBe(404);
      expect((await api('DELETE', `/api/tasks/${enc}`)).statusCode, id).toBe(404);
    }
    // Over-long ids stop at Fastify's maxParamLength (414), like every other :id route.
    const long = 'x'.repeat(5000);
    expect((await api('POST', `/api/trash/${long}/restore`)).statusCode).toBe(414);
    expect((await api('DELETE', `/api/tasks/${long}`)).statusCode).toBe(414);
  });

  it('rejects a non-boolean `archived` and keeps the first archivedAt when archived twice', async () => {
    const listId = await newList('两次归档');
    for (const archived of ['yes', 1, null]) {
      expect((await api('PATCH', `/api/lists/${listId}`, { archived })).statusCode, String(archived)).toBe(400);
    }
    const first = (await api('PATCH', `/api/lists/${listId}`, { archived: true })).json().archivedAt;
    clock.advance(5_000);
    const second = (await api('PATCH', `/api/lists/${listId}`, { archived: true })).json().archivedAt;
    expect(second).toBe(first);
  });

  it('only the deleted task (batch root) can be restored or purged, not a 子任务 inside its batch', async () => {
    const root = await createTask({ title: '批次根' });
    const child = await createTask({ title: '批次里的子任务', parentId: root.id });
    expect((await api('DELETE', `/api/tasks/${root.id}`)).statusCode).toBe(204);
    expect((await api('POST', `/api/trash/${child.id}/restore`)).statusCode).toBe(404);
    expect((await api('DELETE', `/api/trash/${child.id}`)).statusCode).toBe(404);
    expect(await trashIds()).toContain(root.id);
  });

  it('concurrent deletes of one task: exactly one 204, one 回收站 entry', async () => {
    const task = await createTask({ title: '并发删除' });
    const codes = await Promise.all(Array.from({ length: 5 }, () => api('DELETE', `/api/tasks/${task.id}`).then((r) => r.statusCode)));
    expect(codes.filter((c) => c === 204)).toHaveLength(1);
    expect(codes.filter((c) => c === 404)).toHaveLength(4);
    expect((await trashIds()).filter((id) => id === task.id)).toHaveLength(1);
  });

  it('concurrent restores: exactly one 200', async () => {
    const task = await createTask({ title: '并发还原' });
    await api('DELETE', `/api/tasks/${task.id}`);
    const codes = await Promise.all(Array.from({ length: 4 }, () => api('POST', `/api/trash/${task.id}/restore`).then((r) => r.statusCode)));
    expect(codes.sort()).toEqual([200, 404, 404, 404]);
    expect((await api('GET', `/api/tasks/${task.id}`)).statusCode).toBe(200);
  });

  it('concurrent restore and 彻底删除: one wins and the state is consistent', async () => {
    const task = await createTask({ title: '还原和彻底删除抢' });
    await api('DELETE', `/api/tasks/${task.id}`);
    const [restore, purge] = await Promise.all([api('POST', `/api/trash/${task.id}/restore`), api('DELETE', `/api/trash/${task.id}`)]);
    const live = (await api('GET', `/api/tasks/${task.id}`)).statusCode === 200;
    if (restore.statusCode === 200) {
      expect(purge.statusCode).toBe(404);
      expect(live).toBe(true);
    } else {
      expect(purge.statusCode).toBe(204);
      expect(live).toBe(false);
    }
    expect(await trashIds()).not.toContain(task.id);
  });

  it('deleting a 清单 puts one entry per task tree in the 回收站; 还原 brings the whole tree to the 收件箱', async () => {
    const listId = await newList('三层树');
    const a = await createTask({ title: 'A', listId });
    const b = await createTask({ title: 'B', parentId: a.id });
    const c = await createTask({ title: 'C', parentId: b.id });
    const solo = await createTask({ title: '单独的', listId });
    expect((await api('DELETE', `/api/lists/${listId}`)).statusCode).toBe(204);
    const ids = await trashIds();
    expect(ids).toEqual(expect.arrayContaining([a.id, solo.id]));
    expect(ids).not.toContain(b.id);
    expect(ids).not.toContain(c.id);
    expect((await api('POST', `/api/trash/${a.id}/restore`)).statusCode).toBe(200);
    const cBack = taskSchema.parse((await api('GET', `/api/tasks/${c.id}`)).json());
    const bBack = taskSchema.parse((await api('GET', `/api/tasks/${b.id}`)).json());
    expect(bBack.parentId).toBe(a.id);
    expect(cBack.parentId).toBe(b.id);
    expect(cBack.listId).toBe(bBack.listId);
  });

  it('还原 under a parent that got deeper becomes a top-level task instead of breaking the 5-level limit', async () => {
    const x = await createTask({ title: 'X' });
    const y = await createTask({ title: 'Y', parentId: x.id });
    const a = await createTask({ title: 'A' });
    const b = await createTask({ title: 'B', parentId: a.id });
    const c = await createTask({ title: 'C', parentId: b.id });
    const d = await createTask({ title: 'D', parentId: c.id });
    const e = await createTask({ title: 'E', parentId: d.id });
    // Delete C (batch C, D, E: height 3), then move B two levels deeper (under Y).
    expect((await api('DELETE', `/api/tasks/${c.id}`)).statusCode).toBe(204);
    const moved = await api('PATCH', `/api/tasks/${b.id}`, { parentId: y.id });
    expect(moved.statusCode, moved.body).toBe(200);
    // C under B would be at level 4, D 5, E 6 > 5.
    const res = await api('POST', `/api/trash/${c.id}/restore`);
    expect(res.statusCode, res.body).toBe(200);
    expect(taskSchema.parse(res.json()).parentId).toBeNull();
    expect(taskSchema.parse((await api('GET', `/api/tasks/${e.id}`)).json()).parentId).toBe(d.id);
  });

  it('a task moved into an archived 清单 leaves the 智能清单 scope', async () => {
    const listId = await newList('归档目标');
    await api('PATCH', `/api/lists/${listId}`, { archived: true });
    const task = await createTask({ title: '待移入' });
    expect(await smartIds()).toContain(task.id);
    expect((await api('PATCH', `/api/tasks/${task.id}`, { listId })).statusCode).toBe(200);
    expect(await smartIds()).not.toContain(task.id);
  });

  it('彻底删除 re-sends the tombstone with a newer revision, so a client synced before the purge sees it', async () => {
    const task = await createTask({ title: '同步过的墓碑' });
    await api('DELETE', `/api/tasks/${task.id}`);
    const before = changesResponseSchema.parse((await api('GET', '/api/changes')).json()).revision;
    expect((await api('DELETE', `/api/trash/${task.id}`)).statusCode).toBe(204);
    const delta = changesResponseSchema.parse((await api('GET', `/api/changes?since=${before}`)).json());
    expect(delta.entities.task?.tombstones.map((x) => x.id)).toEqual([task.id]);
    expect(delta.entities.task?.upserts ?? []).toEqual([]);
    expect(delta.revision).toBeGreaterThan(before);
  });
});
