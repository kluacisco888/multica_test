// 集成测试：在临时配置目录 + 本机 HTTP 服务上真正运行 screenshot.mjs，
// 检查页面发出的各种写请求是否到达服务端。不碰 ~/.dida-reference，也不访问 dida365.com。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

// ---- 导航脚本（ADR-0008）----

const NAV_PAGE = `<!doctype html><title>nav-probe</title>
<nav><button id="month">月</button><button id="week">周</button><button id="del">删除</button><input id="q" aria-label="搜索"></nav>
<main id="view">空</main>
<script>
  document.getElementById('month').onclick = () => {
    document.getElementById('view').textContent = '月视图';
    fetch('/track', { method: 'POST', body: 'click' }).catch(() => {});
  };
  document.getElementById('week').onclick = () => { document.getElementById('view').textContent = '周视图'; };
  document.getElementById('del').onclick = () => { fetch('/delete-get-probe').catch(() => {}); };
</script>`;

async function navServer(seen) {
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(NAV_PAGE);
    } else {
      res.writeHead(204);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server;
}

test('--script clicks navigation controls, takes the shots, still blocks writes', { skip: !hasChromium && 'Chromium 未安装' }, async () => {
  const seen = [];
  const server = await navServer(seen);
  const home = mkdtempSync(path.join(tmpdir(), 'ref-env-it-'));
  mkdirSync(path.join(home, 'profile'), { mode: 0o700 });
  try {
    const script = path.join(home, 'nav.json');
    writeFileSync(
      script,
      JSON.stringify([
        { click: 'text=月' },
        { waitFor: 'text=月视图' },
        { screenshot: 'month.png' },
        { hover: '#week' },
        { click: 'role=button[name="周"]' },
        { waitFor: 'text=周视图' },
      ]),
    );
    const shot = path.join(home, 'final.png');
    const r = await run([`http://127.0.0.1:${server.address().port}/`, '-o', shot, '--wait', '200', '--script', script], { DIDA_REF_HOME: home });
    assert.equal(r.code, 0, r.err);
    const out = JSON.parse(r.out);
    assert.ok(existsSync(path.join(home, 'month.png')), 'step screenshot written next to -o');
    assert.ok(existsSync(shot), 'final screenshot written');
    assert.deepEqual(out.screenshots, [path.join(home, 'month.png'), shot]);
    assert.equal(out.steps.length, 6);
    assert.ok(out.blockedRequests.some((b) => /^POST .*\/track$/.test(b)), `click's POST recorded: ${out.blockedRequests}`);
    assert.deepEqual(seen.filter((s) => !/^(GET|HEAD|OPTIONS) /.test(s)), []);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('--script refuses to click a control that changes data, or an input', { skip: !hasChromium && 'Chromium 未安装' }, async () => {
  for (const target of ['text=删除', '#q']) {
    const seen = [];
    const server = await navServer(seen);
    const home = mkdtempSync(path.join(tmpdir(), 'ref-env-it-'));
    mkdirSync(path.join(home, 'profile'), { mode: 0o700 });
    try {
      const script = path.join(home, 'nav.json');
      writeFileSync(script, JSON.stringify([{ click: target }]));
      const r = await run([`http://127.0.0.1:${server.address().port}/`, '-o', path.join(home, 'x.png'), '--wait', '0', '--script', script], {
        DIDA_REF_HOME: home,
      });
      assert.notEqual(r.code, 0, `${target} should be refused`);
      assert.match(r.err, /拒绝/);
      assert.ok(!seen.includes('GET /delete-get-probe'), 'the handler never ran');
      assert.ok(!existsSync(path.join(home, 'x.png')));
    } finally {
      server.close();
      rmSync(home, { recursive: true, force: true });
    }
  }
});

// ---- 修饰键点击和右键（EURO-22）：新开的标签页/窗口和右键菜单里的写请求也要拦住 ----

const POPUP_PAGE = `<!doctype html><title>popup-probe</title>
<script>
  fetch('/popup-post', { method: 'POST', body: 'x' }).catch(() => {});
  navigator.sendBeacon('/popup-beacon', 'x');
  try { new WebSocket('ws://' + location.host + '/popup-ws'); } catch (e) {}
</script>`;

const MULTI_PAGE = `<!doctype html><title>multi-probe</title>
<ul>
  <li><a id="l1" href="/popup">一</a></li>
  <li><a id="l2" href="/popup?shift">二</a></li>
  <li id="row">四</li>
</ul>
<main id="view">空</main>
<script>
  for (const a of document.querySelectorAll('a')) a.addEventListener('click', (e) => {
    fetch('/click-post?' + a.id + (e.ctrlKey ? '-ctrl' : '') + (e.shiftKey ? '-shift' : ''), { method: 'POST', body: 'x' }).catch(() => {});
  });
  document.getElementById('row').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    document.getElementById('view').textContent = '右键菜单';
    fetch('/contextmenu-post', { method: 'POST', body: 'x' }).catch(() => {});
    fetch('/contextmenu-delete', { method: 'DELETE' }).catch(() => {});
  });
</script>`;

test('--script modifier clicks and right clicks: new tabs and context menus still cannot write', { skip: !hasChromium && 'Chromium 未安装' }, async () => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(MULTI_PAGE);
    } else if (req.url.startsWith('/popup')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(POPUP_PAGE);
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
  const home = mkdtempSync(path.join(tmpdir(), 'ref-env-it-'));
  mkdirSync(path.join(home, 'profile'), { mode: 0o700 });
  try {
    const script = path.join(home, 'multi.json');
    writeFileSync(
      script,
      JSON.stringify([
        { click: '#l1', modifiers: ['Control'] }, // new background tab
        { click: '#l2', modifiers: ['Shift'] }, // new window
        { click: '#view', modifiers: ['Meta'] }, // on Linux Meta+click on a link navigates in place, so click plain text
        { click: '#row', button: 'right' },
        { waitFor: 'text=右键菜单' },
        { wait: 1500 },
      ]),
    );
    const shot = path.join(home, 'final.png');
    const r = await run([`http://127.0.0.1:${server.address().port}/`, '-o', shot, '--wait', '200', '--script', script], { DIDA_REF_HOME: home });
    assert.equal(r.code, 0, r.err);
    const out = JSON.parse(r.out);
    // The new tabs did open (their GET reached the server) …
    assert.ok(seen.some((s) => s.startsWith('GET /popup')), `a new tab was opened: ${seen}`);
    // … but nothing from them, from the click handlers or from the context menu wrote anything.
    assert.deepEqual(seen.filter((s) => !/^(GET|HEAD|OPTIONS) /.test(s)), []);
    assert.ok(out.blockedRequests.some((b) => /^POST .*\/contextmenu-post$/.test(b)), `context menu POST recorded: ${out.blockedRequests}`);
    assert.ok(out.blockedRequests.some((b) => /^POST .*\/popup-post$/.test(b)), `new tab POST recorded: ${out.blockedRequests}`);
    assert.ok(out.blockedRequests.some((b) => /^WS .*\/popup-ws$/.test(b)), `new tab websocket recorded: ${out.blockedRequests}`);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('--script refuses a right click or a modifier click on a control that changes data', { skip: !hasChromium && 'Chromium 未安装' }, async () => {
  for (const step of [
    { click: 'text=删除', button: 'right' },
    { click: 'text=删除', modifiers: ['Shift'] },
    { click: '#q', modifiers: ['Control'] },
  ]) {
    const seen = [];
    const server = await navServer(seen);
    const home = mkdtempSync(path.join(tmpdir(), 'ref-env-it-'));
    mkdirSync(path.join(home, 'profile'), { mode: 0o700 });
    try {
      const script = path.join(home, 'nav.json');
      writeFileSync(script, JSON.stringify([step]));
      const r = await run([`http://127.0.0.1:${server.address().port}/`, '-o', path.join(home, 'x.png'), '--wait', '0', '--script', script], {
        DIDA_REF_HOME: home,
      });
      assert.notEqual(r.code, 0, `${JSON.stringify(step)} should be refused`);
      assert.match(r.err, /拒绝/);
      assert.ok(!seen.includes('GET /delete-get-probe'), 'the handler never ran');
    } finally {
      server.close();
      rmSync(home, { recursive: true, force: true });
    }
  }
});
