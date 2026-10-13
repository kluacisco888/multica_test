import { and, asc, eq, isNull } from 'drizzle-orm';
import type { ChannelMessage, NotificationChannel } from '@dida/shared';
import type { Clock } from '../clock.js';
import type { Executor } from '../db/client.js';
import {
  notificationChannels,
  type CredentialHints,
  type EmailCredentials,
  type EmailSettings,
  type FeishuCredentials,
} from '../db/schema/channels.js';
import { findOwned } from '../sync/sync.js';
import { maskSecret, maskWebhookUrl, type CredentialCipher } from './credentials.js';
import { sendEmail } from './email.js';
import { sendFeishu } from './feishu.js';

/*
 * The one way to deliver a message to a 通知渠道 (ADR-0005). 提醒, 专注 and
 * 习惯 call `app.notifier.send(userId, channelId, message)`; it never throws
 * and says whether a failure is worth retrying (network, 5xx, 4xx SMTP) or
 * needs the user to fix the channel (bad 授权码, bad signature).
 */

export type DeliveryResult = { ok: true } | { ok: false; error: string; retryable: boolean };

export interface Notifier {
  send(userId: string, channelId: string, message: ChannelMessage): Promise<DeliveryResult>;
  /** The user's default channels, oldest first. */
  defaultChannelIds(userId: string): Promise<string[]>;
}

export type ChannelRow = typeof notificationChannels.$inferSelect;

/** AAD binding a sealed credential to its record (see credentials.ts). */
export function credentialContext(userId: string, channelId: string): string {
  return `notification_channel:${userId}:${channelId}`;
}

export function feishuHints(credentials: FeishuCredentials): CredentialHints {
  return { webhookUrl: maskWebhookUrl(credentials.webhookUrl), secret: credentials.secret ? maskSecret(credentials.secret) : null };
}

export function emailHints(credentials: EmailCredentials): CredentialHints {
  return { password: maskSecret(credentials.password) };
}

/** API (and sync) representation: settings plus masked credentials, never the ciphertext. */
export function channelToApi(row: ChannelRow): NotificationChannel {
  const base = {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    revision: row.revision,
    name: row.name,
    isDefault: row.isDefault,
  };
  const hints = row.credentialHints;
  if (row.type === 'feishu') {
    return { ...base, type: 'feishu', config: { webhookUrl: hints.webhookUrl ?? '****', secret: hints.secret ?? null } };
  }
  const settings = row.settings as EmailSettings;
  return { ...base, type: 'email', config: { ...settings, password: hints.password ?? '****' } };
}

export async function liveChannels(db: Executor, userId: string): Promise<ChannelRow[]> {
  return db
    .select()
    .from(notificationChannels)
    .where(and(eq(notificationChannels.userId, userId), isNull(notificationChannels.deletedAt)))
    .orderBy(asc(notificationChannels.createdAt), asc(notificationChannels.id));
}

export const ENCRYPTION_KEY_MISSING_MESSAGE = '服务器未配置 APP_ENCRYPTION_KEY，无法保存通知渠道凭证';

export function createNotifier(deps: { db: Executor; cipher: CredentialCipher | null; clock: Clock }): Notifier {
  const fail = (error: string, retryable = false): DeliveryResult => ({ ok: false, error, retryable });

  return {
    async send(userId, channelId, message) {
      const row = await findOwned(deps.db, notificationChannels, userId, channelId);
      if (!row) return fail('通知渠道不存在');
      if (!deps.cipher) return fail(ENCRYPTION_KEY_MISSING_MESSAGE);
      let credentials: FeishuCredentials | EmailCredentials;
      try {
        credentials = deps.cipher.open(row.credentials, credentialContext(userId, row.id));
      } catch {
        return fail('无法解密渠道凭证：APP_ENCRYPTION_KEY 可能已更换，请重新填写凭证');
      }
      if (row.type === 'feishu') return sendFeishu(credentials as FeishuCredentials, message, deps.clock.now());
      return sendEmail(row.settings as EmailSettings, credentials as EmailCredentials, message);
    },
    async defaultChannelIds(userId) {
      return (await liveChannels(deps.db, userId)).filter((c) => c.isDefault).map((c) => c.id);
    },
  };
}
