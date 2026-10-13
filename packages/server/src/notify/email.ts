import nodemailer from 'nodemailer';
import type { ChannelMessage } from '@dida/shared';
import type { EmailCredentials, EmailSettings } from '../db/schema/channels.js';
import type { DeliveryResult } from './notifier.js';

/* 邮件 channel: one SMTP connection per message (提醒 are rare; no pool to keep alive). */

const TIMEOUT_MS = 15_000;

interface SmtpError extends Error {
  code?: string;
  response?: string;
  responseCode?: number;
}

function describe(error: SmtpError, settings: EmailSettings): { error: string; retryable: boolean } {
  const response = error.response?.trim();
  switch (error.code) {
    case 'EAUTH':
      return { error: `SMTP 登录失败，请检查账号和授权码（${response ?? error.message}）`, retryable: false };
    case 'ETLS':
      return {
        error: `与 SMTP 服务器建立加密连接失败，请检查加密方式和端口（${error.message}）`,
        retryable: false,
      };
    case 'ECONNECTION':
    case 'ETIMEDOUT':
    case 'ESOCKET':
    case 'EDNS':
    case 'ECONNREFUSED':
      return { error: `无法连接 SMTP 服务器 ${settings.host}:${settings.port}（${error.message}）`, retryable: true };
    default:
      if (error.responseCode) {
        return {
          error: `邮件服务器拒绝了这封邮件（${response ?? error.responseCode}）`,
          retryable: error.responseCode >= 400 && error.responseCode < 500,
        };
      }
      return { error: `邮件发送失败：${error.message}`, retryable: true };
  }
}

export async function sendEmail(
  settings: EmailSettings,
  credentials: EmailCredentials,
  message: ChannelMessage,
): Promise<DeliveryResult> {
  const transport = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.security === 'ssl',
    requireTLS: settings.security === 'starttls',
    ignoreTLS: settings.security === 'none',
    auth: { user: settings.username, pass: credentials.password },
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  });
  try {
    await transport.sendMail({
      // QQ 邮箱 only accepts mail whose sender is the logged-in account.
      from: settings.username.includes('@') ? settings.username : undefined,
      to: settings.to,
      subject: message.title,
      text: message.body,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, ...describe(error as SmtpError, settings) };
  } finally {
    transport.close();
  }
}
