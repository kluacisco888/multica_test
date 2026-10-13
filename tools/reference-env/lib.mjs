// 截图工具的纯逻辑：参数解析、导航脚本校验（ADR-0008）、输出路径校验、只读请求判定、配置目录锁检测。
import { readlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';

const USAGE =
  '用法: screenshot.mjs <url> -o <输出.png（仓库外）> [--full-page] [--wait <毫秒>] [--viewport <宽>x<高>] [--script <导航脚本.json>]';

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
    script: null,
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
      case '--script':
        out.script = argv[++i];
        if (!out.script) throw new Error('--script 需要一个 JSON 文件路径');
        break;
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

// ---- 导航脚本（ADR-0008）----
//
// 一个 JSON 数组，每一步只能是下面之一（selector 是 Playwright 选择器，如 `text=月`、`role=button[name="周"]`、CSS）：
//   { "click": sel }   { "hover": sel }   { "scroll": sel, "by": 像素 }   { "press": "Escape" }
//   { "wait": 毫秒 }   { "waitFor": sel }   { "screenshot": "名字.png", "fullPage"?: bool }
// 没有 fill / type / drag：不打字、不拖动。press 只允许关闭弹层和翻页用的键。

const MAX_WAIT_MS = 120_000;
/** 只用于关闭弹层、移动焦点、滚动的键；不含 Enter / 空格（会触发按钮）和字符键。 */
const NAVIGATION_KEYS = new Set(['Escape', 'Tab', 'Shift+Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End']);

/** 点击时可以按住的修饰键（多选）；Meta 是 macOS 的 Cmd。 */
const CLICK_MODIFIERS = new Set(['Shift', 'Control', 'Meta']);

function stepError(index, step, why) {
  return new Error(`导航脚本步骤 ${index + 1} ${JSON.stringify(step)} 无效：${why}`);
}

const isSelector = (v) => typeof v === 'string' && v.trim() !== '';

/** 解析并校验导航脚本，返回规范化的步骤；任何不在白名单里的操作都拒绝。 */
export function parseScript(json) {
  let raw;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new Error(`导航脚本不是合法 JSON：${e.message}`, { cause: e });
  }
  if (!Array.isArray(raw)) throw new Error('导航脚本必须是步骤数组');
  return raw.map((step, i) => {
    if (step === null || typeof step !== 'object' || Array.isArray(step)) throw stepError(i, step, '每一步是一个对象');
    const keys = Object.keys(step);
    const only = (...allowed) => {
      const extra = keys.filter((k) => !allowed.includes(k));
      if (extra.length > 0) throw stepError(i, step, `不认识的字段 ${extra.join(', ')}`);
    };
    if ('click' in step) {
      // 多选（Shift / Ctrl / Cmd 点击）和右键菜单只改页面上的选中状态、打开菜单，不改数据。
      only('click', 'modifiers', 'button');
      if (!isSelector(step.click)) throw stepError(i, step, '需要非空选择器');
      const modifiers = step.modifiers ?? [];
      if (!Array.isArray(modifiers) || !modifiers.every((m) => CLICK_MODIFIERS.has(m)) || new Set(modifiers).size !== modifiers.length) {
        throw stepError(i, step, `modifiers 只能是 ${[...CLICK_MODIFIERS].join(' / ')}`);
      }
      const button = step.button ?? 'left';
      if (button !== 'left' && button !== 'right') throw stepError(i, step, 'button 只能是 left / right');
      return {
        action: 'click',
        selector: step.click,
        ...(modifiers.length > 0 ? { modifiers } : {}),
        ...(button === 'right' ? { button } : {}),
      };
    }
    if ('hover' in step || 'waitFor' in step) {
      const action = 'hover' in step ? 'hover' : 'waitFor';
      only(action);
      if (!isSelector(step[action])) throw stepError(i, step, '需要非空选择器');
      return { action, selector: step[action] };
    }
    if ('scroll' in step) {
      only('scroll', 'by');
      if (!isSelector(step.scroll)) throw stepError(i, step, '需要非空选择器');
      if (!Number.isInteger(step.by) || Math.abs(step.by) > 100_000) throw stepError(i, step, 'by 是整数像素');
      return { action: 'scroll', selector: step.scroll, by: step.by };
    }
    if ('wait' in step) {
      only('wait');
      if (!Number.isInteger(step.wait) || step.wait < 0 || step.wait > MAX_WAIT_MS) throw stepError(i, step, `wait 是 0–${MAX_WAIT_MS} 毫秒`);
      return { action: 'wait', ms: step.wait };
    }
    if ('press' in step) {
      only('press');
      if (!NAVIGATION_KEYS.has(step.press)) throw stepError(i, step, `只允许导航键 ${[...NAVIGATION_KEYS].join(' ')}`);
      return { action: 'press', key: step.press };
    }
    if ('screenshot' in step) {
      only('screenshot', 'fullPage');
      if (typeof step.screenshot !== 'string' || !step.screenshot.toLowerCase().endsWith('.png')) throw stepError(i, step, '截图文件以 .png 结尾');
      if (step.fullPage !== undefined && typeof step.fullPage !== 'boolean') throw stepError(i, step, 'fullPage 是布尔值');
      return { action: 'screenshot', output: step.screenshot, fullPage: step.fullPage ?? false };
    }
    throw stepError(i, step, '只允许 click / hover / scroll / press / wait / waitFor / screenshot（不打字、不拖动）');
  });
}

/** 会新建、修改、删除数据或改变账号状态的控件文字（ADR-0008：这些不点）。 */
const FORBIDDEN_LABELS =
  /删除|新建|添加|创建|完成|保存|确定|确认|提交|移动|复制|归档|放弃|清空|还原|恢复|退出|注销|订阅|升级|购买|支付|分享|邀请|导入|导出|设置为|置顶|编辑|重命名|发送|上传|\b(delete|remove|add|new|create|save|ok|confirm|submit|done|complete|move|archive|share|subscribe|upgrade|buy|logout|sign out)\b/i;

/**
 * 点击前检查目标控件；返回拒绝原因，可以点时返回 null。
 * `el`：{ text: 可见文字或可访问名称, tag: 小写标签名, type?: input 类型, editable?: contenteditable,
 *        link?: 目标或点击处在 a[href] / [role=link] 里, modified?: 这次点击带修饰键 }
 */
export function forbiddenControl(el) {
  const tag = String(el.tag ?? '').toLowerCase();
  // Shift / Ctrl / Cmd + 点击链接会开新标签页或新窗口，Chromium 不让 context.route 拦截那里的请求（EURO-22 审查）。
  if (el.modified && el.link) return '不带修饰键点链接（会打开新标签页或新窗口，绕过写保护）';
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return `不点输入控件（${tag}${el.type ? ` ${el.type}` : ''}）`;
  if (el.editable) return '不点可编辑区域';
  const text = String(el.text ?? '').trim();
  const hit = FORBIDDEN_LABELS.exec(text);
  return hit ? `控件「${text.slice(0, 40)}」含「${hit[0]}」，可能改数据` : null;
}
