import { expect, test, type Page } from '@playwright/test';
import { createUser, isMobile, logIn, openAccount, openSidebar } from './support.js';

/*
 * 智能识别 (EURO-27, spec 用户故事 51–58): the recognised parts are
 * highlighted in 添加任务, a click cancels one, 保留识别文字 keeps the text in
 * the title, and the 总开关 switches it all off. The server uses the real
 * clock, so dates are checked as 明天 (the list's label for tomorrow).
 */

const quickAdd = (page: Page) => page.getByRole('textbox', { name: '添加任务' });
const openTasks = (page: Page) => page.getByRole('list', { name: '任务', exact: true });
const taskButton = (page: Page, title: string) => openTasks(page).getByRole('button', { name: title, exact: true });
const openRow = (page: Page, title: string) =>
  openTasks(page).getByRole('listitem').filter({ has: page.getByRole('button', { name: title, exact: true }) });
const token = (page: Page, name: string) => page.getByRole('button', { name: `取消识别${name}` });

async function openSmartSettings(page: Page, username: string) {
  const dialog = await openAccount(page, username);
  await dialog.getByRole('tab', { name: '更多设置' }).click();
  await expect(dialog.getByRole('heading', { name: '智能识别' })).toBeVisible();
  return dialog;
}

/** Close 设置 (and on mobile the drawer it was opened from). */
async function closeSettings(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '设置' })).toBeHidden();
  const sidebar = page.getByRole('navigation', { name: '侧栏' });
  if (isMobile(page) && (await sidebar.isVisible())) {
    // The scrim right of the drawer closes it.
    await page.mouse.click(385, 420);
    await expect(sidebar).toBeHidden();
  }
}

async function saveSetting(page: Page, action: () => Promise<void>) {
  const saved = page.waitForResponse((r) => r.url().endsWith('/api/settings') && r.request().method() === 'PATCH' && r.ok());
  await action();
  await saved;
}

test('highlights what is recognised and adds the task with it', async ({ page }, testInfo) => {
  const user = createUser('smart');
  await logIn(page, user.username, user.password);

  await quickAdd(page).fill('明天下午3点开会 #工作 !高');
  for (const name of ['日期“明天”', '时间“下午3点”', '标签“#工作”', '优先级“!高”']) await expect(token(page, name)).toBeVisible();

  // Each highlight sits over its own text inside the field.
  const field = (await quickAdd(page).boundingBox())!;
  const date = (await token(page, '日期“明天”').boundingBox())!;
  const time = (await token(page, '时间“下午3点”').boundingBox())!;
  expect(date.x).toBeGreaterThanOrEqual(field.x - 1);
  expect(date.x + date.width).toBeLessThanOrEqual(time.x + 1);
  expect(time.y).toBeGreaterThanOrEqual(field.y - 1);
  expect(time.y + time.height).toBeLessThanOrEqual(field.y + field.height + 1);
  await page.screenshot({ path: testInfo.outputPath(`smart-input-${testInfo.project.name}.png`) });

  await quickAdd(page).press('Enter');
  await expect(taskButton(page, '开会')).toBeVisible();
  await expect(quickAdd(page)).toHaveValue('');
  const row = openRow(page, '开会');
  await expect(row).toContainText('明天');
  await expect(row).toContainText('工作');

  await taskButton(page, '开会').click();
  const detail = page.getByRole('complementary', { name: '任务详情' });
  await expect(detail.getByRole('textbox', { name: '任务标题' })).toHaveValue('开会');
  await expect(detail.getByRole('button', { name: /^日期：明天.*15:00/ })).toBeVisible();
  await expect(detail.getByRole('button', { name: /高优先级/ })).toBeVisible();
});

test('a click on a highlight cancels that part', async ({ page }) => {
  const user = createUser('smart-cancel');
  await logIn(page, user.username, user.password);

  await quickAdd(page).fill('明天上午提醒我去取快递');
  await expect(token(page, '时间“上午”')).toBeVisible();
  await token(page, '时间“上午”').click();
  await expect(token(page, '时间“上午”')).toHaveCount(0);
  await expect(token(page, '日期“明天”')).toBeVisible();
  // Focus stays in the field, so Enter saves.
  await expect(quickAdd(page)).toBeFocused();

  // Keyboard: Tab to a highlight and press Enter to cancel it too.
  if (!isMobile(page)) {
    await page.keyboard.press('Tab');
    await expect(token(page, '日期“明天”')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(token(page, '日期“明天”')).toHaveCount(0);
    await expect(quickAdd(page)).toBeFocused();
  } else {
    await token(page, '日期“明天”').click();
  }

  await quickAdd(page).press('Enter');
  await expect(taskButton(page, '明天上午去取快递')).toBeVisible();
  // 提醒我 still applies: today, with a reminder.
  await expect(openRow(page, '明天上午去取快递')).toContainText('今天');
});

test('保留识别文字 keeps the recognised text in the title', async ({ page }) => {
  const user = createUser('smart-keep');
  await logIn(page, user.username, user.password);

  const dialog = await openSmartSettings(page, user.username);
  const keep = dialog.getByRole('checkbox', { name: '保留识别文字' });
  await expect(keep).not.toBeChecked();
  await saveSetting(page, () => keep.check());
  await closeSettings(page);

  await quickAdd(page).fill('明天买牛奶');
  await expect(token(page, '日期“明天”')).toBeVisible();
  await quickAdd(page).press('Enter');
  await expect(taskButton(page, '明天买牛奶')).toBeVisible();
  await expect(openRow(page, '明天买牛奶')).toContainText('明天');
});

test('the 智能识别 switch turns recognition off', async ({ page }, testInfo) => {
  const user = createUser('smart-off');
  await logIn(page, user.username, user.password);

  const dialog = await openSmartSettings(page, user.username);
  const toggle = dialog.getByRole('switch', { name: '智能识别' });
  await expect(toggle).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath(`smart-input-settings-${testInfo.project.name}.png`) });
  await saveSetting(page, () => toggle.uncheck());
  await expect(dialog.getByRole('checkbox', { name: '保留识别文字' })).toBeDisabled();
  await closeSettings(page);

  await quickAdd(page).fill('明天买牛奶 #购物');
  await expect(page.getByTestId('smart-highlights')).toHaveCount(0);
  await quickAdd(page).press('Enter');
  await expect(taskButton(page, '明天买牛奶 #购物')).toBeVisible();
  await taskButton(page, '明天买牛奶 #购物').click();
  const detail = page.getByRole('complementary', { name: '任务详情' });
  await expect(detail.getByRole('button', { name: '设置日期' })).toBeVisible();
  if (isMobile(page)) await page.getByRole('button', { name: '返回列表' }).click();

  // Back on: recognised again.
  const again = await openSmartSettings(page, user.username);
  await saveSetting(page, () => again.getByRole('switch', { name: '智能识别' }).check());
  await closeSettings(page);
  await quickAdd(page).fill('后天买牛奶');
  await expect(token(page, '日期“后天”')).toBeVisible();
});

test('模糊时间 settings change what 上午 means', async ({ page }) => {
  const user = createUser('smart-fuzzy');
  await logIn(page, user.username, user.password);

  const dialog = await openSmartSettings(page, user.username);
  const morning = dialog.getByLabel('上午', { exact: true });
  await expect(morning).toHaveValue('10:00');
  await saveSetting(page, () => morning.fill('08:30'));
  await closeSettings(page);

  await quickAdd(page).fill('明天上午晨跑');
  await quickAdd(page).press('Enter');
  await taskButton(page, '晨跑').click();
  const detail = page.getByRole('complementary', { name: '任务详情' });
  await expect(detail.getByRole('button', { name: /^日期：明天.*08:30/ })).toBeVisible();
});

// --- the other 新建任务 fields: 看板, 四象限, 日历 -------------------------------

type ApiTask = { id: string; title: string; priority: string; tagIds: string[]; listId: string; dates: Record<string, unknown> | null };

async function apiTasks(page: Page, query: string): Promise<ApiTask[]> {
  const res = await page.request.get(`/api/tasks?${query}`);
  expect(res.ok(), await res.text()).toBe(true);
  return ((await res.json()) as { tasks: ApiTask[] }).tasks;
}

async function taskTitled(page: Page, query: string, title: string): Promise<ApiTask> {
  let found: ApiTask | undefined;
  await expect.poll(async () => (found = (await apiTasks(page, query)).find((t) => t.title === title)) !== undefined).toBe(true);
  return found as ApiTask;
}

/** Shanghai calendar date `days` from today, and the instant of `time` on it. */
function shanghaiDate(days: number, from = new Date()): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(from);
  const t = new Date(`${today}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}
const shanghaiAt = (date: string, time: string) => new Date(`${date}T${time}:00+08:00`).toISOString();

async function openBoard(page: Page) {
  const res = await page.request.post('/api/lists', { data: { name: '项目' } });
  expect(res.status()).toBe(201);
  const list = (await res.json()) as { id: string };
  await page.reload();
  const sidebar = await openSidebar(page);
  await sidebar.getByRole('link', { name: /^项目/ }).click();
  await page.getByRole('button', { name: '排序和分组' }).click();
  await page.getByRole('menuitemradio', { name: '看板', exact: true }).click();
  await expect(page.getByRole('region', { name: '看板' })).toBeVisible();
  return list.id;
}

async function openModule(page: Page, name: '四象限' | '日历') {
  if (isMobile(page)) {
    const sidebar = await openSidebar(page);
    await sidebar.getByRole('button', { name }).click();
  } else {
    await page.getByRole('navigation', { name: '模块' }).getByRole('link', { name }).click();
  }
}

test('看板: the column quick add highlights, cancels on click and saves what is recognised', async ({ page }, testInfo) => {
  const user = createUser('smart-kanban');
  await logIn(page, user.username, user.password);
  const listId = await openBoard(page);

  await page.getByRole('button', { name: '在「未分组」中添加任务' }).click();
  const input = page.getByRole('textbox', { name: '添加任务到「未分组」' });
  await input.fill('明天写周报 #工作 !高');
  for (const name of ['日期“明天”', '标签“#工作”', '优先级“!高”']) await expect(token(page, name)).toBeVisible();
  // The highlight sits over the start of the input's text.
  const field = (await input.boundingBox())!;
  const first = (await token(page, '日期“明天”').boundingBox())!;
  expect(first.x).toBeGreaterThan(field.x);
  expect(first.x).toBeLessThan(field.x + 16);
  expect(first.y).toBeGreaterThanOrEqual(field.y - 1);
  expect(first.y + first.height).toBeLessThanOrEqual(field.y + field.height + 1);
  await page.screenshot({ path: testInfo.outputPath(`smart-input-kanban-${testInfo.project.name}.png`) });
  await token(page, '优先级“!高”').click();
  await expect(token(page, '优先级“!高”')).toHaveCount(0);
  await expect(input).toBeFocused();
  await input.press('Enter');

  const column = page.getByRole('region', { name: '看板' }).getByRole('region', { name: '未分组', exact: true });
  await expect(column.getByRole('button', { name: '写周报 !高', exact: true })).toBeVisible();
  const task = await taskTitled(page, `listId=${listId}`, '写周报 !高');
  expect(task).toMatchObject({ priority: 'none', dates: { allDay: true, dueDate: shanghaiDate(1) } });
  expect(task.tagIds).toHaveLength(1);
});

test('四象限: the quadrant quick add highlights, cancels on click and keeps the quadrant’s 优先级', async ({ page }) => {
  const user = createUser('smart-matrix');
  await logIn(page, user.username, user.password);
  await openModule(page, '四象限');
  await expect(page.getByRole('heading', { level: 1, name: '四象限' })).toBeVisible();

  await page.getByRole('button', { name: '在「重要且紧急」中添加任务' }).click();
  const input = page.getByRole('textbox', { name: '添加任务到「重要且紧急」' });
  await input.fill('明天上午交报告 #客户');
  await expect(token(page, '时间“上午”')).toBeVisible();
  await token(page, '标签“#客户”').click();
  await expect(token(page, '标签“#客户”')).toHaveCount(0);
  await input.press('Enter');

  const quadrant = page.getByRole('region', { name: '重要且紧急', exact: true });
  await expect(quadrant.getByRole('button', { name: '交报告 #客户', exact: true })).toBeVisible();
  const tomorrow = shanghaiDate(1);
  const task = await taskTitled(page, `from=${shanghaiDate(-1)}&to=${shanghaiDate(3)}`, '交报告 #客户');
  expect(task).toMatchObject({ priority: 'high', tagIds: [], dates: { allDay: false, dueAt: shanghaiAt(tomorrow, '10:00') } });
});

test('日历: the 新建任务 popover highlights, cancels on click, and a recognised date replaces the clicked day', async ({ page }) => {
  // The browser clock is pinned like calendar.spec.ts: Tuesday 2026-10-13 12:00 in Shanghai.
  await page.clock.setFixedTime(new Date('2026-10-13T04:00:00.000Z'));
  const user = createUser('smart-calendar');
  await logIn(page, user.username, user.password);
  await openModule(page, '日历');
  await expect(page.getByRole('heading', { level: 1, name: '2026年10月' })).toBeVisible();
  const range = 'from=2026-09-28&to=2026-11-08';
  const cell = (label: string) => page.getByRole('button', { name: new RegExp(`^${label} .*，新建任务$`) });
  const input = page.getByRole('textbox', { name: '新任务标题' });

  // A recognised date and time win over the clicked day.
  await cell('10月22日').click();
  await input.fill('明天下午3点开会');
  await expect(token(page, '时间“下午3点”')).toBeVisible();
  await input.press('Enter');
  expect((await taskTitled(page, range, '开会')).dates).toMatchObject({ allDay: false, dueAt: shanghaiAt('2026-10-14', '15:00') });
  await page.keyboard.press('Escape');

  // Cancelled: the clicked day stays, the text stays in the title.
  await cell('10月22日').click();
  await input.fill('明天交周报 !中');
  await token(page, '日期“明天”').click();
  await expect(token(page, '日期“明天”')).toHaveCount(0);
  await expect(input).toBeFocused();
  await input.press('Enter');
  expect(await taskTitled(page, range, '明天交周报')).toMatchObject({ priority: 'medium', dates: { allDay: true, dueDate: '2026-10-22' } });
});

test('保留识别文字 and the 智能识别 switch apply to the 看板, 四象限 and 日历 fields too', async ({ page }) => {
  const user = createUser('smart-views');
  await logIn(page, user.username, user.password);

  // 保留识别文字: the 看板 card keeps its text and still gets the date.
  const keep = await openSmartSettings(page, user.username);
  await saveSetting(page, () => keep.getByRole('checkbox', { name: '保留识别文字' }).check());
  await closeSettings(page);
  const listId = await openBoard(page);
  await page.getByRole('button', { name: '在「未分组」中添加任务' }).click();
  await page.getByRole('textbox', { name: '添加任务到「未分组」' }).fill('后天复盘');
  await expect(token(page, '日期“后天”')).toBeVisible();
  await page.getByRole('textbox', { name: '添加任务到「未分组」' }).press('Enter');
  expect((await taskTitled(page, `listId=${listId}`, '后天复盘')).dates).toMatchObject({ allDay: true, dueDate: shanghaiDate(2) });
  await page.getByRole('textbox', { name: '添加任务到「未分组」' }).press('Escape');

  // Switched off: no highlights anywhere, the text is saved as typed.
  const off = await openSmartSettings(page, user.username);
  await saveSetting(page, () => off.getByRole('switch', { name: '智能识别' }).uncheck());
  await closeSettings(page);

  await page.getByRole('button', { name: '在「未分组」中添加任务' }).click();
  await page.getByRole('textbox', { name: '添加任务到「未分组」' }).fill('明天复盘 !高');
  await expect(page.getByTestId('smart-highlights')).toHaveCount(0);
  await page.getByRole('textbox', { name: '添加任务到「未分组」' }).press('Enter');
  expect(await taskTitled(page, `listId=${listId}`, '明天复盘 !高')).toMatchObject({ priority: 'none', dates: null });
  await page.getByRole('textbox', { name: '添加任务到「未分组」' }).press('Escape');

  await openModule(page, '四象限');
  await page.getByRole('button', { name: '在「重要且紧急」中添加任务' }).click();
  await page.getByRole('textbox', { name: '添加任务到「重要且紧急」' }).fill('明天上午打电话');
  await expect(page.getByTestId('smart-highlights')).toHaveCount(0);
  await page.getByRole('textbox', { name: '添加任务到「重要且紧急」' }).press('Escape');

  await openModule(page, '日历');
  await page.getByRole('button', { name: /，新建任务$/ }).first().click();
  await page.getByRole('textbox', { name: '新任务标题' }).fill('明天上午打电话');
  await expect(page.getByTestId('smart-highlights')).toHaveCount(0);
});
