import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';

describe('password hashing (argon2id)', () => {
  it('produces a PHC string that verifies only the original password', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
    expect(hash).not.toContain('correct horse');
    expect(await verifyPassword(hash, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse batterY')).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same password')).not.toBe(await hashPassword('same password'));
  });

  it('rejects malformed or tampered hashes instead of throwing', async () => {
    const hash = await hashPassword('pw12345678');
    const tampered = hash.slice(0, -2) + (hash.endsWith('AA') ? 'BB' : 'AA');
    expect(await verifyPassword(tampered, 'pw12345678')).toBe(false);
    expect(await verifyPassword('', 'pw12345678')).toBe(false);
    expect(await verifyPassword('$argon2i$v=19$m=1,t=1,p=1$AAAA$AAAA', 'pw12345678')).toBe(false);
    expect(await verifyPassword('plain-text', 'plain-text')).toBe(false);
  });

  it('verifies against the parameters stored in the hash', async () => {
    const cheap = await hashPassword('pw12345678', { memoryKiB: 1024, passes: 2 });
    expect(cheap).toContain('$m=1024,t=2,p=1$');
    expect(await verifyPassword(cheap, 'pw12345678')).toBe(true);
  });
});
