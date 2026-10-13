import {
  calendarDaysResponseSchema,
  createWorkdayCalendar,
  placeTaskAt,
  placeTaskOnDay,
  moveTaskByDays,
  taskSchema,
  tasksResponseSchema,
  type HolidayYear,
  type Task,
} from '@dida/shared';
import { solarToLunar } from '@dida/shared/lunar';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { startFakeHolidayCn, type FakeHolidayCn } from '../support/fake-holiday-cn.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/*
 * 日历视图 (spec 用户故事 69–71):
 *   - GET /api/tasks?from=&to= : the tasks a calendar page shows, read in the user's time zone;
 *   - dragging = PATCH with the dates from shared `moveTaskByDays` / `placeTaskAt` / `placeTaskOnDay`;
 *   - GET /api/calendar/days?from=&to= : 农历, 传统节日, 休 / 班 from the same 节假日数据 as the 工作日日历 (EURO-10).
 */

const bundled2026 = JSON.parse(readFileSync(new URL('../../holidays/2026.json', import.meta.url), 'utf8')) as HolidayYear;

describe('calendar API', () => {
  const clock = fixedClock('2026-10-13T02:00:00.000Z'); // 周二 10:00 in Shanghai
  let fake: FakeHolidayCn;
  let t: TestApp;
  let alice: TestUser;
  let bob: TestUser;

  beforeAll(async () => {
    fake = await startFakeHolidayCn();
    t = await createTestApp({ clock, env: { HOLIDAY_DATA_URL: fake.url } });
    alice = await t.createUser('alice');
    bob = await t.createUser('bob');
  });
  afterAll(async () => {
    await t.close();
    await fake.close();
  });

  function api(user: TestUser | null, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) {
    return t.app.inject({ method, url, headers: user?.headers ?? {}, ...(payload ? { payload } : {}) });
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

  async function setTimeZone(user: TestUser, timeZone: string) {
    expect((await api(user, 'PATCH', '/api/settings', { timeZone })).statusCode).toBe(200);
  }

  async function calendarTitles(user: TestUser, from: string, to: string): Promise<string[]> {
    const res = await api(user, 'GET', `/api/tasks?from=${from}&to=${to}`);
    expect(res.statusCode, res.body).toBe(200);
    return tasksResponseSchema
      .parse(res.json())
      .tasks.map((task) => task.title)
      .sort();
  }

  describe('tasks of a calendar page', () => {
    beforeAll(async () => {
      await setTimeZone(alice, 'Asia/Shanghai');
      await createTask(alice, { title: '全天', dates: { allDay: true, dueDate: '2026-10-14' } });
      await createTask(alice, { title: '跨周出差', dates: { allDay: true, startDate: '2026-10-08', dueDate: '2026-10-13' } });
      // 2026-10-11T17:00Z = 10-12 01:00 in Shanghai (still 10-11 in UTC and New York).
      await createTask(alice, { title: '凌晨', dates: { allDay: false, dueAt: '2026-10-11T17:00:00.000Z' } });
      await createTask(alice, { title: '下周', dates: { allDay: true, dueDate: '2026-10-19' } });
      await createTask(alice, { title: '没有日期' });
      const done = await createTask(alice, { title: '已完成', dates: { allDay: true, dueDate: '2026-10-15' } });
      await patchTask(alice, done.id, { status: 'completed' });
      const abandoned = await createTask(alice, { title: '已放弃', dates: { allDay: true, dueDate: '2026-10-15' } });
      await patchTask(alice, abandoned.id, { status: 'abandoned' });
      const deleted = await createTask(alice, { title: '已删除', dates: { allDay: true, dueDate: '2026-10-15' } });
      expect((await api(alice, 'DELETE', `/api/tasks/${deleted.id}`)).statusCode).toBe(204);
      const archived = await api(alice, 'POST', '/api/lists', { name: '旧项目' });
      const archivedId = (archived.json() as { id: string }).id;
      await createTask(alice, { title: '归档清单里的', listId: archivedId, dates: { allDay: true, dueDate: '2026-10-15' } });
      expect((await api(alice, 'PATCH', `/api/lists/${archivedId}`, { archived: true })).statusCode).toBe(200);
      await createTask(bob, { title: 'bob 的任务', dates: { allDay: true, dueDate: '2026-10-14' } });
    });

    it('returns open and completed tasks on any day of the range, 日期区间 that overlap it included', async () => {
      expect(await calendarTitles(alice, '2026-10-12', '2026-10-18')).toEqual(['全天', '凌晨', '已完成', '跨周出差'].sort());
      expect(await calendarTitles(alice, '2026-10-19', '2026-10-25')).toEqual(['下周']);
    });

    it('places timed tasks by the user’s current time zone', async () => {
      await setTimeZone(alice, 'America/New_York');
      try {
        expect(await calendarTitles(alice, '2026-10-12', '2026-10-18')).not.toContain('凌晨');
        expect(await calendarTitles(alice, '2026-10-05', '2026-10-11')).toContain('凌晨');
      } finally {
        await setTimeZone(alice, 'Asia/Shanghai');
      }
    });

    it('only shows the user’s own tasks', async () => {
      expect(await calendarTitles(bob, '2026-10-12', '2026-10-18')).toEqual(['bob 的任务']);
    });

    it('rejects a reversed, too long or malformed range', async () => {
      for (const query of ['from=2026-10-18&to=2026-10-12', 'from=2026-01-01&to=2026-06-01', 'from=2026-02-30&to=2026-03-01', 'from=2026-10-01']) {
        expect((await api(alice, 'GET', `/api/tasks?${query}`)).statusCode, query).toBe(400);
      }
    });

    it('requires a session', async () => {
      expect((await api(null, 'GET', '/api/tasks?from=2026-10-12&to=2026-10-18')).statusCode).toBe(401);
    });
  });

  describe('dragging a task to another day or time', () => {
    it('a timed task set in New York, dragged in Shanghai, keeps the Shanghai clock time and lands on the drop day', async () => {
      await setTimeZone(alice, 'America/New_York');
      // 20:30 on 10-13 in New York = 08:30 on 10-14 in Shanghai.
      const task = await createTask(alice, { title: '纽约会议', dates: { allDay: false, dueAt: '2026-10-14T00:30:00.000Z' } });
      expect(task.dates).toMatchObject({ timeZone: 'America/New_York' });
      await setTimeZone(alice, 'Asia/Shanghai');
      expect(await calendarTitles(alice, '2026-10-14', '2026-10-14')).toContain('纽约会议');

      // 月视图: dragged from 10-14 to 10-16.
      const moved = await patchTask(alice, task.id, { dates: moveTaskByDays(task.dates!, 2, 'Asia/Shanghai') });
      expect(moved.dates).toEqual({ allDay: false, startAt: null, dueAt: '2026-10-16T00:30:00.000Z', timeZone: 'Asia/Shanghai' });
      expect(await calendarTitles(alice, '2026-10-16', '2026-10-16')).toContain('纽约会议');
      expect(await calendarTitles(alice, '2026-10-14', '2026-10-14')).not.toContain('纽约会议');

      // 周视图: dragged to 10-17 15:00.
      const timedAgain = await patchTask(alice, task.id, { dates: placeTaskAt(moved.dates!, '2026-10-17', '15:00', 'Asia/Shanghai') });
      expect(timedAgain.dates).toEqual({ allDay: false, startAt: null, dueAt: '2026-10-17T07:00:00.000Z', timeZone: 'Asia/Shanghai' });
    });

    it('a timed task dragged across a DST change in New York keeps its 09:00', async () => {
      await setTimeZone(bob, 'America/New_York');
      const task = await createTask(bob, { title: '周六例会', dates: { allDay: false, dueAt: '2026-10-31T13:00:00.000Z' } });
      const moved = await patchTask(bob, task.id, { dates: moveTaskByDays(task.dates!, 2, 'America/New_York') });
      expect(moved.dates).toMatchObject({ dueAt: '2026-11-02T14:00:00.000Z' });
    });

    it('a 日期区间 moves as a whole, and onto the 全天 row keeps its length', async () => {
      const trip = await createTask(alice, { title: '旅行', dates: { allDay: true, startDate: '2026-10-20', dueDate: '2026-10-22' } });
      const moved = await patchTask(alice, trip.id, { dates: moveTaskByDays(trip.dates!, 5, 'Asia/Shanghai') });
      expect(moved.dates).toEqual({ allDay: true, startDate: '2026-10-25', dueDate: '2026-10-27' });
      expect(await calendarTitles(alice, '2026-10-26', '2026-11-01')).toContain('旅行');
      expect(await calendarTitles(alice, '2026-10-19', '2026-10-24')).not.toContain('旅行');

      // A timed range 23:00–01:00 (Shanghai) dropped on the 全天 row of 10-28 spans 10-28 – 10-29.
      const night = await createTask(alice, {
        title: '夜班',
        dates: { allDay: false, startAt: '2026-10-13T15:00:00.000Z', dueAt: '2026-10-13T17:00:00.000Z' },
      });
      const allDay = await patchTask(alice, night.id, { dates: placeTaskOnDay(night.dates!, '2026-10-28', 'Asia/Shanghai') });
      expect(allDay.dates).toEqual({ allDay: true, startDate: '2026-10-28', dueDate: '2026-10-29' });
    });
  });

  describe('农历, 节日, 休 and 班', () => {
    async function days(from: string, to: string) {
      const res = await api(alice, 'GET', `/api/calendar/days?from=${from}&to=${to}`);
      expect(res.statusCode, res.body).toBe(200);
      return calendarDaysResponseSchema.parse(res.json()).days;
    }

    it('marks 法定假日 and 调休补班 from the 节假日数据 and labels days with 农历 and 传统节日', async () => {
      const october = await days('2026-09-28', '2026-11-08');
      expect(october).toHaveLength(42);
      const byDate = new Map(october.map((d) => [d.date, d]));
      expect(byDate.get('2026-10-01')).toMatchObject({ mark: 'holiday', holidayName: '国庆节' });
      expect(byDate.get('2026-10-10')).toMatchObject({ mark: 'makeup_workday', holidayName: '国庆节' });
      expect(byDate.get('2026-10-11')).toMatchObject({ mark: null, holidayName: null });
      // 2026-10-18 is 重阳节 (九月初九); 10-10 is 九月初一, labelled with the month.
      expect(byDate.get('2026-10-18')).toMatchObject({ festivals: ['重阳节'], label: '重阳节' });
      expect(byDate.get('2026-10-10')).toMatchObject({ lunarDay: 1, label: '九月' });
      expect(byDate.get('2026-10-13')).toMatchObject({ lunarDayName: '初四', label: '初四' });
    });

    it('matches the 工作日日历 and the 农历 module day by day', async () => {
      const workdays = createWorkdayCalendar([bundled2026]);
      for (const day of await days('2026-09-01', '2026-10-31')) {
        const info = workdays.dayInfo(day.date);
        const expected = info.isHoliday ? 'holiday' : info.isMakeupWorkday ? 'makeup_workday' : null;
        expect(day.mark, day.date).toBe(expected);
        expect(day.holidayName, day.date).toBe(info.holidayName);
        const lunar = solarToLunar(day.date);
        expect([day.lunarMonthName, day.lunarDayName, day.festivals, day.solarTerm], day.date).toEqual([
          lunar.monthName,
          lunar.dayName,
          lunar.festivals,
          lunar.solarTerm,
        ]);
      }
    });

    it('follows updated 节假日数据 after 立即更新', async () => {
      expect((await days('2027-02-06', '2027-02-08')).map((d) => d.mark)).toEqual([null, null, null]);
      fake.set(2027, {
        json: {
          year: 2027,
          days: [
            { name: '春节', date: '2027-02-06', isOffDay: false },
            { name: '春节', date: '2027-02-07', isOffDay: true },
          ],
        },
      });
      expect((await api(alice, 'POST', '/api/holidays/refresh')).statusCode).toBe(200);
      expect((await days('2027-02-06', '2027-02-08')).map((d) => d.mark)).toEqual(['makeup_workday', 'holiday', null]);
    });

    it('rejects a bad range and requires a session', async () => {
      expect((await api(alice, 'GET', '/api/calendar/days?from=2026-10-02&to=2026-10-01')).statusCode).toBe(400);
      expect((await api(alice, 'GET', '/api/calendar/days?from=2026-01-01&to=2026-12-31')).statusCode).toBe(400);
      expect((await api(null, 'GET', '/api/calendar/days?from=2026-10-01&to=2026-10-02')).statusCode).toBe(401);
    });
  });
});
