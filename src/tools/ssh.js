/**
 * 安全交互式 SSH 会话管理器。
 * 凭证只在连接握手时使用，不持久化、不记录；每个会话独立，强制验证主机指纹。
 */
import crypto from 'node:crypto';
import { Client } from 'ssh2';

const MAX_SESSIONS = 8;
const MAX_BUFFER_BYTES = 128 * 1024;
const SESSION_IDLE_MS = 30 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 15_000;
const MAX_WAIT_MS = 20_000;
const sessions = new Map();
let openingSessions = 0;

function fingerprint(key) {
  const digest = crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
  return `SHA256:${digest}`;
}

function safeMessage() {
  // SSH 库的错误文本可能带有服务器/认证细节；对外只返回不含凭证的固定错误。
  return 'SSH 连接失败：请检查主机、端口、认证信息和主机指纹；凭证不会写入日志。';
}

function touch(session) {
  session.lastActivity = Date.now();
}

function appendOutput(session, chunk) {
  const text = chunk.toString('utf8');
  session.output += text;
  if (Buffer.byteLength(session.output, 'utf8') > MAX_BUFFER_BYTES) {
    session.output = Buffer.from(session.output, 'utf8').subarray(-MAX_BUFFER_BYTES).toString('utf8');
    session.truncated = true;
  }
  for (const waiter of session.waiters) waiter();
}

function cleanupSession(id, reason = '会话已关闭') {
  const session = sessions.get(id);
  if (!session) return false;
  sessions.delete(id);
  clearTimeout(session.idleTimer);
  for (const waiter of session.waiters) waiter();
  session.waiters.clear();
  try { session.channel?.end(); } catch {}
  try { session.client.end(); } catch {}
  session.closed = true;
  session.closeReason = reason;
  return true;
}

function scheduleIdleCleanup(id, session) {
  clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => cleanupSession(id, '会话因 30 分钟无操作而关闭'), SESSION_IDLE_MS);
  session.idleTimer.unref?.();
}

export function sshFingerprintFromKey(key) {
  return fingerprint(key);
}

export async function ssh_session_open(args) {
  if (sessions.size + openingSessions >= MAX_SESSIONS) return { text: `SSH 会话数量已达上限（${MAX_SESSIONS}），请先关闭不用的会话。`, isError: true };
  const host = String(args.host).trim();
  if (!host || host.length > 253 || /[\s\u0000-\u001f]/.test(host)) return { text: 'host 格式无效。', isError: true };
  if (!/^SHA256:[A-Za-z0-9+/]{20,}={0,2}$/.test(args.host_fingerprint)) {
    return { text: '必须提供可信来源的 SSH 主机指纹（SHA256:...）；为防止中间人攻击，不支持跳过主机验证。', isError: true };
  }
  if (args.auth_method === 'password' && !args.password) return { text: 'password 认证需要提供 password。', isError: true };
  if (args.auth_method === 'private_key' && !args.private_key) return { text: 'private_key 认证需要提供 private_key 内容。', isError: true };
  if (args.auth_method === 'password' && args.private_key) return { text: 'password 认证不能同时提供 private_key。', isError: true };
  if (args.auth_method === 'private_key' && args.password) return { text: 'private_key 认证不能同时提供 password。', isError: true };

  const client = new Client();
  const id = crypto.randomUUID();
  const session = {
    id, client, channel: null, output: '', truncated: false, waiters: new Set(),
    lastActivity: Date.now(), closed: false, closeReason: '', idleTimer: null,
  };

  const connectOptions = {
    host,
    port: args.port ?? 22,
    username: args.username,
    readyTimeout: CONNECT_TIMEOUT_MS,
    keepaliveInterval: 10_000,
    keepaliveCountMax: 3,
    hostVerifier: (key) => fingerprint(key) === args.host_fingerprint,
  };
  if (args.auth_method === 'password') connectOptions.password = args.password;
  if (args.auth_method === 'private_key') {
    connectOptions.privateKey = args.private_key;
    if (args.passphrase) connectOptions.passphrase = args.passphrase;
  }

  openingSessions += 1;
  return await new Promise((resolve) => {
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      openingSessions -= 1;
      clearTimeout(timer);
      client.destroy();
      resolve({ text: safeMessage(), isError: true });
    };
    const timer = setTimeout(fail, CONNECT_TIMEOUT_MS + 1000);
    timer.unref?.();

    client.on('error', fail);
    client.on('ready', () => {
      client.shell({ term: 'xterm-256color', cols: args.cols ?? 120, rows: args.rows ?? 32 }, (err, channel) => {
        if (err || !channel) return fail();
        if (settled) { channel.close(); return; }
        settled = true;
        openingSessions -= 1;
        clearTimeout(timer);
        session.channel = channel;
        sessions.set(id, session);
        scheduleIdleCleanup(id, session);
        channel.on('data', (chunk) => { appendOutput(session, chunk); touch(session); scheduleIdleCleanup(id, session); });
        channel.stderr?.on('data', (chunk) => { appendOutput(session, chunk); touch(session); scheduleIdleCleanup(id, session); });
        channel.on('close', () => cleanupSession(id, '远端终端已关闭'));
        resolve({ text: `SSH 已连接并建立交互式终端。会话 ID：${id}\n主机：${host}:${args.port ?? 22}\n用户：${args.username}\n主机指纹验证：通过\n使用 ssh_session_write 发送输入，ssh_session_read 读取输出，ssh_session_resize 调整窗口，ssh_session_close 关闭会话。`, isError: false });
      });
    });
    try { client.connect(connectOptions); } catch { fail(); }
  });
}

function getSession(id) {
  const session = sessions.get(id);
  if (!session || session.closed || !session.channel) return null;
  touch(session);
  scheduleIdleCleanup(id, session);
  return session;
}

export async function ssh_session_write(args) {
  const session = getSession(args.session_id);
  if (!session) return { text: 'SSH 会话不存在或已关闭，请重新连接。', isError: true };
  if (Buffer.byteLength(args.data, 'utf8') > 16 * 1024) return { text: '单次输入不能超过 16 KiB。', isError: true };
  try {
    session.channel.write(args.data);
    return { text: `已向 SSH 会话发送 ${Buffer.byteLength(args.data, 'utf8')} 字节输入。`, isError: false };
  } catch {
    cleanupSession(args.session_id, '输入失败，会话已关闭');
    return { text: 'SSH 输入失败，会话已关闭。', isError: true };
  }
}

export async function ssh_session_read(args) {
  const session = getSession(args.session_id);
  if (!session) return { text: 'SSH 会话不存在或已关闭，请重新连接。', isError: true };
  const waitMs = Math.min(args.wait_ms ?? 0, MAX_WAIT_MS);
  if (!session.output && waitMs > 0) {
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        session.waiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, waitMs);
      session.waiters.add(finish);
      if (session.output || session.closed) finish();
    });
  }
  const output = session.output;
  session.output = '';
  const truncated = session.truncated;
  session.truncated = false;
  return { text: output ? `${truncated ? '（输出较多，较早内容已截断）\n' : ''}${output}` : (session.closed ? session.closeReason : '暂无新输出。'), isError: false };
}

export async function ssh_session_resize(args) {
  const session = getSession(args.session_id);
  if (!session) return { text: 'SSH 会话不存在或已关闭，请重新连接。', isError: true };
  const cols = args.cols;
  const rows = args.rows;
  try {
    session.channel.setWindow(rows, cols, 0, 0);
    return { text: `终端尺寸已调整为 ${cols} 列 × ${rows} 行。`, isError: false };
  } catch {
    return { text: '调整 SSH 终端尺寸失败。', isError: true };
  }
}

export async function ssh_session_close(args) {
  const closed = cleanupSession(args.session_id, '会话已由用户关闭');
  return { text: closed ? 'SSH 会话已关闭，连接和终端资源已释放。' : '会话不存在或已关闭。', isError: !closed };
}

export function closeAllSshSessions() {
  for (const id of [...sessions.keys()]) cleanupSession(id, 'Agent 正在关闭');
}

export function activeSshSessionCount() {
  return sessions.size;
}
