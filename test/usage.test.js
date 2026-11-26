/**
 * 用量统计单元测试：计数 / 按工具降序 / 按天聚合 / 持久化恢复 / 容错
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { UsageTracker } from '../src/shared/usage.js';

const TMP = path.join(import.meta.dirname, 'tmp-usage');
const FILE = path.join(TMP, 'usage.json');

before(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
});

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('record 累计 total / tools / days', () => {
  const u = new UsageTracker();
  u.record('read_file', true);
  u.record('read_file', true);
  u.record('write_file', false);
  u.record('write_file', true);

  const s = u.stats();
  assert.equal(s.total.count, 4);
  assert.equal(s.total.ok, 3);
  assert.equal(s.total.fail, 1);

  const read = s.tools.find((t) => t.name === 'read_file');
  assert.deepEqual([read.ok, read.fail, read.total], [2, 0, 2]);
  assert.equal(s.days.length, 1);
  assert.equal(s.days[0].total, 4);
});

test('stats 按工具调用量降序', () => {
  const u = new UsageTracker();
  u.record('a', true);
  u.record('b', true);
  u.record('b', true);
  u.record('c', true);
  u.record('c', true);
  u.record('c', true);
  assert.deepEqual(u.stats().tools.map((t) => t.name), ['c', 'b', 'a']);
});

test('持久化：落盘并可重建实例恢复', () => {
  const u1 = new UsageTracker(FILE);
  u1.record('read_file', true);
  u1.record('read_file', false);
  assert.equal(fs.existsSync(FILE), true);

  const u2 = new UsageTracker(FILE);
  const s = u2.stats();
  assert.equal(s.total.count, 2);
  assert.equal(s.total.ok, 1);
  assert.equal(s.total.fail, 1);
});

test('损坏文件容错：从零开始不抛错', () => {
  fs.writeFileSync(FILE, 'not-json{');
  const u = new UsageTracker(FILE);
  assert.equal(u.stats().total.count, 0);
});

test('无效工具名归一为 unknown', () => {
  const u = new UsageTracker();
  u.record('', true);
  u.record(null, true);
  const s = u.stats();
  assert.equal(s.tools.length, 1);
  assert.equal(s.tools[0].name, 'unknown');
  assert.equal(s.tools[0].total, 2);
});

test('失败记录保存工具名、原因和时间，并在重启后恢复', () => {
  const u1 = new UsageTracker(FILE);
  u1.record('read_file', false, '文件不存在：/tmp/example.txt');
  const item = u1.stats().recent[0];
  assert.equal(item.tool, 'read_file');
  assert.match(item.error, /文件不存在/);
  assert.ok(item.time);
  const u2 = new UsageTracker(FILE);
  assert.equal(u2.stats().recent[0].error, '文件不存在：/tmp/example.txt');
});
