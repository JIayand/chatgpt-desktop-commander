#!/usr/bin/env node
/** 启动 Relay 中枢：MCP streamable HTTP 端点 + Agent 桥接 */
import { startRelay } from '../src/relay/relay.js';

startRelay().catch((e) => {
  console.error(`[relay] 启动失败：${e.message}`);
  process.exit(1);
});