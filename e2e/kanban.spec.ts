import { expect, test, type Locator, type Page } from '@playwright/test';
import { createUser, isMobile, logIn, openSidebar } from './support.js';

/*
 * 看板视图 (EURO-18, spec 用户故事 66、67). Runs at 1440px and 390px
 * (playwright.config.ts projects): a 清单 board with 分栏 added, renamed,
 * reordered and deleted, cards moved between 分栏 (dragging on desktop, the
 * card menu's 移动到分组 on mobile) and still there after a reload; a 智能清单
 * board with automatic columns.
 */

const listTitle = (page: Page) => page.getByRole('heading', { level: 1 });
const board = (page: Page) => page.getByRole('region', { name: '看板' });
const column = (page: Page, name: string) => board(page).getByRole('region', { name, exact: true });
const card = (scope: Locator, title: string) => scope.locator('li.kanban-card').filter({ has: scope.page().getByRole('button', { name: title, exact: true }) });
const columnNames = (page: Page) => board(page).locator('.kanban-column-name').allTextContents();

function shanghaiDate(days: number): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const t = new Date(`${today}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}
const dueOn = (days: number) => ({ allDay: true, startDate: null, dueDate: shanghaiDate(days) });

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

/** The 视图 switcher (shared with the 时间线): 列表 / 看板 / 时间线. */
async function switchView(page: Page, layout: '看板' | '列表') {
  await page.getByRole('button', { name: '排序和分组' }).click();
  await page.getByRole('menuitemradio', { name: layout, exact: true }).click();
}

async function columnMenu(page: Page, name: string, item: string) {
  await page.getByRole('button', { name: `分组「${name}」更多操作` }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

/** Move a card to another column: drag on desktop, the card menu (Shift+F10 → 移动到分组) on mobile. */
async function moveCard(page: Page, title: string, from: string, to: string) {
  if (isMobile(page)) {
    const titleButton = column(page, from).getByRole('button', { name: title, exact: true });
    // Bring the column into view first and let its scroll event pass: the menu closes when its anchor scrolls.
    await titleButton.scrollIntoViewIfNeeded();
    await page.evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await titleButton.focus();
    await page.keyboard.press('Shift+F10');
    await page.getByRole('group', { name: '移动到分组' }).getByRole('menuitemradio', { name: to }).click();
  } else {
    await card(column(page, from), title).dragTo(column(page, to));
  }
}

test('清单看板: add, rename, reorder and delete 分栏; a moved card stays in its 分栏 after a reload', async ({ page }, testInfo) => {
  const { username, password } = createUser('kanban');
  await logIn(page, username, password);
  const list = await post(page, '/api/lists', { name: '产品发布' });
  for (const [title, days] of [
    ['整理需求文档', 2],
    ['写周报', 0],
    ['和设计评审原型', 1],
    ['准备发布说明', null],
  ] as const) {
    await post(page, '/api/tasks', { listId: list.id, title, ...(days === null ? {} : { dates: dueOn(days) }) });
  }
  await page.reload();
  await openList(page, '产品发布');
  if (isMobile(page)) await expect(page.getByRole('navigation', { name: '侧栏' })).toBeHidden();

  await switchView(page, '看板');
  await expect(column(page, '未分组')).toBeVisible();
  await expect(column(page, '未分组').getByRole('heading', { level: 2 })).toHaveText('未分组4');
  // No quick add bar on a board, like the reference; each column has its own +.
  await expect(page.getByRole('textbox', { name: '添加任务', exact: true })).toHaveCount(0);

  // + 新分组 → name, Enter.
  await board(page).getByRole('button', { name: '新分组' }).click();
  await page.getByRole('textbox', { name: '新分组名称' }).fill('进行中');
  await page.getByRole('textbox', { name: '新分组名称' }).press('Enter');
  await expect(column(page, '进行中')).toBeVisible();
  // A duplicate name is refused with the reference's message.
  await columnMenu(page, '进行中', '在右侧添加分组');
  await page.getByRole('textbox', { name: '新分组名称' }).fill('进行中');
  await page.getByRole('textbox', { name: '新分组名称' }).press('Enter');
  await expect(page.getByRole('alert')).toContainText('分组名称已存在');
  await page.getByRole('button', { name: '知道了' }).click();
  await page.getByRole('textbox', { name: '新分组名称' }).fill('待验收');
  await page.getByRole('textbox', { name: '新分组名称' }).press('Enter');
  await columnMenu(page, '进行中', '在左侧添加分组');
  await page.getByRole('textbox', { name: '新分组名称' }).fill('本周');
  await page.getByRole('textbox', { name: '新分组名称' }).press('Enter');
  await expect.poll(() => columnNames(page)).toEqual(['未分组', '本周', '进行中', '待验收']);

  // Rename and reorder.
  await columnMenu(page, '进行中', '重命名');
  await page.getByRole('textbox', { name: '分组名称' }).fill('处理中');
  await page.getByRole('textbox', { name: '分组名称' }).press('Enter');
  await columnMenu(page, '本周', '向右移动');
  await expect.poll(() => columnNames(page)).toEqual(['未分组', '处理中', '本周', '待验收']);

  // Move cards across 分栏.
  await moveCard(page, '写周报', '未分组', '处理中');
  await expect(column(page, '处理中').getByRole('button', { name: '写周报', exact: true })).toBeVisible();
  await moveCard(page, '和设计评审原型', '未分组', '本周');
  await expect(column(page, '本周').getByRole('button', { name: '和设计评审原型', exact: true })).toBeVisible();

  // Add a card straight into a 分栏.
  await page.getByRole('button', { name: '在「待验收」中添加任务' }).click();
  await page.getByRole('textbox', { name: '添加任务到「待验收」' }).fill('验收埋点');
  await page.getByRole('textbox', { name: '添加任务到「待验收」' }).press('Enter');
  await expect(column(page, '待验收').getByRole('button', { name: '验收埋点', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '添加任务到「待验收」' }).press('Escape');

  // 刷新: the board, the 分栏 order and every card's 分栏 are remembered.
  await page.reload();
  await expect(column(page, '处理中').getByRole('button', { name: '写周报', exact: true })).toBeVisible();
  await expect(column(page, '本周').getByRole('button', { name: '和设计评审原型', exact: true })).toBeVisible();
  await expect(column(page, '待验收').getByRole('button', { name: '验收埋点', exact: true })).toBeVisible();
  await expect.poll(() => columnNames(page)).toEqual(['未分组', '处理中', '本周', '待验收']);
  await page.screenshot({ path: testInfo.outputPath(`kanban-${testInfo.project.name}.png`) });

  // 删除分组, moving its tasks to another 分栏.
  await columnMenu(page, '处理中', '删除分组');
  const dialog = page.getByRole('dialog', { name: '删除分组' });
  await expect(dialog.getByRole('radio', { name: '删除分组和任务' })).toBeChecked();
  await dialog.getByRole('radio', { name: '删除分组，将任务移动到...' }).check();
  await dialog.getByLabel('移动到', { exact: true }).selectOption({ label: '待验收' });
  await dialog.getByRole('button', { name: '删除' }).click();
  await expect(dialog).toBeHidden();
  await expect(column(page, '处理中')).toHaveCount(0);
  await expect(column(page, '待验收').getByRole('button', { name: '写周报', exact: true })).toBeVisible();

  // 删除分组 with its tasks (the default): they go to the 回收站.
  await columnMenu(page, '待验收', '删除分组');
  await page.getByRole('dialog', { name: '删除分组' }).getByRole('button', { name: '删除' }).click();
  await expect(column(page, '待验收')).toHaveCount(0);
  await expect(board(page).getByRole('button', { name: '写周报', exact: true })).toHaveCount(0);
  const trash = (await (await page.request.get('/api/trash')).json()) as { tasks: { title: string }[] };
  expect(trash.tasks.map((t) => t.title).sort()).toEqual(['写周报', '验收埋点'].sort());

  // Back to 列表视图: the same tasks, as rows.
  await switchView(page, '列表');
  await expect(board(page)).toHaveCount(0);
  await expect(page.getByRole('main').getByRole('button', { name: '和设计评审原型', exact: true })).toBeVisible();
});

test('智能清单看板: automatic columns by date or 优先级, nothing to add or delete by hand', async ({ page }) => {
  const { username, password } = createUser('kanban-smart');
  await logIn(page, username, password);
  await post(page, '/api/tasks', { title: '交房租', dates: dueOn(-2), priority: 'high' });
  await post(page, '/api/tasks', { title: '写周报', dates: dueOn(0), priority: 'low' });
  await post(page, '/api/tasks', { title: '看牙医', dates: dueOn(3) });
  await page.reload();
  const sidebar = await openSidebar(page);
  await sidebar.getByRole('list', { name: '智能清单' }).getByRole('link', { name: /^最近7天/ }).click();
  await expect(listTitle(page)).toHaveText('最近7天');

  await switchView(page, '看板');
  await expect(column(page, '已过期').getByRole('button', { name: '交房租', exact: true })).toBeVisible();
  await expect(board(page).getByRole('region', { name: /^今天 周/ }).getByRole('button', { name: '写周报', exact: true })).toBeVisible();
  await expect(board(page).getByRole('button', { name: '新分组' })).toHaveCount(0);
  await expect(board(page).getByRole('button', { name: /更多操作$/ })).toHaveCount(0);

  await page.getByRole('button', { name: '排序和分组' }).click();
  await page.getByRole('group', { name: '分组' }).getByRole('menuitemradio', { name: '优先级' }).click();
  await expect.poll(() => columnNames(page)).toEqual(['高优先级', '中优先级', '低优先级', '无优先级']);
  await expect(column(page, '高优先级').getByRole('button', { name: '交房租', exact: true })).toBeVisible();
  await expect(column(page, '无优先级').getByRole('button', { name: '看牙医', exact: true })).toBeVisible();

  await page.reload();
  await expect(column(page, '低优先级').getByRole('button', { name: '写周报', exact: true })).toBeVisible();
});
