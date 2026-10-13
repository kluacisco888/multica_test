import { expect, test, type Page } from '@playwright/test';
import { createUser, isMobile, logIn, openSidebar } from './support.js';

/*
 * 放弃、回收站与清单归档 (EURO-15, spec 用户故事 16、28–30).
 * Runs at 1440px and 390px (playwright.config.ts projects).
 */

const listTitle = (page: Page) => page.getByRole('heading', { level: 1 });
const quickAdd = (page: Page) => page.getByRole('textbox', { name: '添加任务' });
const openTasks = (page: Page) => page.getByRole('list', { name: '任务', exact: true });
const closedTasks = (page: Page) => page.getByRole('list', { name: '已完成的任务' });
const detail = (page: Page) => page.getByRole('complementary', { name: '任务详情' });
const trashRows = (page: Page) => page.getByRole('list', { name: '回收站里的任务' });
const row = (page: Page, title: string) =>
  openTasks(page).getByRole('listitem').filter({ has: page.getByRole('button', { name: title, exact: true }) });

async function addTasks(page: Page, ...titles: string[]) {
  for (const title of titles) {
    await quickAdd(page).fill(title);
    await quickAdd(page).press('Enter');
    await expect(openTasks(page).getByRole('button', { name: title, exact: true })).toBeVisible();
  }
}

async function openTask(page: Page, title: string) {
  await page.getByRole('button', { name: title, exact: true }).click();
  await expect(detail(page).getByRole('textbox', { name: '任务标题' })).toHaveValue(title);
}

async function backToList(page: Page) {
  if (isMobile(page)) await page.getByRole('button', { name: '返回列表' }).click();
}

async function openTrash(page: Page) {
  const sidebar = await openSidebar(page);
  await sidebar.getByRole('link', { name: '回收站' }).click();
  await expect(listTitle(page)).toHaveText('回收站');
}

async function openInbox(page: Page) {
  const sidebar = await openSidebar(page);
  await sidebar.getByRole('link', { name: /收件箱/ }).click();
  await expect(listTitle(page)).toHaveText('收件箱');
}

async function createList(page: Page, name: string) {
  const sidebar = await openSidebar(page);
  await sidebar.getByRole('button', { name: '添加清单' }).click();
  const dialog = page.getByRole('dialog', { name: '添加清单' });
  await dialog.getByLabel('名称').fill(name);
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog).toBeHidden();
  await expect(listTitle(page)).toHaveText(name);
}

test('放弃 from the right-click menu and the detail: kept under 已完成 with its own mark, not counted, re-openable', async ({ page }, testInfo) => {
  const user = createUser('abandon');
  await logIn(page, user.username, user.password);
  await addTasks(page, '还要做', '不做了');

  await row(page, '不做了').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '放弃' }).click();
  const box = closedTasks(page).getByRole('checkbox', { name: '不做了' });
  await expect(box).toHaveAttribute('aria-checked', 'mixed');
  await expect(box).toHaveAccessibleDescription('已放弃');
  const sidebar = await openSidebar(page);
  await expect(sidebar.getByRole('link', { name: /收件箱/ })).toContainText('1');
  if (isMobile(page)) await sidebar.getByRole('button', { name: '关闭侧栏' }).click();

  // The detail shows the state and offers 取消放弃.
  await openTask(page, '不做了');
  await expect(detail(page).getByText('已放弃')).toBeVisible();
  await detail(page).getByRole('button', { name: '任务更多操作' }).click();
  await page.getByRole('menuitem', { name: '取消放弃' }).click();
  await backToList(page);
  await expect(openTasks(page).getByRole('checkbox', { name: '不做了' })).toHaveAttribute('aria-checked', 'false');

  // 放弃 from the detail; clicking the mark re-opens it.
  await openTask(page, '还要做');
  await detail(page).getByRole('button', { name: '任务更多操作' }).click();
  await page.getByRole('menuitem', { name: '放弃' }).click();
  await backToList(page);
  await closedTasks(page).getByRole('checkbox', { name: '还要做' }).click();
  await expect(openTasks(page).getByRole('button', { name: '还要做', exact: true })).toBeVisible();

  // Survives a reload.
  await row(page, '不做了').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '放弃' }).click();
  await page.reload();
  await expect(closedTasks(page).getByRole('checkbox', { name: '不做了' })).toHaveAttribute('aria-checked', 'mixed');
  await openTasks(page).getByRole('checkbox', { name: '还要做' }).click();
  await expect(closedTasks(page).getByRole('checkbox', { name: '还要做' })).toBeChecked();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: testInfo.outputPath(`abandoned-${testInfo.project.name}.png`) });
});

test('删除 into the 回收站, then 还原, 彻底删除 and 清空回收站', async ({ page }, testInfo) => {
  const user = createUser('trash');
  await logIn(page, user.username, user.password);
  await addTasks(page, '整理照片', '交水电费', '预约体检', '给小王回电话');

  // From the detail and from the right-click menu.
  await openTask(page, '交水电费');
  await detail(page).getByRole('button', { name: '任务更多操作' }).click();
  await page.getByRole('menuitem', { name: '删除' }).click();
  if (isMobile(page)) await expect(detail(page)).toBeHidden();
  await expect(openTasks(page).getByRole('button', { name: '交水电费', exact: true })).toBeHidden();
  for (const title of ['预约体检', '整理照片']) {
    await row(page, title).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '删除' }).click();
    await expect(openTasks(page).getByRole('button', { name: title, exact: true })).toBeHidden();
  }

  await openTrash(page);
  await expect(quickAdd(page)).toBeHidden();
  await expect(trashRows(page).getByRole('listitem')).toHaveText([/整理照片/, /预约体检/, /交水电费/]);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: testInfo.outputPath(`trash-${testInfo.project.name}.png`) });

  // 还原
  await trashRows(page).getByRole('button', { name: '回收站操作：交水电费' }).click();
  await page.getByRole('menuitem', { name: '还原' }).click();
  await expect(trashRows(page).getByRole('listitem')).toHaveCount(2);

  // 彻底删除 asks first.
  await trashRows(page).getByRole('button', { name: '回收站操作：预约体检' }).click();
  await page.getByRole('menuitem', { name: '彻底删除' }).click();
  const confirm = page.getByRole('dialog', { name: '彻底删除' });
  await expect(confirm).toContainText('预约体检');
  await confirm.getByRole('button', { name: '彻底删除' }).click();
  await expect(trashRows(page).getByRole('listitem')).toHaveText([/整理照片/]);

  // 清空回收站
  await page.getByRole('button', { name: '清空回收站' }).click();
  await page.getByRole('dialog', { name: '清空回收站' }).getByRole('button', { name: '清空' }).click();
  await expect(page.getByText('回收站是空的')).toBeVisible();
  await expect(page.getByRole('button', { name: '清空回收站' })).toBeDisabled();

  await openInbox(page);
  await expect(openTasks(page).getByRole('button', { name: '交水电费', exact: true })).toBeVisible();
  await expect(openTasks(page).getByRole('button', { name: '预约体检', exact: true })).toBeHidden();
  await page.reload();
  await expect(openTasks(page).getByRole('button', { name: '交水电费', exact: true })).toBeVisible();
});

test('归档 a 清单: it leaves the sidebar tree for 已归档的清单, stays readable, and comes back', async ({ page }, testInfo) => {
  const user = createUser('archive');
  await logIn(page, user.username, user.password);
  await createList(page, '旧项目');
  await addTasks(page, '收尾文档');
  await createList(page, '读书');

  let sidebar = await openSidebar(page);
  const tree = sidebar.getByRole('list', { name: '清单', exact: true });
  await sidebar.getByRole('button', { name: '清单操作：旧项目' }).click();
  await page.getByRole('menuitem', { name: '归档' }).click();
  await expect(tree.getByRole('link', { name: '旧项目' })).toBeHidden();

  const archived = sidebar.getByRole('button', { name: /已归档的清单/ });
  await expect(archived).toHaveAttribute('aria-expanded', 'false');
  await archived.click();
  const archivedList = sidebar.getByRole('list', { name: '已归档的清单' });
  await expect(archivedList.getByRole('link', { name: '旧项目' })).toBeVisible();

  // Still readable, and marked as archived.
  await archivedList.getByRole('link', { name: '旧项目' }).click();
  await expect(listTitle(page)).toHaveText('旧项目');
  await expect(page.getByText('清单已归档')).toBeVisible();
  await expect(openTasks(page).getByRole('button', { name: '收尾文档', exact: true })).toBeVisible();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: testInfo.outputPath(`archive-${testInfo.project.name}.png`) });

  // 取消归档 from the banner.
  await page.reload();
  await page.getByRole('button', { name: '取消归档' }).click();
  await expect(page.getByText('清单已归档')).toBeHidden();
  sidebar = await openSidebar(page);
  await expect(sidebar.getByRole('list', { name: '清单', exact: true }).getByRole('link', { name: '旧项目' })).toBeVisible();
  await expect(sidebar.getByRole('button', { name: /已归档的清单/ })).toBeHidden();
});
