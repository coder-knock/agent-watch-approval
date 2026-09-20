#!/usr/bin/env node
// approval-gateway：本地常驻的确认中枢。
//
//   Agent ──POST /v1/approvals──▶ gateway ──channel──▶ iPhone / Apple Watch
//   Agent ◀──决策结果─────────── gateway ◀──POST /v1/decision（或 HA 事件）
//
// 三条不妥协的规则：
//   1. 默认拒绝。超时、验签失败、通道不可达，一律 deny。
//   2. 一次性。按钮里那串令牌用过即废，重放直接丢。
//   3. 审计留痕。每次确认都落 JSONL，包含动作哈希，事可后查。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { Store } from './core/store.mjs';
import { classify, needsApproval, defaultTtl, TIERS } from './core/risk.mjs';
import {
  actionBinding, newApprovalId, newNonce, sign, safeEqual,
  buildActionId, parseActionId,
} from './core/bind.mjs';
import { createChannel, availableChannels } from './channels/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { config: null, port: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--config') out.config = argv[++i];
    else if (argv[i] === '--port') out.port = Number(argv[++i]);
    else if (argv[i] === '--gen-secret') out.genSecret = true;
  }
  return out;
}

function loadConfig(explicitPath) {
  const candidates = [
    explicitPath,
    path.join(ROOT, 'config.json'),
    path.join(ROOT, 'config.example.json'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      cfg.__path = p;
      if (explicitPath && p !== explicitPath) continue;
      return cfg;
    }
  }
  throw new Error('找不到 config.json，请先从 config.example.json 复制一份');
}

const args = parseArgs(process.argv);
const cfg = loadConfig(args.config);
const DATA_DIR = path.resolve(ROOT, cfg.dataDir || './data');

// 共享密钥：首次运行自动生成并落盘，避免用户用示例里的占位串
const secretFile = path.join(DATA_DIR, 'secret');
fs.mkdirSync(DATA_DIR, { recursive: true });
if (args.genSecret || !fs.existsSync(secretFile)) {
  fs.writeFileSync(secretFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  console.log(`[init] 已生成共享密钥 → ${secretFile}`);
}
const SECRET = fs.readFileSync(secretFile, 'utf8').trim();
if (cfg.sharedSecret && !cfg.sharedSecret.startsWith('CHANGE_ME')) {
  console.warn('[init] config.json 里的 sharedSecret 已被忽略，实际使用 data/secret');
}

const store = new Store(DATA_DIR, {
  // 「本会话内允许」白名单的有效期。默认 30 分钟。
  // 它只存内存，所以网关重启也会清空 —— 两层都偏 fail-closed。
  sessionAllowTtlSeconds: (cfg.defaults || {}).sessionAllowTtlSeconds ?? 1800,
});
const baseUrl = `http://${cfg.host || '127.0.0.1'}:${args.port || cfg.port || 7788}`;

const channel = createChannel(
  cfg.channel || 'mock',
  cfg.channels || {},
  { onDecision: handleIncomingAction },
);

// ── 选项构造 ────────────────────────────────────────────────────────────────
// 顺序很重要：拒绝放第一位，且不标 destructive。
// Apple Watch Series 9 / Ultra 2 的双击手势会触发「第一个非破坏性动作」，
// 把拒绝放第一且不染色，误双击的后果是否决而不是批准。
function buildOptions(tier, reqOptions) {
  // L2 给一个「本会话内允许」以降低重复打扰；L3 绝不给，因为那次点击
  // 可能发生在你完全没看内容的时候 —— 放宽权限必须回到桌面去做。
  const preset = tier === 'L3'
    ? [{ id: 'approve', label: '仅此一次', verdict: 'allow' },
       { id: 'detail', label: '查看详情', verdict: 'defer', informative: true }]
    : [{ id: 'approve', label: '仅此一次', verdict: 'allow' },
       { id: 'approve_session', label: '本会话内允许', verdict: 'allow' }];

  const opts = [{ id: 'deny', label: '拒绝', verdict: 'deny' }, ...preset];

  let final = opts;
  if (Array.isArray(reqOptions) && reqOptions.length) {
    final = reqOptions.map((o) => ({
      id: String(o.id),
      label: String(o.label || o.id),
      verdict: o.verdict || (String(o.id).startsWith('deny') || o.id === 'reject' ? 'deny' : 'allow'),
      destructive: !!o.destructive,
      requireUnlock: !!o.requireUnlock,
      informative: !!o.informative,
    }));
  }

  // 最多 3 个：手表镜像通知能稳定放下 4 个，前 2 个才进紧凑视图
  return final.slice(0, 3);
}

// ── 决策回程（统一入口）────────────────────────────────────────────────────
function handleIncomingAction(actionRaw, meta = {}) {
  const parsed = parseActionId(actionRaw);
  if (!parsed) {
    if (!String(actionRaw).startsWith('APR:')) return { ok: true, ignored: '非本网关的 action' };
    return { ok: false, code: 400, message: 'action 标识格式非法' };
  }
  const { id, optionId, nonce, sig } = parsed;

  if (!safeEqual(sig, sign(SECRET, [id, optionId, nonce]))) {
    store.audit({ event: 'rejected', id, reason: 'signature_mismatch', source: meta.source });
    return { ok: false, code: 403, message: '签名校验失败' };
  }
  if (!store.consumeNonce(nonce)) {
    store.audit({ event: 'rejected', id, reason: 'nonce_replayed', source: meta.source });
    return { ok: false, code: 409, message: '该令牌已被使用过' };
  }

  // 「查看详情」这类信息型选项不结算，只记一笔，用户还能继续点其他按钮
  const rec = store.get(id);
  const opt = rec && rec.options.find((o) => o.id === optionId);
  if (opt && opt.informative) {
    store.audit({ event: 'detail_requested', id, optionId, source: meta.source });
    return { ok: true, code: 200, message: '已请求详情，本请求仍在等待决策', record: null };
  }

  const res = store.decide(id, optionId, {
    source: meta.source || 'unknown',
    deviceName: meta.deviceName || null,
  });
  if (res.ok && res.record && res.record.status !== 'pending') {
    channel.clear?.(res.record);
    // 「本会话内允许」：把 (会话, 工具, 档位) 记进白名单，
    // 让同一会话里同类同档的请求不再打扰你。
    // 用 rec（而不是 res.record）—— sessionId / tool / tier 在它上面。
    // L3 会在 grantSessionAllow 里被拒掉（返回 null）。
    if (optionId === 'approve_session' && rec) {
      const granted = store.grantSessionAllow({
        sessionId: rec.sessionId,
        tool: rec.tool,
        tier: rec.tier,
        id: rec.id,
      });
      if (granted) {
        res.sessionAllow = {
          tool: granted.tool,
          tier: granted.tier,
          expiresAt: granted.expiresAt,
        };
      }
    }
  }
  return res;
}

// ── 创建确认 ────────────────────────────────────────────────────────────────
/**
 * 待确认期间「自动补推」—— 因为 iOS 上根本拦不住你划走它。
 *
 * 先把事实说清楚（2026-09-20 查证）：
 *   - HA 的 `sticky` 是 **Android 专有**字段，iOS 没有对应能力；
 *   - `interruption-level: critical` 只解决「吵醒你 / 绕过静音与专注」，
 *     **不解决划走** —— HA 社区实测原话：*"Swiping/clearing the notification
 *     stops the sound playback."* 划一下就没了，声音也停。
 *   ⇒ **iOS 上不存在「不可划走」的通知。** 任何声称能锁住的方案都是错的。
 *
 * 所以正确的目标不是「划不走」，而是「**划走了也能自己回来**」：
 * 记录还在 pending，就按 renotifySeconds 再推一次，直到你决策、或次数/时间用完。
 * 同一条用同一个 `tag`，所以补推是**替换**那张卡而不是堆一屏 ——
 * 你划走它，几秒后它会带着「（第 2 次提醒）」回来。
 *
 * 关闭方式：`renotifySeconds: 0`（默认就是 0，不吵）。
 * 提醒语在正文里会标次数，见 ha.mjs 的 title 拼接。
 */
function scheduleRenotify(record, everySec, maxTimes) {
  if (!(everySec > 0) || !(maxTimes > 0)) return;
  let sent = 1; // 第 1 次就是 createApproval 里那次正常推送
  const tick = async () => {
    if (sent >= maxTimes) return;
    const cur = store.get(record.id);
    if (!cur || cur.status !== 'pending') return; // 已决策 / 已撤销 / 已过期 → 停
    // 剩余时间不够再等一轮就别推了，免得刚推完就过期。
    if (cur.expiresAt - Date.now() < everySec * 1000) return;
    sent += 1;
    try {
      await channel.push({ ...record, renotify: sent });
      store.audit({
        event: 'push_renotified',
        id: record.id,
        tier: record.tier,
        attempt: sent,
      });
    } catch {
      /* 补推失败不影响原判定，下一次 tick 还会再试 */
    }
    setTimeout(tick, everySec * 1000);
  };
  setTimeout(tick, everySec * 1000);
}

async function createApproval(input) {
  const tool = input.tool || input.tool_name || 'unknown';
  const toolInput = input.tool_input !== undefined ? input.tool_input : input.toolInput;
  const risk = classify(tool, toolInput, cfg.risk || {});
  const tier = input.tier && TIERS.includes(input.tier) ? input.tier : risk.tier;
  const cfgDefaults = cfg.defaults || {};

  const binding = actionBinding(tool, toolInput);
  const id = newApprovalId();
  const now = Date.now();
  const ttlMs = Math.max(5, Number(input.ttl || defaultTtl(tier, cfgDefaults.ttlSeconds))) * 1000;

  const options = buildOptions(tier, input.options);
  const withTokens = options.map((o) => {
    const nonce = newNonce();
    const sig = sign(SECRET, [id, o.id, nonce]);
    return { ...o, actionId: buildActionId(id, o.id, nonce, sig) };
  });

  const record = {
    id,
    createdAt: now,
    expiresAt: now + ttlMs,
    tier,
    tierReason: input.tier_reason || risk.why,
    tool,
    toolInput,
    binding,
    title: input.title || 'Agent 请求确认',
    body: input.body || `${tool}：${summarizeInput(tool, toolInput)}`,
    options: withTokens,
    approveOptionIds: withTokens.filter((o) => o.verdict === 'allow').map((o) => o.id),
    defaultOptionId: input.default_option_id || cfgDefaults.defaultOptionId || 'deny',
    status: 'pending',
    channel: channel.name,
    requester: input.requester || 'agent',
    sessionId: input.session_id || null,
  };

  store.create(record);

  // 「本会话内允许」命中：直接结算，**不推送**。
  // 必须放在 push 之前 —— 命中的全部意义就是「这人已经说过别再问了」。
  const allow = store.findSessionAllow(record);
  if (allow) {
    const decided = store.decide(record.id, 'approve_session', { source: 'session-allow' });
    if (decided.ok && decided.record && decided.record.status !== 'pending') {
      store.audit({
        event: 'session_allow_hit',
        id,
        tier,
        tool,
        sessionId: record.sessionId,
        grantedAt: allow.grantedAt,
      });
      return {
        record: decided.record,
        pushResult: {
          ok: true,
          skipped: true,
          detail:
            `未推送：命中「本会话内允许」` +
            `（${allow.tier} / ${allow.tool}，` +
            `${Math.round((Date.now() - allow.grantedAt) / 1000)} 秒前授予）`,
        },
      };
    }
    // 结算失败就退回正常流程：宁可多问你一次，也不要静默放行
    console.warn('[session-allow] 命中但结算失败，退回正常推送：', decided.message);
  }

  let pushResult;
  try {
    pushResult = await channel.push(record, { baseUrl });
    // 通道**主动**报告推送失败（不是抛错）也要留痕。
    //
    // 典型是「设备根本没在连」：ha.mjs 的 push() 会在推之前先探一次可收性，
    // 确认掉线就直接返回 { ok:false, deviceOffline:true }，压根不去调 notify
    // —— 因为 HA 对掉线设备照样回 200，调了也是白调。
    // 这条路不走下面的 catch，所以原先**一条审计都没有**，
    // 事后翻 audit.jsonl 只会看到这条记录莫名其妙 expired。
    if (pushResult && pushResult.ok === false) {
      store.audit({
        event: 'push_failed',
        id,
        tier,
        error: pushResult.detail || '通道报告推送失败',
        channel: channel.name,
        deviceOffline: pushResult.deviceOffline === true,
      });
      console.error(`[push] 通道 ${channel.name} 推送失败：${pushResult.detail || '未给原因'}`);
    }
  } catch (e) {
    pushResult = { ok: false, detail: e.message };
    store.audit({ event: 'push_failed', id, tier, error: e.message, channel: channel.name });
    console.error(`[push] 通道 ${channel.name} 推送失败：${e.message}`);
  }

  // 推送成功了才值得补推 —— 推都没推出去的话，补推也只是重复失败。
  // 次数/间隔读通道自己的配置（只有 ha 有这个概念，mock 通道不受影响）。
  if (pushResult && pushResult.ok === true && !pushResult.skipped) {
    const haCfg = (cfg.channels || {}).ha || {};
    scheduleRenotify(record, Number(haCfg.renotifySeconds || 0), Number(haCfg.renotifyMax || 0));
  }

  return { record, pushResult };
}

function summarizeInput(tool, toolInput) {
  if (!toolInput) return '';
  if (typeof toolInput === 'object' && typeof toolInput.command === 'string') {
    return toolInput.command.length > 160 ? toolInput.command.slice(0, 157) + '...' : toolInput.command;
  }
  if (typeof toolInput === 'object' && typeof toolInput.file_path === 'string') {
    return toolInput.file_path;
  }
  const s = JSON.stringify(toolInput);
  return s.length > 160 ? s.slice(0, 157) + '...' : s;
}

// ── HTTP ───────────────────────────────────────────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 2_000_000) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        try {
          resolve(Object.fromEntries(new URLSearchParams(raw)));
        } catch {
          reject(new Error('无法解析请求体'));
        }
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, baseUrl);
  const p = url.pathname;

  try {
    if (req.method === 'GET' && (p === '/' || p === '/phone.html')) {
      // 配了 phoneAccessKey 就挡住不带 key 的访问。
      // 只挡页面、不挡 API：phone.html 是拿到 actionId 的唯一途径，而
      // actionId 自带一次性 nonce + HMAC 签名（本身就是凭证）。打不开页面
      // 就无从伪造决策，所以这一层足够，不必给 /v1/decision 加额外门槛。
      const phoneKey = ((cfg.channels || {}).ha || {}).phoneAccessKey || '';
      if (phoneKey && url.searchParams.get('k') !== phoneKey) {
        return sendJson(res, 401, {
          error: '这个审批页需要口令：请在地址后加 ?k=<phoneAccessKey>',
        });
      }
      const file = path.join(ROOT, 'public', 'phone.html');
      if (!fs.existsSync(file)) return sendJson(res, 404, { error: '缺少 public/phone.html' });
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      return res.end(fs.readFileSync(file));
    }

    if (req.method === 'GET' && p === '/healthz') {
      // ⚠️ `channelReady` 只说明**传输层**通（网关↔通道握手成功）。
      // 它曾经被当成「能收到推送」的同义词，于是出现过很坑的一幕：
      // 自检报 channelReady: true，而每一次推送都 500 —— 因为 iPhone 上的
      // HA App 早就掉线了。两个层面必须分开报，否则自检结果自相矛盾。
      // `deviceReady`: true 在 / false 掉线 / null 判不了（设备没注册或实体被禁用）。
      const readiness = channel.readiness ? await channel.readiness().catch(() => null) : null;
      return sendJson(res, 200, {
        ok: true,
        channel: channel.name,
        channelReady: channel.connected === undefined ? true : channel.connected,
        deviceReady: readiness ? readiness.reporting : null,
        deviceHint: readiness && readiness.reporting === false ? readiness.reason : null,
        pending: store.list('pending').length,
        baseUrl,
      });
    }

    if (req.method === 'GET' && p === '/v1/config') {
      return sendJson(res, 200, {
        baseUrl,
        channel: channel.name,
        channels: availableChannels(),
        tierDefaults: (cfg.defaults || {}).ttlSeconds || {},
      });
    }

    if (req.method === 'GET' && p === '/v1/approvals') {
      const status = url.searchParams.get('status');
      const items = store.list(status).slice(0, 100).map((r) => ({
        id: r.id,
        tier: r.tier,
        title: r.title,
        body: r.body,
        status: r.status,
        verdict: r.verdict || null,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        remainingMs: r.status === 'pending' ? Math.max(0, r.expiresAt - Date.now()) : 0,
        options: r.options.map((o) => ({ id: o.id, label: o.label, actionId: o.actionId })),
      }));
      return sendJson(res, 200, { items });
    }

    const mGet = p.match(/^\/v1\/approvals\/([A-Za-z0-9_-]+)$/);
    if (req.method === 'GET' && mGet) {
      const r = store.get(mGet[1]);
      if (!r) return sendJson(res, 404, { error: '不存在' });
      return sendJson(res, 200, {
        id: r.id, tier: r.tier, status: r.status,
        verdict: r.verdict || null, optionId: r.decidedOptionId || null,
        binding: r.binding, tool: r.tool,
        createdAt: r.createdAt, expiresAt: r.expiresAt,
        latencyMs: r.latencyMs || null,
        decidedBy: r.decidedBy || null,
        deviceName: r.deviceName || null,
      });
    }

    if (req.method === 'POST' && p === '/v1/approvals') {
      const body = await readBody(req);
      const { record, pushResult } = await createApproval(body);
      const waitSec = Number(body.wait || 0);

      if (waitSec > 0) {
        // ★ 推送没送出去就别空等。
        //
        // 卡片根本没到用户手机上，等满 maxWait 只是把调用方卡住两分钟，
        // 最后照样是 deny —— 纯白等。实测这条路径每次白等 120 秒
        // （audit.jsonl 里 wait>0 的记录 latencyMs 齐刷刷 1205xx），
        // MCP 的 request_approval 和任何带 wait 的脚本首当其冲。
        //
        // `skipped` 不算失败：那是命中「本会话内允许」主动不推，且已经结算过了。
        if (pushResult.ok === false && !pushResult.skipped) {
          const settled = store.cancel(record.id, 'push-failed') || store.get(record.id) || record;
          return sendJson(res, 200, {
            id: settled.id, tier: settled.tier, status: settled.status,
            verdict: settled.verdict || 'deny',
            optionId: settled.decidedOptionId || record.defaultOptionId,
            binding: settled.binding, latencyMs: settled.latencyMs || 0,
            decidedBy: settled.decidedBy || 'push-failed', deviceName: null,
            pushOk: false, pushDetail: pushResult.detail,
            failedFast: true,
          });
        }
        const maxWait = Math.min(waitSec * 1000, record.expiresAt - Date.now());
        let final = await store.wait(record.id, maxWait);
        if (!final || final.status === 'pending') {
          final = store.settle(record, record.defaultOptionId, 'expired', { source: 'timeout' });
          store.audit({ event: 'timeout_default', id: record.id, tier: record.tier, optionId: record.defaultOptionId });
        }
        return sendJson(res, 200, {
          id: final.id, tier: final.tier, status: final.status,
          verdict: final.verdict, optionId: final.decidedOptionId,
          binding: final.binding, latencyMs: final.latencyMs,
          decidedBy: final.decidedBy, deviceName: final.deviceName,
          pushOk: pushResult.ok, pushDetail: pushResult.detail,
        });
      }

      return sendJson(res, 202, {
        id: record.id, tier: record.tier, status: record.status,
        binding: record.binding, expiresAt: record.expiresAt,
        pushOk: pushResult.ok, pushDetail: pushResult.detail,
      });
    }

    if (req.method === 'POST' && p === '/v1/decision') {
      const body = await readBody(req);
      const action = body.action || body.actionId || body.action_id;
      if (!action) return sendJson(res, 400, { error: '缺少 action' });
      const out = handleIncomingAction(action, {
        source: body.channel || 'phone',
        deviceName: body.deviceName || body.device_name || null,
      });
      store.audit({ event: 'decision_inbound', raw: action.slice(0, 24) + '...', ok: !!out.ok, code: out.code });
      return sendJson(res, out.ok ? 200 : out.code || 400, {
        ok: !!out.ok, message: out.message || out.ignored || '已处理',
        verdict: out.record ? out.record.verdict : null,
        optionId: out.record ? out.record.decidedOptionId : null,
      });
    }

    // 便捷端点：给脚本/测试用，走 approval id + 选项 id，内部补 nonce 与签名
    const mDecide = p.match(/^\/v1\/approvals\/([A-Za-z0-9_-]+)\/decide$/);
    if (req.method === 'POST' && mDecide) {
      const body = await readBody(req);
      const r = store.get(mDecide[1]);
      if (!r) return sendJson(res, 404, { error: '不存在' });
      const opt = r.options.find((o) => o.id === (body.option_id || body.optionId));
      if (!opt) return sendJson(res, 400, { error: '未知选项' });
      const out = handleIncomingAction(opt.actionId, {
        source: body.source || 'local-bypass',
        deviceName: body.deviceName || null,
      });
      return sendJson(res, out.ok ? 200 : out.code || 400, {
        ok: !!out.ok, message: out.message,
        verdict: out.record ? out.record.verdict : null,
      });
    }

    // 「调用方放弃等待」的显式出口。
    //
    // 为什么需要它：hook 在推送失败时会 fail-closed 立刻 deny 并退出，但那条记录
    // 在网关侧仍是 `pending`，要等自己的 sweeper 到 expiresAt 才落 `expired`。
    // 两个后果都很坏：
    //   ① `/v1/approvals?status=pending` 上挂着一条永远没人能点的幽灵卡片；
    //   ② 审计把「推送根本没送出去」记成 `expired / source=timeout` ——
    //      实测 81 次推送失败全被记成 90 条「超时未确认」，排障时看到的是一个
    //      假象：以为用户在手机上不理它，其实是通知压根没送达。
    // 走 store.cancel 后审计记的是 `reason=cancelled`、`source=push-failed`，
    // 一眼能分清「没送到」和「送到了没人点」——这两种情况的处置完全不同。
    const mCancel = p.match(/^\/v1\/approvals\/([A-Za-z0-9_-]+)\/cancel$/);
    if (req.method === 'POST' && mCancel) {
      const body = await readBody(req);
      const reason = String(body.reason || 'cancelled').slice(0, 48);
      const settled = store.cancel(mCancel[1], reason);
      if (!settled) {
        // 幂等：已经结算过（被 sweeper 收走 / 用户抢先点了）就当成功 ——
        // 调用方是来「撤销等待」的，目标状态已经达成，不该让它为此报错。
        const cur = store.get(mCancel[1]);
        if (!cur) return sendJson(res, 404, { error: '不存在' });
        return sendJson(res, 200, {
          ok: true, alreadySettled: true,
          status: cur.status, verdict: cur.verdict || null,
        });
      }
      return sendJson(res, 200, {
        ok: true, status: settled.status, verdict: settled.verdict,
        optionId: settled.decidedOptionId, latencyMs: settled.latencyMs,
      });
    }

    if (req.method === 'POST' && p === '/v1/verify') {
      const body = await readBody(req);
      const r = store.get(body.id);
      if (!r) return sendJson(res, 404, { ok: false, error: '不存在' });
      const actual = actionBinding(body.tool, body.tool_input);
      const ok = r.verdict === 'allow' && actual === r.binding;
      return sendJson(res, 200, { ok, bindingMatch: actual === r.binding, expected: r.binding, actual });
    }

    if (req.method === 'GET' && p === '/v1/audit') {
      const limit = Number(url.searchParams.get('limit') || 50);
      return sendJson(res, 200, { items: store.readAudit(limit) });
    }

    // 让「本机一次性确认」也能在统一审计里留痕。
    //
    // 场景：推送到手表失败 → hook 拦住 → 你在 WorkBuddy 的弹框里点「允许这一次」
    // → Agent 跑 `approval confirm`。那张授权只存在于本机（data/local-grants.json），
    // 但**「有人用本地确认放行了什么」必须事后可查** —— 可见性才是这条路的防线，
    // 所以 confirm 与 hook 都会 best-effort 地往这里补一条。
    //
    // 只认三个固定事件名，避免这个端点退化成「谁都能往审计里写任意内容」。
    // 它不参与任何判定，写失败也不影响放行 —— 纯粹是留痕。
    if (req.method === 'POST' && p === '/v1/audit') {
      const body = await readBody(req);
      const allowed = ['local_confirm_issued', 'local_confirm_used', 'local_confirm_rejected'];
      const event = String(body.event || '');
      if (!allowed.includes(event)) {
        return sendJson(res, 400, { error: `event 必须是 ${allowed.join(' / ')}` });
      }
      store.audit({
        event,
        tool: body.tool || null,
        tier: body.tier || null,
        binding: body.binding || null,
        by: body.by || null,
        summary: String(body.summary || '').slice(0, 200),
      });
      return sendJson(res, 200, { ok: true });
    }

    // 会话白名单：看一眼「现在有哪些事被静默放行」，以及撤销它。
    // 一个放宽权限的机制如果没有可见、可撤销的入口，就不该存在。
    if (req.method === 'GET' && p === '/v1/sessions') {
      const items = store.listSessionAllows();
      return sendJson(res, 200, {
        items,
        ttlSeconds: Math.round(store.sessionAllowTtlMs / 1000),
        note: '只存内存：网关一重启就清空。L3 永不出现在这里。',
      });
    }

    if (req.method === 'POST' && p === '/v1/sessions/revoke') {
      const body = await readBody(req);
      const n = store.revokeSessionAllows({
        sessionId: body.sessionId || body.session_id || undefined,
        tool: body.tool || undefined,
        tier: body.tier || undefined,
      });
      return sendJson(res, 200, { revoked: n, items: store.listSessionAllows() });
    }

    return sendJson(res, 404, { error: '未知端点 ' + p });
  } catch (e) {
    console.error('[gateway] 请求处理异常：', e);
    return sendJson(res, 500, { error: e.message });
  }
});

const PORT = args.port || cfg.port || 7788;

// ── 进程级兜底 ────────────────────────────────────────────────────────────
//
// ⚠️ 这是一个**故意选择「活着」而不是「干净地死」**的地方，理由必须写清楚。
//
// 实测踩过：`store._persist()` 的 `renameSync` 抛 EPERM，而它是在 2 秒一次的
// sweep 定时器里被调用的 —— 未捕获异常直接把网关进程带走。后果不是「少存一条
// 记录」，而是：网关一死，所有 L2/L3 命令都走「网关不可达」分支
// （L2 一直问你、L3 直接拒），用户体感是「我的命令突然全被拒了」，
// 而终端上根本看不到那条真正的错误。
//
// 这个组件的失败模式要按「可用性 > 洁癖」来排序：
//   · 网关活着但状态有点脏  → 审批照常走，用户最多多点一次
//   · 网关死掉              → 所有危险操作被拒 / 被反复追问，属功能性中断
// 所以：记下来、喊出来，然后继续跑。**不是静默吞掉** ——
// 每一笔都会落到 stderr 和审计里，`approval audit` 能查到。
function reportFatal(kind, err) {
  const detail = err && (err.stack || err.message) ? (err.stack || err.message) : String(err);
  console.error(`\n[gateway] ❌ ${kind} —— 已记录并继续运行（不退出，避免所有命令被拒）\n${detail}\n`);
  try {
    store.audit({ event: 'gateway_error', kind, detail: String(detail).slice(0, 2000) });
  } catch {
    /* 连审计都写不进去时，上面的 stderr 就是唯一的痕迹了 */
  }
}
process.on('uncaughtException', (err) => reportFatal('uncaughtException', err));
process.on('unhandledRejection', (err) => reportFatal('unhandledRejection', err));

server.listen(PORT, cfg.host || '127.0.0.1', async () => {
  console.log('');
  console.log('  approval-gateway 已启动');
  console.log('  ├─ 监听      ' + baseUrl);
  console.log('  ├─ 通道      ' + channel.name);
  console.log('  ├─ 配置      ' + cfg.__path);
  console.log('  ├─ 数据目录  ' + DATA_DIR);
  console.log(
    '  ├─ 会话白名单 ' +
      Math.round(store.sessionAllowTtlMs / 1000) +
      ' 秒 / 只存内存（approval sessions 查看或撤销）'
  );
  console.log('  └─ 手机模拟  ' + baseUrl + '/');
  console.log('');
  await channel.start();
});

async function shutdown() {
  await channel.stop?.();
  store.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
