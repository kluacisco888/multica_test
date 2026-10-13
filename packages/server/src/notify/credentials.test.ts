import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCredentialCipher, maskSecret, maskWebhookUrl, parseEncryptionKey } from './credentials.js';

/* 通知渠道 credentials at rest: AES-256-GCM with APP_ENCRYPTION_KEY (ADR-0005). */

const key = randomBytes(32);

describe('credential cipher', () => {
  it('round-trips credentials and never contains the plaintext', () => {
    const cipher = createCredentialCipher(key);
    const plain = { password: 'qq-auth-code-1234' };
    const sealed = cipher.seal(plain, 'user-1:channel-1');
    expect(sealed).not.toContain('qq-auth-code');
    expect(sealed).toMatch(/^v1\./);
    expect(cipher.open(sealed, 'user-1:channel-1')).toEqual(plain);
  });

  it('uses a fresh IV, so the same value encrypts differently each time', () => {
    const cipher = createCredentialCipher(key);
    expect(cipher.seal({ a: 'x' }, 'ctx')).not.toBe(cipher.seal({ a: 'x' }, 'ctx'));
  });

  it('refuses a ciphertext moved to another record, tampered with, or opened with another key', () => {
    const cipher = createCredentialCipher(key);
    const sealed = cipher.seal({ secret: 's' }, 'user-1:channel-1');
    expect(() => cipher.open(sealed, 'user-2:channel-1')).toThrow();
    const parts = sealed.split('.');
    const ct = Buffer.from(parts[3] as string, 'base64');
    ct[0] = (ct[0] as number) ^ 1;
    expect(() => cipher.open([...parts.slice(0, 3), ct.toString('base64')].join('.'), 'user-1:channel-1')).toThrow();
    expect(() => createCredentialCipher(randomBytes(32)).open(sealed, 'user-1:channel-1')).toThrow();
  });
});

describe('parseEncryptionKey', () => {
  it('accepts 32 bytes of base64 (openssl rand -base64 32)', () => {
    expect(parseEncryptionKey(key.toString('base64'))).toEqual(key);
  });

  it('rejects keys of the wrong length', () => {
    expect(() => parseEncryptionKey(randomBytes(16).toString('base64'))).toThrow(/32/);
    expect(() => parseEncryptionKey('not base64 at all!')).toThrow(/32/);
  });
});

describe('masking', () => {
  it('shows only the last 4 characters of a long secret', () => {
    expect(maskSecret('abcdefghijklmnop')).toBe('****mnop');
  });

  it('hides short secrets completely', () => {
    expect(maskSecret('abc123')).toBe('****');
  });

  it('keeps the Webhook host but hides the token', () => {
    expect(maskWebhookUrl('https://open.feishu.cn/open-apis/bot/v2/hook/0f1e2d3c-aaaa-bbbb-cccc-1234567890ab')).toBe(
      'https://open.feishu.cn/****90ab',
    );
  });
});
