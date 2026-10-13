import { bigint, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * 用户. Only the identity columns needed by the sync layer live here;
 * login fields (password hash, admin flag, disabled) are added by EURO-5.
 */
export const users = pgTable('users', {
  id: uuid().primaryKey().defaultRandom(),
  username: text().notNull().unique(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/**
 * Per-user monotonic revision counter (ADR-0004). Every write to a synced
 * entity bumps this row inside the same transaction; the row lock makes
 * commit order equal revision order for one user.
 */
export const userRevisions = pgTable('user_revisions', {
  userId: uuid()
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  revision: bigint({ mode: 'number' }).notNull().default(0),
});
