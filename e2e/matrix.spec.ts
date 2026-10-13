import { expect, test, type Page } from '@playwright/test';
import { createUser, isMobile, logIn, openSidebar } from './support.js';

/*
 * 四象限 (EURO-23, spec 用户故事 72、73). Runs at 1440px and 390px
 * (playwright.config.ts projects): the default quadrants by 优先级, a task
 * moved to another quadrant (dragging on desktop, the row menu's 移动到象限 on
 * mobile) takes that quadrant's 优先级, and an edited quadrant rule is still
 * there after a reload.
 */

const quadrant = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const row = (page: Page, quadrantName: string, title: string) =>
  quadrant(page, quadrantName).locator('li.matrix-row').filter({ has: page.getByRole('button', { name: title, exact: true }) });

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

async function openMatrix(page: Page) {
  if (isMobile(page)) {
    const sidebar = await openSidebar(page);
    await sidebar.getByRole('button', { name: '四象限' }).click();
  } else {
    await page.getByRole('navigation', { name: '模块' }).getByRole('link', { name: '四象限' }).click();
  }
  await expect(page.getByRole('heading', { level: 1, name: '四象限' })).toBeVisible();
}

/** Move a task to another quadrant: drag on desktop, the row menu (Shift+F10 → 移动到象限) on mobile. */
async function moveTask(page: Page, title: string, from: string, to: string) {
  if (isMobile(page)) {
    const titleButton = quadrant(page, from).getByRole('button', { name: title, exact: true });
    await titleButton.scrollIntoViewIfNeeded();
    await page.evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await titleButton.focus();
    await page.keyboard.press('Shift+F10');
    await page.getByRole('group', { name: '移动到象限' }).getByRole('menuitemradio', { name: to }).click();
  } else {
    await row(page, from, title).dragTo(quadrant(page, to));
  }
}

test('四象限: default quadrants by 优先级, moving a task changes its 优先级, edited rules survive a reload', async ({ page }, testInfo) => {
  const { username, password } = createUser('matrix');
  await logIn(page, username, password);
  const work = await post(page, '/api/lists', { name: '工作' });
  for (const [title, priority, days, listId] of [
    ['季度复盘', 'high', -1, work.id],
    ['回复客户邮件', 'high', 0, null],
    ['准备分享', 'medium', 3, work.id],
    ['整理书架', 'low', 1, null],
    ['看一部电影', 'none', null, null],
    ['订机票', 'none', 10, null],
  ] as const) {
    await post(page, '/api/tasks', { title, priority, ...(days === null ? {} : { dates: dueOn(days) }), ...(listId ? { listId } : {}) });
  }
  await page.reload();
  await openMatrix(page);

  // Default rules: 高 / 中 / 低 / 无优先级.
  await expect(row(page, '重要且紧急', '季度复盘')).toBeVisible();
  await expect(row(page, '重要且紧急', '回复客户邮件')).toBeVisible();
  await expect(row(page, '重要不紧急', '准备分享')).toBeVisible();
  await expect(row(page, '不重要但紧急', '整理书架')).toBeVisible();
  await expect(row(page, '不重要不紧急', '看一部电影')).toBeVisible();
  await expect(quadrant(page, '重要且紧急').getByRole('button', { name: /已过期/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`matrix-${testInfo.project.name}.png`) });

  // Moving a task to quadrant 一 makes it 高优先级.
  const saved = page.waitForResponse((r) => r.url().includes('/api/tasks/') && r.request().method() === 'PATCH');
  await moveTask(page, '看一部电影', '不重要不紧急', '重要且紧急');
  expect((await (await saved).json()).priority).toBe('high');
  await expect(row(page, '重要且紧急', '看一部电影')).toBeVisible();
  await expect(row(page, '不重要不紧急', '看一部电影')).toHaveCount(0);

  // Edit quadrant 二: only tasks of 清单「工作」, renamed.
  await quadrant(page, '重要不紧急').hover();
  await page.getByRole('button', { name: '象限「重要不紧急」更多操作' }).click();
  await page.getByRole('menuitem', { name: '编辑象限' }).click();
  const dialog = page.getByRole('dialog', { name: '编辑象限' });
  await dialog.getByLabel('名称').fill('工作计划');
  await dialog.getByRole('group', { name: /清单/ }).getByLabel('工作').check();
  await dialog.getByRole('group', { name: /优先级/ }).getByLabel('中优先级').uncheck();
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog).toBeHidden();
  await expect(row(page, '工作计划', '准备分享')).toBeVisible();
  // 季度复盘 is in 工作 but quadrant 一 comes first.
  await expect(row(page, '重要且紧急', '季度复盘')).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: '四象限' })).toBeVisible();
  await expect(quadrant(page, '工作计划')).toBeVisible();
  await expect(row(page, '工作计划', '准备分享')).toBeVisible();
  await expect(row(page, '重要且紧急', '看一部电影')).toBeVisible();

  // Opening a task shows its detail.
  await quadrant(page, '重要且紧急').getByRole('button', { name: '回复客户邮件', exact: true }).click();
  await expect(page).toHaveURL(/\/matrix\/tasks\//);
});
