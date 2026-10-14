import { expect, test, type Page } from '@playwright/test';
import { createUser, isMobile, logIn, openSidebar } from './support.js';

/*
 * 倒数日 (EURO-26, spec 用户故事 99–101): the cards (days left / passed, a
 * 农历 春节 that repeats every year), adding one through the dialog, the
 * 年月日 format, 置顶, 归档 and 删除. The browser clock is pinned to
 * 2026-10-14 12:00 in Shanghai, the day the reference screenshots show
 * 周末 3 / 春节 115 / 使用滴答清单 4328.
 */

const NOW = new Date('2026-10-14T04:00:00.000Z');

async function create(page: Page, data: object) {
  const res = await page.request.post('/api/countdowns', { data });
  expect(res.status()).toBe(201);
}

async function openCountdowns(page: Page) {
  if (isMobile(page)) {
    await openSidebar(page);
    await page.getByRole('button', { name: '倒数日' }).click();
  } else {
    await page.getByRole('link', { name: '倒数日' }).click();
  }
  await expect(page).toHaveURL(/\/countdowns$/);
}

const card = (page: Page, name: string) => page.getByRole('listitem').filter({ has: page.getByRole('heading', { name }) });

test('倒数日 cards, add with 农历 and 每年, 年月日 format, 置顶, 归档, 删除', async ({ page }, testInfo) => {
  await page.clock.setFixedTime(NOW);
  const user = createUser('countdown');
  await logIn(page, user.username, user.password);
  await create(page, { name: '周末', date: '2026-10-17' });
  await create(page, { name: '春节', icon: '🧧', date: '2026-02-17', calendar: 'lunar', repeat: 'yearly' });
  await create(page, { name: '使用滴答清单', icon: '📅', date: '2014-12-08' });

  await openCountdowns(page);
  await expect(page.getByRole('heading', { level: 1, name: /倒数纪念日/ })).toBeVisible();
  await expect(card(page, '周末').getByRole('button', { name: /距离 2026年10月17日 还有 3天/ })).toBeVisible();
  await expect(card(page, '春节')).toContainText('115');
  await expect(card(page, '春节')).toContainText('距离 正月初一 (2027年2月6日) 还有');
  await expect(card(page, '使用滴答清单')).toContainText('4328');
  await expect(card(page, '使用滴答清单')).toContainText('距离 2014年12月8日 已经');
  await page.mouse.move(0, 0);
  await page.screenshot({ path: testInfo.outputPath(`countdowns-${testInfo.project.name}.png`) });

  // Add one: 农历 腊月初八 (2027-01-15), every year, reminded the day before.
  await page.getByRole('button', { name: '添加倒数日' }).click();
  const dialog = page.getByRole('dialog', { name: '添加倒数日' });
  await dialog.getByLabel('名称').fill('腊八');
  await dialog.getByText('农历', { exact: true }).click();
  await dialog.getByLabel('日期', { exact: true }).fill('2027-01-15');
  await expect(dialog.getByText('农历 腊月初八')).toBeVisible();
  await dialog.getByLabel('重复').selectOption('yearly');
  await dialog.getByLabel('提前1天').check();
  await dialog.getByLabel('提醒时间').fill('20:00');
  await page.screenshot({ path: testInfo.outputPath(`countdown-dialog-${testInfo.project.name}.png`) });
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog).toBeHidden();
  await expect(card(page, '腊八')).toContainText('93');
  await expect(card(page, '腊八')).toContainText('距离 腊月初八 (2027年1月15日) 还有');
  const saved = (await (await page.request.get('/api/countdowns')).json()) as { countdowns: { name: string; reminders: unknown[] }[] };
  expect(saved.countdowns.find((c) => c.name === '腊八')?.reminders).toEqual([{ type: 'day', daysBefore: 1, time: '20:00' }]);

  // The figures switch to 年月日 and back.
  const figure = card(page, '使用滴答清单').getByRole('button', { name: /点击切换为年月日格式/ });
  await figure.click();
  await expect(card(page, '使用滴答清单')).toContainText('11年10个月6天');
  await card(page, '使用滴答清单').getByRole('button', { name: /点击切换为天数格式/ }).click();
  await expect(card(page, '使用滴答清单')).toContainText('4328');

  // 置顶 moves a card first.
  await card(page, '使用滴答清单').getByRole('button', { name: '置顶：使用滴答清单' }).click();
  await expect(page.getByRole('list', { name: '倒数纪念日' }).getByRole('listitem').first()).toContainText('使用滴答清单');

  // 归档: gone from 记录中, listed under 已归档 (title menu), and back.
  await card(page, '周末').getByRole('button', { name: '倒数日操作：周末' }).click();
  await page.getByRole('menuitem', { name: '归档' }).click();
  await expect(card(page, '周末')).toHaveCount(0);
  await page.getByRole('button', { name: /倒数纪念日，切换/ }).click();
  await page.getByRole('menuitemradio', { name: '已归档' }).click();
  await expect(page).toHaveURL(/\/countdowns\/archived$/);
  await expect(card(page, '周末')).toBeVisible();
  await card(page, '周末').getByRole('button', { name: '倒数日操作：周末' }).click();
  await page.getByRole('menuitem', { name: '取消归档' }).click();
  await expect(page.getByText('没有已归档的倒数日')).toBeVisible();

  // 删除 asks first.
  await page.getByRole('button', { name: /已归档的倒数日，切换/ }).click();
  await page.getByRole('menuitemradio', { name: '记录中' }).click();
  await card(page, '腊八').getByRole('button', { name: '倒数日操作：腊八' }).click();
  await page.getByRole('menuitem', { name: '删除' }).click();
  await page.getByRole('dialog', { name: '删除倒数日' }).getByRole('button', { name: '删除' }).click();
  await expect(card(page, '腊八')).toHaveCount(0);
  await expect(card(page, '周末')).toBeVisible();
});
