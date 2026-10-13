/// <reference lib="dom" />
// page.evaluate callbacks below run in the browser.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { createUser, isMobile, logIn, openSidebar } from './support.js';

/*
 * 主题 (EURO-21, spec 用户故事 104): 浅色 / 深色 / 跟随系统 and the 颜色系列 in
 * 设置 → 外观. "No hard-coded colours" is checked two ways: the sources hold
 * no raw colours outside design/tokens.css, and every element on the
 * existing screens really changes colour between 浅色 and 深色.
 */

const COLORS = ['晴蓝', '松石', '秘青', '蒹葭', '杏黄', '桃夭', '暮山紫', '沉香'] as const;
const COLOR_IDS: Record<(typeof COLORS)[number], string> = {
  晴蓝: 'blue',
  松石: 'turquoise',
  秘青: 'cyan',
  蒹葭: 'reed',
  杏黄: 'apricot',
  桃夭: 'peach',
  暮山紫: 'lavender',
  沉香: 'agarwood',
};

const quickAdd = (page: Page) => page.getByRole('textbox', { name: '添加任务' });
const html = (page: Page) => page.locator('html');

async function openSettings(page: Page) {
  if (isMobile(page)) await openSidebar(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置' });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openAppearance(page: Page) {
  const dialog = await openSettings(page);
  await dialog.getByRole('tab', { name: '外观' }).click();
  await expect(dialog.getByRole('heading', { name: '外观' })).toBeVisible();
  return dialog;
}

async function addTask(page: Page, title: string) {
  await quickAdd(page).fill(title);
  await quickAdd(page).press('Enter');
  await expect(page.getByRole('list', { name: '任务', exact: true }).getByRole('button', { name: title, exact: true })).toBeVisible();
}

/** Relative luminance (0 black … 1 white) of a computed `rgb()` / `color(srgb …)` colour; null when transparent. */
function luminanceOf(css: string): number | null {
  const nums = css.match(/[\d.]+/g)?.map(Number) ?? [];
  if (nums.length < 3) return null;
  const srgb = css.startsWith('color(');
  const [r, g, b] = nums.slice(0, 3).map((v) => (srgb ? v : v / 255)) as [number, number, number];
  const alpha = nums.length > 3 ? (nums[3] as number) : 1;
  if (alpha < 0.5) return null;
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/**
 * Elements on screen that still look 浅色 in 深色: a light background, or
 * dark text. User colours (清单 / 标签 dots) and the theme previews are
 * exempt — they are meant to look the same in every theme.
 */
async function lightLeftovers(page: Page): Promise<string[]> {
  const samples = await page.evaluate(() => {
    const exempt = '[data-swatch], .swatch, .theme-mode-preview, .sidebar-color-dot, .list-color, [style*="--tag-color"], [style*="--list-color"]';
    const out: { where: string; bg: string; color: string; hasText: boolean }[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      if (el.closest(exempt) || el.closest('svg')) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
      const hasText = Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());
      const label = `${el.tagName.toLowerCase()}.${String(el.className).split(' ').filter(Boolean).join('.')}`;
      out.push({ where: `${label} "${(el.textContent ?? '').trim().slice(0, 20)}"`, bg: style.backgroundColor, color: style.color, hasText });
    }
    return out;
  });
  const problems: string[] = [];
  for (const s of samples) {
    const bg = luminanceOf(s.bg);
    if (bg !== null && bg > 0.4) problems.push(`light background ${s.bg}: ${s.where}`);
    const fg = luminanceOf(s.color);
    if (s.hasText && fg !== null && fg < 0.1) problems.push(`dark text ${s.color}: ${s.where}`);
  }
  return problems;
}

test('web sources have no raw colours outside the design tokens', () => {
  test.skip(test.info().project.name !== 'desktop', 'a source check: once is enough');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../packages/web/src');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(css|tsx?)$/.test(name)) files.push(full);
    }
  };
  walk(root);
  const raw = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(|\b(?:white|black)\b(?![-\w])/;
  const offenders: string[] = [];
  for (const file of files) {
    const rel = path.relative(root, file);
    if (rel === path.join('design', 'tokens.css')) continue;
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const code = line.replace(/\/\*.*?\*\/|\/\/.*$|^\s*\*.*$/g, '');
        if (!raw.test(code)) return;
        // 清单 / 标签 colours are user data (the colour picker's options), not theme colours.
        if (rel === path.join('app', 'dialogs.tsx') && /^\s*'#[0-9a-f]{6}': '/.test(code)) return;
        offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
  }
  expect(offenders).toEqual([]);
});

test('外观: 深色 changes every screen, survives a reload, and 浅色 brings it back', async ({ page }, testInfo) => {
  const user = createUser('theme-dark');
  await logIn(page, user.username, user.password);
  await addTask(page, '写周报');
  await expect(html(page)).toHaveAttribute('data-theme', 'light');
  await expect(html(page)).toHaveAttribute('data-theme-color', 'blue');

  const dialog = await openAppearance(page);
  await expect(dialog.getByRole('radio', { name: '浅色' })).toBeChecked();
  await expect(dialog.getByRole('radio', { name: '晴蓝' })).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath(`theme-settings-light-${testInfo.project.name}.png`) });

  await dialog.getByRole('radio', { name: '深色' }).check();
  await expect(html(page)).toHaveAttribute('data-theme', 'dark');
  await expect(dialog.getByRole('radio', { name: '深色' })).toBeChecked();
  // The open 设置 dialog itself is dark.
  expect(await lightLeftovers(page)).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath(`theme-settings-dark-${testInfo.project.name}.png`) });
  await dialog.getByRole('button', { name: '关闭' }).click();

  // Saved on the server: a reload with an empty cache is still dark.
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: '收件箱' })).toBeVisible();
  await expect(html(page)).toHaveAttribute('data-theme', 'dark');

  // Every existing screen: the list with a task open in the detail, 今天, 搜索, 回收站 and a dialog.
  await page.getByRole('list', { name: '任务', exact: true }).getByRole('button', { name: '写周报' }).click();
  await expect(page.getByRole('textbox', { name: '任务标题' })).toBeVisible();
  expect(await lightLeftovers(page)).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath(`theme-dark-${testInfo.project.name}.png`) });
  if (isMobile(page)) await page.getByRole('button', { name: '返回列表' }).click();

  const sidebar = await openSidebar(page);
  await sidebar.getByRole('list', { name: '智能清单' }).getByRole('link', { name: /^今天/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: '今天' })).toBeVisible();
  expect(await lightLeftovers(page)).toEqual([]);

  const sidebar2 = await openSidebar(page);
  await sidebar2.getByRole('link', { name: '回收站' }).click();
  await expect(page.getByRole('heading', { level: 1, name: '回收站' })).toBeVisible();
  expect(await lightLeftovers(page)).toEqual([]);

  await page.keyboard.press('Control+k');
  await expect(page.getByRole('searchbox', { name: '搜索任务' })).toBeFocused();
  expect(await lightLeftovers(page)).toEqual([]);

  const sidebar3 = await openSidebar(page);
  await sidebar3.getByRole('button', { name: '添加清单' }).click();
  await expect(page.getByRole('dialog', { name: '添加清单' })).toBeVisible();
  expect(await lightLeftovers(page)).toEqual([]);
  await page.keyboard.press('Escape');

  // Back to 浅色.
  const again = await openAppearance(page);
  await again.getByRole('radio', { name: '浅色' }).check();
  await expect(html(page)).toHaveAttribute('data-theme', 'light');
  const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.settings-dialog') as Element).backgroundColor);
  expect(bg).toBe('rgb(255, 255, 255)');
});

test('外观: 跟随系统 follows the OS setting, live', async ({ page }) => {
  const user = createUser('theme-system');
  await page.emulateMedia({ colorScheme: 'light' });
  await logIn(page, user.username, user.password);
  const dialog = await openAppearance(page);
  await dialog.getByRole('radio', { name: '跟随系统' }).check();
  await expect(html(page)).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(html(page)).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(html(page)).toHaveAttribute('data-theme', 'light');

  // 浅色 / 深色 ignore the OS.
  await dialog.getByRole('radio', { name: '浅色' }).check();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(html(page)).toHaveAttribute('data-theme', 'light');
});

test('外观: each 颜色系列 recolours the brand tokens, in 浅色 and 深色', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const user = createUser('theme-colors');
  await logIn(page, user.username, user.password);
  await addTask(page, '买牛奶');
  const brand = () =>
    page.evaluate(() => {
      const s = getComputedStyle(document.documentElement);
      return { text: s.getPropertyValue('--color-brand-text').trim(), button: s.getPropertyValue('--color-button-primary').trim() };
    });
  const seen = new Set<string>();
  for (const name of COLORS) {
    const dialog = await openAppearance(page);
    await dialog.getByRole('radio', { name }).check();
    await expect(html(page)).toHaveAttribute('data-theme-color', COLOR_IDS[name]);
    await expect(dialog.getByRole('radio', { name })).toBeChecked();
    seen.add(JSON.stringify(await brand()));
    await dialog.getByRole('button', { name: '关闭' }).click();
    await expect(dialog).toBeHidden();
    // The selected sidebar item and the rail use the colour.
    await page.screenshot({ path: testInfo.outputPath(`theme-${COLOR_IDS[name]}-${testInfo.project.name}.png`) });
  }
  expect(seen.size).toBe(COLORS.length);

  // Saved: still 沉香 after a reload.
  await page.reload();
  await expect(html(page)).toHaveAttribute('data-theme-color', 'agarwood');

  // 深色 + a colour: brand text switches to the light variant that reads on dark.
  const dialog = await openAppearance(page);
  await dialog.getByRole('radio', { name: '深色' }).check();
  await dialog.getByRole('radio', { name: '桃夭' }).check();
  await expect(html(page)).toHaveAttribute('data-theme', 'dark');
  await expect(html(page)).toHaveAttribute('data-theme-color', 'peach');
  await dialog.getByRole('button', { name: '关闭' }).click();
  expect(await lightLeftovers(page)).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath(`theme-peach-dark-${testInfo.project.name}.png`) });
});

test('外观 is reachable by keyboard: radios move with the arrow keys', async ({ page }) => {
  test.skip(isMobile(page), 'keyboard only');
  const user = createUser('theme-keys');
  await logIn(page, user.username, user.password);
  const dialog = await openAppearance(page);
  await dialog.getByRole('radio', { name: '晴蓝' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(dialog.getByRole('radio', { name: '松石' })).toBeChecked();
  await expect(html(page)).toHaveAttribute('data-theme-color', 'turquoise');
  await dialog.getByRole('radio', { name: '浅色' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(dialog.getByRole('radio', { name: '深色' })).toBeChecked();
  await expect(html(page)).toHaveAttribute('data-theme', 'dark');
});
