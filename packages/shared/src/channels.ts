import { z } from 'zod';
import { entityNameSchema } from './lists.js';

/*
 * 通知渠道 (spec 用户故事 74–77、85, ADR-0005): a 飞书机器人 Webhook or an SMTP
 * mailbox that 提醒, 专注 and 习惯 deliver messages to. Credentials (Webhook
 * URL, 签名 secret, 授权码) are stored encrypted; the API only ever returns
 * masked values. On update, a credential that is omitted (or an empty string)
 * keeps the stored value.
 */

export const CHANNEL_TYPES = ['feishu', 'email'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const CHANNEL_TYPE_LABELS: Record<ChannelType, string> = {
  feishu: '飞书机器人',
  email: '邮件',
};

export const SMTP_SECURITY = ['ssl', 'starttls', 'none'] as const;
export type SmtpSecurity = (typeof SMTP_SECURITY)[number];

export const SMTP_SECURITY_LABELS: Record<SmtpSecurity, string> = {
  ssl: 'SSL/TLS',
  starttls: 'STARTTLS',
  none: '不加密',
};

/** Usual port for each encryption mode. */
export const SMTP_DEFAULT_PORTS: Record<SmtpSecurity, number> = { ssl: 465, starttls: 587, none: 25 };

/** QQ 邮箱 preset: smtp.qq.com over SSL on 465; the password is the 授权码, not the QQ password. */
export const QQ_MAIL_PRESET = { host: 'smtp.qq.com', port: 465, security: 'ssl' } as const satisfies {
  host: string;
  port: number;
  security: SmtpSecurity;
};

const httpUrlSchema = z
  .string()
  .trim()
  .max(2048, 'Webhook URL 太长')
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
      return false;
    }
  }, 'Webhook URL 必须是 http(s) 地址');

const secretSchema = z.string().trim().max(512, '内容太长');
const hostSchema = z
  .string()
  .trim()
  .min(1, 'SMTP 服务器不能为空')
  .max(253)
  .regex(/^[A-Za-z0-9.-]+$|^\[[0-9A-Fa-f:.]+\]$/, 'SMTP 服务器格式不正确');
const portSchema = z.number().int().min(1, '端口不正确').max(65535, '端口不正确');
const emailSchema = z.email('邮箱地址格式不正确').max(254);

/* ---- API responses (masked) ---- */

const channelBase = {
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  revision: z.number().int().nonnegative(),
  name: z.string(),
  isDefault: z.boolean(),
};

export const feishuChannelSchema = z.object({
  ...channelBase,
  type: z.literal('feishu'),
  config: z.object({
    /** Masked, e.g. `https://open.feishu.cn/****90ab`. */
    webhookUrl: z.string(),
    /** Masked secret, or null when the channel does not sign. */
    secret: z.string().nullable(),
  }),
});

export const emailChannelSchema = z.object({
  ...channelBase,
  type: z.literal('email'),
  config: z.object({
    host: z.string(),
    port: z.number().int(),
    security: z.enum(SMTP_SECURITY),
    username: z.string(),
    /** Masked 授权码. */
    password: z.string(),
    to: z.string(),
  }),
});

export const notificationChannelSchema = z.discriminatedUnion('type', [feishuChannelSchema, emailChannelSchema]);
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;
export type FeishuChannel = z.infer<typeof feishuChannelSchema>;
export type EmailChannel = z.infer<typeof emailChannelSchema>;

export const channelsResponseSchema = z.object({ channels: z.array(notificationChannelSchema) });
export type ChannelsResponse = z.infer<typeof channelsResponseSchema>;

/** `POST /api/notification-channels/:id/test` on success; failures answer 502 `channel_send_failed`. */
export const channelTestResponseSchema = z.object({ ok: z.literal(true) });

/* ---- Requests ---- */

export const feishuConfigSchema = z.object({
  webhookUrl: httpUrlSchema,
  /** 签名 secret, only when 签名校验 is enabled in 飞书. Empty means none. */
  secret: secretSchema.optional(),
});

export const emailConfigSchema = z.object({
  host: hostSchema,
  port: portSchema,
  security: z.enum(SMTP_SECURITY),
  username: z.string().trim().min(1, '账号不能为空').max(254),
  password: z.string().min(1, '授权码不能为空').max(512),
  to: emailSchema,
});

const createBase = {
  /** Client-generated id (ADR-0004). */
  id: z.uuid().optional(),
  name: entityNameSchema.optional(),
  isDefault: z.boolean().optional(),
};

export const createChannelRequestSchema = z.discriminatedUnion('type', [
  z.object({ ...createBase, type: z.literal('feishu'), config: feishuConfigSchema }).strict(),
  z.object({ ...createBase, type: z.literal('email'), config: emailConfigSchema }).strict(),
]);
export type CreateChannelRequest = z.input<typeof createChannelRequestSchema>;

/** `''` for a credential means "keep the stored value", like omitting it. */
const keepIfEmpty = <T extends z.ZodType>(schema: T) => z.union([z.literal(''), schema]).optional();

/**
 * PATCH body. The channel type cannot change. Credentials omitted or `''`
 * keep their stored value; `secret: null` turns 飞书 signing off.
 */
export const updateChannelRequestSchema = z
  .object({
    name: entityNameSchema,
    isDefault: z.boolean(),
    config: z
      .object({
        webhookUrl: keepIfEmpty(httpUrlSchema),
        secret: z.union([z.literal(''), secretSchema, z.null()]).optional(),
        host: hostSchema,
        port: portSchema,
        security: z.enum(SMTP_SECURITY),
        username: z.string().trim().min(1, '账号不能为空').max(254),
        password: keepIfEmpty(z.string().max(512)),
        to: emailSchema,
      })
      .partial()
      .strict(),
  })
  .partial()
  .strict();
export type UpdateChannelRequest = z.input<typeof updateChannelRequestSchema>;

/** Which config fields belong to which channel type (PATCH rejects the others). */
export const CHANNEL_CONFIG_FIELDS: Record<ChannelType, readonly string[]> = {
  feishu: ['webhookUrl', 'secret'],
  email: ['host', 'port', 'security', 'username', 'password', 'to'],
};

/** Message handed to a 通知渠道 by 提醒, 专注 and 习惯. */
export interface ChannelMessage {
  title: string;
  body: string;
}
