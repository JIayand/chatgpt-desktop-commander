#!/usr/bin/env bash
# ChatToDesktop 启动脚本：Relay 中枢 + 本地 Agent
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p .pids log

start_one() {
  local name="$1" entry="$2"
  local pidfile=".pids/${name}.pid"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "⚠ ${name} 已在运行 (PID $(cat "$pidfile"))"
  else
    nohup node "$entry" >> "log/${name}.out" 2>&1 &
    echo $! > "$pidfile"
    echo "✔ ${name} 已启动 (PID $!)"
  fi
}

start_one relay bin/relay.js
start_one agent bin/agent.js

sleep 1
bash scripts/status.sh || true