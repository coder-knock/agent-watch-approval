#!/usr/bin/env node
// `src/core/store.mjs` 的**容错**测试。
//
// 存在的理由
// ----------
// 2026-09-19 网关真的死过一次，日志是这样的：
//
//   Error: EPERM: operation not permitted, rename '.../pending.json.tmp'
//     at Store._persist (src/core/store.mjs:50)      ← renameSync 抛
//     at Store.settle  (…:253)
//     at Store.sweep   (…:280)
//     at Timeout._onTimeout (node:timers:685)        ← 2 秒一次的定时器
//
// 也就是说：**一条持久化错误，变成了未捕获异常，把整个网关进程带走了。**
// 而网关死掉的后果不是「少存一条记录」——hook 会全部走「网关不可达」分支
// （L2 一直问你、L3 直接拒），用户体感是「我的命令突然全被拒了」，
// 终端上还看不到那条真正的错误。这是最不划算的失败方式。
//
// 所以这个文件盯的不是正常路径，而是**坏路径不许把进程带走**：
//   ① `_persist` 原子改名失败 → 退化为覆盖写，不抛
//   ② 改名和覆盖写都失败     → 仍然不抛（留着内存里的记录，只喊一声）
//   ③ `audit()` 落盘失败     → 不抛（但必须喊，不许静默）
//   ④ `_persistNonces()` 失败 → 不抛
//   ⑤ `sweep()` 内部抛异常    → 被吞在 sweep 里，不冒到定时器外面
//   ⑥ ★ 回归：那条真实把网关弄死的调用链，现在跑完**不抛**
//
// 手法：猴补丁。`store.mjs` 用的是 `import fs from 'node:fs'`，
// Node 会缓存模块对象 —— 测试里改 `fs.renameSync` 就能确定性地制造
// 各种 EPERM，不用依赖真实文件系统的权限（那种做法在 CI / 沙箱里不可靠）。
//
//   node test/store-resilience.test.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/core/store.mjs';

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

// ── 制造一个可用的临时 Store ──────────────────────────────────────────────
const dirs = [];
function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apr-store-'));
  dirs.push(dir);
  const s = new Store(dir, { sessionAllowTtlSeconds: 60 });
  return s;
}

// 夹具必须**照着真实记录的形状**来（见 src/gateway.mjs 的 createApproval，
// 那里的 record 字面量）。两处最容易写错、而且写错了会让测试「假绿」：
//
//   · options[].id      —— `decide()` 用 `options.find(o => o.id === optionId)`
//                          找选项；写成 actionId 就永远找不到，decide 会返回
//                          400 而**不结算**，测试于是静默地什么都没测到。
//   · approveOptionIds  —— `settle()` 第一件事就用它算 verdict；
//                          缺了它 settle 会在 _persist 之前抛 TypeError，
//                          异常被上层兜住 → 看起来「不抛」，其实没走到目标路径。
function mkRecord(id, ttlMs = 60_000) {
  return {
    id,
    createdAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
    tier: 'L2',
    tool: 'Bash',
    binding: 'sha256:test',
    title: '测试用',
    body: '测试用',
    options: [
      { id: 'allow', label: '允许', verdict: 'allow', actionId: 'APR:test:allow' },
      { id: 'deny', label: '拒绝', verdict: 'deny', actionId: 'APR:test:deny' },
    ],
    approveOptionIds: ['allow'],
    defaultOptionId: 'deny',
    status: 'pending',
    channel: 'mock',
  };
}

/** 临时把 fs 上的某个方法换成会抛的版本，返回恢复函数。 */
function patchFs(name, impl) {
  const orig = fs[name];
  fs[name] = impl;
  return () => { fs[name] = orig; };
}

/** 临时把 stderr 收起来，返回 { text, restore }。 */
function captureStderr() {
  const orig = process.stderr.write.bind(process.stderr);
  let text = '';
  process.stderr.write = (chunk, ...rest) => { text += String(chunk); return true; };
  return {
    get text() { return text; },
    restore: () => { process.stderr.write = orig; },
  };
}

const eperm = (p) => {
  const e = new Error(`EPERM: operation not permitted, rename '${p}'`);
  e.code = 'EPERM';
  return e;
};

// ── §1 原子改名失败 → 退化为覆盖写 ────────────────────────────────────────
console.log('\n§1 _persist：原子改名失败时退化为覆盖写，且不抛');

{
  const s = freshStore();
  s.create(mkRecord('r1'));

  let copyCalled = 0;
  const origCopy = fs.copyFileSync;
  const un1 = patchFs('renameSync', (from) => { throw eperm(from); });
  const un2 = patchFs('copyFileSync', (a, b) => { copyCalled++; return origCopy(a, b); });
  const cap = captureStderr();

  let threw = null;
  try {
    s.create(mkRecord('r2')); // create → _persist → 改名会失败
  } catch (e) { threw = e; }

  cap.restore(); un1(); un2();
  check('★ 改名失败时不抛异常（这正是把网关弄死的那一步）', threw === null, threw && threw.message);
  check('退化路径真的走了 copyFileSync', copyCalled > 0, `调用 ${copyCalled} 次`);
  check('退化时喊了一声（不是静默吞掉）', cap.text.includes('原子改名失败'), cap.text.slice(0, 160));
  check('__persistFailures 被记账', s._persistFailures > 0, `实际 ${s._persistFailures}`);
  s.close();
}

// ── §2 改名和覆盖写都失败 → 依然不抛 ─────────────────────────────────────
console.log('\n§2 _persist：两条路都失败，仍然不抛（内存里的记录必须还在）');

{
  const s = freshStore();
  s.create(mkRecord('r1'));

  const un1 = patchFs('renameSync', (from) => { throw eperm(from); });
  const un2 = patchFs('copyFileSync', () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; });
  const cap = captureStderr();

  let threw = null;
  try { s.create(mkRecord('r2')); } catch (e) { threw = e; }

  cap.restore(); un1(); un2();
  check('★ 两条路都失败也不抛', threw === null, threw && threw.message);
  check('记录了失败次数（供后续判断是否一直存不上）', s._persistFailures >= 1, `实际 ${s._persistFailures}`);
  check('内存里的待决记录没丢（审批流程不受影响）',
    s.list('pending').length === 2, `实际 ${s.list('pending').length} 条`);
  check('提示里说明了「内存里有、重启会丢」这个真实影响',
    cap.text.includes('重启后'), cap.text.slice(0, 300));
  s.close();
}

// ── §3 连临时文件都写不进去 → 不抛 ───────────────────────────────────────
console.log('\n§3 _persist：连 writeFileSync 都失败，不抛');

{
  const s = freshStore();
  const un = patchFs('writeFileSync', () => { const e = new Error('ENOSPC'); e.code = 'ENOSPC'; throw e; });
  const cap = captureStderr();
  let threw = null;
  try { s.create(mkRecord('r1')); } catch (e) { threw = e; }
  cap.restore(); un();
  check('★ 写临时文件失败也不抛', threw === null, threw && threw.message);
  check('喊出了磁盘/权限问题', cap.text.includes('写临时文件失败'), cap.text.slice(0, 200));
  s.close();
}

// ── §4 audit() 落盘失败 → 不抛，但必须被看见 ─────────────────────────────
console.log('\n§4 audit()：落盘失败不抛，但绝不静默');

{
  const s = freshStore();
  const un = patchFs('appendFileSync', () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; });
  const cap = captureStderr();
  let threw = null;
  try { s.audit({ event: 'decided', id: 'x1', optionId: 'deny' }); } catch (e) { threw = e; }
  cap.restore(); un();
  check('★ 审计写不进去也不抛', threw === null, threw && threw.message);
  check('但打了明确的错误（审计是安全特性，不能静默丢）',
    cap.text.includes('审计落盘失败'), cap.text.slice(0, 200));
  check('被丢掉的那条内容有留痕，便于事后补',
    cap.text.includes('decided'), cap.text.slice(0, 240));
  s.close();
}

// ── §5 _persistNonces 失败 → 不抛 ────────────────────────────────────────
console.log('\n§5 _persistNonces()：失败不抛（重放保护靠内存，落盘只为跨重启）');

{
  const s = freshStore();
  const un = patchFs('writeFileSync', () => { throw new Error('EROFS'); });
  const cap = captureStderr();
  let threw = null;
  try { s._persistNonces(); } catch (e) { threw = e; }
  cap.restore(); un();
  check('★ nonce 落盘失败也不抛', threw === null, threw && threw.message);
  check('说清了「内存里的重放保护不受影响」', cap.text.includes('内存里的重放保护'), cap.text.slice(0, 200));
  s.close();
}

// ── §6/§7 sweep 是最关键的一层 ──────────────────────────────────────────
console.log('\n§6 sweep()：内部抛异常会被吞在 sweep 里（定时器不许炸）');

{
  const s = freshStore();
  s.create(mkRecord('r1', -1)); // 已经过期，下一次 sweep 会结算它

  // 让 settle 抛 —— 模拟「结算路径上又冒出别的意外」
  const origSettle = s.settle.bind(s);
  s.settle = () => { throw new Error('结算路径上的意外'); };
  const cap = captureStderr();
  let threw = null;
  try { s.sweep(); } catch (e) { threw = e; }
  cap.restore();
  s.settle = origSettle;
  check('★ sweep 不把异常抛给调用者（= 不抛给定时器 = 进程不死）', threw === null, threw && threw.message);
  check('吞掉时留了痕', cap.text.includes('sweep 抛异常'), cap.text.slice(0, 200));
  s.close();
}

console.log('\n§7 ★ 回归：真实把网关弄死的那条调用链，现在跑完不抛');

{
  const s = freshStore();
  const rec = mkRecord('r1', -1); // 已过期
  s.create(rec);

  // 复现现场：sweep(定时器) → settle → _persist → renameSync EPERM
  const un = patchFs('renameSync', (from) => { throw eperm(from); });
  const un2 = patchFs('copyFileSync', () => { throw eperm('x'); });
  const cap = captureStderr();

  let threw = null;
  try {
    s.sweep();                    // ← 现场就是这一句（由 Timeout._onTimeout 调）
  } catch (e) { threw = e; }

  cap.restore(); un(); un2();
  check('★ sweep → settle → _persist(rename EPERM) 全程不抛',
    threw === null, threw && threw.message);
  check('★ 记录仍然被正确结算成 expired（业务结果正确）',
    s.get('r1').status === 'expired', s.get('r1').status);
  // 这一条是 §7 的**关键**：`_persistFailures` 有值，才证明异常是被
  // `_persist()` 自己兜住的；如果它是 0，就说明异常其实冒到了 sweep 那一层 ——
  // 那测的是「sweep 的兜底」，而不是「持久化不抛」，完全是两回事（第一版假绿过）。
  check('★ 异常是在 _persist 内部被兜住的（不是靠 sweep 兜底蒙对）',
    s._persistFailures >= 1, `_persistFailures=${s._persistFailures}`);
  check('审计里留下了 settled 这一条（结算不因为落盘失败而中断）',
    s.readAudit(10).some((x) => x.event === 'settled' && x.id === 'r1'));
  s.close();
}

// ── §8 正常路径没被改坏 ─────────────────────────────────────────────────
console.log('\n§8 正常路径：原子改名仍然照常做（别为了容错把正常路径也降级了）');

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apr-store-ok-'));
  dirs.push(dir);
  const s = new Store(dir, { sessionAllowTtlSeconds: 60 });

  // 直接看结果更实在（不去数 renameSync 调了几次）：
  // 正常路径下 pending.json 必须内容正确、且没有走退化分支。
  s.create(mkRecord('r1'));
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'pending.json'), 'utf8'));
  check('★ pending.json 正常落盘（原子改名路径完好）',
    onDisk.records.length === 1 && onDisk.records[0].id === 'r1',
    JSON.stringify(onDisk).slice(0, 140));
  check('正常路径没有记账失败', s._persistFailures === 0, `实际 ${s._persistFailures}`);
  check('审计也正常落盘', s.readAudit(5).some((x) => x.event === 'created'));

  // 决策后从 pending 列表里消失
  s.decide('r1', 'deny', { source: 'test' });
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'pending.json'), 'utf8'));
  check('结算后不再留在 pending.json 里', after.records.length === 0,
    JSON.stringify(after).slice(0, 160));
  check('审计里有 settled（事件名是 settled，不是 decided）',
    s.readAudit(5).some((x) => x.event === 'settled' && x.id === 'r1'));
  s.close();
}

// ── 清理 ──────────────────────────────────────────────────────────────────
for (const d of dirs) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log('');
if (fail === 0) {
  console.log(`\x1b[32m✅ store 容错测试全部通过（${pass} 项通过）\x1b[0m`);
  process.exit(0);
} else {
  console.log(`\x1b[31m❌ ${fail} 项失败 / ${pass} 项通过\x1b[0m`);
  for (const f of failures) console.log(`   · ${f}`);
  process.exit(1);
}
