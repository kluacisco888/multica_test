import { expect, test, type Page } from '@playwright/test';
import { createUser, isMobile, logIn, openSidebar } from './support.js';

/*
 * 快捷键 (EURO-21, spec 用户故事 105–106): one test per shortcut in the `?`
 * panel, plus the guard that single-key shortcuts never fire while typing in
 * an input, a textarea or the search box, or while a dialog is open.
 * Keyboard tests run on the desktop layout; the panel itself also on 390px.
 */

const quickAdd = (page: Page) => page.getByRole('textbox', { name: '添加任务' });
const openTasks = (page: Page) => page.getByRole('list', { name: '任务', exact: true });
const titleButton = (page: Page, title: string) => openTasks(page).getByRole('button', { name: title, exact: true });
const subtasksOf = (page: Page, title: string) => page.getByRole('list', { name: `「${title}」的子任务` });
const panel = (page: Page) => page.getByRole('dialog', { name: '快捷键' });

async function addTasks(page: Page, ...titles: string[]) {
  // Quick add puts new tasks on top: add in reverse so they read in order.
  for (const title of [...titles].reverse()) {
    await quickAdd(page).fill(title);
    await quickAdd(page).press('Enter');
    await expect(titleButton(page, title)).toBeVisible();
  }
}

/** Select a task by clicking its title; focus stays on the row (not in a text box). */
async function select(page: Page, title: string) {
  await titleButton(page, title).click();
  await expect(titleButton(page, title)).toHaveAttribute('aria-current', 'true');
  await expect(titleButton(page, title)).toBeFocused();
}

async function start(page: Page, prefix: string) {
  const user = createUser(prefix);
  await logIn(page, user.username, user.password);
  return user;
}

test.describe('keyboard', () => {
  test.beforeEach(({ page }) => {
    test.skip(isMobile(page), 'keyboard shortcuts: desktop layout');
  });

  test('N focuses 添加任务 without typing the "n"', async ({ page }) => {
    await start(page, 'kb-n');
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await expect(quickAdd(page)).not.toBeFocused();
    await page.keyboard.press('n');
    await expect(quickAdd(page)).toBeFocused();
    await expect(quickAdd(page)).toHaveValue('');
    // Upper-case (Caps Lock) works too.
    await page.getByRole('heading', { level: 1, name: '收件箱' }).click();
    await page.keyboard.press('N');
    await expect(quickAdd(page)).toBeFocused();
  });

  test('Enter in 添加任务 saves the task and keeps the box ready for the next one', async ({ page }) => {
    await start(page, 'kb-enter');
    await quickAdd(page).fill('第一件');
    await page.keyboard.press('Enter');
    await expect(titleButton(page, '第一件')).toBeVisible();
    await expect(quickAdd(page)).toHaveValue('');
    await expect(quickAdd(page)).toBeFocused();
  });

  test('Ctrl+K (and ⌘K) opens 搜索 with the box focused', async ({ page }) => {
    await start(page, 'kb-k');
    await page.keyboard.press('Control+k');
    await expect(page).toHaveURL(/search/);
    const box = page.getByRole('searchbox', { name: '搜索任务' });
    await expect(box).toBeFocused();

    // Again while on 搜索: back to the box.
    await box.blur();
    await page.keyboard.press('Control+k');
    await expect(box).toBeFocused();

    // ⌘K from the 收件箱, even with the focus in an input (it types no character).
    await page.getByRole('navigation', { name: '模块' }).getByRole('link', { name: '任务' }).click();
    await expect(page.getByRole('heading', { level: 1, name: '收件箱' })).toBeVisible();
    await quickAdd(page).focus();
    await page.keyboard.press('Meta+k');
    await expect(box).toBeFocused();
  });

  test('? opens the 快捷键 panel listing every shortcut; Esc closes it and returns focus', async ({ page }, testInfo) => {
    await start(page, 'kb-help');
    await addTasks(page, '一');
    await select(page, '一');
    await page.keyboard.press('?');
    await expect(panel(page)).toBeVisible();
    const rows = panel(page).locator('.shortcut-row');
    const expected: [string, string][] = [
      ['搜索', 'Ctrl+K'],
      ['快捷键', '?'],
      ['取消', 'Esc'],
      ['添加任务', 'N'],
      ['保存并继续添加', 'Enter'],
      ['缩进为子任务', 'Tab'],
      ['取消缩进', 'Shift+Tab'],
      ['设为高优先级', '1'],
      ['设为中优先级', '2'],
      ['设为低优先级', '3'],
      ['设为无优先级', '0'],
    ];
    await expect(rows).toHaveCount(expected.length);
    for (const [i, [label, keys]] of expected.entries()) {
      await expect(rows.nth(i).locator('dt')).toHaveText(label);
      await expect(rows.nth(i).locator('dd')).toHaveText(keys);
    }
    await expect(panel(page).getByRole('heading', { name: '通用' })).toBeVisible();
    await expect(panel(page).getByRole('heading', { name: '任务' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`shortcuts-panel-${testInfo.project.name}.png`) });

    // Inside the panel the single keys do nothing (the dialog owns the keyboard).
    await page.keyboard.press('1');
    await expect(titleButton(page, '一')).not.toHaveAttribute('aria-description', '高优先级');

    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
    await expect(titleButton(page, '一')).toBeFocused();
  });

  test('1 / 2 / 3 / 0 set 高 / 中 / 低 / 无 优先级 on the selected task, and it is saved', async ({ page }) => {
    await start(page, 'kb-priority');
    await addTasks(page, '甲', '乙');
    await select(page, '甲');
    const row = titleButton(page, '甲');

    await page.keyboard.press('1');
    await expect(row).toHaveAttribute('aria-description', '高优先级');
    await page.keyboard.press('2');
    await expect(row).toHaveAttribute('aria-description', '中优先级');
    await page.keyboard.press('3');
    await expect(row).toHaveAttribute('aria-description', '低优先级');
    await page.keyboard.press('0');
    await expect(row).not.toHaveAttribute('aria-description', /优先级/);
    await page.keyboard.press('1');
    await expect(row).toHaveAttribute('aria-description', '高优先级');
    // Only the selected task changed.
    await expect(titleButton(page, '乙')).not.toHaveAttribute('aria-description', /优先级/);

    await page.reload();
    await expect(titleButton(page, '甲')).toHaveAttribute('aria-description', '高优先级');
  });

  test('1 / 2 / 3 / 0 do nothing when no task is selected', async ({ page }) => {
    await start(page, 'kb-priority-none');
    await addTasks(page, '丙');
    await page.getByRole('heading', { level: 1, name: '收件箱' }).click();
    for (const key of ['1', '2', '3', '0']) await page.keyboard.press(key);
    await expect(titleButton(page, '丙')).not.toHaveAttribute('aria-description', /优先级/);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('Tab indents the selected task under the one above; Shift+Tab outdents it', async ({ page }) => {
    await start(page, 'kb-tab');
    await addTasks(page, '父', '子');
    await select(page, '子');
    await page.keyboard.press('Tab');
    await expect(subtasksOf(page, '父').getByRole('button', { name: '子', exact: true })).toBeVisible();
    await expect(titleButton(page, '子')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(subtasksOf(page, '父')).toHaveCount(0);
    await expect(openTasks(page).getByRole('button', { name: /^(父|子)$/ })).toHaveText(['父', '子']);
  });

  test('typing in inputs never triggers N, ?, 1, 2, 3 or 0', async ({ page }) => {
    await start(page, 'kb-typing');
    await addTasks(page, '目标');
    await select(page, '目标');
    const row = titleButton(page, '目标');
    const typed = 'n?1230N';

    // 添加任务 box.
    await quickAdd(page).click();
    await page.keyboard.type(typed);
    await expect(quickAdd(page)).toHaveValue(typed);
    await expect(panel(page)).toHaveCount(0);
    await quickAdd(page).fill('');

    // The detail's 任务标题 and 描述 textareas, with the task still selected.
    const title = page.getByRole('textbox', { name: '任务标题' });
    await title.click();
    await page.keyboard.press('End');
    await page.keyboard.type(typed);
    await expect(title).toHaveValue(`目标${typed}`);
    await expect(panel(page)).toHaveCount(0);
    await expect(quickAdd(page)).not.toBeFocused();
    await title.fill('目标');
    await title.blur();

    const description = page.getByRole('textbox', { name: '描述' });
    await description.click();
    await page.keyboard.type(typed);
    await expect(description).toHaveValue(typed);
    await expect(panel(page)).toHaveCount(0);
    await description.fill('');
    await description.blur();

    // None of that touched the 优先级.
    await expect(row).not.toHaveAttribute('aria-description', /优先级/);

    // The 搜索 box.
    await page.keyboard.press('Control+k');
    const box = page.getByRole('searchbox', { name: '搜索任务' });
    await expect(box).toBeFocused();
    await page.keyboard.type(typed);
    await expect(box).toHaveValue(typed);
    await expect(panel(page)).toHaveCount(0);
  });

  test('a dialog owns the keyboard: N and ? do nothing while 设置 is open', async ({ page }) => {
    await start(page, 'kb-dialog');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '设置' });
    await expect(settings).toBeVisible();
    await settings.getByRole('tab', { name: '外观' }).focus();
    await page.keyboard.press('?');
    await page.keyboard.press('n');
    await expect(panel(page)).toHaveCount(0);
    await expect(quickAdd(page)).not.toBeFocused();
    // Esc (取消) closes the dialog.
    await page.keyboard.press('Escape');
    await expect(settings).toBeHidden();
  });
});

test('设置 →「快捷键」shows the same list (desktop and 390px)', async ({ page }, testInfo) => {
  await start(page, 'kb-settings');
  if (isMobile(page)) await openSidebar(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置' });
  await dialog.getByRole('tab', { name: '快捷键' }).click();
  await expect(dialog.getByRole('heading', { name: '快捷键' })).toBeVisible();
  await expect(dialog.locator('.shortcut-row')).toHaveCount(11);
  await expect(dialog.locator('.shortcut-row').filter({ hasText: '添加任务' }).locator('dd')).toHaveText('N');
  await page.screenshot({ path: testInfo.outputPath(`shortcuts-settings-${testInfo.project.name}.png`) });
});

test('? opens the panel on the 390px layout too (hardware keyboard)', async ({ page }, testInfo) => {
  test.skip(!isMobile(page), 'mobile layout');
  await start(page, 'kb-mobile');
  await page.getByRole('heading', { level: 1, name: '收件箱' }).click();
  await page.keyboard.press('?');
  await expect(panel(page)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`shortcuts-panel-${testInfo.project.name}.png`) });
  await panel(page).getByRole('button', { name: '关闭' }).click();
  await expect(panel(page)).toBeHidden();
});
