import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import path from 'node:path';

import {
  isReadOnlyMethod,
  resolveOutputPath,
  parseArgs,
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
  });
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
