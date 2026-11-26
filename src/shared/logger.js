/**
 * 日志模块：控制台（AI 风格彩色）+ 每日滚动文件 log/YYYYMMDD.log
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './config.js';

const LOG_DIR = path.join(PROJECT_ROOT, 'log');
const COLORS = {
  debug: '\x1b[90m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  reset: '\x1b[0m',
};

function pad(n) {
  return String(n).padStart(2, '0');
}

function todayFile() {
  const d = new Date();
  return path.join(LOG_DIR, `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.log`);
}

function stringify(v) {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return `${v.message}\n${v.stack ?? ''}`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function createLogger(moduleName) {
  function write(level, args) {
    const d = new Date();
    const ts = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
    const msg = args.map(stringify).join(' ');
    const plain = `[${ts}] [${level.toUpperCase()}] [${moduleName}] ${msg}`;
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      fs.appendFile(todayFile(), plain + '\n', () => {});
    } catch {
      /* 日志写入失败不阻断主流程 */
    }
    const consoleFn = level === 'error' ? 'error' : level === 'warn' ? 'warn' : level === 'debug' ? 'debug' : 'log';
    console[consoleFn](`${COLORS[level] ?? ''}[${ts}] [${level.toUpperCase()}] [${moduleName}] ${msg}${COLORS.reset}`);
  }
  return {
    debug: (...a) => write('debug', a),
    info: (...a) => write('info', a),
    warn: (...a) => write('warn', a),
    error: (...a) => write('error', a),
  };
}

const BANNERS = {
  relay: `
┌──────────────────────────────────────────────────────────────┐
│   ChatToDesktop · Relay 中枢                                 │
│   MCP streamable HTTP 端点 + Agent 桥接通道                  │
│   让网页版 ChatGPT 指挥你的本地电脑 · 免费自建               │
└──────────────────────────────────────────────────────────────┘`,
  agent: `
┌──────────────────────────────────────────────────────────────┐
│   ChatToDesktop · 本地 Agent                                 │
│   出站回连长连 · 穿透内网 · 等待中枢指令                      │
│   授权目录内执行文件 / 终端 / 搜索操作                       │
└──────────────────────────────────────────────────────────────┘`,
};

export function printBanner(role) {
  console.log(`\x1b[36m${BANNERS[role] ?? ''}\x1b[0m`);
}