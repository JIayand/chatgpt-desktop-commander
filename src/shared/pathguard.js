/**
 * 路径安全守卫：所有文件类工具必须先经过 resolve() 校验，
 * 拒绝目录逃逸（../）、符号链接逃逸与白名单外路径。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export class PathGuard {
  /**
   * @param {string[]} allowedDirs 授权目录（绝对路径）
   * @param {{allowAll?: boolean}} [opts] allowAll=true 时授权整个文件系统（不做白名单限制）
   */
  constructor(allowedDirs, opts = {}) {
    this.allowAll = opts.allowAll === true;
    this.allowed = [];
    if (this.allowAll) return;
    for (const d of allowedDirs ?? []) {
      const abs = path.resolve(d);
      let real;
      try {
        real = fs.realpathSync(abs);
        if (!fs.statSync(real).isDirectory()) continue;
      } catch {
        continue; // 不存在的授权目录：跳过并在 list 中排除
      }
      this.allowed.push({ abs, real });
    }
    if (this.allowed.length === 0) {
      throw new Error('allowedDirs 为空或目录不存在，请检查配置');
    }
  }

  isAllowAll() {
    return this.allowAll;
  }

  getAllowedDirs() {
    if (this.allowAll) return [];
    return this.allowed.map((a) => a.real);
  }

  /**
   * 把任意目标路径解析为授权范围内的规范绝对路径。
   * 失败抛错，成功返回 { path: 绝对路径, real: 真实路径 }。
   */
  resolve(target, { base } = {}) {
    if (typeof target !== 'string' || target.trim() === '') {
      throw new Error('路径不能为空');
    }
    let p = path.resolve(base ?? process.cwd(), target);

    let exists = true;
    let real;
    try {
      real = fs.realpathSync(p);
    } catch {
      exists = false;
    }

    if (!exists) {
      // 向上找到最近存在的父目录，拼接剩余部分（用于新建文件/目录的场景）
      const tail = [];
      let cur = p;
      while (!fs.existsSync(cur)) {
        const parent = path.dirname(cur);
        if (parent === cur) throw new Error(`路径不存在: ${target}`);
        tail.unshift(path.basename(cur));
        cur = parent;
      }
      real = path.join(fs.realpathSync(cur), ...tail);
    }

    if (this.allowAll) {
      return { path: path.normalize(real), real: path.normalize(real) };
    }

    for (const a of this.allowed) {
      const rel = path.relative(a.real, real);
      if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
        return { path: path.normalize(real), real: path.normalize(real) };
      }
    }
    throw new Error(`拒绝访问：路径不在授权目录范围内 → ${p}\n授权目录：${this.allowed.map((a) => a.real).join(', ')}`);
  }

  /** 默认工作目录：授权所有目录时为当前用户主目录，否则为第一个授权目录 */
  defaultCwd() {
    if (this.allowAll) return os.homedir();
    return this.allowed[0].real;
  }
}