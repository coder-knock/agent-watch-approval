// approval 记录存储：待决项持久化 + 审计日志追加 + 等待者唤醒。
// 重启后会恢复未决记录，并把「宕机期间已经超时」的那些判为过期（按默认选项结算）。

import fs from 'node:fs';
import path from 'node:path';

export class Store {
  /**
   * @param {string} dataDir
   * @param {{sessionAllowTtlSeconds?: number}} [opts]
   *   sessionAllowTtlSeconds：「本会话内允许」白名单的有效期（秒），默认 1800。
   *   这个白名单**只活在内存里** —— 网关一重启就清空，属于故意的 fail-closed 偏置。
   */
  constructor(dataDir, opts = {}) {
    this.dataDir = dataDir;
    this.sessionAllowTtlMs = Math.max(1, Number(opts.sessionAllowTtlSeconds ?? 1800)) * 1000;
    fs.mkdirSync(dataDir, { recursive: true });
    this.pendingFile = path.join(dataDir, 'pending.json');
    this.auditFile = path.join(dataDir, 'audit.jsonl');
    this.nonceFile = path.join(dataDir, 'used-nonces.json');
    this.records = new Map();
    this.waiters = new Map();
    this.usedNonces = new Set();
    this._persistFailures = 0;
    // key = sessionId \0 tool \0 tier → { sessionId, tool, tier, grantedAt, grantedFromId }
    this.sessionAllows = new Map();
    this._load();
    this.sweeper = setInterval(() => this.sweep(), 2000);
    this.sweeper.unref?.();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.pendingFile, 'utf8'));
      for (const r of raw.records || []) this.records.set(r.id, r);
    } catch {
      /* 首次启动，无历史 */
    }
    try {
      const n = JSON.parse(fs.readFileSync(this.nonceFile, 'utf8'));
      for (const x of n.nonces || []) this.usedNonces.add(x);
    } catch {
      /* ignore */
    }
  }

  _persist() {
    const records = [...this.records.values()].filter((r) => r.status === 'pending');
    const tmp = this.pendingFile + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify({ savedAt: Date.now(), records }, null, 2));
      try {
        fs.renameSync(tmp, this.pendingFile);
      } catch (e) {
        // ⚠️ 这里踩过一次**把网关弄死**的坑，必须留着这个兜底。
        //
        // `renameSync` 会以 EPERM 失败（实测：沙箱/macOS 权限策略下
        // `pending.json.tmp → pending.json` 被拒）。而 `_persist()` 会被
        // **2 秒一次的 sweep 定时器**调到 —— 于是这个异常变成一个未捕获异常，
        // 直接把整个 Node 进程带走：
        //
        //   Error: EPERM: operation not permitted, rename '.../pending.json.tmp'
        //     at Store._persist (src/core/store.mjs:50)
        //     at Store.settle  (…:253)
        //     at Store.sweep   (…:280)
        //     at Timeout._onTimeout (node:timers:685)
        //
        // 后果远比「少存一条记录」严重：网关一死，hook 全部走「网关不可达」分支 ——
        // L2 一直问、L3 直接拒，用户看到的是「我的命令突然全被拒了」，
        // 而根因是一条根本没人在看的持久化错误。
        //
        // 所以：**持久化不许抛**。原子改名不行就退化成直接覆盖写；
        // 两种都失败就大声抱怨一句、把 tmp 留着取证，但**绝不中断进程**。
        this._persistFailures++;
        console.error(
          `[store] ⚠️ 原子改名失败（${e.code || e.message}），退化为直接覆盖写：${this.pendingFile}`
        );
        try {
          fs.copyFileSync(tmp, this.pendingFile);
        } catch (e2) {
          console.error(
            `[store] ❌ 待决记录落盘失败（已连续 ${this._persistFailures} 次）：${e2.message}\n` +
            `        数据仍在内存里、审批不受影响；但网关重启后这批未决记录会丢。` +
            `        临时文件留着取证：${tmp}`
          );
        }
      }
    } catch (e) {
      this._persistFailures++;
      console.error(`[store] ❌ 写临时文件失败：${e.message}（待决记录仍在内存里，审批不受影响）`);
    }
  }

  _persistNonces() {
    const arr = [...this.usedNonces].slice(-5000);
    try {
      fs.writeFileSync(this.nonceFile, JSON.stringify({ nonces: arr }));
    } catch (e) {
      // 同样不许抛：重放保护靠的是内存里这个 Set，落盘只是为了跨重启续上。
      // 落盘失败 = 重启后可能接受少量旧 nonce，比把网关弄死轻得多。
      console.error(`[store] ⚠️ nonce 落盘失败：${e.message}（内存里的重放保护不受影响）`);
    }
  }

  audit(entry) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    try {
      fs.appendFileSync(this.auditFile, line + '\n');
    } catch (e) {
      // 审计写不进去是一件**该被看见**的事，但它同样不该把网关带走。
      // 与 _persist 同一条理由：这个函数会被 sweep 定时器间接触发。
      console.error(`[store] ❌ 审计落盘失败：${e.message}｜丢掉的这条：${line.slice(0, 200)}`);
    }
  }

  readAudit(limit = 50) {
    try {
      const lines = fs.readFileSync(this.auditFile, 'utf8').trim().split('\n').filter(Boolean);
      return lines.slice(-limit).map((l) => JSON.parse(l)).reverse();
    } catch {
      return [];
    }
  }

  create(record) {
    this.records.set(record.id, record);
    this._persist();
    this.audit({
      event: 'created',
      id: record.id,
      tier: record.tier,
      tool: record.tool,
      binding: record.binding,
      channel: record.channel,
      expiresAt: record.expiresAt,
    });
    return record;
  }

  get(id) {
    return this.records.get(id) || null;
  }

  list(status) {
    const all = [...this.records.values()].sort((a, b) => b.createdAt - a.createdAt);
    return status ? all.filter((r) => r.status === status) : all;
  }

  /** 记录 nonce 是否已被消费过（重放防护） */
  consumeNonce(nonce) {
    if (this.usedNonces.has(nonce)) return false;
    this.usedNonces.add(nonce);
    this._persistNonces();
    return true;
  }

  // ── 「本会话内允许」白名单 ────────────────────────────────────────────────
  //
  // 为什么需要它：手表上那个按钮原本就写着「本会话内允许」，但实现里只是把
  // verdict 记成 allow —— 和「仅此一次」完全相同，下一件同样的事还会再问一遍。
  // 一个说话不算话的按钮会训练用户盲点，那比没有这个按钮更危险。
  //
  // 三条硬约束（宁窄勿宽）：
  //   1. 作用域是 **(会话, 工具, 档位)** 三元组。同一会话里换个工具、或请求落到更高档位，
  //      一律照旧来问 —— 不做「这个会话全放行」。
  //   2. **L3 永不参与**，授予与命中两侧都拦。放宽权限必须回到桌面做，
  //      这是 SETUP.md §4 第 7 条的原则。
  //   3. 有有效期（默认 30 分钟），且只存内存，网关一重启就失效。

  _sessionKey(sessionId, tool, tier) {
    return `${sessionId}\u0000${tool}\u0000${tier}`;
  }

  /** 授予一条会话白名单。没有 sessionId 或档位是 L3 时返回 null（即不授予）。 */
  grantSessionAllow({ sessionId, tool, tier, id }) {
    if (!sessionId || tier === 'L3') return null;
    const now = Date.now();
    const entry = {
      sessionId,
      tool,
      tier,
      grantedAt: now,
      expiresAt: now + this.sessionAllowTtlMs,
      grantedFromId: id || null,
      hitCount: 0,
    };
    this.sessionAllows.set(this._sessionKey(sessionId, tool, tier), entry);
    this.audit({
      event: 'session_allow_granted',
      id: id || null,
      tier,
      tool,
      sessionId,
      expiresAt: entry.expiresAt,
    });
    return entry;
  }

  /** 这条请求能否被会话白名单直接放行？命中返回条目并记一次命中，否则 null。 */
  findSessionAllow(record) {
    // 没有会话标识（MCP 主动调用、手机模拟器、手工 curl）→ 不适用
    if (!record.sessionId) return null;
    // L3 永不自作主张
    if (record.tier === 'L3') return null;
    const key = this._sessionKey(record.sessionId, record.tool, record.tier);
    const entry = this.sessionAllows.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.sessionAllows.delete(key);
      return null;
    }
    entry.hitCount += 1;
    entry.lastHitAt = Date.now();
    return entry;
  }

  listSessionAllows() {
    const now = Date.now();
    return [...this.sessionAllows.values()]
      .filter((e) => e.expiresAt > now)
      .sort((a, b) => b.grantedAt - a.grantedAt)
      .map((e) => ({
        sessionId: e.sessionId,
        tool: e.tool,
        tier: e.tier,
        grantedAt: e.grantedAt,
        expiresAt: e.expiresAt,
        remainingMs: Math.max(0, e.expiresAt - now),
        hitCount: e.hitCount || 0,
        grantedFromId: e.grantedFromId,
      }));
  }

  /** 撤销白名单。带条件就只撤匹配的，不带就全撤。返回撤销条数。 */
  revokeSessionAllows(filter = {}) {
    let n = 0;
    for (const [key, e] of [...this.sessionAllows]) {
      if (filter.sessionId && e.sessionId !== filter.sessionId) continue;
      if (filter.tool && e.tool !== filter.tool) continue;
      if (filter.tier && e.tier !== filter.tier) continue;
      this.sessionAllows.delete(key);
      n++;
      this.audit({
        event: 'session_allow_revoked',
        tier: e.tier,
        tool: e.tool,
        sessionId: e.sessionId,
      });
    }
    return n;
  }

  /** 等待某个 approval 的决策；超时返回 null（由调用方按默认选项结算） */
  wait(id, timeoutMs) {
    return new Promise((resolve) => {
      const rec = this.records.get(id);
      if (!rec) return resolve(null);
      if (rec.status !== 'pending') return resolve(rec);

      const timer = setTimeout(() => {
        this.waiters.delete(id);
        resolve(null);
      }, Math.max(0, timeoutMs));

      this.waiters.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          this.waiters.delete(id);
          resolve(r);
        },
        timer,
      });
    });
  }

  _wake(id, rec) {
    const w = this.waiters.get(id);
    if (w) w.resolve(rec);
  }

  /** 结算一次决策。返回 {ok, code, message, record} */
  decide(id, optionId, meta = {}) {
    const rec = this.records.get(id);
    if (!rec) return { ok: false, code: 404, message: 'approval 不存在' };
    if (rec.status !== 'pending') {
      return { ok: false, code: 409, message: `已结算（${rec.status}），忽略重复决策`, record: rec };
    }
    if (Date.now() > rec.expiresAt) {
      this.settle(rec, rec.defaultOptionId, 'expired', meta);
      return { ok: false, code: 410, message: '已过期，按默认选项结算', record: rec };
    }
    const opt = rec.options.find((o) => o.id === optionId);
    if (!opt) return { ok: false, code: 400, message: `未知选项 ${optionId}` };
    this.settle(rec, optionId, 'decided', meta);
    return { ok: true, code: 200, message: '已记录决策', record: rec };
  }

  settle(rec, optionId, reason, meta = {}) {
    rec.status = optionId === rec.defaultOptionId && reason === 'expired' ? 'expired' : 'decided';
    rec.decidedOptionId = optionId;
    rec.decidedAt = Date.now();
    rec.decidedBy = meta.source || 'unknown';
    rec.deviceName = meta.deviceName || null;
    rec.latencyMs = rec.decidedAt - rec.createdAt;
    rec.verdict = rec.approveOptionIds.includes(optionId) ? 'allow' : 'deny';
    this._persist();
    this.audit({
      event: 'settled',
      id: rec.id,
      tier: rec.tier,
      verdict: rec.verdict,
      optionId,
      reason,
      latencyMs: rec.latencyMs,
      source: rec.decidedBy,
      deviceName: rec.deviceName,
      binding: rec.binding,
    });
    this._wake(rec.id, rec);
    return rec;
  }

  cancel(id, reason = 'cancelled') {
    const rec = this.records.get(id);
    if (!rec || rec.status !== 'pending') return null;
    return this.settle(rec, rec.defaultOptionId, 'cancelled', { source: reason });
  }

  sweep() {
    const now = Date.now();
    // ⚠️ 定时器里**不能有未捕获异常**。
    // sweep 每 2 秒跑一次，而它内部会 settle() → _persist() / audit() 碰文件系统。
    // 这里踩过一次：_persist 的 renameSync 抛 EPERM，异常沿 sweep 冒出来变成
    // uncaughtException，直接把网关进程带走（见 _persist 里的长注释）。
    // 下面这些函数已经各自不抛了，但「定时器不许炸」值得再兜一层 ——
    // 一个周期任务因为一次意外就杀掉整个服务，是最不划算的失败方式。
    try {
      this._sweepOnce(now);
    } catch (e) {
      console.error(`[store] ⚠️ sweep 抛异常（已吞掉，网关继续跑）：${e.stack || e.message}`);
    }
  }

  _sweepOnce(now) {
    for (const rec of this.records.values()) {
      if (rec.status === 'pending' && now > rec.expiresAt) {
        this.settle(rec, rec.defaultOptionId, 'expired', { source: 'timeout' });
      }
    }
    // 过期的会话白名单顺手清掉。不写审计 —— 它会每 2 秒扫一次，
    // 真写进去会把 audit.jsonl 刷爆；授予/撤销才值得留痕。
    for (const [key, e] of [...this.sessionAllows]) {
      if (now > e.expiresAt) this.sessionAllows.delete(key);
    }
  }

  close() {
    clearInterval(this.sweeper);
  }
}
