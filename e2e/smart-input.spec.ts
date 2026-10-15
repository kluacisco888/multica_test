import { expect, test, type Page } from '@playwright/test';
import { createUser, isMobile, logIn, openAccount, openSidebar } from './support.js';

/*
 * 智能识别 (EURO-27, spec 用户故事 51–58; settings as 滴答's, EURO-39): the
 * recognised parts are highlighted in 添加任务 — parts next to each other (or
 * only spaces apart) as one highlight, as 滴答 does (EURO-43) — a click cancels
 * a highlight, unticking
 * 移除文本中的日期 / 移除任务标题中的标签 keeps their text in the title, and
 * 日期识别 / 标签识别 switch them off. The server uses the real clock, so
 * dates are checked as 明天 (the list's label for tomorrow).
 */

const quickAdd = (page: Page) => page.getByRole('textbox', { name: '添加任务' });
const openTasks = (page: Page) => page.getByRole('list', { name: '任务', exact: true });
const taskButton = (page: Page, title: string) => openTasks(page).getByRole('button', { name: title, exact: true });
const openRow = (page: Page, title: string) =>
  openTasks(page).getByRole('listitem').filter({ has: page.getByRole('button', { name: title, exact: true }) });
/** The highlight of these recognised parts (one highlight for parts next to each other). */
const token = (page: Page, ...names: string[]) => page.getByRole('button', { name: `取消识别${names.join('、')}`, exact: true });

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
  await expect(token(page, '日期“明天”', '时间“下午3点”')).toBeVisible();
  await expect(token(page, '标签“#工作”', '优先级“!高”')).toBeVisible();
  await expect(page.locator('.smart-token')).toHaveCount(2);

  // Each highlight sits over its own text inside the field.
  const field = (await quickAdd(page).boundingBox())!;
  const date = (await token(page, '日期“明天”', '时间“下午3点”').boundingBox())!;
  const tag = (await token(page, '标签“#工作”', '优先级“!高”').boundingBox())!;
  expect(date.x).toBeGreaterThanOrEqual(field.x - 1);
  expect(date.x + date.width).toBeLessThan(tag.x);
  expect(tag.y).toBeGreaterThanOrEqual(field.y - 1);
  expect(tag.y + tag.height).toBeLessThanOrEqual(field.y + field.height + 1);
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

test('parts next to each other are one highlight, and a click cancels all of it (EURO-43)', async ({ page }, testInfo) => {
  const user = createUser('smart-merge');
  await logIn(page, user.username, user.password);

  await quickAdd(page).fill('明天上午10点开会');
  const whole = token(page, '日期“明天”', '时间“上午10点”');
  await expect(whole).toBeVisible();
  await expect(whole).toHaveText('明天上午10点');
  await expect(page.locator('.smart-token')).toHaveCount(1);
  // The one highlight covers 明天上午10点, from the start of the text.
  const field = (await quickAdd(page).boundingBox())!;
  const box = (await whole.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(field.x - 1);
  expect(box.x).toBeLessThan(field.x + 40);
  expect(box.width).toBeGreaterThan(60);
  await page.screenshot({ path: testInfo.outputPath(`smart-input-merged-${testInfo.project.name}.png`) });

  await whole.click();
  await expect(page.getByTestId('smart-highlights')).toHaveCount(0);
  await expect(quickAdd(page)).toHaveValue('明天上午10点开会');
  await expect(quickAdd(page)).toBeFocused();
  await quickAdd(page).press('Enter');
  // 标题恢复原文: saved as typed, with no date.
  await expect(taskButton(page, '明天上午10点开会')).toBeVisible();
  await taskButton(page, '明天上午10点开会').click();
  const detail = page.getByRole('complementary', { name: '任务详情' });
  await expect(detail.getByRole('button', { name: '设置日期' })).toBeVisible();
  if (isMobile(page)) await page.getByRole('button', { name: '返回列表' }).click();

  // 重复 + 时间, and the keyboard: Tab to the highlight and Enter cancels all of it too.
  await quickAdd(page).fill('每天晚上跑步');
  const daily = token(page, '重复“每天”', '时间“晚上”');
  await expect(daily).toHaveText('每天晚上');
  await expect(page.locator('.smart-token')).toHaveCount(1);
  if (!isMobile(page)) {
    await page.keyboard.press('Tab');
    await expect(daily).toBeFocused();
    await page.keyboard.press('Enter');
  } else {
    await daily.click();
  }
  await expect(page.getByTestId('smart-highlights')).toHaveCount(0);
  await expect(quickAdd(page)).toBeFocused();
  await quickAdd(page).press('Enter');
  await expect(taskButton(page, '每天晚上跑步')).toBeVisible();

  // Only spaces between: still one highlight.
  await quickAdd(page).fill('明天 上午10点 开会');
  await expect(token(page, '日期“明天”', '时间“上午10点”')).toHaveText('明天 上午10点');
  await expect(page.locator('.smart-token')).toHaveCount(1);
});

test('parts apart are highlighted and cancelled each on its own', async ({ page }) => {
  const user = createUser('smart-cancel');
  await logIn(page, user.username, user.password);

  await quickAdd(page).fill('明天去取快递 #生活');
  await expect(token(page, '日期“明天”')).toBeVisible();
  await expect(token(page, '标签“#生活”')).toBeVisible();
  await expect(page.locator('.smart-token')).toHaveCount(2);
  await token(page, '标签“#生活”').click();
  await expect(token(page, '标签“#生活”')).toHaveCount(0);
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

  await expect(page.getByTestId('smart-highlights')).toHaveCount(0);
  await quickAdd(page).press('Enter');
  await expect(taskButton(page, '明天去取快递 #生活')).toBeVisible();
  await expect(openRow(page, '明天去取快递 #生活')).not.toContainText('今天');
});

test('the 智能识别 settings are laid out as 滴答’s, with 滴答’s defaults', async ({ page }, testInfo) => {
  const user = createUser('smart-layout');
  await logIn(page, user.username, user.password);

  const dialog = await openSmartSettings(page, user.username);
  const section = dialog.getByRole('region', { name: '智能识别' });
  await expect(section.getByRole('switch')).toHaveCount(3);
  for (const name of ['日期识别', '标签识别', '网址解析']) await expect(section.getByRole('switch', { name })).toBeChecked();
  for (const name of ['移除文本中的日期', '移除任务标题中的标签']) await expect(section.getByRole('checkbox', { name })).toBeChecked();
  await expect(section.getByRole('switch', { name: '日期识别' })).toHaveAccessibleDescription('添加任务时，识别日期和时间信息并自动设置提醒。');
  await expect(section.getByRole('switch', { name: '标签识别' })).toHaveAccessibleDescription('添加任务时，你可以选择在任务标题中保留或移除标签文本。');
  await expect(section.getByRole('switch', { name: '网址解析' })).toHaveAccessibleDescription('当任务标题为网址时，将识别为网页标题以便查看。');
  // 滴答's order: each switch, then its 移除 tick.
  const order = await section.locator('input[type="checkbox"]').evaluateAll((els) => els.map((el) => (el as HTMLInputElement).labels?.[0]?.textContent?.trim()));
  expect(order).toEqual(['日期识别', '移除文本中的日期', '标签识别', '移除任务标题中的标签', '网址解析']);
  await page.screenshot({ path: testInfo.outputPath(`smart-input-settings-${testInfo.project.name}.png`) });
});

test('unticking 移除文本中的日期 / 移除任务标题中的标签 keeps that text in the title', async ({ page }) => {
  const user = createUser('smart-keep');
  await logIn(page, user.username, user.password);

  const dialog = await openSmartSettings(page, user.username);
  await saveSetting(page, () => dialog.getByRole('checkbox', { name: '移除文本中的日期' }).uncheck());
  await closeSettings(page);

  await quickAdd(page).fill('明天买牛奶 #购物');
  await expect(token(page, '日期“明天”')).toBeVisible();
  await quickAdd(page).press('Enter');
  // The date text stays, the 标签 is still taken out.
  await expect(taskButton(page, '明天买牛奶')).toBeVisible();
  await expect(openRow(page, '明天买牛奶')).toContainText('明天');
  await expect(openRow(page, '明天买牛奶')).toContainText('购物');

  const again = await openSmartSettings(page, user.username);
  await saveSetting(page, () => again.getByRole('checkbox', { name: '移除任务标题中的标签' }).uncheck());
  await closeSettings(page);
  await quickAdd(page).fill('后天买面包 #购物');
  await expect(token(page, '标签“#购物”')).toBeVisible();
  await quickAdd(page).press('Enter');
  await expect(taskButton(page, '后天买面包 #购物')).toBeVisible();
});

test('日期识别 off: dates are no longer recognised, 标签 still are; 标签识别 off too: nothing is', async ({ page }) => {
  const user = createUser('smart-off');
  await logIn(page, user.username, user.password);

  const dialog = await openSmartSettings(page, user.username);
  await saveSetting(page, () => dialog.getByRole('switch', { name: '日期识别' }).uncheck());
  await expect(dialog.getByRole('checkbox', { name: '移除文本中的日期' })).toBeDisabled();
  await closeSettings(page);

  await quickAdd(page).fill('明天买牛奶 #购物');
  await expect(token(page, '标签“#购物”')).toBeVisible();
  await expect(token(page, '日期“明天”')).toHaveCount(0);
  await quickAdd(page).press('Enter');
  await expect(taskButton(page, '明天买牛奶')).toBeVisible();
  await taskButton(page, '明天买牛奶').click();
  const detail = page.getByRole('complementary', { name: '任务详情' });
  await expect(detail.getByRole('button', { name: '设置日期' })).toBeVisible();
  if (isMobile(page)) await page.getByRole('button', { name: '返回列表' }).click();

  const tags = await openSmartSettings(page, user.username);
  await saveSetting(page, () => tags.getByRole('switch', { name: '标签识别' }).uncheck());
  await expect(tags.getByRole('checkbox', { name: '移除任务标题中的标签' })).toBeDisabled();
  await closeSettings(page);
  await quickAdd(page).fill('明天买面包 #购物');
  await expect(page.getByTestId('smart-highlights')).toHaveCount(0);
  await quickAdd(page).press('Enter');
  await expect(taskButton(page, '明天买面包 #购物')).toBeVisible();

  // Back on: recognised again.
  const again = await openSmartSettings(page, user.username);
  await saveSetting(page, () => again.getByRole('switch', { name: '日期识别' }).check());
  await closeSettings(page);
  await quickAdd(page).fill('后天买牛奶');
  await expect(token(page, '日期“后天”')).toBeVisible();
});

test('模糊时间 settings change what 上午 means', async ({ page }) => {
  const user = createUser('smart-fuzzy');
  await logIn(page, user.username, user.password);

  const dialog = await openSmartSettings(page, user.username);
  const morning = dialog.getByLabel('上午', { exact: true });
  await expect(morning).toHaveValue('09:00');
  await saveSetting(page, () => morning.fill('08:30'));
  await closeSettings(page);

  await quickAdd(page).fill('明天上午晨跑');
  await quickAdd(page).press('Enter');
  await taskButton(page, '晨跑').click();
  const detail = page.getByRole('complementary', { name: '任务详情' });
  await expect(detail.getByRole('button', { name: /^日期：明天.*08:30/ })).toBeVisible();
});

// --- the other 新建任务 fields: 看板, 四象限, 日历 -------------------------------

type ApiTask = { id: string; title: string; priority: string; tagIds: string[]; listId: string; dates: Record<string, unknown> | null; reminders: unknown[] };

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
  await expect(token(page, '日期“明天”')).toBeVisible();
  await expect(token(page, '标签“#工作”', '优先级“!高”')).toBeVisible();
  // The highlight sits over the start of the input's text.
  const field = (await input.boundingBox())!;
  const first = (await token(page, '日期“明天”').boundingBox())!;
  expect(first.x).toBeGreaterThan(field.x);
  expect(first.x).toBeLessThan(field.x + 16);
  expect(first.y).toBeGreaterThanOrEqual(field.y - 1);
  expect(first.y + first.height).toBeLessThanOrEqual(field.y + field.height + 1);
  await page.screenshot({ path: testInfo.outputPath(`smart-input-kanban-${testInfo.project.name}.png`) });
  // #工作 !高 are one space apart: one highlight, cancelled together.
  await token(page, '标签“#工作”', '优先级“!高”').click();
  await expect(token(page, '标签“#工作”', '优先级“!高”')).toHaveCount(0);
  await expect(input).toBeFocused();
  await input.press('Enter');

  const column = page.getByRole('region', { name: '看板' }).getByRole('region', { name: '未分组', exact: true });
  await expect(column.getByRole('button', { name: '写周报 #工作 !高', exact: true })).toBeVisible();
  const task = await taskTitled(page, `listId=${listId}`, '写周报 #工作 !高');
  expect(task).toMatchObject({ priority: 'none', tagIds: [], dates: { allDay: true, dueDate: shanghaiDate(1) } });
});

test('四象限: the quadrant quick add highlights, cancels on click and keeps the quadrant’s 优先级', async ({ page }) => {
  const user = createUser('smart-matrix');
  await logIn(page, user.username, user.password);
  await openModule(page, '四象限');
  await expect(page.getByRole('heading', { level: 1, name: '四象限' })).toBeVisible();

  await page.getByRole('button', { name: '在「重要且紧急」中添加任务' }).click();
  const input = page.getByRole('textbox', { name: '添加任务到「重要且紧急」' });
  await input.fill('明天上午交报告 #客户');
  await expect(token(page, '日期“明天”', '时间“上午”')).toBeVisible();
  await token(page, '标签“#客户”').click();
  await expect(token(page, '标签“#客户”')).toHaveCount(0);
  await input.press('Enter');

  const quadrant = page.getByRole('region', { name: '重要且紧急', exact: true });
  await expect(quadrant.getByRole('button', { name: '交报告 #客户', exact: true })).toBeVisible();
  const tomorrow = shanghaiDate(1);
  const task = await taskTitled(page, `from=${shanghaiDate(-1)}&to=${shanghaiDate(3)}`, '交报告 #客户');
  expect(task).toMatchObject({ priority: 'high', tagIds: [], dates: { allDay: false, dueAt: shanghaiAt(tomorrow, '09:00') } });
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
  await expect(token(page, '日期“明天”', '时间“下午3点”')).toBeVisible();
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

test('移除文本中的日期 and the 日期识别 / 标签识别 switches apply to the 看板, 四象限 and 日历 fields too', async ({ page }) => {
  const user = createUser('smart-views');
  await logIn(page, user.username, user.password);

  // 移除文本中的日期 unticked: the 看板 card keeps its text and still gets the date.
  const keep = await openSmartSettings(page, user.username);
  await saveSetting(page, () => keep.getByRole('checkbox', { name: '移除文本中的日期' }).uncheck());
  await closeSettings(page);
  const listId = await openBoard(page);
  await page.getByRole('button', { name: '在「未分组」中添加任务' }).click();
  await page.getByRole('textbox', { name: '添加任务到「未分组」' }).fill('后天复盘');
  await expect(token(page, '日期“后天”')).toBeVisible();
  await page.getByRole('textbox', { name: '添加任务到「未分组」' }).press('Enter');
  expect((await taskTitled(page, `listId=${listId}`, '后天复盘')).dates).toMatchObject({ allDay: true, dueDate: shanghaiDate(2) });
  await page.getByRole('textbox', { name: '添加任务到「未分组」' }).press('Escape');

  // Both switched off: no highlights anywhere, the text is saved as typed.
  const off = await openSmartSettings(page, user.username);
  await saveSetting(page, () => off.getByRole('switch', { name: '日期识别' }).uncheck());
  await saveSetting(page, () => off.getByRole('switch', { name: '标签识别' }).uncheck());
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

test('四象限: a recognised !低 overrides the quadrant’s 优先级', async ({ page }) => {
  const user = createUser('smart-matrix-low');
  await logIn(page, user.username, user.password);
  await openModule(page, '四象限');
  await expect(page.getByRole('heading', { level: 1, name: '四象限' })).toBeVisible();

  await page.getByRole('button', { name: '在「重要且紧急」中添加任务' }).click();
  const input = page.getByRole('textbox', { name: '添加任务到「重要且紧急」' });
  await input.fill('整理邮件 !低');
  await expect(token(page, '优先级“!低”')).toBeVisible();
  await input.press('Enter');

  // 低优先级 belongs to 不重要但紧急 by default: the task moves there.
  await expect(page.getByRole('region', { name: '不重要但紧急', exact: true }).getByRole('button', { name: '整理邮件', exact: true })).toBeVisible();
  expect((await taskTitled(page, 'smart=notImportant', '整理邮件')).priority).toBe('low');
});

test('日历: a time or a 提醒 alone keeps the clicked day', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-13T04:00:00.000Z'));
  const user = createUser('smart-calendar-anchor');
  await logIn(page, user.username, user.password);
  await openModule(page, '日历');
  await expect(page.getByRole('heading', { level: 1, name: '2026年10月' })).toBeVisible();
  const range = 'from=2026-09-28&to=2026-11-08';
  const cell = (label: string) => page.getByRole('button', { name: new RegExp(`^${label} .*，新建任务$`) });
  const input = page.getByRole('textbox', { name: '新任务标题' });

  await cell('10月22日').click();
  await input.fill('下午3点开会');
  await expect(token(page, '时间“下午3点”')).toBeVisible();
  await input.press('Enter');
  expect((await taskTitled(page, range, '开会')).dates).toMatchObject({ allDay: false, dueAt: shanghaiAt('2026-10-22', '15:00') });
  await page.keyboard.press('Escape');

  await cell('10月23日').click();
  await input.fill('提醒我交报告');
  await input.press('Enter');
  expect(await taskTitled(page, range, '交报告')).toMatchObject({
    dates: { allDay: true, dueDate: '2026-10-23' },
    reminders: [{ type: 'day', daysBefore: 0, time: null }],
  });
});

test('明天: 提醒我续费 stays tomorrow, with a reminder', async ({ page }) => {
  const user = createUser('smart-tomorrow');
  await logIn(page, user.username, user.password);
  const sidebar = await openSidebar(page);
  await sidebar.getByRole('list', { name: '智能清单' }).getByRole('link', { name: /^明天/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: '明天' })).toBeVisible();

  await quickAdd(page).fill('提醒我续费');
  await expect(token(page, '提醒“提醒我”')).toBeVisible();
  await quickAdd(page).press('Enter');
  // Still in 明天 once saved.
  await expect(page.getByRole('main').getByRole('button', { name: '续费', exact: true })).toBeVisible();
  const tomorrow = shanghaiDate(1);
  expect(await taskTitled(page, `from=${tomorrow}&to=${tomorrow}`, '续费')).toMatchObject({
    dates: { allDay: true, dueDate: tomorrow },
    reminders: [{ type: 'day', daysBefore: 0, time: null }],
  });
});
