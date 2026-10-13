import { expect, test, type Locator, type Page } from '@playwright/test';
import { createUser, isMobile, logIn, openSidebar } from './support.js';

/*
 * Application shell, 清单, 文件夹 and basic 任务 (EURO-6, spec 用户故事 12–15、20、21、27、31、40、65).
 * Runs at 1440px and 390px (playwright.config.ts projects).
 */

const listTitle = (page: Page) => page.getByRole('heading', { level: 1 });
const quickAdd = (page: Page) => page.getByRole('textbox', { name: '添加任务' });
const openTasks = (page: Page) => page.getByRole('list', { name: '任务', exact: true });
const completedTasks = (page: Page) => page.getByRole('list', { name: '已完成的任务' });
const detail = (page: Page) => page.getByRole('complementary', { name: '任务详情' });

async function addTasks(page: Page, ...titles: string[]) {
  for (const title of titles) {
    await quickAdd(page).fill(title);
    await quickAdd(page).press('Enter');
    await expect(openTasks(page).getByRole('button', { name: title, exact: true })).toBeVisible();
    await expect(quickAdd(page)).toHaveValue('');
  }
}

async function openTask(page: Page, title: string) {
  await page.getByRole('button', { name: title, exact: true }).click();
  await expect(detail(page).getByRole('textbox', { name: '任务标题' })).toHaveValue(title);
}

/** Leave the detail page on mobile (desktop keeps both visible). */
async function backToList(page: Page) {
  if (isMobile(page)) await page.getByRole('button', { name: '返回列表' }).click();
}

async function sidebarNames(sidebar: Locator): Promise<string[]> {
  const tree = sidebar.getByRole('list', { name: '清单', exact: true });
  return tree.locator('.sidebar-item-name').allInnerTexts();
}

async function createList(page: Page, name: string, options: { color?: string; icon?: string; folder?: string } = {}) {
  const sidebar = await openSidebar(page);
  await sidebar.getByRole('button', { name: '添加清单' }).click();
  const dialog = page.getByRole('dialog', { name: '添加清单' });
  await dialog.getByLabel('名称').fill(name);
  if (options.color) await dialog.getByRole('radio', { name: options.color, exact: true }).check();
  if (options.icon) await dialog.getByRole('radio', { name: `图标 ${options.icon}` }).check();
  if (options.folder) await dialog.getByLabel('文件夹').selectOption({ label: options.folder });
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog).toBeHidden();
  await expect(listTitle(page)).toHaveText(name);
}

async function createFolder(page: Page, name: string) {
  const sidebar = await openSidebar(page);
  await sidebar.getByRole('button', { name: '添加文件夹' }).click();
  const dialog = page.getByRole('dialog', { name: '添加文件夹' });
  await dialog.getByLabel('文件夹名称').fill(name);
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog).toBeHidden();
}

test('收件箱: quick add with Enter, edit title and Markdown description, complete and un-complete', async ({ page }, testInfo) => {
  const user = createUser('tasks');
  await logIn(page, user.username, user.password);
  await expect(quickAdd(page)).toHaveAttribute('placeholder', /添加任务至"收件箱"/);

  await addTasks(page, '买牛奶', '写周报', '取快递');
  // Newest on top.
  // Title buttons only: the checkboxes have role=checkbox.
  await expect(openTasks(page).getByRole('button')).toHaveText(['取快递', '写周报', '买牛奶']);

  // Edit the title and write a Markdown description.
  await openTask(page, '写周报');
  const title = detail(page).getByRole('textbox', { name: '任务标题' });
  await title.fill('写本周周报');
  await title.press('Enter');
  const description = detail(page).getByRole('textbox', { name: '描述' });
  await description.fill('## 本周进展\n\n- 完成 **EURO-6**\n- 参考 [文档](https://example.com/doc)');
  await description.blur();
  const rendered = detail(page).getByRole('region', { name: '描述' });
  await expect(rendered.getByRole('heading', { level: 2, name: '本周进展' })).toBeVisible();
  await expect(rendered.locator('strong')).toHaveText('EURO-6');
  await expect(rendered.getByRole('link', { name: '文档' })).toHaveAttribute('href', 'https://example.com/doc');
  await expect(rendered.getByRole('link', { name: '文档' })).toHaveAttribute('rel', 'noopener noreferrer');

  // Raw HTML is shown as text, never executed.
  await rendered.getByText('本周进展').click();
  await detail(page).getByRole('textbox', { name: '描述' }).fill('<img src=x onerror="window.__xss=1"> plain');
  await detail(page).getByRole('textbox', { name: '描述' }).blur();
  await expect(detail(page).getByRole('region', { name: '描述' })).toContainText('<img src=x');
  expect(await page.evaluate(() => (globalThis as unknown as { __xss?: number }).__xss)).toBeUndefined();
  await detail(page).getByRole('button', { name: '编辑描述' }).click();
  await detail(page).getByRole('textbox', { name: '描述' }).fill('## 本周进展\n\n- 完成 **EURO-6**');
  await detail(page).getByRole('textbox', { name: '描述' }).blur();
  await expect(detail(page).getByRole('region', { name: '描述' }).locator('strong')).toHaveText('EURO-6');
  await backToList(page);
  await expect(openTasks(page).getByRole('button', { name: '写本周周报', exact: true })).toBeVisible();

  // Complete one: it moves to the 已完成 section at the bottom.
  await openTasks(page).getByRole('checkbox', { name: '买牛奶' }).click();
  await expect(completedTasks(page).getByRole('checkbox', { name: '买牛奶' })).toBeChecked();
  await expect(openTasks(page).getByRole('checkbox', { name: '买牛奶' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /已完成\s*1/ })).toHaveAttribute('aria-expanded', 'true');

  // State survives a reload (it is on the server).
  await page.reload();
  await expect(completedTasks(page).getByRole('checkbox', { name: '买牛奶' })).toBeChecked();
  await expect(openTasks(page).getByRole('button', { name: '写本周周报', exact: true })).toBeVisible();
  await openTask(page, '写本周周报');
  await expect(detail(page).getByRole('region', { name: '描述' }).locator('strong')).toHaveText('EURO-6');
  await page.screenshot({ path: testInfo.outputPath(`task-detail-${testInfo.project.name}.png`) });
  await backToList(page);

  // Un-complete it again from the 已完成 section.
  await completedTasks(page).getByRole('checkbox', { name: '买牛奶' }).click();
  await expect(openTasks(page).getByRole('checkbox', { name: '买牛奶' })).not.toBeChecked();
  await expect(page.getByRole('button', { name: /已完成/ })).toHaveCount(0);

  // Collapse / expand the 已完成 section.
  await openTasks(page).getByRole('checkbox', { name: '取快递' }).click();
  const toggle = page.getByRole('button', { name: /已完成\s*1/ });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(completedTasks(page)).toHaveCount(0);
  await toggle.click();
  await expect(completedTasks(page).getByRole('checkbox', { name: '取快递' })).toBeChecked();
});

test('清单 with colour and icon, move a task to it, rename and delete; 收件箱 cannot be deleted', async ({ page }) => {
  const user = createUser('lists');
  await logIn(page, user.username, user.password);
  await addTasks(page, '订机票');

  await createList(page, '旅行', { color: '蓝色', icon: '✈️' });
  const sidebar = await openSidebar(page);
  const travel = sidebar.getByRole('link', { name: /旅行/ });
  await expect(travel).toContainText('✈️');
  await expect(travel.locator('.sidebar-color-dot')).toHaveCSS('background-color', 'rgb(76, 161, 255)');

  // The 收件箱 has no menu at all: it cannot be renamed or deleted.
  await expect(sidebar.getByRole('button', { name: '清单操作：收件箱' })).toHaveCount(0);

  // Move 订机票 from the 收件箱 to 旅行 via the detail pane.
  await sidebar.getByRole('link', { name: /收件箱/ }).click();
  await expect(listTitle(page)).toHaveText('收件箱');
  await openTask(page, '订机票');
  await detail(page).getByRole('button', { name: '所属清单：收件箱' }).click();
  await page.getByRole('menuitemradio', { name: '旅行' }).click();
  await expect(openTasks(page)).toHaveCount(0);
  const nav = await openSidebar(page);
  await nav.getByRole('link', { name: /旅行/ }).click();
  await expect(listTitle(page)).toHaveText('旅行');
  await expect(openTasks(page).getByRole('button', { name: '订机票', exact: true })).toBeVisible();

  // Rename and recolour through the 清单 menu.
  const menuNav = await openSidebar(page);
  await menuNav.getByRole('button', { name: '清单操作：旅行' }).click();
  await page.getByRole('menuitem', { name: '编辑' }).click();
  const dialog = page.getByRole('dialog', { name: '编辑清单' });
  await dialog.getByLabel('名称').fill('出行');
  await dialog.getByRole('radio', { name: '无颜色' }).check();
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(listTitle(page)).toHaveText('出行');
  await page.reload();
  await expect(listTitle(page)).toHaveText('出行');
  const after = await openSidebar(page);
  await expect(after.getByRole('link', { name: /出行/ }).locator('.sidebar-color-dot')).toHaveCount(0);

  // Delete it: back to the 收件箱, and the task is gone with it.
  await after.getByRole('button', { name: '清单操作：出行' }).click();
  await page.getByRole('menuitem', { name: '删除' }).click();
  await page.getByRole('dialog', { name: '删除清单' }).getByRole('button', { name: '删除' }).click();
  await expect(listTitle(page)).toHaveText('收件箱');
  const final = await openSidebar(page);
  await expect(final.getByRole('link', { name: /出行/ })).toHaveCount(0);
});

test('文件夹 collapse and sidebar order persist after reload', async ({ page }) => {
  const user = createUser('order');
  await logIn(page, user.username, user.password);
  await createFolder(page, '工作');
  await createList(page, '周会', { folder: '工作' });
  await createList(page, '项目', { folder: '工作' });
  await createList(page, '读书', { icon: '📚', color: '绿色' });
  await createList(page, '健身', { icon: '💪' });
  let sidebar = await openSidebar(page);
  expect(await sidebarNames(sidebar)).toEqual(['工作', '周会', '项目', '读书', '健身']);

  // Collapse the folder; it stays collapsed after reload.
  const folder = sidebar.getByRole('button', { name: '工作', exact: true });
  await folder.click();
  await expect(folder).toHaveAttribute('aria-expanded', 'false');
  expect(await sidebarNames(sidebar)).toEqual(['工作', '读书', '健身']);
  await page.reload();
  sidebar = await openSidebar(page);
  await expect(sidebar.getByRole('button', { name: '工作', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await sidebar.getByRole('button', { name: '工作', exact: true }).click();
  await expect(sidebar.getByRole('link', { name: /周会/ })).toBeVisible();

  if (isMobile(page)) {
    // Touch: reorder with the menu instead of dragging.
    await sidebar.getByRole('button', { name: '清单操作：健身' }).click();
    await page.getByRole('menuitem', { name: '上移' }).click();
    await expect.poll(() => sidebarNames(sidebar)).toEqual(['工作', '周会', '项目', '健身', '读书']);
    await sidebar.getByRole('button', { name: '文件夹操作：工作' }).click();
    await page.getByRole('menuitem', { name: '下移' }).click();
    await expect.poll(() => sidebarNames(sidebar)).toEqual(['健身', '工作', '周会', '项目', '读书']);
  } else {
    // Drag 健身 above 读书, then 读书 into the folder, then the folder to the bottom.
    await sidebar.getByRole('link', { name: /健身/ }).dragTo(sidebar.getByRole('link', { name: /读书/ }), {
      targetPosition: { x: 40, y: 4 },
    });
    await expect.poll(() => sidebarNames(sidebar)).toEqual(['工作', '周会', '项目', '健身', '读书']);
    await sidebar.getByRole('link', { name: /读书/ }).dragTo(sidebar.getByRole('button', { name: '工作', exact: true }), {
      targetPosition: { x: 60, y: 17 },
    });
    await expect.poll(() => sidebarNames(sidebar)).toEqual(['工作', '周会', '项目', '读书', '健身']);
    await sidebar.getByRole('button', { name: '工作', exact: true }).dragTo(sidebar.getByRole('link', { name: /健身/ }), {
      targetPosition: { x: 40, y: 30 },
    });
    await expect.poll(() => sidebarNames(sidebar)).toEqual(['健身', '工作', '周会', '项目', '读书']);
  }

  await page.reload();
  sidebar = await openSidebar(page);
  await expect.poll(() => sidebarNames(sidebar)).toEqual(['健身', '工作', '周会', '项目', '读书']);

  // Deleting the folder keeps its 清单.
  await sidebar.getByRole('button', { name: '文件夹操作：工作' }).click();
  await page.getByRole('menuitem', { name: '删除' }).click();
  await page.getByRole('dialog', { name: '删除文件夹' }).getByRole('button', { name: '删除' }).click();
  await expect.poll(() => sidebarNames(sidebar)).toEqual(['健身', '周会', '项目', '读书']);
});

test('screenshots of the main screen for comparison with the reference', async ({ page }, testInfo) => {
  const user = createUser('shots');
  await logIn(page, user.username, user.password);
  await createFolder(page, '工作');
  await createList(page, '周会', { folder: '工作', icon: '💼' });
  await createList(page, '读书', { color: '绿色' });
  await createList(page, '健身', { color: '橙色' });
  const sidebar = await openSidebar(page);
  await sidebar.getByRole('link', { name: /收件箱/ }).click();
  await expect(listTitle(page)).toHaveText('收件箱');
  await addTasks(page, '交水电费', '准备周会材料', '给小王回电话', '整理照片', '预约体检');
  await openTasks(page).getByRole('checkbox', { name: '交水电费' }).click();
  await expect(completedTasks(page).getByRole('checkbox', { name: '交水电费' })).toBeChecked();
  if (!isMobile(page)) {
    await openTask(page, '准备周会材料');
    await detail(page).getByRole('textbox', { name: '描述' }).fill('## 议程\n\n1. 上周回顾\n2. **本周计划**\n\n> 周三前发给大家');
    await detail(page).getByRole('textbox', { name: '描述' }).blur();
    await expect(detail(page).getByRole('region', { name: '描述' }).locator('strong')).toHaveText('本周计划');
  }
  await page.mouse.move(0, 0);
  await page.screenshot({ path: testInfo.outputPath(`main-${testInfo.project.name}.png`) });
  if (isMobile(page)) {
    await openSidebar(page);
    await page.screenshot({ path: testInfo.outputPath(`drawer-${testInfo.project.name}.png`) });
  }
  await page.context().clearCookies();
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: '登录' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`login-${testInfo.project.name}.png`) });
});
