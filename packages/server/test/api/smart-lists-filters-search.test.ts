import {
  changesResponseSchema,
  filterSchema,
  listSchema,
  searchResponseSchema,
  settingsSchema,
  smartListCountsResponseSchema,
  taskSchema,
  tasksResponseSchema,
  type Task,
} from '@dida/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/*
 * 智能清单, 不进智能清单, 过滤器 and 全局搜索 (spec 用户故事 17、59–64), over HTTP
 * against a real database. The clock is 2026-10-13 10:00 in Shanghai (周二).
 */

const NOW = '2026-10-13T02:00:00.000Z';

describe('智能清单, 过滤器 and 搜索 API', () => {
  const clock = fixedClock(NOW);
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

  const createList = (user: TestUser, payload: object) => ok(user, 'POST', '/api/lists', payload, (v) => listSchema.parse(v));
  const createTask = (user: TestUser, payload: object) => ok(user, 'POST', '/api/tasks', payload, (v) => taskSchema.parse(v));
  const patchTask = (user: TestUser, id: string, patch: object) =>
    ok(user, 'PATCH', `/api/tasks/${id}`, patch, (v) => taskSchema.parse(v));
  const createTag = (user: TestUser, payload: object) =>
    ok(user, 'POST', '/api/tags', payload, (v) => v as { id: string; name: string });
  const titles = (tasks: Task[]) => tasks.map((x) => x.title).sort();

  async function view(user: TestUser, query: string): Promise<Task[]> {
    return ok(user, 'GET', `/api/tasks?${query}`, undefined, (v) => tasksResponseSchema.parse(v).tasks);
  }
  const smart = (user: TestUser, id: string) => view(user, `smart=${id}`);
  const day = (dueDate: string, startDate: string | null = null) => ({ allDay: true, startDate, dueDate });

  describe('智能清单 rules', () => {
    let user: TestUser;
    beforeAll(async () => {
      user = await t.createUser('smart-rules');
      await createTask(user, { title: '无日期' });
      await createTask(user, { title: '过期', dates: day('2026-10-01') });
      await createTask(user, { title: '今天', dates: day('2026-10-13') });
      await createTask(user, { title: '今天晚上', dates: { allDay: false, dueAt: '2026-10-13T13:00:00.000Z' } });
      await createTask(user, { title: '明天', dates: day('2026-10-14') });
      await createTask(user, { title: '跨今天的时间段', dates: day('2026-10-15', '2026-10-11') });
      await createTask(user, { title: '第 7 天', dates: day('2026-10-19') });
      await createTask(user, { title: '第 8 天', dates: day('2026-10-20') });
      await createTask(user, { title: '低优先级', priority: 'low' });
      const done = await createTask(user, { title: '今天完成', dates: day('2026-09-01') });
      await patchTask(user, done.id, { status: 'completed' });
      const doneTomorrow = await createTask(user, { title: '明天的已完成', dates: day('2026-10-14') });
      await patchTask(user, doneTomorrow.id, { status: 'completed' });
      const parent = await createTask(user, { title: '父任务' });
      await createTask(user, { title: '今天的子任务', parentId: parent.id, dates: day('2026-10-13') });
    });

    it('今天: dated today (also via a range or a time), overdue, completed today', async () => {
      // 明天的已完成 was completed today (the clock is fixed), so it shows in 今天 too.
      expect(titles(await smart(user, 'today'))).toEqual(
        ['今天', '今天完成', '今天晚上', '今天的子任务', '明天的已完成', '跨今天的时间段', '过期'].sort(),
      );
    });

    it('明天: dated tomorrow, no overdue tasks', async () => {
      expect(titles(await smart(user, 'tomorrow'))).toEqual(['明天', '明天的已完成', '跨今天的时间段'].sort());
    });

    it('最近 7 天: today … today + 6 and overdue', async () => {
      expect(titles(await smart(user, 'week'))).toEqual(
        ['今天', '今天完成', '今天晚上', '今天的子任务', '明天', '明天的已完成', '第 7 天', '跨今天的时间段', '过期'].sort(),
      );
    });

    it('已完成 and 不重要的', async () => {
      expect(titles(await smart(user, 'completed'))).toEqual(['今天完成', '明天的已完成'].sort());
      expect(titles(await smart(user, 'notImportant'))).toEqual(['低优先级']);
    });

    it('sidebar counts are the open tasks of 今天 / 明天 / 最近7天', async () => {
      const counts = await ok(user, 'GET', '/api/smart-lists', undefined, (v) => smartListCountsResponseSchema.parse(v).counts);
      expect(counts).toEqual({ today: 5, tomorrow: 2, week: 7 });
    });

    it('uses the user’s time zone for "today"', async () => {
      const night = await t.createUser('smart-tz');
      // 2026-10-13 23:30 in Shanghai, already the 14th in Tokyo.
      clock.set('2026-10-13T15:30:00.000Z');
      try {
        await createTask(night, { title: '13 日', dates: day('2026-10-13') });
        expect(titles(await smart(night, 'today'))).toEqual(['13 日']);
        await ok(night, 'PATCH', '/api/settings', { timeZone: 'Asia/Tokyo' }, (v) => v);
        // In Tokyo it is the 14th: the task is overdue, still in 今天, and no longer in 明天.
        expect(titles(await smart(night, 'today'))).toEqual(['13 日']);
        expect(titles(await smart(night, 'tomorrow'))).toEqual([]);
      } finally {
        clock.set(NOW);
      }
    });

    it('moves tasks in and out as they change', async () => {
      const task = await createTask(user, { title: '会变的', dates: day('2026-10-13') });
      expect(titles(await smart(user, 'today'))).toContain('会变的');
      await patchTask(user, task.id, { dates: day('2026-10-14') });
      expect(titles(await smart(user, 'today'))).not.toContain('会变的');
      expect(titles(await smart(user, 'tomorrow'))).toContain('会变的');
      await patchTask(user, task.id, { status: 'completed' });
      expect(titles(await smart(user, 'completed'))).toContain('会变的');
    });

    it('rejects unknown smart lists', async () => {
      expect((await api(user, 'GET', '/api/tasks?smart=someday')).statusCode).toBe(400);
      expect((await api(user, 'GET', '/api/tasks?smart=today&listId=00000000-0000-4000-8000-000000000000')).statusCode).toBe(400);
    });
  });

  describe('不进智能清单', () => {
    let user: TestUser;
    let hidden: { id: string };
    beforeAll(async () => {
      user = await t.createUser('excluded');
      hidden = await createList(user, { name: '私密', excludeFromSmartLists: true });
      await createTask(user, { title: '私密今天 关键词', listId: hidden.id, dates: day('2026-10-13'), priority: 'low' });
      await createTask(user, { title: '公开今天 关键词', dates: day('2026-10-13'), priority: 'low' });
      const done = await createTask(user, { title: '私密已完成', listId: hidden.id });
      await patchTask(user, done.id, { status: 'completed' });
    });

    it('keeps the 清单 out of every smart list and their counts', async () => {
      for (const id of ['today', 'week', 'completed', 'notImportant']) {
        const found = titles(await smart(user, id));
        expect(found.filter((x) => x.startsWith('私密')), id).toEqual([]);
      }
      expect(titles(await smart(user, 'today'))).toEqual(['公开今天 关键词']);
      const counts = await ok(user, 'GET', '/api/smart-lists', undefined, (v) => smartListCountsResponseSchema.parse(v).counts);
      expect(counts.today).toBe(1);
    });

    it('its tasks are still found by search and selected by filters', async () => {
      const found = await ok(user, 'GET', `/api/search?q=${encodeURIComponent('关键词')}`, undefined, (v) => searchResponseSchema.parse(v));
      expect(titles(found.tasks)).toEqual(['公开今天 关键词', '私密今天 关键词']);
      const filter = await ok(user, 'POST', '/api/filters', { name: '今天', rules: { dates: ['today'] } }, (v) => filterSchema.parse(v));
      expect(titles(await view(user, `filterId=${filter.id}`))).toEqual(['公开今天 关键词', '私密今天 关键词']);
      const byList = await ok(user, 'POST', '/api/filters', { name: '私密', rules: { listIds: [hidden.id] } }, (v) => filterSchema.parse(v));
      expect(titles(await view(user, `filterId=${byList.id}`))).toEqual(['私密今天 关键词', '私密已完成']);
    });

    it('switching it off brings the tasks back; the 清单 view itself is unaffected', async () => {
      expect(titles(await view(user, `listId=${hidden.id}`))).toEqual(['私密今天 关键词', '私密已完成']);
      const updated = await ok(user, 'PATCH', `/api/lists/${hidden.id}`, { excludeFromSmartLists: false }, (v) => listSchema.parse(v));
      expect(updated.excludeFromSmartLists).toBe(false);
      expect(titles(await smart(user, 'today'))).toEqual(['公开今天 关键词', '私密今天 关键词', '私密已完成']);
      await ok(user, 'PATCH', `/api/lists/${hidden.id}`, { excludeFromSmartLists: true }, (v) => v);
    });

    it('the sidebar reports the switch; the 收件箱 cannot be changed', async () => {
      const sidebar = await ok(user, 'GET', '/api/lists', undefined, (v) => v as { lists: { id: string; isInbox: boolean; excludeFromSmartLists: boolean }[] });
      expect(sidebar.lists.find((l) => l.id === hidden.id)?.excludeFromSmartLists).toBe(true);
      const inbox = sidebar.lists.find((l) => l.isInbox);
      expect(inbox?.excludeFromSmartLists).toBe(false);
      expect((await api(user, 'PATCH', `/api/lists/${inbox?.id}`, { excludeFromSmartLists: true })).statusCode).toBe(400);
    });

  });

  describe('归档 清单 (EURO-15)', () => {
    let user: TestUser;
    let project: { id: string };
    const archive = (archived: boolean) => ok(user, 'PATCH', `/api/lists/${project.id}`, { archived }, (v) => listSchema.parse(v));
    const counts = () => ok(user, 'GET', '/api/smart-lists', undefined, (v) => smartListCountsResponseSchema.parse(v).counts);
    const ALL = { today: ['收件箱今天'], tomorrow: [] as string[], week: ['收件箱今天'], completed: [] as string[], notImportant: [] as string[] };
    const WITH_PROJECT = {
      today: ['收件箱今天', '项目今天 归档词', '项目今天的子任务', '项目已完成'].sort(),
      tomorrow: ['项目明天'],
      week: ['收件箱今天', '项目今天 归档词', '项目今天的子任务', '项目已完成', '项目明天'].sort(),
      completed: ['项目已完成'],
      notImportant: ['项目今天 归档词'],
    };

    beforeAll(async () => {
      user = await t.createUser('archived');
      project = await createList(user, { name: '项目' });
      await createTask(user, { title: '收件箱今天', dates: day('2026-10-13') });
      const parent = await createTask(user, { title: '项目今天 归档词', listId: project.id, dates: day('2026-10-13'), priority: 'low' });
      await createTask(user, { title: '项目今天的子任务', parentId: parent.id, dates: day('2026-10-13') });
      await createTask(user, { title: '项目明天', listId: project.id, dates: day('2026-10-14') });
      const done = await createTask(user, { title: '项目已完成', listId: project.id, dates: day('2026-10-13') });
      await patchTask(user, done.id, { status: 'completed' });
    });

    it('takes the 清单 out of every smart list and the counts while archived, and back when unarchived', async () => {
      const lists = async () =>
        Object.fromEntries(await Promise.all(Object.keys(ALL).map(async (id) => [id, titles(await smart(user, id))])));
      expect(await lists()).toEqual(WITH_PROJECT);
      expect(await counts()).toEqual({ today: 3, tomorrow: 1, week: 4 });

      await archive(true);
      expect(await lists()).toEqual(ALL);
      expect(await counts()).toEqual({ today: 1, tomorrow: 0, week: 1 });
      // A task created in the archived 清单 stays out too.
      await createTask(user, { title: '归档后新建', listId: project.id, dates: day('2026-10-13') });
      expect(titles(await smart(user, 'today'))).toEqual(['收件箱今天']);

      await archive(false);
      expect((await lists()).today).toEqual([...WITH_PROJECT.today, '归档后新建'].sort());
      expect(await counts()).toEqual({ today: 4, tomorrow: 1, week: 5 });
    });

    it('its tasks are still found by search and selected by filters, and its own view still lists them', async () => {
      await archive(true);
      try {
        const found = await ok(user, 'GET', `/api/search?q=${encodeURIComponent('归档词')}`, undefined, (v) => searchResponseSchema.parse(v));
        expect(titles(found.tasks)).toEqual(['项目今天 归档词']);
        const filter = await ok(user, 'POST', '/api/filters', { name: '项目', rules: { listIds: [project.id] } }, (v) => filterSchema.parse(v));
        expect(titles(await view(user, `filterId=${filter.id}`))).toContain('项目明天');
        expect(titles(await view(user, `listId=${project.id}`))).toContain('项目明天');
      } finally {
        await archive(false);
      }
    });
  });

  describe('过滤器', () => {
    let user: TestUser;
    let work: { id: string };
    let life: { id: string };
    let parentTag: { id: string };
    let childTag: { id: string };
    beforeAll(async () => {
      user = await t.createUser('filters');
      work = await createList(user, { name: '工作' });
      life = await createList(user, { name: '生活' });
      parentTag = await createTag(user, { name: '项目' });
      childTag = await createTag(user, { name: '子项目', parentId: parentTag.id });
      await createTask(user, { title: '工作高今天', listId: work.id, priority: 'high', dates: day('2026-10-13') });
      await createTask(user, { title: '工作低明天带子标签', listId: work.id, priority: 'low', dates: day('2026-10-14'), tagIds: [childTag.id] });
      await createTask(user, { title: '生活高无日期带标签', listId: life.id, priority: 'high', tagIds: [parentTag.id] });
      await createTask(user, { title: '生活中过期', listId: life.id, priority: 'medium', dates: day('2026-10-10') });
    });

    async function filterFor(rules: object): Promise<string[]> {
      const filter = await ok(user, 'POST', '/api/filters', { name: '临时', rules }, (v) => filterSchema.parse(v));
      const found = titles(await view(user, `filterId=${filter.id}`));
      expect((await api(user, 'DELETE', `/api/filters/${filter.id}`)).statusCode).toBe(204);
      return found;
    }

    it('combines conditions: OR within one, AND across', async () => {
      expect(await filterFor({ listIds: [work.id] })).toEqual(['工作低明天带子标签', '工作高今天']);
      expect(await filterFor({ priorities: ['high'] })).toEqual(['工作高今天', '生活高无日期带标签']);
      expect(await filterFor({ priorities: ['high'], listIds: [life.id] })).toEqual(['生活高无日期带标签']);
      expect(await filterFor({ priorities: ['high', 'medium'], listIds: [life.id] })).toEqual(['生活中过期', '生活高无日期带标签']);
      expect(await filterFor({ dates: ['today', 'overdue'] })).toEqual(['工作高今天', '生活中过期']);
      expect(await filterFor({ dates: ['noDate'], priorities: ['high'] })).toEqual(['生活高无日期带标签']);
      expect(await filterFor({ dates: ['week'], listIds: [work.id], priorities: ['low'] })).toEqual(['工作低明天带子标签']);
      expect(await filterFor({ dates: ['tomorrow'], priorities: ['high'] })).toEqual([]);
    });

    it('a parent 标签 includes its children; 无标签 selects untagged tasks', async () => {
      expect(await filterFor({ tagIds: [parentTag.id] })).toEqual(['工作低明天带子标签', '生活高无日期带标签']);
      expect(await filterFor({ tagIds: [childTag.id] })).toEqual(['工作低明天带子标签']);
      expect(await filterFor({ untagged: true })).toEqual(['工作高今天', '生活中过期']);
    });

    it('create, list, edit, delete', async () => {
      const created = await ok(user, 'POST', '/api/filters', { name: '高优先级', rules: { priorities: ['high'] } }, (v) =>
        filterSchema.parse(v),
      );
      expect(created.rules).toEqual({ listIds: [], tagIds: [], untagged: false, dates: [], priorities: ['high'] });
      const second = await ok(user, 'POST', '/api/filters', { name: '第二个', rules: {} }, (v) => filterSchema.parse(v));
      const listed = await ok(user, 'GET', '/api/filters', undefined, (v) => (v as { filters: unknown[] }).filters.map((f) => filterSchema.parse(f)));
      expect(listed.map((f) => f.name)).toEqual(['高优先级', '第二个']);

      const edited = await ok(user, 'PATCH', `/api/filters/${created.id}`, { name: '工作高', rules: { priorities: ['high'], listIds: [work.id] } }, (v) =>
        filterSchema.parse(v),
      );
      expect(edited.name).toBe('工作高');
      expect(titles(await view(user, `filterId=${created.id}`))).toEqual(['工作高今天']);

      expect((await api(user, 'DELETE', `/api/filters/${created.id}`)).statusCode).toBe(204);
      expect((await api(user, 'GET', `/api/tasks?filterId=${created.id}`)).statusCode).toBe(404);
      expect((await api(user, 'PATCH', `/api/filters/${created.id}`, { name: 'x' })).statusCode).toBe(404);

      // Tombstone in the sync feed (ADR-0004).
      const changes = changesResponseSchema.parse((await api(user, 'GET', '/api/changes')).json());
      expect(changes.entities.filter?.tombstones.map((x) => x.id)).toContain(created.id);
      expect(changes.entities.filter?.upserts.map((x) => x.id)).toContain(second.id);
    });

    it('validates rules: unknown fields 400, other users’ 清单 / 标签 400', async () => {
      const bobList = await createList(bob, { name: 'bob 的' });
      const bobTag = await createTag(bob, { name: 'bob标签' });
      const bad = [
        { name: '', rules: {} },
        { name: 'x', rules: { status: 'open' } },
        { name: 'x', rules: { dates: ['someday'] } },
        { name: 'x', rules: { priorities: ['urgent'] } },
      ];
      for (const payload of bad) expect((await api(user, 'POST', '/api/filters', payload)).statusCode, JSON.stringify(payload)).toBe(400);
      const res = await api(user, 'POST', '/api/filters', { name: 'x', rules: { listIds: [bobList.id] } });
      expect(res.json()).toMatchObject({ error: { code: 'invalid_list' } });
      const tagRes = await api(user, 'POST', '/api/filters', { name: 'x', rules: { tagIds: [bobTag.id] } });
      expect(tagRes.json()).toMatchObject({ error: { code: 'invalid_tags' } });
    });

    it('is isolated per user', async () => {
      const mine = await ok(user, 'POST', '/api/filters', { name: '我的', rules: {} }, (v) => filterSchema.parse(v));
      expect((await api(bob, 'GET', `/api/tasks?filterId=${mine.id}`)).statusCode).toBe(404);
      expect((await api(bob, 'PATCH', `/api/filters/${mine.id}`, { name: 'x' })).statusCode).toBe(404);
      expect((await api(bob, 'DELETE', `/api/filters/${mine.id}`)).statusCode).toBe(404);
      const bobs = await ok(bob, 'GET', '/api/filters', undefined, (v) => (v as { filters: { id: string }[] }).filters);
      expect(bobs.map((f) => f.id)).not.toContain(mine.id);
      // An empty filter of bob's shows only bob's tasks.
      await createTask(bob, { title: 'bob 的任务' });
      const bobFilter = await ok(bob, 'POST', '/api/filters', { name: '全部', rules: {} }, (v) => filterSchema.parse(v));
      expect(titles(await view(bob, `filterId=${bobFilter.id}`))).toEqual(['bob 的任务']);
    });
  });

  describe('过滤器 naming deleted 清单 / 标签 (review round 1)', () => {
    let user: TestUser;
    const getFilter = async (id: string) => {
      const all = await ok(user, 'GET', '/api/filters', undefined, (v) => (v as { filters: unknown[] }).filters.map((f) => filterSchema.parse(f)));
      return all.find((f) => f.id === id);
    };
    const del = async (url: string) => expect((await api(user, 'DELETE', url)).statusCode).toBe(204);

    beforeAll(async () => {
      user = await t.createUser('filters-deleted-refs');
    });

    it('a deleted 清单: the 过滤器 can be renamed, the id is dropped, the condition no longer restricts', async () => {
      const temp = await createList(user, { name: '临时清单' });
      const kept = await createList(user, { name: '保留清单' });
      await createTask(user, { title: '临时里的任务', listId: temp.id });
      await createTask(user, { title: '收件箱里的高优先级', priority: 'high' });
      await createTask(user, { title: '保留清单里的高优先级', listId: kept.id, priority: 'high' });
      const only = await ok(user, 'POST', '/api/filters', { name: '只看临时', rules: { listIds: [temp.id], priorities: ['high'] } }, (v) =>
        filterSchema.parse(v),
      );
      const both = await ok(user, 'POST', '/api/filters', { name: '两个清单', rules: { listIds: [temp.id, kept.id] } }, (v) =>
        filterSchema.parse(v),
      );
      expect(titles(await view(user, `filterId=${only.id}`))).toEqual([]);

      await del(`/api/lists/${temp.id}`);

      // Reading: the dead id is gone, and the view applies what is shown —
      // 清单 is no longer restricted, only 高优先级 is.
      expect((await getFilter(only.id))?.rules.listIds).toEqual([]);
      expect(titles(await view(user, `filterId=${only.id}`))).toEqual(['保留清单里的高优先级', '收件箱里的高优先级']);
      // With a live id left, only that one applies.
      expect((await getFilter(both.id))?.rules.listIds).toEqual([kept.id]);
      expect(titles(await view(user, `filterId=${both.id}`))).toEqual(['保留清单里的高优先级']);

      // Saving: a rename alone works and stores the rules without the dead id, with a new revision.
      const before = changesResponseSchema.parse((await api(user, 'GET', '/api/changes')).json());
      const stored = before.entities.filter?.upserts.find((f) => f.id === only.id) as unknown as { rules: { listIds: string[] }; revision: number };
      expect(stored.rules.listIds).toEqual([temp.id]); // kept as stored until the next save (回收站 restore, EURO-15)
      const renamed = await ok(user, 'PATCH', `/api/filters/${only.id}`, { name: '改个名' }, (v) => filterSchema.parse(v));
      expect(renamed.name).toBe('改个名');
      expect(renamed.rules.listIds).toEqual([]);
      expect(renamed.revision).toBeGreaterThan(stored.revision);
      const after = changesResponseSchema.parse((await api(user, 'GET', `/api/changes?since=${before.revision}`)).json());
      expect(after.entities.filter?.upserts).toEqual([expect.objectContaining({ id: only.id, rules: expect.objectContaining({ listIds: [] }) })]);

      // An old dialog sending the dead id back is accepted and the id dropped.
      const resent = await ok(user, 'PATCH', `/api/filters/${both.id}`, { rules: { listIds: [temp.id, kept.id] } }, (v) => filterSchema.parse(v));
      expect(resent.rules.listIds).toEqual([kept.id]);
      const created = await ok(user, 'POST', '/api/filters', { name: '新建也行', rules: { listIds: [temp.id] } }, (v) => filterSchema.parse(v));
      expect(created.rules.listIds).toEqual([]);
    });

    it('a deleted 标签 (parent included): same behaviour', async () => {
      const parent = await createTag(user, { name: '旧项目' });
      const child = await createTag(user, { name: '旧子项目', parentId: parent.id });
      const other = await createTag(user, { name: '其他' });
      await createTask(user, { title: '带其他标签', tagIds: [other.id] });
      await createTask(user, { title: '带子标签', tagIds: [child.id] });
      const filter = await ok(user, 'POST', '/api/filters', { name: '按标签', rules: { tagIds: [parent.id], priorities: ['none'] } }, (v) =>
        filterSchema.parse(v),
      );
      expect(titles(await view(user, `filterId=${filter.id}`))).toEqual(['带子标签']);

      await del(`/api/tags/${parent.id}`);
      expect((await getFilter(filter.id))?.rules.tagIds).toEqual([]);
      // 标签 no longer restricts: every open task without a priority shows.
      const shown = titles(await view(user, `filterId=${filter.id}`));
      expect(shown).toEqual(expect.arrayContaining(['带其他标签', '带子标签']));
      const renamed = await ok(user, 'PATCH', `/api/filters/${filter.id}`, { name: '按标签改名' }, (v) => filterSchema.parse(v));
      expect(renamed.rules).toMatchObject({ tagIds: [], priorities: ['none'] });
    });

    it('another user’s or a never-existing id is still a 400', async () => {
      const filter = await ok(user, 'POST', '/api/filters', { name: '校验', rules: {} }, (v) => filterSchema.parse(v));
      const bobList = await createList(bob, { name: 'bob 删除的' });
      await api(bob, 'DELETE', `/api/lists/${bobList.id}`);
      const bobTag = await createTag(bob, { name: 'bob删除的标签' });
      await api(bob, 'DELETE', `/api/tags/${bobTag.id}`);
      const cases: [object, string][] = [
        [{ listIds: [bobList.id] }, 'invalid_list'],
        [{ listIds: ['00000000-0000-4000-8000-0000000000ee'] }, 'invalid_list'],
        [{ tagIds: [bobTag.id] }, 'invalid_tags'],
        [{ tagIds: ['00000000-0000-4000-8000-0000000000ee'] }, 'invalid_tags'],
      ];
      for (const [rules, code] of cases) {
        const created = await api(user, 'POST', '/api/filters', { name: 'x', rules });
        expect(created.statusCode, JSON.stringify(rules)).toBe(400);
        expect(created.json()).toMatchObject({ error: { code } });
        const patched = await api(user, 'PATCH', `/api/filters/${filter.id}`, { rules });
        expect(patched.statusCode, JSON.stringify(rules)).toBe(400);
      }
    });
  });

  describe('全局搜索', () => {
    let user: TestUser;
    const search = async (u: TestUser, q: string) =>
      ok(u, 'GET', `/api/search?q=${encodeURIComponent(q)}`, undefined, (v) => searchResponseSchema.parse(v));

    beforeAll(async () => {
      user = await t.createUser('search');
      await createTask(user, { title: '买牛奶' });
      await createTask(user, { title: '周报', description: '记得写 **牛奶** 的开销' });
      const checklist = await createTask(user, { title: '出差', description: '护照\n充电器' });
      await patchTask(user, checklist.id, { kind: 'checklist' });
      const done = await createTask(user, { title: 'Milk 已完成' });
      await patchTask(user, done.id, { status: 'completed' });
      await createTask(user, { title: '100% 完成率_报告' });
    });

    it('matches title, 描述 and 检查项, case-insensitively, reporting where', async () => {
      const milk = await search(user, '牛奶');
      expect(titles(milk.tasks)).toEqual(['买牛奶', '周报']);
      expect(Object.fromEntries(milk.tasks.map((x) => [x.title, milk.matches[x.id]]))).toEqual({
        买牛奶: ['title'],
        周报: ['description'],
      });
      const passport = await search(user, '护照');
      expect(titles(passport.tasks)).toEqual(['出差']);
      expect(passport.matches[passport.tasks[0]?.id as string]).toEqual(['checklist']);
      expect(titles((await search(user, 'MILK')).tasks)).toEqual(['Milk 已完成']);
    });

    it('treats % and _ literally', async () => {
      expect(titles((await search(user, '%')).tasks)).toEqual(['100% 完成率_报告']);
      expect(titles((await search(user, '_')).tasks)).toEqual(['100% 完成率_报告']);
      expect((await search(user, '牛%奶')).tasks).toEqual([]);
    });

    it('puts open tasks before completed ones', async () => {
      await createTask(user, { title: 'milk 未完成' });
      expect((await search(user, 'milk')).tasks.map((x) => x.title)).toEqual(['milk 未完成', 'Milk 已完成']);
    });

    it('does not find deleted 检查项, nor other users’ tasks', async () => {
      const task = await createTask(user, { title: '旅行', description: '防晒霜' });
      await patchTask(user, task.id, { kind: 'checklist' });
      const items = (await api(user, 'GET', `/api/tasks/${task.id}/checklist-items`)).json() as { items: { id: string }[] };
      expect((await search(user, '防晒霜')).tasks).toHaveLength(1);
      expect((await api(user, 'DELETE', `/api/checklist-items/${items.items[0]?.id}`)).statusCode).toBe(204);
      expect((await search(user, '防晒霜')).tasks).toEqual([]);
      expect((await search(bob, '牛奶')).tasks).toEqual([]);
    });

    it('rejects empty and over-long queries', async () => {
      expect((await api(user, 'GET', '/api/search?q=')).statusCode).toBe(400);
      expect((await api(user, 'GET', '/api/search?q=%20%20')).statusCode).toBe(400);
      expect((await api(user, 'GET', `/api/search?q=${'x'.repeat(101)}`)).statusCode).toBe(400);
      expect((await api(user, 'GET', '/api/search')).statusCode).toBe(400);
    });

    it('finds a task by its 评论 (EURO-16), `matches` says `comment`; edited and deleted 评论 count as they are now', async () => {
      const task = await createTask(user, { title: '装修' });
      const comment = await ok(user, 'POST', `/api/tasks/${task.id}/comments`, { content: '和师傅约了周六看瓷砖' }, (v) => v as { id: string });
      const tiles = await search(user, '瓷砖');
      expect(titles(tiles.tasks)).toEqual(['装修']);
      expect(tiles.matches[task.id]).toEqual(['comment']);
      // Several matching 评论 report the field once; title and 评论 both report.
      await ok(user, 'POST', `/api/tasks/${task.id}/comments`, { content: '瓷砖要防滑的' }, (v) => v);
      await ok(user, 'POST', `/api/tasks/${task.id}/comments`, { content: '装修预算' }, (v) => v);
      expect((await search(user, '瓷砖')).matches[task.id]).toEqual(['comment']);
      expect((await search(user, '装修')).matches[task.id]).toEqual(['title', 'comment']);

      await ok(user, 'PATCH', `/api/comments/${comment.id}`, { content: '和师傅约了周六' }, (v) => v);
      expect(titles((await search(user, '看瓷砖')).tasks)).toEqual([]);
      const all = (await api(user, 'GET', `/api/tasks/${task.id}/comments`)).json() as { comments: { id: string; content: string }[] };
      for (const c of all.comments.filter((x) => x.content.includes('瓷砖'))) {
        expect((await api(user, 'DELETE', `/api/comments/${c.id}`)).statusCode).toBe(204);
      }
      expect((await search(user, '瓷砖')).tasks).toEqual([]);
      // Other users' 评论 are never searched.
      const theirs = await createTask(bob, { title: 'bob 的任务' });
      await ok(bob, 'POST', `/api/tasks/${theirs.id}/comments`, { content: '只有 bob 知道的词' }, (v) => v);
      expect((await search(user, '只有 bob')).tasks).toEqual([]);
      expect(titles((await search(bob, '只有 bob')).tasks)).toEqual(['bob 的任务']);
    });

    it('finds tasks of an 归档 清单 (EURO-15) but not of a deleted one', async () => {
      const archived = await createList(user, { name: '旧项目' });
      await createTask(user, { title: '旧项目的 遗留事项', listId: archived.id });
      await ok(user, 'PATCH', `/api/lists/${archived.id}`, { archived: true }, (v) => v);
      expect(titles((await search(user, '遗留事项')).tasks)).toEqual(['旧项目的 遗留事项']);
      // Deleting the 清单 moves its tasks to the 回收站, which is not searched.
      expect((await api(user, 'DELETE', `/api/lists/${archived.id}`)).statusCode).toBe(204);
      expect((await search(user, '遗留事项')).tasks).toEqual([]);
    });
  });

  describe('设置: hidden smart lists and view options', () => {
    it('stores hidden smart lists and per-view sort / group, merged per view', async () => {
      const user = await t.createUser('view-settings');
      const initial = await ok(user, 'GET', '/api/settings', undefined, (v) => settingsSchema.parse(v));
      expect(initial).toEqual({ timeZone: 'Asia/Shanghai', hiddenSmartLists: [], viewOptions: {}, allDayReminderTime: '09:00' });

      const hidden = await ok(user, 'PATCH', '/api/settings', { hiddenSmartLists: ['tomorrow', 'notImportant', 'tomorrow'] }, (v) =>
        settingsSchema.parse(v),
      );
      expect(hidden.hiddenSmartLists).toEqual(['tomorrow', 'notImportant']);

      await ok(user, 'PATCH', '/api/settings', { viewOptions: { 'smart:today': { sortBy: 'priority', groupBy: 'list' } } }, (v) => v);
      const merged = await ok(user, 'PATCH', '/api/settings', { viewOptions: { search: { sortBy: 'title', groupBy: 'none' } } }, (v) =>
        settingsSchema.parse(v),
      );
      expect(merged.viewOptions).toEqual({
        'smart:today': { sortBy: 'priority', groupBy: 'list' },
        search: { sortBy: 'title', groupBy: 'none' },
      });
      const reset = await ok(user, 'PATCH', '/api/settings', { viewOptions: { 'smart:today': null } }, (v) => settingsSchema.parse(v));
      expect(reset.viewOptions).toEqual({ search: { sortBy: 'title', groupBy: 'none' } });
      expect(reset.hiddenSmartLists).toEqual(['tomorrow', 'notImportant']);

      for (const payload of [
        { hiddenSmartLists: ['someday'] },
        { viewOptions: { 'smart:today': { sortBy: 'random', groupBy: 'none' } } },
        { viewOptions: { 'bogus:key': { sortBy: 'title', groupBy: 'none' } } },
      ]) {
        expect((await api(user, 'PATCH', '/api/settings', payload)).statusCode, JSON.stringify(payload)).toBe(400);
      }
      // Other users are unaffected.
      expect((await ok(alice, 'GET', '/api/settings', undefined, (v) => settingsSchema.parse(v))).hiddenSmartLists).toEqual([]);
    });
  });
});
