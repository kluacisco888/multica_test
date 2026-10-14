import { changesResponseSchema, DEFAULT_QUADRANTS, listSchema, settingsSchema, taskSchema, tasksResponseSchema, type Quadrant, type Task } from '@dida/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/*
 * 四象限 (spec 用户故事 72、73) over HTTP against a real database: default
 * quadrants by 优先级, rules saved in 设置, the matrix task set, and moving a
 * task to another quadrant by changing its 优先级. The clock is 2026-10-13
 * 10:00 in Shanghai.
 */

describe('四象限 API', () => {
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

  async function ok<T>(user: TestUser, method: 'GET' | 'POST' | 'PATCH', url: string, payload: object | undefined, parse: (v: unknown) => T) {
    const res = await api(user, method, url, payload);
    expect(res.statusCode, res.body).toBeLessThan(300);
    return parse(res.json());
  }

  const createTask = (user: TestUser, payload: object) => ok(user, 'POST', '/api/tasks', payload, (v) => taskSchema.parse(v));
  const createList = (user: TestUser, payload: object) => ok(user, 'POST', '/api/lists', payload, (v) => listSchema.parse(v));
  const settings = (user: TestUser) => ok(user, 'GET', '/api/settings', undefined, (v) => settingsSchema.parse(v));
  const saveQuadrants = (user: TestUser, matrixQuadrants: unknown) =>
    ok(user, 'PATCH', '/api/settings', { matrixQuadrants }, (v) => settingsSchema.parse(v));
  const matrix = (user: TestUser) => ok(user, 'GET', '/api/tasks?view=matrix', undefined, (v) => tasksResponseSchema.parse(v).tasks);
  const titles = (tasks: Task[]) => tasks.map((x) => x.title).sort();
  const withRules = (rules: Record<string, unknown>[]): object[] => rules.map((r, i) => ({ name: `象限${i + 1}`, rules: r }));

  it('starts with the four default quadrants: 高 / 中 / 低 / 无优先级', async () => {
    const s = await settings(alice);
    expect(s.matrixQuadrants).toEqual(DEFAULT_QUADRANTS);
  });

  it('shows open and completed tasks of every quadrant, never 放弃, deleted or archived-清单 ones, and only the user’s own', async () => {
    const user = await t.createUser('matrix-tasks');
    await createTask(user, { title: '高', priority: 'high' });
    await createTask(user, { title: '中', priority: 'medium' });
    await createTask(user, { title: '低', priority: 'low' });
    await createTask(user, { title: '无' });
    const done = await createTask(user, { title: '完成的高', priority: 'high' });
    await ok(user, 'PATCH', `/api/tasks/${done.id}`, { status: 'completed' }, (v) => v);
    const abandoned = await createTask(user, { title: '放弃的', priority: 'high' });
    await ok(user, 'PATCH', `/api/tasks/${abandoned.id}`, { status: 'abandoned' }, (v) => v);
    const deleted = await createTask(user, { title: '删除的', priority: 'high' });
    expect((await api(user, 'DELETE', `/api/tasks/${deleted.id}`)).statusCode).toBe(204);
    const archived = await createList(user, { name: '归档的清单' });
    await createTask(user, { title: '归档清单里的', listId: archived.id, priority: 'high' });
    await ok(user, 'PATCH', `/api/lists/${archived.id}`, { archived: true }, (v) => v);
    const hidden = await createList(user, { name: '不进智能清单', excludeFromSmartLists: true });
    await createTask(user, { title: '不进智能清单的', listId: hidden.id });
    await createTask(bob, { title: 'bob 的', priority: 'high' });

    expect(titles(await matrix(user))).toEqual(['中', '低', '无', '不进智能清单的', '完成的高', '高'].sort());
    expect(titles(await matrix(bob))).toEqual(['bob 的']);
  });

  it('saves changed rules per user; they survive a reload and drive the task set', async () => {
    const user = await t.createUser('matrix-rules');
    const work = await createList(user, { name: '工作' });
    await createTask(user, { title: '工作里的低', listId: work.id, priority: 'low' });
    await createTask(user, { title: '收件箱的高', priority: 'high' });
    await createTask(user, { title: '收件箱的无' });

    const rules = withRules([{ listIds: [work.id] }, { priorities: ['high'] }, { priorities: ['medium'] }, { dates: ['today'] }]);
    const saved = await saveQuadrants(user, rules);
    expect(saved.matrixQuadrants.map((q) => q.name)).toEqual(['象限1', '象限2', '象限3', '象限4']);
    expect(saved.matrixQuadrants[0]?.rules.listIds).toEqual([work.id]);

    // A fresh read (a page reload) returns the saved rules.
    expect((await settings(user)).matrixQuadrants).toEqual(saved.matrixQuadrants);
    // No quadrant takes 收件箱的无 now.
    expect(titles(await matrix(user))).toEqual(['工作里的低', '收件箱的高'].sort());
    // Other users keep the defaults.
    expect((await settings(bob)).matrixQuadrants).toEqual(DEFAULT_QUADRANTS);

    // null goes back to the defaults.
    expect((await saveQuadrants(user, null)).matrixQuadrants).toEqual(DEFAULT_QUADRANTS);
    expect(titles(await matrix(user))).toEqual(['工作里的低', '收件箱的无', '收件箱的高'].sort());
  });

  it('a changed rule is a new settings revision in /api/changes (ADR-0004)', async () => {
    const user = await t.createUser('matrix-sync');
    const before = changesResponseSchema.parse((await api(user, 'GET', '/api/changes?since=0')).json()).revision;
    await saveQuadrants(user, withRules([{ priorities: ['low'] }, {}, {}, {}]));
    const changes = changesResponseSchema.parse((await api(user, 'GET', `/api/changes?since=${before}`)).json());
    expect(changes.revision).toBeGreaterThan(before);
    const upserts = changes.entities.settings?.upserts as unknown as { matrixQuadrants: Quadrant[] }[];
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.matrixQuadrants[0]?.rules.priorities).toEqual(['low']);
  });

  it('rejects anything but four valid quadrants, and 清单 / 标签 of other users', async () => {
    const bobList = await createList(bob, { name: 'bob 的清单' });
    const bobTag = await ok(bob, 'POST', '/api/tags', { name: 'bob标签' }, (v) => v as { id: string });
    const bad: [unknown, number, string?][] = [
      [withRules([{}, {}, {}]), 400],
      [withRules([{}, {}, {}, {}, {}]), 400],
      [withRules([{}, {}, {}, {}]).map((q) => ({ ...q, name: '' })), 400],
      [withRules([{ priorities: ['urgent'] }, {}, {}, {}]), 400],
      [withRules([{ listIds: [bobList.id] }, {}, {}, {}]), 400, 'invalid_list'],
      [withRules([{ tagIds: [bobTag.id] }, {}, {}, {}]), 400, 'invalid_tags'],
    ];
    for (const [matrixQuadrants, status, code] of bad) {
      const res = await api(alice, 'PATCH', '/api/settings', { matrixQuadrants });
      expect(res.statusCode, JSON.stringify(matrixQuadrants)).toBe(status);
      if (code) expect(res.json().error.code).toBe(code);
    }
    expect((await settings(alice)).matrixQuadrants).toEqual(DEFAULT_QUADRANTS);
  });

  it('a deleted 清单 drops out of the rules', async () => {
    const user = await t.createUser('matrix-deleted');
    const list = await createList(user, { name: '要删的' });
    await saveQuadrants(user, withRules([{ listIds: [list.id] }, {}, {}, {}]));
    expect((await api(user, 'DELETE', `/api/lists/${list.id}`)).statusCode).toBe(204);
    expect((await settings(user)).matrixQuadrants[0]?.rules.listIds).toEqual([]);
  });

  it('moving a task to another quadrant changes its 优先级', async () => {
    const user = await t.createUser('matrix-move');
    const task = await createTask(user, { title: '要移动的' });
    // Dropped on quadrant 一 (高优先级): the client patches the 优先级.
    await ok(user, 'PATCH', `/api/tasks/${task.id}`, { priority: 'high' }, (v) => v);
    const [moved] = await matrix(user);
    expect(moved).toMatchObject({ id: task.id, priority: 'high' });
    expect((await api(bob, 'PATCH', `/api/tasks/${task.id}`, { priority: 'low' })).statusCode).toBe(404);
  });

  it('needs a session', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/tasks?view=matrix' })).statusCode).toBe(401);
    expect((await api(alice, 'GET', '/api/tasks?view=board')).statusCode).toBe(400);
  });
});
