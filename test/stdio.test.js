/**
 * stdio 直连模式集成测试：模拟 Claude Desktop / Codex 等本地客户端
 * 直接拉起 bin/stdio.js 进程，通过标准输入输出协议调用工具。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const PROJECT = path.join(import.meta.dirname, '..');
const WORK = path.join(import.meta.dirname, 'tmp-stdio');

let client = null;

before(async () => {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(path.join(WORK, 'hello.txt'), 'stdio 直连测试\n');

  client = new Client({ name: 'stdio-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(PROJECT, 'bin', 'stdio.js')],
    cwd: PROJECT,
    stderr: 'pipe',
    // 隔离生产配置（config.local.json 可能设置了 allowAllDirs），强制白名单模式 + 以 WORK 为授权目录
    env: { CDC_ALLOW_ALL_DIRS: 'false', CDC_ALLOWED_DIRS: WORK },
  });
  await client.connect(transport);
});

after(async () => {
  try { await client?.close(); } catch { /* ignore */ }
  fs.rmSync(WORK, { recursive: true, force: true });
});

test('stdio 模式：工具列表与文件读写可用', async () => {
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 19);

  const r = await client.callTool({ name: 'read_file', arguments: { path: path.join(WORK, 'hello.txt') } });
  assert.match(r.content[0].text, /stdio 直连测试/);

  const w = await client.callTool({ name: 'write_file', arguments: { path: path.join(WORK, 'new.txt'), content: '来自 stdio 客户端' } });
  assert.equal(w.isError, false);
  assert.equal(fs.readFileSync(path.join(WORK, 'new.txt'), 'utf8'), '来自 stdio 客户端');
});

test('stdio 模式：目录逃逸被拦截', async () => {
  const r = await client.callTool({ name: 'read_file', arguments: { path: '/etc/hosts' } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /拒绝访问/);
});