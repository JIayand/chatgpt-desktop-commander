/**
 * Relay 中枢：
 *  - {mcpPath}  MCP streamable HTTP 端点（API Key 认证），供 ChatGPT 网页版等远程客户端连接；
 *  - {bridgePath} WebSocket 桥接通道（Bridge Token 认证），本地 Agent 出站回连；
 *  - /healthz 健康检查、/ 设备状态页（配合 Cloudflare Tunnel 暴露公网）。
 */
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig, PROJECT_ROOT } from '../shared/config.js';
import { createLogger, printBanner } from '../shared/logger.js';
import { createOauth } from './oauth.js';
import { UsageTracker } from '../shared/usage.js';
import { TOOL_DEFS } from '../tools/index.js';

const SERVICE_NAME = 'chatgpt-desktop-commander';
const SERVICE_VERSION = '1.0.0';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, Mcp-Session-Id, mcp-session-id, Mcp-Protocol-Version, mcp-protocol-version, Last-Event-ID, Accept',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, mcp-session-id',
};

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const hb = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export async function startRelay() {
  const config = loadConfig('relay');
  const logger = createLogger('relay');
  printBanner('relay');

  const { host, port, mcpPath, bridgePath, apiKey, bridgeToken, agentTimeoutMs } = config.relay;

  // 对外基地址：接入 ChatGPT 需走公网 HTTPS（Cloudflare Tunnel），OAuth 元数据必须用公网地址
  // 若 publicUrl 为空，OAuth issuer 将根据每个请求的 Host 头动态生成（兼容 localhost / 127.0.0.1 / ::1 任意入口）
  const publicUrl = String(config.relay.publicUrl ?? '').trim().replace(/\/+$/, '');
  const fallbackBase = `http://${host}:${port}`;
  const baseUrl = publicUrl || fallbackBase;
  const oauth = createOauth({ baseUrl, mcpUrl: `${baseUrl}${mcpPath}`, apiKey, logger, dynamicOrigin: !publicUrl });

  // 用量统计（持久化到 data/usage.json；测试可用 CDC_USAGE_FILE 隔离）
  const usage = new UsageTracker(process.env.CDC_USAGE_FILE || path.join(PROJECT_ROOT, 'data', 'usage.json'));

  // ── Agent 连接池与任务队列 ─────────────────────────────
  const agents = new Map(); // ws -> device info
  const pending = new Map(); // taskId -> { resolve, reject, timer, socket }

  function onlineAgent() {
    for (const [socket, info] of agents.entries()) {
      if (socket.readyState === 1) return { socket, info };
    }
    return null;
  }

  function rejectPendingOf(socket, reason) {
    for (const [taskId, p] of pending.entries()) {
      if (p.socket === socket) {
        clearTimeout(p.timer);
        p.reject(new McpError(ErrorCode.InternalError, reason));
        pending.delete(taskId);
      }
    }
  }

  function dispatchToAgent(name, args) {
    const a = onlineAgent();
    if (!a) {
      usage.record(name, false, '本地设备离线：请先启动 Agent 后重试');
      throw new McpError(ErrorCode.InternalError, '本地设备离线：请先在你的电脑上启动 Agent（npm run agent / scripts/start.sh）后再试');
    }
    const taskId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(taskId);
        usage.record(name, false, `任务超时（${agentTimeoutMs}ms）：设备未响应工具 ${name}`);
        reject(new McpError(ErrorCode.InternalError, `任务超时（${agentTimeoutMs}ms）：设备未响应工具 ${name}`));
      }, agentTimeoutMs);
      pending.set(taskId, {
        resolve: (result) => { usage.record(name, true); resolve(result); },
        reject: (err) => { usage.record(name, false, err?.message || String(err)); reject(err); },
        timer,
        socket: a.socket,
      });
      a.socket.send(JSON.stringify({ type: 'task', taskId, name, arguments: args }));
    });
  }

  // ── MCP Server 工厂（stateless 模式：每个 HTTP 请求一个独立实例，避免传输连接竞态） ──
  const createMcpServer = () => {
    const server = new McpServer({ name: SERVICE_NAME, version: SERVICE_VERSION });
    for (const def of TOOL_DEFS) {
      server.registerTool(def.name, { description: def.description, inputSchema: def.schema }, async (args) => {
        return await dispatchToAgent(def.name, args);
      });
    }
    return server;
  };
  logger.info(`已注册 ${TOOL_DEFS.length} 个工具：${TOOL_DEFS.map((t) => t.name).join(', ')}`);

  // ── WebSocket 桥接（Agent 连接） ───────────────────────
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.device = null;
    const helloTimer = setTimeout(() => {
      if (!ws.device) {
        logger.warn('Agent 未在 30 秒内完成握手，断开');
        ws.close(4001, '握手超时');
      }
    }, 30000);
    helloTimer.unref();

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === 'hello') {
        if (!safeEqual(msg.token, bridgeToken)) {
          logger.warn('Agent 握手 token 校验失败，断开');
          ws.close(4003, 'token 校验失败');
          return;
        }
        ws.device = msg.device ?? { name: 'unknown' };
        clearTimeout(helloTimer);
        agents.set(ws, { ...ws.device, lastSeen: Date.now() });
        const dirDesc = ws.device.allowAllDirs ? '所有目录' : `${(ws.device.allowedDirs ?? []).length} 个`;
        logger.info(`🔗 设备上线：${ws.device.name} (${ws.device.hostname ?? '?'} · ${ws.device.platform ?? '?'})，授权范围：${dirDesc}`);
        ws.send(JSON.stringify({ type: 'hello_ok', message: '已接入中枢，等待任务' }));
      } else if (msg.type === 'heartbeat') {
        if (agents.has(ws)) agents.get(ws).lastSeen = Date.now();
      } else if (msg.type === 'task_result' || msg.type === 'task_error') {
        const p = pending.get(msg.taskId);
        if (p) {
          clearTimeout(p.timer);
          pending.delete(msg.taskId);
          if (msg.type === 'task_result') {
            p.resolve(msg.result);
          } else {
            p.reject(new McpError(ErrorCode.InternalError, `设备执行失败：${msg.error}`));
          }
        }
      }
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (agents.has(ws)) {
        const info = agents.get(ws);
        logger.warn(`🔌 设备离线：${info.name}`);
        agents.delete(ws);
      }
      rejectPendingOf(ws, '设备在执行任务时离线，任务已中止');
      ws.device = null;
    });
    ws.on('error', () => { /* close 事件会处理 */ });
  });

  // 心跳巡检：清理僵尸连接
  const heartbeatTimer = setInterval(() => {
    for (const [ws] of agents.entries()) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);
  heartbeatTimer.unref();

  // ── 认证 ──────────────────────────────────────────────
  function authorized(req) {
    const auth = req.headers.authorization ?? '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const xKey = Array.isArray(req.headers['x-api-key']) ? req.headers['x-api-key'][0] : req.headers['x-api-key'];
    return safeEqual(bearer || '', apiKey) || safeEqual(xKey || '', apiKey);
  }

  function sendJson(res, code, obj, extraHeaders = {}) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS, ...extraHeaders });
    res.end(body);
  }

  // ── 设备状态页 ────────────────────────────────────────
  function statusPage() {
    const a = onlineAgent();
    const agent = a?.info ?? null;
    const dirs = agent?.allowAllDirs
      ? '<li>所有目录（无白名单限制）</li>'
      : (agent?.allowedDirs ?? []).map((d) => `<li>${escapeHtml(d)}</li>`).join('');

    const us = usage.stats();
    const maxTool = Math.max(1, ...us.tools.map((t) => t.total));
    const toolRows = us.tools.length
      ? us.tools.map((t) => {
          const pct = Math.round((t.total / maxTool) * 100);
          const def = TOOL_DEFS.find((item) => item.name === t.name);
          return `<button class="tool-row tool-button" data-tool="${escapeHtml(t.name)}" aria-label="查看 ${escapeHtml(t.name)} 工具说明"><span class="tool-name">${escapeHtml(t.name)}</span><div class="tool-bar"><div class="tool-fill" style="width:${pct}%"></div></div><span class="tool-count">${t.total}</span><span class="tool-rate">${t.total ? Math.round(t.ok / t.total * 100) : 0}% 成功</span></button>`;
        }).join('')
      : '<p class="empty">暂无调用记录，使用 ChatGPT 调用本地工具后这里会显示统计。</p>';
    const toolCatalog = TOOL_DEFS.map((t) => ({ name: t.name, description: t.description, parameters: Object.entries(t.schema ?? {}).map(([name, schema]) => ({ name, description: schema.description || '未提供参数说明' })) }));
    const chips = TOOL_DEFS.map((t) => `<button class="chip tool-button" data-tool="${escapeHtml(t.name)}" title="点击查看工具说明">${escapeHtml(t.name)}</button>`).join('');

    return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ChatToDesktop</title>
<style>*{box-sizing:border-box;margin:0}body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif;max-width:720px;margin:0 auto;padding:44px 24px 80px;color:#e5e7eb;background:#0a0a0a;-webkit-font-smoothing:antialiased}
.brand{display:flex;align-items:center;gap:11px}.logo{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,#3b82f6,#7c3aed);display:flex;align-items:center;justify-content:center;font-size:16px;color:#fff;font-weight:700}.brand h1{font-size:22px;font-weight:700;color:#fff;letter-spacing:-.02em}
.tagline{color:#6b7280;font-size:13px;margin:8px 0 30px}
.card{background:#141414;border:1px solid rgba(255,255,255,.06);border-radius:14px;padding:18px 20px;margin:10px 0}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px;min-width:0}
h2{font-size:15px;font-weight:600;color:#fff}
h3{font-size:11px;font-weight:600;color:#9ca3af;text-transform:uppercase;letter-spacing:.08em;margin:24px 0 12px}
.badge{font-size:12px;font-weight:600;padding:3px 11px;border-radius:999px}.badge.online{background:rgba(34,197,94,.13);color:#22c55e}.badge.offline{background:rgba(239,68,68,.13);color:#ef4444}
.hero{display:flex;align-items:baseline;gap:11px;margin:2px 0 4px}.hero-num{font-size:46px;font-weight:700;color:#fff;line-height:1;letter-spacing:-.03em;font-variant-numeric:tabular-nums}.hero-label{color:#6b7280;font-size:14px}
.mini{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:14px 0 4px}
.mini-item{background:#191919;border:1px solid rgba(255,255,255,.05);border-radius:12px;padding:14px 16px}
.mini-num{font-size:26px;font-weight:700;font-variant-numeric:tabular-nums;display:block;letter-spacing:-.02em}.mini-label{font-size:12px;color:#9ca3af}
.mini-item.ok .mini-num{color:#22c55e}.mini-item.fail .mini-num{color:#ef4444}
.tool-row{display:flex;align-items:center;gap:12px;padding:7px 0}
.tool-name{width:150px;font-size:13px;color:#e5e7eb;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tool-bar{flex:1;height:6px;background:#262626;border-radius:3px;overflow:hidden}
.tool-fill{height:100%;background:linear-gradient(90deg,#3b82f6,#6366f1);border-radius:3px}
.tool-count{width:42px;text-align:right;font-size:13px;color:#9ca3af;font-variant-numeric:tabular-nums;flex-shrink:0}
.chart{display:flex;align-items:flex-end;gap:10px;height:150px;padding-top:8px}
.bar-col{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%}
.bar-val{font-size:11px;color:#9ca3af;margin-bottom:6px;font-variant-numeric:tabular-nums}
.bar{width:100%;max-width:40px;background:linear-gradient(180deg,#3b82f6,#2563eb);border-radius:6px 6px 2px 2px}
.bar-day{font-size:11px;color:#6b7280;margin-top:9px;font-variant-numeric:tabular-nums}
.chips{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}.chip{width:auto;min-width:0;max-width:100%;font-size:12px;font-family:ui-monospace,Menlo,monospace;background:#1c1c1c;border:1px solid rgba(255,255,255,.06);color:#e5e7eb;padding:9px 10px;border-radius:8px;cursor:pointer;text-align:center;white-space:normal;overflow-wrap:anywhere;line-height:1.35}
.empty{color:#6b7280;font-size:13px;padding:12px 0}.tool-button{width:100%;text-align:left;cursor:pointer;color:inherit;font:inherit;border:0;background:transparent;appearance:none}.tool-button:focus-visible,.trend-btn:focus-visible,.modal-close:focus-visible{outline:2px solid #60a5fa;outline-offset:2px}@media(max-width:520px){body{padding:24px 14px 48px}.card{padding:16px}.tool-name{width:108px;font-size:11px}.tool-row{gap:7px}.tool-rate{width:54px;font-size:10px}.chart{gap:4px}.bar-day{font-size:9px}}.tool-button:hover{background:#202027}.tool-rate{width:62px;text-align:right;color:#6b7280;font-size:11px;flex-shrink:0}.trend-controls{display:flex;gap:7px;flex-wrap:wrap;margin:12px 0}.trend-btn{background:#202020;border:1px solid #333;color:#a1a1aa;border-radius:8px;padding:7px 12px;cursor:pointer}.trend-btn.active{background:#1d2d50;border-color:#3b82f6;color:#bfdbfe}.chart{gap:6px;overflow-x:auto}.bar-col{min-width:28px}.bar-day{white-space:nowrap}.modal-backdrop{position:fixed;inset:0;background:#000b;display:none;align-items:center;justify-content:center;padding:20px;z-index:10}.modal-backdrop.open{display:flex}.modal{width:min(560px,100%);max-height:80vh;overflow:auto;background:#171717;border:1px solid #383838;border-radius:16px;padding:22px}.modal-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}.modal-close{background:#292929;border:0;color:#ddd;border-radius:8px;padding:7px 10px;cursor:pointer}.param{padding:10px 0;border-top:1px solid #292929}.param code{margin-right:8px}.daily-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:10px}.daily-summary{font-size:11px;color:#737373}.daily-detail{margin-top:12px;border:1px solid #303030;border-radius:10px;background:#111;overflow:hidden}.daily-head{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-bottom:1px solid #292929;font-size:12px;color:#d4d4d8}.daily-head span{color:#737373;font-weight:400}.daily-table-wrap{max-height:380px;overflow:auto}.daily-table{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}.daily-table th,.daily-table td{padding:10px 12px;text-align:right;border-bottom:1px solid #242424;white-space:nowrap}.daily-table th:first-child,.daily-table td:first-child{text-align:left}.daily-table th{position:sticky;top:0;background:#1b1b1b;color:#9ca3af;font-weight:500}.daily-table td{color:#d4d4d8}.daily-table tr:last-child td{border-bottom:0}.daily-table .daily-fail{color:#f87171}.daily-table .daily-rate{color:#4ade80}.daily-empty{text-align:center!important;color:#737373!important;padding:22px!important}
ul{list-style:none;padding:0}li{margin:5px 0;font-size:13px;color:#9ca3af;line-height:1.6}
p{font-size:13px;color:#9ca3af;line-height:1.7}b{color:#e5e7eb;font-weight:600}
code{background:#1f1f1f;border-radius:5px;padding:2px 7px;color:#93c5fd;font-family:ui-monospace,Menlo,monospace;font-size:12px}
a{color:#3b82f6;text-decoration:none}
/* 主内容采用稳定的双栏布局：左侧设备与接入信息，右侧统计与工具能力。 */
@media (min-width:900px){
body{width:min(calc(100% - 64px),1560px);max-width:none;padding:28px 0 40px}
.tagline{margin:6px 0 18px}
.dashboard-layout{display:grid;grid-template-columns:minmax(280px,.78fr) minmax(0,1.7fr);align-items:start;gap:20px;min-width:0}
.dashboard-column{display:flex;flex-direction:column;gap:14px;min-width:0}
.dashboard-column>.card{margin:0}
.card{min-width:0;padding:18px 20px}
.hero-num{font-size:clamp(40px,3vw,54px)}.mini{gap:10px}.mini-item{padding:12px 14px}
.tool-name{width:170px}.tool-row{gap:12px;padding:7px 0}.tool-count{width:48px}.tool-rate{width:70px}
.chips{grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.chip{min-height:36px;padding:8px}
.chart{height:124px;gap:8px;padding:4px 4px 0}.bar{max-width:48px}.bar-day{font-size:11px}h3{margin:18px 0 8px}.trend-controls{margin:8px 0}
}
@media(max-width:899px){.dashboard-layout{display:flex;flex-direction:column;gap:14px}.dashboard-column{width:100%;display:flex;flex-direction:column;gap:14px}.dashboard-column>.card{margin:0}.chips{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(min-width:1400px){.dashboard-layout{grid-template-columns:minmax(320px,.72fr) minmax(0,1.85fr);gap:24px}.card{padding:20px 22px}.tool-name{width:190px}}
</style></head><body>
<div class="brand"><div class="logo">◈</div><h1>ChatToDesktop</h1></div>
<p class="tagline">ChatGPT 网页版本地指挥官 · Remote MCP</p>

<div class="dashboard-layout"><div class="dashboard-column layout-left">
<div class="card device-card">
  <div class="card-head"><h2>设备状态</h2>${agent ? '<span class="badge online">● 在线</span>' : '<span class="badge offline">● 离线</span>'}</div>
  ${agent ? `<p>设备 <b>${escapeHtml(agent.name)}</b> · ${escapeHtml(agent.platform ?? '?')}（${escapeHtml(agent.hostname ?? '?')}）</p>
<p>授权目录：</p><ul>${dirs}</ul>
<p>最后心跳 <b>${new Date(agent.lastSeen).toLocaleTimeString('zh-CN')}</b></p>`
    : '<p>本地 Agent 未连接。请在你的电脑上运行 <code>npm run agent</code> 或双击 <code>start.command</code>。</p>'}
</div>



<div class="card connect-card"><div class="card-head"><h2>接入 ChatGPT</h2></div><p>在 ChatGPT 网页版「添加自定义 MCP 服务器」中填入 <code>${escapeHtml(`${baseUrl}${mcpPath}`)}</code>，身份验证选择 <b>OAuth</b>，按页面提示完成授权即可。</p></div>
</div>
<div class="dashboard-column layout-right">
<div class="card usage-card">
  <div class="card-head"><h2>用量统计</h2><span style="color:#6b7280;font-size:12px">Tool calls</span></div>
  <div class="hero"><div class="hero-num">${us.total.count}</div><div class="hero-label">次工具调用</div></div>
  <div class="mini">
    <div class="mini-item ok"><span class="mini-num">${us.total.ok}</span><span class="mini-label">成功</span></div>
    <div class="mini-item fail"><span class="mini-num">${us.total.fail}</span><span class="mini-label">失败</span></div>
  </div>
  <h3>按工具分类</h3>${toolRows}
  <h3>调用趋势</h3><div class="trend-controls"><button class="trend-btn active" data-range="7">最近 7 天</button><button class="trend-btn" data-range="30">按月（近 12 个月）</button><button class="trend-btn" data-range="365">按年（近 5 年）</button></div><div id="trend-chart" class="chart"></div><p id="trend-caption" class="empty"></p><div class="daily-actions"><button id="daily-toggle" class="trend-btn">查看全部每日用量</button><span id="daily-summary" class="daily-summary"></span></div><div id="daily-detail" class="daily-detail" hidden><div class="daily-head"><b>每日调用明细</b><span id="daily-count"></span></div><div class="daily-table-wrap"><table class="daily-table"><thead><tr><th>日期</th><th>总调用</th><th>成功</th><th>失败</th><th>成功率</th></tr></thead><tbody id="daily-rows"></tbody></table></div></div>
</div>
<div class="card tools-card"><div class="card-head"><h2>工具能力</h2><span style="color:#6b7280;font-size:12px">${TOOL_DEFS.length} 个</span></div><p>点击任意工具，查看用途、参数和调用说明。</p><div class="chips">${chips}</div></div>
</div></div>
<div id="tool-modal" class="modal-backdrop"><div class="modal"><div class="modal-head"><h2 id="modal-title">工具说明</h2><button id="modal-close" class="modal-close">关闭</button></div><p id="modal-description"></p><h3>参数说明</h3><div id="modal-params"></div></div></div>
<script>const days=${JSON.stringify(us.days)};const catalog=${JSON.stringify(toolCatalog).replace(/</g,"\\u003c")};const chart=document.getElementById("trend-chart");function renderTrend(range){const now=new Date();const pts=[];if(range===7){for(let i=6;i>=0;i--){const d=new Date(now.getFullYear(),now.getMonth(),now.getDate()-i);const k=d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");pts.push({key:k,label:k.slice(5),total:0,ok:0,fail:0});}}else if(range===30){for(let i=11;i>=0;i--){const d=new Date(now.getFullYear(),now.getMonth()-i,1);const k=d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0");pts.push({key:k,label:k.slice(2),total:0,ok:0,fail:0});}}else{for(let i=4;i>=0;i--){const k=String(now.getFullYear()-i);pts.push({key:k,label:k,total:0,ok:0,fail:0});}}days.forEach(d=>{const k=range===7?d.date:range===30?d.date.slice(0,7):d.date.slice(0,4);const p=pts.find(x=>x.key===k);if(p){p.total+=d.total;p.ok+=d.ok;p.fail+=d.fail;}});const max=Math.max(1,...pts.map(p=>p.total));chart.replaceChildren();pts.forEach(p=>{const col=document.createElement("div");col.className="bar-col";col.title=p.key+": "+p.total+" 次（成功 "+p.ok+" / 失败 "+p.fail+"）";const value=document.createElement("span");value.className="bar-val";value.textContent=p.total||"";const bar=document.createElement("div");bar.className="bar";bar.style.height=(p.total?Math.max(4,Math.round(p.total/max*108)):2)+"px";bar.style.opacity=p.total?1:.2;const label=document.createElement("span");label.className="bar-day";label.textContent=p.label;col.append(value,bar,label);chart.append(col);});document.getElementById("trend-caption").textContent=range===7?"按天统计，包含无调用日期":range===30?"按月汇总最近 12 个月":"按年汇总最近 5 年";document.querySelectorAll(".trend-btn").forEach(b=>b.classList.toggle("active",Number(b.dataset.range)===range));}document.querySelectorAll(".trend-btn").forEach(b=>b.addEventListener("click",()=>renderTrend(Number(b.dataset.range))));renderTrend(7);
const dailyRows=document.getElementById("daily-rows");
const dailyDetail=document.getElementById("daily-detail");
const dailyToggle=document.getElementById("daily-toggle");
const dailySorted=[...days].sort((a,b)=>b.date.localeCompare(a.date));
const dailyTotal=dailySorted.reduce((s,d)=>s+d.total,0);
const dailyPeak=dailySorted.reduce((best,d)=>!best||d.total>best.total?d:best,null);
document.getElementById("daily-summary").textContent=dailySorted.length?("累计 "+dailySorted.length+" 个有调用日期 · 日均 "+Math.round(dailyTotal/dailySorted.length)+" 次"+(dailyPeak?" · 峰值 "+dailyPeak.date+"（"+dailyPeak.total+" 次）":"")):"暂无每日记录";
document.getElementById("daily-count").textContent="共 "+dailySorted.length+" 天 · "+dailyTotal+" 次调用";
dailyRows.replaceChildren();
if(!dailySorted.length){const tr=document.createElement("tr");const td=document.createElement("td");td.colSpan=5;td.className="daily-empty";td.textContent="暂无每日用量记录";tr.append(td);dailyRows.append(tr);}
else dailySorted.forEach(d=>{const tr=document.createElement("tr");const values=[d.date,d.total,d.ok,d.fail,(d.total?Math.round(d.ok/d.total*100):0)+"%"];values.forEach((v,i)=>{const td=document.createElement("td");td.textContent=v;if(i===3&&d.fail)td.className="daily-fail";if(i===4)td.className="daily-rate";tr.append(td);});dailyRows.append(tr);});
dailyToggle.addEventListener("click",()=>{const opening=dailyDetail.hidden;dailyDetail.hidden=!opening;dailyToggle.textContent=opening?"收起每日用量":"查看全部每日用量";});
const modal=document.getElementById("tool-modal");document.querySelectorAll(".tool-button").forEach(b=>b.addEventListener("click",()=>{const t=catalog.find(x=>x.name===b.dataset.tool);if(!t)return;document.getElementById("modal-title").textContent=t.name;document.getElementById("modal-description").textContent=t.description;const params=document.getElementById("modal-params");params.replaceChildren();if(t.parameters.length){t.parameters.forEach(p=>{const row=document.createElement("div");row.className="param";const code=document.createElement("code");code.textContent=p.name;row.append(code,document.createTextNode(p.description));params.append(row);});}else{const empty=document.createElement("p");empty.textContent="该工具无需参数。";params.append(empty);}modal.classList.add("open");}));document.getElementById("modal-close").onclick=()=>modal.classList.remove("open");modal.onclick=e=>{if(e.target===modal)modal.classList.remove("open")};document.addEventListener("keydown",e=>{if(e.key==="Escape")modal.classList.remove("open")});
</script>
</body></html>`;
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ── HTTP 服务 ─────────────────────────────────────────
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }
    if (pathname === '/healthz') {
      sendJson(res, 200, { ok: true, service: SERVICE_NAME, version: SERVICE_VERSION, agentOnline: Boolean(onlineAgent()), tools: TOOL_DEFS.length });
      return;
    }
    if (pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS });
      res.end(statusPage());
      return;
    }
    // OAuth 相关端点（PRM / AS 元数据 / DCR / 授权 / 令牌）
    if (await oauth.tryHandle(req, res, url)) return;

    if (pathname === mcpPath) {
      if (!authorized(req)) {
        sendJson(res, 401, { error: 'unauthorized：请先完成 OAuth 授权，或携带正确的 API Key' }, {
          'WWW-Authenticate': `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource", realm="mcp"`,
        });
        return;
      }
      try {
        let body;
        if (req.method === 'POST') {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const raw = Buffer.concat(chunks).toString('utf8');
          body = raw ? JSON.parse(raw) : undefined;
        }
        // 无状态模式：每个请求独立的 McpServer + transport，请求结束即整体回收
        const mcp = createMcpServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => {
          transport.close().catch(() => {});
          mcp.close().catch(() => {});
        });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (e) {
        logger.error(`MCP 请求处理异常：${e.message}`);
        if (!res.headersSent) sendJson(res, 400, { error: '请求处理失败', detail: e.message });
      }
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  });

  // ws upgrade
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== bridgePath) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const auth = req.headers.authorization ?? '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!safeEqual(bearer, bridgeToken) && !safeEqual(url.searchParams.get('token') ?? '', bridgeToken)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    // 监听地址：传 "0.0.0.0" 或 "::" 时省略 host，让 Node 默认 dual-stack（监听 ::，macOS 同时接受 IPv4），
    // 这样 localhost（优先 IPv6 ::1）和 127.0.0.1 都能连通。其他自定义地址则按用户指定绑定。
    const shouldBindAll = !host || host === '0.0.0.0' || host === '::';
    if (shouldBindAll) {
      server.listen(port, () => resolve());
    } else {
      server.listen(port, host, () => resolve());
    }
  });

  logger.info(`🚀 Relay 已启动：http://${host}:${port}${mcpPath}（MCP 端点）`);
  logger.info(`🔗 桥接通道：ws://${host}:${port}${bridgePath}（Agent 回连）`);
  logger.info(`🔍 状态页：http://${host}:${port}/`);
  logger.info(`🔐 OAuth 授权端点：${baseUrl}/oauth/authorize`);
  if (config.relay.publicUrl) {
    logger.info(`🌐 对外地址：${baseUrl}${mcpPath}（请在 ChatGPT 连接器中填入此地址，身份验证选 OAuth）`);
  } else {
    logger.warn('⚠ 尚未配置 relay.publicUrl，OAuth 元数据将回退为内网地址，接入 ChatGPT 前请先配好域名与 Cloudflare Tunnel（见 README）');
  }

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      logger.info(`Relay 停止（收到 ${sig}）`);
      for (const [ws] of agents) {
        try { ws.send(JSON.stringify({ type: 'shutdown' })); } catch { /* ignore */ }
      }
      wss.close();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    });
  }
}