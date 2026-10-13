import {
  changesResponseSchema,
  kanbanColumnSchema,
  kanbanColumnsResponseSchema,
  listSchema,
  taskSchema,
  tasksResponseSchema,
  trashResponseSchema,
  type KanbanColumn,
  type Task,
} from '@dida/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/*
 * 看板视图 (EURO-18, spec 用户故事 66、67): 看板分栏 of a 清单 — create, rename,
 * reorder, delete (tasks into the 回收站, or moved to another 分栏 / 未分组, like
 * the reference's 删除分组 dialog) — and each 任务 remembering its 分栏.
 */

describe('看板分栏 API', () => {
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

  async function created<T>(user: TestUser, url: string, payload: object, parse: (v: unknown) => T): Promise<T> {
    const res = await api(user, 'POST', url, payload);
    expect(res.statusCode, res.body).toBe(201);
    return parse(res.json());
  }

  const createList = (user: TestUser, name: string) => created(user, '/api/lists', { name }, (v) => listSchema.parse(v));
  const createColumn = (user: TestUser, listId: string, name: string, extra: object = {}) =>
    created(user, '/api/kanban-columns', { listId, name, ...extra }, (v) => kanbanColumnSchema.parse(v));
  const createTask = (user: TestUser, payload: object) => created(user, '/api/tasks', payload, (v) => taskSchema.parse(v));

  async function columnsOf(user: TestUser, listId: string): Promise<KanbanColumn[]> {
    const res = await api(user, 'GET', `/api/kanban-columns?listId=${listId}`);
    expect(res.statusCode, res.body).toBe(200);
    return kanbanColumnsResponseSchema.parse(res.json()).columns;
  }

  async function tasksOf(user: TestUser, listId: string): Promise<Task[]> {
    const res = await api(user, 'GET', `/api/tasks?listId=${listId}`);
    expect(res.statusCode, res.body).toBe(200);
    return tasksResponseSchema.parse(res.json()).tasks;
  }

  async function patchTask(user: TestUser, id: string, patch: object): Promise<Task> {
    const res = await api(user, 'PATCH', `/api/tasks/${id}`, patch);
    expect(res.statusCode, res.body).toBe(200);
    return taskSchema.parse(res.json());
  }

  const columnOf = async (user: TestUser, listId: string, title: string) =>
    (await tasksOf(user, listId)).find((x) => x.title === title)?.columnId;

  describe('分栏', () => {
    it('creates 分栏 at the right end and lists them left to right', async () => {
      const list = await createList(alice, '项目');
      expect(await columnsOf(alice, list.id)).toEqual([]);
      const todo = await createColumn(alice, list.id, '待办');
      const doing = await createColumn(alice, list.id, ' 进行中 ');
      expect(doing.name).toBe('进行中');
      expect(doing.listId).toBe(list.id);
      expect((await columnsOf(alice, list.id)).map((c) => c.name)).toEqual(['待办', '进行中']);
      expect(todo.sortOrder < doing.sortOrder).toBe(true);
    });

    it('renames and reorders a 分栏', async () => {
      const list = await createList(alice, '排序');
      const a = await createColumn(alice, list.id, 'A');
      const b = await createColumn(alice, list.id, 'B');
      const renamed = await api(alice, 'PATCH', `/api/kanban-columns/${a.id}`, { name: '第一' });
      expect(renamed.statusCode, renamed.body).toBe(200);
      expect(kanbanColumnSchema.parse(renamed.json()).name).toBe('第一');
      // Move B in front of A.
      const before = String.fromCharCode(a.sortOrder.charCodeAt(0) - 1);
      expect((await api(alice, 'PATCH', `/api/kanban-columns/${b.id}`, { sortOrder: before })).statusCode).toBe(200);
      expect((await columnsOf(alice, list.id)).map((c) => c.name)).toEqual(['B', '第一']);
    });

    it('rejects an empty name, a duplicate name in the same 清单 and an unknown 清单', async () => {
      const list = await createList(alice, '重名');
      const other = await createList(alice, '别的清单');
      const a = await createColumn(alice, list.id, '待办');
      await createColumn(alice, list.id, '完成');
      expect((await api(alice, 'POST', '/api/kanban-columns', { listId: list.id, name: '  ' })).statusCode).toBe(400);
      const dup = await api(alice, 'POST', '/api/kanban-columns', { listId: list.id, name: '待办' });
      expect(dup.statusCode).toBe(409);
      expect(dup.json()).toMatchObject({ error: { code: 'column_name_taken', message: '分组名称已存在' } });
      expect((await api(alice, 'PATCH', `/api/kanban-columns/${a.id}`, { name: '完成' })).statusCode).toBe(409);
      // Same name in another 清单 is fine; renaming to its own name too.
      await createColumn(alice, other.id, '待办');
      expect((await api(alice, 'PATCH', `/api/kanban-columns/${a.id}`, { name: '待办' })).statusCode).toBe(200);
      const unknown = await api(alice, 'POST', '/api/kanban-columns', { listId: '00000000-0000-4000-8000-000000000000', name: 'x' });
      expect(unknown.statusCode).toBe(400);
      expect(unknown.json()).toMatchObject({ error: { code: 'invalid_list' } });
    });

    it('works in the 收件箱 too', async () => {
      const inbox = (await api(alice, 'GET', '/api/lists')).json().lists[0] as { id: string; isInbox: boolean };
      expect(inbox.isInbox).toBe(true);
      const column = await createColumn(alice, inbox.id, '收件箱分组');
      expect((await columnsOf(alice, inbox.id)).map((c) => c.id)).toContain(column.id);
    });
  });

  describe('任务 in 分栏', () => {
    it('creates a task in a 分栏 and moves it to another one; the 分栏 is still there after re-reading (刷新)', async () => {
      const list = await createList(alice, '拖动');
      const todo = await createColumn(alice, list.id, '待办');
      const done = await createColumn(alice, list.id, '完成');
      const task = await createTask(alice, { listId: list.id, title: '写周报', columnId: todo.id });
      expect(task.columnId).toBe(todo.id);
      expect((await createTask(alice, { listId: list.id, title: '默认' })).columnId).toBeNull();

      const moved = await patchTask(alice, task.id, { columnId: done.id, sortOrder: 'k' });
      expect(moved).toMatchObject({ columnId: done.id, sortOrder: 'k' });
      expect(await columnOf(alice, list.id, '写周报')).toBe(done.id);
      expect(taskSchema.parse((await api(alice, 'GET', `/api/tasks/${task.id}`)).json()).columnId).toBe(done.id);

      // Back to 未分组.
      expect((await patchTask(alice, task.id, { columnId: null })).columnId).toBeNull();
    });

    it('rejects a 分栏 of another 清单, a deleted one and another user’s', async () => {
      const list = await createList(alice, '校验');
      const other = await createList(alice, '另一个');
      const foreign = await createColumn(alice, other.id, '外面');
      const gone = await createColumn(alice, list.id, '删掉的');
      expect((await api(alice, 'DELETE', `/api/kanban-columns/${gone.id}`)).statusCode).toBe(204);
      const bobList = await createList(bob, 'bob');
      const bobColumn = await createColumn(bob, bobList.id, 'bob 的');
      const task = await createTask(alice, { listId: list.id, title: 't' });

      for (const columnId of [foreign.id, gone.id, bobColumn.id]) {
        const patch = await api(alice, 'PATCH', `/api/tasks/${task.id}`, { columnId });
        expect(patch.statusCode, columnId).toBe(400);
        expect(patch.json()).toMatchObject({ error: { code: 'invalid_column' } });
        const create = await api(alice, 'POST', '/api/tasks', { listId: list.id, title: 'x', columnId });
        expect(create.statusCode, columnId).toBe(400);
      }
      // A 分栏 of the target 清单 is fine when moving with it.
      const moved = await patchTask(alice, task.id, { listId: other.id, columnId: foreign.id });
      expect(moved).toMatchObject({ listId: other.id, columnId: foreign.id });
    });

    it('moving a task to another 清单 puts it into 未分组 there', async () => {
      const list = await createList(alice, '原清单');
      const target = await createList(alice, '新清单');
      const column = await createColumn(alice, list.id, '待办');
      const task = await createTask(alice, { listId: list.id, title: '搬家', columnId: column.id });
      expect((await patchTask(alice, task.id, { listId: target.id })).columnId).toBeNull();
    });

    it('keeps the 分栏 for the next instance of a 重复任务', async () => {
      const list = await createList(alice, '重复');
      const column = await createColumn(alice, list.id, '每天');
      const task = await createTask(alice, {
        listId: list.id,
        title: '打卡',
        columnId: column.id,
        dates: { allDay: true, startDate: null, dueDate: '2026-10-13' },
        repeat: { freq: 'daily' },
      });
      await patchTask(alice, task.id, { status: 'completed' });
      const next = (await tasksOf(alice, list.id)).find((x) => x.status === 'open' && x.title === '打卡');
      expect(next?.columnId).toBe(column.id);
    });
  });

  describe('删除分栏', () => {
    it('by default moves its tasks (with 子任务) into the 回收站; restoring puts them into 未分组', async () => {
      const list = await createList(alice, '删分栏');
      const keep = await createColumn(alice, list.id, '保留');
      const drop = await createColumn(alice, list.id, '删除');
      const parent = await createTask(alice, { listId: list.id, title: '父', columnId: drop.id });
      await createTask(alice, { parentId: parent.id, title: '子' });
      await createTask(alice, { listId: list.id, title: '留下', columnId: keep.id });

      expect((await api(alice, 'DELETE', `/api/kanban-columns/${drop.id}`)).statusCode).toBe(204);
      expect((await columnsOf(alice, list.id)).map((c) => c.name)).toEqual(['保留']);
      expect((await tasksOf(alice, list.id)).map((x) => x.title)).toEqual(['留下']);
      const trash = trashResponseSchema.parse((await api(alice, 'GET', '/api/trash')).json()).tasks;
      expect(trash.map((x) => x.title)).toContain('父');

      expect((await api(alice, 'POST', `/api/trash/${parent.id}/restore`)).statusCode).toBe(200);
      const restored = await tasksOf(alice, list.id);
      expect(restored.find((x) => x.title === '父')?.columnId).toBeNull();
      expect(restored.map((x) => x.title).sort()).toEqual(['子', '父', '留下'].sort());
      expect((await api(alice, 'PATCH', `/api/kanban-columns/${drop.id}`, { name: 'x' })).statusCode).toBe(404);
    });

    it('can move its tasks to another 分栏 or to 未分组 instead', async () => {
      const list = await createList(alice, '移动任务');
      const a = await createColumn(alice, list.id, 'A');
      const b = await createColumn(alice, list.id, 'B');
      const c = await createColumn(alice, list.id, 'C');
      await createTask(alice, { listId: list.id, title: 'a1', columnId: a.id });
      const done = await createTask(alice, { listId: list.id, title: 'a2', columnId: a.id });
      await patchTask(alice, done.id, { status: 'completed' });
      await createTask(alice, { listId: list.id, title: 'c1', columnId: c.id });

      const res = await api(alice, 'DELETE', `/api/kanban-columns/${a.id}?tasks=move&moveTo=${b.id}`);
      expect(res.statusCode, res.body).toBe(204);
      expect(await columnOf(alice, list.id, 'a1')).toBe(b.id);
      expect(await columnOf(alice, list.id, 'a2')).toBe(b.id);

      expect((await api(alice, 'DELETE', `/api/kanban-columns/${c.id}?tasks=move`)).statusCode).toBe(204);
      expect(await columnOf(alice, list.id, 'c1')).toBeNull();
      expect((await tasksOf(alice, list.id)).length).toBe(3);
    });

    it('rejects moving the tasks into itself, into another 清单’s 分栏 or a bad query', async () => {
      const list = await createList(alice, '坏目标');
      const other = await createList(alice, '其他清单');
      const a = await createColumn(alice, list.id, 'A');
      const foreign = await createColumn(alice, other.id, 'X');
      for (const url of [
        `/api/kanban-columns/${a.id}?tasks=move&moveTo=${a.id}`,
        `/api/kanban-columns/${a.id}?tasks=move&moveTo=${foreign.id}`,
        `/api/kanban-columns/${a.id}?tasks=delete&moveTo=${foreign.id}`,
        `/api/kanban-columns/${a.id}?tasks=keep`,
      ]) {
        expect((await api(alice, 'DELETE', url)).statusCode, url).toBe(400);
      }
      expect((await columnsOf(alice, list.id)).map((c) => c.id)).toEqual([a.id]);
    });

    it('deleting a 清单 deletes its 分栏 (tombstones in /api/changes)', async () => {
      const before = changesResponseSchema.parse((await api(alice, 'GET', '/api/changes?since=0')).json()).revision;
      const list = await createList(alice, '整个删掉');
      const column = await createColumn(alice, list.id, '待办');
      const after = changesResponseSchema.parse((await api(alice, 'GET', `/api/changes?since=${before}`)).json());
      expect(after.entities.kanbanColumn?.upserts.map((u) => u.id)).toEqual([column.id]);

      expect((await api(alice, 'DELETE', `/api/lists/${list.id}`)).statusCode).toBe(204);
      expect((await api(alice, 'GET', `/api/kanban-columns?listId=${list.id}`)).statusCode).toBe(404);
      const changes = changesResponseSchema.parse((await api(alice, 'GET', `/api/changes?since=${after.revision}`)).json());
      expect(changes.entities.kanbanColumn?.tombstones.map((x) => x.id)).toEqual([column.id]);
    });
  });

  describe('数据隔离', () => {
    it('another user’s 清单 and 分栏 are 404 / invalid', async () => {
      const list = await createList(alice, '私有');
      const column = await createColumn(alice, list.id, '私有分栏');
      expect((await api(bob, 'GET', `/api/kanban-columns?listId=${list.id}`)).statusCode).toBe(404);
      expect((await api(bob, 'POST', '/api/kanban-columns', { listId: list.id, name: 'x' })).statusCode).toBe(400);
      expect((await api(bob, 'PATCH', `/api/kanban-columns/${column.id}`, { name: 'x' })).statusCode).toBe(404);
      expect((await api(bob, 'DELETE', `/api/kanban-columns/${column.id}`)).statusCode).toBe(404);
      expect((await columnsOf(alice, list.id)).map((c) => c.name)).toEqual(['私有分栏']);
      const changes = changesResponseSchema.parse((await api(bob, 'GET', '/api/changes?since=0')).json());
      expect(changes.entities.kanbanColumn?.upserts.map((u) => u.id)).not.toContain(column.id);
    });

    it('requires a session', async () => {
      const res = await t.app.inject({ method: 'GET', url: '/api/kanban-columns?listId=00000000-0000-4000-8000-000000000000' });
      expect(res.statusCode).toBe(401);
    });
  });
});
