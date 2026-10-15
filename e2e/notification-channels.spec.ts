import { expect, test, type Locator, type Page } from '@playwright/test';
import { startFakeSmtp, type FakeSmtpServer } from '../packages/server/test/fakes/fake-smtp.js';
import { startFakeWebhook, type FakeWebhookServer } from '../packages/server/test/fakes/fake-webhook.js';
import { createUser, fakeListen, isMobile, logIn, openSidebar } from './support.js';

/*
 * 设置 →「提醒与通知」: 通知渠道 (EURO-11, spec 用户故事 74–77、85).
 * The fake Webhook and fake SMTP run in the test process (127.0.0.1, or the
 * Docker bridge for the compose run), which the server under test can reach;
 * nothing is sent to the internet.
 */

let hook: FakeWebhookServer;
let smtp: FakeSmtpServer;

test.beforeAll(async () => {
  hook = await startFakeWebhook({ listen: fakeListen() });
  smtp = await startFakeSmtp({ listen: fakeListen(), credentials: { username: 'me@qq.com', password: 'right-auth-code' } });
});
test.afterAll(async () => {
  await hook.close();
  await smtp.close();
});

async function openSettings(page: Page): Promise<Locator> {
  if (isMobile(page)) {
    const sidebar = await openSidebar(page);
    await sidebar.getByRole('button', { name: '设置', exact: true }).click();
  } else {
    await page.getByRole('navigation', { name: '模块' }).getByRole('button', { name: '设置', exact: true }).click();
  }
  const settings = page.getByRole('dialog', { name: '设置' });
  await expect(settings.getByRole('heading', { name: '提醒与通知' })).toBeVisible();
  return settings;
}

const channelCard = (settings: Locator, name: string) => settings.getByRole('listitem', { name, exact: true });

async function addFeishu(page: Page, settings: Locator, name: string, url: string, secret?: string) {
  await settings.getByRole('button', { name: '添加渠道' }).click();
  await page.getByRole('menuitem', { name: '飞书机器人' }).click();
  const form = page.getByRole('dialog', { name: '添加飞书机器人渠道' });
  await form.getByLabel('名称').fill(name);
  await form.getByLabel('Webhook URL').fill(url);
  if (secret) await form.getByLabel('签名 secret（选填）').fill(secret);
  await form.getByRole('button', { name: '保存' }).click();
  await expect(form).toBeHidden();
  await expect(channelCard(settings, name)).toBeVisible();
}

test('飞书 channel: add with secret, send a signed test message, edit without re-entering credentials', async ({ page }, testInfo) => {
  const { username, password } = createUser('channels');
  await logIn(page, username, password);
  const settings = await openSettings(page);
  await expect(settings.getByText('还没有通知渠道')).toBeVisible();

  const token = `hook-${testInfo.project.name}-0123456789abcdef`;
  await addFeishu(page, settings, '工作群', `${hook.url}/open-apis/bot/v2/hook/${token}`, 'feishu-e2e-secret');
  const card = channelCard(settings, '工作群');
  // Only masked values reach the page.
  await expect(card).toContainText(`${hook.url}/****cdef`);
  await expect(card).toContainText('****cret');
  await expect(settings).not.toContainText(token);
  await expect(settings).not.toContainText('feishu-e2e-secret');

  await card.getByRole('button', { name: '发送测试消息到「工作群」' }).click();
  await expect(card.getByRole('status')).toHaveText('测试消息已发送，请查收');
  const request = hook.requests.find((r) => r.path.endsWith(token));
  expect(request?.json).toMatchObject({ sign: expect.any(String), timestamp: expect.any(String), msg_type: 'text' });

  // Rename only: credential inputs stay empty and the stored ones are kept.
  await card.getByRole('button', { name: '编辑「工作群」' }).click();
  const form = page.getByRole('dialog', { name: '编辑飞书机器人渠道' });
  await expect(form.getByLabel('Webhook URL')).toHaveValue('');
  await expect(form.getByText(`已保存（${hook.url}/****cdef），留空则保持不变。`)).toBeVisible();
  await form.getByLabel('名称').fill('工作群（新）');
  await form.getByRole('button', { name: '保存' }).click();
  await expect(form).toBeHidden();
  const renamed = channelCard(settings, '工作群（新）');
  await expect(renamed).toContainText(`${hook.url}/****cdef`);

  // A failing 飞书 shows its concrete reason.
  hook.replyNext({ status: 200, body: { code: 19021, msg: 'sign match fail or timestamp is not within one hour from current time' } });
  await renamed.getByRole('button', { name: '发送测试消息到「工作群（新）」' }).click();
  await expect(renamed.getByRole('alert')).toHaveText(
    '发送失败：飞书返回错误 19021：sign match fail or timestamp is not within one hour from current time',
  );

  // Default channel switch survives a reload.
  await renamed.getByRole('switch', { name: '设为默认渠道' }).check();
  await expect(renamed.getByText('默认', { exact: true })).toBeVisible();
  await page.reload();
  const again = await openSettings(page);
  await expect(channelCard(again, '工作群（新）').getByRole('switch', { name: '设为默认渠道' })).toBeChecked();

  // Delete.
  await channelCard(again, '工作群（新）').getByRole('button', { name: '删除「工作群（新）」' }).click();
  await page.getByRole('dialog', { name: '删除通知渠道' }).getByRole('button', { name: '删除' }).click();
  await expect(channelCard(again, '工作群（新）')).toBeHidden();
  await expect(again.getByText('还没有通知渠道')).toBeVisible();
});

test('邮件 channel: QQ preset, wrong 授权码 shows the SMTP error, the right one delivers', async ({ page }, testInfo) => {
  const { username, password } = createUser('mail');
  await logIn(page, username, password);
  const settings = await openSettings(page);

  await settings.getByRole('button', { name: '添加渠道' }).click();
  await page.getByRole('menuitem', { name: '邮件' }).click();
  const form = page.getByRole('dialog', { name: '添加邮件渠道' });
  // QQ 邮箱 preset is filled in.
  await expect(form.getByLabel('邮箱服务商')).toHaveValue('qq');
  await expect(form.getByLabel('SMTP 服务器')).toHaveValue('smtp.qq.com');
  await expect(form.getByLabel('端口')).toHaveValue('465');
  await expect(form.getByLabel('加密方式')).toHaveValue('ssl');

  // Point it at the local fake SMTP instead (no TLS).
  await form.getByLabel('名称').fill('QQ 邮箱');
  await form.getByLabel('SMTP 服务器').fill(smtp.host);
  await expect(form.getByLabel('邮箱服务商')).toHaveValue('custom');
  await form.getByLabel('加密方式').selectOption('none');
  await form.getByLabel('端口').fill(String(smtp.port));
  await form.getByLabel('账号').fill('me@qq.com');
  await form.getByLabel('授权码').fill('wrong-auth-code');
  const to = `inbox-${testInfo.project.name}@example.com`;
  await form.getByLabel('收件地址').fill(to);
  await form.getByRole('button', { name: '保存' }).click();
  await expect(form).toBeHidden();

  const card = channelCard(settings, 'QQ 邮箱');
  await expect(card).toContainText('****');
  await expect(settings).not.toContainText('wrong-auth-code');
  await card.getByRole('button', { name: '发送测试消息到「QQ 邮箱」' }).click();
  await expect(card.getByRole('alert')).toContainText('发送失败：SMTP 登录失败，请检查账号和授权码（535');

  await card.getByRole('button', { name: '编辑「QQ 邮箱」' }).click();
  const edit = page.getByRole('dialog', { name: '编辑邮件渠道' });
  await edit.getByLabel('授权码').fill('right-auth-code');
  await edit.getByRole('button', { name: '保存' }).click();
  await expect(edit).toBeHidden();
  await card.getByRole('button', { name: '发送测试消息到「QQ 邮箱」' }).click();
  await expect(card.getByRole('status')).toHaveText('测试消息已发送，请查收');
  await expect.poll(() => smtp.messages.some((m) => m.to.includes(to))).toBe(true);
});

test('screenshots of 设置 → 提醒与通知 for comparison with the reference', async ({ page }, testInfo) => {
  const { username, password } = createUser('shots');
  await logIn(page, username, password);
  let settings = await openSettings(page);
  await addFeishu(page, settings, '飞书 · 工作群', `${hook.url}/open-apis/bot/v2/hook/0f1e2d3c-aaaa-bbbb-cccc-1234567890ab`, 'feishu-sign-secret');
  await settings.getByRole('button', { name: '添加渠道' }).click();
  await page.getByRole('menuitem', { name: '邮件' }).click();
  const form = page.getByRole('dialog', { name: '添加邮件渠道' });
  await form.getByLabel('名称').fill('QQ 邮箱');
  await form.getByLabel('账号').fill('123456@qq.com');
  await form.getByLabel('授权码').fill('abcdefghijklmnop');
  await form.getByLabel('收件地址').fill('123456@qq.com');
  await form.getByRole('checkbox', { name: '设为默认渠道' }).check();
  await page.screenshot({ path: testInfo.outputPath(`channel-form-${testInfo.project.name}.png`) });
  await form.getByRole('button', { name: '保存' }).click();
  await expect(form).toBeHidden();
  await page.reload();
  settings = await openSettings(page);
  await expect(channelCard(settings, 'QQ 邮箱')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`settings-notifications-${testInfo.project.name}.png`) });
});
