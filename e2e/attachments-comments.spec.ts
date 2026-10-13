import { deflateSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { createUser, isMobile, logIn } from './support.js';

/*
 * 附件 and 评论 (EURO-16, spec 用户故事 38、39). Runs at 1440px and 390px.
 */

const quickAdd = (page: Page) => page.getByRole('textbox', { name: '添加任务' });
const openTasks = (page: Page) => page.getByRole('list', { name: '任务', exact: true });
const detail = (page: Page) => page.getByRole('complementary', { name: '任务详情' });
const attachmentList = (page: Page) => detail(page).getByRole('list', { name: '附件列表' });
const commentList = (page: Page) => detail(page).getByRole('list', { name: '评论列表' });

async function addAndOpenTask(page: Page, title: string) {
  await quickAdd(page).fill(title);
  await quickAdd(page).press('Enter');
  await openTasks(page).getByRole('button', { name: title, exact: true }).click();
  await expect(detail(page).getByRole('textbox', { name: '任务标题' })).toHaveValue(title);
}

/** A real w×h PNG filled with one colour (so the thumbnail is visible in screenshots). */
function png(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = (crcTable[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj ' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

test('附件: upload, preview, download, refuse over 50MB, delete', async ({ page }, testInfo) => {
  const user = createUser('attach');
  await logIn(page, user.username, user.password);
  await addAndOpenTask(page, '报销材料');

  // 上传附件 lives in the detail's more menu and opens the system file picker.
  const chooser = page.waitForEvent('filechooser');
  await detail(page).getByRole('button', { name: '任务更多操作' }).click();
  await page.getByRole('menuitem', { name: '上传附件' }).click();
  await (
    await chooser
  ).setFiles([
    { name: '发票.png', mimeType: 'image/png', buffer: png(240, 160, [71, 114, 250]) },
    { name: '合同.pdf', mimeType: 'application/pdf', buffer: PDF },
    { name: '明细.csv', mimeType: 'text/csv', buffer: Buffer.from('日期,金额\n10-13,42\n') },
  ]);

  await expect(attachmentList(page).getByRole('img', { name: '发票.png' })).toBeVisible();
  await expect(attachmentList(page).getByRole('button', { name: '预览：合同.pdf' })).toContainText('合同.pdf');
  await expect(attachmentList(page).getByRole('link', { name: '下载：明细.csv' })).toContainText('明细.csv');
  // The thumbnail really loaded through the authenticated download route.
  await expect.poll(() => attachmentList(page).getByRole('img', { name: '发票.png' }).evaluate((img) => (img as unknown as { naturalWidth: number }).naturalWidth)).toBe(240);
  await page.screenshot({ path: testInfo.outputPath(`attachments-${testInfo.project.name}.png`) });

  // Image preview in a dialog; Esc closes it.
  await attachmentList(page).getByRole('button', { name: '预览：发票.png' }).click();
  const preview = page.getByRole('dialog', { name: '发票.png' });
  await expect(preview.getByRole('img', { name: '发票.png' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`attachment-preview-${testInfo.project.name}.png`) });
  await page.keyboard.press('Escape');
  await expect(preview).toBeHidden();

  // PDF preview is an embedded frame of the same file.
  await attachmentList(page).getByRole('button', { name: '预览：合同.pdf' }).click();
  const pdfDialog = page.getByRole('dialog', { name: '合同.pdf' });
  await expect(pdfDialog.locator('iframe[title="PDF 预览：合同.pdf"]')).toHaveAttribute('src', /\/api\/attachments\/[0-9a-f-]+\/content$/);
  await pdfDialog.getByRole('button', { name: '关闭' }).click();

  // Download keeps the original (Chinese) file name and content.
  const downloading = page.waitForEvent('download');
  await attachmentList(page).getByRole('link', { name: '下载：明细.csv' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('明细.csv');
  const { readFile } = await import('node:fs/promises');
  expect(await readFile(await download.path(), 'utf8')).toBe('日期,金额\n10-13,42\n');

  // Over 50MB: refused with a message, nothing added.
  const { truncate, writeFile } = await import('node:fs/promises');
  const big = testInfo.outputPath('太大.zip');
  await writeFile(big, '');
  await truncate(big, 50 * 1024 * 1024 + 1); // sparse file, no 50MB in memory
  await detail(page).locator('input[type="file"]').setInputFiles(big);
  await expect(page.getByRole('alert')).toContainText('单个附件不能超过 50MB');
  await page.getByRole('button', { name: '知道了' }).click();
  await expect(attachmentList(page).getByRole('listitem')).toHaveCount(3);

  // Delete with confirmation; survives a reload.
  await attachmentList(page).getByRole('button', { name: '删除附件：明细.csv' }).click();
  await page.getByRole('dialog', { name: '删除附件' }).getByRole('button', { name: '删除' }).click();
  await expect(attachmentList(page).getByRole('listitem')).toHaveCount(2);

  await page.reload();
  await openTasks(page).getByRole('button', { name: '报销材料', exact: true }).click();
  await expect(attachmentList(page).getByRole('img', { name: '发票.png' })).toBeVisible();
  await expect(attachmentList(page).getByRole('listitem')).toHaveCount(2);
});

test('评论: write, edit and delete; they stay after a reload', async ({ page }, testInfo) => {
  const user = createUser('comment');
  await logIn(page, user.username, user.password);
  await addAndOpenTask(page, '写周报');

  // No 评论 yet: the footer's 评论 button opens the composer.
  await expect(detail(page).getByRole('textbox', { name: '写评论' })).toHaveCount(0);
  await detail(page).getByRole('button', { name: '评论', exact: true }).click();
  const composer = detail(page).getByRole('textbox', { name: '写评论' });
  await expect(composer).toBeFocused();

  await composer.fill('初稿写完了');
  await composer.press('Enter');
  await expect(composer).toHaveValue('');
  await composer.fill('等老板看');
  await composer.press('Shift+Enter');
  await composer.pressSequentially('明天改');
  await detail(page).getByRole('button', { name: '发送' }).click();
  await expect(commentList(page).getByRole('listitem')).toHaveCount(2);
  await expect(commentList(page).getByRole('listitem').nth(0)).toContainText('初稿写完了');
  await expect(commentList(page).getByRole('listitem').nth(1)).toContainText('等老板看\n明天改');
  await expect(commentList(page).getByRole('listitem').nth(0)).toContainText(user.username);
  await page.screenshot({ path: testInfo.outputPath(`comments-${testInfo.project.name}.png`) });

  // Edit the first one from its menu.
  const first = commentList(page).getByRole('listitem').nth(0);
  await first.getByRole('button', { name: '评论操作' }).click();
  await page.getByRole('menuitem', { name: '编辑' }).click();
  const editor = first.getByRole('textbox', { name: '编辑评论' });
  await expect(editor).toBeFocused();
  await editor.fill('初稿改完了');
  if (isMobile(page)) await first.getByRole('button', { name: '保存' }).click();
  else await editor.press('Enter');
  await expect(first).toContainText('初稿改完了');
  await expect(first).toContainText('已编辑');

  // Esc cancels an edit.
  await first.getByRole('button', { name: '评论操作' }).click();
  await page.getByRole('menuitem', { name: '编辑' }).click();
  await first.getByRole('textbox', { name: '编辑评论' }).fill('不要这个');
  await first.getByRole('textbox', { name: '编辑评论' }).press('Escape');
  await expect(first).toContainText('初稿改完了');

  // Delete the second one.
  await commentList(page).getByRole('listitem').nth(1).getByRole('button', { name: '评论操作' }).click();
  await page.getByRole('menuitem', { name: '删除' }).click();
  await page.getByRole('dialog', { name: '删除评论' }).getByRole('button', { name: '删除' }).click();
  await expect(commentList(page).getByRole('listitem')).toHaveCount(1);

  await page.reload();
  await openTasks(page).getByRole('button', { name: '写周报', exact: true }).click();
  await expect(commentList(page).getByRole('listitem')).toHaveCount(1);
  await expect(commentList(page).getByRole('listitem').first()).toContainText('初稿改完了');
});
