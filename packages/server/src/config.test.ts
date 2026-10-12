import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' };

describe('loadConfig', () => {
  it('defaults to listening on port 8090 with Asia/Shanghai', () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({
      host: '0.0.0.0',
      port: 8090,
      publicUrl: 'http://127.0.0.1:8090',
      defaultTimezone: 'Asia/Shanghai',
      dataDir: '/data',
      trustProxy: ['loopback', 'linklocal', 'uniquelocal'],
    });
  });

  it('reads port, host and PUBLIC_URL from the environment', () => {
    const config = loadConfig({
      ...base,
      HOST: '127.0.0.1',
      PORT: '9000',
      PUBLIC_URL: 'https://todo.example.com/',
    });
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 9000,
      publicUrl: 'https://todo.example.com',
    });
  });

  it.each([
    ['true', true],
    ['false', false],
    ['2', 2],
    ['10.0.0.0/8, 192.168.1.1', ['10.0.0.0/8', '192.168.1.1']],
  ])('parses TRUST_PROXY=%s', (value, expected) => {
    expect(loadConfig({ ...base, TRUST_PROXY: value }).trustProxy).toEqual(expected);
  });

  it('rejects missing DATABASE_URL and invalid values with a readable message', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ ...base, PORT: '70000' })).toThrow(/PORT/);
    expect(() => loadConfig({ ...base, PUBLIC_URL: 'not a url' })).toThrow(/PUBLIC_URL/);
  });
});
