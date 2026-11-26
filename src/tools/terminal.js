/**
 * 终端执行：使用非 login bash 运行独立命令，带进程组超时终止与输出截断。
 * 注意：终端拥有该用户账号的完整权限，与白名单无关（Desktop Commander 同款行为）。
 * 由 agent.allowShell 开关整体控制。
 */
import { spawn } from 'node:child_process';

function capOutput(acc, chunk) {
  const { text, maxBytes, hit } = acc;
  const merged = text + chunk.toString('utf8');
  if (merged.length <= maxBytes) {
    return { text: merged, maxBytes, hit };
  }
  // 超限：保留头 70% + 尾 25%，中间留截断标记
  const head = maxBytes - Math.floor(maxBytes * 0.25);
  return {
    text: merged.slice(0, Math.floor(maxBytes * 0.7)) + `\n……[输出已截断，中间 ${merged.length - maxBytes} 字节被省略]……\n` + merged.slice(head),
    maxBytes,
    hit: true,
  };
}

/**
 * @returns {Promise<{exitCode:number, timedOut:boolean, stdout:string, stderr:string, truncated:boolean}>}
 */
export function executeCommand(command, opts = {}) {
  const { cwd, timeoutMs = 60000, maxOutputBytes = 204800, env = {} } = opts;
  return new Promise((resolve) => {
    let child;
    try {
      // 不使用 login shell（-l）：它会执行用户的 ~/.bash_profile，可能启动后台进程、挂住管道或污染输出，导致 pwd/echo 也超时。
      child = spawn('/bin/bash', ['-c', command], {
        cwd,
        env: { ...process.env, ...env, FORCE_COLOR: '0', TERM: 'dumb', CI: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32', // 独立进程组，超时时连同子进程一起清理
      });
    } catch (e) {
      resolve({ exitCode: -1, timedOut: false, stdout: '', stderr: `无法启动 bash: ${e.message}`, truncated: false });
      return;
    }

    let out = { text: '', maxBytes: maxOutputBytes, hit: false };
    let errOut = { text: '', maxBytes: maxOutputBytes, hit: false };
    let timedOut = false;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      // 结束整个进程组，避免子进程继承 stdout/stderr 管道后导致 close 永远不触发。
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch { /* process may already have exited */ }
      finish({
        exitCode: -1, timedOut: true, stdout: out.text,
        stderr: `${errOut.text}${errOut.text ? '\\n' : ''}命令超过 ${timeoutMs}ms，已终止进程组`,
        truncated: out.hit || errOut.hit,
      });
      setTimeout(() => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch { /* process group already exited */ }
      }, 1000).unref();
    }, timeoutMs);

    child.stdout.on('data', (d) => { out = capOutput(out, d); });
    child.stderr.on('data', (d) => { errOut = capOutput(errOut, d); });
    child.on('error', (e) => finish({ exitCode: -1, timedOut: false, stdout: out.text, stderr: `进程错误: ${e.message}`, truncated: out.hit || errOut.hit }));
    child.on('close', (code) => finish({
      exitCode: code ?? -1,
      timedOut,
      stdout: out.text,
      stderr: errOut.text,
      truncated: out.hit || errOut.hit,
    }));
  });
}