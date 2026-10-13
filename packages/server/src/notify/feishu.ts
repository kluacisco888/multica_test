import { createHmac } from 'node:crypto';
import type { ChannelMessage } from '@dida/shared';
import type { FeishuCredentials } from '../db/schema/channels.js';
import type { DeliveryResult } from './notifier.js';

/*
 * 飞书自定义机器人 Webhook. With 签名校验 on, the body carries `timestamp`
 * (unix seconds) and `sign` = base64(HMAC-SHA256(key = "<timestamp>\n<secret>",
 * message = "")); without a secret neither field is sent.
 * https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot
 */

const TIMEOUT_MS = 10_000;
/** 飞书 "request frequency limited": worth retrying later. */
const RATE_LIMITED_CODES = new Set([11232, 9499]);

export function feishuSign(timestamp: number, secret: string): string {
  return createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
}

export function feishuBody(credentials: FeishuCredentials, message: ChannelMessage, now: Date): Record<string, unknown> {
  const content = { msg_type: 'text', content: { text: `${message.title}\n${message.body}` } };
  if (!credentials.secret) return content;
  const timestamp = Math.floor(now.getTime() / 1000);
  return { timestamp: String(timestamp), sign: feishuSign(timestamp, credentials.secret), ...content };
}

function describeFetchError(error: unknown): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return `请求超时（${TIMEOUT_MS / 1000} 秒）`;
  }
  const cause = (error as { cause?: { message?: string; code?: string } }).cause;
  return cause?.message ?? cause?.code ?? (error as Error).message;
}

export async function sendFeishu(credentials: FeishuCredentials, message: ChannelMessage, now: Date): Promise<DeliveryResult> {
  let res: Response;
  try {
    res = await fetch(credentials.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(feishuBody(credentials, message, now)),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, error: `无法连接飞书 Webhook：${describeFetchError(error)}`, retryable: true };
  }

  const text = await res.text().catch(() => '');
  let json: { code?: number; msg?: string; StatusCode?: number; StatusMessage?: string } = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    // Not JSON (proxy error page etc.): report the HTTP status only.
  }
  const code = json.code ?? json.StatusCode ?? 0;
  const msg = json.msg ?? json.StatusMessage;

  if (!res.ok) {
    return {
      ok: false,
      error: `飞书返回 HTTP ${res.status}${msg ? `：${msg}` : ''}`,
      retryable: res.status >= 500 || res.status === 429,
    };
  }
  if (code !== 0) {
    return { ok: false, error: `飞书返回错误 ${code}${msg ? `：${msg}` : ''}`, retryable: RATE_LIMITED_CODES.has(code) };
  }
  return { ok: true };
}
