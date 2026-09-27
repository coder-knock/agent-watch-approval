#!/usr/bin/env node
// 端到端自检：不依赖任何手机端配置，把整条确认链路跑一遍。
//   node test/selftest.mjs

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify } from '../src/core/risk.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 7799;
const BASE = `http://127.0.0.1:${PORT}`;

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, body, method = 'POST') {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = {};
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json };
}

// ── 1. 风险分级 ─────────────────────────────────────────────────────────────
console.log('\n[1] 风险分级');

const cases = [
  ['Read', { file_path: '/tmp/x' }, 'L0'],
  ['Glob', { pattern: '*' }, 'L0'],
  ['Edit', { file_path: '/tmp/x' }, 'L1'],
  ['Write', { file_path: '/tmp/x' }, 'L1'],
  ['Bash', { command: 'ls -la' }, 'L0'],
  ['Bash', { command: 'git status' }, 'L0'],
  ['Bash', { command: 'git log --oneline -5' }, 'L0'],
  ['Bash', { command: 'node -v' }, 'L0'],
  ['Bash', { command: 'curl -sI https://example.com' }, 'L0'],
  ['Bash', { command: 'sed -n 1p file.txt' }, 'L0'],
  ['Bash', { command: 'git add . && git commit -m "x"' }, 'L1'],
  ['Bash', { command: 'node script.mjs' }, 'L1'],
  ['Bash', { command: 'rm -rf node_modules' }, 'L1'],
  ['Bash', { command: 'rm -rf /tmp/build-cache' }, 'L1'],
  ['Bash', { command: 'rm -rf ~/Documents' }, 'L3'],
  ['Bash', { command: 'rm -rf /' }, 'L3'],
  ['Bash', { command: 'rm -rf $HOME/important' }, 'L3'],
  ['Bash', { command: 'git push origin main' }, 'L2'],
  ['Bash', { command: 'git push --force origin main' }, 'L3'],
  ['Bash', { command: 'git push -f origin main' }, 'L3'],
  ['Bash', { command: 'git reset --hard HEAD~1' }, 'L3'],
  ['Bash', { command: 'curl -X POST https://api.example.com -d x=1' }, 'L2'],
  ['Bash', { command: 'gh pr create --title x' }, 'L2'],
  ['Bash', { command: 'sudo rm /etc/hosts' }, 'L3'],
  ['Bash', { command: 'npm publish' }, 'L3'],
  ['Bash', { command: 'some-unknown-tool --go' }, 'L2'],
  ['mcp__agent-mail__SendMessage', { to: 'a@b.c' }, 'L2'],
  ['mcp__fff__grep', { pattern: 'x' }, 'L1'],
];

for (const [tool, input, expected] of cases) {
  const got = classify(tool, input, {}).tier;
  const label = `${tool} ${tool === 'Bash' ? JSON.stringify(input.command) : ''} → ${expected}`;
  check(label, got === expected, got === expected ? '' : `实际 ${got}`);
}

// ── 2. 启动网关 ─────────────────────────────────────────────────────────────
console.log('\n[2] 启动网关（mock 通道）');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apr-selftest-'));
const cfgPath = path.join(tmp, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify({
  port: PORT,
  host: '127.0.0.1',
  dataDir: path.join(tmp, 'data'),
  channel: 'mock',
  defaults: {
    ttlSeconds: { L2: 20, L3: 12 },
    defaultOptionId: 'deny',
    unknownToolTier: 'L1',
    unmatchedBashTier: 'L2',
  },
  channels: { mock: {} },
  risk: {},
}, null, 2));

const gw = spawn(process.execPath, [path.join(ROOT, 'src/gateway.mjs'), '--config', cfgPath], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let gwOut = '';
gw.stdout.on('data', (d) => { gwOut += d; });
gw.stderr.on('data', (d) => { gwOut += d; });

let healthy = false;
for (let i = 0; i < 40; i++) {
  await sleep(250);
  try {
    const r = await fetch(BASE + '/healthz');
    if (r.ok) { healthy = true; break; }
  } catch { /* 还没起来 */ }
}
check('网关可访问 /healthz', healthy, healthy ? '' : gwOut.slice(-500));
if (!healthy) {
  gw.kill();
  console.log('\n网关未能启动，后续用例跳过。');
  process.exit(1);
}

// ── 3. 确认与回程 ───────────────────────────────────────────────────────────
console.log('\n[3] 确认签发与回程校验');

const created = await api('/v1/approvals', {
  tool: 'Bash',
  tool_input: { command: 'git push origin main' },
  ttl: 30,
});
check('L2 确认创建成功', created.status === 202, `status ${created.status}`);
check('分级为 L2', created.json.tier === 'L2', created.json.tier);
check('推送成功（mock）', created.json.pushOk === true, JSON.stringify(created.json));
check('返回了绑定哈希', String(created.json.binding || '').startsWith('sha256:'), created.json.binding);

const pending = await api('/v1/approvals?status=pending', undefined, 'GET');
const item = (pending.json.items || []).find((i) => i.id === created.json.id);
check('出现在待确认列表', !!item);
check('选项数不超过 3（手表能放下）', item && item.options.length <= 3, item && String(item.options.length));

const denyOpt = item.options.find((o) => o.id === 'deny');
const approveOpt = item.options.find((o) => o.id === 'approve');
check('拒绝选项排在第一位（双击即否决）', item.options[0].id === 'deny', item.options.map((o) => o.id).join(','));

const r1 = await api('/v1/decision', { action: denyOpt.actionId, channel: 'selftest' });
check('拒绝决策被接受', r1.status === 200 && r1.json.verdict === 'deny', JSON.stringify(r1.json));

const r2 = await api('/v1/decision', { action: denyOpt.actionId, channel: 'selftest' });
check('同一令牌重放被拦截', r2.status === 409, `status ${r2.status}`);

const tampered = approveOpt.actionId.slice(0, -1) + (approveOpt.actionId.endsWith('a') ? 'b' : 'a');
const r3 = await api('/v1/decision', { action: tampered, channel: 'selftest' });
check('签名被篡改时拒绝（403）', r3.status === 403, `status ${r3.status}`);

const r4 = await api('/v1/decision', { action: 'APR:bogus:approve:deadbeef:0000000000000000', channel: 'selftest' });
check('伪造 approval id 被拦截', r4.status === 403 || r4.status === 404, `status ${r4.status}`);

// 详情型选项不应结算（只有 L3 会带这个选项）
const c2 = await api('/v1/approvals', { tool: 'Bash', tool_input: { command: 'git push --force origin dev' }, ttl: 30 });
const p2 = (await api('/v1/approvals?status=pending', undefined, 'GET')).json.items.find((i) => i.id === c2.json.id);
const detailOpt = p2.options.find((o) => o.id === 'detail');
check('L3 带「查看详情」选项', !!detailOpt, p2.options.map((o) => o.id).join(','));
if (detailOpt) {
  const rd = await api('/v1/decision', { action: detailOpt.actionId, channel: 'selftest' });
  const stillPending = (await api('/v1/approvals?status=pending', undefined, 'GET')).json.items.some((i) => i.id === c2.json.id);
  check('「查看详情」不结算请求', rd.status === 200 && stillPending, `status ${rd.status} pending=${stillPending}`);
}
await api('/v1/decision', {
  action: (await api('/v1/approvals?status=pending', undefined, 'GET')).json.items
    .find((i) => i.id === c2.json.id).options.find((o) => o.id === 'deny').actionId,
  channel: 'selftest',
});

// ── 4. 超时默认拒绝 ─────────────────────────────────────────────────────────
console.log('\n[4] 超时与兜底');

const c3 = await api('/v1/approvals', { tool: 'Bash', tool_input: { command: 'git push origin hotfix' }, ttl: 6 });
const t0 = Date.now();
const waitRes = await api('/v1/approvals', {
  tool: 'Bash', tool_input: { command: 'git push origin slow' }, ttl: 6, wait: 6,
});
const elapsed = Date.now() - t0;
check('阻塞等待按超时返回', elapsed > 4000 && elapsed < 12000, `${elapsed}ms`);
check('超时后状态为 expired', waitRes.json.status === 'expired', waitRes.json.status);
check('超时后判定为拒绝', waitRes.json.verdict === 'deny', waitRes.json.verdict);

await sleep(7000);
const c3state = await api(`/v1/approvals/${c3.json.id}`, undefined, 'GET');
check('后台过期的记录最终结算为拒绝', c3state.json.verdict === 'deny', JSON.stringify(c3state.json));

// ── 5. L3 策略与绑定校验 ────────────────────────────────────────────────────
console.log('\n[5] L3 策略与动作绑定');

const c4 = await api('/v1/approvals', {
  tool: 'Bash', tool_input: { command: 'git push --force origin main' }, ttl: 20,
});
check('force push 判为 L3', c4.json.tier === 'L3', c4.json.tier);
const p4 = (await api('/v1/approvals?status=pending', undefined, 'GET')).json.items.find((i) => i.id === c4.json.id);
check('L3 不提供「本会话内允许」', !p4.options.some((o) => o.id === 'approve_session'), p4.options.map((o) => o.id).join(','));

const vr1 = await api('/v1/verify', { id: c4.json.id, tool: 'Bash', tool_input: { command: 'git push --force origin main' } });
check('绑定校验：同动作一致', vr1.json.bindingMatch === true);
const vr2 = await api('/v1/verify', { id: c4.json.id, tool: 'Bash', tool_input: { command: 'git push --force origin evil' } });
check('绑定校验：换动作即不匹配', vr2.json.bindingMatch === false);
check('未获批时 verify 不通过', vr2.json.ok === false);

// ── 6. hook 行为 ────────────────────────────────────────────────────────────
console.log('\n[6] hook 端到端');

function runHook(payload, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'bin/approve-hook.mjs')], {
      env: { ...process.env, ...env },
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
    p.stdin.end(JSON.stringify(payload));
  });
}

const h0 = await runHook({
  hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/tmp/x' }, session_id: 'st-l0',
}, { APPROVAL_GATEWAY_URL: BASE });
check('L0 不输出任何决策（不静默提权）', h0.out.trim() === '' && h0.code === 0, `out=${h0.out.slice(0, 120)}`);

const h1 = await runHook({
  hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf ~/Documents' }, session_id: 'st-l3',
}, { APPROVAL_GATEWAY_URL: 'http://127.0.0.1:1' });
let h1json = {};
try { h1json = JSON.parse(h1.out); } catch { /* ignore */ }
check('网关不可达时 L3 fail-closed 为 deny',
  h1json?.hookSpecificOutput?.permissionDecision === 'deny', h1.out.slice(0, 200));

const h2 = await runHook({
  hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin feature' }, session_id: 'st-l2-deny',
}, { APPROVAL_GATEWAY_URL: BASE, APPROVAL_TTL_L2: '6' });
let h2json = {};
try { h2json = JSON.parse(h2.out); } catch { /* ignore */ }
// 注意：这条实际测的是**超时未确认**（没人点，ttl 6s 到点），不是「用户点了拒绝」。
// 超时恒 deny 是策略默认，不跟 APPROVAL_FALLBACK_L2 走 —— 见 bin/approve-hook.mjs 里的注释。
check('超时未确认时 hook 返回 deny（策略默认，不受 FALLBACK 影响）',
  h2json?.hookSpecificOutput?.permissionDecision === 'deny', h2.out.slice(0, 200));

// 批准路径：起一个 hook，等它把确认推出来，再从「手机」点批准
const hookPromise = runHook({
  hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'gh pr create --title selftest' }, session_id: 'st-l2-allow',
}, { APPROVAL_GATEWAY_URL: BASE, APPROVAL_TTL_L2: '25' });

let target = null;
for (let i = 0; i < 40; i++) {
  await sleep(250);
  const list = (await api('/v1/approvals?status=pending', undefined, 'GET')).json.items || [];
  target = list.find((i) => i.body.includes('gh pr create'));
  if (target) break;
}
check('hook 确实把确认推了出来', !!target, target ? '' : '未在待确认列表中找到');

if (target) {
  const opt = target.options.find((o) => o.id === 'approve');
  const d = await api('/v1/decision', { action: opt.actionId, channel: 'selftest-phone', deviceName: 'Apple Watch' });
  check('手机端批准被接受', d.json.verdict === 'allow', JSON.stringify(d.json));
  const h3 = await hookPromise;
  let h3json = {};
  try { h3json = JSON.parse(h3.out); } catch { /* ignore */ }
  check('hook 放行了已批准的操作',
    h3json?.hookSpecificOutput?.permissionDecision === 'allow', h3.out.slice(0, 200));
  check('放行理由里带了设备信息',
    /Apple Watch/.test(h3json?.hookSpecificOutput?.permissionDecisionReason || ''),
    h3json?.hookSpecificOutput?.permissionDecisionReason);
} else {
  await hookPromise;
}

// PermissionRequest 事件格式
const h4 = await runHook({
  hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf ~/x' },
}, { APPROVAL_GATEWAY_URL: 'http://127.0.0.1:1' });
let h4json = {};
try { h4json = JSON.parse(h4.out); } catch { /* ignore */ }
check('PermissionRequest 事件返回 decision.behavior',
  h4json?.hookSpecificOutput?.decision?.behavior === 'deny', h4.out.slice(0, 200));

// ── 7. 审计 ─────────────────────────────────────────────────────────────────
console.log('\n[7] 审计日志');

const audit = await api('/v1/audit?limit=200', undefined, 'GET');
const events = (audit.json.items || []).map((x) => x.event);
check('记录了发起事件', events.includes('created'));
check('记录了结算事件', events.includes('settled'));
check('记录了重放拦截', events.includes('rejected'));
const settled = (audit.json.items || []).find((x) => x.event === 'settled');
check('结算记录含动作哈希与耗时',
  !!settled && typeof settled.binding === 'string' && typeof settled.latencyMs === 'number',
  JSON.stringify(settled || {}).slice(0, 200));

// ── 7.1 本机一次性确认的留痕端点（POST /v1/audit）───────────────────────────
// 推送失败时那条「本机确认放行」绕过了推送，是整条链路上**唯一没有设备侧记录**
// 的决定。它的可见性全靠审计，所以这个端点必须真的能用，而且不能退化成
// 「谁都能往审计里写任意内容」的入口 —— 因此只认三个固定事件名。
const auditPost = await api('/v1/audit', {
  event: 'local_confirm_issued', tool: 'Bash', tier: 'L2',
  binding: 'sha256:' + 'a'.repeat(64), by: 'selftest', summary: 'git push origin x',
}, 'POST');
check('POST /v1/audit 接受 local_confirm_issued',
  auditPost.status === 200 && auditPost.json.ok === true,
  `status ${auditPost.status} ${JSON.stringify(auditPost.json)}`);

const auditBad = await api('/v1/audit', { event: 'whatever_i_want' }, 'POST');
check('POST /v1/audit 拒绝未知事件名（不做成任意写入口）', auditBad.status === 400,
  `status ${auditBad.status} ${JSON.stringify(auditBad.json)}`);

const aud7 = await api('/v1/audit?limit=50', undefined, 'GET');
const rec7 = (aud7.json.items || []).find((x) => x.event === 'local_confirm_issued');
check('补录的审计能读回来（含 binding 与 by）',
  rec7?.binding === 'sha256:' + 'a'.repeat(64) && rec7?.by === 'selftest',
  JSON.stringify(rec7 || {}).slice(0, 200));

// ── 8. 「本会话内允许」是不是真的免打扰 ──────────────────────────────────────
// 这个按钮原先是个空按钮：只是把 verdict 记成 allow，和「仅此一次」完全一样，
// 下一件同样的事还会再问你一遍。而 SETUP.md §4 早就写着它「只在当前会话有效」——
// 文档承诺了、实现没有。这一节把它的承诺钉住，尤其是 L3 那条硬约束。
console.log('\n[8] 本会话内允许（会话白名单）');

const decideVia = (id, option_id, extra = {}) =>
  api(`/v1/approvals/${id}/decide`, { option_id, source: 'selftest-phone', ...extra });
const statusOf = async (id) => (await api(`/v1/approvals/${id}`, undefined, 'GET')).json.status;
const createIn = (session_id, body) =>
  api('/v1/approvals', { session_id, ttl: 60, ...body });

// 8.1 授予
const a1 = await createIn('sess-A', {
  tool: 'Bash', tool_input: { command: 'rm -rf ./logs/*.log' }, tier: 'L2',
});
check('会话内请求创建成功（202）', a1.status === 202, JSON.stringify(a1.json).slice(0, 200));
const d1 = await decideVia(a1.json.id, 'approve_session');
check('点「本会话内允许」被接受且判为 allow', d1.json.verdict === 'allow', JSON.stringify(d1.json));

const sess1 = await api('/v1/sessions', undefined, 'GET');
check('白名单里出现 1 条', (sess1.json.items || []).length === 1, JSON.stringify(sess1.json));
const allow1 = (sess1.json.items || [])[0] || {};
check('白名单的键是 (会话, 工具, 档位)',
  allow1.sessionId === 'sess-A' && allow1.tool === 'Bash' && allow1.tier === 'L2',
  JSON.stringify(allow1));

// 8.2 同类同档 → 免打扰（这一条就是那个「空按钮」的回归测试）
const a2 = await createIn('sess-A', {
  tool: 'Bash', tool_input: { command: 'rm -rf ./another-dir' }, tier: 'L2', wait: 5,
});
check('同类同档的请求被直接放行（不再问）', a2.json.verdict === 'allow', JSON.stringify(a2.json));
check('并且确实没有推送出去', /未推送/.test(a2.json.pushDetail || ''), a2.json.pushDetail);
check('决策来源标明是白名单放行', a2.json.decidedBy === 'session-allow', JSON.stringify(a2.json));

// 8.3 / 8.4 作用域必须窄：换工具、换会话都得照旧问
const a3 = await createIn('sess-A', {
  tool: 'Write', tool_input: { file_path: '/tmp/x' }, tier: 'L2',
});
check('同一会话换个工具仍要问', (await statusOf(a3.json.id)) === 'pending');

const a4 = await createIn('sess-B', {
  tool: 'Bash', tool_input: { command: 'rm -rf ./another-dir' }, tier: 'L2',
});
check('另一个会话的同类请求仍要问', (await statusOf(a4.json.id)) === 'pending');

// 8.5 最关键的一条：L3 永不被白名单放行
const a5 = await createIn('sess-A', {
  tool: 'Bash', tool_input: { command: 'rm -rf ~/Documents' }, tier: 'L3',
});
check('L3 即使同会话同工具也照旧要问', (await statusOf(a5.json.id)) === 'pending');

// 8.6 可见就要可撤
const rv = await api('/v1/sessions/revoke', {});
check('撤销返回被撤条数 1', rv.json.revoked === 1, JSON.stringify(rv.json).slice(0, 200));
check('撤销后白名单为空', (rv.json.items || []).length === 0, JSON.stringify(rv.json.items));

const a6 = await createIn('sess-A', {
  tool: 'Bash', tool_input: { command: 'rm -rf ./again' }, tier: 'L2',
});
check('撤销后同类请求重新开始问', (await statusOf(a6.json.id)) === 'pending');

// 8.7 留痕
const aud8 = await api('/v1/audit?limit=200', undefined, 'GET');
const ev8 = (aud8.json.items || []).map((x) => x.event);
check('审计留痕：授予', ev8.includes('session_allow_granted'));
check('审计留痕：命中', ev8.includes('session_allow_hit'));
check('审计留痕：撤销', ev8.includes('session_allow_revoked'));

// ── 9. 管理面板：/admin.html 与配套 API ────────────────────────────────────
// 这一面给浏览器看，一面给 AI / 脚本看。共用「查询参数 → 服务端过滤」语义，
// 避免前端再写一份。
console.log('\n[9] 管理面板（admin.html + 过滤端点）');

// 9.1 页面能 GET —— 直接 fetch 以拿到 content-type（api 助手只回 json）
const adminPageRes = await fetch(BASE + '/admin.html');
const adminPageBody = await adminPageRes.text();
check('GET /admin.html 返回 200 + text/html',
  adminPageRes.status === 200 && /text\/html/.test(adminPageRes.headers.get('content-type') || ''),
  `status ${adminPageRes.status} ${adminPageRes.headers.get('content-type')}`);
check('admin.html 含 /v1/approvals 与 /v1/audit/summary',
  adminPageBody.includes('/v1/approvals') && adminPageBody.includes('/v1/audit/summary'),
  'admin.html 缺少关键端点引用');

// 9.2 过滤：tier / q / limit / offset
const f1 = await api('/v1/approvals?tier=L2&q=rm&limit=3', undefined, 'GET');
const f1AllL2 = (f1.json.items || []).every((i) => i.tier === 'L2');
check('GET /v1/approvals?tier=L2&q=rm 只返回 L2',
  f1.status === 200 && f1AllL2,
  `status ${f1.status} mixed: ${!f1AllL2}`);

const f2 = await api('/v1/approvals?limit=2', undefined, 'GET');
check('GET /v1/approvals?limit=2 至少返回 2 条',
  f2.json.items.length >= 2 && f2.json.limit === 2,
  JSON.stringify({ len: f2.json.items.length, limit: f2.json.limit }));

// 9.3 审计过滤：event / tier / since / id
const f3 = await api('/v1/audit?event=created&limit=10', undefined, 'GET');
const f3AllCreated = (f3.json.items || []).every((i) => i.event === 'created');
check('GET /v1/audit?event=created 只返回 created 事件',
  f3AllCreated, `mixed events found: ${(f3.json.items || []).slice(0, 3).map((i) => i.event).join(',')}`);

// 9.4 限制裁剪
const f4 = await api('/v1/audit?limit=99999', undefined, 'GET');
check('GET /v1/audit?limit=99999 被夹到 500',
  f4.json.limit === 500, JSON.stringify({ got: f4.json.limit }));

// 9.5 坏时间戳：parseTs 返回 null，不过滤
const f5 = await api('/v1/audit?since=not-a-date', undefined, 'GET');
check('GET /v1/audit?since=not-a-date 不抛错、不过滤（fallback 全量）',
  f5.status === 200 && Array.isArray(f5.json.items),
  `status ${f5.status} ${JSON.stringify(f5.json).slice(0, 100)}`);

// 9.6 summary：byEvent / byTier / byVerdict 三个维度
const sum = await api('/v1/audit/summary', undefined, 'GET');
check('GET /v1/audit/summary 含三个维度',
  sum.json.byEvent && sum.json.byTier && sum.json.byVerdict && typeof sum.json.total === 'number',
  JSON.stringify(Object.keys(sum.json || {})));

// 9.7 trace：拉一条已知 id 的全部事件
const traceId = f3.json.items[0]?.id;
if (traceId) {
  const trace = await api(`/v1/audit/trace/${traceId}`, undefined, 'GET');
  check('GET /v1/audit/trace/:id 返回与 id 关联的事件',
    trace.status === 200 && trace.json.items.every((e) => e.id === traceId),
    `count=${trace.json.items.length} mismatch=${!trace.json.items.every((e) => e.id === traceId)}`);
}

// 9.8 详情端点：GET /v1/approvals/:id 仍按 id 走，没破坏
// 用一个**已决定**的 id（section 3 里那条被拒的）来保证 verdict 不为 null。
const decidedId = (await api('/v1/approvals?status=decided&limit=1', undefined, 'GET')).json.items[0]?.id;
if (decidedId) {
  const det = await api(`/v1/approvals/${decidedId}`, undefined, 'GET');
  check('GET /v1/approvals/:id 仍能拿到完整记录',
    det.status === 200 && det.json.id === decidedId && det.json.verdict,
    `status ${det.status} id=${det.json?.id}`);
} else {
  check('GET /v1/approvals/:id 仍能拿到完整记录', false, 'no decided id available');
}

// ── 收尾 ────────────────────────────────────────────────────────────────────
gw.kill('SIGTERM');
await sleep(600);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

console.log('\n' + '─'.repeat(52));
console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n  失败明细：');
  failures.forEach((f) => console.log('   · ' + f));
}
console.log('─'.repeat(52) + '\n');
process.exit(fail ? 1 : 0);
