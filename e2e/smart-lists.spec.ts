import { expect, test, type Page } from '@playwright/test';
import { createUser, isMobile, logIn, openSidebar } from './support.js';

/*
 * 智能清单, 不进智能清单, 过滤器, 全局搜索, 排序和分组 (EURO-13, spec 用户故事
 * 17、59–64). Runs at 1440px and 390px (playwright.config.ts projects).
 */

const listTitle = (page: Page) => page.getByRole('heading', { level: 1 });
const main = (page: Page) => page.getByRole('main');
const quickAdd = (page: Page) => page.getByRole('textbox', { name: '添加任务' });
const section = (page: Page, title: string | RegExp) => main(page).getByRole('region', { name: title });

/** Calendar date `days` from today in the default time zone (Asia/Shanghai), like the server. */
function shanghaiDate(days: number): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const t = new Date(`${today}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

/** Create data through the API with the page's session (the UI paths are covered by other specs). */
async function post(page: Page, url: string, data: object): Promise<{ id: string }> {
  const res = await page.request.post(url, { data });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { id: string };
}

const dueOn = (days: number) => ({ allDay: true, startDate: null, dueDate: shanghaiDate(days) });

async function openSmart(page: Page, name: string) {
  const sidebar = await openSidebar(page);
  await sidebar.getByRole('list', { name: '智能清单' }).getByRole('link', { name: new RegExp(`^${name}`) }).click();
  await expect(listTitle(page)).toHaveText(name);
}

test('智能清单: 今天 groups 已过期, quick add dates the task, 不进智能清单 keeps a 清单 out, hide and show', async ({ page }, testInfo) => {
  const { username, password } = createUser('smart');
  await logIn(page, username, password);

  // A 清单 with 不进智能清单 switched on, through the 清单 dialog.
  const sidebar = await openSidebar(page);
  await sidebar.getByRole('button', { name: '添加清单' }).click();
  const dialog = page.getByRole('dialog', { name: '添加清单' });
  await dialog.getByLabel('名称').fill('私密');
  await dialog.getByRole('switch', { name: '不进智能清单' }).check();
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(listTitle(page)).toHaveText('私密');
  const lists = (await (await page.request.get('/api/lists')).json()) as { lists: { id: string; name: string; isInbox: boolean }[] };
  const privateList = lists.lists.find((l) => l.name === '私密') as { id: string };

  await post(page, '/api/tasks', { title: '交房租', dates: dueOn(-3) });
  await post(page, '/api/tasks', { title: '体检', dates: dueOn(-1), priority: 'high' });
  await post(page, '/api/tasks', { title: '写周报', dates: dueOn(0) });
  await post(page, '/api/tasks', { title: '取快递', dates: dueOn(1) });
  await post(page, '/api/tasks', { title: '看牙医', dates: dueOn(4) });
  await post(page, '/api/tasks', { title: '私密的今天任务', dates: dueOn(0), listId: privateList.id });
  await page.reload();

  await openSmart(page, '今天');
  await expect(section(page, /^已过期/).getByRole('button', { name: '交房租', exact: true })).toBeVisible();
  await expect(section(page, /^已过期/).getByRole('button', { name: '体检', exact: true })).toBeVisible();
  await expect(section(page, /^今天 周/).getByRole('button', { name: '写周报', exact: true })).toBeVisible();
  await expect(main(page).getByRole('button', { name: '私密的今天任务' })).toHaveCount(0);
  await expect(main(page).getByRole('button', { name: '取快递' })).toHaveCount(0);
  // Each row names its 清单, like the reference.
  await expect(section(page, /^今天 周/).getByText('收件箱')).toBeVisible();
  // Sidebar badge: 2 overdue + 1 today.
  const smartNav = (await openSidebar(page)).getByRole('list', { name: '智能清单' });
  await expect(smartNav.getByRole('link', { name: /^今天/ })).toContainText('3');
  if (isMobile(page)) await page.getByRole('button', { name: '关闭侧栏' }).click();

  // Quick add in 今天: lands in the 收件箱 dated today.
  await expect(quickAdd(page)).toHaveAttribute('placeholder', /收件箱/);
  await quickAdd(page).fill('买菜');
  await quickAdd(page).press('Enter');
  await expect(section(page, /^今天 周/).getByRole('button', { name: '买菜', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`smart-today-${testInfo.project.name}.png`) });

  // Completing moves the task into the 已完成 section of 今天.
  await section(page, /^今天 周/).getByRole('checkbox', { name: '买菜' }).click();
  await expect(section(page, /^已完成/).getByRole('checkbox', { name: '买菜' })).toBeChecked();

  await openSmart(page, '明天');
  await expect(main(page).getByRole('button', { name: '取快递', exact: true })).toBeVisible();
  await expect(main(page).getByRole('button', { name: '交房租' })).toHaveCount(0);

  await openSmart(page, '最近7天');
  for (const title of ['交房租', '写周报', '取快递', '看牙医']) {
    await expect(main(page).getByRole('button', { name: title, exact: true })).toBeVisible();
  }
  await expect(section(page, /^明天 周/).getByRole('button', { name: '取快递', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`smart-week-${testInfo.project.name}.png`) });

  // The 清单 itself still shows its task.
  await (await openSidebar(page)).getByRole('link', { name: '私密' }).click();
  await expect(main(page).getByRole('button', { name: '私密的今天任务', exact: true })).toBeVisible();

  // Hide 明天 from the sidebar, then show it again from 设置 → 智能清单.
  const nav = await openSidebar(page);
  await nav.getByRole('button', { name: '智能清单操作：明天' }).click();
  await page.getByRole('menuitem', { name: '隐藏' }).click();
  await expect(nav.getByRole('link', { name: /^明天/ })).toHaveCount(0);
  await page.reload();
  await expect((await openSidebar(page)).getByRole('link', { name: /^明天/ })).toHaveCount(0);
  if (isMobile(page)) await page.getByRole('button', { name: '设置' }).click();
  else await page.getByRole('navigation', { name: '模块' }).getByRole('button', { name: '设置' }).click();
  const settings = page.getByRole('dialog', { name: '设置' });
  await settings.getByRole('tab', { name: '智能清单' }).click();
  await expect(settings.getByRole('switch', { name: '明天' })).not.toBeChecked();
  await settings.getByRole('switch', { name: '明天' }).check();
  await expect(settings.getByRole('switch', { name: '明天' })).toBeChecked();
  await page.keyboard.press('Escape');
  await expect((await openSidebar(page)).getByRole('link', { name: /^明天/ })).toBeVisible();
});

test('过滤器: create with combined conditions, edit, delete', async ({ page }, testInfo) => {
  const { username, password } = createUser('filter');
  await logIn(page, username, password);
  const work = await post(page, '/api/lists', { name: '工作', excludeFromSmartLists: true });
  await post(page, '/api/lists', { name: '生活' });
  await post(page, '/api/tasks', { title: '季度汇报', listId: work.id, priority: 'high', dates: dueOn(0) });
  await post(page, '/api/tasks', { title: '整理邮件', listId: work.id, priority: 'low' });
  await post(page, '/api/tasks', { title: '买礼物', priority: 'high' });
  await page.reload();

  const sidebar = await openSidebar(page);
  await expect(sidebar.getByText('根据清单、时间、优先级、标签等过滤出特定的任务')).toBeVisible();
  await sidebar.getByRole('button', { name: '添加过滤器' }).click();
  const dialog = page.getByRole('dialog', { name: '添加过滤器' });
  await dialog.getByLabel('名称').fill('工作要事');
  await dialog.getByRole('group', { name: /^清单/ }).getByRole('checkbox', { name: '工作' }).check();
  await dialog.getByRole('group', { name: /^优先级/ }).getByRole('checkbox', { name: '高优先级' }).check();
  if (testInfo.project.name === 'desktop') await page.screenshot({ path: testInfo.outputPath(`filter-dialog-${testInfo.project.name}.png`) });
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(listTitle(page)).toHaveText('工作要事');
  // 工作 is out of 智能清单, but a 过滤器 still selects it.
  await expect(main(page).getByRole('button', { name: '季度汇报', exact: true })).toBeVisible();
  await expect(main(page).getByRole('button', { name: '整理邮件' })).toHaveCount(0);
  await expect(main(page).getByRole('button', { name: '买礼物' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath(`filter-view-${testInfo.project.name}.png`) });

  // Edit: any priority of 工作 → both 工作 tasks.
  const nav = await openSidebar(page);
  await nav.getByRole('button', { name: '过滤器操作：工作要事' }).click();
  await page.getByRole('menuitem', { name: '编辑' }).click();
  const edit = page.getByRole('dialog', { name: '编辑过滤器' });
  await expect(edit.getByRole('checkbox', { name: '工作' })).toBeChecked();
  await edit.getByRole('checkbox', { name: '高优先级' }).uncheck();
  await edit.getByLabel('名称').fill('工作全部');
  await edit.getByRole('button', { name: '保存' }).click();
  await expect(listTitle(page)).toHaveText('工作全部');
  await expect(main(page).getByRole('button', { name: '整理邮件', exact: true })).toBeVisible();
  await page.reload();
  await expect(listTitle(page)).toHaveText('工作全部');

  // Delete: back to the 收件箱, the tasks remain.
  await (await openSidebar(page)).getByRole('button', { name: '过滤器操作：工作全部' }).click();
  await page.getByRole('menuitem', { name: '删除' }).click();
  await page.getByRole('dialog', { name: '删除过滤器' }).getByRole('button', { name: '删除' }).click();
  await expect(listTitle(page)).toHaveText('收件箱');
  await expect((await openSidebar(page)).getByRole('link', { name: '工作全部' })).toHaveCount(0);
});

test('过滤器 whose 清单 was deleted can still be edited (review round 1)', async ({ page }) => {
  const { username, password } = createUser('filter-deleted');
  await logIn(page, username, password);
  await post(page, '/api/tasks', { title: '收件箱的任务' });
  await page.reload();

  // 1. A 清单 「临时清单」 and a 过滤器 with 清单 = 临时清单.
  let sidebar = await openSidebar(page);
  await sidebar.getByRole('button', { name: '添加清单' }).click();
  const listDialog = page.getByRole('dialog', { name: '添加清单' });
  await listDialog.getByLabel('名称').fill('临时清单');
  await listDialog.getByRole('button', { name: '保存' }).click();
  await expect(listTitle(page)).toHaveText('临时清单');
  sidebar = await openSidebar(page);
  await sidebar.getByRole('button', { name: '添加过滤器' }).click();
  const add = page.getByRole('dialog', { name: '添加过滤器' });
  await add.getByLabel('名称').fill('看临时清单');
  await add.getByRole('checkbox', { name: '临时清单' }).check();
  await add.getByRole('button', { name: '保存' }).click();
  await expect(listTitle(page)).toHaveText('看临时清单');
  await expect(main(page).getByRole('button', { name: '收件箱的任务' })).toHaveCount(0);

  // 2. Delete 「临时清单」.
  sidebar = await openSidebar(page);
  await sidebar.getByRole('button', { name: '清单操作：临时清单' }).click();
  await page.getByRole('menuitem', { name: '删除' }).click();
  await page.getByRole('dialog', { name: '删除清单' }).getByRole('button', { name: '删除' }).click();
  await expect(page.getByRole('dialog', { name: '删除清单' })).toBeHidden();

  // 3. Edit the 过滤器: nothing ticked under 清单 (= all 清单), rename, save.
  sidebar = await openSidebar(page);
  await sidebar.getByRole('button', { name: '过滤器操作：看临时清单' }).click();
  await page.getByRole('menuitem', { name: '编辑' }).click();
  const edit = page.getByRole('dialog', { name: '编辑过滤器' });
  await expect(edit.getByRole('group', { name: /^清单/ }).getByRole('checkbox', { checked: true })).toHaveCount(0);
  await edit.getByLabel('名称').fill('改个名');
  await edit.getByRole('button', { name: '保存' }).click();
  await expect(edit).toBeHidden();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(listTitle(page)).toHaveText('改个名');
  // The view matches the dialog: 清单 is unrestricted, so the 收件箱 task shows.
  await expect(main(page).getByRole('button', { name: '收件箱的任务', exact: true })).toBeVisible();
  await page.reload();
  await expect(listTitle(page)).toHaveText('改个名');
  await expect(main(page).getByRole('button', { name: '收件箱的任务', exact: true })).toBeVisible();
});

test('全局搜索: title, 描述 and 检查项, including a 不进智能清单 清单', async ({ page }, testInfo) => {
  const { username, password } = createUser('search');
  await logIn(page, username, password);
  const hidden = await post(page, '/api/lists', { name: '日记', excludeFromSmartLists: true });
  await post(page, '/api/tasks', { title: '订机票去杭州' });
  await post(page, '/api/tasks', { title: '周末计划', description: '去**杭州**看西湖' });
  const trip = await post(page, '/api/tasks', { title: '出差准备', description: '杭州的酒店\n充电器' });
  expect((await page.request.patch(`/api/tasks/${trip.id}`, { data: { kind: 'checklist' } })).status()).toBe(200);
  await post(page, '/api/tasks', { title: '杭州游记', listId: hidden.id });
  await post(page, '/api/tasks', { title: '无关的任务' });
  await page.reload();

  if (isMobile(page)) {
    await openSidebar(page);
    await page.getByRole('button', { name: '搜索' }).click();
  } else {
    await page.getByRole('navigation', { name: '模块' }).getByRole('link', { name: '搜索' }).click();
  }
  const box = page.getByRole('searchbox', { name: '搜索任务' });
  await expect(box).toBeFocused();
  await box.fill('杭州');
  await box.press('Enter');
  await expect(page).toHaveURL(/\/search\/%E6%9D%AD%E5%B7%9E$/);
  for (const title of ['订机票去杭州', '周末计划', '出差准备', '杭州游记']) {
    await expect(main(page).getByRole('button', { name: title, exact: true })).toBeVisible();
  }
  await expect(main(page).getByRole('button', { name: '无关的任务' })).toHaveCount(0);
  const rowOf = (title: string) => main(page).getByRole('listitem').filter({ has: page.getByRole('button', { name: title, exact: true }) });
  await expect(rowOf('周末计划')).toContainText('匹配描述');
  await expect(rowOf('出差准备')).toContainText('匹配检查项');
  await expect(rowOf('杭州游记')).toContainText('日记');
  await page.screenshot({ path: testInfo.outputPath(`search-${testInfo.project.name}.png`) });

  // Opening a result keeps the search; refreshing re-runs it.
  await main(page).getByRole('button', { name: '周末计划', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '任务详情' }).getByRole('textbox', { name: '任务标题' })).toHaveValue('周末计划');
  if (isMobile(page)) await page.getByRole('button', { name: '返回列表' }).click();
  await page.reload();
  await expect(main(page).getByRole('button', { name: '杭州游记', exact: true })).toBeVisible();

  await page.getByRole('searchbox', { name: '搜索任务' }).fill('没有这个词');
  await expect(main(page).getByText('没有找到相关任务')).toBeVisible();
});

test('排序和分组: per view, remembered, keyboard operable', async ({ page }) => {
  const { username, password } = createUser('layout');
  await logIn(page, username, password);
  await post(page, '/api/tasks', { title: 'B 低', priority: 'low', dates: dueOn(2) });
  await post(page, '/api/tasks', { title: 'A 高', priority: 'high', dates: dueOn(5) });
  await post(page, '/api/tasks', { title: 'C 无' });
  await page.reload();

  const titles = () => main(page).locator('.task-row-title');
  // 收件箱 default: custom order (newest on top).
  await expect(titles()).toHaveText(['C 无', 'A 高', 'B 低']);

  const layout = main(page).getByRole('button', { name: '排序和分组' });
  await layout.click();
  await page.getByRole('menuitemradio', { name: '标题' }).click();
  await expect(titles()).toHaveText(['A 高', 'B 低', 'C 无']);

  // Keyboard: open with Enter, move with the arrow keys, choose with Enter.
  await layout.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: '排序和分组' });
  await expect(menu.getByRole('menuitemradio', { name: '标题' })).toHaveAttribute('aria-checked', 'true');
  await menu.getByRole('menuitemradio', { name: '优先级' }).first().focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown'); // 排序: 自定义 日期 优先级 标题 | 分组: 不分组 清单 日期 优先级 …
  await expect(menu.getByRole('group', { name: '分组' }).getByRole('menuitemradio', { name: '日期' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(menu).toBeHidden();
  await expect(layout).toBeFocused();
  await expect(main(page).getByRole('region', { name: '无日期' }).getByRole('button', { name: 'C 无' })).toBeVisible();

  await layout.click();
  await page.getByRole('group', { name: '分组' }).getByRole('menuitemradio', { name: '优先级' }).click();
  await expect(main(page).getByRole('region')).toHaveCount(3);
  await expect(main(page).getByRole('region', { name: /^高优先级/ }).getByRole('button', { name: 'A 高' })).toBeVisible();
  await page.reload();
  await expect(main(page).getByRole('region', { name: /^低优先级/ }).getByRole('button', { name: 'B 低' })).toBeVisible();

  // Other views keep their own layout: 最近7天 still groups by day.
  await openSmart(page, '最近7天');
  await expect(main(page).getByRole('region', { name: /周/ })).toHaveCount(2);
});
