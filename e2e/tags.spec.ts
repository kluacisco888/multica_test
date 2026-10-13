import { expect, test, type Page } from '@playwright/test';
import { createUser, isMobile, logIn, openSidebar } from './support.js';

/*
 * 优先级 and nested 标签 (EURO-8, spec 用户故事 18、19、22).
 * Runs at 1440px and 390px (playwright.config.ts projects).
 */

const listTitle = (page: Page) => page.getByRole('heading', { level: 1 });
const quickAdd = (page: Page) => page.getByRole('textbox', { name: '添加任务' });
const openTasks = (page: Page) => page.getByRole('list', { name: '任务', exact: true });
const detail = (page: Page) => page.getByRole('complementary', { name: '任务详情' });
const row = (page: Page, title: string) => openTasks(page).getByRole('listitem').filter({ has: page.getByRole('button', { name: title, exact: true }) });

/** Outline colours from tokens.css. */
const PRIORITY_BORDER = {
  high: 'rgb(224, 49, 49)',
  medium: 'rgb(194, 124, 14)',
  low: 'rgb(71, 114, 250)',
  none: 'rgb(138, 139, 141)',
};

async function addTasks(page: Page, ...titles: string[]) {
  for (const title of titles) {
    await quickAdd(page).fill(title);
    await quickAdd(page).press('Enter');
    await expect(openTasks(page).getByRole('button', { name: title, exact: true })).toBeVisible();
  }
}

async function openTask(page: Page, title: string) {
  await openTasks(page).getByRole('button', { name: title, exact: true }).click();
  await expect(detail(page).getByRole('textbox', { name: '任务标题' })).toHaveValue(title);
}

async function backToList(page: Page) {
  if (isMobile(page)) await page.getByRole('button', { name: '返回列表' }).click();
}

async function createTag(page: Page, name: string, options: { color?: string; parent?: string } = {}) {
  const sidebar = await openSidebar(page);
  if (options.parent) {
    await sidebar.getByRole('button', { name: `标签操作：${options.parent}` }).click();
    await page.getByRole('menuitem', { name: '添加子标签' }).click();
  } else {
    await sidebar.getByRole('button', { name: '添加标签' }).click();
  }
  const dialog = page.getByRole('dialog', { name: '添加标签' });
  await dialog.getByLabel('名称').fill(name);
  if (options.color) await dialog.getByRole('radio', { name: options.color, exact: true }).check();
  if (options.parent) await expect(dialog.getByLabel('父标签')).toHaveValue(/.+/);
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog).toBeHidden();
  await expect(listTitle(page)).toHaveText(name);
}

async function openTag(page: Page, name: string) {
  const sidebar = await openSidebar(page);
  await sidebar.getByRole('list', { name: '标签', exact: true }).getByRole('link', { name, exact: true }).click();
  await expect(listTitle(page)).toHaveText(name);
}

async function openInbox(page: Page) {
  const sidebar = await openSidebar(page);
  await sidebar.getByRole('link', { name: /收件箱/ }).click();
  await expect(listTitle(page)).toHaveText('收件箱');
}

/** Toggle a 标签 on the open task through the detail pane's 标签 menu. */
async function toggleTagInDetail(page: Page, path: string) {
  await detail(page).getByRole('button', { name: '设置标签' }).click();
  await page.getByRole('menuitemcheckbox', { name: path, exact: true }).click();
}

test('优先级 from the task detail and from the right-click menu, with the reference colours', async ({ page }, testInfo) => {
  const user = createUser('prio');
  await logIn(page, user.username, user.password);
  await addTasks(page, '普通', '要紧', '有空再说');

  // Default: no priority, plain outline.
  await expect(row(page, '普通').getByRole('checkbox')).toHaveCSS('border-top-color', PRIORITY_BORDER.none);

  // Detail pane: the flag menu in the header.
  await openTask(page, '要紧');
  await detail(page).getByRole('button', { name: '优先级：无优先级' }).click();
  await page.getByRole('menuitemradio', { name: '高优先级' }).click();
  await expect(detail(page).getByRole('button', { name: '优先级：高优先级' })).toBeVisible();
  await expect(detail(page).getByRole('checkbox', { name: '要紧' })).toHaveCSS('border-top-color', PRIORITY_BORDER.high);
  await backToList(page);
  await expect(row(page, '要紧').getByRole('checkbox')).toHaveCSS('border-top-color', PRIORITY_BORDER.high);

  // Right-click menu on a row (long press on touch fires the same contextmenu event).
  await row(page, '有空再说').click({ button: 'right' });
  const menu = page.getByRole('menu', { name: '任务操作：有空再说' });
  await expect(menu.getByRole('menuitemradio', { name: '无优先级' })).toHaveAttribute('aria-checked', 'true');
  await menu.getByRole('menuitemradio', { name: '低优先级' }).click();
  await expect(menu).toBeHidden();
  await expect(row(page, '有空再说').getByRole('checkbox')).toHaveCSS('border-top-color', PRIORITY_BORDER.low);

  // Keyboard: Shift+F10 on the focused task opens the same menu; arrows move, Enter picks.
  if (!isMobile(page)) {
    await openTasks(page).getByRole('button', { name: '普通', exact: true }).focus();
    await page.keyboard.press('Shift+F10');
    const keyMenu = page.getByRole('menu', { name: '任务操作：普通' });
    await expect(keyMenu.getByRole('menuitemradio', { name: '高优先级' })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(keyMenu.getByRole('menuitemradio', { name: '中优先级' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(keyMenu).toBeHidden();
    await expect(openTasks(page).getByRole('button', { name: '普通', exact: true })).toBeFocused();
  } else {
    await row(page, '普通').click({ button: 'right' });
    await page.getByRole('menu', { name: '任务操作：普通' }).getByRole('menuitemradio', { name: '中优先级' }).click();
  }
  await expect(row(page, '普通').getByRole('checkbox')).toHaveCSS('border-top-color', PRIORITY_BORDER.medium);

  // Esc closes the menu without changing anything.
  await row(page, '要紧').click({ button: 'right' });
  await expect(page.getByRole('menu', { name: '任务操作：要紧' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`priority-menu-${testInfo.project.name}.png`) });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu', { name: '任务操作：要紧' })).toBeHidden();

  // Stored on the server.
  await page.reload();
  await expect(row(page, '要紧').getByRole('checkbox')).toHaveCSS('border-top-color', PRIORITY_BORDER.high);
  await expect(row(page, '普通').getByRole('checkbox')).toHaveCSS('border-top-color', PRIORITY_BORDER.medium);
  await expect(row(page, '有空再说').getByRole('checkbox')).toHaveCSS('border-top-color', PRIORITY_BORDER.low);
  await page.screenshot({ path: testInfo.outputPath(`priority-${testInfo.project.name}.png`) });
});

test('nested 标签: tag tasks, a parent 标签 view includes its children, rename, recolour and delete', async ({ page }, testInfo) => {
  const user = createUser('tags');
  await logIn(page, user.username, user.password);
  await addTasks(page, '写方案', '开周会', '买菜');

  await createTag(page, '工作', { color: '蓝色' });
  await createTag(page, '会议', { parent: '工作', color: '橙色' });
  await createTag(page, '生活');
  let sidebar = await openSidebar(page);
  const tagTree = sidebar.getByRole('list', { name: '标签', exact: true });
  await expect(tagTree.locator('.sidebar-item-name')).toHaveText(['工作', '会议', '生活']);
  await expect(tagTree.getByRole('link', { name: '工作', exact: true }).locator('.sidebar-color-dot')).toHaveCSS(
    'background-color',
    'rgb(76, 161, 255)',
  );
  // Collapse / expand the children of a parent 标签.
  await sidebar.getByRole('button', { name: '收起子标签：工作' }).click();
  await expect(tagTree.getByRole('link', { name: '会议', exact: true })).toHaveCount(0);
  await sidebar.getByRole('button', { name: '展开子标签：工作' }).click();
  await expect(tagTree.getByRole('link', { name: '会议', exact: true })).toBeVisible();
  if (isMobile(page)) await sidebar.getByRole('button', { name: '关闭侧栏' }).click();

  // Several 标签 on one task, through the detail pane and the right-click menu.
  await openInbox(page);
  await openTask(page, '写方案');
  await toggleTagInDetail(page, '工作');
  await expect(detail(page).getByRole('list', { name: '标签' }).getByRole('listitem')).toHaveText(['工作']);
  await toggleTagInDetail(page, '生活');
  await expect(detail(page).getByRole('list', { name: '标签' }).getByRole('listitem')).toHaveText(['工作', '生活']);
  await backToList(page);
  await row(page, '开周会').click({ button: 'right' });
  await page.getByRole('menu', { name: '任务操作：开周会' }).getByRole('menuitemcheckbox', { name: '工作/会议' }).click();
  await expect(row(page, '开周会').getByRole('list', { name: '标签' })).toHaveText('会议');
  await expect(row(page, '写方案').getByRole('listitem')).toHaveText(['工作', '生活']);

  // Parent 标签 view: its own tasks plus the children's.
  await openTag(page, '工作');
  await expect(openTasks(page).getByRole('button')).toHaveCount(2);
  await expect(openTasks(page).getByRole('button', { name: '写方案', exact: true })).toBeVisible();
  await expect(openTasks(page).getByRole('button', { name: '开周会', exact: true })).toBeVisible();
  await expect(openTasks(page).getByRole('button', { name: '买菜', exact: true })).toHaveCount(0);
  await expect(row(page, '写方案')).toContainText('收件箱'); // 标签 views name each task's 清单
  await page.screenshot({ path: testInfo.outputPath(`tag-parent-${testInfo.project.name}.png`) });
  await openTask(page, '写方案');
  await page.screenshot({ path: testInfo.outputPath(`tag-detail-${testInfo.project.name}.png`) });
  await backToList(page);
  if (isMobile(page)) {
    await openSidebar(page);
    await page.screenshot({ path: testInfo.outputPath(`tag-drawer-${testInfo.project.name}.png`) });
    await page.getByRole('button', { name: '关闭侧栏' }).click();
  }
  // Child 标签 view: only its own.
  await openTag(page, '会议');
  await expect(openTasks(page).getByRole('button')).toHaveText(['开周会']);

  // Quick add inside a 标签 view: the task goes to the 收件箱 with that 标签.
  await addTasks(page, '订会议室');
  await expect(row(page, '订会议室').getByRole('list', { name: '标签' })).toHaveText('会议');
  await openTag(page, '工作');
  await expect(openTasks(page).getByRole('button', { name: '订会议室', exact: true })).toBeVisible();

  // Remove a 标签 from a task with its chip button.
  await openTask(page, '写方案');
  await detail(page).getByRole('button', { name: '移除标签：生活' }).click();
  await expect(detail(page).getByRole('list', { name: '标签' }).getByRole('listitem')).toHaveText(['工作']);
  await backToList(page);

  // Rename and recolour.
  sidebar = await openSidebar(page);
  await sidebar.getByRole('button', { name: '标签操作：会议' }).click();
  await page.getByRole('menuitem', { name: '编辑' }).click();
  const edit = page.getByRole('dialog', { name: '编辑标签' });
  await edit.getByLabel('名称').fill('例会');
  await edit.getByRole('radio', { name: '绿色', exact: true }).check();
  await edit.getByRole('button', { name: '保存' }).click();
  await expect(edit).toBeHidden();
  await page.reload();
  sidebar = await openSidebar(page);
  const renamed = sidebar.getByRole('list', { name: '标签', exact: true }).getByRole('link', { name: '例会', exact: true });
  await expect(renamed.locator('.sidebar-color-dot')).toHaveCSS('background-color', 'rgb(53, 216, 112)');
  if (isMobile(page)) await sidebar.getByRole('button', { name: '关闭侧栏' }).click();
  await expect(row(page, '开周会').getByRole('list', { name: '标签' })).toHaveText('例会');

  // Delete the child 标签: the tag leaves the tasks, the tasks stay.
  sidebar = await openSidebar(page);
  await sidebar.getByRole('button', { name: '标签操作：例会' }).click();
  await page.getByRole('menuitem', { name: '删除' }).click();
  const confirm = page.getByRole('dialog', { name: '删除标签' });
  await expect(confirm).toContainText('任务本身不受影响');
  await confirm.getByRole('button', { name: '删除' }).click();
  await expect(confirm).toBeHidden();
  sidebar = await openSidebar(page);
  await expect(sidebar.getByRole('link', { name: '例会', exact: true })).toHaveCount(0);
  if (isMobile(page)) await sidebar.getByRole('button', { name: '关闭侧栏' }).click();
  // Still in the 工作 view: 开周会 / 订会议室 only had the deleted child, so they leave it.
  await expect(listTitle(page)).toHaveText('工作');
  await expect(openTasks(page).getByRole('button')).toHaveText(['写方案']);
  await openInbox(page);
  for (const title of ['写方案', '开周会', '订会议室', '买菜']) {
    await expect(openTasks(page).getByRole('button', { name: title, exact: true })).toBeVisible();
  }
  await expect(row(page, '开周会').getByRole('list', { name: '标签' })).toHaveCount(0);
  await expect(row(page, '写方案').getByRole('list', { name: '标签' })).toHaveText('工作');
});
