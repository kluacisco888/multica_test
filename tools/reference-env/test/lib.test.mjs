import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import path from 'node:path';

import {
  isReadOnlyMethod,
  resolveOutputPath,
  parseArgs,
  parseScript,
  forbiddenControl,
  forbiddenTypingTarget,
  profileLockOwner,
} from '../lib.mjs';

test('only GET/HEAD/OPTIONS are allowed through', () => {
  for (const m of ['GET', 'get', 'HEAD', 'OPTIONS']) assert.equal(isReadOnlyMethod(m), true, m);
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) assert.equal(isReadOnlyMethod(m), false, m);
});

test('output path inside the repository is refused', () => {
  const repo = '/srv/repo';
  assert.throws(() => resolveOutputPath('/srv/repo/shots/a.png', repo), /仓库/);
  assert.throws(() => resolveOutputPath('/srv/repo', repo), /仓库/);
  assert.throws(() => resolveOutputPath('shots/a.png', repo, '/srv/repo/tools'), /仓库/);
});

test('output path outside the repository resolves to absolute .png', () => {
  assert.equal(resolveOutputPath('/home/u/shots/a.png', '/srv/repo'), '/home/u/shots/a.png');
  assert.equal(resolveOutputPath('/srv/repo-shots/a.png', '/srv/repo'), '/srv/repo-shots/a.png');
  assert.equal(resolveOutputPath('a.png', '/srv/repo', '/home/u'), '/home/u/a.png');
  assert.throws(() => resolveOutputPath('/home/u/a.jpg', '/srv/repo'), /\.png/);
});

test('parseArgs reads url, output and options with defaults', () => {
  const a = parseArgs(['https://dida365.com/webapp/', '-o', '/x/a.png', '--full-page', '--wait', '5000', '--viewport', '1280x800']);
  assert.deepEqual(a, {
    url: 'https://dida365.com/webapp/',
    output: '/x/a.png',
    fullPage: true,
    waitMs: 5000,
    viewport: { width: 1280, height: 800 },
    script: null,
  });
  assert.equal(parseArgs(['https://dida365.com/', '-o', '/x/b.png', '--script', 'nav.json']).script, 'nav.json');
  const d = parseArgs(['https://dida365.com/', '-o', '/x/b.png']);
  assert.equal(d.fullPage, false);
  assert.equal(d.waitMs, 3000);
  assert.deepEqual(d.viewport, { width: 1440, height: 900 });
});

test('parseArgs rejects missing args, bad viewport and non-http urls', () => {
  assert.throws(() => parseArgs([]), /用法/);
  assert.throws(() => parseArgs(['https://dida365.com/']), /-o/);
  assert.throws(() => parseArgs(['file:///etc/passwd', '-o', '/x/a.png']), /http/);
  assert.throws(() => parseArgs(['https://dida365.com/', '-o', '/x/a.png', '--viewport', 'big']), /viewport/);
  assert.throws(() => parseArgs(['https://dida365.com/', '-o', '/x/a.png', '--click', '#x']), /未知参数/);
});

test('profileLockOwner reports a live lock and ignores stale or missing ones', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ref-env-test-'));
  try {
    assert.equal(profileLockOwner(dir), null);
    symlinkSync(`${hostname()}-${process.pid}`, path.join(dir, 'SingletonLock'));
    assert.equal(profileLockOwner(dir), process.pid);
    rmSync(path.join(dir, 'SingletonLock'));
    symlinkSync(`${hostname()}-999999999`, path.join(dir, 'SingletonLock'));
    assert.equal(profileLockOwner(dir), null);
    rmSync(path.join(dir, 'SingletonLock'));
    symlinkSync(`some-other-host-${process.pid}`, path.join(dir, 'SingletonLock'));
    assert.equal(profileLockOwner(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseScript accepts only navigation steps (ADR-0008)', () => {
  const steps = parseScript(
    JSON.stringify([
      { click: 'role=link[name="日历"]' },
      { hover: 'text=月' },
      { scroll: '.list', by: 300 },
      { wait: 500 },
      { waitFor: 'text=2026年10月' },
      { screenshot: 'month.png', fullPage: true },
      { press: 'Escape' },
    ]),
  );
  assert.deepEqual(steps, [
    { action: 'click', selector: 'role=link[name="日历"]' },
    { action: 'hover', selector: 'text=月' },
    { action: 'scroll', selector: '.list', by: 300 },
    { action: 'wait', ms: 500 },
    { action: 'waitFor', selector: 'text=2026年10月' },
    { action: 'screenshot', output: 'month.png', fullPage: true },
    { action: 'press', key: 'Escape' },
  ]);
});

test('parseScript accepts multi-select clicks (Shift / Ctrl / Cmd) and right clicks', () => {
  const steps = parseScript(
    JSON.stringify([
      { click: 'text="a"', modifiers: ['Control'] },
      { click: 'text="b"', modifiers: ['Shift'] },
      { click: 'text="c"', modifiers: ['Meta'], button: 'left' },
      { click: 'text="d"', button: 'right' },
    ]),
  );
  assert.deepEqual(steps, [
    { action: 'click', selector: 'text="a"', modifiers: ['Control'] },
    { action: 'click', selector: 'text="b"', modifiers: ['Shift'] },
    { action: 'click', selector: 'text="c"', modifiers: ['Meta'] },
    { action: 'click', selector: 'text="d"', button: 'right' },
  ]);
  for (const step of [
    { click: 'x', modifiers: ['Alt'] },
    { click: 'x', modifiers: 'Shift' },
    { click: 'x', modifiers: ['Shift', 'Shift'] },
    { click: 'x', button: 'middle' },
    { hover: 'x', modifiers: ['Shift'] },
  ]) {
    assert.throws(() => parseScript(JSON.stringify([step])), /步骤/, JSON.stringify(step));
  }
});

test('parseScript rejects fill, typing without a field, dragging, unknown steps and bad values', () => {
  assert.throws(() => parseScript('{}'), /数组/);
  assert.throws(() => parseScript('not json'), /JSON/);
  for (const step of [
    { fill: 'input', value: 'x' },
    { type: 'abc' },
    { dragTo: 'x' },
    { press: 'a' },
    { press: 'Enter' },
    { click: 'x', extra: 1 },
    { click: '' },
    { wait: -1 },
    { wait: 120001 },
    { screenshot: 'a.jpg' },
    { scroll: 'x', by: 'far' },
  ]) {
    assert.throws(() => parseScript(JSON.stringify([step])), /步骤/, JSON.stringify(step));
  }
});

test('forbiddenControl refuses modifier clicks on links (new tabs bypass the write guard)', () => {
  assert.match(forbiddenControl({ text: '一', tag: 'a', link: true, modified: true }), /链接/);
  assert.match(forbiddenControl({ text: '一', tag: 'span', link: true, modified: true }), /链接/);
  assert.equal(forbiddenControl({ text: '一', tag: 'a', link: true, modified: false }), null);
  assert.equal(forbiddenControl({ text: '一', tag: 'div', link: false, modified: true }), null);
});

test('forbiddenControl flags controls that would create, change or delete data', () => {
  for (const label of ['删除', '新建清单', '添加任务', '完成', '保存', '确定', '移动到', '归档', '放弃', '清空回收站', '退出登录', '订阅', '升级高级会员', 'Delete', 'Add Task']) {
    assert.ok(forbiddenControl({ text: label, tag: 'button' }), label);
  }
  assert.ok(forbiddenControl({ text: '', tag: 'input', type: 'checkbox' }), 'checkbox');
  assert.ok(forbiddenControl({ text: '', tag: 'input', type: 'text' }), 'text input');
  assert.ok(forbiddenControl({ text: '', tag: 'textarea' }), 'textarea');
  assert.ok(forbiddenControl({ text: '', tag: 'div', editable: true }), 'contenteditable');
  for (const label of ['月', '周', '日', '多日', '日历', '今天', '下一页', '']) {
    assert.equal(forbiddenControl({ text: label, tag: 'div' }), null, label);
  }
});

test('parseScript accepts typing into a field, clearing it and reading text (ADR-0010)', () => {
  assert.deepEqual(
    parseScript(
      JSON.stringify([
        { type: '明天上午提醒我去取快递', into: '.add-task-input' },
        { read: '.add-task-input', html: true },
        { read: 'text=明天' },
        { clear: '.add-task-input' },
      ]),
    ),
    [
      { action: 'type', selector: '.add-task-input', text: '明天上午提醒我去取快递' },
      { action: 'read', selector: '.add-task-input', html: true },
      { action: 'read', selector: 'text=明天', html: false },
      { action: 'clear', selector: '.add-task-input' },
    ],
  );
});

test('parseScript refuses typing that could submit or is not plain text', () => {
  for (const step of [
    { type: 'abc' },
    { type: '', into: 'x' },
    { type: 'a\nb', into: 'x' },
    { type: 'a\rb', into: 'x' },
    { type: 'a\tb', into: 'x' },
    { type: 'x'.repeat(201), into: 'x' },
    { type: 1, into: 'x' },
    { type: 'a', into: '' },
    { type: 'a', into: 'x', press: 'Enter' },
    { clear: '' },
    { read: 'x', html: 'yes' },
    { read: 'x', extra: 1 },
  ]) {
    assert.throws(() => parseScript(JSON.stringify([step])), /步骤/, JSON.stringify(step));
  }
});

test('forbiddenTypingTarget allows only the 添加任务 field (ADR-0010)', () => {
  assert.equal(forbiddenTypingTarget({ tag: 'input', type: 'text', labels: ['添加任务至"收集箱"，回车即可保存'] }), null);
  assert.equal(forbiddenTypingTarget({ tag: 'div', editable: true, labels: ['', '+ 添加任务'] }), null);
  assert.equal(forbiddenTypingTarget({ tag: 'textarea', labels: ['快速添加任务'] }), null);
  // 滴答：#add-task 里的 CodeMirror 编辑器，提示文字画在旁边的 span 里。
  assert.equal(forbiddenTypingTarget({ tag: 'textarea', labels: [null, '#add-task'] }), null);
  assert.match(forbiddenTypingTarget({ tag: 'textarea', labels: ['#task-detail', '#add-task-button-x'] }), /添加任务/);
  assert.match(forbiddenTypingTarget({ tag: 'div', editable: false, labels: ['添加任务'] }), /输入框/);
  assert.match(forbiddenTypingTarget({ tag: 'input', type: 'checkbox', labels: ['添加任务'] }), /输入框/);
  assert.match(forbiddenTypingTarget({ tag: 'input', type: 'password', labels: ['添加任务'] }), /输入框/);
  // Fields that save on their own: a task's title, description, comments, search, list names.
  for (const label of ['标题', '描述', '写评论', '搜索', '清单名称', '']) {
    assert.match(forbiddenTypingTarget({ tag: 'div', editable: true, labels: [label] }), /添加任务/, label);
  }
});
