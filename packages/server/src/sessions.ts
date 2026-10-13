import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import type { Clock } from './clock.js';
import type { Db } from './db/client.js';
import { sessions, users } from './db/schema/users.js';

/** The user a request acts on behalf of. */
export interface SessionUser {
  id: string;
  username: string;
  isAdmin: boolean;
  /** The login session the request came with. */
  sessionId: string;
}

export interface ResolvedSession {
  user: SessionUser;
  /** Expiry was pushed forward; the cookie should be re-issued with the new max age. */
  renewed: boolean;
  expiresAt: Date;
}

export interface SessionStore {
  /** Start a session; returns the opaque token for the cookie. */
  create(userId: string): Promise<{ token: string; expiresAt: Date }>;
  /** The live session for a token of an enabled user, or null. Slides the expiry. */
  resolve(token: string): Promise<ResolvedSession | null>;
  revoke(token: string): Promise<void>;
  /** Revoke every live session of a user, optionally keeping one. */
  revokeAllForUser(userId: string, exceptSessionId?: string): Promise<void>;
}

/** Sessions stay valid this long after the last request ("保持登录"). */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Write `last_seen_at` / expiry at most this often per session. */
const RENEW_AFTER_MS = 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createSessionStore(db: Db, clock: Clock): SessionStore {
  return {
    async create(userId) {
      const token = randomBytes(32).toString('base64url');
      const now = clock.now();
      const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
      await db.insert(sessions).values({
        userId,
        tokenHash: hashToken(token),
        createdAt: now,
        lastSeenAt: now,
        expiresAt,
      });
      return { token, expiresAt };
    },

    async resolve(token) {
      if (!token) return null;
      const now = clock.now();
      const [row] = await db
        .select({
          sessionId: sessions.id,
          lastSeenAt: sessions.lastSeenAt,
          expiresAt: sessions.expiresAt,
          id: users.id,
          username: users.username,
          isAdmin: users.isAdmin,
        })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(
          and(
            eq(sessions.tokenHash, hashToken(token)),
            isNull(sessions.revokedAt),
            gt(sessions.expiresAt, now),
            // A disabled user's sessions stop working immediately, even if not revoked.
            isNull(users.disabledAt),
          ),
        );
      if (!row) return null;
      const user: SessionUser = {
        id: row.id,
        username: row.username,
        isAdmin: row.isAdmin,
        sessionId: row.sessionId,
      };
      if (now.getTime() - row.lastSeenAt.getTime() < RENEW_AFTER_MS) {
        return { user, renewed: false, expiresAt: row.expiresAt };
      }
      const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
      await db
        .update(sessions)
        .set({ lastSeenAt: now, expiresAt })
        .where(eq(sessions.id, row.sessionId));
      return { user, renewed: true, expiresAt };
    },

    async revoke(token) {
      if (!token) return;
      await db
        .update(sessions)
        .set({ revokedAt: clock.now() })
        .where(and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.revokedAt)));
    },

    async revokeAllForUser(userId, exceptSessionId) {
      await db
        .update(sessions)
        .set({ revokedAt: clock.now() })
        .where(
          and(
            eq(sessions.userId, userId),
            isNull(sessions.revokedAt),
            exceptSessionId ? ne(sessions.id, exceptSessionId) : sql`true`,
          ),
        );
    },
  };
}
