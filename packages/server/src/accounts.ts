import { asc, count, eq, sql } from 'drizzle-orm';
import { passwordSchema, usernameSchema } from '@dida/shared';
import type { Clock } from './clock.js';
import type { Db, Executor } from './db/client.js';
import { users } from './db/schema/users.js';
import { hashPassword, verifyPassword } from './password.js';
import type { SessionStore } from './sessions.js';

/*
 * 用户 accounts: creation, credentials, disabling. Shared by the HTTP routes
 * and the admin CLI. There is no self-registration (spec: 不开放注册).
 */

export interface Account {
  id: string;
  username: string;
  isAdmin: boolean;
  disabled: boolean;
  createdAt: Date;
}

export type AccountErrorCode =
  | 'invalid_username'
  | 'invalid_password'
  | 'username_taken'
  | 'user_not_found'
  | 'wrong_password';

export class AccountError extends Error {
  constructor(
    readonly code: AccountErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AccountError';
  }
}

export type LoginResult =
  | { ok: true; account: Account }
  | { ok: false; reason: 'invalid_credentials' | 'disabled' };

export type BootstrapResult = 'created' | 'users_exist' | 'not_configured';

export interface Accounts {
  create(input: { username: string; password: string; isAdmin?: boolean }): Promise<Account>;
  findByUsername(username: string): Promise<Account | null>;
  list(): Promise<Account[]>;
  /** Check credentials for login. Takes about the same time whether or not the user exists. */
  verifyLogin(username: string, password: string): Promise<LoginResult>;
  /** The user changes their own password; other sessions are logged out. */
  changePassword(userId: string, currentPassword: string, newPassword: string, keepSessionId: string): Promise<void>;
  /** Admin / CLI reset; logs the user out everywhere. */
  resetPassword(username: string, newPassword: string): Promise<Account>;
  /** Disabling logs the user out everywhere and blocks login; enabling allows login again. */
  setDisabled(username: string, disabled: boolean): Promise<Account>;
  /** First start: create the 管理员 from `.env` when the database has no user at all. */
  bootstrapAdmin(initial: { username?: string | undefined; password?: string | undefined }): Promise<BootstrapResult>;
}

type UserRow = typeof users.$inferSelect;

function toAccount(row: UserRow): Account {
  return {
    id: row.id,
    username: row.username,
    isAdmin: row.isAdmin,
    disabled: row.disabledAt !== null,
    createdAt: row.createdAt,
  };
}

function validUsername(username: string): string {
  const parsed = usernameSchema.safeParse(username);
  if (!parsed.success) throw new AccountError('invalid_username', parsed.error.issues[0]?.message ?? '账号不合法');
  return parsed.data;
}

function validPassword(password: string): string {
  const parsed = passwordSchema.safeParse(password);
  if (!parsed.success) throw new AccountError('invalid_password', parsed.error.issues[0]?.message ?? '密码不合法');
  return parsed.data;
}

function isUniqueViolation(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } }).cause ?? error;
  return (cause as { code?: string }).code === '23505';
}

/** Key for the advisory lock that serializes the first-admin bootstrap across processes. */
const BOOTSTRAP_LOCK = 0x6469_6461; // "dida"

export function createAccounts(db: Db, sessions: SessionStore, clock: Clock): Accounts {
  // Verified against when the username does not exist, so timing does not reveal accounts.
  let dummyHash: Promise<string> | undefined;

  async function rowByUsername(username: string): Promise<UserRow | undefined> {
    const [row] = await db.select().from(users).where(eq(users.username, username.trim()));
    return row;
  }

  async function requireUser(username: string): Promise<UserRow> {
    const row = await rowByUsername(username);
    if (!row) throw new AccountError('user_not_found', `用户不存在：${username}`);
    return row;
  }

  async function insertUser(executor: Executor, username: string, password: string, isAdmin: boolean) {
    const name = validUsername(username);
    const passwordHash = await hashPassword(validPassword(password));
    const now = clock.now();
    try {
      const [row] = await executor
        .insert(users)
        .values({ username: name, passwordHash, isAdmin, createdAt: now, updatedAt: now })
        .returning();
      if (!row) throw new Error('user insert returned no row');
      return toAccount(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw new AccountError('username_taken', `账号已存在：${name}`);
      throw error;
    }
  }

  return {
    create({ username, password, isAdmin = false }) {
      return insertUser(db, username, password, isAdmin);
    },

    async findByUsername(username) {
      const row = await rowByUsername(username);
      return row ? toAccount(row) : null;
    },

    async list() {
      const rows = await db.select().from(users).orderBy(asc(users.createdAt), asc(users.username));
      return rows.map(toAccount);
    },

    async verifyLogin(username, password) {
      const row = await rowByUsername(username);
      if (!row) {
        dummyHash ??= hashPassword('dummy password for timing');
        await verifyPassword(await dummyHash, password);
        return { ok: false, reason: 'invalid_credentials' };
      }
      if (!(await verifyPassword(row.passwordHash, password))) {
        return { ok: false, reason: 'invalid_credentials' };
      }
      // Only tell "disabled" to someone who knows the password.
      if (row.disabledAt) return { ok: false, reason: 'disabled' };
      return { ok: true, account: toAccount(row) };
    },

    async changePassword(userId, currentPassword, newPassword, keepSessionId) {
      const [row] = await db.select().from(users).where(eq(users.id, userId));
      if (!row) throw new AccountError('user_not_found', '用户不存在');
      if (!(await verifyPassword(row.passwordHash, currentPassword))) {
        throw new AccountError('wrong_password', '当前密码不正确');
      }
      const passwordHash = await hashPassword(validPassword(newPassword));
      await db.update(users).set({ passwordHash, updatedAt: clock.now() }).where(eq(users.id, userId));
      await sessions.revokeAllForUser(userId, keepSessionId);
    },

    async resetPassword(username, newPassword) {
      const row = await requireUser(username);
      const passwordHash = await hashPassword(validPassword(newPassword));
      const [updated] = await db
        .update(users)
        .set({ passwordHash, updatedAt: clock.now() })
        .where(eq(users.id, row.id))
        .returning();
      await sessions.revokeAllForUser(row.id);
      return toAccount(updated ?? row);
    },

    async setDisabled(username, disabled) {
      const row = await requireUser(username);
      const now = clock.now();
      const [updated] = await db
        .update(users)
        .set({ disabledAt: disabled ? (row.disabledAt ?? now) : null, updatedAt: now })
        .where(eq(users.id, row.id))
        .returning();
      if (disabled) await sessions.revokeAllForUser(row.id);
      return toAccount(updated ?? row);
    },

    async bootstrapAdmin({ username, password }) {
      if (!username || !password) return 'not_configured';
      return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${BOOTSTRAP_LOCK})`);
        const [existing] = await tx.select({ n: count() }).from(users);
        if ((existing?.n ?? 0) > 0) return 'users_exist';
        await insertUser(tx, username, password, true);
        return 'created';
      });
    },
  };
}
