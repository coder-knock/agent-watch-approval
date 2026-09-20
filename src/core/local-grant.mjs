// 推送通道不可用时的「本机一次性确认」。
//
// 为什么需要这个文件
// ------------------
// 用户的原话：「推送到手表失败…已按 deny 处理，这个处理不对，如果推送失败，
// 请在 workbuddy 弹出选项供确认」。
//
// 直觉做法是让 hook 输出 `permissionDecision: "ask"` —— 语义上正好是
// 「交给宿主的原生权限框」。**但在本构建的 WorkBuddy 里这条路不通。**
// 两份独立代码 + 一次活体 A/B 都指向同一结论：
//
//   HookExecutor.parseHookOutput():
//     let ep = { allowed: 0 === eA, ... };        // 初值 = 「exit 0 即 allowed」
//     "deny"  === decision ? (ep.allowed = false)
//   : "allow" === decision && (ep.allowed = true);  // ← "ask" 没有分支
//
//   SessionToolManager.executePreToolUseHooks():
//     let ed = eu.allowed;
//     "deny" === el ? ed = false : "allow" === el && (ed = true);   // ← 同样漏掉 ask
//     return { allowed: ed, ... };                // 调用方只读 .allowed
//
//   （另：两处的 catch 都是 `{ allowed: true }` —— hook 自己崩了也是放行。）
//
// 也就是说：settings.json 里的 command 型 hook 只有两种有效结果 ——
//   `deny` → 拦住；**其余一切（`ask` / 空输出 / 崩溃）→ 放行**。
// `ask` 不但不弹框，反而等于静默放行。活体实测：L2 探针（`git push`）
// 在推送必然失败的情况下照常执行；L3 探针（`rm -rf <不存在路径>`）被拦住。
//
// 所以「给用户一个选项」只能这么实现：
//   ① hook 拦住（fail-closed），并让 **Agent 去调 AskUserQuestion**
//      —— 那是 WorkBuddy 真正的原生弹框（日志里的
//      `[HandleInterruptions] Approval dialog shown for tool: AskUserQuestion`）；
//   ② 用户选「允许这一次」→ Agent 跑 `approval confirm` 落一张一次性授权；
//   ③ 重试同一条命令时，hook 在推送**之前**先查这张表 → 命中就 allow。
//
// 这张表**不是安全边界**
// ----------------------
// 必须说清楚：本机的 agent 有能力读 `data/secret`、也有 TTY，所以它技术上
// 可以自己执行 `approval confirm`。这里做签名只是防止「手改文件」和表达意图，
// 不是防对抗。真正的安全边界仍然是「推送通道可达」。
// 因此每一次签发与消费都会**留痕**（本地日志 + 尽可能写网关审计），
// 让「有人用本地确认放行了什么」事后可查 —— 可见性才是这里的防线。
//
// 授权本身的强度（相对合理的部分）：
//   · 绑定到 actionBinding（tool + 规范化 input 的 sha256）—— 换一条命令就失效；
//   · 只能用一次（消费即删）；
//   · 有 TTL（默认 10 分钟）；
//   · HMAC 签名，光改文件不改签名过不了。

import fs from 'node:fs';
import path from 'node:path';
import { actionBinding, sign, safeEqual } from './bind.mjs';

export const DEFAULT_TTL_SECONDS = 600;

/**
 * 绑定「动作」，而不是「信封」。
 *
 * ⚠️ 这里踩过一个会让整个功能失效的坑（2026-09-19 活体实测）：
 * WorkBuddy 给 Bash 的 `tool_input` 里**除了 `command` 还有 `description`**，
 * 而 `actionBinding()` 会把整个 input 都算进哈希。于是 Agent 重试时
 * **只要把 description 换个说法**，绑定就变了 —— 实测：
 *
 *   {command, description:"跑一条 L2 探针验证推送失败时的处置"}  → 短号 0a9682（签发时）
 *   {command, description:"重试同一条命令验证一次性放行"}        → 短号 4bdaca（重试时）
 *
 * 现象是「`approval confirm --yes` 成功，重试同一条命令却仍然被拦」，
 * 而 reason 里的短号看起来还挺正常 —— 极难归因。
 *
 * 用户授权的是**要执行什么**，不是那句给日志看的描述。所以这张表用收紧后的绑定：
 * 只保留真正决定动作的字段。**这不是安全性削弱** —— 命令本身仍须逐字节相同。
 *
 * 注意：它与网关的 `actionBinding` 是**两个不同的用途**，不要混用。
 * 网关那个要覆盖整个 input（它自己的一致性校验用），这个只覆盖动作。
 */
const METADATA_KEYS = new Set(['description', 'timeout', 'run_in_background', 'runInBackground']);

export function grantBinding(tool, toolInput) {
  const t = String(tool || 'unknown');
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  // Bash 的动作就是 command 一个字段；其余全是我们（或 Agent）加的操作元数据。
  if (t === 'Bash') return actionBinding(t, { command: input.command ?? '' });
  const action = {};
  for (const [k, v] of Object.entries(input)) if (!METADATA_KEYS.has(k)) action[k] = v;
  return actionBinding(t, action);
}

/** 展示用的短绑定串（像 git 的短 hash，便于人核对是哪一条命令）。 */
export function shortBinding(binding) {
  return String(binding || '').replace(/^sha256:/, '').slice(0, 6);
}

export function files(dataDir) {
  return {
    grants: path.join(dataDir, 'local-grants.json'),
    blocked: path.join(dataDir, 'blocked-last.json'),
    log: path.join(dataDir, 'local-confirm.log'),
  };
}

/**
 * 与网关一致的 dataDir 解析：读 config.json 的 dataDir，默认 ./data，
 * 相对项目根目录。读不到就退回默认值 —— 这个模块绝不能因为配置缺失而抛。
 *
 * `APPROVAL_DATA_DIR` 优先于 config.json：这是给测试用的（测试不该往真实
 * data/ 里写 blocked-last.json），也给「同一个 hook 想指到别的库」留个出口。
 */
export function resolveDataDir(projectRoot) {
  const override = process.env.APPROVAL_DATA_DIR;
  if (override) return path.resolve(override);
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'config.json'), 'utf8'));
    return path.resolve(projectRoot, cfg.dataDir || './data');
  } catch {
    return path.resolve(projectRoot, 'data');
  }
}

function readJson(file, fallback) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' ? j : fallback;
  } catch {
    return fallback;
  }
}

/**
 * 写盘一律不抛。理由与 store.mjs 一致：这个模块被 2 秒级/hook 级路径调用，
 * 一个 EPERM 不该把调用方带走。失败只返回错误对象，由调用方决定怎么吱声。
 */
function writeJson(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    try {
      fs.renameSync(tmp, file);
    } catch {
      // 改名失败（权限策略）就退化覆盖写 —— 可用性优先于原子性
      fs.writeFileSync(file, JSON.stringify(obj, null, 2));
    }
    return null;
  } catch (e) {
    return e;
  }
}

function appendLog(dataDir, line) {
  try {
    const { log } = files(dataDir);
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.appendFileSync(log, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* 留痕失败不阻断主流程 */
  }
}

// ── 被拦下的动作（供 approval confirm 使用）────────────────────────────────

/**
 * 记下「最近一次因为送不到你手上而被拦住的命令」。
 * approval confirm 不带参数时就是确认这一条。
 */
export function rememberBlocked(dataDir, rec) {
  const payload = {
    binding: rec.binding,
    tool: rec.tool,
    tier: rec.tier,
    summary: rec.summary || '',
    reason: rec.reason || '',
    approvalId: rec.approvalId || null,
    // 网关算的那个（覆盖整个 tool_input）—— 只作交叉引用，**不参与匹配**。
    // 两者不同是正常的：详见 grantBinding() 的注释。
    gatewayBinding: rec.gatewayBinding || null,
    at: Date.now(),
  };
  const err = writeJson(files(dataDir).blocked, payload);
  appendLog(dataDir, `blocked tool=${rec.tool} tier=${rec.tier} binding=${shortBinding(rec.binding)}`);
  return err;
}

export function readBlocked(dataDir) {
  const j = readJson(files(dataDir).blocked, null);
  return j && j.binding ? j : null;
}

// ── 一次性授权 ────────────────────────────────────────────────────────────

function readGrants(dataDir) {
  const j = readJson(files(dataDir).grants, { grants: [] });
  return Array.isArray(j.grants) ? j.grants : [];
}

/** 顺手清掉已过期的，避免文件无限长。 */
function prune(list, now = Date.now()) {
  return list.filter((g) => g && typeof g.expiresAt === 'number' && g.expiresAt > now);
}

export function issueGrant(dataDir, opts) {
  const {
    secret,
    binding,
    tool = 'unknown',
    summary = '',
    ttlSeconds = DEFAULT_TTL_SECONDS,
    by = 'local',
  } = opts || {};
  if (!secret) return { ok: false, reason: '缺少 secret（data/secret 不存在？）' };
  if (!binding) return { ok: false, reason: '缺少 binding' };

  const now = Date.now();
  const record = {
    binding,
    tool,
    summary: String(summary).slice(0, 200),
    issuedAt: now,
    expiresAt: now + Math.max(30, Number(ttlSeconds) || DEFAULT_TTL_SECONDS) * 1000,
    by,
  };
  record.sig = sign(secret, [record.binding, record.issuedAt, record.expiresAt, record.by]);

  const list = prune(readGrants(dataDir), now).filter((g) => g.binding !== binding);
  list.push(record);
  const err = writeJson(files(dataDir).grants, { grants: list });
  if (err) return { ok: false, reason: `写不进去：${err.message}` };

  appendLog(dataDir, `issue binding=${shortBinding(binding)} tool=${tool} ttl=${ttlSeconds}s by=${by}`);
  return { ok: true, record };
}

/**
 * 消费一张授权：命中即删（单次），并校验签名与有效期。
 * 返回值一律是对象，绝不抛。
 */
export function consumeGrant(dataDir, opts) {
  const { secret, binding } = opts || {};
  const list = readGrants(dataDir);
  if (!list.length) return { ok: false, reason: 'no-grant' };

  const now = Date.now();
  const kept = [];
  let hit = null;
  for (const g of list) {
    if (!hit && g && g.binding === binding) {
      hit = g;
      continue; // 命中即从列表里摘掉（无论后面校验是否通过 —— 一律作废，防重放）
    }
    kept.push(g);
  }

  if (!hit) {
    const pruned = prune(list, now);
    if (pruned.length !== list.length) writeJson(files(dataDir).grants, { grants: pruned });
    return { ok: false, reason: 'no-grant' };
  }

  writeJson(files(dataDir).grants, { grants: prune(kept, now) });

  if (!secret) return { ok: false, reason: 'no-secret' };
  const want = sign(secret, [hit.binding, hit.issuedAt, hit.expiresAt, hit.by]);
  if (!safeEqual(hit.sig || '', want)) {
    appendLog(dataDir, `REJECT bad-sig binding=${shortBinding(binding)}`);
    return { ok: false, reason: 'bad-sig' };
  }
  if (typeof hit.expiresAt !== 'number' || now > hit.expiresAt) {
    appendLog(dataDir, `REJECT expired binding=${shortBinding(binding)}`);
    return { ok: false, reason: 'expired' };
  }

  appendLog(dataDir, `consume binding=${shortBinding(binding)} tool=${hit.tool} by=${hit.by}`);
  return { ok: true, record: hit };
}

/** 列出当前有效的授权（给人看）。 */
export function listGrants(dataDir) {
  return prune(readGrants(dataDir));
}

/** 读共享密钥。读不到返回 null —— 调用方据此走 fail-closed。 */
export function readSecret(dataDir) {
  try {
    return fs.readFileSync(path.join(dataDir, 'secret'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}
