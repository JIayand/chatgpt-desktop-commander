/**
 * 用量统计：按工具调用链路是否成功完成计数；工具正常返回的业务结果（包括文件不存在、内容未匹配等 isError）不算调用失败。
 */
import fs from 'node:fs';
import path from 'node:path';

function localDay(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export class UsageTracker {
  constructor(file = null) {
    this.file = file;
    this.total = { ok: 0, fail: 0 };
    this.tools = new Map();
    this.days = new Map();
    this.recent = [];
    if (this.file) this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [name, v] of Object.entries(data.tools ?? {})) {
        const ok = v.ok ?? 0, fail = v.fail ?? 0;
        this.tools.set(name, { ok, fail });
        this.total.ok += ok; this.total.fail += fail;
      }
      for (const [day, v] of Object.entries(data.days ?? {})) this.days.set(day, { ok: v.ok ?? 0, fail: v.fail ?? 0 });
      this.recent = Array.isArray(data.recent) ? data.recent.slice(-200).reverse() : [];
    } catch { /* 损坏文件不阻断服务 */ }
  }

  _save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({
        tools: Object.fromEntries(this.tools), days: Object.fromEntries(this.days),
        recent: this.recent.slice().reverse().slice(-200),
      }, null, 2) + '\n');
    } catch { /* 写盘失败不影响工具调用 */ }
  }

  record(tool, ok, error = '') {
    const name = typeof tool === 'string' && tool ? tool : 'unknown';
    const day = localDay();
    this.total[ok ? 'ok' : 'fail'] += 1;
    if (!this.tools.has(name)) this.tools.set(name, { ok: 0, fail: 0 });
    this.tools.get(name)[ok ? 'ok' : 'fail'] += 1;
    if (!this.days.has(day)) this.days.set(day, { ok: 0, fail: 0 });
    this.days.get(day)[ok ? 'ok' : 'fail'] += 1;
    this.recent.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, tool: name, ok: Boolean(ok), error: ok ? '' : String(error || '工具执行失败'), time: new Date().toISOString(), date: day });
    if (this.recent.length > 200) this.recent.splice(0, this.recent.length - 200);
    this._save();
  }

  stats() {
    const tools = [...this.tools.entries()]
      .map(([name, v]) => ({ name, ok: v.ok, fail: v.fail, total: v.ok + v.fail }))
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    const days = [...this.days.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({ date, ok: v.ok, fail: v.fail, total: v.ok + v.fail }));
    return { total: { ...this.total, count: this.total.ok + this.total.fail }, tools, days, recent: this.recent.slice(0, 200) };
  }
}
