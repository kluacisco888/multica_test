import { expect, test, type Page } from '@playwright/test';
import { createUser, isMobile, logIn } from './support.js';

/*
 * Keyboard edge cases for Tab / Shift+Tab on 子任务 (EURO-9 review): Tab is
 * only taken by the selected task, and only when a move is possible, so it
 * never traps keyboard focus.
 */

const quickAdd = (page: Page) => page.getByRole('textbox', { name: '添加任务' });
const openTasks = (page: Page) => page.getByRole('list', { name: '任务', exact: true });
const titleButton = (page: Page, title: string) => openTasks(page).getByRole('button', { name: title, exact: true });
const subtasksOf = (page: Page, title: string) => page.getByRole('list', { name: `「${title}」的子任务` });

test('Tab never traps focus: unselected rows, the first row and top-level Shift+Tab keep the default', async ({ page }) => {
  test.skip(isMobile(page), 'keyboard only');
  const user = createUser('tab-edges');
  await logIn(page, user.username, user.password);
  for (const title of ['B', 'A']) {
    await quickAdd(page).fill(title);
    await quickAdd(page).press('Enter');
    await expect(titleButton(page, title)).toBeVisible();
  }
  await expect(openTasks(page).getByRole('button')).toHaveText(['A', 'B']);

  // Tab in quick add just moves focus; nothing is indented.
  await quickAdd(page).focus();
  await page.keyboard.press('Tab');
  await expect(quickAdd(page)).not.toBeFocused();
  await expect(subtasksOf(page, 'A')).toHaveCount(0);

  // Focused but not selected: Tab moves focus, B stays top-level.
  await titleButton(page, 'B').focus();
  await page.keyboard.press('Tab');
  await expect(titleButton(page, 'B')).not.toBeFocused();
  await expect(subtasksOf(page, 'A')).toHaveCount(0);

  // Selected first row (no sibling above): Tab cannot indent, so focus moves on.
  await titleButton(page, 'A').click();
  await titleButton(page, 'A').focus();
  await page.keyboard.press('Tab');
  await expect(titleButton(page, 'A')).not.toBeFocused();
  await expect(page.getByRole('alert')).toHaveCount(0);

  // Selected top-level row: Shift+Tab cannot outdent, so focus moves back.
  await titleButton(page, 'A').focus();
  await page.keyboard.press('Shift+Tab');
  await expect(titleButton(page, 'A')).not.toBeFocused();

  // Selected B under A: Tab indents and keeps focus on B; Shift+Tab restores it.
  await titleButton(page, 'B').click();
  await titleButton(page, 'B').focus();
  await page.keyboard.press('Tab');
  await expect(subtasksOf(page, 'A').getByRole('button')).toHaveText(['B']);
  await expect(titleButton(page, 'B')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(subtasksOf(page, 'A')).toHaveCount(0);
  await expect(openTasks(page).getByRole('button', { name: /^(A|B)$/ })).toHaveText(['A', 'B']);
});
