import { sql } from 'drizzle-orm';
import { pgTable, text, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { syncColumns, syncIndex } from '../../sync/columns.js';

/** 标签: nested one level deep through `parent_id` (rules in @dida/shared `tags.ts`). */
export const tags = pgTable(
  'tags',
  {
    ...syncColumns(),
    name: text().notNull(),
    /** #rrggbb or null (no colour). */
    color: text(),
    parentId: uuid().references((): AnyPgColumn => tags.id),
    /** Fractional key within its level (top level, or one parent's children). */
    sortOrder: text().notNull(),
  },
  (t) => [
    syncIndex('tags', t),
    // Names are unique per user, ignoring case, among live 标签.
    uniqueIndex('tags_user_name_unique').on(t.userId, sql`lower(${t.name})`).where(sql`${t.deletedAt} IS NULL`),
  ],
);
