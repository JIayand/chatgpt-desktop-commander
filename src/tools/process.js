/**
 * 进程管理：列出进程、终止进程（基于 macOS/Linux 的 ps 命令）
 */
import { spawn } from 'node:child_process';

function ok(text) {
  return { text, isError: false };
}
function err(text) {
  return { text, isError: true };
}

function runPs(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ps', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let errOut = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { errOut += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(errOut || `ps 退出码 ${code}`))));
  });
}

export async function list_processes(_args, _ctx) {
  try {
    const out = await runPs(['-Ao', 'pid,ppid,etime,rss,comm']);
    const lines = out.trim().split('\n');
    const header = lines[0];
    const rows = lines.slice(1);
    // 按内存占用降序，取前 300 个
    const parsed = rows
      .map((line) => {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) return null;
        return { pid: Number(parts[0]), ppid: Number(parts[1]), etime: parts[2], rssMB: Math.round(Number(parts[3]) / 1024), comm: parts.slice(4).join(' ') };
      })
      .filter((r) => r && !Number.isNaN(r.pid));
    parsed.sort((a, b) => b.rssMB - a.rssMB);
    const top = parsed.slice(0, 300);
    const body = top.map((r) => `${String(r.pid).padEnd(7)} ${String(r.ppid).padEnd(7)} ${r.etime.padEnd(10)} ${String(r.rssMB).padStart(6)} MB  ${r.comm}`).join('\n');
    return ok(`=== 进程列表（按内存降序，前 ${top.length} / 共 ${parsed.length} 个） ===\n${header}\n${body}`);
  } catch (e) {
    return err(`读取进程失败：${e.message}`);
  }
}

export async function kill_process(args, ctx) {
  const pid = Number(args.pid);
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0x400000) {
    return err('pid 必须是正整数');
  }
  if (pid === process.pid) return err('拒绝自杀：不能终止 Agent 自身的进程');
  try {
    process.kill(pid, 'SIGTERM');
    return ok(`✓ 已向进程 ${pid} 发送 SIGTERM 终止信号`);
  } catch (e) {
    return err(`无法终止进程 ${pid}：${e.message}（可能不存在或权限不足）`);
  }
}