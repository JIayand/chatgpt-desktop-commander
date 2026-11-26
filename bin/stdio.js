#!/usr/bin/env node
/** stdio 直连模式：本地 MCP 客户端（Claude Desktop / Codex / Cursor）直接使用 */
import { startStdio } from '../src/stdio/stdio.js';

startStdio().catch((e) => {
  console.error(`[stdio] 启动失败：${e.message}`);
  process.exit(1);
});