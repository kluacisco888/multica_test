import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { addDays, todayIn } from '../packages/shared/src/index.js';
import { decodeMail, startFakeSmtp, type FakeSmtpServer } from '../packages/server/test/fakes/fake-smtp.js';
import { startFakeWebhook, type FakeWebhookServer } from '../packages/server/test/fakes/fake-webhook.js';
import { createUser, dida, fakeListen, isMobile, logIn, openAccount, openSidebar } from './support.js';

/*
 * 跨功能主流程 (EURO-33): each test walks one user path through several
 * features, the way the spec's 用户故事 chain together, at 1440px and 390px.
 * The server runs the real clock and the real pg-boss jobs; 提醒 go to the
 * fake 飞书 Webhook and fake SMTP below (127.0.0.1, or the Docker bridge in the
 * compose run: scripts/e2e-compose.mjs), never to the internet. Steps a user
 * does are done in the UI; the API is used to read results back and, where
 * waiting is not practical (a 提醒 at 10:00, a 番茄 of 25 minutes), to move a
 * time closer or shorten it.
 */

const TIME_ZONE = 'Asia/Shanghai';

let hook: FakeWebhookServer;
let smtp: FakeSmtpServer;
test.beforeAll(async () => {
  hook = await startFakeWebhook({ listen: fakeListen() });
  smtp = await startFakeSmtp({ listen: fakeListen(), credentials: { username: 'flows@example.com', password: 'flows-auth-code' } });
});
test.afterAll(async () => {
  await hook.close();
  await smtp.close();
});

// --- locators -------------------------------------------------------------

const listTitle = (page: Page) => page.getByRole('heading', { level: 1 });
const main = (page: Page) => page.getByRole('main');
const quickAdd = (page: Page) => page.getByRole('textbox', { name: '添加任务' });
const openTasks = (page: Page) => page.getByRole('list', { name: '任务', exact: true });
const completedTasks = (page: Page) => page.getByRole('list', { name: '已完成的任务' });
const detail = (page: Page) => page.getByRole('complementary', { name: '任务详情' });
const picker = (page: Page) => page.getByRole('dialog', { name: '设置日期' });
const token = (page: Page, name: string) => page.getByRole('button', { name: `取消识别${name}` });
/** A task's row in whatever list the main pane shows (a 清单, or a section of a 智能清单). */
const taskRow = (page: Page, title: string) =>
  main(page).getByRole('listitem').filter({ has: page.getByRole('button', { name: title, exact: true }) });
const bottomNav = (page: Page) => page.getByRole('navigation', { name: '底部导航' });

// --- API helpers (reading results back) ------------------------------------

type ApiTask = {
  id: string;
  title: string;
  listId: string;
  parentId: string | null;
  status: 'open' | 'completed' | 'abandoned';
  priority: string;
  tagIds: string[];
  dates: { allDay: true; startDate: string | null; dueDate: string } | { allDay: false; startAt: string | null; dueAt: string; timeZone: string } | null;
  repeat: { freq: string } | null;
  reminders: unknown[];
  reminderChannelIds: string[] | null;
};

async function api<T>(page: Page, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, data?: object): Promise<T> {
  const res = await page.request.fetch(url, { method, ...(data ? { data } : {}) });
  expect(res.ok(), `${method} ${url}: ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

async function search(page: Page, q: string): Promise<ApiTask[]> {
  return (await api<{ tasks: ApiTask[] }>(page, 'GET', `/api/search?q=${encodeURIComponent(q)}`)).tasks;
}

async function smartList(page: Page, smart: string): Promise<string[]> {
  return (await api<{ tasks: ApiTask[] }>(page, 'GET', `/api/tasks?smart=${smart}`)).tasks.map((t) => t.title);
}

const today = () => todayIn(new Date(), TIME_ZONE);

/** Day (YYYY-MM-DD) and HH:MM of a task's due date in Shanghai. */
function dueOf(task: ApiTask): { day: string; time: string | null } {
  const dates = task.dates;
  if (!dates) throw new Error(`${task.title} has no date`);
  if (dates.allDay) return { day: dates.dueDate, time: null };
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(dates.dueAt))
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** First 工作日 after `day`, from the server's 节假日数据 (GET /api/calendar/days). */
async function nextWorkdayAfter(page: Page, day: string): Promise<string> {
  const { days } = await api<{ days: { date: string; mark: 'holiday' | 'makeup_workday' | null }[] }>(
    page,
    'GET',
    `/api/calendar/days?from=${addDays(day, 1)}&to=${addDays(day, 30)}`,
  );
  const workday = days.find((d) => {
    if (d.mark === 'makeup_workday') return true;
    if (d.mark === 'holiday') return false;
    const weekday = new Date(`${d.date}T00:00:00Z`).getUTCDay();
    return weekday >= 1 && weekday <= 5;
  });
  if (!workday) throw new Error(`no 工作日 within 30 days after ${day}`);
  return workday.date;
}

const monthDay = (day: string) => `${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日`;

// --- navigation (desktop: the rail; 390px: bottom navigation, 更多 and the drawer) ---

type Module = '日历' | '番茄专注' | '习惯打卡' | '四象限' | '统计' | '搜索';

async function openModule(page: Page, module: Module) {
  if (!isMobile(page)) {
    await page.getByRole('navigation', { name: '模块' }).getByRole('link', { name: module }).click();
    return;
  }
  const tab = { 日历: '日历', 番茄专注: '专注', 习惯打卡: '习惯' }[module as string];
  if (tab) {
    await bottomNav(page).getByRole('link', { name: tab }).click();
  } else {
    await bottomNav(page).getByRole('button', { name: '更多' }).click();
    await page.getByRole('dialog', { name: '更多' }).getByRole('button', { name: module }).click();
  }
}

async function openSettings(page: Page): Promise<Locator> {
  if (isMobile(page)) {
    await bottomNav(page).getByRole('button', { name: '更多' }).click();
    await page.getByRole('dialog', { name: '更多' }).getByRole('button', { name: '设置' }).click();
  } else {
    await page.getByRole('navigation', { name: '模块' }).getByRole('button', { name: '设置', exact: true }).click();
  }
  const settings = page.getByRole('dialog', { name: '设置' });
  await expect(settings).toBeVisible();
  return settings;
}

async function closeSettings(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '设置' })).toBeHidden();
}

/** The 侧栏 from any module: 日历, 四象限 … have none, so go back to 任务 first. */
async function sidebarFromAnywhere(page: Page): Promise<Locator> {
  const sidebar = page.getByRole('navigation', { name: '侧栏' });
  const toggle = page.getByRole('button', { name: '展开侧栏' });
  if (!(await sidebar.isVisible()) && !(await toggle.isVisible())) {
    if (isMobile(page)) await bottomNav(page).getByRole('link', { name: '任务' }).click();
    else await page.getByRole('navigation', { name: '模块' }).getByRole('link', { name: '任务' }).click();
  }
  return openSidebar(page);
}

async function openSidebarLink(page: Page, name: string | RegExp) {
  const sidebar = await sidebarFromAnywhere(page);
  await sidebar.getByRole('link', { name: typeof name === 'string' ? new RegExp(`^${name}`) : name }).first().click();
}

/** Close a menu that stays open after a pick (multi-select menus), without closing the dialog under it. */
async function closeMenu(page: Page) {
  if (await page.getByRole('menu').first().isVisible()) await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
}

async function openTag(page: Page, name: string) {
  const sidebar = await sidebarFromAnywhere(page);
  await sidebar.getByRole('list', { name: '标签', exact: true }).getByRole('link', { name, exact: true }).click();
  await expect(listTitle(page)).toHaveText(name);
}

async function backToList(page: Page) {
  if (isMobile(page)) await page.getByRole('button', { name: '返回列表' }).click();
}

async function addTask(page: Page, text: string, title: string) {
  await quickAdd(page).fill(text);
  await quickAdd(page).press('Enter');
  await expect(openTasks(page).getByRole('button', { name: title, exact: true })).toBeVisible();
}

async function createFolder(page: Page, name: string) {
  const sidebar = await openSidebar(page);
  await sidebar.getByRole('button', { name: '添加文件夹' }).click();
  const dialog = page.getByRole('dialog', { name: '添加文件夹' });
  await dialog.getByLabel('文件夹名称').fill(name);
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog).toBeHidden();
}

async function createList(page: Page, name: string, folder?: string) {
  const sidebar = await openSidebar(page);
  await sidebar.getByRole('button', { name: '添加清单' }).click();
  const dialog = page.getByRole('dialog', { name: '添加清单' });
  await dialog.getByLabel('名称').fill(name);
  if (folder) await dialog.getByLabel('文件夹').selectOption({ label: folder });
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog).toBeHidden();
  await expect(listTitle(page)).toHaveText(name);
}

/** 设置 → 提醒与通知 → 添加渠道 → 飞书机器人, pointing at the fake Webhook. */
async function addFeishuChannel(page: Page, settings: Locator, name: string, token: string, isDefault: boolean) {
  await settings.getByRole('button', { name: '添加渠道' }).click();
  await page.getByRole('menuitem', { name: '飞书机器人' }).click();
  const form = page.getByRole('dialog', { name: '添加飞书机器人渠道' });
  await form.getByLabel('名称').fill(name);
  await form.getByLabel('Webhook URL').fill(`${hook.url}/open-apis/bot/v2/hook/${token}`);
  if (isDefault) await form.getByRole('checkbox', { name: '设为默认渠道' }).check();
  await form.getByRole('button', { name: '保存' }).click();
  await expect(form).toBeHidden();
  await expect(settings.getByRole('listitem', { name, exact: true })).toBeVisible();
}

/** 设置 → 提醒与通知 → 添加渠道 → 邮件, pointing at the fake SMTP (no TLS). */
async function addEmailChannel(page: Page, settings: Locator, name: string, to: string, isDefault: boolean) {
  await settings.getByRole('button', { name: '添加渠道' }).click();
  await page.getByRole('menuitem', { name: '邮件' }).click();
  const form = page.getByRole('dialog', { name: '添加邮件渠道' });
  await form.getByLabel('名称').fill(name);
  await form.getByLabel('SMTP 服务器').fill(smtp.host);
  await form.getByLabel('加密方式').selectOption('none');
  await form.getByLabel('端口').fill(String(smtp.port));
  await form.getByLabel('账号').fill('flows@example.com');
  await form.getByLabel('授权码').fill('flows-auth-code');
  await form.getByLabel('收件地址').fill(to);
  if (isDefault) await form.getByRole('checkbox', { name: '设为默认渠道' }).check();
  await form.getByRole('button', { name: '保存' }).click();
  await expect(form).toBeHidden();
  await expect(settings.getByRole('listitem', { name, exact: true })).toBeVisible();
}

/** A second browser for another account, same size as `page`. */
async function otherBrowser(browser: Browser, page: Page) {
  const context = await browser.newContext({
    viewport: page.viewportSize(),
    isMobile: isMobile(page),
    hasTouch: isMobile(page),
    baseURL: new URL(page.url()).origin,
  });
  return { context, page: await context.newPage() };
}

/** Webhook requests that reached this test's own 飞书 robot. */
const hookTexts = (botToken: string) =>
  hook.requests
    .filter((r) => r.path.endsWith(`/${botToken}`))
    .map((r) => ((r.json as { content?: { text?: string } } | undefined)?.content?.text ?? ''));

const mailsTo = (to: string) => smtp.messages.filter((m) => m.to.includes(to)).map((m) => decodeMail(m.raw));

// --- the flows --------------------------------------------------------------

test('1 智能识别「每个工作日上午10点提醒我」→ 飞书收到提醒 → 日历上改到另一天 → 完成后生成下一次', async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  const user = createUser('flow-repeat');
  await logIn(page, user.username, user.password);

  // A default 飞书 channel (用户故事 74、77).
  const botToken = `flow1-${testInfo.project.name}-${randomBytes(4).toString('hex')}`;
  const settings = await openSettings(page);
  await addFeishuChannel(page, settings, '工作群', botToken, true);
  await closeSettings(page);

  // 智能识别 (用户故事 54、45、52): 重复、时间、提醒 are highlighted and taken out of the title.
  await quickAdd(page).fill('每个工作日上午10点提醒我站会');
  for (const name of ['重复“每个工作日”', '时间“上午10点”', '提醒“提醒我”']) await expect(token(page, name)).toBeVisible();
  await quickAdd(page).press('Enter');
  await expect(openTasks(page).getByRole('button', { name: '站会', exact: true })).toBeVisible();
  const [task] = await search(page, '站会');
  expect(task!.repeat?.freq).toBe('workday');
  expect(task!.reminders).toEqual([{ type: 'before', minutes: 0 }]);
  expect(dueOf(task!).time).toBe('10:00');
  // The first instance is on a 工作日 (中国法定节假日 and 调休).
  expect(dueOf(task!).day).toBe(await nextWorkdayAfter(page, addDays(dueOf(task!).day, -1)));

  // 到点: 10:00 cannot be waited for, so the due time is moved to a few seconds from now.
  const dueAt = new Date(Date.now() + 8_000).toISOString();
  await api(page, 'PATCH', `/api/tasks/${task!.id}`, { dates: { allDay: false, dueAt } });
  await expect.poll(() => hookTexts(botToken).length, { timeout: 60_000 }).toBeGreaterThan(0);
  expect(hookTexts(botToken)[0]).toContain('站会');
  // Delivery evidence for the PR (what the fake 飞书 robot received).
  console.log(`[fake 飞书 ${testInfo.project.name}] ${JSON.stringify(hook.requests.find((r) => r.path.endsWith(`/${botToken}`))?.json)}`);
  // The open page shows the 应用内提醒 too (用户故事 82); 稍后提醒 would bring it back, so close it with 完成 later.
  const alert = page.getByRole('region', { name: '提醒' }).getByRole('article', { name: '站会' });
  await expect(alert).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: testInfo.outputPath(`flow1-alert-${testInfo.project.name}.png`) });

  // 日历: move it to tomorrow (drag on desktop; a touch user changes the date in the detail).
  const moveTo = addDays(today(), 1);
  const time = dueOf((await search(page, '站会'))[0]!).time;
  await openModule(page, '日历');
  const calendarTask = main(page).getByRole('button', { name: /站会/ }).first();
  await expect(calendarTask).toBeVisible();
  if (isMobile(page)) {
    await calendarTask.click();
    await detail(page).getByRole('button', { name: /^日期：/ }).click();
    await picker(page).getByRole('button', { name: '明天', exact: true }).click();
    // The 应用内提醒 is still up; it must not cover the sheet's 确定 (fixed in EURO-33).
    await picker(page).getByRole('button', { name: '确定' }).click();
    await backToList(page);
  } else {
    const target = page.getByRole('button', { name: new RegExp(`^${monthDay(moveTo)} .*，新建任务$`) });
    await calendarTask.dragTo(target, { targetPosition: { x: 60, y: 60 } });
  }
  await expect.poll(async () => dueOf((await search(page, '站会'))[0]!)).toEqual({ day: moveTo, time });
  await page.screenshot({ path: testInfo.outputPath(`flow1-calendar-${testInfo.project.name}.png`) });

  // 完成 from the 应用内提醒: this one is done, the next one is on the 工作日 after tomorrow, same time and 提醒 (用户故事 43、81).
  await alert.getByRole('button', { name: '完成「站会」' }).click();
  await expect(alert).toHaveCount(0);
  await expect
    .poll(async () => (await search(page, '站会')).map((t) => t.status).sort())
    .toEqual(['completed', 'open']);
  const next = (await search(page, '站会')).find((t) => t.status === 'open')!;
  expect(dueOf(next)).toEqual({ day: await nextWorkdayAfter(page, moveTo), time });
  expect(next.repeat?.freq).toBe('workday');
  expect(next.reminders).toEqual([{ type: 'before', minutes: 0 }]);
  await openSidebarLink(page, '收件箱');
  await expect(completedTasks(page).getByRole('checkbox', { name: '站会' })).toBeChecked();
  await expect(openTasks(page).getByRole('checkbox', { name: '站会' })).not.toBeChecked();
});

test('2 文件夹、清单和标签 → 看板、时间线、四象限之间切换 → 过滤器和搜索都能找到', async ({ page }, testInfo) => {
  const user = createUser('flow-organize');
  await logIn(page, user.username, user.password);

  await createFolder(page, '工作区');
  await createList(page, '项目A', '工作区');
  // 智能识别 sets the 标签 (created on the fly), 优先级 and date.
  await addTask(page, '准备方案 明天 #客户 !高', '准备方案');
  await addTask(page, '整理纪要 #客户', '整理纪要');
  await addTask(page, '订会议室', '订会议室');
  const sidebar = await openSidebar(page);
  await sidebar.getByRole('button', { name: /^工作区/ }).first().waitFor();
  await expect(sidebar.getByRole('list', { name: '标签', exact: true }).getByRole('link', { name: '客户', exact: true })).toBeVisible();
  if (isMobile(page)) await sidebar.getByRole('button', { name: '关闭侧栏' }).click();

  // 看板 (用户故事 66)
  await page.getByRole('button', { name: '排序和分组' }).click();
  await page.getByRole('menuitemradio', { name: '看板', exact: true }).click();
  const board = page.getByRole('region', { name: '看板' });
  for (const title of ['准备方案', '整理纪要', '订会议室']) await expect(board.getByRole('button', { name: title, exact: true })).toBeVisible();

  // 时间线 (用户故事 68): the dated task is a bar, the others wait in 待安排.
  await page.getByRole('button', { name: '排序和分组' }).click();
  await page.getByRole('menuitemradio', { name: '时间线' }).click();
  await expect(page.getByRole('button', { name: '准备方案，明天' })).toBeVisible();
  await expect(main(page).getByText('整理纪要')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`flow2-timeline-${testInfo.project.name}.png`) });

  // 四象限 (用户故事 72): 高优先级 → 重要且紧急.
  await openModule(page, '四象限');
  await expect(page.getByRole('heading', { level: 1, name: '四象限' })).toBeVisible();
  await expect(page.getByRole('region', { name: '重要且紧急', exact: true }).getByRole('button', { name: '准备方案', exact: true })).toBeVisible();

  // 过滤器 (用户故事 62): 标签 客户 + 高优先级.
  const nav = await sidebarFromAnywhere(page);
  await nav.getByRole('button', { name: '添加过滤器' }).click();
  const dialog = page.getByRole('dialog', { name: '添加过滤器' });
  await dialog.getByLabel('名称').fill('客户要事');
  await dialog.getByRole('group', { name: /^标签/ }).getByRole('checkbox', { name: '客户' }).check();
  await dialog.getByRole('group', { name: /^优先级/ }).getByRole('checkbox', { name: '高优先级' }).check();
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(listTitle(page)).toHaveText('客户要事');
  await expect(main(page).getByRole('button', { name: '准备方案', exact: true })).toBeVisible();
  await expect(main(page).getByRole('button', { name: '整理纪要', exact: true })).toHaveCount(0);

  // 标签 view (用户故事 18) and 全局搜索 (用户故事 63).
  await openTag(page, '客户');
  for (const title of ['准备方案', '整理纪要']) await expect(main(page).getByRole('button', { name: title, exact: true })).toBeVisible();
  await openModule(page, '搜索');
  const box = page.getByRole('searchbox', { name: '搜索任务' });
  await box.fill('方案');
  await box.press('Enter');
  const hit = main(page).getByRole('listitem').filter({ has: page.getByRole('button', { name: '准备方案', exact: true }) });
  await expect(hit).toContainText('项目A');
});

test('3 番茄专注关联任务 → 专注记录和统计页的专注时长更新', async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  const user = createUser('flow-focus');
  await logIn(page, user.username, user.password);
  await addTask(page, '写年终总结 今天', '写年终总结');

  await openModule(page, '番茄专注');
  const pane = page.getByRole('region', { name: '番茄专注' });
  const timer = page.getByRole('timer');
  // 番茄设置: a 1-minute 番茄 so the test can wait for it (用户故事 86).
  await pane.getByRole('button', { name: '专注更多操作' }).click();
  await page.getByRole('menuitem', { name: '番茄设置' }).click();
  const focusSettings = page.getByRole('dialog', { name: '番茄设置' });
  await focusSettings.getByLabel('专注时长（分钟）').fill('1');
  await focusSettings.getByRole('button', { name: '保存' }).click();
  await expect(timer).toHaveAccessibleName('未开始，剩余 01:00');

  await pane.getByRole('button', { name: '选择关联任务' }).click();
  await page.getByRole('dialog', { name: '选择任务' }).getByRole('button', { name: '写年终总结' }).click();
  await pane.getByRole('button', { name: '开始' }).click();
  // A reload keeps the running 番茄 (用户故事 90).
  await page.reload();
  await expect(timer).toHaveAccessibleName(/^专注中/);
  await expect(timer).toHaveAccessibleName(/^短休息中/, { timeout: 80_000 });

  const side = page.getByRole('complementary', { name: '专注概览与记录' });
  await expect(side.getByRole('region', { name: '专注记录' }).getByText('写年终总结')).toBeVisible();
  await expect(side.getByRole('list', { name: '任务用时' })).toContainText('写年终总结');
  await pane.getByRole('button', { name: '跳过休息' }).click();

  // 统计 (用户故事 102): 今日番茄 1, 今日专注时长 1 分钟, and in the 专注时长 trend.
  await openModule(page, '统计');
  const overview = page.getByRole('region', { name: '概览' });
  const figure = (label: string) => overview.getByRole('term').filter({ hasText: label }).locator('xpath=following-sibling::dd');
  await expect(figure('今日番茄')).toHaveText('1');
  await expect(figure('今日专注时长')).toHaveText('0h1m');
  await expect(figure('总专注时长')).toHaveText('0h1m');
  await expect(page.getByRole('region', { name: '最近专注时长趋势' }).getByRole('img', { name: /今天 1m$/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`flow3-statistics-${testInfo.project.name}.png`) });
});

test('4 习惯打卡、补打卡和撤销 → 连续天数和统计页的打卡完成率更新', async ({ page }, testInfo) => {
  const user = createUser('flow-habit');
  await logIn(page, user.username, user.password);
  const yesterday = addDays(today(), -1);

  await openModule(page, '习惯打卡');
  await expect(page.getByRole('heading', { level: 1, name: '习惯' })).toBeVisible();
  await page.getByRole('button', { name: '添加习惯' }).click();
  const dialog = page.getByRole('dialog', { name: '添加习惯' });
  await dialog.getByLabel('名称').fill('晨读');
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog).toBeHidden();
  if (isMobile(page)) await page.getByRole('button', { name: '返回' }).click();

  // 打卡 today, 补打卡 yesterday from the 7-day strip (用户故事 96).
  await page.getByRole('button', { name: '打卡：晨读（今天）' }).click();
  await expect(page.getByRole('button', { name: '撤销打卡：晨读（今天）' })).toBeVisible();
  await page.getByRole('list', { name: '最近 7 天' }).getByRole('button', { name: new RegExp(`^${yesterday}`) }).click();
  await page.getByRole('button', { name: `打卡：晨读（${yesterday}）` }).click();
  await expect(page.getByRole('button', { name: `撤销打卡：晨读（${yesterday}）` })).toBeVisible();

  // 连续 2 天 (用户故事 97).
  await page.getByRole('list', { name: '坚持中的习惯' }).getByRole('button', { name: /^晨读/ }).click();
  const habitDetail = page.getByRole('complementary', { name: '习惯详情' });
  await expect(habitDetail.getByText('当前连续').locator('..')).toContainText('2 天');
  if (isMobile(page)) await page.getByRole('button', { name: '返回' }).click();

  // 统计: today's 打卡完成率 is 100% (用户故事 102).
  await openModule(page, '统计');
  const habitTrend = page.getByRole('region', { name: '最近打卡完成率趋势' });
  await expect(habitTrend.getByRole('img', { name: /今天 100%$/ })).toBeVisible();
  await expect(page.getByRole('region', { name: '本周打卡进展' }).getByRole('img', { name: /完成 1\/1/ }).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`flow4-statistics-${testInfo.project.name}.png`) });

  // 撤销 today's 打卡: 统计 follows.
  await openModule(page, '习惯打卡');
  await page.getByRole('list', { name: '最近 7 天' }).getByRole('button', { name: /^今天/ }).click();
  await page.getByRole('button', { name: '撤销打卡：晨读（今天）' }).click();
  await expect(page.getByRole('button', { name: '打卡：晨读（今天）' })).toBeVisible();
  await openModule(page, '统计');
  await expect(habitTrend.getByRole('img', { name: /今天 0%$/ })).toBeVisible();
});

test('5 导出 JSON 备份 → 另一个用户导入 → 数据一致', async ({ page, browser }, testInfo) => {
  const source = createUser('flow-export');
  await logIn(page, source.username, source.password);

  // A bit of everything: 文件夹, 清单, 标签, 任务 with 子任务, 检查项 and 评论, 过滤器, 习惯 with 打卡, 倒数日.
  const folder = await api<{ id: string }>(page, 'POST', '/api/folders', { name: '个人' });
  const list = await api<{ id: string }>(page, 'POST', '/api/lists', { name: '旅行', folderId: folder.id });
  const tag = await api<{ id: string }>(page, 'POST', '/api/tags', { name: '假期' });
  const trip = await api<{ id: string }>(page, 'POST', '/api/tasks', {
    title: '订酒店',
    listId: list.id,
    priority: 'medium',
    tagIds: [tag.id],
    dates: { allDay: true, dueDate: addDays(today(), 3) },
    repeat: { freq: 'yearly' },
  });
  await api(page, 'POST', '/api/tasks', { title: '比价', parentId: trip.id });
  const pack = await api<{ id: string }>(page, 'POST', '/api/tasks', { title: '收拾行李', listId: list.id });
  await api(page, 'PATCH', `/api/tasks/${pack.id}`, { kind: 'checklist' });
  await api(page, 'POST', `/api/tasks/${pack.id}/checklist-items`, { title: '护照' });
  await api(page, 'POST', `/api/tasks/${trip.id}/comments`, { content: '要含早餐' });
  await api(page, 'POST', '/api/filters', { name: '假期要事', rules: { tagIds: [tag.id] } });
  const habit = await api<{ id: string }>(page, 'POST', '/api/habits', { name: '跳绳', startDate: addDays(today(), -3) });
  await api(page, 'PUT', `/api/habits/${habit.id}/checkins/${today()}`, { count: 1 });
  await api(page, 'POST', '/api/countdowns', { name: '出发', date: addDays(today(), 10) });
  await page.reload();

  const openBackup = async (p: Page) => {
    const settings = await openSettings(p);
    await settings.getByRole('tab', { name: '关联与导入' }).click();
    const card = settings.getByRole('group', { name: '备份与还原' });
    await expect(card).toBeVisible();
    return card;
  };
  const card = await openBackup(page);
  const [download] = await Promise.all([page.waitForEvent('download'), card.getByRole('button', { name: '生成备份' }).click()]);
  const file = testInfo.outputPath('flow5-backup.json');
  await download.saveAs(file);

  const target = createUser('flow-import');
  const other = await otherBrowser(browser, page);
  await logIn(other.page, target.username, target.password);
  const otherCard = await openBackup(other.page);
  await otherCard.getByLabel('选择备份文件').setInputFiles(file);
  await expect(otherCard.getByRole('status', { name: '导入状态' })).toContainText('导入完成：');
  await otherCard.getByRole('button', { name: '刷新页面' }).click();
  await openSidebarLink(other.page, '旅行');
  await expect(openTasks(other.page).getByRole('button', { name: '订酒店', exact: true })).toBeVisible();
  await expect(openTasks(other.page).getByRole('button', { name: '收拾行李', exact: true })).toBeVisible();

  // Same data on both sides: every entity type, compared without ids and timestamps.
  const exported = async (p: Page) => {
    const backup = await api<{ entities: Record<string, Record<string, unknown>[]> }>(p, 'GET', '/api/backup/export');
    const label = (r: Record<string, unknown>) => String(r.name ?? r.title ?? r.content ?? r.date ?? r.type ?? '');
    return Object.fromEntries(
      Object.entries(backup.entities)
        .filter(([type]) => type !== 'settings')
        .map(([type, records]) => [type, records.filter((r) => !r.deletedAt).map(label).sort()]),
    );
  };
  const [mine, theirs] = [await exported(page), await exported(other.page)];
  expect(theirs).toEqual(mine);
  expect(mine.task).toEqual(['收拾行李', '比价', '订酒店'].sort());
  const imported = (await search(other.page, '订酒店'))[0]!;
  expect(imported.repeat?.freq).toBe('yearly');
  expect(imported.priority).toBe('medium');
  expect(imported.tagIds).toHaveLength(1);
  await other.context.close();
});

test('6 删除任务 → 回收站还原 → 归档清单 → 不再出现在智能清单里，但仍能搜到', async ({ page }, testInfo) => {
  const user = createUser('flow-archive');
  await logIn(page, user.username, user.password);
  await createList(page, '旧项目');
  await addTask(page, '收尾文档 今天', '收尾文档');

  // 今天 shows it (用户故事 59).
  await openSidebarLink(page, '今天');
  await expect(listTitle(page)).toHaveText('今天');
  await expect(main(page).getByRole('button', { name: '收尾文档', exact: true })).toBeVisible();

  // 删除 → 回收站 → 还原 (用户故事 29、30).
  await taskRow(page, '收尾文档').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '删除' }).click();
  await expect(main(page).getByRole('button', { name: '收尾文档', exact: true })).toHaveCount(0);
  await openSidebarLink(page, '回收站');
  const trash = page.getByRole('list', { name: '回收站里的任务' });
  await expect(trash.getByRole('listitem')).toHaveText([/收尾文档/]);
  await trash.getByRole('button', { name: '回收站操作：收尾文档' }).click();
  await page.getByRole('menuitem', { name: '还原' }).click();
  await expect(page.getByText('回收站是空的')).toBeVisible();
  await openSidebarLink(page, '今天');
  await expect(main(page).getByRole('button', { name: '收尾文档', exact: true })).toBeVisible();

  // 归档 the 清单 (用户故事 16): gone from 今天 and 最近 7 天, still found by 搜索 (用户故事 63).
  const sidebar = await sidebarFromAnywhere(page);
  await sidebar.getByRole('button', { name: '清单操作：旧项目' }).click();
  await page.getByRole('menuitem', { name: '归档' }).click();
  await expect(sidebar.getByRole('list', { name: '清单', exact: true }).getByRole('link', { name: '旧项目' })).toBeHidden();
  expect(await smartList(page, 'today')).not.toContain('收尾文档');
  expect(await smartList(page, 'week')).not.toContain('收尾文档');
  await openSidebarLink(page, '今天');
  await expect(listTitle(page)).toHaveText('今天');
  await expect(main(page).getByRole('button', { name: '收尾文档', exact: true })).toHaveCount(0);
  await openModule(page, '搜索');
  const box = page.getByRole('searchbox', { name: '搜索任务' });
  await box.fill('收尾');
  await box.press('Enter');
  await expect(main(page).getByRole('listitem').filter({ hasText: '收尾文档' })).toContainText('旧项目');
  await page.screenshot({ path: testInfo.outputPath(`flow6-search-${testInfo.project.name}.png`) });
});

test('7 两个通知渠道 → 任务只发到邮件 → 假 SMTP 收到提醒，飞书没收到 → 应用内提醒点完成', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const user = createUser('flow-mail');
  await logIn(page, user.username, user.password);
  const botToken = `flow7-${testInfo.project.name}-${randomBytes(4).toString('hex')}`;
  const to = `flow7-${testInfo.project.name}-${randomBytes(4).toString('hex')}@example.com`;

  // 飞书 is the default channel; 邮件 is not (用户故事 75、77).
  const settings = await openSettings(page);
  await addFeishuChannel(page, settings, '飞书', botToken, true);
  await addEmailChannel(page, settings, '我的邮箱', to, false);
  await closeSettings(page);
  await page.reload();

  // A task with a 准时 提醒 that goes to 我的邮箱 only, set in the date picker (用户故事 78、79).
  await addTask(page, '交房租 明天下午3点', '交房租');
  await openTasks(page).getByRole('button', { name: '交房租', exact: true }).click();
  await detail(page).getByRole('button', { name: /^日期：/ }).click();
  await picker(page).getByRole('button', { name: '提醒：无' }).click();
  await picker(page).getByRole('menuitemcheckbox', { name: '准时' }).click();
  await closeMenu(page);
  await picker(page).getByRole('button', { name: '提醒发送到：默认渠道' }).click();
  await picker(page).getByRole('menuitemcheckbox', { name: '我的邮箱' }).click();
  await expect(picker(page).getByRole('button', { name: '提醒发送到：我的邮箱' })).toBeVisible();
  await closeMenu(page);
  await picker(page).getByRole('button', { name: '确定' }).click();
  await expect(detail(page).getByRole('button', { name: /^日期：明天 15:00，提醒：准时$/ })).toBeVisible();
  await backToList(page);

  // 到点 (moved to a few seconds from now): the mail arrives, the 飞书 robot gets nothing.
  const task = (await search(page, '交房租'))[0]!;
  expect(task.reminderChannelIds).toHaveLength(1);
  await api(page, 'PATCH', `/api/tasks/${task.id}`, { dates: { allDay: false, dueAt: new Date(Date.now() + 8_000).toISOString() } });
  await expect.poll(() => mailsTo(to).length, { timeout: 60_000 }).toBe(1);
  expect(mailsTo(to)[0]!.subject).toBe('提醒：交房租');
  console.log(`[fake SMTP ${testInfo.project.name}] to=${to} ${JSON.stringify(mailsTo(to)[0])}`);
  expect(hookTexts(botToken)).toEqual([]);

  // 应用内提醒 → 完成 (用户故事 82).
  const alert = page.getByRole('region', { name: '提醒' }).getByRole('article', { name: '交房租' });
  await expect(alert).toBeVisible({ timeout: 30_000 });
  await alert.getByRole('button', { name: '完成「交房租」' }).click();
  await expect(completedTasks(page).getByRole('checkbox', { name: '交房租' })).toBeChecked();
  expect((await search(page, '交房租'))[0]!.status).toBe('completed');
});

test('8 子任务、检查项、评论和附件 → 搜索能按评论找到 → 完成父任务也完成子任务 → 已完成里能看到', async ({ page }, testInfo) => {
  const user = createUser('flow-detail');
  await logIn(page, user.username, user.password);
  await addTask(page, '筹备年会', '筹备年会');
  await openTasks(page).getByRole('button', { name: '筹备年会', exact: true }).click();
  await expect(detail(page).getByRole('textbox', { name: '任务标题' })).toHaveValue('筹备年会');

  // 子任务 (用户故事 35)
  const subtaskInput = detail(page).getByRole('textbox', { name: '添加子任务' });
  await subtaskInput.fill('订场地');
  await subtaskInput.press('Enter');
  await expect(detail(page).getByRole('list', { name: '子任务列表' }).getByRole('button', { name: '订场地', exact: true })).toBeVisible();

  // 评论 (用户故事 39)
  await detail(page).getByRole('button', { name: '评论', exact: true }).click();
  const composer = detail(page).getByRole('textbox', { name: '写评论' });
  await composer.fill('已联系供应商');
  await composer.press('Enter');
  await expect(detail(page).getByRole('list', { name: '评论列表' }).getByRole('listitem')).toHaveCount(1);

  // 附件 (用户故事 38)
  await detail(page).getByLabel('选择要上传的附件').setInputFiles({ name: '预算.txt', mimeType: 'text/plain', buffer: Buffer.from('场地 3000\n') });
  await expect(detail(page).getByRole('list', { name: '附件列表' })).toContainText('预算.txt');
  await backToList(page);

  // 检查清单 on another task (用户故事 37)
  await addTask(page, '采购清单', '采购清单');
  const shopping = (await search(page, '采购清单'))[0]!;
  await api(page, 'PATCH', `/api/tasks/${shopping.id}`, { kind: 'checklist' });
  await api(page, 'POST', `/api/tasks/${shopping.id}/checklist-items`, { title: '供应商名片' });

  // 搜索 by a 评论 and by a 检查项 (用户故事 63).
  await openModule(page, '搜索');
  const box = page.getByRole('searchbox', { name: '搜索任务' });
  await box.fill('供应商');
  await box.press('Enter');
  await expect(taskRow(page, '筹备年会')).toContainText('匹配评论');
  await expect(taskRow(page, '采购清单')).toContainText('匹配检查项');
  await page.screenshot({ path: testInfo.outputPath(`flow8-search-${testInfo.project.name}.png`) });

  // 完成 the parent from the 收件箱: its 子任务 is completed too; both are under 已完成 (用户故事 27、40).
  await openSidebarLink(page, '收件箱');
  await openTasks(page).getByRole('checkbox', { name: '筹备年会' }).click();
  await expect.poll(async () => (await search(page, '订场地'))[0]!.status).toBe('completed');
  await openSidebarLink(page, '已完成');
  await expect(listTitle(page)).toHaveText('已完成');
  for (const title of ['筹备年会', '订场地']) await expect(main(page).getByText(title, { exact: true }).first()).toBeVisible();
});

test('9 管理员添加用户 → 新用户导入滴答 CSV → 在日历和清单里看到 → 其他用户看不到', async ({ page, browser }, testInfo) => {
  const admin = { username: `flow-admin-${randomBytes(4).toString('hex')}`, password: `pw-${randomBytes(6).toString('hex')}` };
  dida(['create-user', admin.username, '--admin'], `${admin.password}\n`);
  await logIn(page, admin.username, admin.password);

  // 用户管理 → 添加用户 (用户故事 9)
  const dialog = await openAccount(page, admin.username);
  await dialog.getByRole('tab', { name: '用户管理' }).click();
  const panel = dialog.getByRole('tabpanel');
  const name = `flow-new-${randomBytes(3).toString('hex')}`;
  await panel.getByRole('button', { name: '+ 添加用户' }).click();
  const add = page.getByRole('dialog', { name: '添加用户' });
  await add.getByLabel('账号').fill(name);
  await add.getByLabel('初始密码').fill('first-password');
  await add.getByLabel('确认密码').fill('first-password');
  await add.getByRole('button', { name: '添加' }).click();
  await expect(panel.getByRole('status')).toHaveText(`已添加用户 ${name}`);
  await closeSettings(page);

  // The new user moves in with a 滴答清单 CSV (用户故事 113).
  const other = await otherBrowser(browser, page);
  await logIn(other.page, name, 'first-password');
  const settings = await openSettings(other.page);
  await settings.getByRole('tab', { name: '关联与导入' }).click();
  const card = settings.getByRole('group', { name: '备份与还原' });
  const mock = await readFile(new URL('../packages/server/test/fixtures/ticktick-backup.mock.csv', import.meta.url));
  await card.getByLabel('选择滴答清单备份文件').setInputFiles({ name: 'TickTick-backup.csv', mimeType: 'text/csv', buffer: mock });
  await expect(card.getByRole('status', { name: '导入状态' })).toContainText('导入完成：');
  await card.getByRole('button', { name: '刷新页面' }).click();
  await expect(other.page.getByText('示例任务：买牛奶')).toBeVisible();
  const imported = await search(other.page, '示例任务');
  expect(imported.length).toBeGreaterThan(1);
  const dated = imported.find((t) => t.dates && t.status === 'open');
  expect(dated, 'the mock CSV has an open task with a date').toBeTruthy();
  const calendarRange = `from=${addDays(dueOf(dated!).day, -1)}&to=${addDays(dueOf(dated!).day, 1)}`;
  expect((await api<{ tasks: ApiTask[] }>(other.page, 'GET', `/api/tasks?${calendarRange}`)).tasks.map((t) => t.id)).toContain(dated!.id);
  await other.page.screenshot({ path: testInfo.outputPath(`flow9-imported-${testInfo.project.name}.png`) });

  // 数据隔离 (用户故事 11): the 管理员 sees none of it, and the API answers 404.
  expect(await search(page, '示例任务')).toEqual([]);
  expect((await page.request.get(`/api/tasks/${dated!.id}`)).status()).toBe(404);
  expect((await page.request.patch(`/api/tasks/${dated!.id}`, { data: { title: '改掉' } })).status()).toBe(404);
  await page.reload();
  await expect(page.getByText('示例任务：买牛奶')).toHaveCount(0);
  await other.context.close();
});

test('10 多选批量改优先级和打标签 → 四象限和标签视图跟着变 → 智能清单看板按优先级分栏', async ({ page }, testInfo) => {
  const user = createUser('flow-batch');
  await logIn(page, user.username, user.password);
  await api(page, 'POST', '/api/tags', { name: '本周' });
  await page.reload();
  for (const title of ['写周报', '回邮件', '交报销']) await addTask(page, `${title} 今天`, title);
  const titleButton = (title: string) => openTasks(page).getByRole('button', { name: title, exact: true });

  // 多选 (用户故事 34): Ctrl + click; the 批量操作 panel (desktop) or toolbar (390px).
  await titleButton('写周报').click({ modifiers: ['Control'] });
  await titleButton('回邮件').click({ modifiers: ['Control'] });
  const batch = isMobile(page) ? page.getByRole('toolbar', { name: /^批量操作/ }) : page.getByRole('complementary', { name: /已选择/ });
  await expect(batch).toBeVisible();
  await batch.getByRole('button', { name: '优先级', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '高优先级', exact: true }).click();
  await batch.getByRole('button', { name: '标签', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: '本周', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect
    .poll(async () => (await smartList(page, 'today')).length)
    .toBe(3);
  await expect
    .poll(async () => (await api<{ tasks: ApiTask[] }>(page, 'GET', '/api/tasks?smart=today')).tasks.filter((t) => t.priority === 'high' && t.tagIds.length === 1).map((t) => t.title).sort())
    .toEqual(['写周报', '回邮件'].sort());
  await page.reload();

  // 四象限 (用户故事 72)
  await openModule(page, '四象限');
  const urgent = page.getByRole('region', { name: '重要且紧急', exact: true });
  for (const title of ['写周报', '回邮件']) await expect(urgent.getByRole('button', { name: title, exact: true })).toBeVisible();
  await expect(urgent.getByRole('button', { name: '交报销', exact: true })).toHaveCount(0);

  // 标签 view (用户故事 18)
  await openTag(page, '本周');
  await expect(main(page).getByRole('button', { name: '交报销', exact: true })).toHaveCount(0);
  for (const title of ['写周报', '回邮件']) await expect(main(page).getByRole('button', { name: title, exact: true })).toBeVisible();

  // 今天 as a 看板 (用户故事 67): columns by 优先级 come from the tasks.
  await openSidebarLink(page, '今天');
  await page.getByRole('button', { name: '排序和分组' }).click();
  await page.getByRole('menuitemradio', { name: '看板', exact: true }).click();
  const board = page.getByRole('region', { name: '看板' });
  await expect(board).toBeVisible();
  for (const title of ['写周报', '回邮件', '交报销']) await expect(board.getByRole('button', { name: title, exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`flow10-kanban-${testInfo.project.name}.png`) });
});
