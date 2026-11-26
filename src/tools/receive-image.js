/**
 * 接收 ChatGPT 传入的二进制文件内容并保存到本机授权目录。
 * 使用 Base64 传输，限定文件名、类型、大小；拒绝覆盖与路径穿越。
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_FILE_BYTES = 6 * 1024 * 1024;
const ALLOWED_TYPES = new Map([
  ['png', { mime: 'image/png', signature: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) }],
  ['jpg', { mime: 'image/jpeg', signature: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff }],
  ['jpeg', { mime: 'image/jpeg', signature: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff }],
  ['webp', { mime: 'image/webp', signature: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' }],
  ['gif', { mime: 'image/gif', signature: (b) => b.length >= 6 && ['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6)) }],
]);

export async function receive_image_file(args, ctx) {
  if (typeof args.data_base64 !== 'string' || !args.data_base64) {
    return { text: 'data_base64 不能为空。请传入文件原始字节的 Base64 编码。', isError: true };
  }
  const name = args.file_name;
  if (typeof name !== 'string' || name.length > 180 || name !== path.basename(name) ||
      name === '.' || name === '..' || /[\\/\\0-\\x1f]/.test(name) || name.startsWith('.')) {
    return { text: 'file_name 无效：只允许普通文件名，不允许路径、隐藏文件名或控制字符。', isError: true };
  }
  const ext = path.extname(name).slice(1).toLowerCase();
  const type = ALLOWED_TYPES.get(ext);
  if (!type) return { text: '当前只接受 PNG、JPG/JPEG、WEBP、GIF 图片文件。', isError: true };
  // 严格检查 Base64 语法，避免 Buffer.from 对非法输入静默容错。
  if (args.data_base64.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 + 8 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(args.data_base64)) {
    return { text: 'Base64 格式无效或文件超过 6 MiB 上限。', isError: true };
  }
  const bytes = Buffer.from(args.data_base64, 'base64');
  if (!bytes.length || bytes.length > MAX_FILE_BYTES) {
    return { text: '图片为空或超过 6 MiB 上限。', isError: true };
  }
  if (!type.signature(bytes)) return { text: `文件内容与 .${ext} 扩展名不匹配，已拒绝写入。`, isError: true };

  let dir;
  try {
    dir = ctx.guard.resolve(args.directory).path;
  } catch (e) {
    return { text: `目标目录未获授权：${e.message}`, isError: true };
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return { text: `目标目录不存在或不是目录：${dir}`, isError: true };
  }
  const target = path.join(dir, name);
  // 不覆盖任何现有路径；wx 避免检查与写入之间的覆盖竞态。
  try {
    const fd = fs.openSync(target, 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); } finally { fs.closeSync(fd); }
  } catch (e) {
    if (e.code === 'EEXIST') return { text: `目标文件已存在，为避免覆盖未写入：${target}`, isError: true };
    throw e;
  }
  return { text: `✓ 图片已接收到本机：${target}（${bytes.length} 字节，${type.mime}）`, isError: false };
}
