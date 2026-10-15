import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { createUser, isMobile, logIn, openSidebar } from './support.js';

/*
 * 设置 → 关联与导入 → 备份与还原 (EURO-30, spec 用户故事 110–112): 生成备份
 * downloads the account as JSON, 导出 CSV the 任务, and 导入本地备份 restores
 * the JSON into another account; a refused file lists the records at fault.
 */

async function openBackup(page: Page) {
  if (isMobile(page)) await openSidebar(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置' });
  await expect(dialog).toBeVisible();
  const tab = dialog.getByRole('tab', { name: '关联与导入' });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  const card = dialog.getByRole('group', { name: '备份与还原' });
  await expect(card).toBeVisible();
  return card;
}

test('生成备份, 导出 CSV and 导入本地备份 into another account', async ({ page, browser }, testInfo) => {
  const source = createUser('backup-src');
  await logIn(page, source.username, source.password);
  const created = await page.request.post('/api/tasks', { data: { title: '备份里的任务', priority: 'high' } });
  expect(created.status()).toBe(201);
  const card = await openBackup(page);

  const [jsonDownload] = await Promise.all([page.waitForEvent('download'), card.getByRole('button', { name: '生成备份' }).click()]);
  expect(jsonDownload.suggestedFilename()).toMatch(/^dida-clone-backup-\d{8}\.json$/);
  const backupPath = testInfo.outputPath('backup.json');
  await jsonDownload.saveAs(backupPath);
  const backup = JSON.parse(await readFile(backupPath, 'utf8')) as { entities: { task: { title: string }[] } };
  expect(backup.entities.task.map((t) => t.title)).toContain('备份里的任务');

  const [csvDownload] = await Promise.all([page.waitForEvent('download'), card.getByRole('link', { name: '导出 CSV' }).click()]);
  expect(csvDownload.suggestedFilename()).toMatch(/^dida-clone-tasks-\d{8}\.csv$/);
  const csvPath = testInfo.outputPath('tasks.csv');
  await csvDownload.saveAs(csvPath);
  expect(await readFile(csvPath, 'utf8')).toContain('收件箱,,备份里的任务,,,高,未完成');
  await page.screenshot({ path: testInfo.outputPath(`backup-settings-${testInfo.project.name}.png`) });

  // Another account imports the file.
  const target = createUser('backup-dst');
  const context = await browser.newContext({ viewport: page.viewportSize(), isMobile: isMobile(page), hasTouch: isMobile(page) });
  const other = await context.newPage();
  await logIn(other, target.username, target.password);
  const otherCard = await openBackup(other);
  await otherCard.getByLabel('选择备份文件').setInputFiles(backupPath);
  await expect(otherCard.getByRole('status', { name: '导入状态' })).toContainText('导入完成：');
  await otherCard.getByRole('button', { name: '刷新页面' }).click();
  await expect(other.getByRole('heading', { level: 1, name: '收件箱' })).toBeVisible();
  await expect(other.getByText('备份里的任务')).toBeVisible();

  // A broken file names the record and imports nothing.
  const broken = structuredClone(backup) as { entities: { task: Record<string, unknown>[] } };
  (broken.entities.task[0] as Record<string, unknown>).priority = 'urgent';
  const brokenCard = await openBackup(other);
  await brokenCard.getByLabel('选择备份文件').setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(broken)) });
  await expect(brokenCard.getByRole('status', { name: '导入状态' })).toHaveText('备份文件里有不能导入的数据，没有导入任何内容');
  await expect(brokenCard.getByRole('list', { name: '出错的数据' })).toContainText(/任务 第 1 条（id .+）：priority 的取值不合法/);
  await other.screenshot({ path: testInfo.outputPath(`backup-import-error-${testInfo.project.name}.png`) });
  await context.close();
});

test('导入本地备份 is keyboard operable and says when the file is not JSON', async ({ page }) => {
  const user = createUser('backup-kb');
  await logIn(page, user.username, user.password);
  const card = await openBackup(page);
  const button = card.getByRole('button', { name: '导入本地备份' });
  await button.focus();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
  await chooser.setFiles({ name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from('not json') });
  await expect(card.getByRole('status', { name: '导入状态' })).toHaveText('这不是有效的 JSON 文件，请选择本应用导出的备份文件');
});

test('生成备份 says why when the server refuses (too large to import back)', async ({ page }) => {
  const user = createUser('backup-big');
  await logIn(page, user.username, user.password);
  const message = '备份文件预计约 300.0 MB，超过了导入上限 256.0 MB，生成了也导不回来。请先删除一些不需要的附件，再生成备份。';
  // The real limit needs 256MB of 附件; the API test covers the server side with a small limit.
  await page.route('**/api/backup/export', (route) =>
    route.fulfill({ status: 413, contentType: 'application/json', body: JSON.stringify({ error: { code: 'backup_too_large', message } }) }),
  );
  const card = await openBackup(page);
  await card.getByRole('button', { name: '生成备份' }).click();
  await expect(card.getByRole('status', { name: '生成备份状态' })).toHaveText(message);
});

test('导入滴答清单备份: the mock 滴答 CSV goes in, a bad line is named', async ({ page }, testInfo) => {
  const user = createUser('backup-tt');
  await logIn(page, user.username, user.password);
  const mock = await readFile(new URL('../packages/server/test/fixtures/ticktick-backup.mock.csv', import.meta.url), 'utf8');

  // A broken row first: nothing is imported, the line is listed.
  const broken = mock.replace('"FREQ=YEARLY;INTERVAL=1;BYMONTH=12;BYMONTHDAY=31"', '"FREQ=DAILY;INTERVAL=364"');
  const card = await openBackup(page);
  await card.getByLabel('选择滴答清单备份文件').setInputFiles({ name: 'TickTick-backup.csv', mimeType: 'text/csv', buffer: Buffer.from(broken) });
  await expect(card.getByRole('status', { name: '导入状态' })).toHaveText('滴答清单备份里有不能导入的行，没有导入任何内容');
  await expect(card.getByRole('list', { name: '出错的数据' })).toContainText('第 16 行（示例：每年）：重复规则「FREQ=DAILY;INTERVAL=364」：重复间隔最多 99');

  await card.getByLabel('选择滴答清单备份文件').setInputFiles({ name: 'TickTick-backup.csv', mimeType: 'text/csv', buffer: Buffer.from(mock) });
  await expect(card.getByRole('status', { name: '导入状态' })).toContainText('导入完成：文件夹 1 条、清单 2 条、标签 3 条、任务 10 条、检查项 3 条');
  await page.screenshot({ path: testInfo.outputPath(`backup-ticktick-${testInfo.project.name}.png`) });
  await card.getByRole('button', { name: '刷新页面' }).click();
  await expect(page.getByText('示例任务：买牛奶')).toBeVisible();
});
