import { execFileSync } from 'node:child_process';
import { expect, type Locator, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { FakeListen } from '../packages/server/test/fakes/fake-smtp.js';
import { databaseUrl, E2E_DATABASE, ensureTestPostgres } from '../scripts/test-postgres.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let e2eDatabaseUrl: string | undefined;

/*
 * Two targets (see README「测试」):
 * - default: scripts/e2e-server.mjs, the built server on the test PostgreSQL;
 * - compose: `node scripts/e2e-compose.mjs`, a `docker compose` deployment.
 *   It sets E2E_COMPOSE_APP (the app container), E2E_DATABASE_URL (its
 *   PostgreSQL, published on loopback for e2eSql only) and E2E_FAKE_BIND /
 *   E2E_FAKE_HOST (where fake receivers listen and how the container reaches them).
 */
const composeApp = process.env.E2E_COMPOSE_APP;

function e2eDatabase(): string {
  e2eDatabaseUrl ??= process.env.E2E_DATABASE_URL ?? databaseUrl(ensureTestPostgres(), E2E_DATABASE);
  return e2eDatabaseUrl;
}

/** Where fake SMTP / Webhook receivers listen so the server under test can reach them. */
export function fakeListen(): FakeListen {
  return { bind: process.env.E2E_FAKE_BIND ?? '127.0.0.1', publicHost: process.env.E2E_FAKE_HOST ?? '127.0.0.1' };
}

/**
 * Run the admin CLI (`dida …`) against the server under test: the built file
 * on the e2e database, or the real `dida` command in the compose app
 * container. `stdin` answers the password prompt.
 */
export function dida(args: string[], stdin = ''): string {
  if (composeApp) {
    return execFileSync('docker', ['exec', '-i', '-e', 'LOG_LEVEL=silent', composeApp, 'dida', ...args], {
      input: stdin,
      encoding: 'utf8',
    });
  }
  const e2eDatabaseUrl = e2eDatabase();
  return execFileSync(process.execPath, [path.join(repoRoot, 'packages/server/dist/cli.js'), ...args], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: e2eDatabaseUrl, LOG_LEVEL: 'silent' },
  });
}

/**
 * Run one parameterized SQL statement on the e2e server's database, for
 * states the app itself no longer produces (e.g. data left by a fixed bug).
 */
export async function e2eSql(text: string, values: unknown[] = []): Promise<pg.QueryResult> {
  const client = new pg.Client({ connectionString: e2eDatabase() });
  await client.connect();
  try {
    return await client.query(text, values);
  } finally {
    await client.end();
  }
}

/** A fresh user per test so parallel desktop/mobile runs never share state. */
export function createUser(prefix: string): { username: string; password: string } {
  const username = `${prefix}-${randomBytes(4).toString('hex')}`;
  const password = `pw-${randomBytes(6).toString('hex')}`;
  dida(['create-user', username], `${password}\n`);
  return { username, password };
}

export function isMobile(page: Page): boolean {
  return (page.viewportSize()?.width ?? 1440) < 768;
}

/** On mobile the sidebar is a drawer: open it (no-op on desktop). */
export async function openSidebar(page: Page): Promise<Locator> {
  const sidebar = page.getByRole('navigation', { name: '侧栏' });
  if (isMobile(page) && !(await sidebar.isVisible())) {
    await page.getByRole('button', { name: '展开侧栏' }).click();
  }
  await expect(sidebar).toBeVisible();
  return sidebar;
}

/** Open the 设置 dialog on its 账户与安全 tab (rail avatar on desktop, drawer header on mobile). */
export async function openAccount(page: Page, username: string): Promise<Locator> {
  if (isMobile(page)) await openSidebar(page);
  await page.getByRole('button', { name: `账户：${username}` }).click();
  const dialog = page.getByRole('dialog', { name: '设置' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Log in through the login form and wait for the 收件箱. */
export async function logIn(page: Page, username: string, password: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('账号').fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('heading', { level: 1, name: '收件箱' })).toBeVisible();
}
