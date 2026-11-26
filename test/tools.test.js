/**
 * 工具层单元测试：文件读写/编辑/目录/搜索/终端/进程
 * 直接调用工具函数（不经 MCP 协议），验证核心逻辑与安全约束。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PathGuard } from '../src/shared/pathguard.js';
import { callTool, createToolContext, TOOL_DEFS } from '../src/tools/index.js';

const ROOT = path.join(import.meta.dirname, 'tmp-tools');
const ALLOWED = path.join(ROOT, 'workspace');

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };
const config = Object.freeze({
  agent: {
    allowShell: true,
    shellCwdMustBeAllowed: true,
    commandTimeoutMs: 15000,
    commandMaxOutputBytes: 65536,
    readFileMaxBytes: 1024 * 1024,
    writeFileMaxBytes: 1024 * 1024,
    searchMaxResults: 100,
    backupOnWrite: true,
  },
});

let ctx;
const call = (name, args) => callTool(ctx, name, args);

before(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(ALLOWED, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(ALLOWED, 'hello.txt'), '第一行 hello\n第二行 world\n第三行 中文测试\n');
  fs.writeFileSync(path.join(ALLOWED, 'docs', 'note.md'), '# 标题\n内容包含 needle 关键词\n');
  ctx = createToolContext({ guard: new PathGuard([ALLOWED]), config, logger: noopLogger });
});

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test('工具清单为非空且包含核心工具', () => {
  const names = TOOL_DEFS.map((t) => t.name);
  for (const n of ['read_file', 'write_file', 'edit_file', 'append_file', 'list_directory', 'create_directory', 'move_file', 'delete_files', 'get_file_info', 'search_files', 'execute_command', 'ssh_session_open', 'ssh_session_write', 'ssh_session_read', 'ssh_session_resize', 'ssh_session_close', 'list_processes', 'kill_process']) {
    assert.ok(names.includes(n), `缺少工具 ${n}`);
  }
});

test('read_file：默认带行号读完，offset/limit 生效', async () => {
  const r1 = await call('read_file', { path: path.join(ALLOWED, 'hello.txt') });
  assert.equal(r1.isError, false);
  assert.match(r1.text, /第一行 hello/);
  assert.match(r1.text, /共 4 行/); // 尾部换行计入最后一行，与编辑器行为一致

  const r2 = await call('read_file', { path: path.join(ALLOWED, 'hello.txt'), offset: 2, limit: 1 });
  assert.match(r2.text, /第二行 world/);
  assert.doesNotMatch(r2.text, /第一行/);
});

test('read_file：目录报错、不存在报错', async () => {
  const r1 = await call('read_file', { path: ALLOWED });
  assert.equal(r1.isError, true);
  const r2 = await call('read_file', { path: path.join(ALLOWED, 'no.txt') });
  assert.equal(r2.isError, true);
});

test('write_file：写入并生成 .backups 备份', async () => {
  const p = path.join(ALLOWED, 'docs', 'out.txt');
  const r1 = await call('write_file', { path: p, content: 'v1' });
  assert.equal(r1.isError, false);
  assert.equal(fs.readFileSync(p, 'utf8'), 'v1');

  const r2 = await call('write_file', { path: p, content: 'v2' });
  assert.equal(r2.isError, false);
  assert.equal(fs.readFileSync(p, 'utf8'), 'v2');
  const backups = fs.readdirSync(path.join(ALLOWED, 'docs', '.backups'));
  assert.equal(backups.length, 1);
});

test('write_file：超出授权目录被拒绝', async () => {
  const r = await call('write_file', { path: '/tmp/x.txt', content: 'x' });
  assert.equal(r.isError, true);
  assert.match(r.text, /拒绝访问/);
});

test('append_file：追加内容', async () => {
  const p = path.join(ALLOWED, 'log.txt');
  await call('append_file', { path: p, content: 'a\n' });
  await call('append_file', { path: p, content: 'b\n' });
  assert.equal(fs.readFileSync(p, 'utf8'), 'a\nb\n');
});

test('edit_file：唯一匹配替换；多处匹配拒绝；不匹配拒绝', async () => {
  const p = path.join(ALLOWED, 'edit.txt');
  fs.writeFileSync(p, 'AAA BBB CCC AAA\n');
  const r1 = await call('edit_file', { path: p, old_string: 'BBB', new_string: 'DDD' });
  assert.equal(r1.isError, false);
  assert.equal(fs.readFileSync(p, 'utf8'), 'AAA DDD CCC AAA\n');

  const r2 = await call('edit_file', { path: p, old_string: 'AAA', new_string: 'X' });
  assert.equal(r2.isError, true);
  assert.match(r2.text, /出现了 2 次/);

  const r3 = await call('edit_file', { path: p, old_string: 'AAA', new_string: 'X', replace_all: true });
  assert.equal(r3.isError, false);
  assert.equal(fs.readFileSync(p, 'utf8'), 'X DDD CCC X\n');

  const r4 = await call('edit_file', { path: p, old_string: '不存在的内容', new_string: 'Y' });
  assert.equal(r4.isError, true);
});

test('list_directory / create_directory / move_file / delete_files 全流程', async () => {
  let r = await call('list_directory', { path: ALLOWED });
  assert.equal(r.isError, false);
  assert.match(r.text, /hello\.txt/);

  r = await call('create_directory', { path: path.join(ALLOWED, 'newdir') });
  assert.equal(r.isError, false);
  assert.ok(fs.statSync(path.join(ALLOWED, 'newdir')).isDirectory());

  // 使用独立的移动源文件，避免污染其他测试依赖的 hello.txt
  fs.writeFileSync(path.join(ALLOWED, 'mv-src.txt'), 'move me');
  r = await call('move_file', { source: path.join(ALLOWED, 'mv-src.txt'), destination: path.join(ALLOWED, 'newdir', 'moved.txt') });
  assert.equal(r.isError, false);
  assert.ok(fs.existsSync(path.join(ALLOWED, 'newdir', 'moved.txt')));

  r = await call('delete_files', { paths: [path.join(ALLOWED, 'newdir', 'moved.txt')] });
  assert.equal(r.isError, false);
  assert.ok(!fs.existsSync(path.join(ALLOWED, 'newdir', 'moved.txt')));

  // 非空目录拒绝删除
  fs.writeFileSync(path.join(ALLOWED, 'newdir', 'keep.txt'), 'x');
  r = await call('delete_files', { paths: [path.join(ALLOWED, 'newdir')] });
  assert.equal(r.isError, false);
  assert.match(r.text, /目录非空/);
});

test('move_file：目标已存在时拒绝覆盖', async () => {
  fs.writeFileSync(path.join(ALLOWED, 'm1.txt'), '1');
  fs.writeFileSync(path.join(ALLOWED, 'm2.txt'), '2');
  const r = await call('move_file', { source: path.join(ALLOWED, 'm1.txt'), destination: path.join(ALLOWED, 'm2.txt') });
  assert.equal(r.isError, true);
});

test('get_file_info：返回元信息', async () => {
  const r = await call('get_file_info', { path: path.join(ALLOWED, 'hello.txt') });
  assert.match(r.text, /类型: 文件/);
});

test('search_files：文件名与内容匹配', async () => {
  const r1 = await call('search_files', { path: ALLOWED, pattern: 'note', match_content: false });
  assert.match(r1.text, /note\.md/);

  const r2 = await call('search_files', { path: ALLOWED, pattern: 'needle' });
  assert.match(r2.text, /note\.md/);
  assert.match(r2.text, /内容匹配/);

  const r3 = await call('search_files', { path: ALLOWED, pattern: '绝对不会出现的词xyz' });
  assert.match(r3.text, /未找到/);
});

test('search_files：通配符文件名匹配', async () => {
  const r = await call('search_files', { path: ALLOWED, pattern: '*.txt' });
  assert.match(r.text, /hello\.txt/);
});

test('execute_command：输出/退出码/超时；越权 workdir 被拒绝', async () => {
  const r1 = await call('execute_command', { command: 'echo hello-shell && pwd' });
  assert.equal(r1.isError, false);
  assert.match(r1.text, /hello-shell/);
  assert.match(r1.text, /退出码: 0/);

  const r2 = await call('execute_command', { command: 'exit 3' });
  assert.equal(r2.isError, true);
  assert.match(r2.text, /退出码: 3/);

  const r3 = await call('execute_command', { command: 'sleep 30', timeout_seconds: 1 });
  assert.match(r3.text, /超时/);

  // 回归：超时任务结束后，下一条终端命令必须立即可执行，不得被残留锁阻塞。
  const r3b = await call('execute_command', { command: 'printf AFTER_TIMEOUT_OK' });
  assert.equal(r3b.isError, false);
  assert.match(r3b.text, /AFTER_TIMEOUT_OK/);
  assert.match(r3b.text, /退出码: 0/);

  const r4 = await call('execute_command', { command: 'pwd', workdir: '/etc' });
  assert.equal(r4.isError, true);
  assert.match(r4.text, /workdir 非法/);
});

test('SSH 会话：默认关闭且不会尝试连接', async () => {
  const r = await call('ssh_session_open', {
    host: '127.0.0.1',
    username: 'test-user',
    auth_method: 'password',
    password: 'do-not-log-this',
    host_fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  });
  assert.equal(r.isError, true);
  assert.match(r.text, /SSH 会话功能已禁用/);
  assert.doesNotMatch(r.text, /do-not-log-this/);
});

test('execute_command：配置禁用 shell 时拒绝', async () => {
  const disabledCtx = createToolContext({
    guard: new PathGuard([ALLOWED]),
    config: { ...config, agent: { ...config.agent, allowShell: false } },
    logger: noopLogger,
  });
  const r = await callTool(disabledCtx, 'execute_command', { command: 'echo x' });
  assert.equal(r.isError, true);
  assert.match(r.text, /已被配置禁用/);
});

test('list_processes：返回当前进程信息', async () => {
  const r = await call('list_processes', {});
  assert.match(r.text, /PID/);
});

test('kill_process：非法 pid 在协议层被拒绝', async () => {
  await assert.rejects(() => call('kill_process', { pid: -1 }), /参数不合法/);
});

test('callTool：未知工具 / 非法参数抛协议错误', async () => {
  await assert.rejects(() => callTool(ctx, 'no_such_tool', {}), /未知工具/);
  await assert.rejects(() => callTool(ctx, 'read_file', { path: 123 }), /参数不合法/);
});