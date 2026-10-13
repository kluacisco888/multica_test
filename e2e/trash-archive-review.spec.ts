import { expect, test, type Page } from '@playwright/test';
import { createUser, isMobile, logIn, openSidebar } from './support.js';

/*
 * EURO-15 review: the PR's manual steps 3 and 5 with a 子任务 and keyboard-only
 * operation of the 回收站 row menu and the 归档 banner, at 1440px and 390px.
 */

const listTitle = (page: Page) => page.getByRole('heading', { level: 1 });
const openTasks = (page: Page) => page.getByRole('list', { name: '任务', exact: true });
const detail = (page: Page) => page.getByRole('complementary', { name: '任务详情' });
const trashRows = (page: Page) => page.getByRole('list', { name: '回收站里的任务' });

async function inboxId(page: Page): Promise<string> {
  const res = await page.request.get('/api/lists');
  return (await res.json()).lists.find((l: { isInbox: boolean }) => l.isInbox).id;
}

test('删除 a task with a 子任务, 还原 it from the 回收站 by keyboard: both come back', async ({ page }) => {
  const user = createUser('rv-trash');
  await logIn(page, user.username, user.password);
  const parent = await (await page.request.post('/api/tasks', { data: { title: '带子任务的父任务' } })).json();
  await page.request.post('/api/tasks', { data: { title: '跟着回来的子任务', parentId: parent.id } });
  await page.reload();

  await page.getByRole('button', { name: '带子任务的父任务', exact: true }).click();
  await expect(detail(page).getByRole('textbox', { name: '任务标题' })).toHaveValue('带子任务的父任务');
  await detail(page).getByRole('button', { name: '任务更多操作' }).click();
  await page.getByRole('menuitem', { name: '删除' }).click();
  await expect(openTasks(page).getByRole('button', { name: '带子任务的父任务', exact: true })).toBeHidden();

  const sidebar = await openSidebar(page);
  await sidebar.getByRole('link', { name: '回收站' }).click();
  await expect(listTitle(page)).toHaveText('回收站');
  // Only the deleted task is listed, not its 子任务.
  await expect(trashRows(page).getByRole('listitem')).toHaveText([/带子任务的父任务/]);

  // Keyboard only: focus the row menu, open it with Enter, pick 还原.
  const menu = trashRows(page).getByRole('button', { name: '回收站操作：带子任务的父任务' });
  await menu.focus();
  await expect(menu).toBeVisible();
  await page.keyboard.press('Enter');
  const restore = page.getByRole('menuitem', { name: '还原' });
  await expect(restore).toBeVisible();
  await restore.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('回收站是空的')).toBeVisible();

  const res = await page.request.get(`/api/tasks?listId=${await inboxId(page)}`);
  const titles = (await res.json()).tasks.map((t: { title: string; parentId: string | null }) => [t.title, t.parentId]);
  expect(titles).toEqual(expect.arrayContaining([['带子任务的父任务', null], ['跟着回来的子任务', parent.id]]));
});

test('取消归档 from the banner by keyboard', async ({ page }) => {
  const user = createUser('rv-archive');
  await logIn(page, user.username, user.password);
  const list = await (await page.request.post('/api/lists', { data: { name: '键盘归档' } })).json();
  await page.request.patch(`/api/lists/${list.id}`, { data: { archived: true } });
  await page.reload();

  const sidebar = await openSidebar(page);
  await expect(sidebar.getByRole('list', { name: '清单', exact: true }).getByRole('link', { name: '键盘归档' })).toBeHidden();
  await sidebar.getByRole('button', { name: /已归档的清单/ }).click();
  await sidebar.getByRole('list', { name: '已归档的清单' }).getByRole('link', { name: '键盘归档' }).click();
  await expect(listTitle(page)).toHaveText('键盘归档');
  if (isMobile(page) && (await sidebar.isVisible())) await sidebar.getByRole('button', { name: '关闭侧栏' }).click();

  const unarchive = page.getByRole('button', { name: '取消归档' });
  await unarchive.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('清单已归档，其中的任务不会出现在智能清单里')).toBeHidden();
  const after = await (await page.request.get('/api/lists')).json();
  expect(after.lists.find((l: { id: string }) => l.id === list.id).archivedAt).toBeNull();
});
