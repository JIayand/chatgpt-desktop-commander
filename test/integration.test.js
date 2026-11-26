/**
 * 端到端集成测试：完整模拟 ChatGPT 网页版的连接路径
 * MCP HTTP 客户端(带 API Key) → Relay(mcpPath) → WebSocket 桥 → 本地 Agent → 工具执行
 * 覆盖：工具列表 / 文件读写回环 / 终端执行 / 未认证 401 / 设备离线报错
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig } from '../src/shared/config.js';

const PORT = 18723;
const BASE = `http://127.0.0.1:${PORT}`;
const PROJECT = path.join(import.meta.dirname, '..');
const WORK = path.join(import.meta.dirname, 'tmp-integration');
const API_KEY = loadConfig('relay').relay.apiKey;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let relay = null;
let agent = null;
let client = null;
let relayLog = '';
let agentLog = '';

async function health() {
  try {
    const res = await fetch(`${BASE}/healthz`);
    return await res.json();
  } catch {
    return null;
  }
}

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`等待超时：${label}\n--- relay 日志 ---\n${relayLog}\n--- agent 日志 ---\n${agentLog}`);
    }
    await sleep(250);
  }
}

before(async () => {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(path.join(WORK, 'fixture.txt'), '端到端测试文件\n第二行 line2\n');

  relay = spawn(process.execPath, ['bin/relay.js'], {
    cwd: PROJECT,
    env: { ...process.env, CDC_PORT: String(PORT), CDC_USAGE_FILE: path.join(WORK, 'usage.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  relay.stdout.on('data', (d) => { relayLog += d; });
  relay.stderr.on('data', (d) => { relayLog += d; });
  await waitFor(async () => (await health())?.ok === true, 20000, 'Relay 启动并监听 /healthz');

  agent = spawn(process.execPath, ['bin/agent.js'], {
    cwd: PROJECT,
    env: { ...process.env, CDC_RELAY_URL: `ws://127.0.0.1:${PORT}/bridge` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  agent.stdout.on('data', (d) => { agentLog += d; });
  agent.stderr.on('data', (d) => { agentLog += d; });
  await waitFor(async () => (await health())?.agentOnline === true, 20000, 'Agent 上线');

  client = new Client({ name: 'integration-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { 'X-API-Key': API_KEY } },
  });
  await client.connect(transport);
});

after(async () => {
  try { await client?.close(); } catch { /* ignore */ }
  for (const child of [agent, relay]) {
    if (child && child.exitCode === null) child.kill('SIGTERM');
  }
  fs.rmSync(WORK, { recursive: true, force: true });
});

test('工具列表：19 个工具全部经 Relay 可见', async () => {
  const res = await client.listTools();
  const names = res.tools.map((t) => t.name);
  assert.equal(names.length, 19);
  for (const n of ['read_file', 'write_file', 'receive_image_file', 'execute_command', 'search_files']) {
    assert.ok(names.includes(n), `缺少 ${n}`);
  }
});

test('receive_image_file：通过 MCP 把 PNG 二进制写入本机且拒绝覆盖/伪造类型', async () => {
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQioAAAAASUVORK5CYII=';
  const target = path.join(WORK, 'generated-test.png');
  const saved = await client.callTool({ name: 'receive_image_file', arguments: { directory: WORK, file_name: 'generated-test.png', data_base64: pngBase64 } });
  assert.equal(saved.isError, false, saved.content?.[0]?.text);
  assert.deepEqual(fs.readFileSync(target), Buffer.from(pngBase64, 'base64'));
  const overwrite = await client.callTool({ name: 'receive_image_file', arguments: { directory: WORK, file_name: 'generated-test.png', data_base64: pngBase64 } });
  assert.equal(overwrite.isError, true);
  const fake = await client.callTool({ name: 'receive_image_file', arguments: { directory: WORK, file_name: 'fake.png', data_base64: Buffer.from('not a png').toString('base64') } });
  assert.equal(fake.isError, true);
  assert.equal(fs.existsSync(path.join(WORK, 'fake.png')), false);
  // 工具正常返回业务错误（例如目标已存在、文件类型不符），仍属于一次成功完成的工具调用。
  const usage = JSON.parse(fs.readFileSync(path.join(WORK, 'usage.json'), 'utf8'));
  assert.deepEqual(usage.tools.receive_image_file, { ok: 3, fail: 0 });
});

test('read_file：端到端读取本地文件', async () => {
  const res = await client.callTool({ name: 'read_file', arguments: { path: path.join(WORK, 'fixture.txt') } });
  assert.equal(res.isError, false);
  assert.match(res.content[0].text, /端到端测试文件/);
});

test('write_file → read_file 回环（含自动备份）', async () => {
  const p = path.join(WORK, 'roundtrip.txt');
  const w = await client.callTool({ name: 'write_file', arguments: { path: p, content: '回环内容 v1' } });
  assert.equal(w.isError, false);

  const r1 = await client.callTool({ name: 'read_file', arguments: { path: p } });
  assert.match(r1.content[0].text, /回环内容 v1/);

  await client.callTool({ name: 'write_file', arguments: { path: p, content: '回环内容 v2' } });
  const backups = fs.readdirSync(path.join(WORK, '.backups'));
  assert.equal(backups.length, 1, '覆盖写入应生成 1 份备份');

  const r2 = await client.callTool({ name: 'read_file', arguments: { path: p } });
  assert.match(r2.content[0].text, /回环内容 v2/);
});

test('edit_file：端到端精确替换', async () => {
  const p = path.join(WORK, 'edit-e2e.txt');
  await client.callTool({ name: 'write_file', arguments: { path: p, content: 'AAA 123 BBB\n' } });
  const r = await client.callTool({ name: 'edit_file', arguments: { path: p, old_string: '123', new_string: '456' } });
  assert.equal(r.isError, false);
  assert.equal(fs.readFileSync(p, 'utf8'), 'AAA 456 BBB\n');
});

test('execute_command：端到端执行终端命令', async () => {
  const res = await client.callTool({ name: 'execute_command', arguments: { command: 'echo e2e-shell && date +%s | head -c 4', workdir: WORK } });
  assert.equal(res.isError, false);
  assert.match(res.content[0].text, /e2e-shell/);
  assert.match(res.content[0].text, /退出码: 0/);
});

test('search_files：端到端搜索', async () => {
  const res = await client.callTool({ name: 'search_files', arguments: { path: WORK, pattern: 'fixture', match_content: false } });
  assert.match(res.content[0].text, /fixture\.txt/);
});

test('未认证请求被拒绝（401）', async () => {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(res.status, 401);
});

test('Agent 离线后调用工具返回清晰错误', async () => {
  agent.kill('SIGTERM');
  await waitFor(async () => (await health())?.agentOnline === false, 15000, 'Agent 断开');
  // SDK 客户端将协议错误包装为 isError 结果（与 ChatGPT 看到的形态一致）
  const res = await client.callTool({ name: 'read_file', arguments: { path: path.join(WORK, 'fixture.txt') } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /设备离线/);
});

test('状态页可访问且包含当前状态', async () => {
  const res = await fetch(BASE + '/');
  const html = await res.text();
  assert.match(html, /ChatToDesktop/);
});