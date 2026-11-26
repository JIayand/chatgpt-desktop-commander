#!/usr/bin/env node
/** 启动本地 Agent：出站回连 Relay 中枢 */
import { startAgent } from '../src/agent/agent.js';

startAgent().catch((e) => {
  console.error(`[agent] 启动失败：${e.message}`);
  process.exit(1);
});