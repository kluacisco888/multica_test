import { randomUUID } from 'node:crypto';
import {
  batchResponseSchema,
  changesResponseSchema,
  isSortKey,
  moveTaskResponseSchema,
  SORT_KEY_REBALANCE_LENGTH,
  sidebarResponseSchema,
  taskSchema,
  tasksResponseSchema,
  trashResponseSchema,
  type Task,
} from '@dida/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/* 拖拽排序、置顶与批量操作 (spec 用户故事 32–34). */

describe('拖拽排序、置顶与批量操作 API', () => {
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

  async function patchTask(user: TestUser, id: string, patch: object): Promise<Task> {
    const res = await api(user, 'PATCH', `/api/tasks/${id}`, patch);
    expect(res.statusCode, res.body).toBe(200);
    return taskSchema.parse(res.json());
  }

  async function getTask(user: TestUser, id: string): Promise<Task> {
    const res = await api(user, 'GET', `/api/tasks/${id}`);
    expect(res.statusCode, res.body).toBe(200);
    return taskSchema.parse(res.json());
  }

  async function tasksOf(user: TestUser, listId: string): Promise<Task[]> {
    const res = await api(user, 'GET', `/api/tasks?listId=${listId}`);
    expect(res.statusCode, res.body).toBe(200);
    return tasksResponseSchema.parse(res.json()).tasks;
  }

  async function move(user: TestUser, id: string, afterId: string | null): Promise<Task[]> {
    const res = await api(user, 'POST', `/api/tasks/${id}/move`, { afterId });
    expect(res.statusCode, res.body).toBe(200);
    return moveTaskResponseSchema.parse(res.json()).tasks;
  }

  async function batch(user: TestUser, ids: string[], action: object): Promise<Task[]> {
    const res = await api(user, 'POST', '/api/tasks/batch', { ids, action });
    expect(res.statusCode, res.body).toBe(200);
    return batchResponseSchema.parse(res.json()).tasks;
  }

  const titles = (tasks: Task[]) => tasks.filter((x) => x.parentId === null && x.status === 'open').map((x) => x.title);

  function expectHealthyKeys(keys: string[]) {
    for (let i = 1; i < keys.length; i++) expect(keys[i - 1]! < keys[i]!, `${keys[i - 1]} < ${keys[i]}`).toBe(true);
    for (const key of keys) {
      expect(isSortKey(key)).toBe(true);
      expect(key.length).toBeLessThanOrEqual(SORT_KEY_REBALANCE_LENGTH);
    }
  }

  describe('拖拽排序 (POST /api/tasks/:id/move)', () => {
    it('keeps the dragged order after a re-read, writing only the moved task', async () => {
      const listId = await newList(alice, '排序');
      const a = await createTask(alice, { listId, title: 'A' });
      const b = await createTask(alice, { listId, title: 'B' });
      const c = await createTask(alice, { listId, title: 'C' });
      expect(titles(await tasksOf(alice, listId))).toEqual(['C', 'B', 'A']);

      const moved = await move(alice, a.id, c.id);
      expect(moved.map((x) => x.id)).toEqual([a.id]);
      expect(titles(await tasksOf(alice, listId))).toEqual(['C', 'A', 'B']);
      // The neighbours were not rewritten.
      expect((await getTask(alice, b.id)).revision).toBe(b.revision);
      expect((await getTask(alice, c.id)).revision).toBe(c.revision);

      await move(alice, b.id, null);
      expect(titles(await tasksOf(alice, listId))).toEqual(['B', 'C', 'A']);
      await move(alice, b.id, a.id);
      expect(titles(await tasksOf(alice, listId))).toEqual(['C', 'A', 'B']);
    });

    it('reorders 子任务 among their siblings only', async () => {
      const listId = await newList(alice, '子任务排序');
      const parent = await createTask(alice, { listId, title: '父' });
      const one = await createTask(alice, { parentId: parent.id, title: '一' });
      const two = await createTask(alice, { parentId: parent.id, title: '二' });
      await move(alice, two.id, null);
      const children = (await tasksOf(alice, listId)).filter((x) => x.parentId === parent.id).map((x) => x.title);
      expect(children).toEqual(['二', '一']);
      // A root is not a sibling of a 子任务.
      const res = await api(alice, 'POST', `/api/tasks/${one.id}/move`, { afterId: parent.id });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('invalid_position');
    });

    it('stays ordered with short keys after 1000 drops at the same spot', { timeout: 120_000 }, async () => {
      const listId = await newList(alice, '拖很多次');
      const anchor = await createTask(alice, { listId, title: 'anchor' });
      const x = await createTask(alice, { listId, title: 'x' });
      const y = await createTask(alice, { listId, title: 'y' });
      await move(alice, anchor.id, null); // anchor, y, x
      // Always drop the third task right after the first: the worst case for key length.
      let order = ['anchor', 'y', 'x'];
      const ids: Record<string, string> = { anchor: anchor.id, x: x.id, y: y.id };
      let rekeyedTotal = 0;
      for (let i = 0; i < 1000; i++) {
        const third = order[2]!;
        const changed = await move(alice, ids[third]!, anchor.id);
        rekeyedTotal += changed.length - 1;
        order = ['anchor', third, order[1]!];
      }
      const tasks = await tasksOf(alice, listId);
      expect(titles(tasks)).toEqual(order);
      expectHealthyKeys(tasks.map((x) => x.sortOrder));
      expect(rekeyedTotal).toBeGreaterThan(0); // the group was re-keyed at least once …
      expect(rekeyedTotal).toBeLessThan(200); // … but rarely
    });

    it('stays ordered with short keys after 1000 new tasks at the top of a 清单', { timeout: 120_000 }, async () => {
      const listId = await newList(alice, '加很多');
      for (let i = 0; i < 1000; i++) await createTask(alice, { listId, title: `t${i}` });
      const tasks = await tasksOf(alice, listId);
      expect(tasks).toHaveLength(1000);
      expect(tasks[0]!.title).toBe('t999');
      expect(tasks[999]!.title).toBe('t0');
      expectHealthyKeys(tasks.map((x) => x.sortOrder));
    });

    it('rejects positions outside the group, other users and bad input', async () => {
      const listId = await newList(alice, '校验');
      const other = await newList(alice, '别的');
      const a = await createTask(alice, { listId, title: 'a' });
      const elsewhere = await createTask(alice, { listId: other, title: 'elsewhere' });
      const bobs = await createTask(bob, { title: 'bob' });
      for (const afterId of [a.id, elsewhere.id, bobs.id, randomUUID()]) {
        const res = await api(alice, 'POST', `/api/tasks/${a.id}/move`, { afterId });
        expect(res.statusCode, afterId).toBe(400);
        expect(res.json().error.code).toBe('invalid_position');
      }
      expect((await api(bob, 'POST', `/api/tasks/${a.id}/move`, { afterId: null })).statusCode).toBe(404);
      expect((await api(null, 'POST', `/api/tasks/${a.id}/move`, { afterId: null })).statusCode).toBe(401);
      expect((await api(alice, 'POST', `/api/tasks/${a.id}/move`, {})).statusCode).toBe(400);
      expect((await api(alice, 'POST', `/api/tasks/${a.id}/move`, { afterId: 'nope' })).statusCode).toBe(400);
      expect((await getTask(alice, a.id)).revision).toBe(a.revision);
    });
  });

  describe('置顶', () => {
    it('puts the latest pinned task first, keeps sortOrder, and 取消置顶 goes back to its place', async () => {
      const listId = await newList(alice, '置顶');
      const a = await createTask(alice, { listId, title: 'A' });
      const b = await createTask(alice, { listId, title: 'B' });
      const c = await createTask(alice, { listId, title: 'C' });
      const pinnedA = await patchTask(alice, a.id, { pinned: true });
      expect(pinnedA.pinOrder).not.toBeNull();
      expect(pinnedA.sortOrder).toBe(a.sortOrder);
      const pinnedC = await patchTask(alice, c.id, { pinned: true });
      expect(pinnedC.pinOrder! < pinnedA.pinOrder!).toBe(true);
      // Pinning again changes nothing.
      expect((await patchTask(alice, c.id, { pinned: true })).pinOrder).toBe(pinnedC.pinOrder);

      // Drag within 已置顶: A before C.
      const [movedA] = await move(alice, a.id, null);
      expect(movedA!.pinOrder! < pinnedC.pinOrder!).toBe(true);
      expect(movedA!.sortOrder).toBe(a.sortOrder);
      // An unpinned task is not a position inside 已置顶.
      const res = await api(alice, 'POST', `/api/tasks/${a.id}/move`, { afterId: b.id });
      expect(res.json().error.code).toBe('invalid_position');

      const unpinned = await patchTask(alice, a.id, { pinned: false });
      expect(unpinned.pinOrder).toBeNull();
      expect(titles(await tasksOf(alice, listId))).toEqual(['C', 'B', 'A']);
    });

    it('pins top-level tasks only; becoming a 子任务 unpins', async () => {
      const listId = await newList(alice, '置顶子任务');
      const parent = await createTask(alice, { listId, title: '父' });
      const child = await createTask(alice, { parentId: parent.id, title: '子' });
      const res = await api(alice, 'PATCH', `/api/tasks/${child.id}`, { pinned: true });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('invalid_pin');
      const other = await patchTask(alice, (await createTask(alice, { listId, title: '另一个' })).id, { pinned: true });
      const indented = await patchTask(alice, other.id, { parentId: parent.id });
      expect(indented.pinOrder).toBeNull();
    });

    it('a pinned 重复任务 stays pinned in its next instance', async () => {
      const task = await createTask(alice, {
        title: '每天',
        dates: { allDay: true, startDate: null, dueDate: '2026-10-13' },
        repeat: { freq: 'daily' },
      });
      const pinned = await patchTask(alice, task.id, { pinned: true });
      await patchTask(alice, task.id, { status: 'completed' });
      const next = (await tasksOf(alice, task.listId)).find((x) => x.title === '每天' && x.status === 'open');
      expect(next?.pinOrder).toBe(pinned.pinOrder);
    });
  });

  describe('批量操作 (POST /api/tasks/batch)', () => {
    async function three(name: string) {
      const listId = await newList(alice, name);
      const a = await createTask(alice, { listId, title: 'a' });
      const b = await createTask(alice, { listId, title: 'b' });
      const sub = await createTask(alice, { parentId: b.id, title: 'b 的子任务' });
      const c = await createTask(alice, { listId, title: 'c' });
      return { listId, a, b, sub, c };
    }

    it('完成: completes every task with its 子任务, leaves the others', async () => {
      const { listId, a, b, sub, c } = await three('批量完成');
      const changed = await batch(alice, [a.id, b.id], { op: 'complete' });
      expect(changed.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
      const after = await tasksOf(alice, listId);
      const status = (id: string) => after.find((x) => x.id === id)?.status;
      expect([status(a.id), status(b.id), status(sub.id), status(c.id)]).toEqual(['completed', 'completed', 'completed', 'open']);
    });

    it('删除: soft-deletes into the 回收站 (tombstones in /api/changes), with 子任务', async () => {
      const { listId, a, b, sub, c } = await three('批量删除');
      const before = changesResponseSchema.parse((await api(alice, 'GET', '/api/changes')).json()).revision;
      // A 子任务 listed after its parent is already gone with it: no error.
      expect(await batch(alice, [b.id, a.id, sub.id], { op: 'delete' })).toEqual([]);
      expect(titles(await tasksOf(alice, listId))).toEqual(['c']);
      expect((await api(alice, 'GET', `/api/tasks/${a.id}`)).statusCode).toBe(404);
      const trash = trashResponseSchema.parse((await api(alice, 'GET', '/api/trash')).json()).tasks.map((x) => x.id);
      expect(trash).toEqual(expect.arrayContaining([a.id, b.id]));
      expect(trash).not.toContain(sub.id);
      const changes = changesResponseSchema.parse((await api(alice, 'GET', `/api/changes?since=${before}`)).json());
      expect(changes.entities.task!.tombstones.map((x) => x.id).sort()).toEqual([a.id, b.id, sub.id].sort());
      // Restorable like a single delete.
      expect((await api(alice, 'POST', `/api/trash/${b.id}/restore`)).statusCode).toBe(200);
      expect((await getTask(alice, sub.id)).parentId).toBe(b.id);
      expect((await getTask(alice, c.id)).status).toBe('open');
    });

    it('移动: moves the tasks (and 子任务) to another 清单, on top there', async () => {
      const { a, b, sub } = await three('批量移动');
      const target = await newList(alice, '移动目标');
      const existing = await createTask(alice, { listId: target, title: '原有' });
      const changed = await batch(alice, [a.id, b.id], { op: 'move', listId: target });
      expect(changed.every((x) => x.listId === target)).toBe(true);
      expect((await getTask(alice, sub.id)).listId).toBe(target);
      // On top there, in the order they were given.
      expect(titles(await tasksOf(alice, target))).toEqual(['a', 'b', existing.title]);
      const res = await api(alice, 'POST', '/api/tasks/batch', { ids: [a.id], action: { op: 'move', listId: randomUUID() } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('invalid_list');
    });

    it('改日期: sets the same date on every task; null clears dates and 重复规则', async () => {
      const { a, b } = await three('批量日期');
      const repeating = await createTask(alice, {
        title: '重复',
        dates: { allDay: true, startDate: null, dueDate: '2026-10-13' },
        repeat: { freq: 'daily' },
      });
      const dates = { allDay: true, startDate: null, dueDate: '2026-10-20' };
      const changed = await batch(alice, [a.id, b.id, repeating.id], { op: 'dates', dates });
      expect(changed.map((x) => x.dates)).toEqual([dates, dates, dates]);
      await batch(alice, [a.id, repeating.id], { op: 'dates', dates: null });
      expect((await getTask(alice, a.id)).dates).toBeNull();
      expect(await getTask(alice, repeating.id)).toMatchObject({ dates: null, repeat: null });
      expect((await getTask(alice, b.id)).dates).toEqual(dates);
    });

    it('改优先级: sets the 优先级 of every task', async () => {
      const { a, b, c } = await three('批量优先级');
      await batch(alice, [a.id, c.id], { op: 'priority', priority: 'high' });
      expect((await getTask(alice, a.id)).priority).toBe('high');
      expect((await getTask(alice, c.id)).priority).toBe('high');
      expect((await getTask(alice, b.id)).priority).toBe('none');
      expect((await api(alice, 'POST', '/api/tasks/batch', { ids: [a.id], action: { op: 'priority', priority: 'urgent' } })).statusCode).toBe(400);
    });

    it('打标签: adds and removes 标签, keeping the others', async () => {
      const { a, b } = await three('批量标签');
      const tag = async (name: string) => {
        const res = await api(alice, 'POST', '/api/tags', { name });
        expect(res.statusCode, res.body).toBe(201);
        return res.json().id as string;
      };
      const work = await tag('批量工作');
      const home = await tag('批量家里');
      await patchTask(alice, a.id, { tagIds: [home] });
      await batch(alice, [a.id, b.id], { op: 'tags', add: [work] });
      expect((await getTask(alice, a.id)).tagIds).toEqual([home, work]);
      expect((await getTask(alice, b.id)).tagIds).toEqual([work]);
      await batch(alice, [a.id, b.id], { op: 'tags', remove: [home] });
      expect((await getTask(alice, a.id)).tagIds).toEqual([work]);
      // An unknown 标签 changes nothing at all.
      const res = await api(alice, 'POST', '/api/tasks/batch', { ids: [a.id, b.id], action: { op: 'tags', add: [randomUUID()] } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('invalid_tags');
      expect((await getTask(alice, b.id)).tagIds).toEqual([work]);
    });

    it('置顶 / 放弃 work in a batch too', async () => {
      const { a, b, c } = await three('批量置顶');
      const pinned = await batch(alice, [a.id, b.id], { op: 'pin', pinned: true });
      expect(pinned.every((x) => x.pinOrder !== null)).toBe(true);
      await batch(alice, [c.id], { op: 'abandon' });
      expect((await getTask(alice, c.id)).status).toBe('abandoned');
    });

    it('is all or nothing and isolated per user', async () => {
      const { listId, a, b } = await three('批量隔离');
      const bobs = await createTask(bob, { title: 'bob 的任务' });
      const bobCounts = sidebarResponseSchema.parse((await api(bob, 'GET', '/api/lists')).json()).openTaskCounts;
      // Someone else's task, an unknown id or a deleted task: 404, nothing changes.
      const deleted = await createTask(alice, { listId, title: '已删除' });
      expect((await api(alice, 'DELETE', `/api/tasks/${deleted.id}`)).statusCode).toBe(204);
      for (const id of [bobs.id, randomUUID(), deleted.id]) {
        const res = await api(alice, 'POST', '/api/tasks/batch', { ids: [a.id, id], action: { op: 'complete' } });
        expect(res.statusCode, id).toBe(404);
      }
      expect((await getTask(alice, a.id)).status).toBe('open');
      expect((await getTask(bob, bobs.id)).status).toBe('open');
      // Bob cannot touch Alice's tasks.
      expect((await api(bob, 'POST', '/api/tasks/batch', { ids: [a.id], action: { op: 'delete' } })).statusCode).toBe(404);
      expect((await getTask(alice, a.id)).status).toBe('open');
      expect((await api(null, 'POST', '/api/tasks/batch', { ids: [a.id], action: { op: 'complete' } })).statusCode).toBe(401);
      // Bad input.
      for (const payload of [{ ids: [], action: { op: 'complete' } }, { ids: [a.id], action: { op: 'explode' } }, { ids: ['x'], action: { op: 'complete' } }]) {
        expect((await api(alice, 'POST', '/api/tasks/batch', payload)).statusCode).toBe(400);
      }
      expect((await getTask(alice, b.id)).revision).toBe(b.revision);
      // Bob's sidebar counts are untouched by Alice's batches.
      const sidebar = sidebarResponseSchema.parse((await api(bob, 'GET', '/api/lists')).json());
      expect(sidebar.openTaskCounts).toEqual(bobCounts);
    });
  });
});
