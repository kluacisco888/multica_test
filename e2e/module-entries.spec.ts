import { expect, test } from '@playwright/test';
import { createUser, isMobile, logIn, openSidebar } from './support.js';

/*
 * Rebase check (EURO-25 on top of EURO-23 / 24 / 26): the desktop 导航条 and
 * the mobile drawer both carry 四象限, 番茄专注, 倒数日 and 习惯打卡, and each
 * one opens its own page, also when coming from another of them.
 */

const MODULES = [
  { label: '四象限', url: /\/matrix$/ },
  { label: '番茄专注', url: /\/focus$/ },
  { label: '倒数日', url: /\/countdowns$/ },
  { label: '习惯打卡', url: /\/habits$/ },
] as const;

test('四象限, 番茄专注, 倒数日 and 习惯打卡 entries all open their page', async ({ page }) => {
  const user = createUser('module-entries');
  await logIn(page, user.username, user.password);
  // Twice round, so every module is also opened from each of the others.
  for (const module of [...MODULES, ...MODULES]) {
    if (isMobile(page)) {
      const sidebar = await openSidebar(page);
      for (const m of MODULES) await expect(sidebar.getByRole('button', { name: m.label })).toBeVisible();
      await sidebar.getByRole('button', { name: module.label }).click();
    } else {
      const rail = page.getByRole('navigation', { name: '模块' });
      for (const m of MODULES) await expect(rail.getByRole('link', { name: m.label })).toBeVisible();
      await rail.getByRole('link', { name: module.label }).click();
      await expect(rail.getByRole('link', { name: module.label })).toHaveAttribute('aria-current', 'page');
    }
    await expect(page).toHaveURL(module.url);
  }
});
