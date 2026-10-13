// 集成测试：在临时配置目录 + 本机 HTTP 服务上真正运行 screenshot.mjs，
// 检查页面发出的各种写请求是否到达服务端。不碰 ~/.dida-reference，也不访问 dida365.com。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const tool = path.join(here, '..', 'screenshot.mjs');

const PAGE = `<!doctype html><title>readonly-probe</title>
<form id="f" method="POST" action="/form-post" target="sink"><input name="a" value="1"></form>
<iframe name="sink"></iframe>
<img src="/img-get">
<script>
  fetch('/fetch-post', { method: 'POST', body: 'x' }).catch(() => {});
  fetch('/fetch-put', { method: 'PUT', body: 'x' }).catch(() => {});
  fetch('/fetch-patch', { method: 'PATCH', body: 'x' }).catch(() => {});
  fetch('/fetch-delete', { method: 'DELETE' }).catch(() => {});
  navigator.sendBeacon('/beacon', 'x');
  const x = new XMLHttpRequest(); x.open('POST', '/xhr-post'); x.send('x');
  document.getElementById('f').submit();
  try { new WebSocket('ws://' + location.host + '/ws'); } catch (e) {}
</script>`;

function run(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [tool, ...args], { env: { ...process.env, ...env } });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

test('screenshot.mjs lets no write request or websocket reach the server', { skip: !hasChromium && 'Chromium 未安装' }, async () => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    } else {
      res.writeHead(204);
      res.end();
    }
  });
  server.on('upgrade', (req, socket) => {
    seen.push(`UPGRADE ${req.url}`);
    socket.destroy();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const home = mkdtempSync(path.join(tmpdir(), 'ref-env-it-'));
  mkdirSync(path.join(home, 'profile'), { mode: 0o700 });
  try {
    const shot = path.join(home, 'shot.png');
    const r = await run([`http://127.0.0.1:${port}/`, '-o', shot, '--wait', '1500'], { DIDA_REF_HOME: home });
    assert.equal(r.code, 0, r.err);
    assert.ok(existsSync(shot), 'screenshot written');
    assert.ok(seen.includes('GET /'), `page loaded: ${seen}`);
    const writes = seen.filter((s) => !/^(GET|HEAD|OPTIONS) /.test(s));
    assert.deepEqual(writes, [], `requests that reached the server: ${writes.join(', ')}`);
    const { blockedRequests } = JSON.parse(r.out);
    assert.ok(blockedRequests.some((b) => /^WS ws:\/\/127\.0\.0\.1:\d+\/ws$/.test(b)), `websocket recorded: ${blockedRequests}`);
    assert.ok(blockedRequests.some((b) => b.startsWith('POST ')), `post recorded: ${blockedRequests}`);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});
