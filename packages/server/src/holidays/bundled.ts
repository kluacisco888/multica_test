import { readdir, readFile } from 'node:fs/promises';
import { holidayYearSchema, type HolidayYear } from '@dida/shared';

/**
 * The holiday-cn files built into the image (`packages/server/holidays/<year>.json`),
 * used for every year the database has no fetched data for (ADR-0006).
 * Refresh them with `scripts/update-bundled-holidays.sh` before a release.
 */
export const bundledHolidaysDir = new URL('../../holidays/', import.meta.url);

export async function loadBundledHolidays(dir: URL = bundledHolidaysDir): Promise<Map<number, HolidayYear>> {
  const years = new Map<number, HolidayYear>();
  for (const name of await readdir(dir)) {
    const match = /^(\d{4})\.json$/.exec(name);
    if (!match) continue;
    const data = holidayYearSchema.parse(JSON.parse(await readFile(new URL(name, dir), 'utf8')));
    if (data.year !== Number(match[1])) throw new Error(`bundled holiday file ${name} is for year ${data.year}`);
    years.set(data.year, data);
  }
  return years;
}
