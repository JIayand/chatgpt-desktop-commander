#!/usr/bin/env bash
# ChatToDesktop 状态检查：Relay 健康、Agent 在线状态、进程 PID
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="$(node --input-type=commonjs -e "const fs=require('fs');let c=JSON.parse(fs.readFileSync('config/config.json','utf8'));const l='config/config.local.json';if(fs.existsSync(l)){const x=JSON.parse(fs.readFileSync(l,'utf8'));c.relay={...c.relay,...(x.relay||{})};}process.stdout.write(String(c.relay.port||8723));" 2>/dev/null || echo 8723)"

echo "── ChatToDesktop 状态 ──"
for name in relay agent; do
  if [ -f ".pids/${name}.pid" ]; then
    pid="$(cat ".pids/${name}.pid")"
    if kill -0 "$pid" 2>/dev/null; then
      echo "✔ ${name} 运行中 (PID ${pid})"
    else
      echo "✘ ${name} 未运行（PID 文件残留 ${pid}）"
    fi
  else
    echo "✘ ${name} 未运行"
  fi
done

if curl -sf "http://127.0.0.1:${PORT}/healthz" > /tmp/cdc-health.json 2>/dev/null; then
  node --input-type=commonjs -e "const h=require('/tmp/cdc-health.json');console.log('✔ Relay 健康检查通过 → http://127.0.0.1:'+${PORT});console.log('  设备在线: '+(h.agentOnline?'是 ✅':'否 ❌（请启动 Agent）'));console.log('  工具数量: '+h.tools);"
  rm -f /tmp/cdc-health.json
else
  echo "✘ Relay 无响应（端口 ${PORT}），请查看 log/relay.out"
fi

# 提示接入状态
node --input-type=commonjs -e "const fs=require('fs');const l='config/config.local.json';const b=JSON.parse(fs.readFileSync('config/config.json','utf8'));let c=b;if(fs.existsSync(l)){const x=JSON.parse(fs.readFileSync(l,'utf8'));c={relay:{...b.relay,...(x.relay||{})}};}if(c.relay.publicUrl){console.log('🌐 对外地址: '+c.relay.publicUrl+c.relay.mcpPath);}else{console.log('⚠ 尚未配置公网地址（relay.publicUrl），接入 ChatGPT 网页版前请参考 README 完成域名与 Cloudflare Tunnel 配置');}" 2>/dev/null || true