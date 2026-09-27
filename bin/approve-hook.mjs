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
// 「确认送不到你手上」时（推送 500 / 网关失联 / 网关非 2xx）一律 fail-closed
// **输出 deny**，但 deny 不等于「什么都不做地拒掉」—— 降级会继续走，顺序是：
//
//   ① 查 data/local-grants.json 里的一张**本机一次性授权** —— 你在 WorkBuddy 的
//      弹框里点过「允许这一次」之后由 `approval confirm` 落下的。命中就放行
//      （且只能消费一次）。这一步在所有策略之前，不受任何开关影响。
//   ② 默认策略（`ask_user`）：deny 的 reason 带上 `[approval: action_required=ask_user]`
//      标记与两步指令 → 由 Agent 调 **AskUserQuestion** —— 那才是宿主
//      **原本的询问方式**（走 HandleInterruptions 那个原生确认框）。
//      整个降级过程都由宿主的原生 UI 承担询问，这套 hook 不另造确认界面。
//   ③ 可选策略（`APPROVAL_PUSH_FAIL_POLICY=local`）：转场到网关自带的
//      /phone.html（先探可达再开），你在那一页点一下，决策经 /v1/decision 带回。
//      这是唯一一条能把决策直接带回来的兜底。
//   ④ 都不成 → 就停在 deny，并把这条写进 data/blocked-last.json。
//
// ⚠️ 为什么默认不是 `permissionDecision:"ask"`：ask 的效果**取决于权限模式**
// （在需要审批的场景确实会弹框，但在沙箱快速路径上宿主本来就不问人，它不阻止
// 执行）。deny 的行为不依赖模式，而「用原本的方式询问」这件事由 ② 的
// AskUserQuestion 承担 —— 既不赌模式，也不丢询问。
// 完整的两层机制见下面 RAW_FALLBACK 那一段。
//
// 另一个用法：作为 Stop / Notification hook 的发信器
//   approve-hook --notify "任务已完成" ["补充说明"]

import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
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
import * as macAlert from '../src/core/mac-alert.mjs';

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

// 「确认没能送到你手上」时 hook 输出什么。这是**最关键的一个开关**。
//
// 取值：'deny'（默认） | 'ask' | 'allow'
//
// ── `ask` 到底是什么意思：两层机制，两处都别过度概括 ────────────────────────
//
// 这个注释在两天里被改过三次，每次都是因为只看到了一半。现在的结论是
// **两句并存的**，缺任何一句都会得出错误结论：
//
//   第一句：`ask` 自己**不拦**。
//     executePreToolUseHooks()（settings.json 的 command 型 hook 走这条）：
//       let ed = eu.allowed;                       // eu = hookManager.executeHooks 的结果
//       return "deny" === el ? ed = !1
//            : "allow" === el && (ed = !0),        // ← 只有这两个分支
//              { allowed: ed, permissionDecision: el, … };
//     调用方只判 `if (!ew.allowed) { …block… }`。所以 ask 时 allowed 停在
//     初值 true → **这一步不会拦住命令**。
//
//   第二句：但 `ask` **会被读到，并且禁止自动放行**。
//       hasForcedAskDecision(eA, el) {
//         return this.getCachedPreToolUseResult(eA, el)?.permissionDecision === "ask"
//       }
//       canAutoApproveInBypassMode(…) { return !(… || this.hasForcedAskDecision(eA, el)) && … }
//       canUseCachedApproval(…)        { return !this.hasForcedAskDecision(eA, el) && … }
//     读的就是我们给的那个字段。它的作用是让宿主**不自动批、不复用缓存批准**，
//     于是落回宿主常规的权限流程 —— 那一步才是弹框的地方
//     （HandleInterruptions → `Approval dialog shown for tool: …`）。
//
// **合起来：`ask` 的语义是「禁止自动放行，交回宿主常规权限流程」，
//   而它到底会不会变成一个框，取决于宿主原本会不会问你：**
//
//   · 在需要审批的场景（bypass 模式 / 有缓存批准 / 工具本身要批准）→ 真的弹框。
//     用户实测：**确实会弹**。（这一点曾经被我判定为「不可能」，是错的。）
//   · 在沙箱快速路径上 → 宿主自己就打了
//       `[BashTool] sandbox path active, skipping 8-Phase permission check`
//     也就是说它**本来就不打算问任何人**，ask 变不出框来，命令照跑
//     （日志同处 `prompted=false`）。SETUP.md 那次活体 A/B 记的就是这种情形。
//
// 所以两边都别把话说满：不是「ask 必弹框」，也不是「ask 等于放行」。
// **要不要用 ask，取决于你关心的那一档工具在你的权限模式下走的是哪条路。**
//
// ── 那这个开关的默认值怎么定 ──────────────────────────────────────────────
//
//   deny（默认）—— 两个档位都是 deny，理由不是「ask 没用」，而是
//   **deny 的行为不依赖权限模式**。这台机器上还有另一条更完整的兜底
//   （见下面「降级怎么走」），它不赌宿主当时会不会弹框。
//   要改请显式设 APPROVAL_FALLBACK_L2/L3，让它是**你做过的**决定。
//
// ── 降级怎么走：用「原本的方式询问」，而不是干拒 ─────────────────────────────
//
// deny 不等于「什么都不做地拒掉」。默认策略（APPROVAL_PUSH_FAIL_POLICY 不设
// 时取 'ask_user'）会让 deny 的 reason 带上标记与可执行的下一步：
//
//   [approval: action_required=ask_user]      ← Agent 的循环靠这一行 grep
//   …已拦住而不是放行：<那条命令>
//   下一步：① 用 AskUserQuestion 问「是否允许执行：<命令>？」；
//          ② 你选「允许这一次」后执行 `approval confirm --yes`（绑定 xxx）；
//          ③ 重试**逐字节相同**的那条命令。
//
// 关键点：**AskUserQuestion 才是宿主「原本的询问方式」**（它走的就是
// HandleInterruptions 那个原生确认框，日志里的
// `Approval dialog shown for tool: AskUserQuestion`）。于是链路变成
// 「hook 拦住 → Agent 弹原生框问你 → 你确认 → 落一张一次性授权 → 重试放行」——
// 从头到尾都由宿主的原生 UI 承担询问，这套 hook 不另造一个确认界面。
//
// 兜底值的来源只有一处：环境变量（settings.json 里给 hook 加的那行）。
//
// ⚠️ config.json 里曾经有个 `defaults.gatewayUnreachable` 与它语义重复，
// 但**没有任何代码读它** —— 一个调不动的开关，而它的值正好是最危险的那个
// （`L2: "ask"`）。SETUP.md 还照着它写「头一周设成 ask」。
// 它已被删掉：配置里不该留一个「看起来能调、其实没接线」的旋钮，
// 因为下一次有人照着它调参时，得到的行为和文档承诺的完全不一样。
const RAW_FALLBACK = {
  L2: process.env.APPROVAL_FALLBACK_L2,
  L3: process.env.APPROVAL_FALLBACK_L3,
};
const DEFAULT_FALLBACK = 'deny'; // fail-closed，且行为不依赖权限模式
const fallbackWarned = new Set();

function fallbackFor(t) {
  const raw = String(RAW_FALLBACK[t] ?? DEFAULT_FALLBACK).trim().toLowerCase();
  if (raw === 'deny') return 'deny';
  if (raw === 'allow') return 'allow';
  if (raw === 'ask') {
    // 不硬性拒绝（用户实测它确实会弹框），但要把「取决于权限模式」说清楚，
    // 否则下一次在沙箱快速路径上遇到「怎么直接跑了」时无从下手。
    if (!fallbackWarned.has('ask-' + t)) {
      fallbackWarned.add('ask-' + t);
      progress(
        `⚠️ APPROVAL_FALLBACK_${t}=ask：ask 的效果**取决于权限模式** —— 在需要审批的\n` +
        `        场景会真的交回宿主确认框；但在沙箱快速路径（宿主日志里的\n` +
        `        "sandbox path active, skipping 8-Phase permission check"）上，\n` +
        `        宿主本来就不问人，ask 不会阻止执行。若你要的是「一定拦住」，用 deny。`
      );
    }
    return 'ask';
  }
  if (!fallbackWarned.has(t)) {
    fallbackWarned.add(t);
    progress(`⚠️ APPROVAL_FALLBACK_${t}=${raw} 不是合法值（deny / ask / allow），按 deny 处理。`);
  }
  return 'deny';
}

// ── 推送失败 / 网关不可达时的处置策略 ──────────────────────────────────────
//
// 允许的值：
//   'ask_user' —— **默认**。deny + reason 带 `[approval: action_required=ask_user]`
//                 标记与两步指令 → 由 Agent 调 AskUserQuestion，用宿主的原生
//                 确认框问你一次（「降级也用原本的方式询问」）。
//   'local'    —— 转场到网关自带的本地审批页（浏览器），你在页面上点。
//                 这条是**唯一一条能把决策直接带回来**的兜底：页面按钮 POST
//                 /v1/decision，走的是与手机完全同一条回程。
//                 代价是它不等价于「问你一句」，所以不设为默认。
//   'deny'     —— 纯 deny reason，不带标记、不给下一步。
//   'ask'      —— 输出 permissionDecision:"ask"，交给宿主确认框。
//                 ⚠️ 注意上面那两层机制：它在沙箱快速路径上不阻止执行。
//
// ⚠️ 不显式设这个变量时，三条降级路径（网关非 2xx / 网关不可达 / 推送失败）
// **统一走 'ask_user'** —— 这样不会出现「同一个原因、两种处置」这种最难排查的
// 分裂（SETUP.md 记过一次：FALLBACK 曾硬编码在三处、只有一处生效）。
const PUSH_FAIL_POLICY = String(process.env.APPROVAL_PUSH_FAIL_POLICY || '').trim().toLowerCase();
const PUSH_FAIL_POLICY_VALID = new Set(['deny', 'ask', 'local', 'ask_user']);
/** 未设 / 非法值时统一采用的策略。 */
const PUSH_FAIL_POLICY_DEFAULT = 'ask_user';

/**
 * 解析出这次要用哪条降级策略。
 *
 * 优先级（**顺序不能反**）：
 *   ① 显式设了 APPROVAL_PUSH_FAIL_POLICY → 用它。
 *   ② 否则，若用户显式设了 APPROVAL_FALLBACK_L2/L3 → 尊重它。
 *      这一条必须排在 ③ 前面，否则那个旋钮在降级路径上就失效了 ——
 *      正是 SETUP.md 记过的「设了不生效」的老毛病（FALLBACK 曾被硬编码绕过）。
 *   ③ 两者都没设 → `ask_user`：拦住 + 让 Agent 用 AskUserQuestion 问一次。
 *
 * ⚠️ 这里踩过一次：最初写成「先取 fallbackFor(tier)，它合法就用它」——
 * 而 fallbackFor 总是返回 deny/ask/allow 之一，于是那个分支**恒真**，
 * `ask_user` 默认值永远到不了，整个默认策略静默失效。判断依据必须是
 * 「用户有没有显式设过环境变量」，而不是「fallbackFor 返回了合法值」。
 */
function degradePolicyFor(tier) {
  if (PUSH_FAIL_POLICY_VALID.has(PUSH_FAIL_POLICY)) return PUSH_FAIL_POLICY;
  const raw = RAW_FALLBACK[tier];
  if (raw !== undefined && String(raw).trim() !== '') return fallbackFor(tier);
  return PUSH_FAIL_POLICY_DEFAULT;
}

/**
 * 策略 → 最终 emit 的 permissionDecision。
 *
 * 只有 `ask` / `allow` 两个显式策略会改变判定；`deny` / `ask_user` / `local`
 * 一律以 **deny** 收口 —— 「降级」这条路上没有任何一条会变成放行。
 */
function decisionForPolicy(policy) {
  if (policy === 'ask') return 'ask';
  if (policy === 'allow') return 'allow';
  return 'deny';
}

/**
 * 拼出「降级时」给你的那几行 reason。
 *
 * 为什么单独抽出来：这几行此前只写在「推送失败」那一条路径上，
 * 于是「网关不可达」和「网关非 2xx」两条路只丢一句冷冰冰的原因 ——
 * 用户的原话是「只有提醒，不能确认」。三条路径现在共用同一段措辞。
 *
 * ⚠️ 措辞要跟着策略走，不能写死。「已拦住而不是放行」对 policy=deny/ask_user
 * 是对的，但 policy=ask 时它明明是交回宿主确认框、policy=allow 时更是真的放行了
 * —— 写死会让 reason 与真实判定相反，而 reason 是事后回溯的唯一线索。
 * 这个错被上面的验证脚本抓到过一次（decision=allow 却写着「已拦住」）。
 *
 * @param {string} cause     出什么事了（不含结论）
 * @param {string} body      要执行的那条命令（给人看的描述）
 * @param {string} bindingShort 短绑定号，写进指令里方便人核对是哪条命令。
 */
function degradeReasonLines({ policy, cause, body, bindingShort = '' }) {
  const lines = [];
  // 标记必须是**第一行**：Agent 的循环靠 reason.startsWith(...) 判定。
  if (policy === 'ask_user') lines.push('[approval: action_required=ask_user]');
  const tail =
    policy === 'ask' ? '已交回宿主权限确认，请在那里决定是否执行'
      : policy === 'allow' ? '已按显式配置放行'
        : '已拦住而不是放行';
  lines.push(`${cause}，${tail}：${body}`);
  if (policy === 'ask_user') {
    lines.push(
      '下一步：① 用 AskUserQuestion 问一句「是否允许执行上面这条命令？」；'
      + '② 用户选「允许这一次」后执行 `approval confirm --yes --json`'
      + (bindingShort ? `（绑定 ${bindingShort}）` : '')
      + '，并重试**逐字节相同**的那条命令'
      + '（本机一次性授权只能消费一次，重试的 tool_input 必须一致）。'
    );
  }
  return lines;
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

// ── 「确认没送到你手上」时的本地喊话 ────────────────────────────────────────
//
// 为什么要喊：这条分支的旧行为是**只写 stderr + 一条 blocked-last.json**。
// 而 stderr 被宿主收走、blocked-last.json 要等 Agent 主动去读 —— 两处都
// 不是「你」看得见的地方。实测后果：命令被拒了十几条、每条都留了痕，
// 而用户在终端上什么都没看到，只感觉「Agent 突然不干活了」。
//
// 所以这里补一条 Mac 本地提醒。这不是「锦上添花的通知」，它承担的是
// **把静默失败变成可见失败**的职责 —— fail-closed 只有在用户知情时才叫安全，
// 不知情的 fail-closed 只是坏掉。
//
// 三点刻意的约束：
//   1. **不阻塞判定**。提醒是 best-effort，发不出去也照常 deny。
//      绝不能让「喇叭坏了」影响「门有没有关上」。
//   2. **不进 stdout**。stdout 是 hook 的 JSON 通道，往里写人类可读文本
//      会把 deny 洗成「没有决定」= 静默放行（见上面 progress 的长注释）。
//   3. **只发一条**。醒目度靠声音和位置，不靠条数 —— 连发多条在
//      push_failed 累计 81 次的现实下会变成一场雪崩，反而没人看。
function shoutLocally({ tier, body, reason }) {
  if (String(process.env.APPROVAL_MAC_NOTIFY || '1') === '0') return;
  try {
    const how =
      tier === 'L3'
        ? '高危操作，不会自动放行 —— 只能回到桌面重新决定。'
        : '要让这一次跑下去，让 Agent 用弹框问你一句，你选「允许这一次」后它会重试这条命令。';
    macAlert.notify({
      title: '🚫 Agent 命令被拦住了',
      subtitle: `腕上确认没送到（${reason || '未知原因'}）`,
      body: `${body}\n\n${how}`,
      level: 'loud',
      repeat: 1,
      // 不抢前台：转场确认时前台应该是浏览器（审批页）。
      withActivate: false,
    });
  } catch {
    /* 喊不出去也不能影响判定 —— 判定已经由下面的 emit 定死了 */
  }
}

// ── 转场本地确认 ────────────────────────────────────────────────────────────
//
// 这是「推送失败」的正解：**不是拒掉，而是换一条能真做决定的路。**
//
// ── 为什么必须是浏览器页面，而不是系统弹框（实测记录，2026-09-20）─────────
//
//   `osascript display dialog`  第一次探针返回过 `__timeout__`，
//       但之后连续四次（两按钮 / 三按钮各两次）**全部 ETIMEDOUT 挂死**，
//       25 秒都不返回。它在「由后台进程触发」这个位置上是不可靠的。
//   `osascript display alert`   从第一次起就挂死。
//
// 偶发可用、常态挂死的东西**比干脆没有更糟**：它会让 hook 白白卡满预算，
// 最后照样 deny，还额外制造一个「进程卡住」的假象。所以模态弹框出局。
//
// ── 浏览器页面这条路的四个实打实的好处 ────────────────────────────────────
//
//   1. 网关**已经**提供了 public/phone.html，按钮直接 POST /v1/decision ——
//      走的是与手机完全同一条回程，不需要新造任何决策通路，也不用碰签名。
//   2. 它是**长期存在**的一页：收到 `?focus=<id>` 会把那条置顶高亮，
//      并且每 1.5 秒自动刷新。于是连续几条待确认会堆在**同一个页面**里，
//      而不是一次事件弹一个窗 —— 这正是「弹出的运行项太多」的解药。
//   3. 它不受横幅那套「专注模式会吞掉」的限制。
//   4. 打开动作本身就是醒目 —— 浏览器会被带到前台。
//
// 安全上没有新增暴露面：`?k=` 口令沿用 phoneAccessKey，决策仍靠 actionId
// 里的一次性 nonce + HMAC 签名（见 gateway.mjs 里那两处页面注释）。

// ⚠️ 文件名刻意不叫 local-confirm.*：`data/local-confirm.log` 是
// local-grant.mjs 里 consumeGrant 的流水账（记「哪张本机授权被用掉了」），
// 两者只是恰好都属于「本机确认」这个主题，混在一起会让人误读。
const LOCAL_CONFIRM_STATE = path.join(DATA_DIR, 'handoff-state.json');
// 同一个页面 30 秒内只打开一次。页面每 1.5 秒刷新、会把新的待确认项自动
// 纳入列表，所以「不重复打开」不会漏掉任何一条 —— 只是不再多开标签页。
const HANDOFF_MIN_GAP_MS = Math.max(0, Number(process.env.APPROVAL_HANDOFF_GAP_SECONDS || 30)) * 1000;
// 熔断：连续 N 次转场都**没人决策**，就认定你不在电脑前，不再转场。
// 否则每条 L2 都要空等满 TTL 才 deny，Agent 会像死了一样。
const HANDOFF_MAX_UNANSWERED = Math.max(1, Number(process.env.APPROVAL_HANDOFF_MAX_UNANSWERED || 3));

function readHandoffState() {
  try {
    const j = JSON.parse(fs.readFileSync(LOCAL_CONFIRM_STATE, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function writeHandoffState(s) {
  try {
    fs.mkdirSync(path.dirname(LOCAL_CONFIRM_STATE), { recursive: true });
    fs.writeFileSync(LOCAL_CONFIRM_STATE, JSON.stringify(s, null, 2));
  } catch {
    /* 状态写不进去只影响节流效果，不该影响判定 */
  }
}

/**
 * 组出本地审批页地址。
 *
 * 基址用 `GATEWAY`（= APPROVAL_GATEWAY_URL，默认 http://127.0.0.1:7788），
 * **不另读 config.json 的 port** —— 理由：这个 hook 连的是哪个网关，审批页
 * 就应该在哪个网关上。两处各读各的配置时，一旦有人用 APPROVAL_GATEWAY_URL
 * 指向别处（换端口、跑第二个实例、测试用 mock），页面地址就会指向一个
 * 「其实是别的服务」的端口，于是要么 401、要么开到别人的页面上。
 * 口令仍然从 config.json 读 —— 那是网关自己的配置，只有一个来源。
 */
function localConfirmUrl(id) {
  let key = '';
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'config.json'), 'utf8'));
    key = String((((cfg.channels || {}).ha || {}).phoneAccessKey) || '');
  } catch {
    /* 读不到就用空口令；页面若要求口令会 401，探测那一步会拦住，不会开废标签页 */
  }
  const q = new URLSearchParams({ focus: id });
  if (key) q.set('k', key);
  return `${GATEWAY}/phone.html?${q}`;
}

/**
 * 探测本地审批页是否**真的**在那儿。
 *
 * 为什么必须先探再开（实测踩到，2026-09-20）：`open <url>` 对任何 URL 都返回 0
 * —— 它只负责「交给浏览器」，不负责那个地址有没有内容。于是当端口配错、
 * phoneAccessKey 变了（页面会 401）、或者网关压根没在跑时，我们会**照样弹一个
 * 浏览器窗口**，里面是一条 401 / 连不上。用户看到的就是「它又弹了个没用的窗」，
 * 而这正是「弹出的运行项太多」里最烦人的那一种：既没用又不可忽略。
 *
 * 判据用「是不是我们自己那一页」而不是只看状态码：
 *   · HTTP 200
 *   · content-type 含 text/html
 * 两条都满足才认为可以打开。宁可退回 fail-closed，也不要开一个废标签页。
 */
// 把 URL 里的访问口令抹掉。`handoff-state.json` 是给人排查用的（「为什么没转场成？」
// 第一眼就是看这里），而排查记录经常被贴进日志或对话里 —— 口令不该跟着走。
// 注意只抹口令，focus / 其余参数保留：那些才是排查真正要看的。
function maskKey(url) {
  return String(url || '').replace(/([?&]k=)[^&]*/g, '$1***');
}

async function probeLocalConfirmPage(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2500), redirect: 'manual' });
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
    const ct = String(res.headers.get('content-type') || '');
    if (!ct.includes('text/html')) return { ok: false, why: `不是 HTML（${ct || '无 content-type'}）` };
    // 再确认一下是我们那张页面，而不是某个代理/门户页。
    const html = await res.text();
    if (!/<!doctype html|<html/i.test(html)) return { ok: false, why: '返回的不是 HTML 文档' };
    return { ok: true };
  } catch (e) {
    return { ok: false, why: e.name === 'TimeoutError' ? '探测超时' : e.message };
  }
}

/**
 * 把一条待确认**转场到本地审批页**。
 *
 * 返回 `{ ok, detail, url? }`。
 *   `ok: true`  —— 已经给你开好了确认入口，调用方应当**继续等待**而不是 deny。
 *   `ok: false` —— 调用方必须走原来的 fail-closed 路径。
 *
 * ⚠️ 这条通道**绝不允许**把「没能提供确认入口」变成「放行」。
 * 它只做一件事：把「无路可走」换成「有一条路」。
 */
async function handoffToLocal({ id, tier, body }) {
  if (!id) return { ok: false, detail: '没有 approval id，无从转场' };
  if (String(process.env.APPROVAL_LOCAL_HANDOFF || '1') === '0') {
    return { ok: false, detail: '转场被 APPROVAL_LOCAL_HANDOFF=0 关掉了' };
  }

  const st = readHandoffState();
  const now = Date.now();
  const unanswered = Number(st.unanswered || 0);

  if (unanswered >= HANDOFF_MAX_UNANSWERED) {
    return {
      ok: false,
      detail:
        `已连续 ${unanswered} 次转场无人确认（你在电脑前吗？），暂不再转场。` +
        `在浏览器里打开一次审批页并做一次决策即可复位；或用 APPROVAL_HANDOFF_MAX_UNANSWERED 调整。`,
    };
  }

  const sinceLast = now - Number(st.lastOpenAt || 0);
  const pageProbablyOpen = sinceLast < HANDOFF_MIN_GAP_MS;

  let url = '';
  let opened = false;
  let openError = '';
  if (!pageProbablyOpen) {
    url = localConfirmUrl(id);
    // ★ 先探再开。探测不过就直接判失败 —— 不开废标签页。
    const probe = await probeLocalConfirmPage(url);
    if (!probe.ok) {
      return { ok: false, detail: `本地审批页不可用（${probe.why}）：${url}` };
    }
    const r = spawnSync('/usr/bin/open', [url], { timeout: 5000, stdio: 'ignore' });
    opened = !r.error && r.status === 0;
    if (!opened) openError = r.error ? r.error.message : `open 退出码 ${r.status}`;
    if (opened) {
      writeHandoffState({
        ...st,
        lastOpenAt: now,
        opened: Number(st.opened || 0) + 1,
        unanswered: unanswered + 1,
        lastUrl: maskKey(url),
        lastAt: now,
        lastTier: tier,
        lastBody: String(body || '').slice(0, 200),
      });
    }
  }

  if (!opened && !pageProbablyOpen) {
    return { ok: false, detail: `打不开本地审批页（${openError || '未知原因'}）` };
  }

  macAlert.notify({
    title: '👉 请在本机确认',
    subtitle: '腕上确认没送到，已为你打开本地审批页',
    body:
      `${String(body || '').slice(0, 120)}\n\n` +
      '在浏览器那一页点「仅此一次」或「本会话内允许」即可放行；不理它则超时按拒绝处理。',
    level: 'loud',
    repeat: 1,
    withActivate: false,
  });

  return {
    ok: true,
    detail: pageProbablyOpen
      ? `审批页应当已经开着（${Math.round(sinceLast / 1000)} 秒前打开），新条目会自行出现在列表里`
      : '已打开本地审批页',
    url: url || localConfirmUrl(id),
  };
}

/** 转场之后无论结果如何都要结算一次熔断计数。 */
function settleHandoff(decided) {
  try {
    const st = readHandoffState();
    if (decided) {
      // 你做了决策 → 说明你在，计数清零，下一次转场重新可用。
      writeHandoffState({ ...st, unanswered: 0, lastDecidedAt: Date.now() });
    } else {
      writeHandoffState({ ...st, lastTimeoutAt: Date.now() });
    }
  } catch {
    /* ignore */
  }
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
    // 这一支在本项目的 settings.json 里没有注册（只挂了 PreToolUse），
    // 但既然要支持 ask，就两支保持一致 —— 宿主自己内部算权限时用的也是
    // `{ behavior: "ask", message, decisionReason }` 这个形状
    // （见 ToolPermissionService 的 alwaysApprovalTools 分支）。
    const behavior = decision === 'allow' ? 'allow' : decision === 'ask' ? 'ask' : 'deny';
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior, message: reason },
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
//
// 三条**共用同一个策略解析**（degradePolicyFor）与同一段 reason 措辞
// （degradeReasonLines），默认都是 deny + `[approval: action_required=ask_user]`
// 标记 → 由 Agent 调 AskUserQuestion 用宿主的原生确认框问你。
//
// 为什么必须共用：SETUP.md 记过一次事故 —— FALLBACK 曾被硬编码在三处，
// 结果「同一个原因、两种处置」：只有一条路径生效，另两条静默走另一套。
// 那种分裂在排查时几乎无法定位（你改的那个开关根本没接线）。
//
// 注意「超时未确认」**不在这里** —— 那是策略默认（恒 deny，不走任何策略开关），
// 因为「看到了但没答」与「没送到」是两件不同的事。

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
    // 网关活着但拒绝了这次创建（配置错、内部 500、鉴权失败…）。
    // 这条同样是「静默失败」的一种 —— 只写 stderr 的话，用户看到的现象
    // 就是「Agent 忽然不执行命令了」，而原因在两个看不见的地方。
    const policy = degradePolicyFor(tier);
    shoutLocally({ tier, body, reason: `网关返回 ${status}` });
    emit(makeOutput(eventName, decisionForPolicy(policy),
      degradeReasonLines({
        policy,
        cause: `确认网关返回 ${status}（${json.error || '未知错误'}）`,
        body,
        bindingShort: shortBinding(grantBinding(toolName, toolInput)),
      }).join('\n')));
  }

  // 卡片建出来了，但**没送到你手上**（手表 500 / 通道离线 / 设备掉线）。
  //
  // 处置顺序是从「最省事」到「最后手段」：
  //
  //   ① 本机一次性授权 —— 你刚在 WorkBuddy 弹框里点过「允许这一次」，
  //      `approval confirm` 把它落在 data/local-grants.json，绑定到同一条命令。
  //      命中即放行（且只能消费一次）。**这一步不受任何策略开关影响。**
  //   ② policy=ask（显式开启才有）—— 输出 `permissionDecision:"ask"`，
  //      交给宿主自己的确认框。⚠️ 它的效果取决于权限模式，见上方 RAW_FALLBACK。
  //   ③ policy=local（显式开启才有）—— 转场到网关自带的审批页
  //      （public/phone.html，先探可达再开），你在浏览器里点一下，
  //      决策走 `/v1/decision` 回来，由下面的等待循环结算。
  //   ④ **默认走这里**（policy=ask_user）—— 拦住，并在 reason 里带上
  //      可 grep 的标记与两步指令：由 Agent 调 **AskUserQuestion**
  //      弹宿主自己的原生框问你，确认后落一张一次性授权、重试放行。
  //      也就是说「降级也是用原本的方式询问」，只是询问改由 Agent 发起。
  //
  // 为什么 ② / ③ 不是默认：
  //   · ② 赌宿主当时会不会弹框（沙箱快速路径上不会）；
  //   · ③ 要开一个浏览器标签页，代价比「问你一句」大得多，而且早年实测
  //     「一次事件弹一个窗」正是用户反馈的「弹出的运行项太多」。
  //   两者都保留成显式选项，默认选行为最确定的那条。
  let handoffUsed = null;
  if (json.pushOk === false && json.verdict !== 'allow') {
    const policy = degradePolicyFor(tier);
    const deviceOffline = json.deviceOffline === true;
    const pushReason = json.pushFailureReason || (deviceOffline ? 'device_offline' : 'unknown');
    // ⚠️ 用 grantBinding（只绑动作），**不要**用 json.binding / actionBinding。
    // 后者把整个 tool_input 算进去，而 WorkBuddy 给 Bash 的 input 里带 description
    // —— Agent 重试时改一句描述就会让绑定变掉，授权永远命中不了。详见 local-grant.mjs。
    const binding = grantBinding(toolName, toolInput);

    // ── ① 本机一次性授权 ──
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

    // ── ② policy=ask：交回宿主的原生确认框（显式开启）──
    //
    // 为什么这条**不做本地审批页转场**：宿主马上就要弹框了，再开一个浏览器
    // 页面就是两条提醒同时问你同一件事。两者是替代关系，不是叠加关系。
    if (policy === 'ask') {
      await reportAudit({
        event: 'handback_to_host', tool: toolName, tier, binding,
        by: 'hook', summary: body,
      });
      // 判定权已经交回宿主，网关这条待确认不会再有人点它，撤销掉，
      // 免得它在 pending 里当幽灵卡片、最后被记成「超时未确认」。
      await abandonGatewayRecord(json.id, 'handback-to-host');
      emit(makeOutput(eventName, 'ask',
        `腕上确认没送到（${pushReason}：${json.pushDetail || '未知原因'}）。`
        + `已交回本机权限确认，请在这里决定是否执行：${body}`));
    }

    // ── ③ policy=local：转场本地审批页（显式开启）──
    //
    // 只有显式选了 local 才转场。这一步会开一个浏览器标签页，代价比「问你一句」
    // 大，所以不设为默认 —— 默认走 ④ 的 AskUserQuestion 那条。
    if (policy === 'local') {
      handoffUsed = await handoffToLocal({ id: json.id, tier, body });
      if (handoffUsed.ok) {
        progress(`🔁 推送失败（${pushReason}）→ 已转场本地确认：${handoffUsed.detail}`);
        await reportAudit({
          event: 'local_handoff', tool: toolName, tier, binding,
          by: 'hook', summary: body,
        });
        // ★ 刻意**不 emit** —— 让执行流落到下面的等待循环，
        //   等你在浏览器那一页点出结论。超时仍未点 → 由 TTL 兜底成 deny。
      }
    }

    // ── ④ 拦住（默认落点）──
    if (!(handoffUsed && handoffUsed.ok)) {
      progress(
        `⛔ 推送失败（${pushReason}）、无本机授权（${granted.reason}），按 ${policy} 拦住。`
        + (handoffUsed ? `转场未成：${handoffUsed.detail}` : '')
      );
      await abandonGatewayRecord(json.id, 'push-failed');
      rememberBlocked(DATA_DIR, {
        binding,
        tool: toolName,
        tier,
        summary: body,
        reason: `推送到手表失败：${json.pushDetail || '未知原因'}`
          + (handoffUsed ? `（转场也失败：${handoffUsed.detail}）` : ''),
        approvalId: json.id || null,
        gatewayBinding: json.binding || null, // 只作交叉引用，不参与匹配
      });
      const reasonLines = degradeReasonLines({
        policy,
        cause: `推送到手表失败（${pushReason}：${json.pushDetail || '未知原因'}）`,
        body,
        bindingShort: shortBinding(binding),
      });
      // 为什么要把「转场为什么没成」也写进来：这条 reason 是你在宿主界面上
      // 唯一能看到的东西，而「推送失败」和「转场也失败」是两个独立故障。
      // 不写的话，现象永远是同一句「推送到手表失败」，排查只能靠翻 stderr
      // —— 而 stderr 是被宿主收走的。实测踩过一次：转场其实只是被
      // APPROVAL_LOCAL_HANDOFF=0 关着，却花了很久去查网关。
      if (handoffUsed && handoffUsed.detail) {
        reasonLines.push(`（未能转场到本机确认：${handoffUsed.detail}）`);
      }
      // ★ 在拦住之前先喊一声。
      //
      // 顺序是刻意的：**先喊，再 emit** —— emit 会 process.exit，喊在后面就永远
      // 发不出去。而这一声喊是用户唯一能当场看到「出事了」的地方：
      // stderr 被宿主收走，blocked-last.json 要等 Agent 主动去读。
      shoutLocally({ tier, body, reason: pushReason });
      emit(makeOutput(eventName, 'deny', reasonLines.join('\n')));
    }
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

  // 转场过的这一条要结算熔断计数：你点了 → 清零（说明你在，下次还能转场）；
  // 没点 → 保持累积，连续几次之后就不再转场（见 handoffToLocal）。
  if (handoffUsed && handoffUsed.ok) {
    const decided = !!(final && final.status !== 'pending' && final.status !== 'expired');
    settleHandoff(decided);
  }

  if (!final) {
    // BUDGET 先到（网关的 TTL 比本地预算长）、或网关失联 —— 两种情况下
    // 网关侧都可能还挂着 pending，主动撤销掉。
    await abandonGatewayRecord(json.id, 'hook-abandoned');
    // 兜底超时（比网关 expiresAt 更晚才发生 = 网关卡死/失联）。
    // 与「网关判定过期」一样：没答 = 没同意，恒 deny，不走 FALLBACK。
    emit(makeOutput(eventName, 'deny', `${ttl}s 内未收到确认，按默认拒绝：${body}`));
  }

  if (final.status === 'expired' || final.status === 'cancelled') {
    const where = handoffUsed && handoffUsed.ok ? '（已转场本地审批页，但没人做决策）' : '';
    emit(makeOutput(eventName, 'deny', `${ttl}s 内未收到确认，按默认拒绝${where}：${body}`));
  }
  if (final.verdict === 'allow') {
    // 说清这一次是在哪确认的 —— 「腕上确认没送到、你是在本机点的」这件事
    // 必须留在给 Agent 的 reason 里，否则事后回溯只看得到一条 allow。
    const how = handoffUsed && handoffUsed.ok ? '已通过本机审批页确认' : '已通过手机/手表确认';
    emit(makeOutput(eventName, 'allow', `${how}：${describe(final)}`));
  }
  emit(makeOutput(eventName, 'deny', `已拒绝（${describe(final)}）：${body}`));
} catch (e) {
  const unreachable = e.name === 'AbortError' || /fetch failed|ECONNREFUSED/i.test(String(e.message));
  const cause = unreachable
    ? `确认网关不可达（${GATEWAY}）`
    : `确认流程异常：${e.message}`;
  // 网关不可达 —— 这是**最容易被误判**的一种失败。
  //
  // 用户那边的现象是「Agent 突然什么都不肯做了」，而网关此刻可能只是
  // 被系统回收了（实测：脱管启动的实例在会话结束后被杀，launchd 又没装载，
  // 于是它静默消失，日志最后一行还停在「已启动」）。没有这一声喊，
  // 排查方向会一路偏到「权限配错了」上去。
  shoutLocally({
    tier,
    body,
    reason: unreachable ? '网关不可达' : '确认流程异常',
  });
  // 走与另外两条路径**完全相同的**降级策略（默认 ask_user），
  // 于是「网关不可达」也不再是一句干拒 —— 它同样会把「用 AskUserQuestion
  // 问一次 + 落一次性授权 + 重试」这条路指出来，由 Agent 去执行。
  const policy = degradePolicyFor(tier);
  emit(makeOutput(eventName, decisionForPolicy(policy),
    degradeReasonLines({
      policy,
      cause,
      body,
      bindingShort: shortBinding(grantBinding(toolName, toolInput)),
    }).join('\n')));
}
