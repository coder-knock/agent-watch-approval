#!/usr/bin/env node
// src/core/local-grant.mjs 的单元测试。
//
// 存在的理由：这个模块是「推送失败时给你一个选项」那条路的全部状态机 ——
// 签发、单次消费、绑定校验、TTL、签名、以及「写不进去也不许把 hook 带走」。
// 它同时被 hook（2 秒级热路径）和 approval confirm 调用，任何一处抛异常
// 都会变成「命令被莫名拦住」或「命令被莫名放行」，两种都很难事后查。
//
// 全部在临时目录里跑，不碰真实 data/、不碰网关、不碰网络。
//
//   node test/local-grant.test.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_TTL_SECONDS,
  shortBinding,
  files,
  resolveDataDir,
  issueGrant,
  consumeGrant,
  listGrants,
  rememberBlocked,
  readBlocked,
  readSecret,
  grantBinding,
} from '../src/core/local-grant.mjs';
import { actionBinding } from '../src/core/bind.mjs';

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'local-grant-'));
const SECRET = 'a'.repeat(64);

/** 每个用例一个干净的 data 目录，避免用例之间互相污染。 */
let caseNo = 0;
function freshDir() {
  const d = path.join(TMP, `case-${++caseNo}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const B1 = 'sha256:' + '1'.repeat(64);
const B2 = 'sha256:' + '2'.repeat(64);

console.log('\nlocal-grant.mjs — 本机一次性确认的状态机\n');

// ── 1. 短的展示号 ─────────────────────────────────────────────
{
  console.log('[1] shortBinding');
  check('去掉 sha256: 前缀并截前 6 位',
    shortBinding(B1) === '111111', shortBinding(B1));
  check('长度恒为 6', shortBinding(B1).length === 6);
  check('空值不抛，给空串', shortBinding(undefined) === '', `实际 ${JSON.stringify(shortBinding(undefined))}`);
  check('不是 sha256: 开头时也只看前 6 位',
    shortBinding('abcdef1234') === 'abcdef', shortBinding('abcdef1234'));
}

// ── 2. dataDir 解析 ──────────────────────────────────────────
{
  console.log('\n[2] resolveDataDir');
  const root = path.join(TMP, 'proj');
  fs.mkdirSync(root, { recursive: true });

  check('没有 config.json → <root>/data',
    resolveDataDir(root) === path.join(root, 'data'), resolveDataDir(root));

  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ dataDir: './var/store' }));
  check('读 config.json 的 dataDir（相对项目根）',
    resolveDataDir(root) === path.join(root, 'var', 'store'), resolveDataDir(root));

  fs.writeFileSync(path.join(root, 'config.json'), '{ 这不是 JSON');
  check('config.json 坏掉 → 退回 <root>/data（绝不抛）',
    resolveDataDir(root) === path.join(root, 'data'), resolveDataDir(root));

  // 测试用覆盖：否则 hook 的测试会往真实 data/ 里写 blocked-last.json
  const prev = process.env.APPROVAL_DATA_DIR;
  process.env.APPROVAL_DATA_DIR = path.join(TMP, 'override');
  check('APPROVAL_DATA_DIR 优先于 config.json',
    resolveDataDir(root) === path.join(TMP, 'override'), resolveDataDir(root));
  if (prev === undefined) delete process.env.APPROVAL_DATA_DIR;
  else process.env.APPROVAL_DATA_DIR = prev;
}

// ── 3. 签发 → 消费 的正常往返 ────────────────────────────────
{
  console.log('\n[3] 签发 → 消费');
  const d = freshDir();
  const r = issueGrant(d, { secret: SECRET, binding: B1, tool: 'Bash', summary: 'git push origin main' });
  check('issueGrant ok', r.ok === true, JSON.stringify(r));
  check('记下了 binding / tool / by', r.record.binding === B1 && r.record.tool === 'Bash');
  check('带上了签名', typeof r.record.sig === 'string' && r.record.sig.length > 0);
  check('默认 TTL 是 600s',
    Math.round((r.record.expiresAt - r.record.issuedAt) / 1000) === DEFAULT_TTL_SECONDS,
    String((r.record.expiresAt - r.record.issuedAt) / 1000));

  const c = consumeGrant(d, { secret: SECRET, binding: B1 });
  check('consumeGrant 命中', c.ok === true, JSON.stringify(c));
  check('返回原始记录（供留痕）', c.record?.summary === 'git push origin main');

  const again = consumeGrant(d, { secret: SECRET, binding: B1 });
  check('**只能消费一次**（第二次 no-grant）', again.ok === false && again.reason === 'no-grant',
    JSON.stringify(again));

  check('本地日志留了痕', fs.readFileSync(files(d).log, 'utf8').includes('consume'));
  check('日志里同时有签发与消费两条',
    /\bissue binding=/.test(fs.readFileSync(files(d).log, 'utf8')) &&
    /\bconsume binding=/.test(fs.readFileSync(files(d).log, 'utf8')),
    fs.readFileSync(files(d).log, 'utf8').trim());
}

// ── 4. 绑定不匹配 ────────────────────────────────────────────
{
  console.log('\n[4] 绑定必须完全一致');
  const d = freshDir();
  issueGrant(d, { secret: SECRET, binding: B1, tool: 'Bash', summary: 'git push origin main' });

  const miss = consumeGrant(d, { secret: SECRET, binding: B2 });
  check('换一条命令 → no-grant', miss.ok === false && miss.reason === 'no-grant', JSON.stringify(miss));
  check('不匹配**不会**顺手把 B1 那张吃掉', listGrants(d).length === 1, `剩 ${listGrants(d).length}`);

  const hit = consumeGrant(d, { secret: SECRET, binding: B1 });
  check('原命令仍然可以用掉自己那张', hit.ok === true, JSON.stringify(hit));
}

// ── 5. 过期 ──────────────────────────────────────────────────
{
  console.log('\n[5] 过期');
  const d = freshDir();
  issueGrant(d, { secret: SECRET, binding: B1, ttlSeconds: 30 });

  // 注意：**不能靠改 expiresAt 来造过期样本** —— 那会同时破坏签名，
  // 而签名是在有效期之前校验的，于是拿到的是 bad-sig 而不是 expired
  // （这个顺序是对的，见下面第 6 节；但用它来测过期就测错了对象）。
  // 正确做法是把「现在」往后拨：签名覆盖的是 issuedAt/expiresAt 两个**数值**，
  // 与当前时间无关，所以签名仍然有效，只是真的过期了。
  const realNow = Date.now;
  const jumpTo = realNow() + 31_000;
  Date.now = () => jumpTo;
  let c;
  try {
    c = consumeGrant(d, { secret: SECRET, binding: B1 });
  } finally {
    Date.now = realNow;
  }

  check('过期 → reason=expired', c.ok === false && c.reason === 'expired', JSON.stringify(c));
  check('过期的那张被摘掉（不留着反复试）', listGrants(d).length === 0);
  check('日志里记了 REJECT expired', /REJECT expired/.test(fs.readFileSync(files(d).log, 'utf8')));

  // 反向锚点：把「现在」往后拨但还没到 expiresAt，必须仍然可用。
  // 否则上面那条「expired」可能只是因为我们把时间拨坏了。
  const d1b = freshDir();
  issueGrant(d1b, { secret: SECRET, binding: B1, ttlSeconds: 600 });
  const jump2 = realNow() + 599_000;
  Date.now = () => jump2;
  let ok;
  try {
    ok = consumeGrant(d1b, { secret: SECRET, binding: B1 });
  } finally {
    Date.now = realNow;
  }
  check('同一手法下「还没到期」时仍然可用（证明上一条测的是过期而非时钟故障）',
    ok.ok === true, JSON.stringify(ok));

  check('ttl 有下限（给 1 秒也按 30 秒起算）',
    (() => {
      const d2 = freshDir();
      const r2 = issueGrant(d2, { secret: SECRET, binding: B1, ttlSeconds: 1 });
      return Math.round((r2.record.expiresAt - r2.record.issuedAt) / 1000) === 30;
    })());
}

// ── 6. 签名：光改文件不改签名过不了 ──────────────────────────
{
  console.log('\n[6] 签名');
  const d = freshDir();
  issueGrant(d, { secret: SECRET, binding: B1 });
  const j = JSON.parse(fs.readFileSync(files(d).grants, 'utf8'));
  j.grants[0].expiresAt = Date.now() + 999_000; // 手改有效期（想续命）
  fs.writeFileSync(files(d).grants, JSON.stringify(j));

  const c = consumeGrant(d, { secret: SECRET, binding: B1 });
  check('改过 expiresAt → bad-sig', c.ok === false && c.reason === 'bad-sig', JSON.stringify(c));
  check('**签名先于有效期校验** —— 因此「手改有效期续命」报的是 bad-sig 而不是 expired',
    c.reason === 'bad-sig', `实际 ${c.reason}`);
  check('作废的那张被摘掉', listGrants(d).length === 0);
  check('日志里记了 REJECT bad-sig', /REJECT bad-sig/.test(fs.readFileSync(files(d).log, 'utf8')));

  // 换一个 secret 来校验同样应该过不了
  const d2 = freshDir();
  issueGrant(d2, { secret: SECRET, binding: B1 });
  const c2 = consumeGrant(d2, { secret: 'b'.repeat(64), binding: B1 });
  check('换密钥校验 → bad-sig', c2.ok === false && c2.reason === 'bad-sig', JSON.stringify(c2));
}

// ── 7. 密钥缺失 / 坏文件 / 空表 ──────────────────────────────
{
  console.log('\n[7] 退化输入一律不抛');
  const d = freshDir();
  issueGrant(d, { secret: SECRET, binding: B1 });
  const c = consumeGrant(d, { secret: null, binding: B1 });
  check('读不到 secret → no-secret（不放行）', c.ok === false && c.reason === 'no-secret', JSON.stringify(c));

  const d2 = freshDir();
  check('空目录 consume → no-grant', consumeGrant(d2, { secret: SECRET, binding: B1 }).reason === 'no-grant');
  check('空目录 list → 空数组', listGrants(d2).length === 0);

  fs.writeFileSync(files(d2).grants, '这不是 JSON');
  check('grants 文件坏掉 → no-grant（不抛）',
    consumeGrant(d2, { secret: SECRET, binding: B1 }).reason === 'no-grant');

  const bad = issueGrant(d2, { secret: null, binding: B1 });
  check('issueGrant 缺 secret → ok:false（不抛）', bad.ok === false && /secret/.test(bad.reason), JSON.stringify(bad));
  const noBind = issueGrant(d2, { secret: SECRET, binding: '' });
  check('issueGrant 缺 binding → ok:false', noBind.ok === false, JSON.stringify(noBind));
}

// ── 8. 同一个 binding 重复签发不会堆积 ───────────────────────
{
  console.log('\n[8] 重复签发');
  const d = freshDir();
  issueGrant(d, { secret: SECRET, binding: B1, by: 'first' });
  const second = issueGrant(d, { secret: SECRET, binding: B1, by: 'second' });
  check('同 binding 再签 → 只留一张', listGrants(d).length === 1, `剩 ${listGrants(d).length}`);
  check('留下的是新的那张', listGrants(d)[0].by === 'second' && second.ok === true);

  issueGrant(d, { secret: SECRET, binding: B2, by: 'other' });
  check('不同 binding 各占一张', listGrants(d).length === 2);
}

// ── 9. 过期项会自动从列表里剪掉 ──────────────────────────────
{
  console.log('\n[9] listGrants 自动剪枝');
  const d = freshDir();
  issueGrant(d, { secret: SECRET, binding: B1 });
  issueGrant(d, { secret: SECRET, binding: B2 });
  const j = JSON.parse(fs.readFileSync(files(d).grants, 'utf8'));
  j.grants.find((g) => g.binding === B1).expiresAt = Date.now() - 1;
  fs.writeFileSync(files(d).grants, JSON.stringify(j));
  check('只返回还有效的那张', listGrants(d).length === 1 && listGrants(d)[0].binding === B2);
}

// ── 10. 被拦记录（给 approval confirm 用）────────────────────
{
  console.log('\n[10] blocked-last.json');
  const d = freshDir();
  check('没拦过 → null', readBlocked(d) === null);

  rememberBlocked(d, {
    binding: B1, tool: 'Bash', tier: 'L2', summary: 'git push origin main',
    reason: '推送到手表失败：500', approvalId: 'abc123',
  });
  const r = readBlocked(d);
  check('读回 binding / tool / tier',
    r?.binding === B1 && r?.tool === 'Bash' && r?.tier === 'L2', JSON.stringify(r));
  check('带上原因与 approvalId', /500/.test(r.reason) && r.approvalId === 'abc123');
  check('带上时间戳（confirm 用它算「拦于多久前」）', typeof r.at === 'number' && r.at > 0);
  check('blocked 也进本地日志', /blocked tool=Bash/.test(fs.readFileSync(files(d).log, 'utf8')));

  const d2 = freshDir();
  fs.writeFileSync(files(d2).blocked, '{"没有binding":1}');
  check('字段不全的 blocked 当没有处理', readBlocked(d2) === null);
}

// ── 11. 写不进去时：不抛，且明确失败 ─────────────────────────
{
  console.log('\n[11] 磁盘写不进去也不许把调用方带走');
  // 把「目录」的位置放一个普通文件 → mkdirSync/writeFileSync 必然 ENOTDIR
  const blocker = path.join(TMP, 'blocker-file');
  fs.writeFileSync(blocker, 'x');
  const unusable = path.join(blocker, 'sub');

  let threw = null;
  let res = null;
  try {
    res = issueGrant(unusable, { secret: SECRET, binding: B1 });
  } catch (e) {
    threw = e;
  }
  check('issueGrant 不抛', threw === null, threw ? String(threw.message) : '');
  check('而是返回 ok:false + 原因', res?.ok === false && /写不进去/.test(res.reason), JSON.stringify(res));

  let threw2 = null;
  let res2 = null;
  try {
    res2 = consumeGrant(unusable, { secret: SECRET, binding: B1 });
  } catch (e) {
    threw2 = e;
  }
  check('consumeGrant 不抛（只读路径本来就不该抛）', threw2 === null, threw2 ? String(threw2.message) : '');
  check('拿不到 → no-grant（fail-closed）', res2?.ok === false, JSON.stringify(res2));

  check('readSecret 对不存在的目录返回 null', readSecret(unusable) === null);
  check('readBlocked 对坏路径返回 null',
    (() => { try { return readBlocked(unusable) === null; } catch { return false; } })());
}

// ── 12. files() 路径形状 ─────────────────────────────────────
{
  console.log('\n[12] files()');
  const f = files('/tmp/x');
  check('grants → local-grants.json', f.grants === path.join('/tmp/x', 'local-grants.json'));
  check('blocked → blocked-last.json', f.blocked === path.join('/tmp/x', 'blocked-last.json'));
  check('log → local-confirm.log', f.log === path.join('/tmp/x', 'local-confirm.log'));
}

// ── 13. grantBinding：绑动作，不绑信封 ───────────────────────
// 这一节钉住一个**会让整个功能失效**的坑（2026-09-19 活体实测发现）：
// WorkBuddy 给 Bash 的 tool_input 里带 `description`，而 actionBinding 会把
// 整个 input 算进去 —— 于是 Agent 重试时改一句描述，绑定就变了，
// 「approval confirm --yes 成功但重试仍被拦」。用户授权的是动作，不是描述。
{
  console.log('\n[13] grantBinding 只绑动作');
  const CMD = 'git push origin main';
  const a = grantBinding('Bash', { command: CMD, description: '跑一条探针' });
  const b = grantBinding('Bash', { command: CMD, description: '重试同一条命令' });

  check('换 description **不**改变绑定（这正是修复点）', a === b, `${shortBinding(a)} vs ${shortBinding(b)}`);
  check('换 timeout / run_in_background 也不改变绑定',
    a === grantBinding('Bash', { command: CMD, timeout: 999 })
    && a === grantBinding('Bash', { command: CMD, run_in_background: true }));
  check('换命令本身**必须**改变绑定',
    a !== grantBinding('Bash', { command: 'git push origin other' }));
  check('反向锚点：actionBinding 反而**会**因为 description 改变（说明这个坑真实存在）',
    actionBinding('Bash', { command: CMD, description: 'x' })
    !== actionBinding('Bash', { command: CMD, description: 'y' }));
  check('缺 command 时退化成空命令，不抛',
    typeof grantBinding('Bash', { description: 'x' }) === 'string'
    && grantBinding('Bash', {}) === grantBinding('Bash', { command: '' }));
  check('tool_input 不是对象也不抛', typeof grantBinding('Bash', undefined) === 'string');

  // 非 Bash 工具：只剥元数据，动作字段必须全留
  const editA = grantBinding('Edit', { file_path: '/a', old_string: 'x', new_string: 'y', description: 'd1' });
  const editB = grantBinding('Edit', { file_path: '/a', old_string: 'x', new_string: 'y', description: 'd2' });
  check('Edit：剥掉 description 后仍然稳定', editA === editB);
  check('Edit：换 file_path 会改变绑定',
    editA !== grantBinding('Edit', { file_path: '/b', old_string: 'x', new_string: 'y' }));
  check('Edit：换 new_string 会改变绑定',
    editA !== grantBinding('Edit', { file_path: '/a', old_string: 'x', new_string: 'z' }));
  check('未知工具也走同一条剥元数据的规则',
    grantBinding('SomeTool', { a: 1, description: 'd1' }) === grantBinding('SomeTool', { a: 1, description: 'd2' }));

  // 端到端：签发用 grantBinding，重试时 description 变了也要能命中
  const d = freshDir();
  const first = grantBinding('Bash', { command: CMD, description: '第一次的描述' });
  issueGrant(d, { secret: SECRET, binding: first, tool: 'Bash' });
  const retry = grantBinding('Bash', { command: CMD, description: '重试时改写的描述' });
  const hit = consumeGrant(d, { secret: SECRET, binding: retry });
  check('签发后重试（description 不同）仍能命中', hit.ok === true, JSON.stringify(hit));
}

fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}: ${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(fail ? 1 : 0);
