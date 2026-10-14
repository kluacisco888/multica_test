import { expect, test, type Page } from '@playwright/test';
import { formatYmd, todayIn, ymdBetween, addDays, countdownCaption } from '../packages/shared/src/index.js';
import { lunarLabel, nextOccurrence, type CountdownDate } from '../packages/shared/src/countdown-dates.js';
import { createUser, isMobile, logIn, openSidebar } from './support.js';

/*
 * 倒数日 (EURO-26, spec 用户故事 99–101): the cards (days left / passed, a
 * 农历 春节 that repeats every year), adding one through the dialog, the
 * 年月日 format, 置顶, 归档 and 删除.
 *
 * The server counts the days from its own (real) today in the user's time
 * zone, so the test cannot pin a calendar date: the browser clock is pinned
 * to the real now (the server's), dates are set relative to today, and the
 * figures that depend on the calendar (农历 春节, 年月日, 腊八) are worked out
 * with the shared rules. Relative to today the cards show 周末 3 and
 * 使用滴答清单 4328, like the reference screenshots (taken on 2026-10-14).
 */

const TIME_ZONE = 'Asia/Shanghai';

/** Card caption and day count the server shows today, from the shared rules. */
function expected(c: CountdownDate, today: string) {
  const next = nextOccurrence(c, today);
  return { days: String(next.days), caption: countdownCaption({ calendar: c.calendar, lunar: c.calendar === 'lunar' ? lunarLabel(c.date) : null, next }) };
}

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
  const now = new Date();
  await page.clock.setFixedTime(now);
  const today = todayIn(now, TIME_ZONE);
  const weekend = addDays(today, 3);
  const since = addDays(today, -4328);
  const spring: CountdownDate = { date: '2026-02-17', calendar: 'lunar', repeat: 'yearly' };
  const springShown = expected(spring, today);
  const user = createUser('countdown');
  await logIn(page, user.username, user.password);
  await create(page, { name: '周末', date: weekend });
  await create(page, { name: '春节', icon: '🧧', ...spring });
  await create(page, { name: '使用滴答清单', icon: '📅', date: since });

  await openCountdowns(page);
  await expect(page.getByRole('heading', { level: 1, name: /倒数纪念日/ })).toBeVisible();
  const weekendCaption = expected({ date: weekend, calendar: 'solar', repeat: 'none' }, today).caption;
  await expect(card(page, '周末').getByRole('button', { name: `${weekendCaption} 3天` })).toBeVisible();
  await expect(card(page, '春节')).toContainText(springShown.days);
  await expect(card(page, '春节')).toContainText(springShown.caption);
  await expect(card(page, '使用滴答清单')).toContainText('4328');
  await expect(card(page, '使用滴答清单')).toContainText(expected({ date: since, calendar: 'solar', repeat: 'none' }, today).caption);
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
  const labaShown = expected({ date: '2027-01-15', calendar: 'lunar', repeat: 'yearly' }, today);
  await expect(card(page, '腊八')).toContainText(labaShown.days);
  await expect(card(page, '腊八')).toContainText(labaShown.caption);
  const saved = (await (await page.request.get('/api/countdowns')).json()) as { countdowns: { name: string; reminders: unknown[] }[] };
  expect(saved.countdowns.find((c) => c.name === '腊八')?.reminders).toEqual([{ type: 'day', daysBefore: 1, time: '20:00' }]);

  // The figures switch to 年月日 and back.
  const figure = card(page, '使用滴答清单').getByRole('button', { name: /点击切换为年月日格式/ });
  await figure.click();
  await expect(card(page, '使用滴答清单')).toContainText(formatYmd(ymdBetween(since, today)));
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
