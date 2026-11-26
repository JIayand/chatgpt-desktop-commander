/**
 * OAuth 2.1 授权支持（MCP Remote Server 标准流程）：
 *   - Protected Resource Metadata（RFC 9728）：GET /.well-known/oauth-protected-resource
 *   - 授权服务器元数据（RFC 8414）           ：GET /.well-known/oauth-authorization-server
 *   - 动态客户端注册（RFC 7591 / DCR）       ：POST /oauth/register
 *   - 授权码 + PKCE(S256)                    ：GET/POST /oauth/authorize
 *   - 令牌交换                                ：POST /oauth/token
 *
 * 设计说明：
 *   - access_token 直接复用静态 apiKey 签发（token_type=Bearer），因此资源端验证无需后端状态、
 *     服务重启后令牌依然有效，也无需单独持久化；授权码为一次性、5 分钟有效、仅存内存。
 *   - 授权流程图解：ChatGPT 先无凭证访问 /mcp → 收到 401+WWW-Authenticate → 读取 PRM/AS 元数据
 *     → DCR 注册 → 浏览器跳转 /oauth/authorize 展示同意页 → 用户点「授权」→ 302 带回 code
 *     → ChatGPT 用 code + code_verifier(PKCE) 换 token → 后续请求带 Bearer token。
 */
import crypto from 'node:crypto';

const CODE_TTL_MS = 5 * 60 * 1000;              // 授权码有效期
const ACCESS_TOKEN_TTL_S = 60 * 60 * 24 * 365;  // access_token 有效时长（复用 apiKey，连年)
const OAUTH_PATHS = {
  prm: '/.well-known/oauth-protected-resource',
  asMetadata: '/.well-known/oauth-authorization-server',
  register: '/oauth/register',
  authorize: '/oauth/authorize',
  token: '/oauth/token',
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function send(res, code, obj, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS, ...headers });
  res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

/** 解析请求体，兼容 JSON 与 application/x-www-form-urlencoded（OAuth 常用后者） */
async function readParams(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  const ct = req.headers['content-type'] ?? '';
  if (ct.includes('application/json')) {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

export function createOauth({ baseUrl, mcpUrl, apiKey, logger, dynamicOrigin = false }) {
  const codes = new Map();    // code -> { codeChallenge, redirectUri, clientId, expiresAt }
  const clients = new Map();  // clientId -> Set(redirectUris)

  /** 根据当前请求头构造 origin，兼容 localhost / 127.0.0.1 / ::1 任意入口 */
  function originFromRequest(req) {
    if (!dynamicOrigin) return null;
    const host = req.headers.host ?? '';
    if (!host) return null;
    const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    // IPv6 地址加方括号
    const hostForUrl = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    return `${proto}://${hostForUrl}`;
  }

  const prm = (overrideBase) => {
    const base = overrideBase || baseUrl;
    const mcp = overrideBase ? `${overrideBase}${mcpUrl.replace(baseUrl, '')}` : mcpUrl;
    return {
      resource: mcp,
      authorization_servers: [base],
      scopes_supported: [],
    };
  };

  const asMetadata = (overrideBase) => {
    const base = overrideBase || baseUrl;
    const mcp = overrideBase ? `${overrideBase}${mcpUrl.replace(baseUrl, '')}` : mcpUrl;
    return {
      issuer: base,
      authorization_endpoint: `${base}${OAUTH_PATHS.authorize}`,
      token_endpoint: `${base}${OAUTH_PATHS.token}`,
      registration_endpoint: `${base}${OAUTH_PATHS.register}`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      grant_types_supported: ['authorization_code'],
      scopes_supported: [],
    };
  };

  function verifyPkce(verifier, challenge) {
    try {
      const hash = crypto.createHash('sha256').update(verifier).digest('base64url');
      return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(String(challenge ?? '')));
    } catch {
      return false;
    }
  }

  function isSafeRedirect(uri) {
    return /^https:\/\//i.test(uri) || /^http:\/\/localhost[:/]/i.test(uri) || /^http:\/\/127\.0\.0\.1[:/]/i.test(uri);
  }

  function redirectOrError(res, redirectUri, params) {
    if (isSafeRedirect(redirectUri)) {
      const q = new URLSearchParams(params).toString();
      res.writeHead(302, { Location: `${redirectUri}${redirectUri.includes('?') ? '&' : '?'}${q}` });
      res.end();
      return;
    }
    send(res, 400, { error: 'invalid_request', error_description: 'redirect_uri 非法' });
  }

  // ── 授权同意页 ─────────────────────────────────────────
  function consentPage(params) {
    const hidden = Object.entries(params)
      .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
      .join('\n      ');
    return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ChatToDesktop 授权</title>
<style>
body{font-family:-apple-system,"PingFang SC",sans-serif;background:#f7f7f8;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box}
.card{background:#fff;border:1px solid #e5e5e7;border-radius:16px;padding:32px;max-width:420px;width:100%;box-shadow:0 4px 20px rgba(0,0,0,.04)}
h1{font-size:20px;margin:0 0 8px;color:#171717}
p{font-size:14px;color:#52525b;line-height:1.6;margin:0 0 20px}
code{background:#f0f0f2;border-radius:4px;padding:2px 6px;font-size:13px}
button{width:100%;background:#0b57d0;color:#fff;border:0;border-radius:12px;padding:12px;font-size:15px;cursor:pointer}
button:hover{background:#0a4cb8}
.warn{font-size:12px;color:#a1a1aa;margin-top:14px}
</style></head><body>
<div class="card">
  <h1>🔐 授权 ChatGPT 访问本机</h1>
  <p style="word-break:break-all">ChatGPT 连接器请求访问：<br><code>${escapeHtml(params.redirect_uri || '')}</code></p>
  <p>授权后，ChatGPT 将能够通过你本地运行的 ChatToDesktop，在已白名单的目录内读写文件、执行命令。</p>
  <form method="POST" action="${escapeHtml(OAUTH_PATHS.authorize)}">
    ${hidden}
    <button type="submit">授权</button>
  </form>
  <p class="warn">仅对你自己搭建的 ChatToDesktop 实例授权。</p>
</div>
</body></html>`;
  }

  const errorPage = (message) => `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>授权失败</title></head>
<body style="font-family:-apple-system,'PingFang SC',sans-serif;padding:40px">
<h1>⚠️ 授权失败</h1><p>${escapeHtml(message)}</p></body></html>`;

  // ── DCR 注册 ───────────────────────────────────────────
  async function register(req, res) {
    const body = await readParams(req);
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter(Boolean) : [];
    if (redirectUris.length === 0) {
      send(res, 400, { error: 'invalid_redirect_uri', error_description: 'redirect_uris 不能为空' });
      return;
    }
    const clientId = crypto.randomBytes(16).toString('hex');
    clients.set(clientId, new Set(redirectUris));
    logger.info(`OAuth 客户端已注册：${body.client_name ?? '(未命名)'} redirect=${redirectUris.join(', ')}`);
    send(res, 201, {
      client_id: clientId,
      client_secret_expires_at: 0,
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      redirect_uris: redirectUris,
    });
  }

  // ── 授权 ───────────────────────────────────────────────
  async function authorize(req, res, url) {
    // GET：参数在查询串；POST：参数在表单体（同意页 submit）
    let params;
    if (req.method === 'POST') {
      const b = await readParams(req);
      params = {
        response_type: b.response_type ?? '',
        client_id: b.client_id ?? '',
        redirect_uri: b.redirect_uri ?? '',
        code_challenge: b.code_challenge ?? '',
        code_challenge_method: b.code_challenge_method ?? '',
        state: b.state ?? '',
        scope: b.scope ?? '',
      };
    } else {
      const q = url.searchParams;
      params = {
        response_type: q.get('response_type') ?? '',
        client_id: q.get('client_id') ?? '',
        redirect_uri: q.get('redirect_uri') ?? '',
        code_challenge: q.get('code_challenge') ?? '',
        code_challenge_method: q.get('code_challenge_method') ?? '',
        state: q.get('state') ?? '',
        scope: q.get('scope') ?? '',
      };
    }

    const fail = (msg) => send(res, 400, errorPage(msg), { 'Content-Type': 'text/html; charset=utf-8' });

    if (params.response_type !== 'code') return fail('response_type 必须是 code');
    if (!params.client_id) return fail('缺少 client_id');
    if (!isSafeRedirect(params.redirect_uri)) return fail('redirect_uri 非法');
    if (!params.code_challenge) return fail('缺少 code_challenge');
    if (params.code_challenge_method !== 'S256') return fail('仅支持 PKCE S256');

    const client = clients.get(params.client_id);
    if (client && !client.has(params.redirect_uri)) {
      return fail('redirect_uri 与注册信息不一致');
    }

    // 用户在同意页点击「授权」→ POST 提交确认
    if (req.method === 'POST') {
      const code = crypto.randomBytes(24).toString('hex');
      codes.set(code, {
        codeChallenge: params.code_challenge,
        redirectUri: params.redirect_uri,
        clientId: params.client_id,
        expiresAt: Date.now() + CODE_TTL_MS,
      });
      logger.info('OAuth 授权码已签发');
      redirectOrError(res, params.redirect_uri, { code, ...(params.state ? { state: params.state } : {}) });
      return;
    }

    // GET 显示同意页
    send(res, 200, consentPage(params), { 'Content-Type': 'text/html; charset=utf-8' });
  }

  // ── 令牌交换 ───────────────────────────────────────────
  async function token(req, res) {
    const body = await readParams(req);
    if (body.grant_type !== 'authorization_code') {
      send(res, 400, { error: 'unsupported_grant_type' });
      return;
    }
    const bad = () => send(res, 400, { error: 'invalid_grant' });

    const entry = codes.get(body.code);
    if (!entry || Date.now() > entry.expiresAt) return bad();
    if (!verifyPkce(body.code_verifier ?? '', entry.codeChallenge)) return bad();
    if (body.redirect_uri && body.redirect_uri !== entry.redirectUri) return bad();
    if (body.client_id && body.client_id !== entry.clientId) return bad();

    codes.delete(body.code); // 授权码一次性
    logger.info('OAuth 令牌已签发（复用静态 apiKey 作为 access_token）');
    send(res, 200, {
      access_token: apiKey,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_S,
      scope: '',
    });
  }

  // ── 统一路由：命中即处理并返回 true ────────────────────
  async function tryHandle(req, res, url) {
    const p = url.pathname;
    const dynBase = originFromRequest(req);
    if (p === OAUTH_PATHS.prm) { send(res, 200, prm(dynBase)); return true; }
    if (p === OAUTH_PATHS.asMetadata) { send(res, 200, asMetadata(dynBase)); return true; }
    if (p === OAUTH_PATHS.register && req.method === 'POST') { await register(req, res); return true; }
    if (p === OAUTH_PATHS.authorize) { await authorize(req, res, url); return true; }
    if (p === OAUTH_PATHS.token && req.method === 'POST') { await token(req, res); return true; }
    return false;
  }

  return { tryHandle, prm, asMetadata };
}