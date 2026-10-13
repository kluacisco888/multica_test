import {
  changesResponseSchema,
  describeTaskDates,
  settingsSchema,
  taskSchema,
  tasksResponseSchema,
  type Task,
} from '@dida/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/*
 * 任务日期 and the user's time zone (spec 用户故事 23–26):
 *   - no date / due date only / range, all-day or timed, switchable;
 *   - all-day dates are calendar dates, never converted between zones;
 *   - timed dates are UTC instants plus the user's time zone at the time of setting.
 */

describe('task dates and time zone settings API', () => {
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

  async function patchTask(user: TestUser, id: string, patch: object): Promise<Task> {
    const res = await api(user, 'PATCH', `/api/tasks/${id}`, patch);
    expect(res.statusCode, res.body).toBe(200);
    return taskSchema.parse(res.json());
  }

  async function getTask(user: TestUser, id: string): Promise<Task> {
    return taskSchema.parse((await api(user, 'GET', `/api/tasks/${id}`)).json());
  }

  async function settings(user: TestUser) {
    const res = await api(user, 'GET', '/api/settings');
    expect(res.statusCode, res.body).toBe(200);
    return settingsSchema.parse(res.json());
  }

  async function setTimeZone(user: TestUser, timeZone: string) {
    const res = await api(user, 'PATCH', '/api/settings', { timeZone });
    expect(res.statusCode, res.body).toBe(200);
    return settingsSchema.parse(res.json());
  }

  it('creates tasks without a date by default', async () => {
    const task = await createTask(alice, { title: '没有日期' });
    expect(task.dates).toBeNull();
  });

  it('sets a due date only, all-day or timed, stamping the user time zone on timed dates', async () => {
    const allDay = await createTask(alice, { title: '交房租', dates: { allDay: true, dueDate: '2026-10-15' } });
    expect(allDay.dates).toEqual({ allDay: true, startDate: null, dueDate: '2026-10-15' });

    const timed = await createTask(alice, { title: '开会', dates: { allDay: false, dueAt: '2026-10-13T06:00:00.000Z' } });
    expect(timed.dates).toEqual({ allDay: false, startAt: null, dueAt: '2026-10-13T06:00:00.000Z', timeZone: 'Asia/Shanghai' });
    expect(await getTask(alice, timed.id)).toEqual(timed);
  });

  it('sets a range, switches between all-day and timed, and clears the date', async () => {
    const task = await createTask(alice, { title: '出差' });
    const range = await patchTask(alice, task.id, { dates: { allDay: true, startDate: '2026-10-14', dueDate: '2026-10-16' } });
    expect(range.dates).toEqual({ allDay: true, startDate: '2026-10-14', dueDate: '2026-10-16' });
    expect(range.revision).toBeGreaterThan(task.revision);

    const timed = await patchTask(alice, task.id, {
      dates: { allDay: false, startAt: '2026-10-14T01:00:00.000Z', dueAt: '2026-10-16T10:00:00.000Z' },
    });
    expect(timed.dates).toEqual({
      allDay: false,
      startAt: '2026-10-14T01:00:00.000Z',
      dueAt: '2026-10-16T10:00:00.000Z',
      timeZone: 'Asia/Shanghai',
    });

    const backToAllDay = await patchTask(alice, task.id, { dates: { allDay: true, dueDate: '2026-10-16' } });
    expect(backToAllDay.dates).toEqual({ allDay: true, startDate: null, dueDate: '2026-10-16' });

    // Other edits leave the dates alone; null clears them.
    expect((await patchTask(alice, task.id, { title: '出差（改）' })).dates).toEqual(backToAllDay.dates);
    expect((await patchTask(alice, task.id, { dates: null })).dates).toBeNull();
    expect((await getTask(alice, task.id)).dates).toBeNull();
  });

  it('rejects invalid dates', async () => {
    const task = await createTask(alice, { title: 'x' });
    for (const dates of [
      { allDay: true, dueDate: '2026-02-30' },
      { allDay: true, startDate: '2026-10-17', dueDate: '2026-10-16' },
      { allDay: false, startAt: '2026-10-16T10:00:00.000Z', dueAt: '2026-10-16T09:00:00.000Z' },
      { allDay: false, dueAt: 'tomorrow' },
      { allDay: false, dueAt: '2026-10-16T09:00:00.000Z', timeZone: 'UTC' },
      { dueDate: '2026-10-16' },
    ]) {
      const res = await api(alice, 'PATCH', `/api/tasks/${task.id}`, { dates });
      expect(res.statusCode, JSON.stringify(dates)).toBe(400);
      expect(res.json().error.code).toBe('invalid_request');
    }
    expect((await api(alice, 'POST', '/api/tasks', { title: 'y', dates: { allDay: true, dueDate: 'soon' } })).statusCode).toBe(400);
  });

  it('defaults the time zone to Asia/Shanghai and validates changes', async () => {
    expect(await settings(bob)).toMatchObject({ timeZone: 'Asia/Shanghai' });
    for (const payload of [{ timeZone: 'Mars/Olympus' }, { timeZone: '' }, { timeZone: 8 }, { theme: 'dark' }]) {
      expect((await api(bob, 'PATCH', '/api/settings', payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(await setTimeZone(bob, 'Europe/London')).toMatchObject({ timeZone: 'Europe/London' });
    expect(await settings(bob)).toMatchObject({ timeZone: 'Europe/London' });
    // Each user has their own settings.
    expect((await settings(alice)).timeZone).toBe('Asia/Shanghai');
  });

  it('after a time zone change, timed tasks show in the new zone and all-day dates stay the same', async () => {
    const carol = await t.createUser('carol');
    const allDay = await createTask(carol, { title: '生日', dates: { allDay: true, dueDate: '2026-10-13' } });
    // 22:00 on 2026-10-13 in Shanghai.
    const timed = await createTask(carol, { title: '电话会', dates: { allDay: false, dueAt: '2026-10-13T14:00:00.000Z' } });
    const label = (task: Task, timeZone: string) => describeTaskDates(task.dates!, { now: clock.now(), timeZone });
    expect(label(timed, 'Asia/Shanghai').text).toBe('22:00');
    expect(label(allDay, 'Asia/Shanghai').text).toBe('今天');

    const { timeZone } = await setTimeZone(carol, 'America/New_York');
    clock.set('2026-10-13T12:00:00.000Z'); // 08:00 on 2026-10-13 in New York, 20:00 in Shanghai

    const [afterAllDay, afterTimed] = await Promise.all([getTask(carol, allDay.id), getTask(carol, timed.id)]);
    // Stored values do not move: the calendar date and the instant.
    expect(afterAllDay.dates).toEqual({ allDay: true, startDate: null, dueDate: '2026-10-13' });
    expect(afterTimed.dates).toMatchObject({ allDay: false, dueAt: '2026-10-13T14:00:00.000Z' });
    // Shown in the new zone: the meeting is at 10:00 New York time; the birthday is still 2026-10-13.
    expect(label(afterTimed, timeZone).text).toBe('10:00');
    expect(label(afterAllDay, timeZone).text).toBe('今天');

    // Dates set after the change carry the new zone.
    const later = await createTask(carol, { title: '晚到的', dates: { allDay: false, dueAt: '2026-10-14T13:00:00.000Z' } });
    expect(later.dates).toMatchObject({ timeZone: 'America/New_York' });
    clock.set('2026-10-13T02:00:00.000Z');
  });

  it('across a DST change: switching zones keeps instants and all-day dates, timed labels follow the new zone (review)', async () => {
    const erin = await t.createUser('erin');
    await setTimeZone(erin, 'America/New_York');
    clock.set('2026-10-30T16:00:00.000Z'); // 10-30 12:00 New York (EDT), 10-31 00:00 Shanghai
    // 09:00 New York on each side of 2026-11-01 (EDT UTC-4 -> EST UTC-5).
    const edt = await createTask(erin, { title: '夏令时内', dates: { allDay: false, dueAt: '2026-10-31T13:00:00.000Z' } });
    const est = await createTask(erin, { title: '夏令时后', dates: { allDay: false, dueAt: '2026-11-02T14:00:00.000Z' } });
    const day = await createTask(erin, { title: '切换当天', dates: { allDay: true, dueDate: '2026-11-01' } });
    expect(edt.dates).toMatchObject({ timeZone: 'America/New_York' });
    const label = (task: Task, timeZone: string) => describeTaskDates(task.dates!, { now: clock.now(), timeZone });
    expect(label(edt, 'America/New_York').text).toBe('明天 09:00');
    expect(label(est, 'America/New_York').text).toBe('周一 09:00');

    const { timeZone } = await setTimeZone(erin, 'Asia/Shanghai');
    const [edt2, est2, day2] = await Promise.all([getTask(erin, edt.id), getTask(erin, est.id), getTask(erin, day.id)]);
    expect(edt2.dates).toEqual(edt.dates);
    expect(est2.dates).toEqual(est.dates);
    expect(day2.dates).toEqual({ allDay: true, startDate: null, dueDate: '2026-11-01' });
    // UTC-4 -> +8 is 12 hours, UTC-5 -> +8 is 13 hours.
    expect(label(edt2, timeZone).text).toBe('21:00');
    expect(label(est2, timeZone).text).toBe('周一 22:00');
    expect(label(day2, timeZone).text).toBe('明天');
    clock.set('2026-10-13T02:00:00.000Z');
  });

  it('keeps settings per user: one user changing the zone never shows up for another (review)', async () => {
    const [u1, u2] = await Promise.all([t.createUser('frank'), t.createUser('grace')]);
    await Promise.all([setTimeZone(u1, 'Asia/Tokyo'), setTimeZone(u2, 'Europe/Paris')]);
    expect(await settings(u1)).toMatchObject({ timeZone: 'Asia/Tokyo' });
    expect(await settings(u2)).toMatchObject({ timeZone: 'Europe/Paris' });
    // A timed task gets its owner's zone, not the other user's.
    const task = await createTask(u2, { title: 'x', dates: { allDay: false, dueAt: '2026-10-14T01:00:00.000Z' } });
    expect(task.dates).toMatchObject({ timeZone: 'Europe/Paris' });
    // Concurrent first changes for one user leave a single settings row.
    const zones = ['Asia/Seoul', 'Asia/Dubai', 'Europe/Rome', 'America/Chicago', 'Australia/Sydney'];
    const hank = await t.createUser('hank');
    const results = await Promise.all(zones.map((z) => api(hank, 'PATCH', '/api/settings', { timeZone: z })));
    expect(results.map((r) => r.statusCode)).toEqual(zones.map(() => 200));
    const changes = changesResponseSchema.parse((await api(hank, 'GET', '/api/changes')).json());
    expect(changes.entities.settings?.upserts).toHaveLength(1);
    expect(zones).toContain((await settings(hank)).timeZone);
  });

  it('lists tasks with their dates and syncs dates and settings through /api/changes', async () => {
    const dave = await t.createUser('dave');
    const task = await createTask(dave, { title: '同步', dates: { allDay: true, startDate: '2026-10-13', dueDate: '2026-10-14' } });
    const listed = tasksResponseSchema.parse((await api(dave, 'GET', `/api/tasks?listId=${task.listId}`)).json()).tasks;
    expect(listed.find((x) => x.id === task.id)?.dates).toEqual(task.dates);

    await setTimeZone(dave, 'Asia/Tokyo');
    const changes = changesResponseSchema.parse((await api(dave, 'GET', '/api/changes')).json());
    expect(changes.entities.task?.upserts).toEqual([
      expect.objectContaining({ id: task.id, allDay: true, startDate: '2026-10-13', dueDate: '2026-10-14' }),
    ]);
    expect(changes.entities.settings?.upserts).toEqual([expect.objectContaining({ timeZone: 'Asia/Tokyo' })]);
    // Another user's view contains none of it.
    const bobChanges = changesResponseSchema.parse((await api(bob, 'GET', '/api/changes')).json());
    expect(bobChanges.entities.settings?.upserts.map((s) => s.timeZone)).toEqual(['Europe/London']);
  });
});
