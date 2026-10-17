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

// EURO-22 第 2 轮：所有能开新页面的入口。每种都必须让运行失败，而且新页面一个请求都发不出去（连它自己的 GET 都没有），
// 服务器只看到首页的 GET。点击的都是普通文字（不带修饰键），新页面由页面脚本打开。
const ENTRIES = {
  'form.submit() target=_blank': `<form id="f" action="/popup" target="_blank"></form>`,
  'requestSubmit() target=_blank': `<form id="f" action="/popup" target="_blank"><button id="b">x</button></form>`,
  'requestSubmit(submitter) with formtarget=_blank': `<form id="f" action="/popup"><button id="b" formtarget="_blank">x</button></form>`,
  '<base target=_blank> + form.submit()': `<base target="_blank"><form id="f" action="/popup"></form>`,
  '<base target=_blank> + link click': `<base target="_blank"><a id="a" href="/popup">链接</a>`,
  'link to an unknown named window': `<a id="a" href="/popup" target="win1">链接</a>`,
  'form to an unknown named window': `<form id="f" action="/popup" target="win1"></form>`,
  'detached a.click()': ``,
  'detached anchor dispatchEvent(click)': ``,
  'open()': ``,
  'self.open()': ``,
  'Reflect.apply(open)': ``,
  "open(url, '_blank')": ``,
  'new iframe contentWindow.open()': ``,
  'new iframe realm form.submit()': `<form id="f" action="/popup" target="_blank"></form>`,
};

const ENTRY_JS = {
  'form.submit() target=_blank': `document.getElementById('f').submit()`,
  'requestSubmit() target=_blank': `document.getElementById('f').requestSubmit()`,
  'requestSubmit(submitter) with formtarget=_blank': `document.getElementById('f').requestSubmit(document.getElementById('b'))`,
  '<base target=_blank> + form.submit()': `document.getElementById('f').submit()`,
  '<base target=_blank> + link click': `document.getElementById('a').click()`,
  'link to an unknown named window': `document.getElementById('a').click()`,
  'form to an unknown named window': `document.getElementById('f').submit()`,
  'detached a.click()': `const a = document.createElement('a'); a.href = '/popup'; a.target = '_blank'; a.click()`,
  'detached anchor dispatchEvent(click)': `const a = document.createElement('a'); a.href = '/popup'; a.target = '_blank'; a.dispatchEvent(new MouseEvent('click'))`,
  'open()': `open('/popup')`,
  'self.open()': `self.open('/popup', 'w2', 'popup')`,
  'Reflect.apply(open)': `Reflect.apply(window['op' + 'en'], window, ['/popup', 'w3'])`,
  "open(url, '_blank')": `window.open('/popup?script', '_blank')`,
  'new iframe contentWindow.open()': `const f = document.createElement('iframe'); document.body.append(f); f.contentWindow.open('/popup')`,
  'new iframe realm form.submit()': `const f = document.createElement('iframe'); document.body.append(f); f.contentWindow.HTMLFormElement.prototype.submit.call(document.getElementById('f'))`,
};

test('--script: every way a page can open a new tab or window fails the run before the new page sends anything', { skip: !hasChromium && 'Chromium 未安装' }, async () => {
  for (const [name, html] of Object.entries(ENTRIES)) {
    const page = `<!doctype html><title>entry</title>${html}<p id="go">打开</p>
<script>document.getElementById('go').addEventListener('click', () => { try { ${ENTRY_JS[name]}; } catch (e) {} });</script>`;
    const seen = [];
    const server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page);
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
      const script = path.join(home, 'entry.json');
      writeFileSync(script, JSON.stringify([{ click: '#go' }, { wait: 1500 }]));
      const r = await run([`http://127.0.0.1:${server.address().port}/`, '-o', path.join(home, 'x.png'), '--wait', '200', '--script', script], { DIDA_REF_HOME: home });
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.notEqual(r.code, 0, `${name}: opening a new page fails the run`);
      assert.match(r.err, /新页面/, name);
      assert.ok(!existsSync(path.join(home, 'x.png')), `${name}: no screenshot`);
      assert.deepEqual(seen, ['GET /'], `${name}: requests that reached the server`);
    } finally {
      server.close();
      rmSync(home, { recursive: true, force: true });
    }
  }
});

// EURO-22 第 3 次审查：Worker / SharedWorker 里开的 WebSocket 不经过 context.routeWebSocket，
// 浏览器层的 Fetch 也不管 WebSocket，握手直接到达服务器（main 上的工具同样如此）。
const WORKER_WS_PAGE = `<!doctype html><title>worker-ws-probe</title>
<script>
  const host = location.host;
  const blob = (code) => URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  new Worker(blob("onmessage = (e) => { new WebSocket('ws://' + e.data + '/worker-ws'); };")).postMessage(host);
  new SharedWorker(blob("onconnect = (c) => { c.ports[0].onmessage = (e) => { new WebSocket('ws://' + e.data + '/shared-ws'); }; };")).port.postMessage(host);
</script>`;

test('WebSockets opened in a Worker or SharedWorker never reach the server', { skip: !hasChromium && 'Chromium 未安装' }, async () => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(req.url === '/' ? 200 : 204, { 'content-type': 'text/html; charset=utf-8' });
    res.end(req.url === '/' ? WORKER_WS_PAGE : undefined);
  });
  server.on('upgrade', (req, socket) => {
    seen.push(`UPGRADE ${req.url}`);
    socket.destroy();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const home = mkdtempSync(path.join(tmpdir(), 'ref-env-it-'));
  mkdirSync(path.join(home, 'profile'), { mode: 0o700 });
  try {
    await run([`http://127.0.0.1:${server.address().port}/`, '-o', path.join(home, 'x.png'), '--wait', '1500'], { DIDA_REF_HOME: home });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(seen.filter((s) => s.startsWith('UPGRADE ')), [], `websockets that reached the server: ${seen.join(', ')}`);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

// EURO-22 第 4 轮：worker 根本起不来（每个文档的响应都加上 CSP worker-src 'none'，由浏览器执行）。
// 各种起 worker 的写法都试一遍：同源脚本、blob、module、SharedWorker，以及继承文档策略的 about:blank / srcdoc / data: iframe 里起的。
const WORKER_ENTRIES = {
  'same-origin script': `new Worker('/w.js')`,
  'module worker': `new Worker('/w.js', { type: 'module' })`,
  'blob worker': `new Worker(URL.createObjectURL(new Blob([W])))`,
  'data: worker': `new Worker('data:text/javascript,' + encodeURIComponent(W))`,
  SharedWorker: `new SharedWorker('/w.js?shared')`,
  'about:blank iframe': `const f = document.createElement('iframe'); document.body.append(f); new f.contentWindow.Worker(f.contentWindow.URL.createObjectURL(new f.contentWindow.Blob([W])))`,
  'srcdoc iframe': `const f = document.createElement('iframe'); f.srcdoc = '<scr' + 'ipt>new Worker(URL.createObjectURL(new Blob([parent.W])))</scr' + 'ipt>'; document.body.append(f)`,
  'blob: iframe': `const f = document.createElement('iframe'); f.src = URL.createObjectURL(new Blob(['<scr' + 'ipt>new Worker(URL.createObjectURL(new Blob([parent.W])))</scr' + 'ipt>'], { type: 'text/html' })); document.body.append(f)`,
};

test('workers cannot start at all, however they are created; blocked workers are recorded', { skip: !hasChromium && 'Chromium 未安装' }, async () => {
  for (const [name, code] of Object.entries(WORKER_ENTRIES)) {
    const seen = [];
    const server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><title>w</title><body><script>
  window.W = "new WebSocket('ws://" + location.host + "/w-ws'); fetch('/w-post', { method: 'POST', body: 'x' });";
  const W = window.W;
  try { ${code}; } catch (e) {}
</script>`);
      } else if (req.url.startsWith('/w.js')) {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end("new WebSocket('ws://' + location.host + '/w-ws'); onconnect = () => {};");
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
      const r = await run([`http://127.0.0.1:${server.address().port}/`, '-o', path.join(home, 'x.png'), '--wait', '1500'], { DIDA_REF_HOME: home });
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(r.code, 0, `${name}: ${r.err}`);
      assert.deepEqual(seen.filter((s) => !/^(GET|HEAD|OPTIONS) /.test(s)), [], `${name}: requests that reached the server`);
      assert.ok(!seen.some((s) => s.startsWith('GET /w.js')), `${name}: the worker script was never fetched: ${seen}`);
      assert.ok(JSON.parse(r.out).blockedRequests.some((b) => b.startsWith('WORKER ')), `${name}: blocked worker recorded`);
    } finally {
      server.close();
      rmSync(home, { recursive: true, force: true });
    }
  }
});

// EURO-37：给文档加 worker 禁令要用 Fetch.fulfillRequest 改写响应，改写过的文档在浏览器看来没有 IP 地址空间，
// 它里面跨源的子 frame（另一个端口、另一个主机）被本地网络访问检查（Local Network Access）挡下，请求到不了服务器，运行却照样成功。
// 两个本机服务互为跨源：A 是 127.0.0.1，B 用 localhost（不同站点，走独立渲染进程）或 127.0.0.1 的另一个端口（同站不同源）。
async function twoOrigins(pageFor, frameHtml, bHost = 'localhost') {
  const seen = [];
  const handler = (name) => (req, res) => {
    seen.push(`${name} ${req.method} ${req.url}`);
    if (name === 'A' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(pageFor(b));
    } else if (name === 'A' && req.url === '/redir') {
      res.writeHead(302, { location: `${b.origin}/frame?redir` });
      res.end();
    } else if (name === 'B' && req.url.startsWith('/frame')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(frameHtml);
    } else {
      res.writeHead(204);
      res.end();
    }
  };
  const a = createServer(handler('A'));
  const b = createServer(handler('B'));
  for (const s of [a, b]) {
    s.on('upgrade', (req, socket) => {
      seen.push(`UPGRADE ${req.url}`);
      socket.destroy();
    });
  }
  await new Promise((r) => a.listen(0, '127.0.0.1', r));
  await new Promise((r) => b.listen(0, '127.0.0.1', r));
  b.origin = `http://${bHost}:${b.address().port}`;
  return { seen, url: `http://127.0.0.1:${a.address().port}/`, close: () => (a.close(), b.close()) };
}

// The frame's script tries a worker (must stay blocked) and says it ran with a GET (must arrive).
const CROSS_FRAME = `<!doctype html><title>cross</title><p>跨源</p><script>
  fetch('/frame-ran?' + location.search.slice(1)).catch(() => {});
  try { new Worker(URL.createObjectURL(new Blob(["fetch('/frame-worker-ran')"]))); } catch (e) {}
</script>`;

test('cross-origin iframes, iframes redirected cross-origin and cross-origin <object>s load, and their workers stay blocked', { skip: !hasChromium && 'Chromium 未安装' }, async () => {
  for (const host of ['localhost', '127.0.0.1']) {
    const env = await twoOrigins(
      (b) => `<!doctype html><title>frames</title>
<iframe src="${b.origin}/frame?iframe"></iframe>
<iframe src="/redir"></iframe>
<object type="text/html" data="${b.origin}/frame?object"></object>`,
      CROSS_FRAME,
      host,
    );
    const home = mkdtempSync(path.join(tmpdir(), 'ref-env-it-'));
    mkdirSync(path.join(home, 'profile'), { mode: 0o700 });
    try {
      const r = await run([env.url, '-o', path.join(home, 'x.png'), '--wait', '1500'], { DIDA_REF_HOME: home });
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(r.code, 0, `${host}: ${r.err}`);
      for (const which of ['iframe', 'redir', 'object']) {
        assert.ok(env.seen.includes(`B GET /frame-ran?${which}`), `${host}: the ${which} frame loaded and ran: ${env.seen}`);
      }
      assert.ok(!env.seen.some((s) => s.includes('/frame-worker-ran')), `${host}: a worker in a cross-origin frame ran: ${env.seen}`);
      assert.ok(JSON.parse(r.out).blockedRequests.some((b) => b.startsWith('WORKER ')), `${host}: blocked worker recorded`);
    } finally {
      env.close();
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test('a frame whose document cannot be loaded fails the run and names the frame', { skip: !hasChromium && 'Chromium 未安装' }, async () => {
  // Nothing listens on this port: the frame's document never arrives.
  const dead = createServer();
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const deadUrl = `http://127.0.0.1:${dead.address().port}/gone`;
  await new Promise((r) => dead.close(r));
  const seen = [];
  const server = await pageServer(`<!doctype html><title>dead-frame</title><iframe src="${deadUrl}"></iframe>`, seen);
  const home = mkdtempSync(path.join(tmpdir(), 'ref-env-it-'));
  mkdirSync(path.join(home, 'profile'), { mode: 0o700 });
  try {
    const shot = path.join(home, 'x.png');
    const r = await run([`http://127.0.0.1:${server.address().port}/`, '-o', shot, '--wait', '500'], { DIDA_REF_HOME: home });
    assert.notEqual(r.code, 0, 'a missing frame fails the run');
    assert.match(r.err, /没加载出来/);
    assert.ok(r.err.includes(deadUrl), `the frame is named: ${r.err}`);
    assert.ok(!existsSync(shot), 'no screenshot with a hole in it');
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

// EURO-37：document.write 写进 about:blank iframe、javascript: URL iframe 里起的 worker 被挡下了，但没有 WORKER 记录：
// 这两种文档里没有 init script 的监听，跨源 frame（独立渲染进程）里的 DevTools issue 也不经过主页面的会话。
const WRITTEN_FRAME_ENTRIES = {
  'document.write into an about:blank iframe': `const f = document.createElement('iframe'); document.body.append(f); const d = f.contentDocument; d.open(); d.write('<scr' + 'ipt>new Worker(URL.createObjectURL(new Blob([parent.W])))</scr' + 'ipt>'); d.close()`,
  'javascript: URL iframe': `const f = document.createElement('iframe'); f.src = 'javascript:"<scr' + 'ipt>new Worker(URL.createObjectURL(new Blob([parent.W])))</scr' + 'ipt>"'; document.body.append(f)`,
};

test('workers started in document.write and javascript: URL iframes are recorded, in the page and in a cross-origin frame', { skip: !hasChromium && 'Chromium 未安装' }, async () => {
  for (const [name, code] of Object.entries(WRITTEN_FRAME_ENTRIES)) {
    const probe = `<!doctype html><title>w</title><body><script>
  window.W = "fetch('/written-worker-ran')";
  try { ${code}; } catch (e) {}
</script>`;
    for (const where of ['page', 'cross-origin frame']) {
      const env = await twoOrigins((b) => (where === 'page' ? probe : `<!doctype html><title>outer</title><iframe src="${b.origin}/frame"></iframe>`), probe);
      const home = mkdtempSync(path.join(tmpdir(), 'ref-env-it-'));
      mkdirSync(path.join(home, 'profile'), { mode: 0o700 });
      try {
        const r = await run([env.url, '-o', path.join(home, 'x.png'), '--wait', '1500'], { DIDA_REF_HOME: home });
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal(r.code, 0, `${name} in the ${where}: ${r.err}`);
        if (where !== 'page') assert.ok(env.seen.includes('B GET /frame'), `${name}: the cross-origin frame loaded: ${env.seen}`);
        assert.ok(!env.seen.some((s) => s.includes('/written-worker-ran')), `${name} in the ${where}: the worker ran: ${env.seen}`);
        assert.ok(JSON.parse(r.out).blockedRequests.some((b) => b.startsWith('WORKER ')), `${name} in the ${where}: blocked worker recorded: ${r.out}`);
      } finally {
        env.close();
        rmSync(home, { recursive: true, force: true });
      }
    }
  }
});

// ---- 打字预览（ADR-0010）----

const TYPE_PAGE = `<!doctype html><title>type-probe</title>
<div class="add"><input id="add" placeholder="添加任务至“收集箱”，回车即可保存"></div>
<div class="desc"><h1 id="heading">收集箱</h1><div id="desc" contenteditable="true" style="min-height:20px"></div><span class="placeholder">描述</span></div>
<p id="preview"></p>
<section class="pane"><span class="add-placeholder">添加任务</span><div class="detail"><input id="title" aria-label="任务标题"></div></section>
<div id="add-task"><div class="CodeMirror"><div><textarea id="cm"></textarea></div><pre class="CodeMirror-placeholder"></pre></div></div>
<script>
  const add = document.getElementById('add');
  add.oninput = () => {
    document.getElementById('preview').textContent = add.value.includes('明天') ? '识别：明天' : '';
    fetch('/autosave', { method: 'POST', body: add.value }).catch(() => {});
  };
  add.onkeydown = (e) => { if (e.key === 'Enter') fetch('/create-get-probe').catch(() => {}); };
</script>`;

async function pageServer(html, seen) {
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    } else {
      res.writeHead(204);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server;
}

test('--script types into the 添加任务 field, reads the preview, clears it; writes stay blocked', { skip: !hasChromium && 'Chromium 未安装' }, async () => {
  const seen = [];
  const server = await pageServer(TYPE_PAGE, seen);
  const home = mkdtempSync(path.join(tmpdir(), 'ref-env-it-'));
  mkdirSync(path.join(home, 'profile'), { mode: 0o700 });
  try {
    const script = path.join(home, 'type.json');
    writeFileSync(
      script,
      JSON.stringify([
        { type: '明天开会', into: '#add' },
        { read: '#preview' },
        { read: '.add', html: true },
        { clear: '#add' },
        { read: '#preview' },
        // A CodeMirror field inside #add-task (滴答's 添加任务 box) is allowed.
        { type: '后天', into: '#cm' },
      ]),
    );
    const r = await run([`http://127.0.0.1:${server.address().port}/`, '-o', path.join(home, 'final.png'), '--wait', '200', '--script', script], { DIDA_REF_HOME: home });
    assert.equal(r.code, 0, r.err);
    const out = JSON.parse(r.out);
    assert.equal(out.reads[0].step, 2);
    assert.equal(out.reads[0].selector, '#preview');
    assert.equal(out.reads[0].matches[0].text, '识别：明天');
    assert.ok(out.reads[0].matches[0].rect.width > 0, 'rect recorded');
    assert.match(out.reads[1].matches[0].html, /<input id="add"/);
    assert.deepEqual(out.reads[2].matches.map((m) => m.text), ['']);
    assert.ok(out.blockedRequests.some((b) => b.startsWith('POST ') && b.endsWith('/autosave')), `autosave blocked: ${out.blockedRequests}`);
    assert.ok(!seen.includes('GET /create-get-probe'), 'Enter was never pressed');
    assert.deepEqual(seen.filter((s) => !/^(GET|HEAD|OPTIONS) /.test(s)), []);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('--script refuses to type anywhere but the 添加任务 field', { skip: !hasChromium && 'Chromium 未安装' }, async () => {
  const seen = [];
  const server = await pageServer(TYPE_PAGE, seen);
  const home = mkdtempSync(path.join(tmpdir(), 'ref-env-it-'));
  mkdirSync(path.join(home, 'profile'), { mode: 0o700 });
  try {
    // #title: a 添加任务 hint sits in a container around it, which must not count (EURO-39 审查).
    for (const steps of [[{ type: '你好', into: '#desc' }], [{ type: '你好', into: '#heading' }], [{ clear: '#desc' }], [{ type: '你好', into: '#title' }]]) {
      const script = path.join(home, 'bad.json');
      writeFileSync(script, JSON.stringify(steps));
      const shot = path.join(home, 'bad.png');
      const r = await run([`http://127.0.0.1:${server.address().port}/`, '-o', shot, '--wait', '200', '--script', script], { DIDA_REF_HOME: home });
      assert.notEqual(r.code, 0, JSON.stringify(steps));
      assert.match(r.err, /拒绝在 .* 里打字/);
      assert.ok(!existsSync(shot), 'no screenshot after a refused step');
    }
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});
