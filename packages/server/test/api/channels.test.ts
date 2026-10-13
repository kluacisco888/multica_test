import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import net from 'node:net';
import { sql } from 'drizzle-orm';
import { changesResponseSchema, channelsResponseSchema, notificationChannelSchema, QQ_MAIL_PRESET } from '@dida/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { decodeMail, startFakeSmtp, type FakeSmtpServer } from '../fakes/fake-smtp.js';
import { startFakeWebhook, type FakeWebhookServer } from '../fakes/fake-webhook.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/*
 * 通知渠道 (EURO-11, spec 用户故事 74–77、85, ADR-0005): settings API, encrypted
 * credentials, 发送测试消息, and the shared "send a message to a channel"
 * interface (`app.notifier`) that 提醒, 专注 and 习惯 reuse.
 */

/** A local port nothing listens on (fetch refuses well-known ports like 1). */
async function closedPort(): Promise<number> {
  const server = net.createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as net.AddressInfo;
  server.close();
  await once(server, 'close');
  return port;
}

const NOW = '2023-11-14T22:13:20.000Z'; // unix 1700000000

describe('notification channels API', () => {
  const clock = fixedClock(NOW);
  let t: TestApp;
  let alice: TestUser;
  let bob: TestUser;
  let hook: FakeWebhookServer;
  let smtp: FakeSmtpServer | undefined;

  beforeAll(async () => {
    t = await createTestApp({ clock });
    alice = await t.createUser('alice');
    bob = await t.createUser('bob');
    hook = await startFakeWebhook();
  });
  afterAll(async () => {
    await hook.close();
    await t.close();
  });
  afterEach(async () => {
    hook.requests.length = 0;
    await smtp?.close();
    smtp = undefined;
  });

  function api(user: TestUser, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) {
    return t.app.inject({ method, url, headers: user.headers, ...(payload ? { payload } : {}) });
  }

  async function create(user: TestUser, payload: object) {
    const res = await api(user, 'POST', '/api/notification-channels', payload);
    expect(res.statusCode, res.body).toBe(201);
    return notificationChannelSchema.parse(res.json());
  }

  async function list(user: TestUser) {
    const res = await api(user, 'GET', '/api/notification-channels');
    expect(res.statusCode).toBe(200);
    return channelsResponseSchema.parse(res.json()).channels;
  }

  const webhookUrl = () => `${hook.url}/open-apis/bot/v2/hook/0f1e2d3c-aaaa-bbbb-cccc-1234567890ab`;

  async function rawRows(): Promise<string> {
    const result = await t.database.db.execute(sql`SELECT * FROM notification_channels`);
    return JSON.stringify(result.rows);
  }

  describe('飞书', () => {
    it('signs the message when a secret is set', async () => {
      const channel = await create(alice, {
        type: 'feishu',
        name: '工作群',
        config: { webhookUrl: webhookUrl(), secret: 'feishu-sign-secret' },
      });
      const res = await api(alice, 'POST', `/api/notification-channels/${channel.id}/test`);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ ok: true });

      const [request] = await hook.waitForRequests(1);
      expect(request).toMatchObject({ method: 'POST', path: '/open-apis/bot/v2/hook/0f1e2d3c-aaaa-bbbb-cccc-1234567890ab' });
      // Expected signature computed independently (Python hmac) from 飞书's documented algorithm:
      // base64(HMAC-SHA256(key = "<timestamp>\n<secret>", message = "")).
      expect(request?.json).toEqual({
        timestamp: '1700000000',
        sign: '81UKnZwmqUfLTAmVXCJI/p9Uyd3qqw5dsBo4h1tXz2w=',
        msg_type: 'text',
        content: { text: expect.stringContaining('测试消息') },
      });
      expect((request?.json as { content: { text: string } }).content.text).toContain('工作群');
    });

    it('sends no timestamp or sign without a secret', async () => {
      const channel = await create(alice, { type: 'feishu', config: { webhookUrl: webhookUrl() } });
      expect(channel.name).toBe('飞书机器人');
      expect(channel.config).toMatchObject({ secret: null });
      expect((await api(alice, 'POST', `/api/notification-channels/${channel.id}/test`)).statusCode).toBe(200);
      const [request] = await hook.waitForRequests(1);
      expect(Object.keys(request?.json as object).sort()).toEqual(['content', 'msg_type']);
    });

    it('reports the reason when 飞书 rejects the message', async () => {
      const channel = await create(alice, { type: 'feishu', config: { webhookUrl: webhookUrl(), secret: 'wrong-secret' } });
      hook.replyNext({ status: 200, body: { code: 19021, msg: 'sign match fail or timestamp is not within one hour from current time' } });
      const res = await api(alice, 'POST', `/api/notification-channels/${channel.id}/test`);
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({
        error: {
          code: 'channel_send_failed',
          message: '飞书返回错误 19021：sign match fail or timestamp is not within one hour from current time',
        },
      });

      hook.replyNext({ status: 404, body: { code: 19001, msg: 'param invalid: incoming webhook access token invalid' } });
      const notFound = await api(alice, 'POST', `/api/notification-channels/${channel.id}/test`);
      expect(notFound.json().error.message).toBe('飞书返回 HTTP 404：param invalid: incoming webhook access token invalid');
    });

    it('reports an unreachable Webhook', async () => {
      const channel = await create(alice, { type: 'feishu', config: { webhookUrl: `http://127.0.0.1:${await closedPort()}/hook` } });
      const res = await api(alice, 'POST', `/api/notification-channels/${channel.id}/test`);
      expect(res.statusCode).toBe(502);
      expect(res.json().error.message).toMatch(/^无法连接飞书 Webhook：.*ECONNREFUSED/);
    });
  });

  describe('邮件', () => {
    it('delivers the test message to the recipient with subject and body', async () => {
      smtp = await startFakeSmtp({ credentials: { username: 'me@qq.com', password: 'qq-auth-code-1234' } });
      const channel = await create(alice, {
        type: 'email',
        name: 'QQ 邮箱',
        config: {
          host: smtp.host,
          port: smtp.port,
          security: 'none',
          username: 'me@qq.com',
          password: 'qq-auth-code-1234',
          to: 'inbox@example.com',
        },
      });
      const res = await api(alice, 'POST', `/api/notification-channels/${channel.id}/test`);
      expect(res.statusCode, res.body).toBe(200);

      const [mail] = await smtp.waitForMessages(1);
      expect(mail).toMatchObject({ from: 'me@qq.com', to: ['inbox@example.com'] });
      const decoded = decodeMail(mail!.raw);
      expect(decoded.subject).toBe('叮叮清单测试消息');
      expect(decoded.text).toContain('「QQ 邮箱」');
      expect(decoded.text).toContain('配置正确');
    });

    it('reports a rejected 授权码', async () => {
      smtp = await startFakeSmtp({ credentials: { username: 'me@qq.com', password: 'right' } });
      const channel = await create(alice, {
        type: 'email',
        config: { host: smtp.host, port: smtp.port, security: 'none', username: 'me@qq.com', password: 'wrong', to: 'me@qq.com' },
      });
      const res = await api(alice, 'POST', `/api/notification-channels/${channel.id}/test`);
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toEqual({
        code: 'channel_send_failed',
        message: expect.stringMatching(/^SMTP 登录失败，请检查账号和授权码（535 .*Authentication credentials invalid/),
      });
      expect(smtp.messages).toHaveLength(0);
    });

    it('reports a refused delivery and an unreachable server', async () => {
      smtp = await startFakeSmtp();
      smtp.failNext(451);
      const channel = await create(alice, {
        type: 'email',
        config: { host: smtp.host, port: smtp.port, security: 'none', username: 'me@qq.com', password: 'x', to: 'me@qq.com' },
      });
      const refused = await api(alice, 'POST', `/api/notification-channels/${channel.id}/test`);
      expect(refused.json().error.message).toMatch(/^邮件服务器拒绝了这封邮件（451 fake failure）/);

      const offline = await create(alice, {
        type: 'email',
        config: { host: '127.0.0.1', port: 1, security: 'none', username: 'me@qq.com', password: 'x', to: 'me@qq.com' },
      });
      const res = await api(alice, 'POST', `/api/notification-channels/${offline.id}/test`);
      expect(res.statusCode).toBe(502);
      expect(res.json().error.message).toMatch(/^无法连接 SMTP 服务器 127\.0\.0\.1:1/);
    });
  });

  describe('credentials', () => {
    it('are encrypted at rest and masked in every response', async () => {
      const created = await create(alice, {
        type: 'feishu',
        config: { webhookUrl: webhookUrl(), secret: 'feishu-sign-secret-xyz' },
      });
      const mail = await create(alice, {
        type: 'email',
        config: { ...QQ_MAIL_PRESET, username: 'me@qq.com', password: 'qq-auth-code-5678', to: 'me@qq.com' },
      });
      expect(created.config).toEqual({ webhookUrl: `${hook.url}/****90ab`, secret: '****-xyz' });
      expect(mail.config).toEqual({
        host: 'smtp.qq.com',
        port: 465,
        security: 'ssl',
        username: 'me@qq.com',
        password: '****5678',
        to: 'me@qq.com',
      });

      const everything = [
        await rawRows(),
        (await api(alice, 'GET', '/api/notification-channels')).body,
        (await api(alice, 'GET', '/api/changes?since=0')).body,
      ];
      for (const text of everything) {
        for (const secret of ['0f1e2d3c-aaaa-bbbb-cccc-1234567890ab', 'feishu-sign-secret-xyz', 'qq-auth-code-5678']) {
          expect(text).not.toContain(secret);
        }
      }
      const changes = changesResponseSchema.parse((await api(alice, 'GET', '/api/changes?since=0')).json());
      const synced = changes.entities.notificationChannel?.upserts.find((u) => u.id === mail.id);
      expect(synced).toMatchObject({ type: 'email', config: { password: '****5678' } });
      expect(synced).not.toHaveProperty('credentials');
    });

    it('keep their stored value when an update leaves them out or empty', async () => {
      const channel = await create(alice, {
        type: 'feishu',
        name: '旧名字',
        config: { webhookUrl: webhookUrl(), secret: 'feishu-sign-secret' },
      });
      const renamed = await api(alice, 'PATCH', `/api/notification-channels/${channel.id}`, {
        name: '新名字',
        config: { webhookUrl: '', secret: '' },
      });
      expect(renamed.statusCode, renamed.body).toBe(200);
      expect(renamed.json()).toMatchObject({ name: '新名字', config: channel.config });

      await api(alice, 'POST', `/api/notification-channels/${channel.id}/test`);
      const [request] = await hook.waitForRequests(1);
      expect(request?.json).toMatchObject({ sign: '81UKnZwmqUfLTAmVXCJI/p9Uyd3qqw5dsBo4h1tXz2w=' });

      // `secret: null` turns signing off; a new URL replaces the old one.
      hook.requests.length = 0;
      const changed = await api(alice, 'PATCH', `/api/notification-channels/${channel.id}`, {
        config: { webhookUrl: `${hook.url}/other-hook-token-9999`, secret: null },
      });
      expect(changed.json().config).toEqual({ webhookUrl: `${hook.url}/****9999`, secret: null });
      await api(alice, 'POST', `/api/notification-channels/${channel.id}/test`);
      const [second] = await hook.waitForRequests(1);
      expect(second?.path).toBe('/other-hook-token-9999');
      expect(second?.json).not.toHaveProperty('sign');
    });

    it('keeps the 授权码 when only the SMTP settings change', async () => {
      smtp = await startFakeSmtp({ credentials: { username: 'me@qq.com', password: 'kept-auth-code' } });
      const channel = await create(alice, {
        type: 'email',
        config: { host: 'smtp.example.com', port: 25, security: 'none', username: 'me@qq.com', password: 'kept-auth-code', to: 'a@example.com' },
      });
      const res = await api(alice, 'PATCH', `/api/notification-channels/${channel.id}`, {
        config: { host: smtp.host, port: smtp.port, to: 'b@example.com', password: '' },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect((await api(alice, 'POST', `/api/notification-channels/${channel.id}/test`)).statusCode).toBe(200);
      const [mail] = await smtp.waitForMessages(1);
      expect(mail).toMatchObject({ to: ['b@example.com'], auth: { password: 'kept-auth-code' } });
    });

    it('rejects config fields of the other channel type', async () => {
      const channel = await create(alice, { type: 'feishu', config: { webhookUrl: webhookUrl() } });
      const res = await api(alice, 'PATCH', `/api/notification-channels/${channel.id}`, { config: { host: 'smtp.qq.com' } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('invalid_request');
    });
  });

  describe('validation', () => {
    it.each([
      ['missing Webhook URL', { type: 'feishu', config: {} }],
      ['non-http Webhook URL', { type: 'feishu', config: { webhookUrl: 'ftp://example.com/hook' } }],
      ['missing 授权码', { type: 'email', config: { ...QQ_MAIL_PRESET, username: 'me@qq.com', to: 'me@qq.com' } }],
      ['bad recipient', { type: 'email', config: { ...QQ_MAIL_PRESET, username: 'me', password: 'x', to: 'not-an-email' } }],
      ['unknown type', { type: 'wechat', config: {} }],
    ])('rejects %s', async (_label, payload) => {
      const res = await api(alice, 'POST', '/api/notification-channels', payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('invalid_request');
    });
  });

  describe('default channels', () => {
    it('one or several channels can be default; the notifier sends to each of them', async () => {
      const carol = await t.createUser('carol');
      smtp = await startFakeSmtp();
      const a = await create(carol, { type: 'feishu', name: 'A', isDefault: true, config: { webhookUrl: `${hook.url}/a` } });
      clock.advance(1000);
      const b = await create(carol, { type: 'feishu', name: 'B', config: { webhookUrl: `${hook.url}/b` } });
      clock.advance(1000);
      const c = await create(carol, {
        type: 'email',
        name: 'C',
        config: { host: smtp.host, port: smtp.port, security: 'none', username: 'c@example.com', password: 'x', to: 'c@example.com' },
      });
      expect(a.isDefault).toBe(true);
      expect(b.isDefault).toBe(false);
      await api(carol, 'PATCH', `/api/notification-channels/${c.id}`, { isDefault: true });

      expect((await list(carol)).filter((ch) => ch.isDefault).map((ch) => ch.name)).toEqual(['A', 'C']);
      expect(await t.app.notifier.defaultChannelIds(carol.id)).toEqual([a.id, c.id]);

      const results = await Promise.all(
        (await t.app.notifier.defaultChannelIds(carol.id)).map((id) =>
          t.app.notifier.send(carol.id, id, { title: '提醒：交周报', body: '今天 18:00' }),
        ),
      );
      expect(results).toEqual([{ ok: true }, { ok: true }]);
      const [request] = await hook.waitForRequests(1);
      expect(request?.path).toBe('/a');
      expect(request?.json).toEqual({ msg_type: 'text', content: { text: '提醒：交周报\n今天 18:00' } });
      const [mail] = await smtp.waitForMessages(1);
      expect(decodeMail(mail!.raw)).toMatchObject({ subject: '提醒：交周报', text: expect.stringContaining('今天 18:00') });
    });

    it('the notifier answers a missing or foreign channel without sending', async () => {
      const channel = await create(bob, { type: 'feishu', config: { webhookUrl: webhookUrl() } });
      expect(await t.app.notifier.send(alice.id, channel.id, { title: 'x', body: 'y' })).toEqual({
        ok: false,
        error: '通知渠道不存在',
        retryable: false,
      });
      expect(await t.app.notifier.send(alice.id, randomUUID(), { title: 'x', body: 'y' })).toMatchObject({ ok: false });
      expect(hook.requests).toHaveLength(0);
    });

    it('marks transient failures retryable and configuration errors not', async () => {
      const channel = await create(alice, { type: 'feishu', config: { webhookUrl: webhookUrl() } });
      hook.replyNext({ status: 503 }, { status: 200, body: { code: 19021, msg: 'sign match fail' } });
      expect(await t.app.notifier.send(alice.id, channel.id, { title: 'x', body: 'y' })).toMatchObject({ ok: false, retryable: true });
      expect(await t.app.notifier.send(alice.id, channel.id, { title: 'x', body: 'y' })).toMatchObject({ ok: false, retryable: false });
    });
  });

  describe('isolation and deletion', () => {
    it("another user's channel looks missing for every endpoint", async () => {
      const channel = await create(bob, { type: 'feishu', name: 'bob', config: { webhookUrl: webhookUrl() } });
      expect((await list(alice)).map((c) => c.id)).not.toContain(channel.id);
      for (const [method, url, payload] of [
        ['PATCH', `/api/notification-channels/${channel.id}`, { name: 'hacked' }],
        ['DELETE', `/api/notification-channels/${channel.id}`, undefined],
        ['POST', `/api/notification-channels/${channel.id}/test`, undefined],
        ['PATCH', '/api/notification-channels/not-a-uuid', { name: 'x' }],
      ] as const) {
        const res = await api(alice, method, url, payload);
        expect(res.statusCode, `${method} ${url}`).toBe(404);
      }
      expect(hook.requests).toHaveLength(0);
      expect((await list(bob)).find((c) => c.id === channel.id)?.name).toBe('bob');
    });

    it('deleting leaves a tombstone and the channel stops sending', async () => {
      const channel = await create(alice, { type: 'feishu', config: { webhookUrl: webhookUrl() } });
      clock.advance(1000);
      expect((await api(alice, 'DELETE', `/api/notification-channels/${channel.id}`)).statusCode).toBe(204);
      expect((await list(alice)).map((c) => c.id)).not.toContain(channel.id);
      expect((await api(alice, 'POST', `/api/notification-channels/${channel.id}/test`)).statusCode).toBe(404);
      const changes = changesResponseSchema.parse((await api(alice, 'GET', `/api/changes?since=${channel.revision}`)).json());
      expect(changes.entities.notificationChannel?.tombstones.map((x) => x.id)).toContain(channel.id);
    });
  });
});

describe('notification channels without APP_ENCRYPTION_KEY', () => {
  let t: TestApp;
  let user: TestUser;
  beforeAll(async () => {
    t = await createTestApp({ env: { APP_ENCRYPTION_KEY: '' } });
    user = await t.createUser('dave');
  });
  afterAll(() => t.close());

  it('refuses to store credentials and says what to configure', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/notification-channels',
      headers: user.headers,
      payload: { type: 'feishu', config: { webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/x' } },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toEqual({
      code: 'encryption_key_missing',
      message: '服务器未配置 APP_ENCRYPTION_KEY，无法保存通知渠道凭证',
    });
    expect((await t.app.inject({ method: 'GET', url: '/api/notification-channels', headers: user.headers })).json()).toEqual({
      channels: [],
    });
  });
});
