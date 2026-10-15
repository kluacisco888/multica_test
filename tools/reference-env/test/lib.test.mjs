import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import path from 'node:path';

import {
  backupDownloadLink,
  isReadOnlyMethod,
  resolveOutputPath,
  parseArgs,
  parseScript,
  forbiddenControl,
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

test('parseScript rejects typing, dragging, unknown steps and bad values', () => {
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

test('parseScript allows one backup download, only from 生成备份, saved as .csv (ADR-0010)', () => {
  assert.deepEqual(parseScript(JSON.stringify([{ download: 'text="生成备份"', saveAs: 'backup.csv' }])), [
    { action: 'download', selector: 'text="生成备份"', output: 'backup.csv' },
  ]);
  for (const step of [
    { download: 'text="导出"', saveAs: 'x.csv' },
    { download: 'text="生成备份"', saveAs: 'x.png' },
    { download: 'text="生成备份"' },
    { download: 'text="生成备份"', saveAs: 'x.csv', extra: 1 },
  ]) {
    assert.throws(() => parseScript(JSON.stringify([step])), /步骤/, JSON.stringify(step));
  }
  const twice = JSON.stringify([
    { download: 'text="生成备份"', saveAs: 'a.csv' },
    { download: 'text="生成备份"', saveAs: 'b.csv' },
  ]);
  assert.throws(() => parseScript(twice), /最多导出一次/);
});

test('fetchBackup: one per script, .csv, picks the newest successful export notice (https only)', () => {
  assert.deepEqual(parseScript(JSON.stringify([{ fetchBackup: true, saveAs: 'b.csv' }])), [{ action: 'fetchBackup', output: 'b.csv', waitMinutes: 10 }]);
  for (const step of [{ fetchBackup: 'yes', saveAs: 'b.csv' }, { fetchBackup: true, saveAs: 'b.png' }, { fetchBackup: true, saveAs: 'b.csv', waitMinutes: 99 }]) {
    assert.throws(() => parseScript(JSON.stringify([step])), /步骤/, JSON.stringify(step));
  }
  assert.throws(() => parseScript(JSON.stringify([{ download: 'text="生成备份"', saveAs: 'a.csv' }, { fetchBackup: true, saveAs: 'b.csv' }])), /最多导出一次/);
  const notice = (createdTime, status, downloadLink) => ({ type: 'exportTask', createdTime, data: { status, downloadLink } });
  assert.equal(
    backupDownloadLink([
      notice('2026-10-14T00:00:00Z', 'success', 'https://dida365.com/old.csv'),
      notice('2026-10-15T00:00:00Z', 'success', 'https://dida365.com/new.csv'),
      notice('2026-10-16T00:00:00Z', 'fail', 'https://dida365.com/failed.csv'),
      { type: 'other', data: { status: 'success', downloadLink: 'https://dida365.com/other' } },
    ]),
    'https://dida365.com/new.csv',
  );
  assert.equal(backupDownloadLink([notice('2026-10-15T00:00:00Z', 'success', 'http://dida365.com/a.csv')]), null);
  assert.equal(backupDownloadLink({}), null);
  // Only dida365.com and its subdomains.
  for (const link of ['https://evil.example/a.csv', 'https://dida365.com.evil.example/a.csv', 'https://notdida365.com/a.csv']) {
    assert.equal(backupDownloadLink([notice('2026-10-15T00:00:00Z', 'success', link)]), null, link);
  }
  for (const link of ['https://dida365.com/api/v2/data/export/link/a', 'https://api.dida365.com/a.csv']) {
    assert.equal(backupDownloadLink([notice('2026-10-15T00:00:00Z', 'success', link)]), link, link);
  }
});

test('download output must be outside the repository and .csv', () => {
  assert.throws(() => resolveOutputPath('/repo/x.csv', '/repo', '/', '.csv'), /仓库内/);
  assert.throws(() => resolveOutputPath('/tmp/x.png', '/repo', '/', '.csv'), /\.csv/);
  assert.equal(resolveOutputPath('/tmp/x.csv', '/repo', '/', '.csv'), '/tmp/x.csv');
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
