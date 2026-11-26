/**
 * PathGuard 单元测试：白名单 / 目录逃逸 / 符号链接逃逸 / 不存在路径
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PathGuard } from '../src/shared/pathguard.js';

const ROOT = path.join(import.meta.dirname, 'tmp');
const ALLOWED = path.join(ROOT, 'allowed');

before(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(ALLOWED, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(ALLOWED, 'a.txt'), 'a');
  fs.writeFileSync(path.join(ALLOWED, 'sub', 'b.txt'), 'b');
  fs.symlinkSync('/etc', path.join(ALLOWED, 'link-out'));
});

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function makeGuard() {
  return new PathGuard([ALLOWED]);
}

test('白名单内绝对路径可解析', () => {
  const g = makeGuard();
  const r = g.resolve(path.join(ALLOWED, 'a.txt'));
  assert.equal(r.path, path.join(ALLOWED, 'a.txt'));
});

test('相对路径基于 base 解析', () => {
  const g = makeGuard();
  const r = g.resolve('sub/b.txt', { base: ALLOWED });
  assert.equal(r.path, path.join(ALLOWED, 'sub', 'b.txt'));
});

test('../ 目录逃逸被拒绝', () => {
  const g = makeGuard();
  // 从 sub 出发，../../ 才是逃逸出授权目录
  assert.throws(() => g.resolve('../../etc/passwd', { base: path.join(ALLOWED, 'sub') }), /拒绝访问/);
});

test('白名单外绝对路径被拒绝', () => {
  const g = makeGuard();
  assert.throws(() => g.resolve('/etc/passwd'), /拒绝访问/);
});

test('符号链接逃逸被拒绝', () => {
  const g = makeGuard();
  assert.throws(() => g.resolve(path.join(ALLOWED, 'link-out', 'hosts')), /拒绝访问/);
});

test('授权目录边界本身允许（目录本身）', () => {
  const g = makeGuard();
  const r = g.resolve(ALLOWED);
  assert.equal(r.path, ALLOWED);
  assert.equal(g.defaultCwd(), ALLOWED);
});

test('不存在的嵌套路径可解析（用于新建文件）', () => {
  const g = makeGuard();
  const target = path.join(ALLOWED, 'x', 'y', 'new.txt');
  const r = g.resolve(target);
  assert.equal(r.path, target);
});

test('空路径与非法输入被拒绝', () => {
  const g = makeGuard();
  assert.throws(() => g.resolve(''), /路径不能为空/);
  assert.throws(() => g.resolve(undefined), /路径不能为空/);
});

test('不存在的授权目录：全部无效时构造报错、部分无效时跳过', () => {
  assert.throws(() => new PathGuard([path.join(ROOT, 'no-such-dir')]), /allowedDirs 为空或目录不存在/);
  const g = new PathGuard([ALLOWED, path.join(ROOT, 'no-such-dir')]);
  assert.equal(g.getAllowedDirs().length, 1);
});

test('白名单为空时构造报错', () => {
  assert.throws(() => new PathGuard([]), /allowedDirs/);
});

test('allowAll：空目录列表也可构造且任意路径放行', () => {
  const g = new PathGuard([], { allowAll: true });
  assert.equal(g.isAllowAll(), true);
  assert.deepEqual(g.getAllowedDirs(), []);
  // 白名单外的绝对路径（如 /etc/hosts）也应放行（macOS 下 /etc 是指向 /private/etc 的软链，故用 realpath 对照）
  const target = '/etc/hosts';
  const r = g.resolve(target);
  assert.equal(r.path, fs.realpathSync(target));
});

test('allowAll：符号链接目标不再被拒绝', () => {
  const g = new PathGuard([], { allowAll: true });
  // ALLOWED/link-out -> /etc（->/private/etc），解析其下 hosts 应返回真实 /etc/hosts 路径
  const r = g.resolve(path.join(ALLOWED, 'link-out', 'hosts'));
  assert.equal(r.path, fs.realpathSync('/etc/hosts'));
});

test('allowAll：defaultCwd 返回主目录', () => {
  const g = new PathGuard([], { allowAll: true });
  const cwd = g.defaultCwd();
  assert.ok(path.isAbsolute(cwd));
  assert.ok(cwd.length > 0);
});