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
    // 一旦 rename 在本环境被判死，后续直接走覆盖写，不再每 2 秒重试一次
    // 注定失败的 syscall 并刷一行日志（见 _persist 里的说明）。
    this._renameBroken = false;
    // 覆盖写自己的失败计数与「喊过了」标记 —— 与 _persistFailures 分开。
    // ⚠️ 为什么必须分开：rename 失败会把 _persistFailures 先加到 1，紧接着
    // 覆盖写失败就变成 2，而告警条件是「第 1 次或每 100 次」——
    // 于是**最该被看见的那条**（数据彻底写不进去、重启会丢）恰好被吞掉。
    // 这是被 §2 断言逼出来的修复，不是洁癖。
    this._directFailures = 0;
    this._directWarned = false;
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
    const json = JSON.stringify({ savedAt: Date.now(), records }, null, 2);

    // ── 「原子改名在这个环境里不可用」时要记住，而不是每 2 秒重试一次 ────────
    //
    // _persist 被 2 秒一次的 sweep 定时器调着。在这一版 macOS 的权限策略下
    // `pending.json.tmp → pending.json` 的 rename 必失败（EPERM），于是
    // 每 2 秒就会：① 发一次注定失败的 syscall；② 往 stderr 打一行。
    // 实测这个组合把 gateway-detached.log 刷成了 26 行里 26 行都是 EPERM，
    // 真正有用的启动信息被埋掉，排查时第一眼看到的是一个「像故障的噪音」。
    //
    // 所以记一次就够了：第一次失败后打**一条**带完整解释的告警，然后
    // 后续直接走退化路径，不再试 rename、不再刷日志。
    if (this._renameBroken) {
      this._writeDirect(json, tmp);
      return;
    }

    try {
      fs.writeFileSync(tmp, json);
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
        // 两种都失败就大声抱怨一句，但**绝不中断进程**。
        this._persistFailures++;
        this._renameBroken = true;
        console.error(
          `[store] ⚠️ 原子改名不可用（${e.code || e.message}），本进程后续改为直接覆盖写。\n` +
          `        影响：写盘不再原子。崩溃/断电的瞬间可能留下一个半截的\n` +
          `        ${path.basename(this.pendingFile)} —— 而它只装「还没结算的待确认记录」，\n` +
          `        丢了最多重问一次；比每 2 秒重试一次注定失败的 syscall 划算。\n` +
          `        这条只打一次，不再刷屏。`
        );
        this._writeDirect(json, tmp);
      }
    } catch (e) {
      this._persistFailures++;
      console.error(`[store] ❌ 写临时文件失败：${e.message}（待决记录仍在内存里，审批不受影响）`);
    }
  }

  /**
   * 退化路径：绕过 rename 直接写目标文件，并清掉那个已经没用的 .tmp。
   *
   * 清 tmp 不是洁癖：rename 失败时 tmp 会一直留着，而它是**上一次的旧内容**。
   * 下次有人按「tmp 是本次写入」的直觉去读它，会读到过期数据。
   */
  _writeDirect(json, tmp) {
    try {
      fs.writeFileSync(this.pendingFile, json);
    } catch (e) {
      this._persistFailures++;
      this._directFailures++;
      // 第 1 次必喊；之后每 100 次再喊一次，避免刷屏但也不至于彻底沉默
      // （沉默比刷屏更糟：那意味着网关在「什么都没存下来」的状态下安静地跑）。
      if (!this._directWarned || this._directFailures % 100 === 0) {
        this._directWarned = true;
        console.error(
          `[store] ❌ 待决记录落盘失败（已连续 ${this._directFailures} 次）：${e.message}\n` +
          `        数据仍在内存里、审批不受影响；但网关重启后这批未决记录会丢。`
        );
      }
      return;
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* tmp 本来就不在就算了 */
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

  /**
   * 过滤后的审计事件 —— 给 /v1/audit 用。
   *
   * 注意：审计文件可能很大（一天几百条，跑一年就上万），所以读取时直接按
   * 行级 predicate 过滤，**不**读全再 filter。`since/before` 仍按时间窗粗筛
   * 之后才解析 JSON，能省一点是一点。
   *
   * @param {object} [opts]
   * @param {string} [opts.event]    按 event 精确匹配（多个用 `,` 分隔）
   * @param {string} [opts.tier]     按 tier 匹配（L0/L1/L2/L3）
   * @param {number} [opts.since]    时间窗起点（epoch ms）
   * @param {number} [opts.before]   时间窗终点（epoch ms）
   * @param {string} [opts.id]       只保留与指定 approval id 相关的事件
   * @param {number} [opts.limit]    返回条数上限（默认 50）
   * @param {number} [opts.offset]   跳过前 N 条（用于翻页）
   */
  queryAudit({ event, tier, since, before, id, limit = 50, offset = 0 } = {}) {
    let lines;
    try {
      lines = fs.readFileSync(this.auditFile, 'utf8').split('\n');
    } catch {
      return [];
    }
    const events = event ? new Set(event.split(',').map((s) => s.trim()).filter(Boolean)) : null;
    const sinceMs = Number.isFinite(since) ? since : null;
    const beforeMs = Number.isFinite(before) ? before : null;
    const out = [];
    // 倒序遍历：最新的在前；时间窗裁剪在解析前做（粗筛）。
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      // JSONL 每行以 {"ts":"2026-09-..." 开头；粗筛时间窗。
      // ⚠️ ISO 字符串比 epoch 多一步比较，但 ts 一定是 ISO 字符串 —— 简单起见
      // 先 parse 后 filter；超过 1 万条再考虑优化。
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (sinceMs != null || beforeMs != null) {
        const t = Date.parse(entry.ts);
        if (Number.isFinite(t)) {
          if (sinceMs != null && t < sinceMs) continue;
          if (beforeMs != null && t > beforeMs) continue;
        }
      }
      if (events && !events.has(entry.event)) continue;
      if (tier && entry.tier !== tier) continue;
      if (id && entry.id !== id) continue;
      if (offset > 0) { offset--; continue; }
      out.push(entry);
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * 聚合统计 —— 给 /v1/audit/summary 用。
   * 给定时间窗内，按 (event, tier, verdict) 分组计数。
   */
  summarizeAudit({ since, before } = {}) {
    let lines;
    try {
      lines = fs.readFileSync(this.auditFile, 'utf8').split('\n');
    } catch {
      return { byEvent: {}, byTier: {}, byVerdict: {}, total: 0, window: { since, before } };
    }
    const sinceMs = Number.isFinite(since) ? since : null;
    const beforeMs = Number.isFinite(before) ? before : null;
    const byEvent = {};
    const byTier = {};
    const byVerdict = {};
    let total = 0;
    for (const line of lines) {
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (sinceMs != null || beforeMs != null) {
        const t = Date.parse(entry.ts);
        if (Number.isFinite(t)) {
          if (sinceMs != null && t < sinceMs) continue;
          if (beforeMs != null && t > beforeMs) continue;
        }
      }
      total++;
      const e = entry.event || 'unknown';
      byEvent[e] = (byEvent[e] || 0) + 1;
      if (entry.tier) byTier[entry.tier] = (byTier[entry.tier] || 0) + 1;
      if (entry.verdict) byVerdict[entry.verdict] = (byVerdict[entry.verdict] || 0) + 1;
    }
    return { byEvent, byTier, byVerdict, total, window: { since: sinceMs, before: beforeMs } };
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

  /**
   * 过滤后的 approval 记录 —— 给 /v1/approvals 用。
   *
   * 与 list() 的区别：能按 tier / 时间窗 / 关键字过滤。`q` 在 body / title /
   * tool / binding / requester 任意字段做**子串**匹配（不区分大小写），
   * 故意不支持正则 —— 留给前端做「人类能想到的简单搜索」就够了。
   */
  queryApprovals({ status, tier, since, before, q, limit = 50, offset = 0 } = {}) {
    const all = [...this.records.values()].sort((a, b) => b.createdAt - a.createdAt);
    const qLower = q ? String(q).toLowerCase() : null;
    const sinceMs = Number.isFinite(since) ? since : null;
    const beforeMs = Number.isFinite(before) ? before : null;
    const out = [];
    let skipped = 0;
    for (const r of all) {
      if (status && r.status !== status) continue;
      if (tier && r.tier !== tier) continue;
      if (sinceMs != null && r.createdAt < sinceMs) continue;
      if (beforeMs != null && r.createdAt > beforeMs) continue;
      if (qLower) {
        const hay = `${r.title} ${r.body} ${r.tool} ${r.binding} ${r.requester || ''}`.toLowerCase();
        if (!hay.includes(qLower)) continue;
      }
      if (skipped < offset) { skipped++; continue; }
      out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** /v1/audit/trace/:id 用：把一条 approval 的全部审计事件按时间正序返回。 */
  auditTrailFor(id) {
    let lines;
    try { lines = fs.readFileSync(this.auditFile, 'utf8').split('\n'); }
    catch { return []; }
    const out = [];
    for (const line of lines) {
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.id === id) out.push(entry);
    }
    return out;
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
