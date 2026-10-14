import { expect, test, type Locator, type Page } from '@playwright/test';
import { createUser, isMobile, logIn, openSidebar } from './support.js';

/*
 * 拖拽排序、置顶与批量操作 (EURO-22, spec 用户故事 32–34). Runs at 1440px and
 * 390px. Reordering drags a row on desktop and uses Alt + ↑ / ↓ on mobile;
 * 多选 uses Ctrl + click and Shift + click like the reference; every result
 * is checked again after a reload.
 */

const listTitle = (page: Page) => page.getByRole('heading', { level: 1 });
const pane = (page: Page) => page.getByRole('main');
const titleName = (title: string) => new RegExp(`^${title}\\s*(（已选中）)?$`);
const titleButton = (page: Page, title: string) => pane(page).getByRole('button', { name: titleName(title) });
const row = (page: Page, title: string) => pane(page).locator('.task-row').filter({ has: page.getByRole('button', { name: titleName(title) }) });
const openTitles = (page: Page) => pane(page).locator('ul[aria-label="任务"] .task-row-title').allInnerTexts();

async function post(page: Page, url: string, data: object): Promise<{ id: string }> {
  const res = await page.request.post(url, { data });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { id: string };
}

async function openList(page: Page, name: string) {
  const sidebar = await openSidebar(page);
  await sidebar.getByRole('link', { name: new RegExp(`^${name}`) }).click();
  await expect(listTitle(page)).toHaveText(name);
}

/** A 清单 with tasks shown top to bottom as `titles`. */
async function seedList(page: Page, name: string, titles: string[]): Promise<string> {
  const list = await post(page, '/api/lists', { name });
  // New tasks land on top: create bottom-up.
  for (const title of [...titles].reverse()) await post(page, '/api/tasks', { listId: list.id, title });
  await page.reload();
  await openList(page, name);
  return list.id;
}

/** The task menu: right click on desktop, Shift+F10 on the focused title on mobile. */
async function openMenu(page: Page, title: string) {
  if (isMobile(page)) {
    await titleButton(page, title).focus();
    await page.keyboard.press('Shift+F10');
  } else {
    await row(page, title).click({ button: 'right' });
  }
}

test('拖拽排序 and 置顶: the order and the 已置顶 group survive a reload', async ({ page }, testInfo) => {
  const { username, password } = createUser('order');
  await logIn(page, username, password);
  await seedList(page, '排序清单', ['写周报', '整理需求', '回复邮件', '订会议室']);
  await expect.poll(() => openTitles(page)).toEqual(['写周报', '整理需求', '回复邮件', '订会议室']);

  // Move 订会议室 above 整理需求.
  if (isMobile(page)) {
    await titleButton(page, '订会议室').focus();
    await page.keyboard.press('Alt+ArrowUp');
    await page.keyboard.press('Alt+ArrowUp');
  } else {
    await row(page, '订会议室').dragTo(row(page, '整理需求'), { targetPosition: { x: 80, y: 4 } });
  }
  await expect.poll(() => openTitles(page)).toEqual(['写周报', '订会议室', '整理需求', '回复邮件']);
  await page.reload();
  await expect.poll(() => openTitles(page)).toEqual(['写周报', '订会议室', '整理需求', '回复邮件']);

  // 置顶 from the task menu: 已置顶 on top, newest pin first.
  await openMenu(page, '回复邮件');
  await page.getByRole('menuitem', { name: '置顶', exact: true }).click();
  await openMenu(page, '整理需求');
  await page.getByRole('menuitem', { name: '置顶', exact: true }).click();
  const pinned = pane(page).getByRole('region', { name: /^已置顶/ });
  await expect(pinned.locator('.task-row-title')).toHaveText(['整理需求', '回复邮件']);
  await page.reload();
  await expect(pinned.locator('.task-row-title')).toHaveText(['整理需求', '回复邮件']);
  await expect.poll(() => openTitles(page)).toEqual(['写周报', '订会议室']);
  await page.screenshot({ path: testInfo.outputPath(`pinned-${testInfo.project.name}.png`) });

  // Reorder inside 已置顶, then 取消置顶 puts the task back where it was.
  if (isMobile(page)) {
    await titleButton(page, '回复邮件').focus();
    await page.keyboard.press('Alt+ArrowUp');
  } else {
    await row(page, '回复邮件').dragTo(row(page, '整理需求'), { targetPosition: { x: 80, y: 4 } });
  }
  await expect(pinned.locator('.task-row-title')).toHaveText(['回复邮件', '整理需求']);
  await openMenu(page, '整理需求');
  await page.getByRole('menuitem', { name: '取消置顶' }).click();
  await page.reload();
  await expect(pinned.locator('.task-row-title')).toHaveText(['回复邮件']);
  await expect.poll(() => openTitles(page)).toEqual(['写周报', '订会议室', '整理需求']);
});

/** The batch controls: the 已选择 N 项 panel on desktop, the floating toolbar on mobile. */
function batchUi(page: Page): Locator {
  return isMobile(page) ? page.getByRole('toolbar', { name: /^批量操作/ }) : page.getByRole('complementary', { name: /已选择/ });
}

async function batchMenu(page: Page, button: string | RegExp, item: string, role: 'menuitem' | 'menuitemradio' | 'menuitemcheckbox' = 'menuitem') {
  await batchUi(page).getByRole('button', typeof button === 'string' ? { name: button, exact: true } : { name: button }).click();
  await page.getByRole(role, { name: item, exact: true }).click();
}

async function batchAction(page: Page, action: '完成' | '删除' | '置顶') {
  if (isMobile(page) && action !== '删除') await batchMenu(page, '更多批量操作', action);
  else await batchUi(page).getByRole('button', { name: action, exact: true }).click();
}

test('多选 with Ctrl / Shift + click and the six 批量操作', async ({ page }, testInfo) => {
  const { username, password } = createUser('batch');
  await logIn(page, username, password);
  await post(page, '/api/tags', { name: '批量' });
  await post(page, '/api/lists', { name: '归档区' });
  const titles = ['任务一', '任务二', '任务三', '任务四', '任务五', '任务六'];
  await seedList(page, '批量清单', titles);

  // Desktop: click opens 任务一, Ctrl + click adds 任务三. Mobile: a tap would open the task full screen, so start with Ctrl.
  if (isMobile(page)) await titleButton(page, '任务一').click({ modifiers: ['Control'] });
  else await titleButton(page, '任务一').click();
  await titleButton(page, '任务三').click({ modifiers: ['Control'] });
  if (!isMobile(page)) await expect(page.getByRole('heading', { name: '已选择 2 项' })).toBeVisible();
  await expect(batchUi(page)).toBeVisible();
  // Shift + click: everything from the first click to 任务五.
  await titleButton(page, '任务五').click({ modifiers: ['Shift'] });
  await expect(pane(page).locator('.task-row-multi .task-row-title')).toHaveText(['任务一（已选中）', '任务二（已选中）', '任务三（已选中）', '任务四（已选中）', '任务五（已选中）']);
  if (!isMobile(page)) await expect(page.getByRole('heading', { name: '已选择 5 项' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`multi-select-${testInfo.project.name}.png`) });
  // Ctrl + click again removes one.
  await titleButton(page, '任务五').click({ modifiers: ['Control'] });
  await expect(pane(page).locator('.task-row-multi')).toHaveCount(4);

  // 改优先级, 改日期, 打标签: the selection stays.
  await batchMenu(page, '优先级', '高优先级', 'menuitemradio');
  await batchMenu(page, '设置日期', '明天');
  await batchMenu(page, '标签', '批量', 'menuitemcheckbox');
  await page.reload();
  const read = async () => {
    const res = await page.request.get('/api/tasks?smart=tomorrow');
    return ((await res.json()) as { tasks: { title: string; priority: string; tagIds: string[] }[] }).tasks;
  };
  await expect.poll(async () => (await read()).map((t) => `${t.title}:${t.priority}:${t.tagIds.length}`).sort()).toEqual([
    '任务一:high:1',
    '任务三:high:1',
    '任务二:high:1',
    '任务四:high:1',
  ]);

  // 完成: select 任务一 + 任务二 again and complete them.
  await titleButton(page, '任务一').click({ modifiers: ['Control'] });
  await titleButton(page, '任务二').click({ modifiers: ['Control'] });
  if (!isMobile(page)) await expect(page.getByRole('heading', { name: '已选择 2 项' })).toBeVisible();
  await batchAction(page, '完成');
  await expect.poll(() => openTitles(page)).toEqual(['任务三', '任务四', '任务五', '任务六']);

  // 移动: 任务三 + 任务四 to 归档区.
  await titleButton(page, '任务三').click({ modifiers: ['Control'] });
  await titleButton(page, '任务四').click({ modifiers: ['Shift'] });
  await batchMenu(page, /移动到清单/, '归档区', 'menuitemradio');
  await expect.poll(() => openTitles(page)).toEqual(['任务五', '任务六']);

  // 删除: into the 回收站 (restorable).
  await titleButton(page, '任务五').click({ modifiers: ['Control'] });
  await titleButton(page, '任务六').click({ modifiers: ['Control'] });
  await batchAction(page, '删除');
  await expect.poll(() => openTitles(page)).toEqual([]);
  await page.reload();
  await expect(pane(page).getByRole('region', { name: /^已完成/ })).toBeVisible();
  await expect.poll(() => openTitles(page)).toEqual([]);
  const trash = (await (await page.request.get('/api/trash')).json()) as { tasks: { title: string }[] };
  expect(trash.tasks.map((t) => t.title).sort()).toEqual(['任务五', '任务六']);
  await openList(page, '归档区');
  await expect.poll(() => openTitles(page)).toEqual(['任务三', '任务四']);
});
