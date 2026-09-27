#!/usr/bin/env node
// `bin/approve-hook.mjs` 的端到端测试：**真起子进程**，喂真实的 hook stdin JSON，
// 校验它吐给 WorkBuddy 的 stdout 协议。
//
// 存在的理由：这个脚本是整条链路上唯一「WorkBuddy 直接执行」的东西，
// 而它此前**一个测试都没有**。结果是 `APPROVAL_FALLBACK_L3` 这个开关
// 在它唯一该生效的三条路径（网关非 2xx / 未确认超时 / 网关不可达）里
// 全被硬编码的 'deny' 绕过了 —— 文档还建议用户「头一周设成 ask」。
// 调一个不存在的旋钮，而且没有任何断言会红。
//
// 这里不碰真网关、不碰真手机：起一个本地 mock 当上游。
//
//   node test/hook.test.mjs

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { actionBinding } from '../src/core/bind.mjs';
import { grantBinding, shortBinding } from '../src/core/local-grant.mjs';
// 档位是这一整套断言的**输入**（默认策略按档位分叉），所以测试里直接复用
// 真实的分类器去钉住命令的档位，而不是靠注释里手写的「这是 L2」。
import { classify } from '../src/core/risk.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, '..', 'bin', 'approve-hook.mjs');
const CONFIRM = path.join(HERE, '..', 'bin', 'approval-confirm.mjs');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

// ── mock 上游网关 ─────────────────────────────────────────────
// mode: allow / deny / expired / http500 / pushfail
// 协议（对齐真实网关）：
//   POST /v1/approvals（wait:0）→ 202 { id, status:'pending', binding, pushOk, pushDetail }
//   GET  /v1/approvals/:id      → 最终 { status:'decided'/'expired', verdict, optionId, … }
// hook 现在是「fire-and-poll」：先发创建，再轮询 GET。
//
// `pushfail` 是本次新增的模式：模拟「卡片建出来了、但 notify.mobile_app_* 返回 500」
// —— 即用户报的那个场景。此时 POST 回 202 带 pushOk:false，hook 必须**不**去等决策。
let mode = 'allow';
let lastBody = null;
let hits = 0;
let nextId = 0;
/** 收到的 /v1/audit 补录（本机确认那条路的留痕），供 §9 断言。 */
const auditPosts = [];

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && /^\/v1\/approvals\//.test(req.url)) {
    res.setHeader('content-type', 'application/json');
    const verdict = mode === 'allow' ? 'allow' : 'deny';
    return res.end(JSON.stringify({
      id: req.url.slice('/v1/approvals/'.length),
      status: mode === 'expired' ? 'expired' : 'decided',
      verdict: mode === 'expired' ? null : verdict,
      optionId: mode === 'expired' ? 'deny' : (verdict === 'allow' ? 'approve' : 'deny'),
      tier: 'L2', latencyMs: 900, deviceName: null,
      decidedBy: mode === 'expired' ? 'timeout' : 'mock',
    }));
  }
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    hits++;
    let body = null;
    try { body = JSON.parse(raw); } catch { body = null; }

    // 留痕端点：hook / approval confirm 在「本机确认放行」时会往这里补一条审计。
    // 单独收口，免得把 lastBody（给 §3 断言用）搅乱。
    if (req.url === '/v1/audit') {
      if (body) auditPosts.push(body);
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ ok: true }));
    }

    lastBody = body;
    if (mode === 'http500') {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ error: 'mock 上游故障' }));
    }
    res.setHeader('content-type', 'application/json');
    // binding 用与真实网关**同一个函数**算，这样这里测的就是真实形状；
    // 顺手让「hook 用网关给的 binding」这条路径有真数据可断言。
    return res.end(JSON.stringify({
      id: 'hooktest' + (++nextId), status: 'pending',
      tier: lastBody?.tier,
      binding: actionBinding(lastBody?.tool, lastBody?.tool_input),
      pushOk: mode !== 'pushfail',
      pushDetail: mode === 'pushfail' ? 'mock: notify.mobile_app_your_iphone 返回 500' : 'mock',
    }));
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const GW = `http://127.0.0.1:${PORT}`;
// 一个必然没人监听的端口，用来测「网关不可达」
const DEAD = 'http://127.0.0.1:1';

/** 跑一次 hook，返回 { code, out, json } */
function runHook(inputJson, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      env: { ...process.env, APPROVAL_GATEWAY_URL: GW, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => {
      let json = null;
      try { json = JSON.parse(out.trim()); } catch { /* 允许空输出 */ }
      resolve({ code, out: out.trim(), err: err.trim(), json });
    });
    child.stdin.end(typeof inputJson === 'string' ? inputJson : JSON.stringify(inputJson));
  });
}

const decisionOf = (r) => r.json?.hookSpecificOutput?.permissionDecision ?? null;
const reasonOf = (r) => r.json?.hookSpecificOutput?.permissionDecisionReason || '';

/**
 * 跑一次 `approval confirm` CLI。
 * dataDir 通过 APPROVAL_DATA_DIR 指到临时目录 —— 这是 §9 的前提：
 * 测试**绝不能**往真实 data/ 里写 blocked-last.json / local-grants.json。
 * stdin 是管道（不是 TTY），所以不带 --yes 时它会拒绝签发 —— 这本身也要断言。
 */
function runConfirm(args, dataDir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CONFIRM, ...args], {
      env: { ...process.env, APPROVAL_DATA_DIR: dataDir, APPROVAL_GATEWAY_URL: GW },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => {
      let json = null;
      try { json = JSON.parse(out.trim()); } catch { /* 非 --json 时是给人看的文本 */ }
      resolve({ code, out: out.trim(), err: err.trim(), json });
    });
    child.stdin.end();
  });
}

console.log('\napprove-hook.mjs — 输出协议与降级行为\n');

// ── 1. L0 / L1：必须什么都不输出 ─────────────────────────────
{
  console.log('[1] L0 / L1 不介入');
  const r0 = await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/tmp/x' } });
  check('L0（Read）输出为空', r0.out === '', `实际: ${JSON.stringify(r0.out)}`);
  check('L0（Read）exit 0', r0.code === 0, `实际 ${r0.code}`);

  const r1 = await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/tmp/x' } });
  check('L1（Edit）输出为空 —— 不静默提权，也不多付一次进程开销',
    r1.out === '', `实际: ${JSON.stringify(r1.out)}`);

  const before = hits;
  await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'x' } });
  check('L0 不会去打网关', hits === before, `网关被调用了 ${hits - before} 次`);
}

// ── 2. 输入异常：静默放行，交回原生权限流程 ─────────────────
{
  console.log('\n[2] 异常输入保持沉默');
  const r = await runHook('这不是 JSON');
  check('非 JSON 输入 → 空输出 + exit 0', r.out === '' && r.code === 0, `out=${JSON.stringify(r.out)} code=${r.code}`);
  const r2 = await runHook('');
  check('空 stdin → 空输出 + exit 0', r2.out === '' && r2.code === 0);
}

// ── 3. 正常往返 ──────────────────────────────────────────────
{
  console.log('\n[3] 正常往返');
  mode = 'allow';
  const r = await runHook({
    hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command: 'git push origin feature' }, session_id: 'sess-a',
  });
  check('批准 → permissionDecision=allow', decisionOf(r) === 'allow', r.out);
  check('事件名回填 PreToolUse', r.json?.hookSpecificOutput?.hookEventName === 'PreToolUse');
  check('原因里带上耗时/档位', /L2\s+approve/.test(r.json?.hookSpecificOutput?.permissionDecisionReason || ''),
    r.json?.hookSpecificOutput?.permissionDecisionReason);
  check('上报了 session_id', lastBody?.session_id === 'sess-a', JSON.stringify(lastBody?.session_id));
  check('上报了 tier=L2', lastBody?.tier === 'L2', String(lastBody?.tier));
  check('wait=0（创建即返回，本地轮询等待）', lastBody?.wait === 0,
    `wait=${lastBody?.wait} ttl=${lastBody?.ttl}`);

  mode = 'deny';
  const r2 = await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin feature' } });
  check('拒绝 → permissionDecision=deny', decisionOf(r2) === 'deny', r2.out);
}

// ── 4. 网关返回非 2xx ────────────────────────────────────────
// ⚠️ 这一节被**反向**改写过两次，两次都值得留下来当教训：
//
// 第一次（2026-09-19）：把默认从 `L2: ask` 改成 `deny`。依据是
// HookExecutor.parseHookOutput() 里 `allowed` 初值就是 `exitCode === 0`（true）、
// 只有 deny/allow 两个分支，于是推断「ask = 静默放行」。
//
// 第二次（2026-09-20）：反读宿主实现后发现上面那个推断**只对 hook 层成立** ——
// `ask` 会被 hasForcedAskDecision() 读到，使 canAutoApproveInBypassMode() /
// canUseCachedApproval() 返回 false，也就是「禁止自动放行、交回宿主常规权限流程」。
// 用户实测在那个流程里**确实会弹框**。于是又把默认改成了 `L2: ask`。
//
// 第三次（本节现状，也是最终结论）：**两边都是过度概括。**
// `ask` 自己不改 `allowed`（所以它自己不拦），它只禁止自动放行；
// 是否真的变成一个框，取决于**宿主原本会不会问你**：
//   · 需要审批的场景（bypass 模式 / 有缓存批准 / 工具要批准）→ 会弹框；
//   · 沙箱快速路径（`skipping 8-Phase permission check`）→ 宿主本来就不问人，
//     ask 变不出框，命令照跑。
//
// 所以默认值回到 **deny**，理由不是「ask 没用」，而是
// **deny 的行为不依赖权限模式**。而「降级也要用原本的方式询问」这件事，
// 由 reason 里的 `[approval: action_required=ask_user]` 标记承担 ——
// 交给 Agent 调 AskUserQuestion，那才是宿主原生、且不受模式影响的询问入口。
{
  console.log('\n[4] 网关返回非 2xx（统一走降级策略）');
  mode = 'http500';
  const l2 = await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin x' } });
  check('L2 → deny（默认；行为不依赖权限模式）',
    decisionOf(l2) === 'deny', `实际 ${decisionOf(l2)} — ${l2.out}`);
  check('原因里带状态码与上游 error',
    /500/.test(reasonOf(l2)), reasonOf(l2).slice(0, 160));
  check('★ reason 第一行是 ask_user 标记（Agent 的循环靠这一行 grep）',
    reasonOf(l2).split('\n')[0] === '[approval: action_required=ask_user]',
    `第一行：${reasonOf(l2).split('\n')[0]}`);
  check('★ 并给出「用原本的方式询问」的可执行下一步（AskUserQuestion + confirm + 重试）',
    /AskUserQuestion/.test(reasonOf(l2)) && /approval confirm --yes/.test(reasonOf(l2))
      && /重试/.test(reasonOf(l2)),
    reasonOf(l2).slice(0, 300));

  const l3 = await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } });
  check('L3 → deny（不可逆操作绝不在无人确认时跑掉）', decisionOf(l3) === 'deny', l3.out);
  check('L3 也拿到同一套下一步（不是一句干拒）',
    /AskUserQuestion/.test(reasonOf(l3)), reasonOf(l3).slice(0, 200));

  // 显式设 ask 时应该真的是 ask —— 这个旋钮必须活着，否则「设了不生效」
  // 就是 SETUP.md 记过的那个老毛病（FALLBACK 曾被硬编码绕过）。
  const l3ask = await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } },
    { APPROVAL_FALLBACK_L3: 'ask' });
  check('显式 APPROVAL_FALLBACK_L3=ask → 真的透出 ask（旋钮活着）',
    decisionOf(l3ask) === 'ask', `实际 ${decisionOf(l3ask)} — ${l3ask.out}`);
  check('★ 并且 stderr 提醒「ask 的效果取决于权限模式」（不硬拒，但要说清）',
    /取决于权限模式/.test(l3ask.err), l3ask.err || '(stderr 为空)');

  // 反向锚点：allow 仍然是有效的显式选择 —— 否则 fallbackFor 就是「恒 deny」，
  // 上面那几条「因为它没生效」的失败会变得不可分辨。
  const l2allow = await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin x' } },
    { APPROVAL_FALLBACK_L2: 'allow' });
  check('显式 APPROVAL_FALLBACK_L2=allow 时确实放行（证明这个旋钮还活着，不是恒 deny）',
    decisionOf(l2allow) === 'allow', `实际 ${decisionOf(l2allow)} — ${l2allow.out}`);

  // 非法值必须回落，而且回落方向是**安全的那一侧**：deny。
  const l2bad = await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin x' } },
    { APPROVAL_FALLBACK_L2: 'yolo' });
  check('非法值回落 deny（回落方向取安全侧，不是 ask）',
    decisionOf(l2bad) === 'deny', `实际 ${decisionOf(l2bad)} — ${l2bad.out}`);
  check('并且 stderr 说清是哪个变量、哪个值不合法',
    /APPROVAL_FALLBACK_L2=yolo/.test(l2bad.err), l2bad.err || '(stderr 为空)');
}

// ── 5. 网关不可达（fail-closed 的核心场景）──────────────────
// 这一节盯的是「三条降级路径共用同一套处置」。它们此前各写各的：
// 「网关不可达」只丢一句原因，「推送失败」才有标记与下一步 —— 于是同一个
// 原因会有两种表现，用户看到的「只有提醒，不能确认」就出在这。
// 现在三条统一走 degradePolicyFor + degradeReasonLines。
{
  console.log('\n[5] 网关不可达');
  const l2 = await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin x' } },
    { APPROVAL_GATEWAY_URL: DEAD });
  check('L2 → deny（不可达绝不等于同意）',
    decisionOf(l2) === 'deny', `实际 ${decisionOf(l2)} — ${l2.out}`);
  check('原因写明网关地址（能看出是哪台网关断了）',
    /不可达/.test(reasonOf(l2)) && new RegExp(DEAD.replace(/[/:.]/g, '\\$&')).test(reasonOf(l2)),
    reasonOf(l2).slice(0, 200));
  check('★ 同样带 ask_user 标记（与 §4 的网关非 2xx 表现一致，不再两副面孔）',
    reasonOf(l2).split('\n')[0] === '[approval: action_required=ask_user]',
    `第一行：${reasonOf(l2).split('\n')[0]}`);
  check('★ 同样给出 AskUserQuestion 那条下一步',
    /AskUserQuestion/.test(reasonOf(l2)), reasonOf(l2).slice(0, 260));

  const l3 = await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'sudo rm -f /etc/hosts' } },
    { APPROVAL_GATEWAY_URL: DEAD });
  check('L3 → deny（不可逆操作绝不在无人确认时跑掉）', decisionOf(l3) === 'deny', l3.out);

  // 显式把旋钮关掉的人应该拿到「纯 deny」—— 不带标记、不给下一步。
  const l2plain = await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin x' } },
    { APPROVAL_GATEWAY_URL: DEAD, APPROVAL_PUSH_FAIL_POLICY: 'deny' });
  check('policy=deny → 纯 deny，不带 ask_user 标记（显式选择被尊重）',
    decisionOf(l2plain) === 'deny' && !/action_required=ask_user/.test(reasonOf(l2plain)),
    reasonOf(l2plain).slice(0, 200));
}

// ── 6. 卡片推出去了但没点 ───────────────────────────────────
// 这一节盯的是「策略默认」与「降级」的分界线：
// 超时 = 你看到了但没答 → 「没答就是没同意」，恒 deny，
// 而且**不接受** APPROVAL_FALLBACK_L2/L3 把它变成 ask。
// （写这一节时我一开始让超时也走 FALLBACK，被 selftest 里
//   「网关可拒绝时 hook 返回 deny」那条断言拦下来了 —— 那条正是这个语义。）
{
  console.log('\n[6] 超时未确认（卡片已到手表，你没答）');
  mode = 'expired';
  const l2 = await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin x' } });
  check('L2 → deny', decisionOf(l2) === 'deny', l2.out);
  const l3 = await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git reset --hard HEAD~5' } });
  check('L3 → deny', decisionOf(l3) === 'deny', l3.out);
  check('原因写明是超时不是拒绝', /未收到确认/.test(l3.json?.hookSpecificOutput?.permissionDecisionReason || ''),
    l3.json?.hookSpecificOutput?.permissionDecisionReason);

  const l2ask = await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin x' } },
    { APPROVAL_FALLBACK_L2: 'ask' });
  check('L2 → 超时**不**受 APPROVAL_FALLBACK_L2 影响，仍为 deny',
    decisionOf(l2ask) === 'deny', `实际 ${decisionOf(l2ask)}`);

  const l3ask = await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git reset --hard HEAD~5' } },
    { APPROVAL_FALLBACK_L3: 'ask' });
  check('L3 → 超时**不**受 APPROVAL_FALLBACK_L3 影响，仍为 deny',
    decisionOf(l3ask) === 'deny', `实际 ${decisionOf(l3ask)}`);
}

// ── 7. TTL / BUDGET 可调 ─────────────────────────────────────
{
  console.log('\n[7] TTL / BUDGET 可调');
  mode = 'allow';
  await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin x' } },
    { APPROVAL_TTL_L2: '42' });
  check('APPROVAL_TTL_L2 生效（未超 BUDGET 时）', lastBody?.ttl === 42, `实际 ${lastBody?.ttl}`);

  // BUDGET 是硬上限：把 ttl 调到比 BUDGET 大，实际 ttl 被压回 BUDGET。
  await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin x' } },
    { APPROVAL_TTL_L2: '300', APPROVAL_HOOK_BUDGET: '150' });
  check('ttl 被 BUDGET 封顶（300→150）', lastBody?.ttl === 150, `实际 ${lastBody?.ttl}`);

  // 不设 BUDGET，默认 150：ttl 更大时同样被压回 150。
  await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin x' } },
    { APPROVAL_TTL_L2: '900' });
  check('默认 BUDGET=150 把 ttl 900 压回 150', lastBody?.ttl === 150, `实际 ${lastBody?.ttl}`);
}

// ── 8. 轮询语义：创建是 pending，决策从 GET 来 ─────────────
{
  console.log('\n[8] 轮询语义');
  mode = 'allow';
  const r = await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin x' } });
  check('批准来自 GET（非创建响应），仍为 allow', decisionOf(r) === 'allow', r.out);
  // mock 里 GET 返回的 latencyMs=900 → 描述里应带 ~9s
  check('原因带耗时（0.9s）', /L2\s+approve\s*（0\.9s/.test(r.json?.hookSpecificOutput?.permissionDecisionReason || ''),
    r.json?.hookSpecificOutput?.permissionDecisionReason);
}

// ── 9. 推送失败 → 拦住 → 本机一次性确认 → 只放行一次 ─────────
// 用户的原话：「推送到手表失败…已按 deny 处理，这个处理不对，如果推送失败，
// 请在 workbuddy 弹出选项供确认」。这一节是那个诉求的回归测试。
//
// ⚠️ 这一节**显式把策略钉成 ask_user**（= 默认值），因为这里要测的是
// 「拦下 + 本机一次性授权」这条兜底路径的完整性：
// 拦住 → 写 blocked-last.json → reason 带 grep 标记与下一步 →
// `approval confirm --yes` 签发 → 重试放行 → 一次性消费 →
// 绑定必须一致 → 可收回。
//
// 为什么钉住而不是靠默认值：这一节的目的是「这条链路本身没坏」，
// 用显式值可以让它与 §10 的「默认值是什么」解耦 —— 默认值将来再变，
// 这里的失败应该只反映链路坏了，而不是「默认值又改了」。
{
  console.log('\n[9] 推送失败 → 拦住 → 本机确认 → 放行一次');
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-pushfail-'));
  // 真实环境里 data/secret 由网关首次启动生成；approval confirm 靠它做 HMAC 签名，
  // 所以临时目录里也得有一份，否则测到的是「缺密钥时报错」而不是签发流程。
  fs.writeFileSync(path.join(DATA, 'secret'), 'f'.repeat(64));
  const env = { APPROVAL_DATA_DIR: DATA, APPROVAL_PUSH_FAIL_POLICY: 'ask_user' };
  const CMD = 'git push origin x';
  // 用 grantBinding（只绑动作），与 hook 内部一致。
  // mock 网关回的那个 binding 是 actionBinding（覆盖整个 input）——两者**故意不同**，
  // 见 local-grant.mjs 里 grantBinding 的注释：信封变了不该让授权失效。
  const BIND = grantBinding('Bash', { command: CMD });
  const blockedFile = path.join(DATA, 'blocked-last.json');

  mode = 'pushfail';

  // ① 没有授权 → 必须拦住，而不是「当作批准」
  const first = await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: CMD } }, env);
  check('无授权时 → deny（策略钉为 deny 时的兜底语义：没送到 = 没同意）',
    decisionOf(first) === 'deny', `实际 ${decisionOf(first)} — ${first.out}`);
  check('原因说清是「推送到手表失败」', /推送到手表失败/.test(reasonOf(first)), reasonOf(first));
  check('原因里给出可执行的下一步（approval confirm）',
    /approval confirm/.test(reasonOf(first)), reasonOf(first));
  check('原因里带短 binding，方便人核对是哪条命令',
    reasonOf(first).includes(shortBinding(BIND)), reasonOf(first));
  check('把这条写进 blocked-last.json',
    fs.existsSync(blockedFile) && JSON.parse(fs.readFileSync(blockedFile, 'utf8')).binding === BIND,
    fs.existsSync(blockedFile) ? fs.readFileSync(blockedFile, 'utf8') : '(文件不存在)');

  // ② 非交互下不加 --yes → 必须拒绝签发（不许替人点头）
  const noYes = await runConfirm(['--json'], DATA);
  check('没有 --yes 且 stdin 不是终端 → 拒绝签发',
    noYes.json?.ok === false, `${noYes.out}｜${noYes.err}`);
  const stillEmpty = await runConfirm(['--list', '--json'], DATA);
  check('拒绝之后表里仍然是空的', (stillEmpty.json?.items || []).length === 0,
    JSON.stringify(stillEmpty.json));

  // ③ 正式签发（这一步等价于「你在 WorkBuddy 弹框里选了允许这一次」）
  const issued = await runConfirm(['--yes', '--json'], DATA);
  check('approval confirm --yes 签发成功', issued.json?.ok === true, `${issued.out}｜${issued.err}`);
  check('签发对象就是被拦下的那条命令', issued.json?.binding === BIND, String(issued.json?.binding));
  check('回显了短号（人核对用）', issued.json?.short === shortBinding(BIND));
  const listed = await runConfirm(['--list', '--json'], DATA);
  check('--list 能看到它', (listed.json?.items || []).length === 1);

  // ④ 重试同一条命令 → 放行
  const retry = await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: CMD } }, env);
  check('重试同一条命令 → allow', decisionOf(retry) === 'allow', `实际 ${decisionOf(retry)} — ${retry.out}`);
  check('原因说明是「本机确认」而不是手表确认',
    /本机确认/.test(reasonOf(retry)), reasonOf(retry));

  // ⑤ 只能用一次
  const third = await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: CMD } }, env);
  check('再用一次就没了（一次性消费）',
    decisionOf(third) === 'deny', `实际 ${decisionOf(third)} — ${third.out}`);

  // ⑥ 绑定必须完全一致：给 A 签的授权不能放行 B
  await runConfirm(['--yes', '--json'], DATA); // 重新给 CMD 签一张
  const other = await runHook({
    hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin y' },
  }, env);
  check('另一条命令蹭不到这张授权 → deny',
    decisionOf(other) === 'deny', `实际 ${decisionOf(other)} — ${other.out}`);

  // ⑦ 收回
  const revoked = await runConfirm(['--revoke'], DATA);
  check('--revoke 收回成功', /收回 1 张/.test(revoked.out), revoked.out);
  const afterRevoke = await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: CMD } }, env);
  check('收回之后立刻回到 deny',
    decisionOf(afterRevoke) === 'deny', `实际 ${decisionOf(afterRevoke)}`);

  // ⑧ 留痕：这条路径绕过了推送，审计是它唯一的对外可见性
  const usedEvents = auditPosts.filter((a) => a.event === 'local_confirm_used');
  const issuedEvents = auditPosts.filter((a) => a.event === 'local_confirm_issued');
  check('放行时往网关补了一条 local_confirm_used', usedEvents.length === 1, JSON.stringify(auditPosts));
  check('签发时补了 local_confirm_issued', issuedEvents.length === 2, JSON.stringify(issuedEvents.length));
  check('审计里带上了 binding 与 by', usedEvents[0]?.binding === BIND && !!usedEvents[0]?.by,
    JSON.stringify(usedEvents[0]));
  check('本地也留了痕', fs.readFileSync(path.join(DATA, 'local-confirm.log'), 'utf8').includes('consume'));

  // ⑨ 推送恢复正常后，一切回到原样（不能让本机授权变成长期后门）
  mode = 'allow';
  const healthy = await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: CMD } }, env);
  check('推送恢复后按正常链路走（allow 来自决策，不来自本机授权）',
    decisionOf(healthy) === 'allow' && !/本机确认/.test(reasonOf(healthy)), reasonOf(healthy));

  // ⑩ WorkBuddy 的 Bash tool_input 里带 `description`，而 Agent 每次重写它都不一样。
  // 这是活体实测踩到的坑：绑整个 tool_input 时，「confirm 成功但重试仍被拦」，
  // 而且 reason 里的短号看着完全正常 —— 极难归因。这一条把它钉死。
  mode = 'pushfail';
  const withDesc = (d) => ({ command: CMD, description: d });
  const firstDesc = await runHook(
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: withDesc('第一次的描述') }, env);
  check('带 description 时仍然拦住', decisionOf(firstDesc) === 'deny', `实际 ${decisionOf(firstDesc)}`);
  check('拦下的绑定仍是「只含 command」的那个（不含 description）',
    JSON.parse(fs.readFileSync(blockedFile, 'utf8')).binding === BIND,
    JSON.parse(fs.readFileSync(blockedFile, 'utf8')).binding);
  check('blocked 记录里另存了网关那个 binding 作交叉引用',
    typeof JSON.parse(fs.readFileSync(blockedFile, 'utf8')).gatewayBinding === 'string');

  await runConfirm(['--yes', '--json'], DATA);
  const retryDesc = await runHook(
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: withDesc('重试时改写的描述') }, env);
  check('**改写描述后重试仍然放行**（回归：曾经因此永远命中不了）',
    decisionOf(retryDesc) === 'allow', `实际 ${decisionOf(retryDesc)} — ${reasonOf(retryDesc)}`);
  const thirdDesc = await runHook(
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: withDesc('重试时改写的描述') }, env);
  check('改描述不能让它变成可复用（仍是一次性）', decisionOf(thirdDesc) === 'deny');
  const otherDesc = await runHook(
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin y', description: '改写的描述' } }, env);
  check('但换命令仍然不行 —— 描述宽松不等于命令宽松',
    decisionOf(otherDesc) === 'deny', `实际 ${decisionOf(otherDesc)}`);

  fs.rmSync(DATA, { recursive: true, force: true });
}

// ── 10. 推送失败时的处置策略（APPROVAL_PUSH_FAIL_POLICY）─────────────────────
//
// 这一节的存在理由：推送失败有**四条**可能的处置，而默认走哪条决定了
// 用户体感是「只有提醒」还是「能用原本的方式问一次」。
//
// 关于 `ask` 的三种说法都出现过，最终结论（完整推理见 approve-hook.mjs 的
// RAW_FALLBACK 注释）：
//   · 「ask 会弹框」——只在需要审批的场景成立；
//   · 「ask 等于放行」——只在沙箱快速路径上成立；
//   · 「ask 的作用是禁止自动放行，交回宿主常规权限流程」——这句才是准确的，
//     而**弹不弹框取决于宿主原本会不会问你**。
// 所以 `ask` 是显式可选项，但**不是默认**：默认选行为不依赖模式的那条。
//
// ⚠️ 本节第一次写成「全绿」时踩过一个坑，值得留在这里：命令原本选了
// `npm publish --access public`，而它被判成 **L3**（「发布到公共仓库，无法撤回」），
// 于是「默认 → ask」永远不可能成立 —— 失败信息长得像实现坏了，其实是
// 断言的前提错了。所以下面先用一行 `check` 把**命令的档位本身**钉住：
// 档位是这条断言的输入，输入错了，后面全是噪声。
//
// 这一节同时是「设备掉线 vs 通道 500」在 reason 里能看出来的回归。
{
  console.log('\n[10] 推送失败时的处置策略');
  auditPosts.length = 0;

  const CMD = 'git push origin feature';
  const CMD_L3 = 'npm publish --access public';

  check('前提：CMD 确实是 L2',
    classify('Bash', { command: CMD }).tier === 'L2',
    `实际 ${classify('Bash', { command: CMD }).tier} — ${classify('Bash', { command: CMD }).why}`);
  check('前提：CMD_L3 确实是 L3',
    classify('Bash', { command: CMD_L3 }).tier === 'L3',
    `实际 ${classify('Bash', { command: CMD_L3 }).tier} — ${classify('Bash', { command: CMD_L3 }).why}`);

  // 10.1 默认（不设 policy）→ deny + ask_user 标记：拦住，但把「怎么继续」交回宿主
  mode = 'pushfail';
  const def = await runHook({
    hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: CMD },
  }, { APPROVAL_LOCAL_HANDOFF: '0' });
  check('L2 默认 → deny（不赌权限模式）',
    decisionOf(def) === 'deny', `decision=${decisionOf(def)} — ${def.out.slice(0, 200)}`);
  check('★ reason 第一行是 ask_user 标记（默认就带，不需要额外配置）',
    reasonOf(def).split('\n')[0] === '[approval: action_required=ask_user]',
    `第一行：${reasonOf(def).split('\n')[0]}`);
  check('reason 说清是「推送到手表失败」而不是别的降级路径',
    /推送到手表失败/.test(reasonOf(def)), reasonOf(def).slice(0, 200));
  check('reason 带上要执行的那条命令（Agent 转述给人时要引用它）',
    reasonOf(def).includes(CMD), reasonOf(def).slice(0, 200));
  check('★ reason 给出「用原本的方式询问」的两步（AskUserQuestion → confirm → 重试）',
    /AskUserQuestion/.test(reasonOf(def)) && /approval confirm --yes/.test(reasonOf(def))
      && /重试/.test(reasonOf(def)),
    reasonOf(def).slice(0, 320));
  check('默认策略不触发转场（没开 local 就不该开浏览器）',
    !auditPosts.some((a) => a.event === 'local_handoff'),
    JSON.stringify(auditPosts.map((a) => a.event)));
  check('默认策略也不交回宿主（不发 handback_to_host）',
    !auditPosts.some((a) => a.event === 'handback_to_host'),
    JSON.stringify(auditPosts.map((a) => a.event)));

  // 10.2 L3 默认 → 同样 deny + 同一套下一步
  const l3 = await runHook({
    hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: CMD_L3 },
  }, { APPROVAL_LOCAL_HANDOFF: '0' });
  check('L3 默认 → deny',
    decisionOf(l3) === 'deny', `decision=${decisionOf(l3)} — ${l3.out.slice(0, 200)}`);
  check('L3 的 reason 也给出下一步（AskUserQuestion + confirm），不是一句干拒',
    /AskUserQuestion/.test(reasonOf(l3)) && /approval confirm/.test(reasonOf(l3)),
    reasonOf(l3).slice(0, 200));

  // 10.3 显式 policy=deny：连标记都不带，纯拦
  const pinned = await runHook({
    hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: CMD },
  }, { APPROVAL_PUSH_FAIL_POLICY: 'deny' });
  check('policy=deny 时 L2 也 deny', decisionOf(pinned) === 'deny', `decision=${decisionOf(pinned)}`);
  check('policy=deny 时不带 ask_user 标记、也不给下一步（显式选择被尊重）',
    !/action_required=ask_user/.test(reasonOf(pinned)) && !/AskUserQuestion/.test(reasonOf(pinned)),
    reasonOf(pinned).slice(0, 200));

  // 10.4 显式 policy=ask：真的透出 ask（交回宿主确认框）
  const ask = await runHook({
    hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: CMD },
  }, { APPROVAL_PUSH_FAIL_POLICY: 'ask' });
  check('policy=ask → permissionDecision=ask（显式开启时真的交回宿主）',
    decisionOf(ask) === 'ask', `actual ${decisionOf(ask)}`);
  check('policy=ask 时补了一条 handback_to_host 审计（否则这条路径对外不可见）',
    auditPosts.some((a) => a.event === 'handback_to_host'),
    JSON.stringify(auditPosts.map((a) => a.event)));
  check('policy=ask 的 reason 说清「腕上确认没送到」',
    /腕上确认没送到/.test(reasonOf(ask)), reasonOf(ask).slice(0, 160));

  // 10.5 显式 policy=ask_user 与默认等价
  auditPosts.length = 0;
  const askUser = await runHook({
    hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: CMD },
  }, { APPROVAL_PUSH_FAIL_POLICY: 'ask_user' });
  check('policy=ask_user 与默认行为一致（deny + 标记）',
    decisionOf(askUser) === 'deny'
      && reasonOf(askUser).split('\n')[0] === '[approval: action_required=ask_user]',
    `decision=${decisionOf(askUser)}｜第一行=${reasonOf(askUser).split('\n')[0]}`);

  // 10.6 policy=local 但转场被关掉 → 必须回到 deny（fail-closed 不能被绕过）
  const localOff = await runHook({
    hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: CMD },
  }, { APPROVAL_PUSH_FAIL_POLICY: 'local', APPROVAL_LOCAL_HANDOFF: '0' });
  check('policy=local 且转场关闭 → deny（不允许「转场不了就放行」）',
    decisionOf(localOff) === 'deny', `decision=${decisionOf(localOff)}`);
  check('★ 转场失败的原因写进了 reason，能查为什么没转成',
    /未能转场到本机确认/.test(reasonOf(localOff)) && /APPROVAL_LOCAL_HANDOFF/.test(reasonOf(localOff)),
    reasonOf(localOff).slice(0, 240));

  // 10.6b policy=local 但页面探不通（mock 网关只有 JSON，不是 phone.html）
  // → 同样必须 deny，而且**不许开浏览器**（先探再开的意义就在这里）。
  auditPosts.length = 0;
  const localUnreachable = await runHook({
    hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: CMD },
  }, { APPROVAL_PUSH_FAIL_POLICY: 'local' });
  check('policy=local 但审批页探不通 → deny，且不开浏览器',
    decisionOf(localUnreachable) === 'deny'
      && !auditPosts.some((a) => a.event === 'local_handoff'),
    `decision=${decisionOf(localUnreachable)}｜audit=${JSON.stringify(auditPosts.map((a) => a.event))}`);
  check('并且 reason 里说明页面为什么不可用（不是含糊的「转场失败」）',
    /未能转场到本机确认/.test(reasonOf(localUnreachable))
      && /本地审批页不可用/.test(reasonOf(localUnreachable)),
    reasonOf(localUnreachable).slice(0, 260));

  // 10.7 非法 policy 值：回落到默认（ask_user），不是硬编码 deny
  mode = 'pushfail';
  const bad = await runHook({
    hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: CMD },
  }, { APPROVAL_PUSH_FAIL_POLICY: 'something_weird', APPROVAL_LOCAL_HANDOFF: '0' });
  check('非法 policy 值回落到默认 ask_user（deny + 标记）',
    decisionOf(bad) === 'deny'
      && reasonOf(bad).split('\n')[0] === '[approval: action_required=ask_user]',
    `decision=${decisionOf(bad)}｜第一行=${reasonOf(bad).split('\n')[0]}`);

  // 10.8 policy 不影响正常 allow 路径
  mode = 'allow';
  const still = await runHook({
    hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: CMD },
  }, { APPROVAL_PUSH_FAIL_POLICY: 'ask_user' });
  check('policy 不污染正常 allow 路径',
    decisionOf(still) === 'allow' && !/action_required=ask_user/.test(reasonOf(still)),
    `decision=${decisionOf(still)}`);

  // 10.9 deviceOffline / pushFailureReason 缺失时 reason 仍可读
  mode = 'pushfail';
  const fallback = await runHook({
    hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: CMD_L3 },
  }, { APPROVAL_PUSH_FAIL_POLICY: 'ask_user' });
  check('mock 网关没给 pushFailureReason 时 reason 仍可读',
    /unknown|推送到手表失败/.test(reasonOf(fallback)),
    reasonOf(fallback).slice(0, 200));
}

server.close();

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}: ${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(fail ? 1 : 0);
