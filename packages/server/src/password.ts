import { argon2, randomBytes, timingSafeEqual, type Argon2Parameters } from 'node:crypto';
import { promisify } from 'node:util';

/*
 * Password hashing with argon2id from Node's built-in crypto (no native
 * add-on). Hashes are stored as standard PHC strings:
 *   $argon2id$v=19$m=<KiB>,t=<passes>,p=<lanes>$<salt b64>$<hash b64>
 * so the cost can be raised later and old hashes still verify.
 */

const argon2Async = promisify(argon2);

export interface HashCost {
  memoryKiB: number;
  passes: number;
}

/** OWASP 2024 minimum for argon2id: 19 MiB, 2 passes, 1 lane. */
const DEFAULT_COST: HashCost = { memoryKiB: 19_456, passes: 2 };
const PARALLELISM = 1;
const SALT_BYTES = 16;
const TAG_BYTES = 32;
/** Refuse to verify hashes asking for absurd cost (defends against a planted hash). */
const MAX_MEMORY_KIB = 1024 * 1024;
const MAX_PASSES = 16;

const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

function b64(buffer: Buffer): string {
  return buffer.toString('base64').replace(/=+$/, '');
}

async function derive(password: string, salt: Buffer, cost: HashCost, lanes: number, tagLength: number) {
  const params: Argon2Parameters = {
    message: password,
    nonce: salt,
    parallelism: lanes,
    tagLength,
    memory: cost.memoryKiB,
    passes: cost.passes,
  };
  return argon2Async('argon2id', params);
}

export async function hashPassword(password: string, cost: HashCost = DEFAULT_COST): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const tag = await derive(password, salt, cost, PARALLELISM, TAG_BYTES);
  return `$argon2id$v=19$m=${cost.memoryKiB},t=${cost.passes},p=${PARALLELISM}$${b64(salt)}$${b64(tag)}`;
}

/** True only if `hash` is a well-formed argon2id PHC string for `password`. Never throws. */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  const match = PHC.exec(hash);
  if (!match) return false;
  const [, m, t, p, saltB64, tagB64] = match as unknown as [string, string, string, string, string, string];
  const memoryKiB = Number(m);
  const passes = Number(t);
  const lanes = Number(p);
  if (memoryKiB > MAX_MEMORY_KIB || passes > MAX_PASSES || lanes < 1 || lanes > 16) return false;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(tagB64, 'base64');
  if (salt.length < 8 || expected.length < 16) return false;
  try {
    const actual = await derive(password, salt, { memoryKiB, passes }, lanes, expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
