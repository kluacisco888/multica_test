import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/*
 * 通知渠道 credentials at rest (ADR-0005): AES-256-GCM with the 32-byte
 * APP_ENCRYPTION_KEY. Sealed format: `v1.<iv>.<tag>.<ciphertext>` (base64).
 * The `context` (user id + channel id) is bound as additional authenticated
 * data, so a ciphertext copied onto another row or user does not decrypt.
 */

const VERSION = 'v1';
const IV_BYTES = 12;

export interface CredentialCipher {
  seal(value: Record<string, unknown>, context: string): string;
  /** Throws when the ciphertext was tampered with, moved, or sealed with another key. */
  open<T = Record<string, unknown>>(sealed: string, context: string): T;
}

/** Decode APP_ENCRYPTION_KEY (`openssl rand -base64 32`); throws unless it is exactly 32 bytes. */
export function parseEncryptionKey(value: string): Buffer {
  const trimmed = value.trim();
  const key = /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) ? Buffer.from(trimmed, 'base64') : Buffer.alloc(0);
  if (key.length !== 32) {
    throw new Error('APP_ENCRYPTION_KEY must be 32 bytes encoded as base64 (openssl rand -base64 32)');
  }
  return key;
}

export function createCredentialCipher(key: Buffer): CredentialCipher {
  if (key.length !== 32) throw new Error('credential key must be 32 bytes');
  return {
    seal(value, context) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(context, 'utf8'));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join('.');
    },
    open<T>(sealed: string, context: string): T {
      const [version, iv, tag, ciphertext] = sealed.split('.');
      if (version !== VERSION || !iv || !tag || ciphertext === undefined) throw new Error('unknown credential format');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      decipher.setAAD(Buffer.from(context, 'utf8'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]);
      return JSON.parse(plain.toString('utf8')) as T;
    },
  };
}

/** `****` plus the last 4 characters; short secrets are hidden completely. */
export function maskSecret(value: string): string {
  return value.length >= 12 ? `****${value.slice(-4)}` : '****';
}

/** Webhook URL with the host kept (to recognise it) and the path token hidden. */
export function maskWebhookUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}/${maskSecret(`${url.pathname}${url.search}`)}`;
  } catch {
    return maskSecret(value);
  }
}
