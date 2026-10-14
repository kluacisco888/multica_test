import { getTableColumns } from 'drizzle-orm';
import { getTableConfig, type PgColumn } from 'drizzle-orm/pg-core';
import type { BackupEntityType } from '@dida/shared';
import { BACKUP_ENTITY_TYPES } from '@dida/shared';
import { attachments, comments } from '../db/schema/attachments.js';
import { notificationChannels } from '../db/schema/channels.js';
import { countdowns } from '../db/schema/countdowns.js';
import { filters } from '../db/schema/filters.js';
import { focusSessions } from '../db/schema/focus.js';
import { habitCheckins, habits } from '../db/schema/habits.js';
import { userSettings } from '../db/schema/settings.js';
import { tags } from '../db/schema/tags.js';
import { checklistItems, folders, kanbanColumns, lists, tasks } from '../db/schema/tasks.js';
import type { SyncTable } from '../sync/columns.js';

/*
 * What a backup is made of: every synced table (sync/registry.ts), in an
 * order where each record only refers to types before it or to its own type.
 * The columns and foreign keys are read from the drizzle schema, so a column
 * added later travels in the backup without touching this file.
 */

export interface BackupColumn {
  key: string;
  column: PgColumn;
  /** Entity type this column refers to (a foreign key, or one listed in `EXTRA_REFS`). */
  refers: BackupEntityType | null;
  /** The reference is a real foreign key (the referenced record must be inserted first). */
  foreignKey: boolean;
  /** Holds ids (a uuid column or a uuid array): rewritten on import. */
  holdsIds: boolean;
}

export interface BackupEntity {
  type: BackupEntityType;
  table: SyncTable;
  /** Stored columns that travel in the backup: all but `userId` and `revision`. */
  columns: BackupColumn[];
}

const TABLES: Record<BackupEntityType, SyncTable> = {
  folder: folders,
  list: lists,
  kanbanColumn: kanbanColumns,
  tag: tags,
  notificationChannel: notificationChannels,
  task: tasks,
  checklistItem: checklistItems,
  attachment: attachments,
  comment: comments,
  filter: filters,
  settings: userSettings,
  countdown: countdowns,
  focusSession: focusSessions,
  habit: habits,
  habitCheckin: habitCheckins,
};

/** References without a foreign key: id arrays (Postgres has none for array elements) and 回收站 bookkeeping. */
const EXTRA_REFS: Partial<Record<BackupEntityType, Record<string, BackupEntityType>>> = {
  task: { tagIds: 'tag', reminderChannelIds: 'notificationChannel', trashRootId: 'task' },
  checklistItem: { trashRootId: 'task' },
  habit: { reminderChannelIds: 'notificationChannel' },
};

const NOT_IN_BACKUP = new Set(['userId', 'revision']);

function typeOfTable(table: unknown): BackupEntityType | null {
  return (Object.entries(TABLES).find(([, t]) => t === table)?.[0] as BackupEntityType | undefined) ?? null;
}

function describe(type: BackupEntityType): BackupEntity {
  const table = TABLES[type];
  const refs = new Map<PgColumn, BackupEntityType>();
  for (const fk of getTableConfig(table).foreignKeys) {
    const { columns, foreignTable } = fk.reference();
    const target = typeOfTable(foreignTable);
    if (target && columns.length === 1) refs.set(columns[0] as PgColumn, target);
    else if (getTableConfig(foreignTable).name !== 'users') {
      throw new Error(`${type}: foreign key to ${getTableConfig(foreignTable).name}, which is not in the backup`);
    }
  }
  const extra = EXTRA_REFS[type] ?? {};
  const columns = Object.entries(getTableColumns(table) as Record<string, PgColumn>)
    .filter(([key]) => !NOT_IN_BACKUP.has(key))
    .map(([key, column]) => ({
      key,
      column,
      refers: refs.get(column) ?? extra[key] ?? null,
      foreignKey: refs.has(column),
      holdsIds: column.columnType === 'PgUUID' || (column.columnType === 'PgArray' && (column as PgColumn & { baseColumn: PgColumn }).baseColumn.columnType === 'PgUUID'),
    }));
  return { type, table, columns };
}

export const backupEntities: readonly BackupEntity[] = BACKUP_ENTITY_TYPES.map(describe);

/** Called for each id inside a JSON column; returns the id to store. */
export type IdVisitor = (id: string, refers: BackupEntityType) => string;

type Rec = Record<string, unknown>;

function mapRules(rules: unknown, visit: IdVisitor): unknown {
  if (!rules || typeof rules !== 'object') return rules;
  const r = rules as Rec;
  return {
    ...r,
    listIds: Array.isArray(r.listIds) ? r.listIds.map((id) => visit(String(id), 'list')) : r.listIds,
    tagIds: Array.isArray(r.tagIds) ? r.tagIds.map((id) => visit(String(id), 'tag')) : r.tagIds,
  };
}

const VIEW_KEY = /^(list|tag|filter):(.+)$/;

/**
 * Ids inside the JSON columns, by structure: 过滤器 and 四象限 rules, the
 * `list:<id>` keys of 设置 viewOptions, a 倒数日's 通知渠道. Nothing else in a
 * record is touched (titles, descriptions and 评论 stay as written).
 */
export function mapJsonIds(type: BackupEntityType, record: Rec, visit: IdVisitor): Rec {
  switch (type) {
    case 'filter':
      return { ...record, rules: mapRules(record.rules, visit) };
    case 'settings': {
      const out = { ...record };
      if (Array.isArray(record.matrixQuadrants)) {
        out.matrixQuadrants = record.matrixQuadrants.map((q: Rec) => ({ ...q, rules: mapRules(q.rules, visit) }));
      }
      if (record.viewOptions && typeof record.viewOptions === 'object') {
        out.viewOptions = Object.fromEntries(
          Object.entries(record.viewOptions as Rec).map(([key, value]) => {
            const m = VIEW_KEY.exec(key);
            return [m ? `${m[1]}:${visit(m[2] as string, m[1] as BackupEntityType)}` : key, value];
          }),
        );
      }
      return out;
    }
    case 'countdown':
      return Array.isArray(record.reminderChannelIds)
        ? { ...record, reminderChannelIds: record.reminderChannelIds.map((id) => visit(String(id), 'notificationChannel')) }
        : record;
    default:
      return record;
  }
}
