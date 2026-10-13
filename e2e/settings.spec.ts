import { expect, test, type Page } from '@playwright/test';
import { createUser, isMobile, logIn, openSidebar } from './support.js';

/*
 * 设置 → 日期与时间 → 节假日数据 (EURO-10, spec 用户故事 114): last update time and 立即更新.
 * The e2e server's holiday-cn stand-in (scripts/e2e-server.mjs) serves the
 * built-in files: this year is unchanged and next year is not published yet.
 */

async function openSettings(page: Page) {
  if (isMobile(page)) await openSidebar(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('节假日数据 shows the last update time and updates on 立即更新', async ({ page }, testInfo) => {
  const user = createUser('holiday');
  await logIn(page, user.username, user.password);
  const dialog = await openSettings(page);

  const dateTab = dialog.getByRole('tab', { name: '日期与时间' });
  await dateTab.click();
  await expect(dateTab).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByRole('heading', { name: '日期与时间' })).toBeVisible();
  const card = dialog.getByRole('group', { name: '节假日数据' });
  await expect(card).toBeVisible();

  const thisYear = new Date().getFullYear();
  await card.getByRole('button', { name: '立即更新' }).click();
  await expect(card.getByRole('status')).toHaveText('节假日数据已是最新');
  await expect(card.getByTestId('holiday-last-updated')).toHaveText(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/);
  await expect(card.getByTestId(`holiday-year-${thisYear}`)).toHaveText('已更新');
  await expect(card.getByTestId(`holiday-year-${thisYear + 1}`)).toHaveText('尚未公布，按周一到周五计算');

  // Reopening reads the saved status from the server.
  await page.reload();
  const again = await openSettings(page);
  await again.getByRole('tab', { name: '日期与时间' }).click();
  await expect(again.getByTestId('holiday-last-updated')).toHaveText(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/);
  await page.screenshot({ path: testInfo.outputPath(`settings-holidays-${testInfo.project.name}.png`) });

  await page.keyboard.press('Escape');
  await expect(again).toBeHidden();
});

test('设置 is keyboard operable', async ({ page }) => {
  const user = createUser('holiday-kb');
  await logIn(page, user.username, user.password);
  const dialog = await openSettings(page);
  // Vertical tabs: ↓ moves from 账户与安全 to 日期与时间.
  await dialog.getByRole('tab', { name: '账户与安全' }).click();
  await page.keyboard.press('ArrowDown');
  await expect(dialog.getByRole('tab', { name: '日期与时间' })).toHaveAttribute('aria-selected', 'true');
  await dialog.getByRole('button', { name: '立即更新' }).focus();
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('status')).toHaveText('节假日数据已是最新');
  await dialog.getByRole('button', { name: '关闭' }).click();
  await expect(dialog).toBeHidden();
});
