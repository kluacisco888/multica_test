import { execFileSync } from 'node:child_process';
import { expect, type Locator, type Page } from '@playwright/test';
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

/** Open the 账户 dialog (rail avatar on desktop, drawer header on mobile). */
export async function openAccount(page: Page, username: string): Promise<Locator> {
  if (isMobile(page)) await openSidebar(page);
  await page.getByRole('button', { name: `账户：${username}` }).click();
  const dialog = page.getByRole('dialog', { name: '账户' });
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
