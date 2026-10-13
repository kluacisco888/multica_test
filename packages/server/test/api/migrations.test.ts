import { existsSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  migrationsFolder,
  readJournal,
  rollbackLastMigration,
  runMigrations,
} from '../../src/db/migrations.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';

async function publicTables(database: TestDatabase): Promise<string[]> {
  const result = await database.db.execute<{ table_name: string }>(
    sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
  );
  return result.rows.map((r) => r.table_name);
}

describe('database migrations', () => {
  let database: TestDatabase;
  beforeAll(async () => {
    database = await createTestDatabase();
  });
  afterAll(() => database.destroy());

  it('has a rollback script for every migration', async () => {
    const journal = await readJournal();
    expect(journal.entries.length).toBeGreaterThan(0);
    for (const entry of journal.entries) {
      expect(existsSync(path.join(migrationsFolder, 'rollback', `${entry.tag}.sql`)), entry.tag).toBe(true);
    }
  });

  it('migrates up, is idempotent, rolls all the way down, and migrates up again', async () => {
    await runMigrations(database.db);
    const migrated = await publicTables(database);
    expect(migrated).toEqual(expect.arrayContaining(['users', 'user_revisions']));

    await runMigrations(database.db); // second start of the app: no-op
    expect(await publicTables(database)).toEqual(migrated);

    const journal = await readJournal();
    for (const entry of [...journal.entries].reverse()) {
      expect(await rollbackLastMigration(database.pool)).toBe(entry.tag);
    }
    expect(await rollbackLastMigration(database.pool)).toBeNull();
    expect(await publicTables(database)).toEqual([]);

    await runMigrations(database.db);
    expect(await publicTables(database)).toEqual(migrated);
  });
});
