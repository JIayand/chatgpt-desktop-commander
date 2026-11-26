/**
 * 文件类工具：读取/写入/追加/编辑/目录/移动/删除/信息
 * 全部操作先经 PathGuard 白名单校验；覆盖与删除自动备份到 .backups/
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DEFAULT_WRITE_MAX = 1024 * 1024;
const DEFAULT_READ_MAX = 1024 * 1024;

function ok(text) {
  return { text, isError: false };
}
function err(text) {
  return { text, isError: true };
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function backupFile(srcPath) {
  const backupDir = path.join(path.dirname(srcPath), '.backups');
  if (fs.existsSync(backupDir) && !fs.statSync(backupDir).isDirectory()) {
    throw new Error(`备份目录被同名文件占用: ${backupDir}`);
  }
  fs.mkdirSync(backupDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const dest = path.join(backupDir, `${path.basename(srcPath)}.${ts}.bak`);
  fs.copyFileSync(srcPath, dest);
  return dest;
}

export async function read_file(args, ctx) {
  const { path: p } = ctx.guard.resolve(args.path);
  const maxBytes = ctx.config.agent?.readFileMaxBytes ?? DEFAULT_READ_MAX;
  try {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      return err(`这是一个目录，请改用 list_directory 查看：${p}`);
    }
    let content;
    if (path.extname(p).toLowerCase() === '.docx') {
      // DOCX 是 ZIP/XML 二进制容器，不能直接按 UTF-8 读取。只提取主文档正文，不执行文档内任何内容。
      if (st.size > 25 * 1024 * 1024) return err(`DOCX 文件过大（${fmtSize(st.size)}），超过 25 MiB 安全上限`);
      try {
        const xml = execFileSync('/usr/bin/unzip', ['-p', p, 'word/document.xml'], {
          encoding: 'utf8', timeout: 15000, maxBuffer: 32 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        content = xml
          .replace(/<w:tab\b[^>]*\/>/g, '\t')
          .replace(/<w:br\b[^>]*\/>/g, '\n')
          .replace(/<\/w:p>/g, '\n')
          .replace(/<\/w:tr>/g, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '\"').replace(/&apos;/g, "'")
          .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
          .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
      } catch (e) {
        return err(`DOCX 正文提取失败：${e.message}。请确认文件完整且包含 word/document.xml`);
      }
    } else {
      if (st.size > maxBytes) {
        return err(`文件过大（${fmtSize(st.size)}），已超过读取上限 ${fmtSize(maxBytes)}，请用 offset/limit 分段读取或先缩小文件`);
      }
      content = fs.readFileSync(p, 'utf8');
    }
    const lines = content.split('\n');
    const start = Math.max(0, (args.offset ?? 1) - 1);
    const limit = args.limit ?? lines.length - start;
    const selected = lines.slice(start, start + limit);
    const numbered = selected.map((line, i) => `${String(start + i + 1).padStart(String(start + selected.length).length, ' ')}│ ${line}`).join('\n');
    const info = st.size > 0 ? `（${st.size} 字节）` : '（空文件）';
    return ok(`=== ${p} ${info}：共 ${lines.length} 行，显示第 ${start + 1}-${start + selected.length} 行 ===\n${numbered || '(该区间无内容)'}`);
  } catch (e) {
    if (e.code === 'ENOENT') return err(`文件不存在：${p}`);
    throw e;
  }
}

export async function write_file(args, ctx) {
  const maxBytes = ctx.config.agent?.writeFileMaxBytes ?? DEFAULT_WRITE_MAX;
  if (!Buffer.isBuffer(args.content) && typeof args.content !== 'string') {
    return err('content 必须是字符串');
  }
  const bytes = Buffer.byteLength(args.content, 'utf8');
  if (bytes > maxBytes) {
    return err(`内容过大（${fmtSize(bytes)}），超过写入上限 ${fmtSize(maxBytes)}`);
  }
  const { path: p } = ctx.guard.resolve(args.path);
  let backupPath = null;
  if (fs.existsSync(p)) {
    if (fs.statSync(p).isDirectory()) return err(`目标是已存在的目录，无法写入：${p}`);
    if (ctx.config.agent?.backupOnWrite) backupPath = backupFile(p);
  } else {
    fs.mkdirSync(path.dirname(p), { recursive: true });
  }
  fs.writeFileSync(p, args.content, 'utf8');
  const note = backupPath ? `，原文件已备份至 ${backupPath}` : '';
  return ok(`✓ 已写入 ${p}（${fmtSize(bytes)}）${note}`);
}

export async function append_file(args, ctx) {
  const { path: p } = ctx.guard.resolve(args.path);
  let existed = false;
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
  } else {
    if (fs.statSync(p).isDirectory()) {
      return err(`目标是目录，无法追加：${p}`);
    }
    existed = true;
    if (ctx.config.agent?.backupOnWrite) backupFile(p);
  }
  fs.appendFileSync(p, args.content, 'utf8');
  const note = existed && ctx.config.agent?.backupOnWrite ? '（追加前已自动备份）' : '';
  return ok(`✓ 已追加 ${Buffer.byteLength(args.content, 'utf8')} 字节到 ${p}${note}`);
}

export async function edit_file(args, ctx) {
  const { path: p } = ctx.guard.resolve(args.path);
  const maxBytes = ctx.config.agent?.readFileMaxBytes ?? DEFAULT_READ_MAX * 2;
  try {
    if (fs.statSync(p).isDirectory()) return err(`目标是目录，无法编辑：${p}`);
    if (fs.statSync(p).size > maxBytes) return err(`文件过大（${fmtSize(fs.statSync(p).size)}），暂不支持编辑`);
  } catch (e) {
    if (e.code === 'ENOENT') return err(`文件不存在：${p}`);
    throw e;
  }
  const oldText = args.old_string ?? '';
  const content = fs.readFileSync(p, 'utf8');
  const occurrences = oldText === '' ? 0 : content.split(oldText).length - 1;
  if (oldText === '' || occurrences === 0) {
    return err(`未找到 old_string，文件内容未修改。请先用 read_file 确认当前内容后再编辑。`);
  }
  if (occurrences > 1 && !args.replace_all) {
    return err(`old_string 在文件中出现了 ${occurrences} 次，请扩充上下文使其唯一，或设置 replace_all: true 全部替换。`);
  }
  const newContent = args.replace_all ? content.split(oldText).join(args.new_string ?? '') : content.replace(oldText, args.new_string ?? '');
  const backupPath = ctx.config.agent?.backupOnWrite ? backupFile(p) : null;
  fs.writeFileSync(p, newContent, 'utf8');
  const n = args.replace_all ? occurrences : 1;
  const note = backupPath ? `，原文件已备份至 ${backupPath}` : '';
  return ok(`✓ 已在 ${p} 完成 ${n} 处替换${note}`);
}

export async function list_directory(args, ctx) {
  const base = args.path ? ctx.guard.resolve(args.path).path : ctx.guard.defaultCwd();
  let st;
  try {
    st = fs.statSync(base);
  } catch (e) {
    if (e.code === 'ENOENT') return err(`目录不存在：${base}`);
    throw e;
  }
  if (!st.isDirectory()) return err(`不是目录：${base}`);
  const maxEntries = Math.min(args.max_entries ?? 500, 2000);
  const dirents = fs.readdirSync(base, { withFileTypes: true });
  const rows = dirents.slice(0, maxEntries).map((d) => {
    let line;
    if (d.isDirectory()) {
      line = `[目录]  ${d.name}/`;
    } else if (d.isSymbolicLink()) {
      let linkTo = '';
      try {
        linkTo = ` -> ${fs.readlinkSync(path.join(base, d.name))}`;
      } catch { /* ignore */ }
      line = `[链接]  ${d.name}${linkTo}`;
    } else {
      let size = '?';
      try {
        size = fmtSize(fs.statSync(path.join(base, d.name)).size);
      } catch { /* ignore */ }
      line = `[文件]  ${size.padEnd(9)} ${d.name}`;
    }
    return line;
  });
  const more = dirents.length > maxEntries ? `\n（仅显示前 ${maxEntries} 项，共 ${dirents.length} 项，可用 max_entries 调整）` : '';
  return ok(`=== ${base}/（${dirents.length} 项） ===\n${rows.join('\n') || '(空目录)'}${more}`);
}

export async function create_directory(args, ctx) {
  const { path: p } = ctx.guard.resolve(args.path);
  if (fs.existsSync(p)) return err(`路径已存在：${p}`);
  fs.mkdirSync(p, { recursive: true });
  return ok(`✓ 已创建目录 ${p}`);
}

export async function move_file(args, ctx) {
  const src = ctx.guard.resolve(args.source).path;
  const dest = ctx.guard.resolve(args.destination).path;
  if (!fs.existsSync(src)) return err(`源路径不存在：${src}`);
  if (fs.existsSync(dest)) return err(`目标已存在，为避免覆盖已中止：${dest}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);
  return ok(`✓ 已移动 ${src} → ${dest}`);
}

export async function delete_files(args, ctx) {
  const results = [];
  for (const target of args.paths) {
    try {
      const p = ctx.guard.resolve(target).path;
      if (!fs.existsSync(p)) {
        results.push(`跳过（不存在）：${p}`);
        continue;
      }
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        if (fs.readdirSync(p).length > 0) {
          results.push(`跳过（目录非空，安全起见只删空目录）：${p}/`);
          continue;
        }
        fs.rmdirSync(p);
        results.push(`✓ 已删除空目录 ${p}/`);
      } else {
        const backupPath = ctx.config.agent?.backupOnWrite ? backupFile(p) : null;
        fs.unlinkSync(p);
        results.push(`✓ 已删除 ${p}${backupPath ? `（备份至 ${backupPath}）` : ''}`);
      }
    } catch (e) {
      results.push(`✗ ${target} 删除失败：${e.message}`);
    }
  }
  return ok(results.join('\n'));
}

export async function get_file_info(args, ctx) {
  const p = ctx.guard.resolve(args.path).path;
  try {
    const st = fs.statSync(p);
    const type = st.isDirectory() ? '目录' : st.isSymbolicLink() ? '符号链接' : st.isFile() ? '文件' : '其他';
    const lines = [
      `路径: ${p}`,
      `类型: ${type}`,
      `大小: ${fmtSize(st.size)}（${st.size} 字节）`,
      `修改时间: ${st.mtime.toISOString()}`,
      `创建时间: ${st.birthtime.toISOString()}`,
      `权限: ${(st.mode & 0o777).toString(8)}`,
      `inode: ${st.ino}`,
    ];
    return ok(lines.join('\n'));
  } catch (e) {
    if (e.code === 'ENOENT') return err(`路径不存在：${p}`);
    throw e;
  }
}