/**
 * OAuth 2.1（MCP Remote Server 标准流程）测试：
 *   PRM / AS 元数据 → DCR 注册 → 授权码 + PKCE(S256) → 令牌交换 → Bearer 校验
 * 负例：错误 verifier / 授权码复用 / 未认证 401 + WWW-Authenticate 头。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PORT = 18724;
const BASE = `http://127.0.0.1:${PORT}`;
const PROJECT = path.join(import.meta.dirname, '..');
const REDIRECT = 'http://localhost:3000/callback';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pkceChallenge = (verifier) => crypto.createHash('sha256').update(verifier).digest('base64url');

/** 通过原始 http 请求发起 POST，以读取 302 的 Location 头（fetch+manual 会返回 opaque redirect） */
function postRaw(url, bodyStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(bodyStr) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(bodyStr);
  });
}

/** 走完整授权码流程拿到授权码 */
async function obtainAuthCode(clientId) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = pkceChallenge(verifier);
  const params = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz123' });
  const confirm = await postRaw(`${BASE}/oauth/authorize`, params.toString());
  assert.equal(confirm.status, 302);
  const code = new URL(confirm.location).searchParams.get('code');
  assert.ok(code);
  return { code, verifier };
}

let relay = null;
let relayLog = '';

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${label}\n${relayLog}`);
    await sleep(150);
  }
}

before(async () => {
  relay = spawn(process.execPath, ['bin/relay.js'], {
    cwd: PROJECT,
    env: { ...process.env, CDC_PORT: String(PORT), CDC_PUBLIC_URL: BASE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  relay.stdout.on('data', (d) => { relayLog += d; });
  relay.stderr.on('data', (d) => { relayLog += d; });
  await waitFor(async () => {
    try { return (await fetch(`${BASE}/healthz`)).ok; } catch { return false; }
  }, 20000, 'Relay 启动');
});

after(() => {
  if (relay && relay.exitCode === null) relay.kill('SIGTERM');
});

test('PRM 元数据正确', async () => {
  const res = await fetch(`${BASE}/.well-known/oauth-protected-resource`);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.resource, `${BASE}/mcp`);
  assert.deepEqual(j.authorization_servers, [BASE]);
});

test('授权服务器元数据正确（RFC 8414）', async () => {
  const res = await fetch(`${BASE}/.well-known/oauth-authorization-server`);
  const j = await res.json();
  assert.equal(j.authorization_endpoint, `${BASE}/oauth/authorize`);
  assert.equal(j.token_endpoint, `${BASE}/oauth/token`);
  assert.equal(j.registration_endpoint, `${BASE}/oauth/register`);
  assert.ok(j.code_challenge_methods_supported.includes('S256'));
  assert.ok(j.token_endpoint_auth_methods_supported.includes('none'));
});

test('完整授权码 + PKCE 流程（注册→授权→令牌→Bearer 调用）', async () => {
  // 1) DCR 注册
  const reg = await fetch(`${BASE}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'oauth-test', redirect_uris: [REDIRECT] }),
  });
  assert.equal(reg.status, 201);
  const regBody = await reg.json();
  assert.ok(regBody.client_id);

  // 2) GET 授权同意页
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = pkceChallenge(verifier);
  const authParams = new URLSearchParams({
    response_type: 'code',
    client_id: regBody.client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz123',
  });
  const consent = await fetch(`${BASE}/oauth/authorize?${authParams}`);
  assert.equal(consent.status, 200);
  assert.match(await consent.text(), /授权/);

  // 3) POST 确认 → 302 带回 code
  const confirm = await postRaw(`${BASE}/oauth/authorize`, authParams.toString());
  assert.equal(confirm.status, 302);
  const loc = new URL(confirm.location);
  assert.equal(loc.origin, 'http://localhost:3000');
  assert.equal(loc.searchParams.get('state'), 'xyz123');
  const code = loc.searchParams.get('code');
  assert.ok(code);

  // 4) 令牌交换
  const token = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: regBody.client_id,
      redirect_uri: REDIRECT,
    }).toString(),
  });
  const tok = await token.json();
  assert.equal(tok.token_type, 'Bearer');
  assert.ok(tok.access_token);

  // 5) 用拿到的 access_token 调 MCP 端点（tools/list）
  const client = new Client({ name: 'oauth-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${tok.access_token}` } },
  });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 19);
  await client.close();
});

test('PKCE 校验失败：错误 verifier → invalid_grant', async () => {
  const reg = await (await fetch(`${BASE}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'neg', redirect_uris: [REDIRECT] }),
  })).json();

  const { code } = await obtainAuthCode(reg.client_id);

  const token = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: 'wrong-verifier', client_id: reg.client_id }).toString(),
  });
  assert.equal(token.status, 400);
  assert.equal((await token.json()).error, 'invalid_grant');
});

test('授权码一次性：重复换取 → invalid_grant', async () => {
  const reg = await (await fetch(`${BASE}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'reuse', redirect_uris: [REDIRECT] }),
  })).json();
  const { code, verifier } = await obtainAuthCode(reg.client_id);
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.client_id }).toString();

  const first = await fetch(`${BASE}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  assert.equal(first.status, 200);

  const second = await fetch(`${BASE}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  assert.equal(second.status, 400);
  assert.equal((await second.json()).error, 'invalid_grant');
});

test('未认证请求返回 401 并携带 WWW-Authenticate', async () => {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(res.status, 401);
  const www = res.headers.get('www-authenticate') ?? '';
  assert.match(www, /resource_metadata=/);
  assert.match(www, /oauth-protected-resource/);
});