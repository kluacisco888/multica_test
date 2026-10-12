#!/usr/bin/env node
// 只读截图工具：加载参照浏览器配置目录（维护者在 noVNC 里登录的那份），打开 url 并截图。
// 只导航和截图，不点击、不输入；所有非 GET/HEAD/OPTIONS 请求都被拦截，防止改动参照账号的数据。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { isReadOnlyMethod, parseArgs, profileLockOwner, resolveOutputPath } from './lib.mjs';

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
  const output = resolveOutputPath(args.output, repoRoot());
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

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(args.url, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForTimeout(args.waitMs);
    await page.screenshot({ path: output, fullPage: args.fullPage });
    console.log(
      JSON.stringify(
        { output, requested: args.url, finalUrl: page.url(), title: await page.title(), blockedRequests: blocked },
        null,
        2,
      ),
    );
  } finally {
    await context.close();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
