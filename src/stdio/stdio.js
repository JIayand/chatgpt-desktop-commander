/**
 * stdio 直连模式：供 Claude Desktop / Codex / Cursor 等本地 MCP 客户端直接连接，
 * 不经 Relay 与公网，工具直接在本机授权目录内执行。
 * 客户端配置示例：{ "command": "node", "args": ["/绝对路径/chatgpt-desktop-commander/bin/stdio.js"] }
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import { PathGuard } from '../shared/pathguard.js';
import { TOOL_DEFS, createToolContext, callTool } from '../tools/index.js';

export async function startStdio() {
  const config = loadConfig('agent');
  const logger = createLogger('stdio');
  const guard = new PathGuard(config.agent.allowedDirs, { allowAll: config.agent.allowAllDirs });
  const ctx = createToolContext({ guard, config, logger });

  const mcp = new McpServer({ name: 'chatgpt-desktop-commander-local', version: '1.0.0' });
  for (const def of TOOL_DEFS) {
    mcp.registerTool(def.name, { description: def.description, inputSchema: def.schema }, async (args) => {
      const result = await callTool(ctx, def.name, args);
      return { content: [{ type: 'text', text: result.text }], isError: result.isError };
    });
  }

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  logger.info(`stdio 模式已启动：${TOOL_DEFS.length} 个工具本地直连可用`);
}