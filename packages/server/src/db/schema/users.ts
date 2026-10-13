import { bigint, boolean, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * 用户. Not a synced entity: accounts are managed by the server (CLI, later the
 * admin page), never by offline clients.
 */
export const users = pgTable('users', {
  id: uuid().primaryKey().defaultRandom(),
  username: text().notNull().unique(),
  /** argon2id PHC string, see `src/password.ts`. */
  passwordHash: text().notNull(),
  /** 管理员 */
  isAdmin: boolean().notNull().default(false),
  /** Set when the user is disabled: login is refused and sessions stop resolving. */
  disabledAt: timestamp({ withTimezone: true }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/**
 * Server-side login sessions. The browser only holds the random token in an
 * httpOnly cookie; the table stores its SHA-256 so a database leak does not
 * leak usable sessions. Logout and password changes set `revoked_at`.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text().notNull().unique(),
    createdAt: timestamp({ withTimezone: true }).notNull(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

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
