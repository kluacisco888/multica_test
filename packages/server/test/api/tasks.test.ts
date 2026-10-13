import { randomUUID } from 'node:crypto';
import { sidebarResponseSchema, taskSchema, tasksResponseSchema, type Task } from '@dida/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/* 任务 basics (spec 用户故事 12、20、21、27、31、40). */

describe('tasks API', () => {
  const clock = fixedClock('2026-10-13T02:00:00.000Z');
  let t: TestApp;
  let alice: TestUser;
  let bob: TestUser;
  let inboxId: string;

  beforeAll(async () => {
    t = await createTestApp({ clock });
    alice = await t.createUser('alice');
    bob = await t.createUser('bob');
    const sidebar = sidebarResponseSchema.parse((await api(alice, 'GET', '/api/lists')).json());
    inboxId = sidebar.lists.find((l) => l.isInbox)!.id;
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

  it('puts a task without a 清单 into the 收件箱, newest on top', async () => {
    const first = await createTask(alice, { title: '  买牛奶  ' });
    expect(first).toMatchObject({ listId: inboxId, title: '买牛奶', description: '', status: 'open', completedAt: null });
    expect(first.createdAt).toBe('2026-10-13T02:00:00.000Z');
    const second = await createTask(alice, { title: '取快递', listId: null });
    expect(second.listId).toBe(inboxId);
    expect((await tasksOf(alice, inboxId)).map((x) => x.title)).toEqual(['取快递', '买牛奶']);
  });

  it('creates the 收件箱 on demand for a user who never opened the sidebar', async () => {
    const carol = await t.createUser('carol');
    const task = await createTask(carol, { title: 'first thing' });
    const sidebar = sidebarResponseSchema.parse((await api(carol, 'GET', '/api/lists')).json());
    expect(sidebar.lists.filter((l) => l.isInbox).map((l) => l.id)).toEqual([task.listId]);
  });

  it('accepts a client-generated id and an explicit 清单', async () => {
    const listId = await newList(alice, '工作');
    const id = randomUUID();
    const task = await createTask(alice, { id, listId, title: '周报' });
    expect(task).toMatchObject({ id, listId });
    const read = await api(alice, 'GET', `/api/tasks/${id}`);
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual(task);
  });

  it('rejects empty or overlong titles and unknown fields', async () => {
    for (const payload of [{ title: '' }, { title: '   ' }, { title: 'x'.repeat(513) }, {}]) {
      const res = await api(alice, 'POST', '/api/tasks', payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error.code).toBe('invalid_request');
    }
    const task = await createTask(alice, { title: 'ok' });
    for (const patch of [{ title: '' }, { status: 'done' }, { userId: bob.id }, { completedAt: null }]) {
      expect((await api(alice, 'PATCH', `/api/tasks/${task.id}`, patch)).statusCode, JSON.stringify(patch)).toBe(400);
    }
  });

  it('edits the title and the Markdown description', async () => {
    const task = await createTask(alice, { title: 'draft' });
    clock.advance(60_000);
    const edited = await patchTask(alice, task.id, { title: '写周报', description: '## 本周\n\n- [x] 完成 **EURO-6**\n- 下周继续' });
    expect(edited).toMatchObject({ title: '写周报', description: '## 本周\n\n- [x] 完成 **EURO-6**\n- 下周继续' });
    expect(edited.updatedAt).toBe('2026-10-13T02:01:00.000Z');
    expect(edited.revision).toBeGreaterThan(task.revision);
    expect((await api(alice, 'GET', `/api/tasks/${task.id}`)).json()).toEqual(edited);
  });

  it('completes and un-completes a task; completed tasks follow the open ones, newest completion first', async () => {
    const listId = await newList(alice, '完成测试');
    const a = await createTask(alice, { listId, title: 'A' });
    const b = await createTask(alice, { listId, title: 'B' });
    await createTask(alice, { listId, title: 'C' });

    clock.set('2026-10-13T03:00:00.000Z');
    const doneA = await patchTask(alice, a.id, { status: 'completed' });
    expect(doneA).toMatchObject({ status: 'completed', completedAt: '2026-10-13T03:00:00.000Z' });
    clock.set('2026-10-13T04:00:00.000Z');
    await patchTask(alice, b.id, { status: 'completed' });
    // Completing again keeps the original completion time.
    expect((await patchTask(alice, a.id, { status: 'completed' })).completedAt).toBe('2026-10-13T03:00:00.000Z');

    const list = await tasksOf(alice, listId);
    expect(list.map((x) => `${x.title}:${x.status}`)).toEqual(['C:open', 'B:completed', 'A:completed']);

    const counts = () => api(alice, 'GET', '/api/lists').then((r) => sidebarResponseSchema.parse(r.json()).openTaskCounts[listId]);
    expect(await counts()).toBe(1);
    const reopened = await patchTask(alice, a.id, { status: 'open' });
    expect(reopened).toMatchObject({ status: 'open', completedAt: null });
    expect((await tasksOf(alice, listId)).map((x) => `${x.title}:${x.status}`)).toEqual(['C:open', 'A:open', 'B:completed']);
    expect(await counts()).toBe(2);
  });

  it('moves a task to another 清单, landing at its top', async () => {
    const from = await newList(alice, 'from');
    const to = await newList(alice, 'to');
    const existing = await createTask(alice, { listId: to, title: 'already there' });
    const task = await createTask(alice, { listId: from, title: 'mover' });
    const moved = await patchTask(alice, task.id, { listId: to });
    expect(moved.listId).toBe(to);
    expect(await tasksOf(alice, from)).toEqual([]);
    expect((await tasksOf(alice, to)).map((x) => x.id)).toEqual([task.id, existing.id]);

    // Into the 收件箱 works too; a missing or foreign 清单 does not.
    expect((await patchTask(alice, task.id, { listId: inboxId })).listId).toBe(inboxId);
    const bobList = await newList(bob, "bob's");
    for (const listId of [randomUUID(), bobList]) {
      const res = await api(alice, 'PATCH', `/api/tasks/${task.id}`, { listId });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('invalid_list');
    }
  });

  it('isolates users: 404 on foreign tasks, foreign 清单 cannot be listed or used', async () => {
    const bobTask = await createTask(bob, { title: "bob's secret" });
    for (const [method, url, payload] of [
      ['GET', `/api/tasks/${bobTask.id}`, undefined],
      ['PATCH', `/api/tasks/${bobTask.id}`, { title: 'hacked' }],
      ['GET', '/api/tasks/not-a-uuid', undefined],
    ] as const) {
      const res = await api(alice, method, url, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    expect((await api(alice, 'GET', `/api/tasks?listId=${bobTask.listId}`)).statusCode).toBe(404);
    expect((await api(alice, 'POST', '/api/tasks', { listId: bobTask.listId, title: 'x' })).statusCode).toBe(400);
    expect((await api(alice, 'POST', '/api/tasks', { id: bobTask.id, title: 'x' })).statusCode).toBe(409);
    expect((await api(bob, 'GET', `/api/tasks/${bobTask.id}`)).json().title).toBe("bob's secret");
  });

  it('requires listId when listing tasks', async () => {
    expect((await api(alice, 'GET', '/api/tasks')).statusCode).toBe(400);
  });
});
