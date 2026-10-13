import { randomUUID } from 'node:crypto';
import {
  changesResponseSchema,
  checklistItemSchema,
  checklistItemsResponseSchema,
  keyBetween,
  taskSchema,
  type ChecklistItem,
  type Task,
} from '@dida/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/* 检查清单 mode and 检查项 (spec 用户故事 37), synced per ADR-0004. */

describe('检查项 API', () => {
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

  async function createTask(user: TestUser, payload: object): Promise<Task> {
    const res = await api(user, 'POST', '/api/tasks', payload);
    expect(res.statusCode, res.body).toBe(201);
    return taskSchema.parse(res.json());
  }

  async function patchTask(user: TestUser, id: string, patch: object): Promise<Task> {
    const res = await api(user, 'PATCH', `/api/tasks/${id}`, patch);
    expect(res.statusCode, res.body).toBe(200);
    return taskSchema.parse(res.json());
  }

  async function itemsOf(user: TestUser, taskId: string): Promise<ChecklistItem[]> {
    const res = await api(user, 'GET', `/api/tasks/${taskId}/checklist-items`);
    expect(res.statusCode, res.body).toBe(200);
    return checklistItemsResponseSchema.parse(res.json()).items;
  }

  async function addItem(user: TestUser, taskId: string, payload: object): Promise<ChecklistItem> {
    const res = await api(user, 'POST', `/api/tasks/${taskId}/checklist-items`, payload);
    expect(res.statusCode, res.body).toBe(201);
    return checklistItemSchema.parse(res.json());
  }

  async function patchItem(user: TestUser, id: string, patch: object): Promise<ChecklistItem> {
    const res = await api(user, 'PATCH', `/api/checklist-items/${id}`, patch);
    expect(res.statusCode, res.body).toBe(200);
    return checklistItemSchema.parse(res.json());
  }

  async function revision(user: TestUser): Promise<number> {
    return changesResponseSchema.parse((await api(user, 'GET', '/api/changes')).json()).revision;
  }

  async function changesSince(user: TestUser, since: number) {
    return changesResponseSchema.parse((await api(user, 'GET', `/api/changes?since=${since}`)).json());
  }

  const summary = (items: ChecklistItem[]) => items.map((i) => `${i.completed ? '[x]' : '[ ]'} ${i.title}`);

  it('switching 描述 → 检查清单 turns each non-empty line into a 检查项 and clears the 描述', async () => {
    const task = await createTask(alice, { title: '出差', description: '订机票\n\n- 订酒店\n- [x] 打印行程单\n' });
    const switched = await patchTask(alice, task.id, { kind: 'checklist' });
    expect(switched).toMatchObject({ kind: 'checklist', description: '' });
    const items = await itemsOf(alice, task.id);
    expect(summary(items)).toEqual(['[ ] 订机票', '[ ] 订酒店', '[x] 打印行程单']);
    expect(items.every((i) => i.taskId === task.id)).toBe(true);
    // Switching to the mode it is already in changes nothing.
    await patchTask(alice, task.id, { kind: 'checklist' });
    expect(await itemsOf(alice, task.id)).toEqual(items);
  });

  it('switching 检查清单 → 描述 turns each 检查项 into one line and removes the 检查项', async () => {
    const task = await createTask(alice, { title: '搬家' });
    await patchTask(alice, task.id, { kind: 'checklist' });
    expect(await itemsOf(alice, task.id)).toEqual([]); // empty 描述: no 检查项
    const a = await addItem(alice, task.id, { title: '打包' });
    await addItem(alice, task.id, { title: '叫车' });
    await patchItem(alice, a.id, { completed: true });
    const since = await revision(alice);

    const back = await patchTask(alice, task.id, { kind: 'text' });
    expect(back).toMatchObject({ kind: 'text', description: '打包\n叫车' });
    expect(await itemsOf(alice, task.id)).toEqual([]);
    // The 检查项 are tombstones now.
    const delta = await changesSince(alice, since);
    expect(delta.entities.checklistItem!.tombstones).toHaveLength(2);
    expect(delta.entities.task!.upserts.map((x) => x.id)).toEqual([task.id]);
  });

  it('adds, checks, renames, reorders and deletes 检查项; every write gets a new revision', async () => {
    const task = await createTask(alice, { title: '周末' });
    await patchTask(alice, task.id, { kind: 'checklist' });
    const id = randomUUID();
    const first = await addItem(alice, task.id, { id, title: '  洗车  ' });
    expect(first).toMatchObject({ id, title: '洗车', completed: false, taskId: task.id });
    expect(first.createdAt).toBe('2026-10-13T02:00:00.000Z');
    const second = await addItem(alice, task.id, { title: '买菜' });
    const third = await addItem(alice, task.id, { title: '健身', completed: true });
    expect(summary(await itemsOf(alice, task.id))).toEqual(['[ ] 洗车', '[ ] 买菜', '[x] 健身']);

    clock.advance(60_000);
    const checked = await patchItem(alice, second.id, { completed: true });
    expect(checked.revision).toBeGreaterThan(third.revision);
    expect(checked.updatedAt).toBe('2026-10-13T02:01:00.000Z');
    const unchecked = await patchItem(alice, second.id, { completed: false, title: '买水果' });
    expect(unchecked.revision).toBeGreaterThan(checked.revision);

    // Reorder: only the moved 检查项 gets a new sort key.
    await patchItem(alice, third.id, { sortOrder: keyBetween(null, first.sortOrder) });
    expect((await itemsOf(alice, task.id)).map((i) => i.title)).toEqual(['健身', '洗车', '买水果']);

    const since = await revision(alice);
    const del = await api(alice, 'DELETE', `/api/checklist-items/${first.id}`);
    expect(del.statusCode).toBe(204);
    expect((await itemsOf(alice, task.id)).map((i) => i.title)).toEqual(['健身', '买水果']);
    expect((await api(alice, 'DELETE', `/api/checklist-items/${first.id}`)).statusCode).toBe(404);
    expect((await api(alice, 'PATCH', `/api/checklist-items/${first.id}`, { completed: true })).statusCode).toBe(404);
    const delta = await changesSince(alice, since);
    expect(delta.entities.checklistItem!.tombstones).toEqual([
      { id: first.id, revision: expect.any(Number), deletedAt: '2026-10-13T02:01:00.000Z' },
    ]);
    expect(delta.entities.checklistItem!.tombstones[0]!.revision).toBeGreaterThan(since);
  });

  it('serves 检查项 upserts in /api/changes like the 检查项 API', async () => {
    const task = await createTask(alice, { title: 'sync' });
    await patchTask(alice, task.id, { kind: 'checklist' });
    const since = await revision(alice);
    const item = await addItem(alice, task.id, { title: '同步我' });
    const delta = await changesSince(alice, since);
    expect(delta.entities.checklistItem!.upserts).toEqual([{ ...item, deletedAt: null }]);
  });

  it('rejects 检查项 on a 描述 task, 描述 edits in 检查清单 mode, and invalid payloads', async () => {
    const text = await createTask(alice, { title: 'text' });
    const res = await api(alice, 'POST', `/api/tasks/${text.id}/checklist-items`, { title: 'x' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('not_checklist');

    const list = await createTask(alice, { title: 'list' });
    await patchTask(alice, list.id, { kind: 'checklist' });
    const desc = await api(alice, 'PATCH', `/api/tasks/${list.id}`, { description: 'hello' });
    expect(desc.statusCode).toBe(400);
    expect(desc.json().error.code).toBe('checklist_mode');
    expect((await api(alice, 'PATCH', `/api/tasks/${text.id}`, { kind: 'checklist', description: 'x' })).statusCode).toBe(400);
    expect((await api(alice, 'PATCH', `/api/tasks/${text.id}`, { kind: 'grid' })).statusCode).toBe(400);

    for (const payload of [{ title: '' }, { title: '   ' }, { title: 'x'.repeat(513) }, {}, { title: 'a', taskId: text.id }]) {
      const bad = await api(alice, 'POST', `/api/tasks/${list.id}/checklist-items`, payload);
      expect(bad.statusCode, JSON.stringify(payload)).toBe(400);
    }
    const item = await addItem(alice, list.id, { title: 'ok' });
    for (const patch of [{ title: '' }, { completed: 'yes' }, { sortOrder: 'a0' }, { taskId: text.id }]) {
      expect((await api(alice, 'PATCH', `/api/checklist-items/${item.id}`, patch)).statusCode, JSON.stringify(patch)).toBe(400);
    }
  });

  it('isolates users: another user’s task and 检查项 are 404', async () => {
    const task = await createTask(alice, { title: 'private' });
    await patchTask(alice, task.id, { kind: 'checklist' });
    const item = await addItem(alice, task.id, { title: 'secret' });
    for (const [method, url, payload] of [
      ['GET', `/api/tasks/${task.id}/checklist-items`, undefined],
      ['POST', `/api/tasks/${task.id}/checklist-items`, { title: 'x' }],
      ['PATCH', `/api/checklist-items/${item.id}`, { completed: true }],
      ['DELETE', `/api/checklist-items/${item.id}`, undefined],
      ['PATCH', '/api/checklist-items/not-a-uuid', { completed: true }],
    ] as const) {
      expect((await api(bob, method, url, payload)).statusCode, `${method} ${url}`).toBe(404);
    }
    // Reusing someone else's 检查项 id is a conflict, not a takeover.
    const bobTask = await createTask(bob, { title: 'bob' });
    await patchTask(bob, bobTask.id, { kind: 'checklist' });
    expect((await api(bob, 'POST', `/api/tasks/${bobTask.id}/checklist-items`, { id: item.id, title: 'x' })).statusCode).toBe(409);
    expect(await itemsOf(alice, task.id)).toEqual([item]);
  });

  it('deleting a 清单 also tombstones the 检查项 of its tasks', async () => {
    const listId = (await api(alice, 'POST', '/api/lists', { name: 'temp' })).json().id as string;
    const task = await createTask(alice, { listId, title: 'in temp' });
    await patchTask(alice, task.id, { kind: 'checklist' });
    const item = await addItem(alice, task.id, { title: 'gone' });
    const since = await revision(alice);
    expect((await api(alice, 'DELETE', `/api/lists/${listId}`)).statusCode).toBe(204);
    expect((await changesSince(alice, since)).entities.checklistItem!.tombstones.map((x) => x.id)).toEqual([item.id]);
  });
});
