#!/usr/bin/env node
// Agent hook 入口：把「需要确认的工具调用」转成一次腕上确认。
//
// 协议（与 Claude Code / WorkBuddy 的 hook JSON 同构）：
//   stdin  ← {"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{...}}
//   stdout → {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}
//
// 分级处置：
//   L0 / L1  → 不输出任何内容（交回原本的权限流程，绝不静默提权）
//   L2       → 推送到手表；批准则 allow，拒绝则 deny，超时 deny
//   L3       → 同上，并要求设备解锁；网关不可达时 fail-closed 直接 deny
//
// 「确认送不到你手上」时（推送 500 / 网关失联 / 网关非 2xx）一律 fail-closed 拦住，
// 但会先去 data/local-grants.json 查一张**本机一次性授权** —— 那是你在 WorkBuddy 的
// 弹框里点过「允许这一次」之后由 `approval confirm` 落下的。命中就放行（且只能用一次）。
// 为什么要这么绕：本构建的 WorkBuddy **不实现 `permissionDecision:"ask"`**，
// 输出 ask 等于静默放行。详见 src/core/local-grant.mjs 的头部说明。
//
// 另一个用法：作为 Stop / Notification hook 的发信器
//   approve-hook --notify "任务已完成" ["补充说明"]

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, needsApproval, defaultTtl } from '../src/core/risk.mjs';
import {
  consumeGrant,
  grantBinding,
  rememberBlocked,
  resolveDataDir,
  readSecret,
  shortBinding,
} from '../src/core/local-grant.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// data/ 与网关共用：本机一次性授权、被拦记录都落在这里。
const DATA_DIR = resolveDataDir(PROJECT_ROOT);
const SECRET = readSecret(DATA_DIR);

const GATEWAY = (process.env.APPROVAL_GATEWAY_URL || 'http://127.0.0.1:7788').replace(/\/+$/, '');

// 「卡片有效期」——卡片什么时候失效，就等于 Agent 什么时候放弃。
// 注意：真正「愿意等多久」由下面的 BUDGET 封顶，两者不必相等。
// 旧设计里二者是同一个数（wait = ttl），结果在宿主按 `timeout` 杀 hook 时
// 会出现「Agent 早拒了、你后点允许却结算成 allow」的迷惑状态。现在拆开：
//   ttl    = 卡片在网关/手表上活多久（可被 BUDGET 进一步缩短）；
//   BUDGET = 本地阻塞等待的硬上限，**必须小于 settings.json 里 hook 的 `timeout`**。
const DEFAULT_TTL = {
  L2: Number(process.env.APPROVAL_TTL_L2 || 120),
  L3: Number(process.env.APPROVAL_TTL_L3 || 120),
};

// 阻塞等待的硬上限。**必须小于 settings.json 里这条 hook 的 `timeout`。**
//
// 宿主对 hook 超时的处置是（从 cli/dist/codebuddy.js 的 HookExecutor 反读）：
//   setTimeout(() => { timedOut = true; child.kill('SIGTERM');
//                      setTimeout(() => child.kill('SIGKILL'), 1000) }, timeoutMs)
//   ...
//   if (timedOut) return { allowed: false, exitCode: -1,
//                          message: `Hook timed out after ${ms}ms` }
// 也就是**宿主直接把 hook 杀掉**，我们的 allow/deny/ask 逻辑根本没机会跑；
// 而网关里那条待确认记录会一直留到它自己的 ttl 到期。
//
// 历史配置 `timeout: 180` + `ttl: 300`（fetch 超时 310s）正好踩了这个坑：
// L2 白等 180 秒，然后被宿主按「hook 超时」拒掉，现象就是「任务卡死两分钟后失败」。
//
// 这里用 min(ttl, BUDGET) 把这个不变式**由构造保证**，而不是指望人去对齐两个数字。
const BUDGET = Math.max(5, Number(process.env.APPROVAL_HOOK_BUDGET || 150));

// 「确认没能送到你手上」时怎么处置。
//
// ⚠️ 只能取 allow / deny 两个值 —— **`ask` 在这里是个陷阱，不要用**。
//
// 直觉上 `permissionDecision: "ask"` 正好是「交给宿主的原生权限框」，
// 但本构建的 WorkBuddy **没有实现 ask**：HookExecutor.parseHookOutput() 里
// `allowed` 的初值是 `exitCode === 0`（= true），而只有 deny/allow 两个分支，
// `ask` 直接落到初值 → **静默放行**。executePreToolUseHooks() 里同样只认这两个。
// 于是 `ask` 的真实效果和 `allow` 完全一样，却没有 allow 那么显眼。
//
// 实测（2026-09-19，推送必然失败的前提下）：
//   · L2 探针 `git push`      → 钩子输出 ask   → 命令**照常执行**
//   · L3 探针 `rm -rf <不存在>` → 钩子输出 deny  → 命令被拦住
// 所以默认值从 `L2: 'ask'` 改为 `deny`：那是个 fail-open 漏洞，不是「问一下」。
//
// 「给用户一个选项」的真正做法见 src/core/local-grant.mjs 的头部说明。
// 兜底值只有一个来源：环境变量（settings.json 里给 hook 加的那行）。默认 deny。
//
// ⚠️ config.json 里曾经有个 `defaults.gatewayUnreachable` 与它语义重复，
// 但**没有任何代码读它** —— 一个调不动的开关，而它的值正好是最危险的那个
// （`L2: "ask"`，等于放行）。SETUP.md 还照着它写「头一周设成 ask」。
// 这次改动把它删掉了：配置里不该留一个「看起来能调、其实没接线」的旋钮，
// 因为下一次有人照着它调参时，得到的行为和文档承诺的完全不一样。
const RAW_FALLBACK = {
  L2: process.env.APPROVAL_FALLBACK_L2,
  L3: process.env.APPROVAL_FALLBACK_L3,
};
const DEFAULT_FALLBACK = 'deny'; // fail-closed
const fallbackWarned = new Set();

function fallbackFor(t) {
  const raw = String(RAW_FALLBACK[t] ?? DEFAULT_FALLBACK).trim().toLowerCase();
  if (raw === 'ask') {
    if (!fallbackWarned.has(t)) {
      fallbackWarned.add(t);
      progress(
        `⚠️ APPROVAL_FALLBACK_${t}=ask 已按 deny 处理：本构建的 WorkBuddy 不实现 ask，` +
          `它会被当成放行。要「弹框问一下」请改用 approval confirm 那条路（见 SETUP.md 2.1）。`
      );
    }
    return 'deny';
  }
  if (raw === 'allow') return 'allow';
  if (raw !== 'deny' && !fallbackWarned.has(t)) {
    fallbackWarned.add(t);
    progress(`⚠️ APPROVAL_FALLBACK_${t}=${raw} 不是合法值，按 deny 处理。`);
  }
  return 'deny';
}

// 进度**只写 stderr，绝不写 stdout**。
// 宿主会把 stdout 当 hook 的 JSON 输出去 JSON.parse（`Hook command completed with
// status 0: <Your stdout>`）；解析失败时它只做两件事：
//   ① 把整段 stdout 当「给用户看的消息」；② `allowed` 保持 `exitCode === 0` 的初值。
// 于是往 stdout 塞人类可读的进度会**把 deny 洗成「没有决定」= 静默放行**。
// stderr 则被文档明确列为安全的调试通道（「调试日志可以安全地写入 stderr，
// 不会污染给 Agent 的反馈消息」）。
let beatTimer = null;
function progress(msg) {
  try { process.stderr.write(`[approval] ${msg}\n`); } catch { /* 写不进去也不影响判定 */ }
}

function emit(obj) {
  if (beatTimer) clearInterval(beatTimer);
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

/**
 * 事件驱动地等一个 id 结算，同时受两层上限约束：
 *   ① 网关自己的 expiresAt —— 到期它会把记录 settle 成 expired；
 *   ② deadline = now + budget —— 兜底，宿主 SIGTERM 之前必须脱身。
 * 每 2s 轮询一次 GET；若期间网关被重启，记录仍在 pending.json，
 * 重启后 sweeper 会把「宕机期间已过期」的判成 expired，轮询照样拿到结论。
 */
async function pollUntilDecided(id, expiresAt, budget) {
  const deadline = Date.now() + budget * 1000;
  let waitedSec = 0;
  for (;;) {
    if (Date.now() >= deadline) return null; // 兜底超时，走 fail-safe
    let cur = null;
    try {
      const res = await fetch(`${GATEWAY}/v1/approvals/${id}`, {
        headers: { Accept: 'application/json' },
      });
      if (res.ok) cur = await res.json();
    } catch { /* 网关此刻不可达，下一轮再试 */ }
    if (cur && cur.status !== 'pending') return cur;
    if (cur && cur.expiresAt && Date.now() >= cur.expiresAt) {
      // 网关还没把 settled 落库（sweeper 最长 2s），直接按过期结算，
      // 避免在过期点附近白轮询到 deadline。
      return { id: cur.id, tier: cur.tier, status: 'expired', verdict: null,
               optionId: null, latencyMs: null, deviceName: null };
    }
    await new Promise((r) => setTimeout(r, 2000));
    waitedSec += 2;
    progress(`等待确认中… ${waitedSec}s / ${Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))}s`);
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { raw += c; });
    process.stdin.on('end', () => resolve(raw));
    setTimeout(() => resolve(raw), 8000);
  });
}

function makeOutput(eventName, decision, reason) {
  if (eventName === 'PermissionRequest') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: decision === 'allow' ? 'allow' : 'deny', message: reason },
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: eventName || 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
}

async function post(pathname, body, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(GATEWAY + pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch { /* 保留空对象 */ }
    return { ok: res.ok, status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 往网关补一条审计，best-effort：绝不抛、绝不改判定、绝不阻塞太久。
 * 只用于「本机一次性确认」这条路 —— 那条路绕过了推送，是唯一没有
 * 设备侧记录的决定，所以它更需要一条可查的痕迹（见 local-grant.mjs 头注释）。
 */
async function reportAudit(entry, timeoutMs = 1200) {
  try { await post('/v1/audit', entry, timeoutMs); } catch { /* 网关不在也不影响本次判定 */ }
}

/**
 * 撤销网关侧那条还挂着的记录 —— 「我这边已经有结论了，别再等它」。
 *
 * 为什么必须做：hook 判定完就 process.exit(0) 走了，而网关的记录没人管，
 * 要等它自己的 sweeper 到 expiresAt 才落 `expired`。两个后果：
 *   ① `/v1/approvals?status=pending` 上留着一条永远没人能点的幽灵卡片；
 *   ② 审计把「推送没送出去」记成 `expired / source=timeout` ——
 *      实测 81 次 push_failed 全被记成 90 条「超时未确认」。
 * 撤销后审计记的是 `reason=cancelled` + `source=<reason>`，
 * 「没送到」和「送到了没人点」一眼可分。
 *
 * best-effort：网关不可达 / 超时，最多少一条审计，绝不影响本次判定。
 */
async function abandonGatewayRecord(id, reason) {
  if (!id) return;
  try {
    await post(`/v1/approvals/${id}/cancel`, { reason }, 1200);
  } catch { /* 撤销失败不影响判定，网关的 sweeper 仍会兜底 */ }
}

function describe(record) {
  const where = record.deviceName ? `，设备 ${record.deviceName}` : '';
  return `${record.tier} ${record.optionId}（${Math.round((record.latencyMs || 0) / 100) / 10}s${where}）`;
}

async function notifyOnly(title, body) {
  try {
    // 通知型请求：不阻塞、不等决策，发完就走（ttl 短一点，免得 pending 里挂一堆）。
    await post('/v1/approvals', {
      tool: 'Notification', tool_input: { title, body }, tier: 'L1',
      title, body, ttl: 10, wait: 0, options: [{ id: 'ok', label: '知道了', verdict: 'allow' }],
      requester: 'hook-notify',
    }, 4000);
  } catch {
    /* 发信失败不该影响 Agent */
  }
  process.exit(0);
}

const argv = process.argv.slice(2);
if (argv[0] === '--notify') {
  await notifyOnly(argv[1] || 'Agent 通知', argv[2] || '');
}

const rawInput = await readStdin();

let input = {};
try {
  input = JSON.parse(rawInput || '{}');
} catch {
  // 解析失败时保持沉默，交回正常流程
  process.exit(0);
}

const eventName = input.hook_event_name || input.hookEventName || 'PreToolUse';
const toolName = input.tool_name || input.toolName || 'unknown';
const toolInput = input.tool_input !== undefined ? input.tool_input : input.toolInput;

const { tier, why } = classify(toolName, toolInput);

// L0 / L1：什么都不输出。这一点很关键 —— 不能为了「省一次点击」就替用户
// 静默放行，那等于把权限系统悄悄放宽了。
if (!needsApproval(tier)) {
  process.exit(0);
}

const ttl = Math.min(defaultTtl(tier, DEFAULT_TTL), BUDGET);
const expiresAt = Date.now() + ttl * 1000;
const title = tier === 'L3' ? '高危操作待确认' : 'Agent 请求确认';
const body = [
  toolName === 'Bash' ? String((toolInput || {}).command || '') : toolName,
  why ? `（${why}）` : '',
].join('').slice(0, 200);

// 「确认没能送到你手上」时的统一出口，定义见文件上方。
// 覆盖三条路径：网关返回非 2xx（`!ok`）、网关不可达/异常（`catch`），
// 以及「卡片建出来了但推送失败」（`json.pushOk === false`，下方单独处理，
// 它会先查一次本机一次性授权再决定）。
// 三条一律 fail-closed（默认 deny）——语义就是「没送到 = 没同意」。
// 注意「超时未确认」**不在这里** —— 那是策略默认（恒 deny），见下方注释。

try {
  // 创建即返回（wait: 0 → 202）。真正的等待在本地做，这样宿主按 hook
  // `timeout` 杀掉我们之前，一定有结论，不会再「卡死两分钟」。
  const { ok, status, json } = await post('/v1/approvals', {
    tool: toolName,
    tool_input: toolInput,
    tier,
    tier_reason: why,
    title,
    body,
    ttl,
    wait: 0,
    requester: input.session_id ? `session:${input.session_id}` : 'agent',
    session_id: input.session_id || null,
    cwd: input.cwd || null,
  }, 5000);

  if (!ok) {
    emit(makeOutput(eventName, fallbackFor(tier),
      `确认网关返回 ${status}：${json.error || '未知错误'}`));
  }

  // 卡片建出来了，但**没送到你手上**（手表 500 / 通道离线）。
  //
  // 这正是用户报的那个场景：「notify.mobile_app_* 返回 500，已按 deny 处理 ——
  // 这个处理不对，请在 WorkBuddy 弹出选项供确认」。旧的处置是一律 fallback，
  // 而 fallback 的默认值是 `ask`，在本构建的 WorkBuddy 里 `ask` = 静默放行
  // （见上方 RAW_FALLBACK 注释）。于是最危险的场景反而最宽松。
  //
  // 现在分两步，把「静默放行」换成一个**显式的、留痕的**确认：
  //   ① 先查「本机一次性授权」——那是你刚在 AskUserQuestion 弹框里点了
  //      「允许这一次」之后、由 `approval confirm` 落下的，绑定到同一条命令；
  //      命中即放行（且只能命中一次）。
  //   ② 没命中就**拦住**，并把这条写进 data/blocked-last.json，
  //      让 Agent（以及你）知道「刚才那条命令在等一个确认」，
  //      而不是收到一条含混的 reason 后无从下手。
  if (json.pushOk === false && json.verdict !== 'allow') {
    // ⚠️ 用 grantBinding（只绑动作），**不要**用 json.binding / actionBinding。
    // 后者把整个 tool_input 算进去，而 WorkBuddy 给 Bash 的 input 里带 description
    // —— Agent 重试时改一句描述就会让绑定变掉，授权永远命中不了。详见 local-grant.mjs。
    const binding = grantBinding(toolName, toolInput);

    const granted = consumeGrant(DATA_DIR, { secret: SECRET, binding });
    if (granted.ok) {
      progress(`✅ 推送失败，但命中本机一次性授权（by=${granted.record.by}），放行这一次。`);
      // 先留痕再放行：这条路径绕过了推送，审计是它唯一的对外可见性。
      await reportAudit({
        event: 'local_confirm_used', tool: toolName, tier, binding,
        by: granted.record.by, summary: body,
      });
      // 这条 approval 从未被任何人决策（推送没出去），先撤销再放行 —
      // 否则它会一直挂在 pending 里，直到 TTL 到期被 sweeper 记成「超时」。
      await abandonGatewayRecord(json.id, 'push-failed');
      emit(makeOutput(eventName, 'allow',
        `推送失败（${json.pushDetail || '未知原因'}），但已由本机确认放行这一次：${body}`));
    }

    // 授权存在但无效（签名不对 / 过期）——这不是日常路径，值得单独留一条，
    // 因为它是「有人动了 local-grants.json」的唯一信号。
    if (granted.reason === 'bad-sig' || granted.reason === 'expired') {
      await reportAudit({
        event: 'local_confirm_rejected', tool: toolName, tier, binding,
        by: 'hook', summary: `${granted.reason}：${body}`,
      });
    }

    progress(`⛔ 推送失败且无本机授权（${granted.reason}），按 deny 拦住。`);
    await abandonGatewayRecord(json.id, 'push-failed');
    rememberBlocked(DATA_DIR, {
      binding,
      tool: toolName,
      tier,
      summary: body,
      reason: `推送到手表失败：${json.pushDetail || '未知原因'}`,
      approvalId: json.id || null,
      gatewayBinding: json.binding || null, // 只作交叉引用，不参与匹配
    });
    emit(makeOutput(eventName, 'deny',
      `推送到手表失败（${json.pushDetail || '未知原因'}），已拦住而不是放行：${body}`
      + `\n要放行这一次，请让 Agent 用 AskUserQuestion 问你一句；你选「允许这一次」后`
      + `它会执行 approval confirm --yes（绑定 ${shortBinding(binding)}）`
      + `并重试**逐字节相同**的那条命令。`));
  }

  // 命中「本会话内允许」时网关已直接结算，202 里就带着 verdict，不用再等。
  if (json.status !== 'pending') {
    if (json.verdict === 'allow') {
      emit(makeOutput(eventName, 'allow', `已通过「本会话内允许」直接放行：${body}`));
    }
    emit(makeOutput(eventName, 'deny', `已拒绝（${json.optionId || '未知'}）：${body}`));
  }

  // 事件驱动等待 + stderr 心跳（绝不写 stdout，见 progress 注释）。
  beatTimer = setInterval(() => {
    progress(`等待确认中…（剩余 ${Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))}s）`);
  }, 10000);

  const final = await pollUntilDecided(json.id, expiresAt, BUDGET);
  if (beatTimer) { clearInterval(beatTimer); beatTimer = null; }

  if (!final) {
    // BUDGET 先到（网关的 TTL 比本地预算长）、或网关失联 —— 两种情况下
    // 网关侧都可能还挂着 pending，主动撤销掉。
    await abandonGatewayRecord(json.id, 'hook-abandoned');
    // 兜底超时（比网关 expiresAt 更晚才发生 = 网关卡死/失联）。
    // 与「网关判定过期」一样：没答 = 没同意，恒 deny，不走 FALLBACK。
    emit(makeOutput(eventName, 'deny', `${ttl}s 内未收到确认，按默认拒绝：${body}`));
  }

  if (final.status === 'expired' || final.status === 'cancelled') {
    emit(makeOutput(eventName, 'deny', `${ttl}s 内未收到确认，按默认拒绝：${body}`));
  }
  if (final.verdict === 'allow') {
    emit(makeOutput(eventName, 'allow', `已通过手机/手表确认：${describe(final)}`));
  }
  emit(makeOutput(eventName, 'deny', `已拒绝（${describe(final)}）：${body}`));
} catch (e) {
  const unreachable = e.name === 'AbortError' || /fetch failed|ECONNREFUSED/i.test(String(e.message));
  const reason = unreachable
    ? `确认网关不可达（${GATEWAY}）`
    : `确认流程异常：${e.message}`;
  emit(makeOutput(eventName, fallbackFor(tier), reason));
}
