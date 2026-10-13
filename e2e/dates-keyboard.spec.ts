import { expect, test, type Page } from '@playwright/test';
import { createUser, isMobile, logIn, openAccount } from './support.js';

/*
 * Review (EURO-7): the date picker and the 日期与时间 settings tab with the
 * keyboard only, and the 390px bottom sheet. No reference shots exist for these
 * two screens, so only behaviour is checked, not pixels.
 */

const NOW = new Date('2026-10-13T04:00:00.000Z'); // Tuesday 12:00 in Shanghai
const TODAY = '2026-10-13';
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const dayMs = (date: string) => Date.parse(`${date}T00:00:00Z`);
const addDays = (date: string, n: number) => new Date(dayMs(date) + n * 86_400_000).toISOString().slice(0, 10);
/** Same words as the list: 今天 / 明天 / 昨天 / 周几 within 6 days / M月D日. */
function relativeDayLabel(date: string, today: string): string {
  const diff = (dayMs(date) - dayMs(today)) / 86_400_000;
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === -1) return '昨天';
  if (diff > 1 && diff < 7) return WEEKDAYS[new Date(dayMs(date)).getUTCDay()]!;
  const [, m, d] = date.split('-').map(Number);
  return `${m}月${d}日`;
}

const quickAdd = (page: Page) => page.getByRole('textbox', { name: '添加任务' });
const openTasks = (page: Page) => page.getByRole('list', { name: '任务', exact: true });
const detail = (page: Page) => page.getByRole('complementary', { name: '任务详情' });
const picker = (page: Page) => page.getByRole('dialog', { name: '设置日期' });
const dateButton = (page: Page) => detail(page).getByRole('button', { name: /^(设置日期|日期：)/ });

const focusedDate = (page: Page) => page.evaluate<string | null>("document.activeElement?.getAttribute('data-date') ?? null");
const focusedText = (page: Page) => page.evaluate<string>("document.activeElement?.textContent?.trim() ?? ''");

/** Press Tab until `done` holds for the focused element (at most `max` times). */
async function tabUntil(page: Page, done: () => Promise<boolean>, max = 30) {
  for (let i = 0; i < max; i++) {
    if (await done()) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('focus never reached the target with Tab');
}

test('date picker works with the keyboard only; 390px shows a bottom sheet', async ({ page }) => {
  await page.clock.setFixedTime(NOW);
  const user = createUser('datekb');
  await logIn(page, user.username, user.password);
  await quickAdd(page).fill('键盘');
  await quickAdd(page).press('Enter');
  await openTasks(page).getByRole('button', { name: '键盘', exact: true }).click();

  // Enter on the date button opens the picker with focus on the selected tab.
  await dateButton(page).focus();
  await page.keyboard.press('Enter');
  await expect(picker(page)).toBeVisible();
  await expect(picker(page).getByRole('tab', { name: '日期', exact: true })).toBeFocused();

  if (isMobile(page)) {
    const box = (await picker(page).boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(Math.round(box.y + box.height)).toBeGreaterThanOrEqual(viewport.height - 2);
    expect(Math.round(box.width)).toBeGreaterThanOrEqual(viewport.width - 2);
  }

  // ←/→ move between the tabs.
  await page.keyboard.press('ArrowRight');
  await expect(picker(page).getByRole('tab', { name: '时间段' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(picker(page).getByRole('tab', { name: '日期', exact: true })).toHaveAttribute('aria-selected', 'true');

  // Tab into the calendar, ↓ one week, ← one day, Enter to pick, then 确定 with Enter.
  await tabUntil(page, async () => (await focusedDate(page)) !== null);
  const start = (await focusedDate(page))!;
  await page.keyboard.press('ArrowDown');
  expect(await focusedDate(page)).toBe(addDays(start, 7));
  await page.keyboard.press('ArrowLeft');
  const picked = addDays(start, 6);
  expect(await focusedDate(page)).toBe(picked);
  await page.keyboard.press('Enter');
  await tabUntil(page, async () => (await focusedText(page)) === '确定');
  await page.keyboard.press('Enter');
  await expect(picker(page)).toBeHidden();
  await expect(dateButton(page)).toHaveAccessibleName(`日期：${relativeDayLabel(picked, TODAY)}`);
  await expect(dateButton(page)).toBeFocused();

  // Esc closes without saving and returns focus to the date button.
  await page.keyboard.press('Enter');
  await expect(picker(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(picker(page)).toBeHidden();
  await expect(dateButton(page)).toBeFocused();
  await expect(dateButton(page)).toHaveAccessibleName(`日期：${relativeDayLabel(picked, TODAY)}`);
});

test('日期与时间 settings tab is reachable and usable with the keyboard', async ({ page }) => {
  await page.clock.setFixedTime(NOW);
  const user = createUser('tzkb');
  await logIn(page, user.username, user.password);
  const settings = await openAccount(page, user.username);
  const accountTab = settings.getByRole('tab', { name: '账户与安全' });
  const dateTab = settings.getByRole('tab', { name: '日期与时间' });
  await accountTab.focus();
  await page.keyboard.press('ArrowDown');
  await expect(dateTab).toBeFocused();
  await expect(dateTab).toHaveAttribute('aria-selected', 'true');
  const zone = settings.getByLabel('时区');
  await expect(zone).toHaveValue('Asia/Shanghai');
  const zoneId = await zone.getAttribute('id');
  expect(zoneId).toBeTruthy();
  await tabUntil(page, async () => (await page.evaluate<string | null>('document.activeElement?.id ?? null')) === zoneId);
  await zone.selectOption('Asia/Tokyo');
  await expect(settings.getByRole('status')).toHaveText('时区已保存');
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await page.reload();
  const again = await openAccount(page, user.username);
  await again.getByRole('tab', { name: '日期与时间' }).click();
  await expect(again.getByLabel('时区')).toHaveValue('Asia/Tokyo');
});
