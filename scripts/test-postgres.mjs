// Locate (or start) the PostgreSQL used by API and e2e tests.
// - TEST_DATABASE_URL set (CI service container): use it as the admin URL.
// - otherwise: start docker-compose.test.yml (project dida-clone-test,
//   127.0.0.1:${TEST_PG_PORT:-55432}) and wait until it is healthy.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function ensureTestPostgres() {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const port = process.env.TEST_PG_PORT ?? '55432';
  execFileSync(
    'docker',
    ['compose', '-f', path.join(repoRoot, 'docker-compose.test.yml'), 'up', '-d', '--wait'],
    { stdio: 'inherit', env: { ...process.env, TEST_PG_PORT: port } },
  );
  const url = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
  process.env.TEST_DATABASE_URL = url;
  return url;
}

/** Database the Playwright server (scripts/e2e-server.mjs) runs on. */
export const E2E_DATABASE = 'dida_e2e';

/** Same server as `adminUrl`, different database name. */
export function databaseUrl(adminUrl, database) {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}
