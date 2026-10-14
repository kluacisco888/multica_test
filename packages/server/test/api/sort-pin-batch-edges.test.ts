import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  BATCH_MAX_TASKS,
  changesResponseSchema,
  moveTaskResponseSchema,
  SORT_KEY_REBALANCE_LENGTH,
  TASK_MAX_TAGS,
  taskSchema,
  tasksResponseSchema,
  type Task,
} from '@dida/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { rollbackLastMigration, runMigrations } from '../../src/db/migrations.js';
import { createTestDatabase } from '../support/database.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/* Review edge cases for 拖拽排序、置顶与批量操作 (EURO-22). */

describe('拖拽排序、置顶与批量操作: edge cases', () => {
  const clock = fixedClock('2026-10-13T02:00:00.000Z');
  let t: TestApp;
  let alice: TestUser;
  let bob: TestUser;

  beforeAll(async () => {
    t = await createTestApp({ clock });
    alice = await t.createUser('alice');
    bob = await t.createUser('bob');
  });
  afterAll(() => t.close());

  function api(user: TestUser | null, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) {
    return t.app.inject({ method, url, headers: user?.headers ?? {}, ...(payload ? { payload } : {}) });
  }

  async function newList(user: TestUser, name: string): Promise<string> {
    const res = await api(user, 'POST', '/api/lists', { name });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id;
  }

  async function createTask(user: TestUser, payload: object): Promise<Task> {
    const res = await api(user, 'POST', '/api/tasks', payload);
    expect(res.statusCode, res.body).toBe(201);
    return taskSchema.parse(res.json());
  }

  async function getTask(user: TestUser, id: string): Promise<Task> {
    const res = await api(user, 'GET', `/api/tasks/${id}`);
    expect(res.statusCode, res.body).toBe(200);
    return taskSchema.parse(res.json());
  }

  async function tasksOf(user: TestUser, listId: string): Promise<Task[]> {
    return tasksResponseSchema.parse((await api(user, 'GET', `/api/tasks?listId=${listId}`)).json()).tasks;
  }

  async function revisionNow(user: TestUser): Promise<number> {
    return changesResponseSchema.parse((await api(user, 'GET', '/api/changes')).json()).revision;
  }

  async function changedTaskIds(user: TestUser, since: number): Promise<string[]> {
    const changes = changesResponseSchema.parse((await api(user, 'GET', `/api/changes?since=${since}`)).json());
    return (changes.entities.task?.upserts ?? []).map((x) => x.id);
  }

  it('re-keying gives every re-keyed task a new revision and puts it in /api/changes', async () => {
    const listId = await newList(alice, '均分修订号');
    const anchor = await createTask(alice, { listId, title: 'anchor' });
    const x = await createTask(alice, { listId, title: 'x' });
    const y = await createTask(alice, { listId, title: 'y' });
    const others = [];
    for (let i = 0; i < 5; i++) others.push(await createTask(alice, { listId, title: `o${i}` }));
    // Order now: o4 o3 o2 o1 o0 y x anchor. Put anchor first.
    await moveTaskOk(anchor.id, null);
    let order = [anchor.id, ...others.map((o) => o.id).reverse(), y.id, x.id];
    let rebalanced: Task[] | null = null;
    let since = 0;
    for (let i = 0; i < 200 && !rebalanced; i++) {
      // Always drop the second task right after the first: grows the key between them.
      const second = order[1]!;
      const third = order[2]!;
      since = await revisionNow(alice);
      const before = new Map((await tasksOf(alice, listId)).map((r) => [r.id, r.revision]));
      const changed = await moveTaskOk(third, anchor.id);
      order = [anchor.id, third, second, ...order.slice(3)];
      if (changed.length > 1) {
        rebalanced = changed;
        // The whole group (other than the moved task) is in the response, each with a higher revision.
        expect(new Set(changed.map((r) => r.id))).toEqual(new Set(order));
        for (const r of changed) expect(r.revision, r.title).toBeGreaterThan(before.get(r.id)!);
      }
    }
    expect(rebalanced, 'a re-key happened').not.toBeNull();
    // /api/changes since just before the drop lists every re-keyed task with the new key.
    expect(new Set(await changedTaskIds(alice, since))).toEqual(new Set(order));
    const after = await tasksOf(alice, listId);
    expect(after.filter((r) => r.parentId === null).map((r) => r.id)).toEqual(order);
    for (const r of after) expect(r.sortOrder.length).toBeLessThanOrEqual(SORT_KEY_REBALANCE_LENGTH);
    // Revisions are unique per user (monotonic), so a client can't miss one.
    const revisions = rebalanced!.map((r) => r.revision);
    expect(new Set(revisions).size).toBe(revisions.length);
  });

  async function moveTaskOk(id: string, afterId: string | null): Promise<Task[]> {
    const res = await api(alice, 'POST', `/api/tasks/${id}/move`, { afterId });
    expect(res.statusCode, res.body).toBe(200);
    return moveTaskResponseSchema.parse(res.json()).tasks;
  }

  it('a batch failing on a later task rolls back the earlier ones (no revisions, no changes)', async () => {
    const listId = await newList(alice, '中途失败');
    const root = await createTask(alice, { listId, title: 'root' });
    const parent = await createTask(alice, { listId, title: 'parent' });
    const child = await createTask(alice, { parentId: parent.id, title: 'child' });
    const since = await revisionNow(alice);
    // root pins fine, child (a 子任务) fails with invalid_pin.
    const res = await api(alice, 'POST', '/api/tasks/batch', { ids: [root.id, child.id], action: { op: 'pin', pinned: true } });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('invalid_pin');
    const after = await getTask(alice, root.id);
    expect(after.pinOrder).toBeNull();
    expect(after.revision).toBe(root.revision);
    expect(await changedTaskIds(alice, since)).toEqual([]);
    expect(await revisionNow(alice)).toBe(since);
  });

  it('too many 标签 on one task of the batch rejects the whole batch', async () => {
    const listId = await newList(alice, '标签上限');
    const tagIds: string[] = [];
    for (let i = 0; i < TASK_MAX_TAGS; i++) {
      const res = await api(alice, 'POST', '/api/tags', { name: `上限${i}` });
      expect(res.statusCode, res.body).toBe(201);
      tagIds.push(res.json().id);
    }
    const extra = (await api(alice, 'POST', '/api/tags', { name: '上限额外' })).json().id as string;
    const free = await createTask(alice, { listId, title: 'free' });
    const full = await createTask(alice, { listId, title: 'full', tagIds });
    const res = await api(alice, 'POST', '/api/tasks/batch', { ids: [free.id, full.id], action: { op: 'tags', add: [extra] } });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('too_many_tags');
    expect((await getTask(alice, free.id)).tagIds).toEqual([]);
  });

  it("cannot reach another user's 清单, 标签 or tasks through a batch or a move", async () => {
    const listId = await newList(alice, '跨用户');
    const a = await createTask(alice, { listId, title: 'a' });
    const bobList = await newList(bob, 'bob 的清单');
    const bobTagRes = await api(bob, 'POST', '/api/tags', { name: 'bob标签' });
    expect(bobTagRes.statusCode, bobTagRes.body).toBe(201);
    const bobTag = bobTagRes.json().id as string;
    const bobTask = await createTask(bob, { listId: bobList, title: 'bob' });

    const move = await api(alice, 'POST', '/api/tasks/batch', { ids: [a.id], action: { op: 'move', listId: bobList } });
    expect(move.statusCode).toBe(400);
    expect(move.json().error.code).toBe('invalid_list');
    const tag = await api(alice, 'POST', '/api/tasks/batch', { ids: [a.id], action: { op: 'tags', add: [bobTag] } });
    expect(tag.statusCode).toBe(400);
    expect(tag.json().error.code).toBe('invalid_tags');
    expect((await api(alice, 'POST', `/api/tasks/${bobTask.id}/move`, { afterId: null })).statusCode).toBe(404);
    expect((await api(alice, 'POST', '/api/tasks/batch', { ids: [bobTask.id], action: { op: 'pin', pinned: true } })).statusCode).toBe(404);

    expect(await getTask(alice, a.id)).toMatchObject({ listId, tagIds: [], revision: a.revision });
    expect(await getTask(bob, bobTask.id)).toMatchObject({ pinOrder: null, revision: bobTask.revision });
    // Bob's pinned group is his own: alice pinning does not show up or shift his keys.
    await api(bob, 'PATCH', `/api/tasks/${bobTask.id}`, { pinned: true });
    const bobPinned = await getTask(bob, bobTask.id);
    expect((await api(alice, 'POST', '/api/tasks/batch', { ids: [a.id], action: { op: 'pin', pinned: true } })).statusCode).toBe(200);
    expect((await getTask(bob, bobTask.id)).revision).toBe(bobPinned.revision);
  });

  it('accepts duplicate and upper-case ids once; rejects more than BATCH_MAX_TASKS', async () => {
    const listId = await newList(alice, 'ids 形式');
    const a = await createTask(alice, { listId, title: 'a' });
    const res = await api(alice, 'POST', '/api/tasks/batch', { ids: [a.id, a.id.toUpperCase(), a.id], action: { op: 'priority', priority: 'high' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().tasks).toHaveLength(1);
    const after = await getTask(alice, a.id);
    expect(after.priority).toBe('high');
    expect(after.revision).toBeGreaterThan(a.revision);

    const tooMany = Array.from({ length: BATCH_MAX_TASKS + 1 }, () => randomUUID());
    expect((await api(alice, 'POST', '/api/tasks/batch', { ids: tooMany, action: { op: 'complete' } })).statusCode).toBe(400);
    // Unknown fields and a missing action are rejected too.
    expect((await api(alice, 'POST', '/api/tasks/batch', { ids: [a.id] })).statusCode).toBe(400);
    expect((await api(alice, 'POST', '/api/tasks/batch', { ids: [a.id], action: { op: 'complete' }, extra: 1 })).statusCode).toBe(400);
    expect((await api(alice, 'POST', '/api/tasks/batch', { ids: [a.id], action: { op: 'priority', priority: 'high', title: 'x' } })).statusCode).toBe(400);
  });

  it('concurrent drops in one group never produce duplicate or unordered keys', async () => {
    const listId = await newList(alice, '并发拖动');
    const rows: Task[] = [];
    for (let i = 0; i < 6; i++) rows.push(await createTask(alice, { listId, title: `t${i}` }));
    const first = rows[5]!; // newest is on top
    // Everyone drops right after the first task at the same time.
    const results = await Promise.all(rows.slice(0, 5).map((r) => api(alice, 'POST', `/api/tasks/${r.id}/move`, { afterId: first.id })));
    for (const r of results) expect(r.statusCode, r.body).toBe(200);
    const keys = (await tasksOf(alice, listId)).map((r) => r.sortOrder);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('a batch with ids from several 清单 and a 子任务 + its parent completes each once', async () => {
    const l1 = await newList(alice, '多清单 1');
    const l2 = await newList(alice, '多清单 2');
    const p = await createTask(alice, { listId: l1, title: 'p' });
    const c = await createTask(alice, { parentId: p.id, title: 'c' });
    const q = await createTask(alice, { listId: l2, title: 'q' });
    const res = await api(alice, 'POST', '/api/tasks/batch', { ids: [c.id, p.id, q.id], action: { op: 'complete' } });
    expect(res.statusCode, res.body).toBe(200);
    for (const id of [p.id, c.id, q.id]) expect((await getTask(alice, id)).status).toBe('completed');
  });
});

describe('migration 0015_pinned_tasks', () => {
  it('rolls back (drops pin_order) and migrates up again', async () => {
    const database = await createTestDatabase();
    try {
      const hasColumn = async () =>
        (
          await database.db.execute<{ n: number }>(
            sql`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = 'pin_order'`,
          )
        ).rows[0]!.n === 1;
      await runMigrations(database.db);
      expect(await hasColumn()).toBe(true);
      // Later migrations come off first (0016_matrix_quadrants, EURO-23).
      expect(await rollbackLastMigration(database.pool)).toBe('0016_matrix_quadrants');
      expect(await hasColumn()).toBe(true);
      expect(await rollbackLastMigration(database.pool)).toBe('0015_pinned_tasks');
      expect(await hasColumn()).toBe(false);
      await runMigrations(database.db);
      expect(await hasColumn()).toBe(true);
    } finally {
      await database.destroy();
    }
  });
});
