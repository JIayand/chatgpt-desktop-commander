#!/usr/bin/env bash
# ChatToDesktop 停止脚本：优雅停掉 Relay 与 Agent
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

stop_one() {
  local name="$1"
  local pidfile=".pids/${name}.pid"
  if [ -f "$pidfile" ]; then
    local pid
    pid="$(cat "$pidfile")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null
      echo "✔ 已停止 ${name} (PID ${pid})"
    else
      echo "ℹ ${name} 未在运行"
    fi
    rm -f "$pidfile"
  else
    echo "ℹ 未找到 ${name} 的运行记录"
  fi
}

stop_one agent
stop_one relay