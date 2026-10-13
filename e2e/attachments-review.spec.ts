import { expect, test } from '@playwright/test';
import { createUser, logIn } from './support.js';

/*
 * EURO-16 review: in a real browser, another account opening the download URL
 * gets 404, the signed-out browser 401, and an SVG upload is never rendered inline.
 */

test('附件 URL: other account 404, signed out 401, SVG is a download', async ({ page, browser }) => {
  const owner = createUser('att-owner');
  await logIn(page, owner.username, owner.password);
  const created = await page.request.post('/api/tasks', { data: { title: '私密附件' } });
  expect(created.status()).toBe(201);
  const taskId = (await created.json()).id as string;
  const svg = await page.request.post(`/api/tasks/${taskId}/attachments?name=x.svg`, {
    headers: { 'content-type': 'image/svg+xml' },
    data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="document.title=\'pwned\'"/>'),
  });
  expect(svg.status()).toBe(201);
  const id = (await svg.json()).id as string;
  const url = `/api/attachments/${id}/content`;

  // Owner: served as a download, never as an SVG document on this origin.
  const own = await page.request.get(url);
  expect(own.status()).toBe(200);
  expect(own.headers()['content-type']).toBe('application/octet-stream');
  expect(own.headers()['content-disposition']).toMatch(/^attachment; /);

  const other = createUser('att-other');
  const otherContext = await browser.newContext();
  const otherPage = await otherContext.newPage();
  await logIn(otherPage, other.username, other.password);
  const foreign = await otherPage.goto(url);
  expect(foreign?.status()).toBe(404);
  await otherContext.close();

  const anonContext = await browser.newContext();
  const anon = await (await anonContext.newPage()).goto(url);
  expect(anon?.status()).toBe(401);
  await anonContext.close();
});
