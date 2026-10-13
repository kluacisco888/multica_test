import { healthResponseSchema } from '@dida/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../support/test-app.js';

describe('GET /api/health', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ env: { PUBLIC_URL: 'https://todo.example.com/' } });
  });
  afterAll(() => t.close());

  it('reports ok when the database answers', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = healthResponseSchema.parse(res.json());
    expect(body).toMatchObject({ status: 'ok', db: 'ok', publicUrl: 'https://todo.example.com' });
  });

  it('applies X-Forwarded-* headers from a trusted proxy', async () => {
    // inject() connects from 127.0.0.1, which the default TRUST_PROXY trusts.
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: {
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'todo.example.com',
        'x-forwarded-for': '203.0.113.7',
      },
    });
    expect(res.json().request).toEqual({
      protocol: 'https',
      host: 'todo.example.com',
      ip: '203.0.113.7',
    });
  });

  it('answers unknown API paths with a JSON 404', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'not_found', message: '资源不存在' } });
  });
});

describe('X-Forwarded-* from an untrusted peer', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ env: { TRUST_PROXY: 'false' } });
  });
  afterAll(() => t.close());

  it('is ignored', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: {
        host: 'internal:8090',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'evil.example.com',
        'x-forwarded-for': '203.0.113.7',
      },
    });
    expect(res.json().request).toEqual({ protocol: 'http', host: 'internal:8090', ip: '127.0.0.1' });
  });
});
