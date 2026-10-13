#!/usr/bin/env node
// 只读截图工具：加载参照浏览器配置目录（维护者在 noVNC 里登录的那份），打开 url 并截图。
// 可选 --script：按导航脚本做导航类的点击、悬停、滚动后截图（ADR-0008），不打字、不拖动，
// 点击前拒绝输入控件和会改数据的控件。所有非 GET/HEAD/OPTIONS 请求和全部 WebSocket 连接都被拦截，防止改动参照账号的数据。
/* global window, document, Element, HTMLFormElement -- used only in code that runs inside the page (addInitScript, evaluate) */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { forbiddenControl, isReadOnlyMethod, parseArgs, parseScript, profileLockOwner, resolveOutputPath } from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function repoRoot() {
  try {
    return execFileSync('git', ['-C', here, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return path.resolve(here, '..', '..');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = repoRoot();
  const output = resolveOutputPath(args.output, root);
  // Parse and check the whole script (and every screenshot path) before touching the profile.
  const steps = args.script ? parseScript(readFileSync(args.script, 'utf8')) : [];
  const stepOutputs = steps.map((step) =>
    step.action === 'screenshot' ? resolveOutputPath(step.output, root, path.dirname(output)) : null,
  );
  const stateDir = process.env.DIDA_REF_HOME || path.join(homedir(), '.dida-reference');
  const profileDir = path.join(stateDir, 'profile');

  if (!existsSync(profileDir)) {
    throw new Error(`找不到浏览器配置目录 ${profileDir}；先运行 reference-env.sh start 并让维护者登录`);
  }
  const owner = profileLockOwner(profileDir);
  if (owner !== null) {
    throw new Error(
      `配置目录正被 noVNC 里的浏览器使用（pid ${owner}）。先运行 reference-env.sh stop-browser，截完图再 start-browser`,
    );
  }

  mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });

  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium', // 与 noVNC 里同一个 Chromium 二进制，保证配置目录兼容
    headless: true,
    viewport: args.viewport,
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    serviceWorkers: 'block', // service worker 发出的请求绕过 route，直接禁用
  });

  const blocked = [];
  await context.route('**/*', (route) => {
    const req = route.request();
    if (isReadOnlyMethod(req.method())) return route.continue();
    blocked.push(`${req.method()} ${req.url()}`);
    return route.abort('blockedbyclient');
  });
  // context.route 拦不到 WebSocket；WS 握手是 GET，但建立后可以双向写数据，所以全部拦掉。
  await context.routeWebSocket(/.*/, (ws) => {
    blocked.push(`WS ${ws.url()}`);
    return ws.close();
  });

  // New tabs and windows are where the write guard leaks (EURO-22 审查: a popup's sendBeacon reached the server even
  // though the popup was closed at once), so pages may not open them at all: window.open, links and forms aimed at
  // another tab, and middle / modifier clicks on links are stopped in the page and reported here.
  const blockedPopups = [];
  await context.exposeBinding('__didaRefPopupBlocked', (_source, what) => {
    blockedPopups.push(String(what));
  });
  await context.addInitScript(() => {
    const report = (what) => {
      try {
        window.__didaRefPopupBlocked(what);
      } catch {
        // binding not ready: the page still gets no popup
      }
    };
    const open = () => {
      report('window.open');
      return null;
    };
    Object.defineProperty(window, 'open', { value: open, writable: false, configurable: false });
    const otherTab = (target) => target !== '' && target !== '_self' && target !== '_parent' && target !== '_top';
    const guardClick = (event) => {
      const link = event.target instanceof Element ? event.target.closest('a[href], area[href]') : null;
      if (!link) return;
      const modified = event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button === 1;
      if (modified || otherTab(link.getAttribute('target') ?? '')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        report(`link ${link.href}`);
      }
    };
    window.addEventListener('click', guardClick, true);
    window.addEventListener('auxclick', guardClick, true);
    window.addEventListener(
      'submit',
      (event) => {
        const form = event.target;
        if (form instanceof HTMLFormElement && otherTab(form.getAttribute('target') ?? '')) {
          event.preventDefault();
          report(`form ${form.action}`);
        }
      },
      true,
    );
  });

  // Only the first page is allowed. Any other (a tab or window a click opened) is closed at once and fails the run:
  // requests of tabs opened with modifier clicks are not seen by context.route (EURO-22 审查).
  const page = context.pages()[0] ?? (await context.newPage());
  const extraPages = [];
  context.on('page', (p) => {
    if (p === page) return;
    extraPages.push(p.url() || 'about:blank');
    p.close().catch(() => {});
  });
  const checkPages = (where) => {
    if (extraPages.length > 0) throw new Error(`${where}打开了新页面（${extraPages.join(', ')}），已关闭；为保护参照账号，本次运行失败`);
    if (blockedPopups.length > 0) throw new Error(`${where}页面想打开新页面（${blockedPopups.join(', ')}），已阻止；为保护参照账号，本次运行失败`);
  };

  try {
    await page.goto(args.url, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForTimeout(args.waitMs);
    const screenshots = [];
    const log = [];
    for (const [i, step] of steps.entries()) {
      await runStep(page, step, stepOutputs[i]);
      checkPages(`步骤 ${i + 1} `);
      if (stepOutputs[i]) screenshots.push(stepOutputs[i]);
      log.push({ ...step, blockedSoFar: blocked.length });
    }
    checkPages('');
    await page.screenshot({ path: output, fullPage: args.fullPage });
    screenshots.push(output);
    console.log(
      JSON.stringify(
        {
          output,
          requested: args.url,
          finalUrl: page.url(),
          title: await page.title(),
          ...(args.script ? { script: path.resolve(args.script), steps: log, screenshots } : {}),
          blockedRequests: blocked,
        },
        null,
        2,
      ),
    );
  } finally {
    await context.close();
  }
}

const STEP_TIMEOUT_MS = 15_000;

/** One navigation step (ADR-0008). Clicks are checked against `forbiddenControl` first. */
async function runStep(page, step, shotPath) {
  switch (step.action) {
    case 'click':
    case 'hover': {
      const target = page.locator(step.selector).first();
      await target.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
      if (step.action === 'click') {
        const info = await target.evaluate((el) => {
          const control = el.closest('button, a, [role="button"], [role="menuitem"], [role="tab"], [role="option"]') ?? el;
          // The click lands at the centre: check the element there too (it may be a link inside `el`).
          const rect = el.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          const LINK = 'a[href], area[href], [role="link"]';
          return {
            text: [control.getAttribute('aria-label'), control.getAttribute('title'), control.innerText].filter(Boolean).join(' '),
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute('type'),
            editable: el.isContentEditable,
            link: el.closest(LINK) !== null || (hit !== null && hit.closest(LINK) !== null),
          };
        });
        info.modified = (step.modifiers ?? []).length > 0;
        const reason = forbiddenControl(info);
        if (reason) throw new Error(`拒绝点击 ${step.selector}：${reason}（ADR-0008）`);
        await target.click({ timeout: STEP_TIMEOUT_MS, modifiers: step.modifiers, button: step.button });
      } else {
        await target.hover({ timeout: STEP_TIMEOUT_MS });
      }
      return;
    }
    case 'scroll': {
      const target = page.locator(step.selector).first();
      await target.waitFor({ state: 'attached', timeout: STEP_TIMEOUT_MS });
      await target.evaluate((el, by) => el.scrollBy(0, by), step.by);
      return;
    }
    case 'press':
      await page.keyboard.press(step.key);
      return;
    case 'wait':
      await page.waitForTimeout(step.ms);
      return;
    case 'waitFor':
      await page.locator(step.selector).first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
      return;
    case 'screenshot':
      mkdirSync(path.dirname(shotPath), { recursive: true, mode: 0o700 });
      await page.screenshot({ path: shotPath, fullPage: step.fullPage });
      return;
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
