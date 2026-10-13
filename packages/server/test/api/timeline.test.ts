import {
  changesResponseSchema,
  dragTaskDates,
  scheduleOnDay,
  settingsSchema,
  taskSchema,
  type Task,
  type TaskDatesInput,
  type TimelineDrag,
} from '@dida/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/*
 * 时间线 (spec 用户故事 68): dragging a bar or one of its ends saves new dates
 * through `PATCH /api/tasks/:id` (the dates come from `dragTaskDates`, the
 * same function the web timeline uses). Each save is a new revision in
 * /api/changes (ADR-0004), and nobody can move another user's task. The
 * timeline layout of a view is kept in 设置 → viewOptions.
 */

describe('timeline drag API', () => {
  const clock = fixedClock('2026-10-13T02:00:00.000Z'); // 周二 10:00 in Shanghai
  let t: TestApp;
  let alice: TestUser;
  let bob: TestUser;

  beforeAll(async () => {
    t = await createTestApp({ clock });
    alice = await t.createUser('alice');
    bob = await t.createUser('bob');
  });
  afterAll(() => t.close());

  function api(user: TestUser, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) {
    return t.app.inject({ method, url, headers: user.headers, ...(payload ? { payload } : {}) });
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

  /** Drag like the timeline does, save, and return the stored task. */
  async function drag(user: TestUser, task: Task, edge: TimelineDrag, days: number): Promise<Task> {
    const dates = dragTaskDates(task.dates!, edge, days, 'Asia/Shanghai');
    expect(dates).not.toBeNull();
    return save(user, task, dates!);
  }

  async function save(user: TestUser, task: Task, dates: TaskDatesInput): Promise<Task> {
    const res = await api(user, 'PATCH', `/api/tasks/${task.id}`, { dates });
    expect(res.statusCode, res.body).toBe(200);
    const stored = await getTask(user, task.id);
    expect(stored).toEqual(taskSchema.parse(res.json()));
    return stored;
  }

  it('moves the whole bar of a range and keeps its length', async () => {
    const task = await createTask(alice, { title: '方案评审', dates: { allDay: true, startDate: '2026-10-13', dueDate: '2026-10-15' } });
    const moved = await drag(alice, task, 'move', 3);
    expect(moved.dates).toEqual({ allDay: true, startDate: '2026-10-16', dueDate: '2026-10-18' });
    expect(moved.revision).toBeGreaterThan(task.revision);
  });

  it('drags each end of a bar', async () => {
    const task = await createTask(alice, { title: '写周报', dates: { allDay: true, startDate: '2026-10-13', dueDate: '2026-10-15' } });
    const longer = await drag(alice, task, 'end', 2);
    expect(longer.dates).toEqual({ allDay: true, startDate: '2026-10-13', dueDate: '2026-10-17' });
    const earlier = await drag(alice, longer, 'start', -3);
    expect(earlier.dates).toEqual({ allDay: true, startDate: '2026-10-10', dueDate: '2026-10-17' });
    // Pulling the start past the end leaves a one-day task due that day.
    const single = await drag(alice, earlier, 'start', 30);
    expect(single.dates).toEqual({ allDay: true, startDate: null, dueDate: '2026-10-17' });
  });

  it('stretches a due-date-only task into a range', async () => {
    const task = await createTask(alice, { title: '交材料', dates: { allDay: true, startDate: null, dueDate: '2026-10-15' } });
    const range = await drag(alice, task, 'end', 1);
    expect(range.dates).toEqual({ allDay: true, startDate: '2026-10-15', dueDate: '2026-10-16' });
  });

  it('moves timed tasks by whole days, keeping their times and stamping the current time zone', async () => {
    // 2026-10-13 09:00 → 18:00 Shanghai
    const task = await createTask(alice, {
      title: '会议',
      dates: { allDay: false, startAt: '2026-10-13T01:00:00.000Z', dueAt: '2026-10-13T10:00:00.000Z' },
    });
    const moved = await drag(alice, task, 'move', 1);
    expect(moved.dates).toEqual({ allDay: false, startAt: '2026-10-14T01:00:00.000Z', dueAt: '2026-10-14T10:00:00.000Z', timeZone: 'Asia/Shanghai' });
    const longer = await drag(alice, moved, 'end', 2);
    expect(longer.dates).toEqual({ allDay: false, startAt: '2026-10-14T01:00:00.000Z', dueAt: '2026-10-16T10:00:00.000Z', timeZone: 'Asia/Shanghai' });
  });

  it('schedules a task without a date on the day it is dropped', async () => {
    const task = await createTask(alice, { title: '没想好什么时候' });
    expect(task.dates).toBeNull();
    const scheduled = await save(alice, task, scheduleOnDay('2026-10-20'));
    expect(scheduled.dates).toEqual({ allDay: true, startDate: null, dueDate: '2026-10-20' });
  });

  it('syncs each drag through /api/changes as a new revision', async () => {
    const task = await createTask(alice, { title: '同步', dates: { allDay: true, startDate: null, dueDate: '2026-10-13' } });
    const before = changesResponseSchema.parse((await api(alice, 'GET', '/api/changes')).json()).revision;
    const moved = await drag(alice, task, 'move', 1);
    const changes = changesResponseSchema.parse((await api(alice, 'GET', `/api/changes?since=${before}`)).json());
    expect(changes.entities.task?.upserts).toEqual([expect.objectContaining({ id: task.id, revision: moved.revision })]);
    expect(changes.entities.task?.tombstones).toEqual([]);
    expect(moved.revision).toBeGreaterThan(before);
  });

  it("does not let another user move a task, nor see it", async () => {
    const task = await createTask(alice, { title: '别人的', dates: { allDay: true, startDate: '2026-10-13', dueDate: '2026-10-14' } });
    const dates = dragTaskDates(task.dates!, 'move', 5, 'Asia/Shanghai');
    const res = await api(bob, 'PATCH', `/api/tasks/${task.id}`, { dates });
    expect(res.statusCode).toBe(404);
    expect((await getTask(alice, task.id)).dates).toEqual(task.dates);
    expect((await api(bob, 'GET', `/api/tasks/${task.id}`)).statusCode).toBe(404);
    // Alice's 清单 does not exist for Bob.
    expect((await api(bob, 'GET', `/api/tasks?listId=${task.listId}`)).statusCode).toBe(404);
    const bobChanges = changesResponseSchema.parse((await api(bob, 'GET', '/api/changes')).json());
    expect(bobChanges.entities.task?.upserts.map((x) => x.id) ?? []).not.toContain(task.id);
  });

  it('rejects dates a drag could never produce', async () => {
    const task = await createTask(alice, { title: '校验', dates: { allDay: true, startDate: null, dueDate: '2026-10-13' } });
    const res = await api(alice, 'PATCH', `/api/tasks/${task.id}`, { dates: { allDay: true, startDate: '2026-10-15', dueDate: '2026-10-13' } });
    expect(res.statusCode).toBe(400);
    expect((await getTask(alice, task.id)).dates).toEqual(task.dates);
  });

  it("keeps each user's timeline layout per view", async () => {
    const lists = (await api(alice, 'GET', '/api/lists')).json() as { lists: { id: string }[] };
    const key = `list:${lists.lists[0]!.id}`;
    const res = await api(alice, 'PATCH', '/api/settings', { viewOptions: { [key]: { sortBy: 'custom', groupBy: 'none', layout: 'timeline' } } });
    expect(res.statusCode, res.body).toBe(200);
    expect(settingsSchema.parse(res.json()).viewOptions[key]).toEqual({ sortBy: 'custom', groupBy: 'none', layout: 'timeline' });
    expect(settingsSchema.parse((await api(alice, 'GET', '/api/settings')).json()).viewOptions[key]?.layout).toBe('timeline');
    expect(settingsSchema.parse((await api(bob, 'GET', '/api/settings')).json()).viewOptions[key]).toBeUndefined();

    const bad = await api(alice, 'PATCH', '/api/settings', { viewOptions: { [key]: { sortBy: 'custom', groupBy: 'none', layout: 'gantt' } } });
    expect(bad.statusCode).toBe(400);
  });
});
