import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { databaseUrl, E2E_DATABASE, ensureTestPostgres } from '../scripts/test-postgres.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let e2eDatabaseUrl: string | undefined;

/**
 * Run the built admin CLI (`dida …`, the same file the container runs) against
 * the e2e server's database. `stdin` answers the password prompt.
 */
export function dida(args: string[], stdin = ''): string {
  e2eDatabaseUrl ??= databaseUrl(ensureTestPostgres(), E2E_DATABASE);
  return execFileSync(process.execPath, [path.join(repoRoot, 'packages/server/dist/cli.js'), ...args], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: e2eDatabaseUrl, LOG_LEVEL: 'silent' },
  });
}

/** A fresh user per test so parallel desktop/mobile runs never share state. */
export function createUser(prefix: string): { username: string; password: string } {
  const username = `${prefix}-${randomBytes(4).toString('hex')}`;
  const password = `pw-${randomBytes(6).toString('hex')}`;
  dida(['create-user', username], `${password}\n`);
  return { username, password };
}
