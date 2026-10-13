import { expect, test, type Page } from '@playwright/test';
import { createUser, isMobile, logIn, openSidebar } from './support.js';

/*
 * EURO-18 review (1440px and 390px): the parts of the manual checklist that
 * e2e/kanban.spec.ts does not walk through — an empty 分栏 is deleted without
 * the dialog, a card trashed with its 分栏 comes back to 未分组 when restored
 * from the 回收站 page, the card context menu (right click / long press) moves
 * cards on mobile, and a 过滤器 board has no manual 分栏.
 */

const listTitle = (page: Page) => page.getByRole('heading', { level: 1 });
const board = (page: Page) => page.getByRole('region', { name: '看板' });
const column = (page: Page, name: string) => board(page).getByRole('region', { name, exact: true });
const columnNames = (page: Page) => board(page).locator('.kanban-column-name').allTextContents();

async function post(page: Page, url: string, data: object): Promise<{ id: string }> {
  const res = await page.request.post(url, { data });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { id: string };
}

async function switchView(page: Page, layout: '看板' | '列表') {
  await page.getByRole('button', { name: '排序和分组' }).click();
  await page.getByRole('menuitemradio', { name: layout, exact: true }).click();
}

async function columnMenu(page: Page, name: string, item: string) {
  await page.getByRole('button', { name: `分组「${name}」更多操作` }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

test('删除分组: empty 分栏 without the dialog; trashed cards restored from the 回收站 land in 未分组', async ({ page }, testInfo) => {
  const { username, password } = createUser('kanban-rv');
  await logIn(page, username, password);
  const list = await post(page, '/api/lists', { name: '审查看板' });
  const todo = await post(page, '/api/kanban-columns', { listId: list.id, name: '待办' });
  await post(page, '/api/kanban-columns', { listId: list.id, name: '空栏' });
  await post(page, '/api/kanban-columns', { listId: list.id, name: '进行中' });
  await post(page, '/api/tasks', { listId: list.id, title: '待办任务', columnId: todo.id });
  await post(page, '/api/tasks', { listId: list.id, title: '未分组任务' });
  await page.reload();
  const sidebar = await openSidebar(page);
  await sidebar.getByRole('link', { name: /^审查看板/ }).click();
  await expect(listTitle(page)).toHaveText('审查看板');
  await switchView(page, '看板');
  await expect.poll(() => columnNames(page)).toEqual(['未分组', '待办', '空栏', '进行中']);

  // Move by the card's context menu (right click on desktop, long-press equivalent on touch).
  const titleButton = column(page, '未分组').getByRole('button', { name: '未分组任务', exact: true });
  await titleButton.scrollIntoViewIfNeeded();
  await titleButton.click({ button: 'right' });
  await page.getByRole('group', { name: '移动到分组' }).getByRole('menuitemradio', { name: '进行中' }).click();
  await expect(column(page, '进行中').getByRole('button', { name: '未分组任务', exact: true })).toBeVisible();
  // 未分组 disappears once empty and the list has 分栏.
  await expect(column(page, '未分组')).toHaveCount(0);

  // Empty 分栏: deleted at once, no dialog.
  await columnMenu(page, '空栏', '删除分组');
  await expect(page.getByRole('dialog', { name: '删除分组' })).toHaveCount(0);
  await expect.poll(() => columnNames(page)).toEqual(['待办', '进行中']);

  // 删除分组 with a task: dialog, default = 删除分组和任务.
  await columnMenu(page, '待办', '删除分组');
  const dialog = page.getByRole('dialog', { name: '删除分组' });
  await expect(dialog.getByRole('radio', { name: '删除分组和任务' })).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath(`delete-dialog-${testInfo.project.name}.png`) });
  await dialog.getByRole('button', { name: '删除' }).click();
  await expect(dialog).toBeHidden();
  await expect(board(page).getByRole('button', { name: '待办任务', exact: true })).toHaveCount(0);

  // 还原 from the 回收站 page.
  await (await openSidebar(page)).getByRole('link', { name: '回收站' }).click();
  await expect(listTitle(page)).toHaveText('回收站');
  await page.getByRole('button', { name: '回收站操作：待办任务' }).click();
  await page.getByRole('menuitem', { name: '还原' }).click();
  await expect(page.getByText('回收站是空的')).toBeVisible();

  await (await openSidebar(page)).getByRole('link', { name: /^审查看板/ }).click();
  await page.reload();
  await expect(column(page, '未分组').getByRole('button', { name: '待办任务', exact: true })).toBeVisible();
  await expect(column(page, '进行中').getByRole('button', { name: '未分组任务', exact: true })).toBeVisible();
  await expect.poll(() => columnNames(page)).toEqual(['未分组', '进行中']);
  await page.screenshot({ path: testInfo.outputPath(`after-restore-${testInfo.project.name}.png`), fullPage: true });
  if (isMobile(page)) {
    const overflow = await page.evaluate<number>('document.documentElement.scrollWidth - document.documentElement.clientWidth');
    expect(overflow, 'page itself must not scroll sideways at 390px (the board scrolls inside)').toBeLessThanOrEqual(0);
  }
});

test('过滤器看板: automatic columns, no manual 分栏', async ({ page }, testInfo) => {
  const { username, password } = createUser('kanban-rv-filter');
  await logIn(page, username, password);
  await post(page, '/api/tasks', { title: '高优先', priority: 'high' });
  await post(page, '/api/tasks', { title: '低优先', priority: 'low' });
  await post(page, '/api/filters', { name: '有优先级', rules: { priorities: ['high', 'low'] } });
  await page.reload();
  const sidebar = await openSidebar(page);
  await sidebar.getByRole('list', { name: '过滤器' }).getByRole('link', { name: /^有优先级/ }).click();
  await expect(listTitle(page)).toHaveText('有优先级');
  await switchView(page, '看板');
  await expect(board(page)).toBeVisible();
  await expect(board(page).getByRole('button', { name: '新分组' })).toHaveCount(0);
  await expect(board(page).getByRole('button', { name: /更多操作$/ })).toHaveCount(0);
  await page.getByRole('button', { name: '排序和分组' }).click();
  await page.getByRole('group', { name: '分组' }).getByRole('menuitemradio', { name: '优先级' }).click();
  await expect.poll(() => columnNames(page)).toEqual(['高优先级', '中优先级', '低优先级', '无优先级']);
  await expect(column(page, '高优先级').getByRole('button', { name: '高优先', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.screenshot({ path: testInfo.outputPath(`filter-board-${testInfo.project.name}.png`) });
});
