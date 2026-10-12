import { afterEach, describe, expect, it } from 'vitest';
import { startFakeWebhook, type FakeWebhookServer } from './fake-webhook.js';

describe('fake Webhook receiver', () => {
  let hook: FakeWebhookServer;
  afterEach(() => hook.close());

  it('records method, path, headers and JSON body, answering like a Feishu bot', async () => {
    hook = await startFakeWebhook();
    const res = await fetch(`${hook.url}/open-apis/bot/v2/hook/abc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text: '交周报' } }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ code: 0, msg: 'success' });

    const [request] = await hook.waitForRequests(1);
    expect(request).toMatchObject({
      method: 'POST',
      path: '/open-apis/bot/v2/hook/abc',
      json: { msg_type: 'text', content: { text: '交周报' } },
      status: 200,
    });
    expect(request?.headers['content-type']).toBe('application/json');
  });

  it('replays queued failures before returning to success', async () => {
    hook = await startFakeWebhook();
    hook.replyNext({ status: 500 }, { status: 200, body: { code: 19021, msg: 'sign match fail' } });

    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await fetch(hook.url, { method: 'POST', body: '{}' });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([500, 200, 200]);
    expect(hook.requests.map((r) => r.status)).toEqual([500, 200, 200]);
  });
});
