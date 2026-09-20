#!/usr/bin/env node
// MCP 入口的端到端测试。
//
// 覆盖了一段 test/selftest.mjs 没有覆盖的路径：自检测的是
//   hook → 网关 → 决策
// 而这里测的是
//   MCP stdio 服务 → 网关 → 决策 → MCP 响应
// 也就是 Agent 主动调用 request_approval 这条路的完整往返。
//
// 跑法：node test/mcp-e2e.mjs        （需要网关已在 7788 上跑着）
//
// 它做的事：真启一个 MCP 子进程，走真实 JSON-RPC 握手，发一个 request_approval，
// 然后用 HTTP 冒充「用户在手表上点了批准」，最后核对 MCP 拿到的结论是不是 allow。

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MCP_ENTRY = path.join(ROOT, 'mcp', 'approval-mcp.mjs');
const GW = process.env.APPROVAL_GATEWAY_URL || 'http://127.0.0.1:7788';

const C = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};
let pass = 0;
let fail = 0;
function check(desc, cond, extra) {
  if (cond) {
    console.log(`  ${C.green('✓')} ${desc}`);
    pass++;
  } else {
    console.log(`  ${C.red('✗')} ${desc}${extra ? `  ${C.dim(String(extra).slice(0, 200))}` : ''}`);
    fail++;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 起 MCP 子进程，按行读 JSON-RPC ────────────────────────────────────────
const child = spawn(process.execPath, [MCP_ENTRY], {
  cwd: ROOT,
  env: { ...process.env, APPROVAL_GATEWAY_URL: GW },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stderrBuf = '';
child.stderr.on('data', (d) => { stderrBuf += d.toString(); });

const waiting = new Map();
let idSeq = 0;
let buf = '';

child.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && waiting.has(msg.id)) {
      const { resolve } = waiting.get(msg.id);
      waiting.delete(msg.id);
      resolve(msg);
    }
  }
});

const dead = new Promise((resolve) => child.on('exit', (code) => resolve(code)));

function rpc(method, params) {
  const id = ++idSeq;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (waiting.has(id)) {
        waiting.delete(id);
        reject(new Error(`${method} 超时`));
      }
    }, 60000);
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

function textOf(resp) {
  const c = resp?.result?.content;
  if (Array.isArray(c)) return c.map((x) => x.text || '').join('\n');
  return JSON.stringify(resp?.result ?? resp?.error ?? null);
}

async function main() {
  console.log(C.bold('\n=== MCP 入口端到端测试 ===\n'));

  // 先确认网关在
  try {
    const r = await fetch(`${GW}/healthz`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const h = await r.json();
    console.log(`  网关在线，通道 ${C.bold(h.channel)}（channelReady=${h.channelReady}）\n`);

    // ⚠️ 这个测试会通过**当前通道**真发一条 request_approval。
    // 网关跑 mock 通道时无所谓；但一旦切到 ha，这就是真的往你手机/手表推一张卡片，
    // 而且会留下一条待确认（得手点掉或等超时）。
    // 一条静默的「测试」不该打扰人，所以非 mock 通道上要求显式同意。
    // （这个坑是真踩到的：切到 ha 通道后直接 `approval test`，手机就响了。）
    if (h.channel !== 'mock' && !process.env.APPROVAL_TEST_ALLOW_PUSH) {
      console.log(C.red(`当前网关的通道是 "${h.channel}" —— 跑下去会真推一条到你手机上。`));
      console.log(C.dim('想跑的话，二选一：'));
      console.log(C.dim('  A. 让它推（就是想在真机上验证一次）：'));
      console.log(C.dim('       approval test --with-push'));
      console.log(C.dim('  B. 不打扰手机：把 config.json 的 "channel" 临时改回 "mock" 再重启网关。'));
      console.log(C.dim('     （selftest 那 82 项用的是自己的临时 mock 配置，不受影响。）'));
      child.kill();
      process.exit(2);
    }
  } catch (e) {
    console.log(C.red(`网关不可达：${GW} —— ${e.message}`));
    console.log(C.dim('先起网关：node src/gateway.mjs'));
    console.log(C.dim('（这一套打的是「当前在跑的网关」，没网关时按设计跳过，不算失败。）'));
    child.kill();
    // exit 2 = 按设计跳过（不是断言失败）。`approval test` 会把它标成「跳过」而不是红。
    process.exit(2);
  }

  console.log('[1] JSON-RPC 握手');
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcp-e2e', version: '1' },
  });
  check('initialize 返回 serverInfo', !!init.result?.serverInfo?.name,
        JSON.stringify(init.result?.serverInfo));
  notify('notifications/initialized');

  const list = await rpc('tools/list', {});
  const tools = list.result?.tools || [];
  check('tools/list 返回 5 个工具', tools.length === 5, `实际 ${tools.length}`);
  const names = tools.map((t) => t.name);
  for (const n of ['request_approval', 'list_pending_approvals', 'cancel_approval',
                   'verify_approval', 'get_approval_audit']) {
    check(`工具存在：${n}`, names.includes(n));
  }

  console.log('\n[2] 发出确认请求（会阻塞等待决策）');
  const ACTION = `echo mcp-e2e-${Date.now()}`;
  const pending = rpc('tools/call', {
    name: 'request_approval',
    arguments: {
      title: 'MCP 自测',
      body: '这是一条端到端自测请求，可忽略。',
      risk_tier: 'L2',
      action: ACTION,
      ttl_seconds: 40,
      wait_seconds: 35,
    },
  });

  // 等它真的落到待决列表里。注意 /v1/approvals 只暴露
  // id/tier/title/body/options，不含动作原文，所以这里按标题认领；
  // 动作原文的完整性改在 [4] 用 MCP 的返回值核对。
  const TITLE = 'MCP 自测';
  let target = null;
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    const r = await fetch(`${GW}/v1/approvals?status=pending`);
    const j = await r.json();
    const arr = Array.isArray(j) ? j : (j.items || j.approvals || []);
    target = arr.find((a) => a.title === TITLE);
    if (target) break;
  }
  check('请求已进入待决列表', !!target,
        target ? '' : JSON.stringify(await (await fetch(`${GW}/v1/approvals`)).json()).slice(0, 300));
  if (!target) {
    child.kill();
    return finish();
  }
  console.log(`  ${C.dim(`id=${target.id} tier=${target.tier} 选项=${(target.options || []).map((o) => o.id).join('/')}`)}`);
  check('带 L2 标记', target.tier === 'L2', target.tier);
  check('默认选项含「拒绝」', (target.options || []).some((o) => o.id === 'deny'));
  check('按钮带一次性令牌而非明文选项', 
        (target.options || []).every((o) => typeof o.actionId === 'string' && o.actionId.startsWith('APR:')),
        JSON.stringify((target.options || []).map((o) => o.actionId).slice(0, 1)));

  console.log('\n[3] 冒充「用户在手表上点了批准」');
  const dec = await fetch(`${GW}/v1/approvals/${target.id}/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ option_id: 'approve', source: 'e2e-test', deviceName: 'MCP E2E' }),
  });
  check('决策接口接受批准', dec.ok, `HTTP ${dec.status}`);

  console.log('\n[4] MCP 侧收到结论');
  const resp = await pending;
  const txt = textOf(resp);
  check('request_approval 正常返回（非 error）', !resp.error, JSON.stringify(resp.error));
  // 注意：结论里的批准是渲染成中文的「已批准」，不是英文 allow。
  check('结论为批准', /已批准|approved/i.test(txt), txt.slice(0, 200));
  check('带绑定哈希（用于事后核对批准的是什么）', /绑定哈希：sha256:[0-9a-f]{16}/.test(txt),
        txt.slice(0, 200));
  check('带用户响应耗时', /耗时：[\d.]+s/.test(txt), txt.slice(0, 200));
  // 注意：这里断言的是「决策来源**字段**会被透传」，不是「能看出是不是手表点的」。
  // HA 通道下 deviceName 恒为 null（HA 侧拿不到是手机还是手表点的，见 SETUP.md 1.5 /
  // 已知限制），只有 mock / 手机模拟器 / MCP 这类由调用方自报来源的通道才有设备名。
  check('透传决策来源（有 deviceName 时一并带上）',
    /决策来源：e2e-test/.test(txt) || /MCP E2E/.test(txt),
        txt.slice(0, 250));
  // 设计上故意不回显动作原文 —— 它要求 Agent 自己去 verify_approval，
  // 免得 Agent 把「批准的 A」和「现在要做的 B」混为一谈。这里把这层意图固化下来。
  check('不直接回显动作原文，而是要求 Agent 自行核对绑定',
        !txt.includes(ACTION) && /verify_approval/.test(txt), txt.slice(0, 250));

  console.log('\n[5] 审计可追溯');
  const aud = await rpc('tools/call', { name: 'get_approval_audit', arguments: { limit: 20 } });
  const audTxt = textOf(aud);
  check('审计里能查到这次请求', audTxt.includes(target.id), audTxt.slice(0, 200));
  check('审计标注了决策来源', /e2e-test|MCP E2E/.test(audTxt), audTxt.slice(0, 300));

  console.log('\n[6] 不存在的请求要报错而不是静默成功');
  const phantom = await rpc('tools/call', {
    name: 'verify_approval',
    arguments: { id: 'apr_does_not_exist', action: 'whatever' },
  });
  const phantomTxt = textOf(phantom);
  check('幽灵 id 不返回成功结论', !/^\s*\{?\s*"?ok"?\s*:?\s*true/i.test(phantomTxt) ,
        phantomTxt.slice(0, 200));

  child.stdin.end();
  child.kill();
  return finish();
}

function finish() {
  console.log('\n' + '─'.repeat(52));
  const color = fail === 0 ? C.green : C.red;
  console.log(color(`  通过 ${pass} 项，失败 ${fail} 项`));
  console.log('─'.repeat(52) + '\n');
  if (stderrBuf.trim() && fail > 0) {
    console.log(C.dim('MCP 子进程 stderr：'));
    console.log(C.dim(stderrBuf.slice(0, 2000)));
  }
  process.exit(fail === 0 ? 0 : 1);
}

process.on('unhandledRejection', (e) => {
  console.error('\n未捕获异常：', e?.message || e);
  try { child.kill(); } catch {}
  process.exit(1);
});

await main();
