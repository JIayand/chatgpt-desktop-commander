/**
 * 配置加载模块：config.json → config.local.json 覆盖 → 环境变量覆盖 → 密钥自动生成
 * 密钥写入 config.local.json（已被 .gitignore 排除），config.json 保持为模板。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '../..');
export const CONFIG_DIR = path.join(PROJECT_ROOT, 'config');
const BASE_CONFIG = path.join(CONFIG_DIR, 'config.json');
const LOCAL_CONFIG = path.join(CONFIG_DIR, 'config.local.json');

function deepMerge(base, extra) {
  const out = structuredClone(base ?? {});
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

const ENV_MAP = {
  CDC_PORT: ['relay', 'port', Number],
  CDC_HOST: ['relay', 'host', String],
  CDC_API_KEY: ['relay', 'apiKey', String],
  CDC_BRIDGE_TOKEN: ['relay', 'bridgeToken', String],
  CDC_PUBLIC_URL: ['relay', 'publicUrl', String],
  CDC_RELAY_URL: ['agent', 'relayUrl', String],
  CDC_DEVICE_NAME: ['agent', 'deviceName', String],
  CDC_ALLOWED_DIRS: ['agent', 'allowedDirs', (v) => v.split(',').map((s) => s.trim()).filter(Boolean)],
  CDC_ALLOW_SHELL: ['agent', 'allowShell', (v) => ['1', 'true', 'yes'].includes(String(v).toLowerCase())],
  CDC_ALLOW_SSH: ['agent', 'allowSsh', (v) => ['1', 'true', 'yes'].includes(String(v).toLowerCase())],
  CDC_ALLOW_ALL_DIRS: ['agent', 'allowAllDirs', (v) => ['1', 'true', 'yes'].includes(String(v).toLowerCase())],
};

function applyEnvOverrides(cfg) {
  for (const [envName, [section, key, cast]] of Object.entries(ENV_MAP)) {
    if (process.env[envName] !== undefined && process.env[envName] !== '') {
      cfg[section][key] = cast(process.env[envName]);
    }
  }
}

/** “changeme” 占位密钥 → 生成强随机密钥并写回 config.local.json */
function ensureSecrets(cfg) {
  const generated = {};
  for (const key of ['apiKey', 'bridgeToken']) {
    if (!cfg.relay[key] || String(cfg.relay[key]).includes('changeme')) {
      generated[key] = crypto.randomBytes(24).toString('hex');
      cfg.relay[key] = generated[key];
    }
  }
  if (Object.keys(generated).length === 0) return;

  let local = {};
  if (fs.existsSync(LOCAL_CONFIG)) {
    local = JSON.parse(fs.readFileSync(LOCAL_CONFIG, 'utf8'));
  }
  local.relay = { ...(local.relay ?? {}), ...generated };
  fs.writeFileSync(LOCAL_CONFIG, JSON.stringify(local, null, 2) + '\n', { mode: 0o600 });
}

/**
 * 加载并校验配置。
 * @param {string} role  'relay' | 'agent'
 */
export function loadConfig(role = 'relay') {
  if (!fs.existsSync(BASE_CONFIG)) {
    throw new Error(`缺少配置文件 ${BASE_CONFIG}，请先复制 config/config.example.json 为 config/config.json`);
  }
  let cfg = JSON.parse(fs.readFileSync(BASE_CONFIG, 'utf8'));
  if (fs.existsSync(LOCAL_CONFIG)) {
    cfg = deepMerge(cfg, JSON.parse(fs.readFileSync(LOCAL_CONFIG, 'utf8')));
  }
  applyEnvOverrides(cfg);
  ensureSecrets(cfg);

  if (!cfg.relay || !cfg.agent) {
    throw new Error('配置文件缺少 relay 或 agent 段落，请对照 config.example.json 检查');
  }
  if (role === 'agent' && !cfg.agent.allowAllDirs && (!Array.isArray(cfg.agent.allowedDirs) || cfg.agent.allowedDirs.length === 0)) {
    throw new Error('agent.allowedDirs 不能为空：必须显式指定授权目录；如确需授权所有目录，请设置 agent.allowAllDirs = true（风险自担）');
  }
  return cfg;
}