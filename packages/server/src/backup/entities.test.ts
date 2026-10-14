import { describe, expect, it } from 'vitest';
import { BACKUP_ENTITY_TYPES } from '@dida/shared';
import { syncEntities } from '../sync/registry.js';
import { backupEntities } from './entities.js';

describe('backup entities', () => {
  it('cover every synced table, so a new table cannot be left out of the backup', () => {
    const synced = new Map(syncEntities.map((e) => [e.type, e.table]));
    expect([...synced.keys()].sort()).toEqual([...BACKUP_ENTITY_TYPES].sort());
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

  it('leave the owner and the revision out of the records', () => {
    for (const e of backupEntities) {
      expect(e.columns.map((c) => c.key)).not.toContain('userId');
      expect(e.columns.map((c) => c.key)).not.toContain('revision');
    }
  });
});
