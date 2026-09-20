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
// ⚠️ 这一节在 2026-09-19 被**反向**改写过，原因值得记下来：
// 原先断言「L2 → ask（回桌面弹窗，不耽误干活）」，而 SETUP.md 还建议
// 头一周把 APPROVAL_FALLBACK_L3 也设成 ask。活体实测才发现：
// **本构建的 WorkBuddy 不实现 ask** —— HookExecutor.parseHookOutput() 里
// `allowed` 初值就是 `exitCode === 0`（true），只有 deny/allow 两个分支，
// ask 直接落到初值 = 静默放行。于是「降级 ask」的真实效果是**把命令放过去**，
// 而且比 allow 更不显眼。这就是用户看到的「推送失败…已按 deny 处理」背后的病灶。
// 现在：fallback 默认 deny；显式配 ask 也会被降级成 deny 并在 stderr 警告。
{
  console.log('\n[4] 网关返回非 2xx（fallback 必须 fail-closed）');
  mode = 'http500';
  const l2 = await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin x' } });
  check('L2 → deny（回归：曾经是 ask，而 ask 在这个构建里 = 放行）',
    decisionOf(l2) === 'deny', `实际 ${decisionOf(l2)} — ${l2.out}`);
  check('原因里带状态码与上游 error', /500/.test(l2.json?.hookSpecificOutput?.permissionDecisionReason || ''));

  const l3 = await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } });
  check('L3 → 默认 fail-closed，deny', decisionOf(l3) === 'deny', l3.out);

  const l3ask = await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } },
    { APPROVAL_FALLBACK_L3: 'ask' });
  check('L3 → 显式配成 ask 时**仍然 deny**（ask 在这个构建里等于放行，不能采用）',
    decisionOf(l3ask) === 'deny', `实际 ${decisionOf(l3ask)} — ${l3ask.out}`);
  check('并且在 stderr 说清为什么把 ask 降级了',
    /不实现 ask/.test(l3ask.err), l3ask.err || '(stderr 为空)');

  // 反向锚点：allow 仍然是有效的显式选择 —— 否则 fallbackFor 就是「恒 deny」，
  // 上面那几条「因为它没生效」的失败会变得不可分辨。
  const l2allow = await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin x' } },
    { APPROVAL_FALLBACK_L2: 'allow' });
  check('L2 → 显式配成 allow 时确实放行（证明这个旋钮还活着，不是恒 deny）',
    decisionOf(l2allow) === 'allow', `实际 ${decisionOf(l2allow)} — ${l2allow.out}`);
}

// ── 5. 网关不可达（fail-closed 的核心场景）──────────────────
// 与上一节同一次修正：L2 原本断言 ask（= 放行），现在恒 deny。
// 理由一样 —— 「确认没送到」必须是 fail-closed，而不是「当作批准」。
{
  console.log('\n[5] 网关不可达');
  const l2 = await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin x' } },
    { APPROVAL_GATEWAY_URL: DEAD });
  check('L2 → deny（回归：曾经是 ask = 静默放行）',
    decisionOf(l2) === 'deny', `实际 ${decisionOf(l2)} — ${l2.out}`);
  check('原因写明网关地址', /不可达/.test(l2.json?.hookSpecificOutput?.permissionDecisionReason || ''),
    l2.json?.hookSpecificOutput?.permissionDecisionReason);

  const l3 = await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'sudo rm -f /etc/hosts' } },
    { APPROVAL_GATEWAY_URL: DEAD });
  check('L3 → deny（不可逆操作绝不在无人确认时跑掉）', decisionOf(l3) === 'deny', l3.out);

  const l3ask = await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'sudo rm -f /etc/hosts' } },
    { APPROVAL_GATEWAY_URL: DEAD, APPROVAL_FALLBACK_L3: 'ask' });
  check('L3 → 显式 ask 仍然 deny，并且 stderr 说明原因',
    decisionOf(l3ask) === 'deny' && /不实现 ask/.test(l3ask.err),
    `实际 ${decisionOf(l3ask)}｜err=${l3ask.err || '(空)'}`);
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
// 请在 workbuddy 弹出选项供确认」。这一节就是那个诉求的回归测试。
//
// 为什么不是「hook 输出 ask 让宿主弹框」：本构建的 WorkBuddy 不实现 ask，
// 输出 ask = 静默放行（见 §4/§5 的注释）。真正的弹框只能由 Agent 调
// AskUserQuestion 来弹，本机一次性授权就是那次「允许这一次」的落点。
{
  console.log('\n[9] 推送失败 → 拦住 → 本机确认 → 放行一次');
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-pushfail-'));
  // 真实环境里 data/secret 由网关首次启动生成；approval confirm 靠它做 HMAC 签名，
  // 所以临时目录里也得有一份，否则测到的是「缺密钥时报错」而不是签发流程。
  fs.writeFileSync(path.join(DATA, 'secret'), 'f'.repeat(64));
  const env = { APPROVAL_DATA_DIR: DATA };
  const CMD = 'git push origin x';
  // 用 grantBinding（只绑动作），与 hook 内部一致。
  // mock 网关回的那个 binding 是 actionBinding（覆盖整个 input）——两者**故意不同**，
  // 见 local-grant.mjs 里 grantBinding 的注释：信封变了不该让授权失效。
  const BIND = grantBinding('Bash', { command: CMD });
  const blockedFile = path.join(DATA, 'blocked-last.json');

  mode = 'pushfail';

  // ① 没有授权 → 必须拦住，而不是「当作批准」
  const first = await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: CMD } }, env);
  check('无授权时 → deny（旧行为是 ask，而 ask 在这个构建里等于放行）',
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

server.close();

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}: ${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(fail ? 1 : 0);
