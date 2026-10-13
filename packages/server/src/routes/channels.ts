import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  CHANNEL_CONFIG_FIELDS,
  CHANNEL_TYPE_LABELS,
  createChannelRequestSchema,
  updateChannelRequestSchema,
  type ChannelMessage,
  type ChannelsResponse,
} from '@dida/shared';
import { sessionUser } from '../auth.js';
import {
  notificationChannels,
  type EmailCredentials,
  type EmailSettings,
  type FeishuCredentials,
} from '../db/schema/channels.js';
import { sendError, sendValidationError } from '../http-errors.js';
import type { CredentialCipher } from '../notify/credentials.js';
import {
  channelToApi,
  credentialContext,
  emailHints,
  ENCRYPTION_KEY_MISSING_MESSAGE,
  feishuHints,
  liveChannels,
} from '../notify/notifier.js';
import { findOwned } from '../sync/sync.js';
import { notFound, Rejection, respond } from './respond.js';

type Params = { Params: { id: string } };

const keyMissing = (reply: FastifyReply) => sendError(reply, 503, 'encryption_key_missing', ENCRYPTION_KEY_MISSING_MESSAGE);

/** The 发送测试消息 text. */
export function testMessage(channelName: string): ChannelMessage {
  return {
    title: '勾勾清单测试消息',
    body: `这是一条来自勾勾清单的测试消息。收到它，说明通知渠道「${channelName}」配置正确。`,
  };
}

/** 通知渠道 settings (spec 用户故事 74–77、85). Credentials are sealed with `cipher`; null when APP_ENCRYPTION_KEY is unset. */
export function channelRoutes(app: FastifyInstance, deps: { cipher: CredentialCipher | null }) {
  const { cipher } = deps;

  app.get('/api/notification-channels', async (request) => {
    const rows = await liveChannels(app.db, sessionUser(request).id);
    const response: ChannelsResponse = { channels: rows.map(channelToApi) };
    return response;
  });

  app.post('/api/notification-channels', async (request, reply) => {
    const body = createChannelRequestSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    if (!cipher) return keyMissing(reply);
    const userId = sessionUser(request).id;
    const { id = randomUUID(), type, name = CHANNEL_TYPE_LABELS[type], isDefault = false } = body.data;
    const context = credentialContext(userId, id);

    let settings: EmailSettings | Record<string, never>;
    let secret: FeishuCredentials | EmailCredentials;
    let hints;
    if (body.data.type === 'feishu') {
      const credentials: FeishuCredentials = { webhookUrl: body.data.config.webhookUrl, secret: body.data.config.secret || null };
      [settings, secret, hints] = [{}, credentials, feishuHints(credentials)];
    } else {
      const { password, ...rest } = body.data.config;
      [settings, secret, hints] = [rest, { password }, emailHints({ password })];
    }

    return respond(
      reply,
      () =>
        app.sync.transaction(userId, (ops) =>
          ops.insert(notificationChannels, {
            id,
            type,
            name,
            isDefault,
            settings,
            credentials: cipher.seal(secret, context),
            credentialHints: hints,
          }),
        ),
      (row) => reply.code(201).send(channelToApi(row)),
    );
  });

  app.patch<Params>('/api/notification-channels/:id', async (request, reply) => {
    const userId = sessionUser(request).id;
    const channel = await findOwned(app.db, notificationChannels, userId, request.params.id);
    if (!channel) return notFound(reply);
    const body = updateChannelRequestSchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);
    const { config, ...fields } = body.data;

    const foreign = Object.keys(config ?? {}).filter((k) => !CHANNEL_CONFIG_FIELDS[channel.type].includes(k));
    if (foreign.length > 0) {
      return sendError(reply, 400, 'invalid_request', `${CHANNEL_TYPE_LABELS[channel.type]}渠道没有这些字段：${foreign.join('、')}`);
    }

    const patch: Partial<typeof notificationChannels.$inferInsert> = { ...fields };
    const context = credentialContext(userId, channel.id);
    if (config && channel.type === 'feishu') {
      const newUrl = config.webhookUrl || undefined;
      const newSecret = config.secret === '' ? undefined : config.secret;
      if (newUrl !== undefined || newSecret !== undefined) {
        if (!cipher) return keyMissing(reply);
        const current = openOrNull<FeishuCredentials>(cipher, channel.credentials, context);
        if (!current && newUrl === undefined) return credentialsLost(reply, 'Webhook URL');
        const next: FeishuCredentials = {
          webhookUrl: newUrl ?? (current as FeishuCredentials).webhookUrl,
          secret: newSecret === undefined ? (current?.secret ?? null) : newSecret,
        };
        Object.assign(patch, { credentials: cipher.seal(next, context), credentialHints: feishuHints(next) });
      }
    } else if (config && channel.type === 'email') {
      const { password, ...rest } = config as Partial<EmailSettings> & { password?: string };
      if (Object.keys(rest).length > 0) patch.settings = { ...(channel.settings as EmailSettings), ...rest };
      if (password) {
        if (!cipher) return keyMissing(reply);
        Object.assign(patch, { credentials: cipher.seal({ password }, context), credentialHints: emailHints({ password }) });
      }
    }

    return respond(
      reply,
      () =>
        app.sync.transaction(userId, async (ops) => {
          const row = await ops.update(notificationChannels, channel.id, patch);
          if (!row) throw new Rejection(notFound);
          return row;
        }),
      (row) => channelToApi(row),
    );
  });

  app.delete<Params>('/api/notification-channels/:id', async (request, reply) => {
    const userId = sessionUser(request).id;
    const channel = await findOwned(app.db, notificationChannels, userId, request.params.id);
    if (!channel) return notFound(reply);
    const deleted = await app.sync.transaction(userId, (ops) => ops.softDelete(notificationChannels, channel.id));
    if (!deleted) return notFound(reply);
    return reply.code(204).send();
  });

  /** 发送测试消息: 200 when delivered, otherwise 502 with the concrete reason. */
  app.post<Params>('/api/notification-channels/:id/test', async (request, reply) => {
    const userId = sessionUser(request).id;
    const channel = await findOwned(app.db, notificationChannels, userId, request.params.id);
    if (!channel) return notFound(reply);
    if (!cipher) return keyMissing(reply);
    const result = await app.notifier.send(userId, channel.id, testMessage(channel.name));
    if (!result.ok) return sendError(reply, 502, 'channel_send_failed', result.error);
    return { ok: true };
  });
}

function openOrNull<T>(cipher: CredentialCipher, sealed: string, context: string): T | null {
  try {
    return cipher.open<T>(sealed, context);
  } catch {
    return null;
  }
}

const credentialsLost = (reply: FastifyReply, field: string) =>
  sendError(reply, 400, 'credentials_unreadable', `已保存的凭证无法解密（APP_ENCRYPTION_KEY 可能已更换），请重新填写${field}`);
