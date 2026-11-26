/**
 * 工具注册表：MCP 工具定义（zod 校验）与执行绑定。
 * Agent 本地执行与 Relay 远端注册共用同一份定义，保证两端工具集一致。
 */
import { z } from 'zod';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import * as fsTools from './filesystem.js';
import * as searchTools from './search.js';
import * as procTools from './process.js';
import { executeCommand } from './terminal.js';
import * as sshTools from './ssh.js';
import * as receiveImageTools from './receive-image.js';

export const TOOL_DEFS = [
  {
    name: 'receive_image_file',
    description: '将本轮生成或提供的图片二进制内容通过 Base64 直接写入本机授权目录。仅接受 PNG/JPG/WEBP/GIF，最大 6 MiB；校验文件签名，拒绝路径穿越和覆盖。调用时传 directory（本机已授权且存在的目录）、file_name（如 generated.png）、data_base64（完整文件字节的 Base64 编码）。',
    schema: {
      directory: z.string().min(1).max(4096).describe('本机已授权且已存在的目标目录绝对路径'),
      file_name: z.string().min(1).max(180).describe('目标图片文件名，例如 generated.png；不允许路径'),
      data_base64: z.string().min(1).max(8388616).describe('图片原始字节的标准 Base64 编码，最多 6 MiB 解码数据'),
    },
    execute: receiveImageTools.receive_image_file,
  },
  {
    name: 'read_file',
    description: '读取本地文本文件内容（带行号），支持 offset/limit 分段读取；支持从 DOCX（Word）提取正文文本，最大 25 MiB。其他文本文件受 readFileMaxBytes 限制。',
    schema: {
      path: z.string().describe('文件路径（位于授权目录内）'),
      offset: z.number().int().min(1).optional().describe('起始行号，从 1 开始，默认 1'),
      limit: z.number().int().min(1).optional().describe('读取行数，默认读到文件末尾'),
    },
    execute: fsTools.read_file,
  },
  {
    name: 'write_file',
    description: '写入文本文件（覆盖已有文件前自动备份到 .backups/）。目录不存在时自动创建。',
    schema: {
      path: z.string().describe('文件路径（位于授权目录内）'),
      content: z.string().describe('要写入的完整文本内容'),
    },
    execute: fsTools.write_file,
  },
  {
    name: 'append_file',
    description: '向文本文件末尾追加内容（追加前自动备份）。',
    schema: {
      path: z.string().describe('文件路径（位于授权目录内）'),
      content: z.string().describe('要追加的文本内容'),
    },
    execute: fsTools.append_file,
  },
  {
    name: 'edit_file',
    description: '精确编辑文件：将文件中唯一出现的 old_string 替换为 new_string。old_string 必须与文件内容完全一致且唯一，否则拒绝修改。',
    schema: {
      path: z.string().describe('文件路径（位于授权目录内）'),
      old_string: z.string().min(1).describe('要被替换的原文片段，必须在文件中唯一出现'),
      new_string: z.string().describe('替换后的新内容'),
      replace_all: z.boolean().optional().describe('为 true 时替换所有出现，默认 false（要求唯一匹配）'),
    },
    execute: fsTools.edit_file,
  },
  {
    name: 'list_directory',
    description: '列出目录内容（文件大小、目录、符号链接）。',
    schema: {
      path: z.string().optional().describe('目录路径，默认第一个授权目录'),
      max_entries: z.number().int().min(1).max(2000).optional().describe('最多显示条目数，默认 500'),
    },
    execute: fsTools.list_directory,
  },
  {
    name: 'create_directory',
    description: '创建目录（自动创建中间层级）。',
    schema: {
      path: z.string().describe('要创建的目录路径（位于授权目录内）'),
    },
    execute: fsTools.create_directory,
  },
  {
    name: 'move_file',
    description: '移动或重命名文件/目录。目标已存在时会拒绝操作，避免覆盖。',
    schema: {
      source: z.string().describe('源路径'),
      destination: z.string().describe('目标路径（位于授权目录内）'),
    },
    execute: fsTools.move_file,
  },
  {
    name: 'delete_files',
    description: '删除文件或空目录（删除前自动备份到 .backups/；非空目录拒绝删除）。',
    schema: {
      paths: z.array(z.string()).min(1).max(50).describe('要删除的路径列表'),
    },
    execute: fsTools.delete_files,
  },
  {
    name: 'get_file_info',
    description: '查看文件/目录的元信息（类型、大小、时间、权限）。',
    schema: {
      path: z.string().describe('路径（位于授权目录内）'),
    },
    execute: fsTools.get_file_info,
  },
  {
    name: 'search_files',
    description: '在目录中搜索文件名或文件内容。模式支持 * ? 通配符（仅文件名）；默认同时匹配内容子串。自动跳过 node_modules、.git 等目录。',
    schema: {
      path: z.string().optional().describe('搜索根目录，默认第一个授权目录'),
      pattern: z.string().min(1).describe('文件名关键字（支持 * ? 通配）或内容子串'),
      match_content: z.boolean().optional().describe('是否匹配文件内容，默认 true（含通配符时自动禁用）'),
      case_sensitive: z.boolean().optional().describe('是否区分大小写，默认 false'),
      max_results: z.number().int().min(1).max(500).optional().describe('结果上限，默认 100'),
    },
    execute: searchTools.search_files,
  },
  {
    name: 'execute_command',
    description: '在本机终端执行独立 shell 命令（非 login bash）。拥有当前用户账号的完整权限，请谨慎使用。默认工作目录为授权目录；workdir 仅允许授权目录内路径。各条命令不共享 shell 状态。',
    schema: {
      command: z.string().min(1).describe('要执行的 shell 命令（独立 bash -c）'),
      workdir: z.string().optional().describe('工作目录（仅允许授权目录内），默认第一个授权目录'),
      timeout_seconds: z.number().int().min(1).max(590).optional().describe('超时秒数，默认 60'),
    },
    execute: async (args, ctx) => {
      const cfg = ctx.config.agent;
      if (!cfg.allowShell) return { text: 'shell 执行已被配置禁用（agent.allowShell = false）', isError: true };
      let cwd = ctx.guard.defaultCwd();
      if (args.workdir) {
        try {
          cwd = ctx.guard.resolve(args.workdir).path;
        } catch (e) {
          return { text: `workdir 非法：${e.message}`, isError: true };
        }
      }
      if (cfg.shellCwdMustBeAllowed) {
        const resolved = ctx.guard.resolve(cwd);
        if (!resolved) return { text: 'shell 工作目录必须位于授权目录内', isError: true };
        cwd = resolved.path;
      }
      const { exitCode, timedOut, stdout, stderr, truncated } = await executeCommand(args.command, {
        cwd,
        timeoutMs: (args.timeout_seconds ?? Math.floor(cfg.commandTimeoutMs / 1000)) * 1000,
        maxOutputBytes: cfg.commandMaxOutputBytes,
      });
      const parts = [`=== $ ${args.command} ===`, `工作目录: ${cwd}`, `退出码: ${exitCode}${timedOut ? '（已超时强杀）' : ''}`];
      if (stdout) parts.push('--- stdout ---', stdout);
      if (stderr) parts.push('--- stderr ---', stderr);
      if (truncated) parts.push('（输出已截断）');
      if (timedOut && exitCode !== 0) parts.push(`已超时被终止：${args.timeout_seconds ?? Math.floor(cfg.commandTimeoutMs / 1000)}s`);
      return { text: parts.join('\n'), isError: exitCode !== 0 && !timedOut };
    },
  },
  {
    name: 'ssh_session_open',
    description: '建立经过 SHA256 主机指纹严格验证的交互式 SSH 终端。密码/私钥仅用于本次连接，不保存、不记录。需要 agent.allowSsh=true。请通过可信渠道核验 host_fingerprint，禁止跳过验证。',
    schema: {
      host: z.string().min(1).max(253).describe('SSH 主机名或 IP'),
      port: z.number().int().min(1).max(65535).optional().describe('SSH 端口，默认 22'),
      username: z.string().min(1).max(128).describe('SSH 登录用户名'),
      auth_method: z.enum(['password', 'private_key']).describe('认证方式'),
      password: z.string().min(1).max(4096).optional().describe('密码认证凭证；不会持久化或记录'),
      private_key: z.string().min(1).max(65536).optional().describe('完整私钥 PEM/OpenSSH 内容；不会持久化或记录'),
      passphrase: z.string().max(4096).optional().describe('私钥口令（如需要）；不会持久化或记录'),
      host_fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{20,}={0,2}$/).describe('可信渠道确认的服务器主机指纹，格式 SHA256:...，必须匹配'),
      cols: z.number().int().min(40).max(300).optional().describe('终端列数，默认 120'),
      rows: z.number().int().min(10).max(100).optional().describe('终端行数，默认 32'),
    },
    execute: async (args, ctx) => {
      if (!ctx.config.agent.allowSsh) return { text: 'SSH 会话功能已禁用；设置 agent.allowSsh=true 或 CDC_ALLOW_SSH=true 后重启 Agent。', isError: true };
      return sshTools.ssh_session_open(args);
    },
  },
  {
    name: 'ssh_session_write',
    description: '向指定交互式 SSH 会话发送终端输入；支持命令、交互提示和控制字符（例如换行符）。',
    schema: {
      session_id: z.string().uuid().describe('ssh_session_open 返回的会话 ID'),
      data: z.string().max(16384).describe('发送到远端终端的文本/控制字符，例如命令后附加换行符'),
    },
    execute: async (args, ctx) => {
      if (!ctx.config.agent.allowSsh) return { text: 'SSH 会话功能已禁用。', isError: true };
      return sshTools.ssh_session_write(args);
    },
  },
  {
    name: 'ssh_session_read',
    description: '读取 SSH 交互终端新输出；wait_ms 可在无输出时等待，最大 20 秒。读取后输出缓冲区会被清空。',
    schema: {
      session_id: z.string().uuid().describe('SSH 会话 ID'),
      wait_ms: z.number().int().min(0).max(20000).optional().describe('等待新输出的毫秒数，默认不等待'),
    },
    execute: async (args, ctx) => {
      if (!ctx.config.agent.allowSsh) return { text: 'SSH 会话功能已禁用。', isError: true };
      return sshTools.ssh_session_read(args);
    },
  },
  {
    name: 'ssh_session_resize',
    description: '调整 SSH 交互式终端尺寸（列/行），适配全屏终端程序。',
    schema: {
      session_id: z.string().uuid().describe('SSH 会话 ID'),
      cols: z.number().int().min(40).max(300).describe('终端列数'),
      rows: z.number().int().min(10).max(100).describe('终端行数'),
    },
    execute: async (args, ctx) => {
      if (!ctx.config.agent.allowSsh) return { text: 'SSH 会话功能已禁用。', isError: true };
      return sshTools.ssh_session_resize(args);
    },
  },
  {
    name: 'ssh_session_close',
    description: '关闭 SSH 会话并释放远端终端、连接和本地资源。',
    schema: {
      session_id: z.string().uuid().describe('SSH 会话 ID'),
    },
    execute: async (args, ctx) => {
      if (!ctx.config.agent.allowSsh) return { text: 'SSH 会话功能已禁用。', isError: true };
      return sshTools.ssh_session_close(args);
    },
  },
  {
    name: 'list_processes',
    description: '列出本机进程（按内存占用降序，最多 300 条）。',
    schema: {},
    execute: procTools.list_processes,
  },
  {
    name: 'kill_process',
    description: '向指定 PID 发送 SIGTERM 终止信号。',
    schema: {
      pid: z.number().int().positive().describe('要终止的进程 PID'),
    },
    execute: procTools.kill_process,
  },
];

export const TOOLS_BY_NAME = new Map(TOOL_DEFS.map((t) => [t.name, t]));

/** 创建工具执行上下文 */
export function createToolContext({ guard, config, logger }) {
  return { guard, config, logger };
}

/**
 * 工具统一入口：zod 校验 → 执行 → 返回 { text, isError }。
 * 参数不合法抛 McpError（协议级错误）；执行期错误包装为 isError 文本。
 */
export async function callTool(ctx, name, args) {
  const def = TOOLS_BY_NAME.get(name);
  if (!def) {
    throw new McpError(ErrorCode.MethodNotFound, `未知工具: ${name}`);
  }
  const parsed = z.object(def.schema).safeParse(args ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`).join('; ');
    throw new McpError(ErrorCode.InvalidParams, `工具 ${name} 参数不合法 → ${detail}`);
  }
  try {
    const result = await def.execute(parsed.data, ctx);
    ctx.logger?.info(`工具执行完成 [${name}] ${result.isError ? '失败' : '成功'}`);
    return result;
  } catch (e) {
    ctx.logger?.warn(`工具执行异常 [${name}] ${e.message}`);
    return { text: `工具执行失败: ${e.message}`, isError: true };
  }
}