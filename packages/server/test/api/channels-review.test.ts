import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { changesResponseSchema, notificationChannelSchema, QQ_MAIL_PRESET } from '@dida/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { startFakeSmtp, type FakeSmtpServer } from '../fakes/fake-smtp.js';
import { startFakeWebhook, type FakeWebhookServer } from '../fakes/fake-webhook.js';
import { createTestApp, type TestApp, type TestUser } from '../support/test-app.js';

/*
 * EURO-11 review: edge cases for 通知渠道 on top of channels.test.ts —
 * signatures after a secret change, credential retention across partial
 * updates, plaintext never reaching the DB / list / changes feed (including
 * after updates and deletes), and malformed / duplicate / unauthenticated input.
 */

const NOW = '2023-11-14T22:13:20.000Z'; // unix 1700000000
// Independently computed: python3 hmac.new(b"1700000000\nnew-secret-abc", b"", sha256), base64.
const SIGN_NEW_SECRET = 'J3GD8PCj7N5LWg+K+EK7Mu9YICOPdqlDSsaUEr316JE=';

describe('notification channels — review edge cases', () => {
  const clock = fixedClock(NOW);
  let t: TestApp;
  let erin: TestUser;
  let hook: FakeWebhookServer;
  let smtp: FakeSmtpServer | undefined;

  beforeAll(async () => {
    t = await createTestApp({ clock });
    erin = await t.createUser('erin');
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

  const api = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object, headers = erin.headers) =>
    t.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
  const token = 'review-hook-token-7f3a2b1c9d8e';
  const webhookUrl = () => `${hook.url}/open-apis/bot/v2/hook/${token}`;

  async function create(payload: object) {
    const res = await api('POST', '/api/notification-channels', payload);
    expect(res.statusCode, res.body).toBe(201);
    return notificationChannelSchema.parse(res.json());
  }
  const rawRows = async () => JSON.stringify((await t.database.db.execute(sql`SELECT * FROM notification_channels`)).rows);
  const sendTest = (id: string) => api('POST', `/api/notification-channels/${id}/test`);

  it('a whitespace-only secret on create means no signature', async () => {
    const channel = await create({ type: 'feishu', config: { webhookUrl: webhookUrl(), secret: '   ' } });
    expect(channel.config).toMatchObject({ secret: null });
    expect((await sendTest(channel.id)).statusCode).toBe(200);
    const [request] = await hook.waitForRequests(1);
    expect(request?.json).not.toHaveProperty('sign');
    expect(request?.json).not.toHaveProperty('timestamp');
  });

  it('adding a secret later keeps the URL and signs with the new secret', async () => {
    const channel = await create({ type: 'feishu', config: { webhookUrl: webhookUrl() } });
    const res = await api('PATCH', `/api/notification-channels/${channel.id}`, { config: { secret: 'new-secret-abc' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().config).toEqual({ ...channel.config, secret: '****-abc' });
    expect((await sendTest(channel.id)).statusCode).toBe(200);
    const [request] = await hook.waitForRequests(1);
    expect(request?.path).toBe(`/open-apis/bot/v2/hook/${token}`);
    expect(request?.json).toMatchObject({ timestamp: '1700000000', sign: SIGN_NEW_SECRET });
    expect(await rawRows()).not.toContain('new-secret-abc');
  });

  it.each([
    ['empty body', {}],
    ['empty config', { config: {} }],
    ['only isDefault', { isDefault: true }],
    ['whitespace secret', { config: { secret: '  ' } }],
  ])('PATCH with %s keeps the stored 飞书 credentials', async (_label, patch) => {
    const channel = await create({ type: 'feishu', config: { webhookUrl: webhookUrl(), secret: 'new-secret-abc' } });
    const res = await api('PATCH', `/api/notification-channels/${channel.id}`, patch);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().config).toEqual(channel.config);
    expect((await sendTest(channel.id)).statusCode).toBe(200);
    const [request] = await hook.waitForRequests(1);
    expect(request?.path).toBe(`/open-apis/bot/v2/hook/${token}`);
    expect(request?.json).toMatchObject({ sign: SIGN_NEW_SECRET });
  });

  it('changing the 邮件 account / encryption without 授权码 keeps the stored 授权码', async () => {
    smtp = await startFakeSmtp({ credentials: { username: 'new@qq.com', password: 'review-auth-code-1' } });
    const channel = await create({
      type: 'email',
      config: { ...QQ_MAIL_PRESET, username: 'old@qq.com', password: 'review-auth-code-1', to: 'old@qq.com' },
    });
    const res = await api('PATCH', `/api/notification-channels/${channel.id}`, {
      name: '改过的邮箱',
      config: { host: smtp.host, port: smtp.port, security: 'none', username: 'new@qq.com', to: 'to@example.com' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().config.password).toBe('****de-1');
    expect((await sendTest(channel.id)).statusCode).toBe(200);
    const [mail] = await smtp.waitForMessages(1);
    expect(mail).toMatchObject({ to: ['to@example.com'], auth: { username: 'new@qq.com', password: 'review-auth-code-1' } });
  });

  it('no plaintext credential in DB, list or /api/changes after create, update and delete', async () => {
    const secrets = ['review-secret-before-1', 'review-secret-after-22', 'review-pass-before-33', 'review-pass-after-444', token];
    const feishu = await create({ type: 'feishu', config: { webhookUrl: webhookUrl(), secret: secrets[0] } });
    const mail = await create({
      type: 'email',
      config: { ...QQ_MAIL_PRESET, username: 'me@qq.com', password: secrets[2], to: 'me@qq.com' },
    });
    await api('PATCH', `/api/notification-channels/${feishu.id}`, { config: { secret: secrets[1] } });
    await api('PATCH', `/api/notification-channels/${mail.id}`, { config: { password: secrets[3] } });
    expect((await api('DELETE', `/api/notification-channels/${mail.id}`)).statusCode).toBe(204);

    const changes = await api('GET', '/api/changes?since=0');
    const everything = [await rawRows(), (await api('GET', '/api/notification-channels')).body, changes.body];
    for (const text of everything) for (const s of secrets) expect(text).not.toContain(s);
    const parsed = changesResponseSchema.parse(changes.json());
    expect(parsed.entities.notificationChannel?.tombstones.map((x) => x.id)).toContain(mail.id);
    for (const upsert of parsed.entities.notificationChannel?.upserts ?? []) {
      expect(upsert).not.toHaveProperty('credentials');
      expect(upsert).not.toHaveProperty('credentialHints');
      expect(upsert).not.toHaveProperty('userId');
    }
  });

  it.each([
    ['no body', undefined],
    ['overlong Webhook URL', { type: 'feishu', config: { webhookUrl: `https://open.feishu.cn/${'a'.repeat(2100)}` } }],
    ['overlong secret', { type: 'feishu', config: { webhookUrl: 'https://open.feishu.cn/h', secret: 'x'.repeat(600) } }],
    ['javascript: URL', { type: 'feishu', config: { webhookUrl: 'javascript:alert(1)' } }],
    ['port out of range', { type: 'email', config: { ...QQ_MAIL_PRESET, port: 70000, username: 'a', password: 'b', to: 'a@b.cn' } }],
    ['SMTP host with CRLF', { type: 'email', config: { ...QQ_MAIL_PRESET, host: 'smtp.qq.com\r\nRCPT', username: 'a', password: 'b', to: 'a@b.cn' } }],
    ['recipient header injection', { type: 'email', config: { ...QQ_MAIL_PRESET, username: 'a', password: 'b', to: 'a@b.cn\r\nBcc: x@y.cn' } }],
    ['extra top-level field', { type: 'feishu', config: { webhookUrl: 'https://open.feishu.cn/h' }, credentials: 'x' }],
  ])('POST rejects %s with 400', async (_label, payload) => {
    const res = await api('POST', '/api/notification-channels', payload);
    expect(res.statusCode, res.body).toBe(400);
  });

  it('PATCH rejects changing the channel type and invalid credential formats', async () => {
    const channel = await create({ type: 'feishu', config: { webhookUrl: webhookUrl() } });
    for (const patch of [{ type: 'email' }, { config: { webhookUrl: 'not a url' } }, { config: { secret: 'x'.repeat(600) } }]) {
      const res = await api('PATCH', `/api/notification-channels/${channel.id}`, patch);
      expect(res.statusCode, JSON.stringify(patch)).toBe(400);
    }
  });

  it('a duplicate client id is a 409, also when submitted concurrently', async () => {
    const id = randomUUID();
    const payload = { id, type: 'feishu', config: { webhookUrl: webhookUrl() } };
    const results = await Promise.all([1, 2, 3].map(() => api('POST', '/api/notification-channels', payload)));
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409, 409]);
    const rows = await t.database.db.execute(sql`SELECT count(*)::int AS n FROM notification_channels WHERE id = ${id}`);
    expect(rows.rows[0]).toEqual({ n: 1 });
  });

  it('requires a session for every endpoint', async () => {
    const id = randomUUID();
    for (const [method, url] of [
      ['GET', '/api/notification-channels'],
      ['POST', '/api/notification-channels'],
      ['PATCH', `/api/notification-channels/${id}`],
      ['DELETE', `/api/notification-channels/${id}`],
      ['POST', `/api/notification-channels/${id}/test`],
    ] as const) {
      const res = await api(method, url, { type: 'feishu', config: { webhookUrl: webhookUrl() } }, {});
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
    expect(hook.requests).toHaveLength(0);
  });
});
