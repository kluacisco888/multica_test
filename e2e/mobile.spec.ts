import { expect, test, type Locator, type Page } from '@playwright/test';
import { createUser, isMobile, logIn, openSidebar } from './support.js';

/*
 * 移动端布局与 PWA (EURO-29, spec 用户故事 107–109).
 * Bottom navigation and swipe gestures run at 390px (the mobile project);
 * the PWA checks run once, on desktop Chrome, where DevTools reports
 * installability.
 */

const quickAdd = (page: Page) => page.getByRole('textbox', { name: '添加任务' });
const openTasks = (page: Page) => page.getByRole('list', { name: '任务', exact: true });
const completedTasks = (page: Page) => page.getByRole('list', { name: '已完成的任务' });
const bottomNav = (page: Page) => page.getByRole('navigation', { name: '底部导航' });

async function addTasks(page: Page, ...titles: string[]) {
  for (const title of titles) {
    await quickAdd(page).fill(title);
    await quickAdd(page).press('Enter');
    await expect(openTasks(page).getByRole('button', { name: title, exact: true })).toBeVisible();
  }
}

/** The row of a root 任务 (the element the swipe gestures are on). */
function taskRow(list: Locator, title: string): Locator {
  return list.locator('.task-row').filter({ has: list.page().getByRole('button', { name: title, exact: true }) });
}

/**
 * A real touch swipe (touchstart → touchmove × n → touchend) through the
 * DevTools protocol, starting at `fromX` (fraction of the row width).
 */
async function swipe(page: Page, row: Locator, dx: number, fromX: number) {
  const box = await row.boundingBox();
  if (!box) throw new Error('row not visible');
  const x = box.x + box.width * fromX;
  const y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (dx * i) / steps, y }] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

/** Nothing on the page is wider than the 390px screen (no sideways scrolling of the page). */
async function expectNoHorizontalOverflow(page: Page, name: string) {
  const screen = page.viewportSize()?.width ?? 0;
  const { width, culprits } = await page.evaluate((screen) => {
    // Content inside a scroll container (e.g. the swipeable 四象限 grid) does not widen the page.
    const scrolls = (el: Element) => getComputedStyle(el).overflowX !== 'visible';
    const contained = (el: Element) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (scrolls(p)) return true;
      return false;
    };
    return {
      width: document.documentElement.scrollWidth,
      culprits: [...document.querySelectorAll('body *')]
        .filter((el) => el.getBoundingClientRect().right > screen + 1 && !contained(el))
        .slice(0, 5)
        .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')} → ${Math.round(el.getBoundingClientRect().right)}`),
    };
  }, screen);
  expect(width, `${name}: ${culprits.join(', ')}`).toBeLessThanOrEqual(screen);
}

test.describe('移动布局', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 1440) >= 768, '390px only');

  test('底部导航: 任务、日历、专注、习惯、更多 switch modules; 更多 holds the rest', async ({ page }) => {
    const user = createUser('mobile-nav');
    await logIn(page, user.username, user.password);

    const nav = bottomNav(page);
    await expect(nav).toBeVisible();
    await expect(nav.getByRole('link')).toHaveText(['任务', '日历', '专注', '习惯']);
    await expect(nav.getByRole('button', { name: '更多' })).toBeVisible();
    await expect(nav.getByRole('link', { name: '任务' })).toHaveAttribute('aria-current', 'page');

    // The bar sits at the bottom of the screen, full width.
    const box = await nav.boundingBox();
    expect(box?.width).toBe(390);
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBe(844);

    await nav.getByRole('link', { name: '日历' }).click();
    await expect(page).toHaveURL(/\/calendar/);
    await expect(nav.getByRole('link', { name: '日历' })).toHaveAttribute('aria-current', 'page');

    await nav.getByRole('link', { name: '专注' }).click();
    await expect(page).toHaveURL(/\/focus$/);
    await expect(page.getByRole('heading', { level: 1, name: /番茄专注/ })).toBeVisible();

    await nav.getByRole('link', { name: '习惯' }).click();
    await expect(page).toHaveURL(/\/habits$/);
    await expect(page.getByRole('heading', { level: 1, name: '习惯' })).toBeVisible();

    // 更多: 四象限、倒数日、搜索、设置 in a sheet; Esc closes it.
    await nav.getByRole('button', { name: '更多' }).click();
    const more = page.getByRole('dialog', { name: '更多' });
    await expect(more).toBeVisible();
    await expect(more.getByRole('list').getByRole('button')).toHaveText(['四象限', '倒数日', '搜索', '设置']);
    await page.keyboard.press('Escape');
    await expect(more).toBeHidden();

    await nav.getByRole('button', { name: '更多' }).click();
    await more.getByRole('button', { name: '四象限' }).click();
    await expect(more).toBeHidden();
    await expect(page).toHaveURL(/\/matrix$/);
    await expect(nav.getByRole('button', { name: '更多' })).toHaveAttribute('aria-current', 'page');

    await nav.getByRole('button', { name: '更多' }).click();
    await more.getByRole('button', { name: '设置' }).click();
    await expect(page.getByRole('dialog', { name: '设置' })).toBeVisible();
    await page.keyboard.press('Escape');

    await nav.getByRole('link', { name: '任务' }).click();
    await expect(page).toHaveURL(/\/$/);

    // The sidebar is a drawer over the bar; a task page hides the bar.
    await openSidebar(page);
    await page.getByRole('button', { name: '关闭侧栏' }).click();
    await addTasks(page, '打开一个任务');
    await page.getByRole('button', { name: '打开一个任务', exact: true }).click();
    await expect(page.getByRole('complementary', { name: '任务详情' })).toBeVisible();
    await expect(nav).toBeHidden();
    await page.getByRole('button', { name: '返回列表' }).click();
    await expect(nav).toBeVisible();
  });

  test('右滑完成任务、左滑删除任务 (touch)', async ({ page }) => {
    const user = createUser('mobile-swipe');
    await logIn(page, user.username, user.password);
    await addTasks(page, '左滑删掉我', '右滑完成我', '轻轻一碰');

    // Right swipe: 完成.
    await swipe(page, taskRow(openTasks(page), '右滑完成我'), 200, 0.3);
    await expect(openTasks(page).getByRole('button', { name: '右滑完成我', exact: true })).toBeHidden();
    await expect(completedTasks(page).getByRole('button', { name: '右滑完成我', exact: true })).toBeVisible();

    // Right swipe on a completed task: 取消完成.
    await swipe(page, taskRow(completedTasks(page), '右滑完成我'), 200, 0.3);
    await expect(openTasks(page).getByRole('button', { name: '右滑完成我', exact: true })).toBeVisible();

    // A short swipe does nothing and the row springs back.
    const short = taskRow(openTasks(page), '轻轻一碰');
    await swipe(page, short, -40, 0.7);
    await expect(short).toBeVisible();
    await expect(short).toHaveCSS('transform', 'none');
    await expect(page.getByRole('complementary', { name: '任务详情' })).toBeHidden();

    // Left swipe: 删除 (into the 回收站).
    await swipe(page, taskRow(openTasks(page), '左滑删掉我'), -220, 0.8);
    await expect(openTasks(page).getByRole('button', { name: '左滑删掉我', exact: true })).toBeHidden();
    await expect(openTasks(page).getByRole('button')).toHaveText(['轻轻一碰', '右滑完成我']);
    await page.goto('/trash');
    await expect(page.getByText('左滑删掉我')).toBeVisible();
  });

  test('手势和鼠标拖拽排序互不干扰; vertical touch moves and taps are not swipes (review)', async ({ page }) => {
    const user = createUser('mobile-swipe-drag');
    await logIn(page, user.username, user.password);
    // New tasks land on top: shown 丙, 乙, 甲.
    await addTasks(page, '甲', '乙', '丙');
    const titles = () => openTasks(page).locator('.task-row-title').allInnerTexts();
    await expect.poll(titles).toEqual(['丙', '乙', '甲']);

    // Mouse drag (拖拽排序) on a 390px screen: reorders, does not complete or delete.
    await taskRow(openTasks(page), '甲').dragTo(taskRow(openTasks(page), '丙'), { targetPosition: { x: 80, y: 4 } });
    await expect.poll(titles).toEqual(['甲', '丙', '乙']);
    await expect(completedTasks(page)).toHaveCount(0);
    await page.reload();
    await expect.poll(titles).toEqual(['甲', '丙', '乙']);

    // A mouse press-and-drag sideways is not a swipe.
    const box = await taskRow(openTasks(page), '乙').boundingBox();
    if (!box) throw new Error('row not visible');
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2, { steps: 10 });
    await page.mouse.up();
    await expect.poll(titles).toEqual(['甲', '丙', '乙']);
    await expect(completedTasks(page)).toHaveCount(0);

    // A touch swipe does not reorder: 右滑 on 丙 completes it, the rest keep their order.
    await swipe(page, taskRow(openTasks(page), '丙'), 200, 0.3);
    await expect.poll(titles).toEqual(['甲', '乙']);
    await expect(completedTasks(page).getByRole('button', { name: '丙', exact: true })).toBeVisible();

    // A mostly vertical touch move is a scroll, not a swipe.
    const r = await taskRow(openTasks(page), '乙').boundingBox();
    if (!r) throw new Error('row not visible');
    const cdp = await page.context().newCDPSession(page);
    const x = r.x + r.width * 0.3;
    const y = r.y + r.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= 12; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + i * 12, y: y + i * 20 }] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
    await expect.poll(titles).toEqual(['甲', '乙']);
    await expect(taskRow(openTasks(page), '乙')).toHaveCSS('transform', 'none');

    // After a short (sprung back) swipe, the next tap still opens the task.
    await swipe(page, taskRow(openTasks(page), '甲'), 40, 0.3);
    await page.getByRole('button', { name: '甲', exact: true }).tap();
    await expect(page.getByRole('complementary', { name: '任务详情' })).toBeVisible();
  });

  test('390px: every main page fits the screen (screenshots for the PR)', async ({ page }, testInfo) => {
    const user = createUser('mobile-pages');
    const shot = async (name: string) => {
      await expectNoHorizontalOverflow(page, name);
      await page.screenshot({ path: testInfo.outputPath(`mobile-${name}.png`) });
    };

    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: '登录' })).toBeVisible();
    await shot('01-login');

    await logIn(page, user.username, user.password);
    await addTasks(page, '跑量化报表', '问一下续费', '周报');
    await page.getByRole('button', { name: '周报', exact: true }).click();
    await page.getByRole('complementary', { name: '任务详情' }).getByRole('textbox', { name: '描述' }).fill('- 本周进展\n- 下周计划');
    await page.getByRole('complementary', { name: '任务详情' }).getByRole('textbox', { name: '描述' }).blur();
    await shot('03-task-detail');
    await page.getByRole('button', { name: '返回列表' }).click();
    await expect(bottomNav(page)).toBeVisible();
    await shot('02-inbox');

    await openSidebar(page);
    await shot('04-drawer');
    await page.getByRole('button', { name: '关闭侧栏' }).click();

    const pages: [string, string, RegExp | string][] = [
      ['05-today', '/smart/today', '今天'],
      ['06-calendar-month', '/calendar/month/2026-10-14', /2026/],
      ['07-calendar-day', '/calendar/day/2026-10-14', /10月/],
      ['08-matrix', '/matrix', '四象限'],
      ['09-focus', '/focus', /番茄专注/],
      ['10-habits', '/habits', '习惯'],
      ['11-countdowns', '/countdowns', /倒数纪念日/],
      ['12-trash', '/trash', '回收站'],
    ];
    for (const [name, path, heading] of pages) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: heading }).first()).toBeVisible();
      await expect(page.locator('main[aria-busy="true"]')).toHaveCount(0);
      await shot(name);
    }

    await page.goto('/search');
    await page.getByRole('searchbox', { name: '搜索任务' }).fill('周报');
    await page.getByRole('searchbox', { name: '搜索任务' }).press('Enter');
    await expect(openTasks(page).getByRole('button', { name: '周报', exact: true })).toBeVisible();
    await shot('13-search');

    await bottomNav(page).getByRole('button', { name: '更多' }).click();
    await expect(page.getByRole('dialog', { name: '更多' })).toBeVisible();
    await shot('14-more');
    await page.getByRole('dialog', { name: '更多' }).getByRole('button', { name: '设置' }).click();
    await expect(page.getByRole('dialog', { name: '设置' })).toBeVisible();
    await shot('15-settings');
  });
});

test.describe('PWA', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 1440) < 768, 'once, on desktop Chrome');

  test('Chrome reports the app as installable: manifest, icons, no installability errors', async ({ page, request }, testInfo) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: '登录' })).toBeVisible();
    expect(isMobile(page)).toBe(false);

    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(manifestHref).toBe('/manifest.webmanifest');
    const response = await request.get('/manifest.webmanifest');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toMatch(/application\/manifest\+json/);
    const manifest = (await response.json()) as {
      name: string;
      short_name: string;
      start_url: string;
      display: string;
      icons: { src: string; sizes: string; type: string; purpose?: string }[];
    };
    expect(manifest).toMatchObject({ name: '叮叮清单', short_name: '叮叮清单', start_url: '/', display: 'standalone' });
    for (const size of ['192x192', '512x512']) {
      const icon = manifest.icons.find((i) => i.sizes === size && (i.purpose ?? 'any').includes('any'));
      expect(icon, `${size} icon`).toBeTruthy();
      const png = await request.get(icon?.src ?? '');
      expect(png.status()).toBe(200);
      expect(png.headers()['content-type']).toBe('image/png');
      const bytes = await png.body();
      // PNG IHDR: width and height at byte 16 / 20.
      expect(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`).toBe(size);
    }
    expect(manifest.icons.some((i) => i.purpose?.includes('maskable'))).toBe(true);

    // iOS 添加到主屏幕 uses the apple-touch-icon.
    const appleIcon = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href');
    expect((await request.get(appleIcon ?? '')).status()).toBe(200);

    // What DevTools → Application → Manifest shows: no installability errors.
    const cdp = await page.context().newCDPSession(page);
    const { errors, url } = await cdp.send('Page.getAppManifest');
    expect(errors).toEqual([]);
    expect(url).toMatch(/\/manifest\.webmanifest$/);
    const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
    expect(installabilityErrors).toEqual([]);
    await testInfo.attach('installability.json', {
      body: JSON.stringify({ manifestUrl: url, manifestErrors: errors, installabilityErrors }, null, 2),
      contentType: 'application/json',
    });
  });
});
