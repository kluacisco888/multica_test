import { sql } from 'drizzle-orm';
import { boolean, check, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import type { SmtpSecurity } from '@dida/shared';
import { syncColumns, syncIndex } from '../../sync/columns.js';

/** Non-secret part of an 邮件 channel; the 授权码 lives in `credentials`. */
export interface EmailSettings {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  to: string;
}

/** Secret part of a channel, stored only inside `credentials` (encrypted). */
export type FeishuCredentials = { webhookUrl: string; secret: string | null };
export type EmailCredentials = { password: string };

/** Masked form of each credential, shown by the API without decrypting (null: not set). */
export type CredentialHints = Record<string, string | null>;

/**
 * 通知渠道 (ADR-0005). `credentials` is the AES-256-GCM sealed JSON of the
 * secret fields (Webhook URL, 签名 secret, 授权码): never plaintext, never
 * returned by the API. `credential_hints` holds their masked forms, written
 * together with `credentials`. `settings` holds the rest (empty for 飞书).
 */
export const notificationChannels = pgTable(
  'notification_channels',
  {
    ...syncColumns(),
    type: text({ enum: ['feishu', 'email'] }).notNull(),
    name: text().notNull(),
    isDefault: boolean().notNull().default(false),
    settings: jsonb().$type<EmailSettings | Record<string, never>>().notNull(),
    credentials: text().notNull(),
    credentialHints: jsonb().$type<CredentialHints>().notNull(),
  },
  (t) => [
    syncIndex('notification_channels', t),
    check('notification_channels_type_check', sql`${t.type} IN ('feishu', 'email')`),
  ],
);
