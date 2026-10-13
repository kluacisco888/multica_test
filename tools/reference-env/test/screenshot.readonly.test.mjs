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
  <li><span id="wrap" style="display: inline-block; padding: 2px"><span role="link" tabindex="0" onclick="window.open('/popup?role')">三</span></span></li>
  <li id="row">四</li>
  <li id="opener">五</li>
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
  // Plain text that opens a window from script: the tool must close it and fail.
  document.getElementById('opener').addEventListener('click', () => window.open('/popup?script', '_blank'));
</script>`;

/** A local page server for the modifier-click tests; `seen` collects every request it receives. */
async function multiServer(seen) {
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
  return server;
}

async function runScript(steps) {
  const seen = [];
  const server = await multiServer(seen);
  const home = mkdtempSync(path.join(tmpdir(), 'ref-env-it-'));
  mkdirSync(path.join(home, 'profile'), { mode: 0o700 });
  try {
    const script = path.join(home, 'multi.json');
    writeFileSync(script, JSON.stringify(steps));
    const shot = path.join(home, 'final.png');
    const r = await run([`http://127.0.0.1:${server.address().port}/`, '-o', shot, '--wait', '200', '--script', script], { DIDA_REF_HOME: home });
    // Give a leaked tab time to send what it would send.
    await new Promise((resolve) => setTimeout(resolve, 500));
    return { ...r, seen, shot: existsSync(shot) };
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
}

const writes = (seen) => seen.filter((s) => !/^(GET|HEAD|OPTIONS) /.test(s));

test('--script modifier clicks and right clicks: new tabs and context menus still cannot write', { skip: !hasChromium && 'Chromium 未安装' }, async () => {
  // A modifier click on a link would open a tab whose requests context.route never sees: refused before clicking.
  for (const step of [
    { click: '#l1', modifiers: ['Control'] }, // new background tab
    { click: '#l2', modifiers: ['Shift'] }, // new window
    { click: '#l1', modifiers: ['Meta'] },
    { click: '#wrap', modifiers: ['Control'] }, // the click lands on a [role=link] inside
  ]) {
    const r = await runScript([step]);
    assert.notEqual(r.code, 0, `${JSON.stringify(step)} should be refused`);
    assert.match(r.err, /拒绝.*链接/);
    assert.ok(!r.seen.some((s) => s.startsWith('GET /popup')), `no tab was opened: ${r.seen}`);
    assert.deepEqual(writes(r.seen), []);
    assert.ok(!r.shot, 'no screenshot after a refused step');
  }

  // Modifier clicks on plain text and right clicks still work, and write nothing.
  const r = await runScript([
    { click: '#view', modifiers: ['Meta'] },
    { click: '#row', modifiers: ['Shift'] },
    { click: '#row', button: 'right' },
    { waitFor: 'text=右键菜单' },
    { wait: 1000 },
  ]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(writes(r.seen), []);
  const out = JSON.parse(r.out);
  assert.ok(out.blockedRequests.some((b) => /^POST .*\/contextmenu-post$/.test(b)), `context menu POST recorded: ${out.blockedRequests}`);
  assert.ok(out.blockedRequests.some((b) => /^DELETE .*\/contextmenu-delete$/.test(b)), `context menu DELETE recorded: ${out.blockedRequests}`);
});

test('--script: any new tab or window is closed at once and fails the run', { skip: !hasChromium && 'Chromium 未安装' }, async () => {
  for (const step of [{ click: '#opener' }, { click: '#opener', modifiers: ['Shift'] }, { click: '#wrap' }]) {
    const r = await runScript([step, { wait: 1000 }]);
    assert.notEqual(r.code, 0, `${JSON.stringify(step)} opened a page and should fail`);
    assert.match(r.err, /新页面/);
    assert.ok(!r.seen.some((x) => x.startsWith('GET /popup')), `no tab was opened: ${r.seen}`);
    assert.deepEqual(writes(r.seen), []);
    assert.ok(!r.shot, 'no screenshot after a new page appeared');
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

// EURO-22 复审：脚本里的 form.submit() 不触发 submit 事件，target="_blank" 的表单照样开出新标签页，
// 新标签页的 sendBeacon 在它被关掉之前就到了服务器。
const FORM_PAGE = `<!doctype html><title>form-probe</title>
<form id="fm" action="/popup" target="_blank" method="GET"></form>
<p id="go">打开</p>
<script>document.getElementById('go').onclick = () => document.getElementById('fm').submit();</script>`;

test('--script: a form.submit() aimed at a new tab cannot write either', { skip: !hasChromium && 'Chromium 未安装' }, async () => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FORM_PAGE);
    } else if (req.url.startsWith('/popup')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(POPUP_PAGE);
    } else {
      res.writeHead(204);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const home = mkdtempSync(path.join(tmpdir(), 'ref-env-it-'));
  mkdirSync(path.join(home, 'profile'), { mode: 0o700 });
  try {
    const script = path.join(home, 'form.json');
    writeFileSync(script, JSON.stringify([{ click: '#go' }, { wait: 1500 }]));
    const r = await run([`http://127.0.0.1:${server.address().port}/`, '-o', path.join(home, 'x.png'), '--wait', '200', '--script', script], { DIDA_REF_HOME: home });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.notEqual(r.code, 0, 'a page that opens a new tab fails the run');
    assert.deepEqual(seen.filter((s) => !/^(GET|HEAD|OPTIONS) /.test(s)), [], `requests that reached the server: ${seen.join(', ')}`);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});
