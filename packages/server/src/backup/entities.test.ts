import { describe, expect, it } from 'vitest';
import { BACKUP_ENTITY_TYPES, BACKUP_SKIPPED_TYPES } from '@dida/shared';
import { syncEntities } from '../sync/registry.js';
import { backupEntities } from './entities.js';
import { batches } from './import.js';

describe('backup entities', () => {
  it('cover every synced table but the server-owned delivery records, so a new table cannot be left out', () => {
    const synced = new Map(syncEntities.map((e) => [e.type, e.table]));
    expect([...synced.keys()].sort()).toEqual([...BACKUP_ENTITY_TYPES, ...BACKUP_SKIPPED_TYPES].sort());
    for (const e of backupEntities) expect(e.table, e.type).toBe(synced.get(e.type));
  });

  it('only refer to types imported before them or to their own type', () => {
    const position = new Map(BACKUP_ENTITY_TYPES.map((type, i) => [type, i]));
    for (const e of backupEntities) {
      for (const c of e.columns.filter((col) => col.refers)) {
        expect(position.get(c.refers!), `${e.type}.${c.key} → ${c.refers}`).toBeLessThanOrEqual(position.get(e.type)!);
      }
    }
  });

  it('know what every id column refers to, so import can rewrite and check it', () => {
    for (const e of backupEntities) {
      for (const c of e.columns.filter((col) => col.holdsIds && col.key !== 'id')) expect(c.refers, `${e.type}.${c.key}`).not.toBeNull();
    }
  });

  it('leave the owner and the revision out of the records', () => {
    for (const e of backupEntities) {
      expect(e.columns.map((c) => c.key)).not.toContain('userId');
      expect(e.columns.map((c) => c.key)).not.toContain('revision');
    }
  });
});

describe('batches', () => {
  it('splits ids into runs of at most 1000 (66000 → 66 calls)', () => {
    const sizes = batches(Array.from({ length: 66_000 }, (_, i) => i)).map((b) => b.length);
    expect(sizes).toHaveLength(66);
    expect(new Set(sizes)).toEqual(new Set([1000]));
    expect(batches([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
    expect(batches([])).toEqual([]);
  });
});
