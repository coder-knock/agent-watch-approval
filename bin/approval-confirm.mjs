#!/usr/bin/env node
// 「本机一次性确认」的签发与查看入口。
//
// 它是哪一环
// ----------
//   推送到手表失败（HA notify 500 / 网关失联）
//     ↓
//   bin/approve-hook.mjs 拦住这条命令（fail-closed），并把它写进 data/blocked-last.json
//     ↓
//   Agent 用 **AskUserQuestion** 在 WorkBuddy 里弹出选项问你      ← 用户要的「弹框确认」
//     ↓
//   你选「允许这一次」
//     ↓
//   Agent 跑 `approval confirm --yes`  →  ← 本文件
//     ↓
//   重试同一条命令时，hook 先查这张表 → 命中 → 放行（且只能用一次）
//
// 为什么不直接在 hook 里弹框
// --------------------------
// 因为本构建的 WorkBuddy **不实现 `permissionDecision:"ask"`**：hook 输出 ask
// 会被当成「放行」。这是这次改动的起点，完整证据见 src/core/local-grant.mjs 头注释。
//
// 安全定位（必须诚实）
// --------------------
// 本机的 agent 能读 data/secret、也有 TTY，所以它技术上完全可以自己跑这条命令。
// 这道门**不是安全边界**，它防的是「手改文件」与「误放行」，不防对抗。
// 因此每一次签发/消费都会留痕：本地 data/local-confirm.log + 网关审计
// （POST /v1/audit，事件 local_confirm_issued / _used / _rejected）。
//
// 用法
// ----
//   approval confirm                 确认「最近一次被拦下的那条命令」（交互式，人会看到摘要）
//   approval confirm --yes           不再追问，直接签发（Agent 用：用户已在弹框里答过）
//   approval confirm --list          看当前有效的一次性授权
//   approval confirm --revoke        收回全部授权（收回一条：--revoke <短 binding>）
//   approval confirm --json          机器可读输出
//
//   --binding <sha256:…>  指定要授权的绑定（默认取 blocked-last.json）
//   --ttl <秒>            授权有效期，默认 600（10 分钟）
//   --by <标签>           签发者标记，默认按是否 --yes 猜（agent-after-dialog / terminal）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import {
  DEFAULT_TTL_SECONDS,
  files,
  issueGrant,
  listGrants,
  readBlocked,
  readSecret,
  resolveDataDir,
  shortBinding,
} from '../src/core/local-grant.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = resolveDataDir(PROJECT_ROOT);
const SECRET = readSecret(DATA_DIR);
const GATEWAY = (process.env.APPROVAL_GATEWAY_URL || 'http://127.0.0.1:7788').replace(/\/+$/, '');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
function opt(name, fallback = null) {
  const i = argv.indexOf(name);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : fallback;
}

const AS_JSON = has('--json');
const out = (s) => process.stdout.write(s + '\n');
const note = (s) => process.stderr.write(s + '\n');

function die(msg, code = 2) {
  if (AS_JSON) out(JSON.stringify({ ok: false, error: msg }));
  else note(`✗ ${msg}`);
  process.exit(code);
}

function humanAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  return `${Math.round(s / 3600)} 小时前`;
}

/** 往网关补一条审计。best-effort —— 网关不在也不该影响这次签发。 */
async function reportAudit(entry) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 1500);
  try {
    await fetch(`${GATEWAY}/v1/audit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
      signal: ac.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 交互式确认。非 TTY 或超时一律按「不确认」处理 —— 宁可不签，也不替人点头。 */
async function askYesNo(question, timeoutMs = 60000) {
  if (!process.stdin.isTTY) {
    note('（stdin 不是终端，无法交互追问；要签发请显式加 --yes）');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const timer = setTimeout(() => rl.close(), timeoutMs);
  try {
    const ans = await rl.question(question);
    return /^(y|yes|是|好)$/i.test(ans.trim());
  } catch {
    return false; // rl.close() 打断 question → 超时
  } finally {
    clearTimeout(timer);
    rl.close();
  }
}

// ── --list ─────────────────────────────────────────────────────────────────
if (has('--list')) {
  const list = listGrants(DATA_DIR);
  if (AS_JSON) {
    out(JSON.stringify({ ok: true, items: list.map((g) => ({ ...g, short: shortBinding(g.binding) })) }));
  } else if (!list.length) {
    out('（当前没有生效中的本机一次性授权）');
  } else {
    out(`本机一次性授权 ${list.length} 张｜一次性消费｜存在 ${path.relative(PROJECT_ROOT, files(DATA_DIR).grants)}\n`);
    for (const g of list) {
      out(`  ${g.tier || '?'}  ${g.tool}  binding ${shortBinding(g.binding)}` +
        `  剩 ${Math.round((g.expiresAt - Date.now()) / 1000)}s  by ${g.by}`);
      out(`      ${g.summary || '（无摘要）'}`);
    }
    out('\n收回全部：approval confirm --revoke');
  }
  process.exit(0);
}

// ── --revoke [短 binding] ──────────────────────────────────────────────────
if (has('--revoke')) {
  const which = opt('--revoke');
  const list = listGrants(DATA_DIR);
  const kept = which ? list.filter((g) => shortBinding(g.binding) !== which) : [];
  const removed = list.length - kept.length;
  try {
    fs.writeFileSync(files(DATA_DIR).grants, JSON.stringify({ grants: kept }, null, 2));
  } catch (e) {
    die(`写不进去：${e.message}`);
  }
  if (removed) {
    await reportAudit({ event: 'local_confirm_rejected', tool: null, by: 'revoke', summary: `收回 ${removed} 张` });
  }
  out(removed ? `✓ 已收回 ${removed} 张授权` : `（没有匹配的授权可收回${which ? `：${which}` : ''}）`);
  process.exit(0);
}

if (has('--help') || has('-h')) {
  out('用法：approval confirm [--yes] [--list] [--revoke [短binding]] [--binding <sha256:…>] [--ttl 秒] [--by 标签] [--json]');
  out('');
  out('不带参数时确认「最近一次被拦下的命令」，会先把摘要打印出来让你核对。');
  process.exit(0);
}

// ── 签发 ──────────────────────────────────────────────────────────────────
let binding = opt('--binding');
let rec = null;

if (!binding) {
  rec = readBlocked(DATA_DIR);
  if (!rec) {
    die('没有「最近被拦下的命令」可确认。\n' +
      '  先让那条命令被拦一次（推送失败时 hook 会自动记下），\n' +
      '  或者显式指定：approval confirm --binding sha256:<...>\n' +
      `  （拦下的记录应出现在 ${path.relative(PROJECT_ROOT, files(DATA_DIR).blocked)}）`, 3);
  }
  binding = rec.binding;
}

if (!SECRET) {
  die(`读不到共享密钥（${path.relative(PROJECT_ROOT, path.join(DATA_DIR, 'secret'))}）。\n` +
    '  网关首次启动时会自动生成它；先跑一次 approval gw status 看看网关在不在。', 4);
}

const ttlSeconds = Number(opt('--ttl', DEFAULT_TTL_SECONDS)) || DEFAULT_TTL_SECONDS;
const autoYes = has('--yes');
const by = opt('--by', autoYes ? 'agent-after-dialog' : 'terminal');

// 让人能核对「我到底在放行什么」——这是整个流程里唯一一次人眼复核的机会。
if (!AS_JSON) {
  out('即将签发一张「只放行一次」的本机授权：\n');
  if (rec) {
    out(`  命令   ${rec.summary || '（无摘要）'}`);
    out(`  档位   ${rec.tier || '?'}`);
    out(`  原因   ${rec.reason || '（无）'}`);
    out(`  拦于   ${humanAge(Date.now() - (rec.at || Date.now()))}`);
  }
  out(`  绑定   ${binding}`);
  out(`  短号   ${shortBinding(binding)}   ← 只有绑定完全相同的命令才能用掉它`);
  out(`  有效期 ${ttlSeconds} 秒（${Math.round(ttlSeconds / 60)} 分钟）｜一次性｜签发者 ${by}`);
  out('');

  // 拦下很久之后才来确认，多半是搞错了对象 —— 值得挡一下，但不阻止（可用 --yes 跳过）。
  const ageMs = rec && rec.at ? Date.now() - rec.at : 0;
  if (ageMs > 30 * 60 * 1000) {
    note(`⚠️ 这条拦截记录是 ${humanAge(ageMs)}的。确认前请再看一眼上面的命令摘要。`);
  }
}

if (!autoYes) {
  const yes = await askYesNo('允许这一次吗？[y/N] ', 60000);
  if (!yes) {
    if (AS_JSON) out(JSON.stringify({ ok: false, error: 'user-cancelled' }));
    else note('**未签发**。什么都没改。');
    process.exit(1);
  }
}

const res = issueGrant(DATA_DIR, {
  secret: SECRET, binding, tool: rec?.tool || 'unknown',
  summary: rec?.summary || '', ttlSeconds, by,
});

if (!res.ok) die(`签发失败：${res.reason}`, 5);

const audited = await reportAudit({
  event: 'local_confirm_issued', tool: rec?.tool || null, tier: rec?.tier || null,
  binding, by, summary: rec?.summary || '',
});

if (AS_JSON) {
  out(JSON.stringify({
    ok: true, binding, short: shortBinding(binding),
    expiresAt: res.record.expiresAt, ttlSeconds, by, audited,
  }));
} else {
  out(`✓ 已签发：binding ${shortBinding(binding)}，${ttlSeconds} 秒内有效，只能用一次。`);
  out('  现在**重试刚才那条命令**即可 —— 推送失败时 hook 会放行这一次。');
  out(`  留痕：${path.relative(PROJECT_ROOT, files(DATA_DIR).log)}${audited ? ' + 网关审计' : '（网关不在，只写了本地）'}`);
  out('  收回：approval confirm --revoke');
}
process.exit(0);
