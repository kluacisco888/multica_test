import { readFileSync } from 'node:fs';
import {
  holidayRefreshResponseSchema,
  holidayStatusSchema,
  holidayYearResponseSchema,
  type HolidayYear,
} from '@dida/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import type { HolidaysUpdatedEvent } from '../../src/holidays/service.js';
import { startFakeHolidayCn, type FakeHolidayCn } from '../support/fake-holiday-cn.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/*
 * 节假日数据 (ADR-0006, spec 用户故事 114、115): daily fetch of this year and
 * next year from holiday-cn into the database, the built-in copy as fallback,
 * and the 节假日数据更新 event. holiday-cn is a local fake (HOLIDAY_DATA_URL).
 */

const bundled2026 = JSON.parse(
  readFileSync(new URL('../../holidays/2026.json', import.meta.url), 'utf8'),
) as HolidayYear & { $schema: string };

const announced2027: HolidayYear = {
  year: 2027,
  papers: ['https://www.gov.cn/example-2027'],
  days: [
    { name: '元旦', date: '2027-01-01', isOffDay: true },
    { name: '春节', date: '2027-02-07', isOffDay: false },
    { name: '春节', date: '2027-02-08', isOffDay: true },
  ],
};

/** Log lines written by the app (pino JSON). */
function captureLogs() {
  const lines: { level: number; msg: string; year?: number; err?: string }[] = [];
  return {
    lines,
    logger: { level: 'info', stream: { write: (line: string) => void lines.push(JSON.parse(line)) } },
  };
}

describe('holiday data API', () => {
  let fake: FakeHolidayCn;
  let t: TestApp;
  let alice: TestUser;
  const logs = captureLogs();
  // 08:30 in Asia/Shanghai; later steps stay within the 30-day session lifetime.
  const clock = fixedClock('2026-10-13T00:30:00.000Z');
  const events: HolidaysUpdatedEvent[] = [];

  beforeAll(async () => {
    fake = await startFakeHolidayCn();
    t = await createTestApp({ clock, env: { HOLIDAY_DATA_URL: fake.url }, logger: logs.logger });
    alice = await t.createUser('alice');
    t.app.holidays.onUpdated((event) => void events.push(event));
  });
  afterAll(async () => {
    await t.close();
    await fake.close();
  });
  afterEach(() => {
    events.length = 0;
  });

  const get = (url: string) => t.app.inject({ method: 'GET', url, headers: alice.headers });
  const refresh = async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/holidays/refresh', headers: alice.headers });
    expect(res.statusCode, res.body).toBe(200);
    return holidayRefreshResponseSchema.parse(res.json());
  };
  const status = async () => holidayStatusSchema.parse((await get('/api/holidays/status')).json());
  const year = async (y: number) => {
    const res = await get(`/api/holidays/${y}`);
    expect(res.statusCode, res.body).toBe(200);
    return holidayYearResponseSchema.parse(res.json());
  };

  it('before the first fetch uses the built-in data and reports no update yet', async () => {
    expect(await status()).toEqual({
      lastUpdatedAt: null,
      years: [
        { year: 2026, source: 'bundled', fetchedAt: null },
        { year: 2027, source: 'none', fetchedAt: null },
      ],
    });
    const y2026 = await year(2026);
    expect(y2026.source).toBe('bundled');
    expect(y2026.days).toContainEqual({ name: '国庆节', date: '2026-10-01', isOffDay: true });
    expect(y2026.days).toContainEqual({ name: '国庆节', date: '2026-10-10', isOffDay: false });
    expect(await year(2027)).toEqual({ year: 2027, source: 'none', days: [] });
  });

  it('立即更新 fetches this year and next year; a year not published yet is not an error', async () => {
    fake.set(2026, { json: bundled2026 });
    const result = await refresh();
    expect(fake.requests).toEqual(['/2026.json', '/2027.json']);
    expect(result.results).toEqual([
      { year: 2026, outcome: 'unchanged' }, // same as the built-in copy: the calendar did not change
      { year: 2027, outcome: 'not_published' },
    ]);
    expect(result.status).toEqual({
      lastUpdatedAt: '2026-10-13T00:30:00.000Z',
      years: [
        { year: 2026, source: 'remote', fetchedAt: '2026-10-13T00:30:00.000Z' },
        { year: 2027, source: 'none', fetchedAt: null },
      ],
    });
    expect(await status()).toEqual(result.status);
    expect(events).toEqual([]);
    expect(logs.lines.filter((l) => l.level >= 40)).toEqual([]);
  });

  it('emits 节假日数据更新 when next year gets announced', async () => {
    clock.set('2026-10-20T02:00:00.000Z');
    fake.set(2027, { json: announced2027 });
    const result = await refresh();
    expect(result.results).toEqual([
      { year: 2026, outcome: 'unchanged' },
      { year: 2027, outcome: 'updated' },
    ]);
    expect(result.status.lastUpdatedAt).toBe('2026-10-20T02:00:00.000Z');
    expect(await year(2027)).toEqual({ year: 2027, source: 'remote', days: announced2027.days });

    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event?.years).toEqual([2027]);
    // The event carries the new 工作日日历 for recalculating dates.
    expect(event?.calendar.isMakeupWorkday('2027-02-07')).toBe(true);
    expect(event?.calendar.isHoliday('2027-02-08')).toBe(true);
    expect(event?.calendar.isWorkday('2026-10-10')).toBe(true);
  });

  it('emits the event again when published data changes, and not when it stays the same', async () => {
    const revised = { ...announced2027, days: [...announced2027.days, { name: '春节', date: '2027-02-09', isOffDay: true }] };
    fake.set(2027, { json: revised });
    expect((await refresh()).results).toContainEqual({ year: 2027, outcome: 'updated' });
    expect(events.map((e) => e.years)).toEqual([[2027]]);
    expect((await year(2027)).days).toHaveLength(4);

    events.length = 0;
    expect((await refresh()).results).toContainEqual({ year: 2027, outcome: 'unchanged' });
    expect(events).toEqual([]);
  });

  it('keeps the stored data and logs a warning when fetching fails', async () => {
    const before = await status();
    clock.set('2026-10-21T02:00:00.000Z');
    fake.set(2026, { status: 503 });
    fake.set(2027, { raw: '{"year": 2027, "days": [{"name": "元旦"' }); // truncated JSON
    logs.lines.length = 0;

    const result = await refresh();
    expect(result.results).toEqual([
      { year: 2026, outcome: 'failed' },
      { year: 2027, outcome: 'failed' },
    ]);
    expect(result.status).toEqual(before); // 最后更新时间 is the last successful fetch
    expect((await year(2027)).days).toHaveLength(4);
    expect(events).toEqual([]);

    const warnings = logs.lines.filter((l) => l.level === 40);
    expect(warnings.map((w) => w.year)).toEqual([2026, 2027]);
    expect(warnings[0]?.msg).toMatch(/holiday data fetch failed/);
    expect(warnings[0]?.err).toMatch(/503/);
  });

  it('a failing event listener is logged and does not break the refresh', async () => {
    const off = t.app.holidays.onUpdated(() => {
      throw new Error('listener exploded');
    });
    fake.set(2026, { json: { ...bundled2026, days: bundled2026.days.slice(1) } });
    logs.lines.length = 0;
    expect((await refresh()).results).toContainEqual({ year: 2026, outcome: 'updated' });
    expect(events.map((e) => e.years)).toEqual([[2026]]);
    expect(logs.lines.some((l) => l.level === 50 && /listener/.test(l.msg))).toBe(true);

    off();
    events.length = 0;
    fake.set(2026, { json: bundled2026 });
    logs.lines.length = 0;
    await refresh();
    expect(events.map((e) => e.years)).toEqual([[2026]]);
    expect(logs.lines.filter((l) => l.level >= 50)).toEqual([]);
  });

  it('rejects data for the wrong year', async () => {
    fake.set(2027, { json: { ...announced2027, year: 2028 } });
    expect((await refresh()).results).toContainEqual({ year: 2027, outcome: 'failed' });
  });

  it('validates the year parameter', async () => {
    expect((await get('/api/holidays/abc')).statusCode).toBe(400);
    expect((await get('/api/holidays/12345')).statusCode).toBe(400);
    expect(await year(1999)).toEqual({ year: 1999, source: 'none', days: [] });
  });
});

describe('holiday data when holiday-cn is unreachable', () => {
  let t: TestApp;
  let alice: TestUser;
  const logs = captureLogs();

  beforeAll(async () => {
    // Nothing listens on port 9 (discard) on the test machine: connection refused.
    t = await createTestApp({
      clock: fixedClock('2026-10-13T00:30:00.000Z'),
      env: { HOLIDAY_DATA_URL: 'http://127.0.0.1:9' },
      logger: logs.logger,
    });
    alice = await t.createUser('alice');
  });
  afterAll(() => t.close());

  it('falls back to the built-in data and logs it', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/holidays/refresh', headers: alice.headers });
    const result = holidayRefreshResponseSchema.parse(res.json());
    expect(result.results).toEqual([
      { year: 2026, outcome: 'failed' },
      { year: 2027, outcome: 'failed' },
    ]);
    expect(result.status.years[0]).toEqual({ year: 2026, source: 'bundled', fetchedAt: null });

    const y2026 = holidayYearResponseSchema.parse(
      (await t.app.inject({ method: 'GET', url: '/api/holidays/2026', headers: alice.headers })).json(),
    );
    expect(y2026.source).toBe('bundled');
    expect(y2026.days.length).toBeGreaterThan(20);

    const calendar = await t.app.holidays.calendar();
    expect(calendar.isHoliday('2026-10-01')).toBe(true);
    expect(calendar.isMakeupWorkday('2026-10-10')).toBe(true);
    expect(calendar.hasYear(2027)).toBe(false);

    const warnings = logs.lines.filter((l) => l.level === 40);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]?.msg).toMatch(/using the built-in data/);
  });
});
