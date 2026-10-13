import { inArray } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import {
  createWorkdayCalendar,
  holidayYearSchema,
  type HolidayDay,
  type HolidayRefreshOutcome,
  type HolidayRefreshResponse,
  type HolidaySource,
  type HolidayStatus,
  type HolidayYear,
  type HolidayYearResponse,
  type WorkdayCalendar,
} from '@dida/shared';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { holidayYears } from '../db/schema/holidays.js';
import { loadBundledHolidays } from './bundled.js';

/*
 * 节假日数据 (ADR-0006): holiday-cn files fetched daily for this year and next
 * year, stored in `holiday_years`; the built-in copy covers years the database
 * lacks; years with neither fall back to Monday–Friday in the 工作日日历.
 */

/** 节假日数据更新: the effective data of `years` changed. */
export interface HolidaysUpdatedEvent {
  years: number[];
  /** 工作日日历 with the new data, for recalculating dates (e.g. 重复任务 next instances). */
  calendar: WorkdayCalendar;
}

export type HolidaysUpdatedListener = (event: HolidaysUpdatedEvent) => void | Promise<void>;

export interface HolidayService {
  /** 工作日日历 over every year with data (stored, else built-in). */
  calendar(): Promise<WorkdayCalendar>;
  year(year: number): Promise<HolidayYearResponse>;
  status(): Promise<HolidayStatus>;
  /** Fetch this year and next year now. Concurrent calls share one run. Never throws for fetch errors. */
  refresh(): Promise<HolidayRefreshResponse>;
  /** Subscribe to 节假日数据更新; returns the unsubscribe function. Listeners run after the data is stored. */
  onUpdated(listener: HolidaysUpdatedListener): () => void;
}

export interface HolidayServiceDeps {
  db: Db;
  clock: Clock;
  log: FastifyBaseLogger;
  /** holiday-cn base URL; files are `<url>/<year>.json`. */
  dataUrl: string;
  /** Time zone that decides what "this year" is. */
  timezone: string;
  fetchTimeoutMs?: number;
}

type Stored = typeof holidayYears.$inferSelect;
type Fetched = { kind: 'ok'; data: HolidayYear } | { kind: 'not_published' };

function yearIn(date: Date, timezone: string): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric' }).format(date));
}

/** Order-insensitive identity of a year's days: what the 工作日日历 sees. */
function daysKey(days: readonly HolidayDay[]): string {
  return JSON.stringify(
    [...days]
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      .map((d) => [d.date, d.isOffDay, d.name]),
  );
}

/** jsonb reorders object keys, so compare field by field. */
function sameData(a: HolidayYear, b: HolidayYear): boolean {
  return daysKey(a.days) === daysKey(b.days) && JSON.stringify(a.papers ?? []) === JSON.stringify(b.papers ?? []);
}

export function createHolidayService(deps: HolidayServiceDeps): HolidayService {
  const { db, clock, log, dataUrl, timezone, fetchTimeoutMs = 15_000 } = deps;
  const listeners = new Set<HolidaysUpdatedListener>();
  let bundledPromise: Promise<Map<number, HolidayYear>> | null = null;
  let running: Promise<HolidayRefreshResponse> | null = null;

  const bundled = () => (bundledPromise ??= loadBundledHolidays());

  async function storedYears(years?: number[]): Promise<Map<number, Stored>> {
    const rows = years
      ? await db.select().from(holidayYears).where(inArray(holidayYears.year, years))
      : await db.select().from(holidayYears);
    return new Map(rows.map((r) => [r.year, r]));
  }

  /** The data the 工作日日历 uses for a year, and where it comes from. */
  function effective(year: number, stored: Map<number, Stored>, builtIn: Map<number, HolidayYear>) {
    const row = stored.get(year);
    if (row && row.data.days.length > 0) return { source: 'remote' as HolidaySource, days: row.data.days };
    const copy = builtIn.get(year);
    if (copy && copy.days.length > 0) return { source: 'bundled' as HolidaySource, days: copy.days };
    return { source: 'none' as HolidaySource, days: [] as HolidayDay[] };
  }

  async function calendar(): Promise<WorkdayCalendar> {
    const [stored, builtIn] = await Promise.all([storedYears(), bundled()]);
    const years = new Set([...stored.keys(), ...builtIn.keys()]);
    return createWorkdayCalendar([...years].map((year) => ({ year, days: effective(year, stored, builtIn).days })));
  }

  async function status(): Promise<HolidayStatus> {
    const current = yearIn(clock.now(), timezone);
    const tracked = [current, current + 1];
    const [stored, builtIn, all] = await Promise.all([storedYears(tracked), bundled(), db.select({ fetchedAt: holidayYears.fetchedAt }).from(holidayYears)]);
    const latest = all.reduce<Date | null>((max, r) => (!max || r.fetchedAt > max ? r.fetchedAt : max), null);
    return {
      lastUpdatedAt: latest?.toISOString() ?? null,
      years: tracked.map((year) => ({
        year,
        source: effective(year, stored, builtIn).source,
        fetchedAt: stored.get(year)?.fetchedAt.toISOString() ?? null,
      })),
    };
  }

  async function fetchYear(year: number): Promise<Fetched> {
    const res = await fetch(`${dataUrl}/${year}.json`, { signal: AbortSignal.timeout(fetchTimeoutMs) });
    if (res.status === 404) return { kind: 'not_published' };
    if (!res.ok) throw new Error(`HTTP ${res.status} from holiday-cn`);
    const data = holidayYearSchema.parse(await res.json());
    if (data.year !== year) throw new Error(`holiday-cn file for ${year} says year ${data.year}`);
    return { kind: 'ok', data };
  }

  async function refreshYear(year: number, builtIn: Map<number, HolidayYear>): Promise<HolidayRefreshOutcome> {
    let fetched: Fetched;
    try {
      fetched = await fetchYear(year);
    } catch (error) {
      const stored = await storedYears([year]);
      const fallback = effective(year, stored, builtIn).source;
      const keeping =
        fallback === 'remote'
          ? 'keeping the stored data'
          : fallback === 'bundled'
            ? 'using the built-in data'
            : 'no data for this year, counting Monday to Friday as workdays';
      log.warn({ year, err: (error as Error).message }, `holiday data fetch failed; ${keeping}`);
      return 'failed';
    }
    if (fetched.kind === 'not_published') return 'not_published';

    const now = clock.now();
    const stored = await storedYears([year]);
    const before = effective(year, stored, builtIn);
    const existing = stored.get(year);
    const dataChanged = !existing || !sameData(existing.data, fetched.data);
    await db
      .insert(holidayYears)
      .values({ year, data: fetched.data, fetchedAt: now, changedAt: now })
      .onConflictDoUpdate({
        target: holidayYears.year,
        set: dataChanged ? { data: fetched.data, fetchedAt: now, changedAt: now } : { fetchedAt: now },
      });
    // "Updated" means the 工作日日历 changed, not merely that a row was written.
    return daysKey(before.days) === daysKey(fetched.data.days) ? 'unchanged' : 'updated';
  }

  async function emit(years: number[]) {
    const event: HolidaysUpdatedEvent = { years, calendar: await calendar() };
    for (const listener of [...listeners]) {
      try {
        await listener(event);
      } catch (error) {
        log.error({ err: error, years }, 'holidays updated listener failed');
      }
    }
  }

  async function runRefresh(): Promise<HolidayRefreshResponse> {
    const builtIn = await bundled();
    const current = yearIn(clock.now(), timezone);
    const results: HolidayRefreshResponse['results'] = [];
    for (const year of [current, current + 1]) {
      results.push({ year, outcome: await refreshYear(year, builtIn) });
    }
    const updated = results.filter((r) => r.outcome === 'updated').map((r) => r.year);
    if (updated.length > 0) {
      log.info({ years: updated }, 'holiday data updated');
      await emit(updated);
    }
    return { results, status: await status() };
  }

  return {
    calendar,
    status,
    async year(year) {
      const [stored, builtIn] = await Promise.all([storedYears([year]), bundled()]);
      const { source, days } = effective(year, stored, builtIn);
      return { year, source, days };
    },
    refresh() {
      running ??= runRefresh().finally(() => {
        running = null;
      });
      return running;
    },
    onUpdated(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
