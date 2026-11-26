/**
 * 文件搜索：文件名匹配（支持 * ? 通配）+ 文本内容子串搜索。
 * 默认跳过 node_modules/.git/.backups 等目录，防止扫描爆炸。
 */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_SKIP_DIRS = new Set([
  'node_modules', '.git', '.backups', '.pids', '.venv', 'venv',
  '__pycache__', '.history', '.idea', '.vscode', 'log',
]);
const CONTENT_MATCH_MAX_BYTES = 1024 * 1024;
const MAX_DEPTH = 20;

function ok(text) {
  return { text, isError: false };
}
function err(text) {
  return { text, isError: true };
}

function globToRegExp(glob, caseSensitive) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, caseSensitive ? '' : 'i');
}

export async function search_files(args, ctx) {
  const base = args.path ? ctx.guard.resolve(args.path).path : ctx.guard.defaultCwd();
  try {
    if (!fs.statSync(base).isDirectory()) return err(`不是目录：${base}`);
  } catch (e) {
    if (e.code === 'ENOENT') return err(`目录不存在：${base}`);
    throw e;
  }
  const pattern = (args.pattern ?? '').trim();
  if (pattern === '') return err('请输入搜索关键词 pattern');

  const hasWildcard = /[*?]/.test(pattern);
  const nameRe = hasWildcard ? globToRegExp(pattern, args.case_sensitive) : null;
  const needle = args.case_sensitive ? pattern : pattern.toLowerCase();
  const matchContent = hasWildcard ? false : (args.match_content ?? true);
  const maxResults = Math.min(args.max_results ?? ctx.config.agent?.searchMaxResults ?? 100, 500);
  const skipDirs = new Set([...DEFAULT_SKIP_DIRS, ...(ctx.config.search?.skipDirs ?? [])]);

  const results = [];

  function walk(dir, depth) {
    if (results.length >= maxResults || depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 无权限目录直接跳过
    }
    for (const ent of entries) {
      if (results.length >= maxResults) return;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (skipDirs.has(ent.name)) continue;
        walk(full, depth + 1);
        continue;
      }
      if (ent.isSymbolicLink()) continue;
      // 文件名匹配
      if (nameRe ? nameRe.test(ent.name) : ent.name.toLowerCase().includes(needle)) {
        results.push({ path: full, reason: '文件名匹配' });
        continue;
      }
      // 内容匹配
      if (matchContent) {
        try {
          const st = fs.statSync(full);
          if (st.size > 0 && st.size <= CONTENT_MATCH_MAX_BYTES) {
            const buf = fs.readFileSync(full);
            if (buf.subarray(0, Math.min(8192, buf.length)).includes(0)) continue; // 疑似二进制
            const text = buf.toString('utf8');
            const idx = args.case_sensitive ? text.indexOf(pattern) : text.toLowerCase().indexOf(needle);
            if (idx >= 0) {
              const before = text.slice(Math.max(0, idx - 40), idx).replace(/\n/g, ' ');
              const after = text.slice(idx, idx + 80).replace(/\n/g, ' ');
              results.push({ path: full, reason: `内容匹配: …${before}${after}…` });
            }
          }
        } catch {
          /* 单文件读取失败不影响整体 */
        }
      }
    }
  }

  walk(base, 0);

  if (results.length === 0) return ok(`在 ${base} 下未找到与 "${pattern}" 匹配的内容。`);
  const lines = results.map((r, i) => `${i + 1}. ${r.path}\n   ${r.reason}`);
  const more = results.length >= maxResults ? `\n（结果已达上限 ${maxResults} 条，可能不完整，可缩小搜索范围）` : '';
  return ok(`=== 在 ${base} 下找到 ${results.length} 条匹配 ===\n${lines.join('\n')}${more}`);
}