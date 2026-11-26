/**
 * 本地 Agent：WebSocket 出站回连 Relay 中枢（穿透 NAT/内网），
 * 接收任务 → 在授权目录白名单内执行工具 → 回传结果。
 */
import WebSocket from 'ws';
import os from 'node:os';
import { loadConfig } from '../shared/config.js';
import { createLogger, printBanner } from '../shared/logger.js';
import { PathGuard } from '../shared/pathguard.js';
import { createToolContext, callTool } from '../tools/index.js';
import { closeAllSshSessions } from '../tools/ssh.js';

export async function startAgent() {
  const config = loadConfig('agent');
  const logger = createLogger('agent');
  printBanner('agent');

  let guard;
  try {
    guard = new PathGuard(config.agent.allowedDirs, { allowAll: config.agent.allowAllDirs });
  } catch (e) {
    logger.error(e.message);
    process.exit(1);
  }
  const ctx = createToolContext({ guard, config, logger });
  if (guard.isAllowAll()) {
    logger.info('已授权所有目录（无白名单限制）');
  } else {
    logger.info(`已加载 ${guard.getAllowedDirs().length} 个授权目录：${guard.getAllowedDirs().join(' | ')}`);
  }
  logger.info(`shell 执行：${config.agent.allowShell ? '已启用（拥有当前用户完整权限，请留意）' : '已禁用'}`);

  let shuttingDown = false;
  let failCount = 0; // 连续断连次数：前 3 次快速重试（覆盖启动时 Relay 尚未就绪的场景）

  async function executeTask(task, ws) {
    const { taskId, name, arguments: args } = task;
    const t0 = Date.now();
    logger.info(`▶ 收到任务 ${taskId.slice(0, 8)} [${name}]`);
    const send = (payload) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    };
    let result;
    try {
      // 各次 execute_command 都是独立的 bash 进程，不共享当前目录或 shell 状态，无需全局互斥锁。
      // 全局锁会让一个未 settle 的调用阻塞所有后续终端任务；单条命令的生命周期由 terminal.js 超时控制。
      result = await callTool(ctx, name, args);
      logger.info(`✔ 任务完成 ${taskId.slice(0, 8)} 用时 ${Date.now() - t0}ms ${result.isError ? '失败' : '成功'}`);
      send({ type: 'task_result', taskId, result: { content: [{ type: 'text', text: result.text }], isError: result.isError } });
    } catch (e) {
      logger.error(`✗ 任务异常 ${taskId.slice(0, 8)} ${e.message}`);
      send({ type: 'task_error', taskId, error: e.message ?? String(e) });
    }
  }

  function connect() {
    if (shuttingDown) return;
    let ws;
    try {
      ws = new WebSocket(config.agent.relayUrl, {
        headers: { Authorization: `Bearer ${config.relay.bridgeToken}` },
      });
    } catch (e) {
      logger.error(`连接中枢失败：${e.message}，${config.agent.reconnectMs}ms 后重试`);
      setTimeout(connect, config.agent.reconnectMs);
      return;
    }
    let heartbeat = null;

    ws.on('open', () => {
      failCount = 0;
      logger.info(`🔗 已连接中枢 ${config.agent.relayUrl}（设备：${config.agent.deviceName}）`);
      ws.send(JSON.stringify({
        type: 'hello',
        token: config.relay.bridgeToken,
        device: {
          name: config.agent.deviceName,
          hostname: os.hostname(),
          platform: `${os.platform()} ${os.release()}`,
          node: process.version,
          allowedDirs: guard.getAllowedDirs(),
          allowAllDirs: guard.isAllowAll(),
          connectedAt: new Date().toISOString(),
        },
      }));
      heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'heartbeat', ts: Date.now() }));
      }, config.agent.heartbeatMs ?? 15000);
    });

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === 'task') {
        executeTask(msg, ws);
      } else if (msg.type === 'shutdown') {
        logger.info('收到中枢下线指令，Agent 退出');
        process.exit(0);
      }
    });

    ws.on('close', (code) => {
      if (heartbeat) clearInterval(heartbeat);
      if (shuttingDown) return;
      failCount += 1;
      const delay = failCount <= 3 ? 1000 : (config.agent.reconnectMs ?? 5000);
      logger.warn(`⚠ 与中枢连接断开 (code=${code})，${delay}ms 后自动重连…`);
      setTimeout(connect, delay);
    });

    ws.on('error', (e) => {
      logger.warn(`网络错误：${e.message}`);
    });
  }

  connect();

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      shuttingDown = true;
      logger.info(`Agent 停止（收到 ${sig}）`);
      closeAllSshSessions();
      process.exit(0);
    });
  }
}