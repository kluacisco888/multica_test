import {
  changesResponseSchema,
  checklistItemSchema,
  listSchema,
  sidebarResponseSchema,
  taskSchema,
  tasksResponseSchema,
  trashResponseSchema,
  type Task,
} from '@dida/shared';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sessionUser } from '../../src/auth.js';
import { fixedClock } from '../../src/clock.js';
import { checklistItems, tasks } from '../../src/db/schema/tasks.js';
import { smartListCandidates } from '../../src/smart-lists.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/* 放弃、回收站与 30 天清理、清单归档 (EURO-15, spec 用户故事 16、28–30; ADR-0004 tombstones). */

const DAY = 24 * 60 * 60 * 1000;

/**
 * The 智能清单 endpoints come with EURO-13; they all start from
 * `smartListCandidates`. This fixture route exposes it so the 归档 rule is
 * tested through HTTP like the real smart lists will be.
 */
function smartFixture(app: FastifyInstance) {
  app.get('/api/test/smart-candidates', async (request) => {
    const rows = await smartListCandidates(app.db, sessionUser(request).id);
    return { ids: rows.map((r) => r.id) };
  });
}

describe('放弃、回收站与清单归档', () => {
  const clock = fixedClock('2026-10-13T02:00:00.000Z');
  let t: TestApp;
  let alice: TestUser;
  let bob: TestUser;
  let inboxId: string;

  beforeAll(async () => {
    t = await createTestApp({ clock, routes: smartFixture });
    alice = await t.createUser('alice');
    bob = await t.createUser('bob');
    inboxId = sidebarResponseSchema.parse((await api(alice, 'GET', '/api/lists')).json()).lists.find((l) => l.isInbox)!.id;
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
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  }

  async function trash(user: TestUser) {
    const res = await api(user, 'GET', '/api/trash');
    expect(res.statusCode, res.body).toBe(200);
    return trashResponseSchema.parse(res.json()).tasks;
  }

  async function deleteTask(user: TestUser, id: string) {
    const res = await api(user, 'DELETE', `/api/tasks/${id}`);
    expect(res.statusCode, res.body).toBe(204);
  }

  async function changes(user: TestUser, since = 0) {
    const res = await api(user, 'GET', `/api/changes?since=${since}`);
    expect(res.statusCode, res.body).toBe(200);
    return changesResponseSchema.parse(res.json());
  }

  async function addChecklistItem(user: TestUser, taskId: string, title: string) {
    const res = await api(user, 'POST', `/api/tasks/${taskId}/checklist-items`, { title });
    expect(res.statusCode, res.body).toBe(201);
    return checklistItemSchema.parse(res.json());
  }

  async function rawTasks(ids: string[]) {
    return t.database.db.select().from(tasks).where(inArray(tasks.id, ids));
  }

  async function smartIds(user: TestUser): Promise<string[]> {
    const res = await api(user, 'GET', '/api/test/smart-candidates');
    expect(res.statusCode, res.body).toBe(200);
    return res.json().ids as string[];
  }

  describe('放弃', () => {
    it('keeps the task with its own timestamp, never as completed, and out of the open count', async () => {
      const listId = await newList(alice, '放弃清单');
      const task = await createTask(alice, { title: '不做了', listId });
      const keep = await createTask(alice, { title: '还要做', listId });
      clock.advance(60_000);
      const abandoned = await patchTask(alice, task.id, { status: 'abandoned' });
      expect(abandoned).toMatchObject({ status: 'abandoned', completedAt: null, abandonedAt: '2026-10-13T02:01:00.000Z' });

      // Still in its 清单 (kept as a record), listed after the open tasks.
      expect((await tasksOf(alice, listId)).map((x) => [x.title, x.status])).toEqual([
        ['还要做', 'open'],
        ['不做了', 'abandoned'],
      ]);
      const sidebar = sidebarResponseSchema.parse((await api(alice, 'GET', '/api/lists')).json());
      expect(sidebar.openTaskCounts[listId]).toBe(1);
      expect(keep.status).toBe('open');

      // Sync clients see the status too.
      const upsert = (await changes(alice)).entities.task?.upserts.find((u) => u.id === task.id);
      expect(upsert).toMatchObject({ status: 'abandoned', completedAt: null });
    });

    it('moves between 放弃, 完成 and open with the matching timestamps', async () => {
      const task = await createTask(alice, { title: '来回切换' });
      await patchTask(alice, task.id, { status: 'abandoned' });
      clock.advance(1_000);
      const completed = await patchTask(alice, task.id, { status: 'completed' });
      expect(completed).toMatchObject({ status: 'completed', abandonedAt: null });
      expect(completed.completedAt).not.toBeNull();
      const again = await patchTask(alice, task.id, { status: 'abandoned' });
      expect(again).toMatchObject({ status: 'abandoned', completedAt: null });
      expect(again.abandonedAt).not.toBeNull();
      const reopened = await patchTask(alice, task.id, { status: 'open' });
      expect(reopened).toMatchObject({ status: 'open', completedAt: null, abandonedAt: null });
    });

    it('abandons the open 子任务 below, and re-opening a 子任务 re-opens its abandoned parent', async () => {
      const parent = await createTask(alice, { title: '父' });
      const child = await createTask(alice, { title: '子', parentId: parent.id });
      const doneChild = await createTask(alice, { title: '已完成的子', parentId: parent.id });
      await patchTask(alice, doneChild.id, { status: 'completed' });
      await patchTask(alice, parent.id, { status: 'abandoned' });
      expect((await getTask(alice, child.id)).status).toBe('abandoned');
      // Completed stays completed: it was done.
      expect((await getTask(alice, doneChild.id)).status).toBe('completed');

      await patchTask(alice, child.id, { status: 'open' });
      expect((await getTask(alice, parent.id))).toMatchObject({ status: 'open', abandonedAt: null });
    });
  });

  describe('删除与回收站', () => {
    it('moves a task with its 子任务 and 检查项 into the 回收站 and leaves tombstones', async () => {
      const listId = await newList(alice, '删除清单');
      const root = await createTask(alice, { title: '要删的', listId });
      const child = await createTask(alice, { title: '跟着走的子任务', parentId: root.id });
      await patchTask(alice, child.id, { kind: 'checklist' });
      const item = await addChecklistItem(alice, child.id, '步骤一');
      const before = (await changes(alice)).revision;
      clock.advance(60_000);

      await deleteTask(alice, root.id);
      expect((await api(alice, 'GET', `/api/tasks/${root.id}`)).statusCode).toBe(404);
      expect((await api(alice, 'GET', `/api/tasks/${child.id}`)).statusCode).toBe(404);
      expect(await tasksOf(alice, listId)).toEqual([]);

      // Only the deleted task is listed; the 子任务 comes back with it.
      const listed = await trash(alice);
      expect(listed.map((x) => x.id)).toEqual([root.id]);
      expect(listed[0]).toMatchObject({ title: '要删的', listId, deletedAt: clock.now().toISOString() });

      const delta = await changes(alice, before);
      expect(delta.entities.task?.tombstones.map((x) => x.id).sort()).toEqual([root.id, child.id].sort());
      expect(delta.entities.checklistItem?.tombstones.map((x) => x.id)).toEqual([item.id]);
    });

    it('lists the most recently deleted first, and deleting a 子任务 alone leaves its parent', async () => {
      const parent = await createTask(alice, { title: '留下的父任务' });
      const child = await createTask(alice, { title: '单独删的子任务', parentId: parent.id });
      const other = await createTask(alice, { title: '后删的' });
      clock.advance(1_000);
      await deleteTask(alice, child.id);
      clock.advance(1_000);
      await deleteTask(alice, other.id);
      const titles = (await trash(alice)).map((x) => x.title);
      expect(titles.indexOf('后删的')).toBe(0);
      expect(titles.indexOf('单独删的子任务')).toBe(1);
      expect((await getTask(alice, parent.id)).status).toBe('open');
    });

    it('isolates users: no deleting, restoring or purging what is not yours', async () => {
      const mine = await createTask(alice, { title: 'alice 的' });
      expect((await api(bob, 'DELETE', `/api/tasks/${mine.id}`)).statusCode).toBe(404);
      await deleteTask(alice, mine.id);
      expect(await trash(bob)).toEqual([]);
      expect((await api(bob, 'POST', `/api/trash/${mine.id}/restore`)).statusCode).toBe(404);
      expect((await api(bob, 'DELETE', `/api/trash/${mine.id}`)).statusCode).toBe(404);
      expect((await api(bob, 'DELETE', '/api/trash')).statusCode).toBe(204);
      expect((await trash(alice)).some((x) => x.id === mine.id)).toBe(true);
      // Deleting twice is a 404: it is no longer a live task.
      expect((await api(alice, 'DELETE', `/api/tasks/${mine.id}`)).statusCode).toBe(404);
      expect((await api(alice, 'DELETE', '/api/tasks/not-a-uuid')).statusCode).toBe(404);
    });
  });

  describe('还原', () => {
    it('brings back the task, its 子任务 and 检查项 where they were, with new revisions', async () => {
      const listId = await newList(alice, '还原清单');
      const root = await createTask(alice, { title: '还原我', listId, priority: 'high' });
      const child = await createTask(alice, { title: '子任务也回来', parentId: root.id });
      await patchTask(alice, root.id, { kind: 'checklist' });
      const item = await addChecklistItem(alice, root.id, '检查项也回来');
      await deleteTask(alice, root.id);
      const before = (await changes(alice)).revision;

      const res = await api(alice, 'POST', `/api/trash/${root.id}/restore`);
      expect(res.statusCode, res.body).toBe(200);
      expect(taskSchema.parse(res.json())).toMatchObject({ id: root.id, listId, priority: 'high', parentId: null });
      const back = await tasksOf(alice, listId);
      expect(back.find((x) => x.id === root.id)?.parentId).toBeNull();
      expect(back.find((x) => x.id === child.id)?.parentId).toBe(root.id);
      expect(back).toHaveLength(2);
      const items = await api(alice, 'GET', `/api/tasks/${root.id}/checklist-items`);
      expect(items.json().items.map((x: { id: string }) => x.id)).toEqual([item.id]);
      expect((await trash(alice)).some((x) => x.id === root.id)).toBe(false);

      const delta = await changes(alice, before);
      expect(delta.entities.task?.upserts.map((x) => x.id).sort()).toEqual([root.id, child.id].sort());
      expect(delta.entities.checklistItem?.upserts.map((x) => x.id)).toEqual([item.id]);
      // 回收站 bookkeeping stays on the server.
      expect(JSON.stringify(delta)).not.toMatch(/trashRootId|purgedAt/);
      // Restoring twice: it is no longer in the 回收站.
      expect((await api(alice, 'POST', `/api/trash/${root.id}/restore`)).statusCode).toBe(404);
    });

    it('restores into the 收件箱 when the 清单 was deleted (deleting a 清单 trashes its tasks)', async () => {
      const listId = await newList(alice, '会被删的清单');
      const task = await createTask(alice, { title: '清单没了' });
      await patchTask(alice, task.id, { listId });
      const child = await createTask(alice, { title: '清单没了的子任务', parentId: task.id });
      expect((await api(alice, 'DELETE', `/api/lists/${listId}`)).statusCode).toBe(204);
      expect((await trash(alice)).map((x) => x.id)).toContain(task.id);

      const res = await api(alice, 'POST', `/api/trash/${task.id}/restore`);
      expect(res.statusCode, res.body).toBe(200);
      expect(taskSchema.parse(res.json()).listId).toBe(inboxId);
      expect((await getTask(alice, child.id))).toMatchObject({ listId: inboxId, parentId: task.id });
    });

    it('restores a 子任务 as a top-level task when its parent is gone', async () => {
      const parent = await createTask(alice, { title: '父任务也删了' });
      const child = await createTask(alice, { title: '先删的子任务', parentId: parent.id });
      await deleteTask(alice, child.id);
      await deleteTask(alice, parent.id);
      const res = await api(alice, 'POST', `/api/trash/${child.id}/restore`);
      expect(res.statusCode, res.body).toBe(200);
      expect(taskSchema.parse(res.json())).toMatchObject({ parentId: null, listId: inboxId });
      // The parent is still in the 回收站 and does not take the child back when restored.
      expect((await trash(alice)).map((x) => x.id)).toContain(parent.id);
    });

    it('restores under the parent when the parent is live again', async () => {
      const parent = await createTask(alice, { title: '父任务还在' });
      const child = await createTask(alice, { title: '回到父任务下', parentId: parent.id });
      await deleteTask(alice, child.id);
      const res = await api(alice, 'POST', `/api/trash/${child.id}/restore`);
      expect(taskSchema.parse(res.json())).toMatchObject({ parentId: parent.id });
    });
  });

  describe('彻底删除', () => {
    it('彻底删除 clears the content of the task, its 子任务 and 检查项; /api/changes still returns the tombstones', async () => {
      const root = await createTask(alice, { title: '机密标题', description: '机密描述', priority: 'high' });
      const child = await createTask(alice, { title: '机密子任务', parentId: root.id });
      await patchTask(alice, child.id, { kind: 'checklist' });
      const item = await addChecklistItem(alice, child.id, '机密检查项');
      await deleteTask(alice, root.id);

      expect((await api(alice, 'DELETE', `/api/trash/${root.id}`)).statusCode).toBe(204);
      expect((await trash(alice)).some((x) => x.id === root.id)).toBe(false);
      expect((await api(alice, 'POST', `/api/trash/${root.id}/restore`)).statusCode).toBe(404);
      expect((await api(alice, 'DELETE', `/api/trash/${root.id}`)).statusCode).toBe(404);

      const all = await changes(alice);
      expect(all.entities.task?.tombstones.map((x) => x.id)).toEqual(expect.arrayContaining([root.id, child.id]));
      expect(all.entities.checklistItem?.tombstones.map((x) => x.id)).toContain(item.id);
      expect(JSON.stringify(all)).not.toContain('机密');

      const rows = await rawTasks([root.id, child.id]);
      for (const row of rows) {
        expect(row).toMatchObject({ title: '', description: '', tagIds: [], priority: 'none', allDay: null });
        expect(row.deletedAt).not.toBeNull();
        expect(row.purgedAt).not.toBeNull();
      }
      const [itemRow] = await t.database.db.select().from(checklistItems).where(eq(checklistItems.id, item.id));
      expect(itemRow).toMatchObject({ title: '' });
    });

    it('清空回收站 purges every task of the user only', async () => {
      const a = await createTask(alice, { title: '清空一' });
      const b = await createTask(alice, { title: '清空二' });
      const bobs = await createTask(bob, { title: 'bob 的回收站' });
      await deleteTask(alice, a.id);
      await deleteTask(alice, b.id);
      await deleteTask(bob, bobs.id);
      expect((await api(alice, 'DELETE', '/api/trash')).statusCode).toBe(204);
      expect(await trash(alice)).toEqual([]);
      expect((await trash(bob)).map((x) => x.id)).toEqual([bobs.id]);
    });
  });

  describe('清单归档', () => {
    it('archives and unarchives a 清单; the 收件箱 cannot be archived', async () => {
      const listId = await newList(alice, '归档清单');
      clock.advance(1_000);
      const res = await api(alice, 'PATCH', `/api/lists/${listId}`, { archived: true });
      expect(res.statusCode, res.body).toBe(200);
      expect(listSchema.parse(res.json()).archivedAt).toBe(clock.now().toISOString());
      // Still part of the sidebar data (shown under 已归档的清单), and its tasks are still readable.
      const sidebar = sidebarResponseSchema.parse((await api(alice, 'GET', '/api/lists')).json());
      expect(sidebar.lists.find((l) => l.id === listId)?.archivedAt).toBe(clock.now().toISOString());
      expect((await api(alice, 'GET', `/api/tasks?listId=${listId}`)).statusCode).toBe(200);

      const back = await api(alice, 'PATCH', `/api/lists/${listId}`, { archived: false });
      expect(listSchema.parse(back.json()).archivedAt).toBeNull();

      const inbox = await api(alice, 'PATCH', `/api/lists/${inboxId}`, { archived: true });
      expect(inbox.statusCode).toBe(400);
      expect(inbox.json().error.code).toBe('inbox_protected');
      expect((await api(bob, 'PATCH', `/api/lists/${listId}`, { archived: true })).statusCode).toBe(404);
    });

    it('keeps the tasks of an archived 清单 out of the 智能清单 until it is unarchived', async () => {
      const dave = await t.createUser('dave');
      const listId = await newList(dave, '项目');
      const inList = await createTask(dave, { title: '项目里的', listId });
      const sub = await createTask(dave, { title: '项目里的子任务', parentId: inList.id });
      const inInbox = await createTask(dave, { title: '收件箱里的' });
      const deleted = await createTask(dave, { title: '删掉的' });
      await deleteTask(dave, deleted.id);
      expect((await smartIds(dave)).sort()).toEqual([inList.id, sub.id, inInbox.id].sort());

      await api(dave, 'PATCH', `/api/lists/${listId}`, { archived: true });
      expect(await smartIds(dave)).toEqual([inInbox.id]);
      // A task created in (or moved into) an archived 清单 stays out too.
      const later = await createTask(dave, { title: '归档后新建的', listId });
      expect(await smartIds(dave)).toEqual([inInbox.id]);

      await api(dave, 'PATCH', `/api/lists/${listId}`, { archived: false });
      expect((await smartIds(dave)).sort()).toEqual([inList.id, sub.id, inInbox.id, later.id].sort());
      // Other users' tasks never show up.
      expect(await smartIds(bob)).not.toContain(inInbox.id);
    });
  });
});

describe('回收站 30 天清理', () => {
  // Its own app and clock: the cleanup runs across all users.
  const clock = fixedClock('2026-11-01T00:00:00.000Z');
  let t: TestApp;
  let carol: TestUser;
  beforeAll(async () => {
    t = await createTestApp({ clock });
    carol = await t.createUser('carol');
  });
  afterAll(() => t.close());

  function api(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) {
    return t.app.inject({ method, url, headers: carol.headers, ...(payload ? { payload } : {}) });
  }
  async function createTask(payload: object): Promise<Task> {
    const res = await api('POST', '/api/tasks', payload);
    expect(res.statusCode, res.body).toBe(201);
    return taskSchema.parse(res.json());
  }
  async function deleteTask(id: string) {
    expect((await api('DELETE', `/api/tasks/${id}`)).statusCode).toBe(204);
  }
  async function trash() {
    return trashResponseSchema.parse((await api('GET', '/api/trash')).json()).tasks;
  }

  it('cleans up after 30 days by the injected clock, keeping the tombstones', async () => {
    const old = await createTask({ title: '30 天前删的' });
    const child = await createTask({ title: '30 天前删的子任务', parentId: old.id });
    await deleteTask(old.id);
    clock.advance(DAY);
    const recent = await createTask({ title: '29 天前删的' });
    await deleteTask(recent.id);

    // One millisecond short of 30 days: nothing is cleaned up.
    clock.advance(29 * DAY - 1);
    expect(await t.app.trash.purgeExpired()).toBe(0);
    expect((await trash()).map((x) => x.id)).toEqual([recent.id, old.id]);

    clock.advance(1);
    expect(await t.app.trash.purgeExpired()).toBe(1);
    expect((await trash()).map((x) => x.id)).toEqual([recent.id]);
    expect((await api('POST', `/api/trash/${old.id}/restore`)).statusCode).toBe(404);
    const rows = await t.database.db.select().from(tasks).where(inArray(tasks.id, [old.id, child.id]));
    expect(rows.map((r) => r.title)).toEqual(['', '']);
    expect(rows.every((r) => r.deletedAt !== null && r.purgedAt !== null)).toBe(true);

    const feed = changesResponseSchema.parse((await api('GET', '/api/changes?since=0')).json());
    expect(feed.entities.task?.tombstones.map((x) => x.id)).toEqual(expect.arrayContaining([old.id, child.id, recent.id]));
    expect(JSON.stringify(feed)).not.toContain('30 天前删的');

    // A day later the other one goes too; running again does nothing more.
    clock.advance(DAY);
    expect(await t.app.trash.purgeExpired()).toBe(1);
    expect(await t.app.trash.purgeExpired()).toBe(0);
    expect(await trash()).toEqual([]);
  });
});
