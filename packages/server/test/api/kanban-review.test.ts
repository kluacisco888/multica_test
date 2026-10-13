import { randomUUID } from 'node:crypto';
import {
  kanbanColumnSchema,
  kanbanColumnsResponseSchema,
  listSchema,
  MAX_KANBAN_COLUMNS,
  taskSchema,
  tasksResponseSchema,
  type KanbanColumn,
  type Task,
} from '@dida/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/*
 * EURO-18 review: edge cases of 看板分栏 not covered by kanban.test.ts —
 * input limits, client-generated ids (ADR-0004), concurrent submissions,
 * cross-user references and where a 回收站 restore lands.
 */

describe('看板分栏 API — review edge cases', () => {
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

  function api(user: TestUser, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) {
    return t.app.inject({ method, url, headers: user.headers, ...(payload ? { payload } : {}) });
  }

  async function createList(user: TestUser, name: string) {
    const res = await api(user, 'POST', '/api/lists', { name });
    expect(res.statusCode, res.body).toBe(201);
    return listSchema.parse(res.json());
  }

  async function createColumn(user: TestUser, listId: string, name: string, extra: object = {}): Promise<KanbanColumn> {
    const res = await api(user, 'POST', '/api/kanban-columns', { listId, name, ...extra });
    expect(res.statusCode, res.body).toBe(201);
    return kanbanColumnSchema.parse(res.json());
  }

  async function createTask(user: TestUser, payload: object): Promise<Task> {
    const res = await api(user, 'POST', '/api/tasks', payload);
    expect(res.statusCode, res.body).toBe(201);
    return taskSchema.parse(res.json());
  }

  async function columnsOf(user: TestUser, listId: string) {
    return kanbanColumnsResponseSchema.parse((await api(user, 'GET', `/api/kanban-columns?listId=${listId}`)).json()).columns;
  }

  async function tasksOf(user: TestUser, listId: string) {
    return tasksResponseSchema.parse((await api(user, 'GET', `/api/tasks?listId=${listId}`)).json()).tasks;
  }

  it('limits the name to 64 characters and rejects unknown fields and a bad sortOrder', async () => {
    const list = await createList(alice, '长度');
    expect((await api(alice, 'POST', '/api/kanban-columns', { listId: list.id, name: 'x'.repeat(65) })).statusCode).toBe(400);
    expect((await createColumn(alice, list.id, 'y'.repeat(64))).name).toHaveLength(64);
    expect((await api(alice, 'POST', '/api/kanban-columns', { listId: 'not-a-uuid', name: 'x' })).statusCode).toBe(400);
    expect((await api(alice, 'POST', '/api/kanban-columns', {})).statusCode).toBe(400);
    const column = await createColumn(alice, list.id, 'z');
    // A 分栏 cannot be moved to another 清单 by PATCH.
    const other = await createList(alice, '别处');
    expect((await api(alice, 'PATCH', `/api/kanban-columns/${column.id}`, { listId: other.id })).statusCode).toBe(400);
    expect((await api(alice, 'PATCH', `/api/kanban-columns/${column.id}`, { sortOrder: '' })).statusCode).toBe(400);
    expect((await api(alice, 'GET', '/api/kanban-columns')).statusCode).toBe(400);
    expect((await api(alice, 'GET', '/api/kanban-columns?listId=nope')).statusCode).toBe(400);
    for (const method of ['PATCH', 'DELETE'] as const) {
      expect((await api(alice, method, '/api/kanban-columns/not-a-uuid', method === 'PATCH' ? { name: 'x' } : undefined)).statusCode).toBe(404);
    }
  });

  it('takes a client-generated id; reusing one (also another user’s) is 409 and touches nothing', async () => {
    const list = await createList(alice, '客户端 id');
    const id = randomUUID();
    expect((await createColumn(alice, list.id, '甲', { id })).id).toBe(id);
    expect((await api(alice, 'POST', '/api/kanban-columns', { id, listId: list.id, name: '乙' })).statusCode).toBe(409);
    const bobList = await createList(bob, 'bob 的清单');
    expect((await api(bob, 'POST', '/api/kanban-columns', { id, listId: bobList.id, name: '抢' })).statusCode).toBe(409);
    expect((await columnsOf(alice, list.id)).map((c) => [c.id, c.name])).toEqual([[id, '甲']]);
  });

  it('concurrent creates with the same name: exactly one wins, the others are 409', async () => {
    const list = await createList(alice, '并发');
    const results = await Promise.all(
      Array.from({ length: 6 }, () => api(alice, 'POST', '/api/kanban-columns', { listId: list.id, name: '同名' })),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409, 409, 409, 409, 409]);
    expect((await columnsOf(alice, list.id)).map((c) => c.name)).toEqual(['同名']);
  });

  it(`stops at ${MAX_KANBAN_COLUMNS} 分栏 per 清单`, async () => {
    const list = await createList(alice, '上限');
    for (let i = 0; i < MAX_KANBAN_COLUMNS; i++) await createColumn(alice, list.id, `c${i}`);
    const res = await api(alice, 'POST', '/api/kanban-columns', { listId: list.id, name: 'one more' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(await columnsOf(alice, list.id)).toHaveLength(MAX_KANBAN_COLUMNS);
  });

  it('cannot delete own 分栏 into another user’s 分栏, nor put another user’s task anywhere', async () => {
    const aliceList = await createList(alice, 'a');
    const aliceColumn = await createColumn(alice, aliceList.id, 'A');
    const bobList = await createList(bob, 'b');
    const bobColumn = await createColumn(bob, bobList.id, 'B');
    await createTask(bob, { listId: bobList.id, title: 'bob task', columnId: bobColumn.id });

    const res = await api(bob, 'DELETE', `/api/kanban-columns/${bobColumn.id}?tasks=move&moveTo=${aliceColumn.id}`);
    expect(res.statusCode).toBe(400);
    expect((await columnsOf(bob, bobList.id)).map((c) => c.id)).toEqual([bobColumn.id]);
    expect((await tasksOf(alice, aliceList.id))).toEqual([]);

    const aliceTask = await createTask(alice, { listId: aliceList.id, title: 'alice task', columnId: aliceColumn.id });
    expect((await api(bob, 'PATCH', `/api/tasks/${aliceTask.id}`, { columnId: bobColumn.id })).statusCode).toBe(404);
    expect((await tasksOf(alice, aliceList.id))[0]?.columnId).toBe(aliceColumn.id);
  });

  it('a task deleted on its own comes back into its 分栏 if that is still there', async () => {
    const list = await createList(alice, '还原');
    const column = await createColumn(alice, list.id, '进行中');
    const task = await createTask(alice, { listId: list.id, title: '单独删除', columnId: column.id });
    expect((await api(alice, 'DELETE', `/api/tasks/${task.id}`)).statusCode).toBe(204);
    expect((await api(alice, 'POST', `/api/trash/${task.id}/restore`)).statusCode).toBe(200);
    expect((await tasksOf(alice, list.id)).find((x) => x.id === task.id)?.columnId).toBe(column.id);
  });

  it('a task trashed with its 清单 is restored into the 收件箱’s 未分组', async () => {
    const list = await createList(alice, '整单删除');
    const column = await createColumn(alice, list.id, '待办');
    const task = await createTask(alice, { listId: list.id, title: '跟着清单走', columnId: column.id });
    expect((await api(alice, 'DELETE', `/api/lists/${list.id}`)).statusCode).toBe(204);
    const restored = await api(alice, 'POST', `/api/trash/${task.id}/restore`);
    expect(restored.statusCode, restored.body).toBe(200);
    const inbox = (await api(alice, 'GET', '/api/lists')).json().lists[0] as { id: string };
    expect((await tasksOf(alice, inbox.id)).find((x) => x.id === task.id)).toMatchObject({ listId: inbox.id, columnId: null });
  });

  it('deleting an empty 分栏 and deleting twice', async () => {
    const list = await createList(alice, '空分栏');
    const column = await createColumn(alice, list.id, '空');
    expect((await api(alice, 'DELETE', `/api/kanban-columns/${column.id}`)).statusCode).toBe(204);
    expect((await api(alice, 'DELETE', `/api/kanban-columns/${column.id}`)).statusCode).toBe(404);
    // The name is free again after the delete.
    expect((await createColumn(alice, list.id, '空')).name).toBe('空');
  });
});
