import { randomUUID } from 'node:crypto';
import { changesResponseSchema, taskSchema, tasksResponseSchema, type Task } from '@dida/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/* 子任务 (spec 用户故事 35、36): nesting up to 5 levels, Tab / Shift+Tab, completion rules. */

describe('子任务 API', () => {
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

  async function newList(user: TestUser, name: string): Promise<string> {
    const res = await api(user, 'POST', '/api/lists', { name });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }

  /** A chain root > … of `levels` tasks; returns them root first. */
  async function chain(user: TestUser, listId: string, levels: number): Promise<Task[]> {
    const out: Task[] = [];
    for (let i = 1; i <= levels; i++) {
      out.push(await createTask(user, { listId, title: `L${i}`, parentId: out.at(-1)?.id ?? null }));
    }
    return out;
  }

  function expectError(res: { statusCode: number; json: () => { error: { code: string; message: string } } }, code: string) {
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe(code);
  }

  it('creates 子任务 in the parent’s 清单, after the existing siblings', async () => {
    const listId = await newList(alice, '子任务');
    const parent = await createTask(alice, { listId, title: '装修' });
    expect(parent).toMatchObject({ parentId: null, kind: 'text' });
    // No listId: the parent's 清单, not the 收件箱.
    const first = await createTask(alice, { parentId: parent.id, title: '选瓷砖' });
    const second = await createTask(alice, { parentId: parent.id, title: '买灯' });
    expect(first).toMatchObject({ parentId: parent.id, listId });
    expect(second.sortOrder > first.sortOrder).toBe(true);
    const list = await tasksOf(alice, listId);
    expect(list.filter((x) => x.parentId === parent.id).map((x) => x.title)).toEqual(['选瓷砖', '买灯']);
    // A 子任务 is a full 任务: it can be read, edited and have its own 子任务.
    expect(await getTask(alice, first.id)).toEqual(first);
    expect((await patchTask(alice, first.id, { title: '选地砖', description: '**灰色**' })).title).toBe('选地砖');
    expect((await createTask(alice, { parentId: first.id, title: '量面积' })).parentId).toBe(first.id);
  });

  it('keeps the dates given when creating a 子任务 (a 子任务 has the full task fields)', async () => {
    const listId = await newList(alice, '带日期的子任务');
    const root = await createTask(alice, { listId, title: 'root' });
    const allDay = await createTask(alice, { parentId: root.id, title: 'all day', dates: { allDay: true, dueDate: '2026-10-20' } });
    expect(allDay.dates).toEqual({ allDay: true, startDate: null, dueDate: '2026-10-20' });
    const timed = await createTask(alice, { parentId: root.id, title: 'timed', dates: { allDay: false, dueAt: '2026-10-20T07:00:00.000Z' } });
    expect(timed.dates).toEqual({ allDay: false, startAt: null, dueAt: '2026-10-20T07:00:00.000Z', timeZone: 'Asia/Shanghai' });
  });

  it('allows 5 levels counting the root as level 1, and rejects a 6th', async () => {
    const listId = await newList(alice, '五层');
    const levels = await chain(alice, listId, 5);
    const res = await api(alice, 'POST', '/api/tasks', { parentId: levels[4]!.id, title: 'L6' });
    expectError(res, 'depth_exceeded');
    expect(res.json().error.message).toBe('子任务最多 5 层');
    expect((await tasksOf(alice, listId)).map((x) => x.title)).not.toContain('L6');
  });

  it('rejects re-parenting that would push any part of the subtree below level 5', async () => {
    const listId = await newList(alice, '移动超限');
    const levels = await chain(alice, listId, 4); // L1 > L2 > L3 > L4
    const other = await createTask(alice, { listId, title: 'X' });
    await createTask(alice, { parentId: other.id, title: 'X1' }); // X > X1: two levels
    // Under L3 it would be X at level 4, X1 at 5: allowed. Under L4, X1 would be level 6.
    expectError(await api(alice, 'PATCH', `/api/tasks/${other.id}`, { parentId: levels[3]!.id }), 'depth_exceeded');
    expect((await getTask(alice, other.id)).parentId).toBeNull();
    expect((await patchTask(alice, other.id, { parentId: levels[2]!.id })).parentId).toBe(levels[2]!.id);
  });

  it('rejects missing, foreign, own-descendant and mismatched parents', async () => {
    const listId = await newList(alice, '父任务校验');
    const [a, b, c] = await chain(alice, listId, 3);
    const bobTask = await createTask(bob, { title: "bob's" });
    for (const parentId of [randomUUID(), bobTask.id]) {
      expectError(await api(alice, 'POST', '/api/tasks', { parentId, title: 'x' }), 'invalid_parent');
      expectError(await api(alice, 'PATCH', `/api/tasks/${a!.id}`, { parentId }), 'invalid_parent');
    }
    // A task cannot become its own parent or move under its own 子任务.
    expectError(await api(alice, 'PATCH', `/api/tasks/${a!.id}`, { parentId: a!.id }), 'invalid_parent');
    expectError(await api(alice, 'PATCH', `/api/tasks/${a!.id}`, { parentId: c!.id }), 'invalid_parent');
    // listId must agree with the parent's 清单.
    const elsewhere = await newList(alice, 'elsewhere');
    expectError(await api(alice, 'POST', '/api/tasks', { parentId: a!.id, listId: elsewhere, title: 'x' }), 'invalid_parent');
    expectError(await api(alice, 'PATCH', `/api/tasks/${c!.id}`, { parentId: a!.id, listId: elsewhere }), 'invalid_parent');
    expect((await getTask(alice, b!.id)).parentId).toBe(a!.id);
  });

  it('indents (Tab) and outdents (Shift+Tab) through parentId + sortOrder', async () => {
    const listId = await newList(alice, '缩进');
    const a = await createTask(alice, { listId, title: 'A', sortOrder: 'G' });
    const b = await createTask(alice, { listId, title: 'B', sortOrder: 'V' });
    const indented = await patchTask(alice, b.id, { parentId: a.id, sortOrder: 'V' });
    expect(indented).toMatchObject({ parentId: a.id, sortOrder: 'V', listId });
    expect(indented.revision).toBeGreaterThan(b.revision);
    const outdented = await patchTask(alice, b.id, { parentId: null, sortOrder: 'N' });
    expect(outdented).toMatchObject({ parentId: null, sortOrder: 'N' });
  });

  it('moves the whole subtree when a task changes 清单 or parent across 清单', async () => {
    const from = await newList(alice, 'from');
    const to = await newList(alice, 'to');
    const [root, child, grandchild] = await chain(alice, from, 3);
    await patchTask(alice, root!.id, { listId: to });
    expect((await tasksOf(alice, to)).map((x) => x.id).sort()).toEqual([root!.id, child!.id, grandchild!.id].sort());
    expect(await tasksOf(alice, from)).toEqual([]);

    // Moving a 子任务 to another 清单 makes it a top-level task there, with its own 子任务.
    const moved = await patchTask(alice, child!.id, { listId: from });
    expect(moved).toMatchObject({ listId: from, parentId: null });
    expect(await getTask(alice, grandchild!.id)).toMatchObject({ listId: from, parentId: child!.id });

    // Re-parenting under a task of another 清单 brings the subtree into that 清单.
    await patchTask(alice, child!.id, { parentId: root!.id });
    expect((await tasksOf(alice, to)).map((x) => x.id).sort()).toEqual([root!.id, child!.id, grandchild!.id].sort());
  });

  it('completing a task completes all of its open 子任务; re-opening it leaves them completed', async () => {
    const listId = await newList(alice, '完成');
    const parent = await createTask(alice, { listId, title: 'P' });
    const early = await createTask(alice, { parentId: parent.id, title: 'early' });
    const open = await createTask(alice, { parentId: parent.id, title: 'open' });
    const deep = await createTask(alice, { parentId: open.id, title: 'deep' });
    clock.set('2026-10-13T03:00:00.000Z');
    await patchTask(alice, early.id, { status: 'completed' });

    clock.set('2026-10-13T04:00:00.000Z');
    const done = await patchTask(alice, parent.id, { status: 'completed' });
    expect(done.completedAt).toBe('2026-10-13T04:00:00.000Z');
    expect(await getTask(alice, open.id)).toMatchObject({ status: 'completed', completedAt: '2026-10-13T04:00:00.000Z' });
    expect(await getTask(alice, deep.id)).toMatchObject({ status: 'completed', completedAt: '2026-10-13T04:00:00.000Z' });
    // Already completed 子任务 keep their own completion time.
    expect((await getTask(alice, early.id)).completedAt).toBe('2026-10-13T03:00:00.000Z');

    await patchTask(alice, parent.id, { status: 'open' });
    expect((await getTask(alice, open.id)).status).toBe('completed');
    expect((await getTask(alice, deep.id)).status).toBe('completed');
  });

  it('re-opening a 子任务 re-opens its completed ancestors, but not its siblings', async () => {
    const listId = await newList(alice, '重开');
    const [root, mid, leaf] = await chain(alice, listId, 3);
    const sibling = await createTask(alice, { parentId: mid!.id, title: 'sibling' });
    await patchTask(alice, root!.id, { status: 'completed' });
    await patchTask(alice, leaf!.id, { status: 'open' });
    expect((await getTask(alice, root!.id)).status).toBe('open');
    expect((await getTask(alice, mid!.id)).status).toBe('open');
    expect((await getTask(alice, sibling.id)).status).toBe('completed');
    // Completing a 子任务 alone never completes its parent.
    await patchTask(alice, leaf!.id, { status: 'completed' });
    expect((await getTask(alice, mid!.id)).status).toBe('open');
  });

  it('reports every row a cascade touched in /api/changes', async () => {
    const listId = await newList(alice, '同步');
    const [root, child] = await chain(alice, listId, 2);
    const since = changesResponseSchema.parse((await api(alice, 'GET', '/api/changes')).json()).revision;
    await patchTask(alice, root!.id, { status: 'completed' });
    const delta = changesResponseSchema.parse((await api(alice, 'GET', `/api/changes?since=${since}`)).json());
    const upserts = delta.entities.task!.upserts;
    expect(upserts.map((x) => x.id).sort()).toEqual([root!.id, child!.id].sort());
    expect(upserts.every((x) => x.status === 'completed' && x.revision > since)).toBe(true);
    expect(upserts.find((x) => x.id === child!.id)).toMatchObject({ parentId: root!.id, kind: 'text' });
  });

  it('isolates users', async () => {
    const own = await createTask(alice, { title: 'mine' });
    const bobs = await createTask(bob, { title: 'theirs' });
    expect((await api(bob, 'POST', '/api/tasks', { parentId: own.id, title: 'x' })).statusCode).toBe(400);
    expect((await api(alice, 'PATCH', `/api/tasks/${bobs.id}`, { parentId: own.id })).statusCode).toBe(404);
  });
});
