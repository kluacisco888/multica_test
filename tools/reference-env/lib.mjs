// 截图工具的纯逻辑：参数解析、输出路径校验、只读请求判定、配置目录锁检测。
import { readlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';

const USAGE =
  '用法: screenshot.mjs <url> -o <输出.png（仓库外）> [--full-page] [--wait <毫秒>] [--viewport <宽>x<高>]';

const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** 只放行不会改动服务端数据的请求方法。 */
export function isReadOnlyMethod(method) {
  return READ_ONLY_METHODS.has(String(method).toUpperCase());
}

/** 解析输出路径为绝对路径；拒绝写进仓库，避免截图里的个人数据被提交。 */
export function resolveOutputPath(output, repoRoot, cwd = process.cwd()) {
  const abs = path.resolve(cwd, output);
  const rel = path.relative(path.resolve(repoRoot), abs);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error(`输出路径 ${abs} 在仓库内；截图含个人数据，只能写到仓库外`);
  }
  if (path.extname(abs).toLowerCase() !== '.png') {
    throw new Error('输出文件必须以 .png 结尾');
  }
  return abs;
}

export function parseArgs(argv) {
  const out = {
    url: undefined,
    output: undefined,
    fullPage: false,
    waitMs: 3000,
    viewport: { width: 1440, height: 900 },
  };
  if (argv.length === 0) throw new Error(USAGE);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-o':
      case '--output':
        out.output = argv[++i];
        break;
      case '--full-page':
        out.fullPage = true;
        break;
      case '--wait': {
        const n = Number(argv[++i]);
        if (!Number.isInteger(n) || n < 0) throw new Error('--wait 需要非负整数毫秒');
        out.waitMs = n;
        break;
      }
      case '--viewport': {
        const m = /^(\d+)x(\d+)$/.exec(argv[++i] ?? '');
        if (!m) throw new Error('--viewport 格式应为 <宽>x<高>，例如 1440x900');
        out.viewport = { width: Number(m[1]), height: Number(m[2]) };
        break;
      }
      default:
        if (a.startsWith('-') || out.url !== undefined) throw new Error(`未知参数: ${a}\n${USAGE}`);
        out.url = a;
    }
  }
  if (!out.url) throw new Error(USAGE);
  if (!/^https?:\/\//i.test(out.url)) throw new Error('url 必须是 http(s) 地址');
  if (!out.output) throw new Error(`缺少 -o <输出.png>\n${USAGE}`);
  return out;
}

/**
 * Chromium 运行时在配置目录里放一个 SingletonLock 符号链接，指向 "<主机名>-<pid>"。
 * 返回仍存活的持有者 pid；没有锁、锁属于别的主机或进程已退出时返回 null。
 */
export function profileLockOwner(profileDir) {
  let target;
  try {
    target = readlinkSync(path.join(profileDir, 'SingletonLock'));
  } catch {
    return null;
  }
  const idx = target.lastIndexOf('-');
  const host = target.slice(0, idx);
  const pid = Number(target.slice(idx + 1));
  if (host !== hostname() || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (e) {
    return e.code === 'EPERM' ? pid : null;
  }
}
