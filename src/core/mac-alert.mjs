// macOS 本地提醒统一出口。
//
// ── 为什么需要这个模块 ─────────────────────────────────────────────────────
//
// 腕上确认（HA 推送）这条链路上有个结构性弱点：它依赖 iPhone 上的 HA App
// 保持在连。App 一掉线，`notify.mobile_app_*` 就返回 500（KeyError: 'push_token'），
// 于是所有 L2/L3 都会 fail-closed 被拒 —— 而**失败是完全无声的**：
// 一行 stderr 淹没在宿主日志里，没人看得到。
//
// 实测（2026-09-20）：netwatch 每 120 秒都判出「手机上的 HA App 没在连（推送必 500）」，
// 判断完全正确，但它只会往 logs/net-watch.log 追加一行。连续二十多条之后，
// 用户那边的体感仍然是「手表确认突然不好使了」，根本不知道去哪查。
//
// 所以「手表不灵了」这件事**必须先能自己喊出来**，而且喊得足够醒目。
// 这个模块就是那个喇叭 —— Mac 侧唯一的、不依赖任何第三方的提醒通道。
//
// ── 通知 vs 确认：两个不同的东西，别混 ─────────────────────────────────────
//
//   通知（notify）—— 单向。告诉你「出事了」，回不来任何结论。
//   确认（confirm）—— 双向。必须拿回一个「允许 / 拒绝」，才谈得上放行。
//
// 这个区分是本模块的核心约定。原先这里只做通知，于是「推送失败」只能
// **fail-closed 拒掉**再靠一条通知让你知情 —— 你能看到，但没法当场决定。
// 现在 confirm() 把最后一环补上：确认框直接带回结论，命令可以就地放行。
//
// ── 模态的可靠性（实测记录，2026-09-20）──────────────────────────────────
//
//   `display dialog`（正文写在 .applescript 文件里、数据走 argv）
//        ✅ 可靠。spawnSync status=0，返回按键文字或 `__timeout__`。
//   `display alert`
//        ❌ 会挂住不返回，一直等到调用方超时被杀。
//   ⚠️ 而且「命令行里内联 AppleScript 源码」的调用方式会被执行环境 SIGKILL ——
//      所以正文必须落盘成文件再 `osascript <file> <argv...>`。
//
// 还有一个必须知道的计时行为：`giving up after N` 的真实耗时是 **N + 6~8 秒**
// （实测 N=2 → 8.5~10.4s）。调用方算预算时要按 N+10 留余量，别用 N 硬算。
//
// ── 通知的三档醒目度 ──────────────────────────────────────────────────────
//
//   quiet   一条横幅，不出声。
//   normal  一条横幅 + 提示音。                                    ← 默认
//   loud    一条横幅 + 提示音 + 把宿主 App 带到前台（横幅才会落在你眼前）。
//
// ⚠️ 默认**只发一条**。这里踩过一次「为了醒目连发 3 条」，结果是：推送失败
// 一次就弹 3 个横幅，而 audit 里 push_failed 累计 81 次 —— 屏幕上就是一场雪崩，
// 最后反而没人看。醒目度应该来自**声音、位置、和一条能直接做决定的确认框**，
// 不是来自条数。要连发请显式传 `repeat`。
//
// ── 为什么「激活宿主 App」是 loud 档的关键 ────────────────────────────────
//
// macOS 的横幅只出现在**当前 Space** 附近。你若切到了别的全屏窗口或另一个
// 桌面，横幅落在那儿你是看不见的（它会留在通知中心，但不会主动找你）。
// `open -a <App>` 把宿主拽到前台，横幅才会出现在你正在看的地方 ——
// 实测这一招比把音量调大有效得多。代价是打断你手头的事，所以只在 loud 档启用。
//
// ⚠️ 一个诚实的边界：横幅受**专注模式 / 勿扰**管辖。开着勿扰时横幅不会出现，
// 而绕过它需要「关键警报」权限（要单独申请、且是系统级授权）。
// 本模块不尝试绕过 —— 只如实把 `methods` 报回来，让调用方能看出
// 「喊了但可能没人听到」。
//
// ── 安全：文本一律走 argv，不拼进脚本 ─────────────────────────────────────
//
// 命令正文（`body`）里可能带引号、反斜杠，甚至 `" do shell script "..."` 这类
// 想越狱的片段。**绝不把它拼进 AppleScript 源码** —— 一旦拼接，一条
// `git commit -m '"; do shell script "id"; --'` 就能借 osascript 执行任意命令，
// 而且是在**用户点了「允许」的那个进程里**执行，等于把确认框变成后门。
// 所以脚本正文是常量，数据全部通过 `osascript <file> <argv...>` 传入。
// 这条不是洁癖：这个模块处理的正是不可信的工具调用正文。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OSASCRIPT = '/usr/bin/osascript';
const AFPLAY = '/usr/bin/afplay';
const OPEN = '/usr/bin/open';
const SOUND_DIR = '/System/Library/Sounds';

// 默认提示音。Funk 是系统音里穿透力较强的一个 —— 短促、低频、不容易被
// 环境噪音盖掉。想要更尖的可以换 Sosumi / Basso（见 APPROVAL_MAC_SOUND）。
const DEFAULT_SOUND = 'Funk';

const LEVELS = ['quiet', 'normal', 'loud'];

/** 当前醒目度。quiet / normal / loud，非法值退回 normal。 */
export function prominence() {
  const raw = String(process.env.APPROVAL_MAC_PROMINENCE || '').trim().toLowerCase();
  return LEVELS.includes(raw) ? raw : 'normal';
}

/** 提示音名（不含扩展名）。找不到就退回默认，绝不因为配错而静音。 */
export function soundName() {
  const raw = String(process.env.APPROVAL_MAC_SOUND || '').trim();
  if (!raw) return DEFAULT_SOUND;
  const clean = raw.replace(/[^A-Za-z0-9_-]/g, '');
  return fs.existsSync(path.join(SOUND_DIR, `${clean}.aiff`)) ? clean : DEFAULT_SOUND;
}

/** 要带到前台的 App（路径或名字）。 */
export function activateApp() {
  return process.env.APPROVAL_MAC_ACTIVATE_APP || '/Applications/WorkBuddy.app';
}

/**
 * 本地提醒是否可用。
 *
 * 只查 osascript 在不在 —— **不**去判断有没有 GUI 会话。理由：判断方法
 * （`launchctl managername`、`stat /dev/console`）在沙箱里都不可靠，
 * 而一个判错的「不可用」会让整套兜底静默失效，比「试一下失败」糟得多。
 * 所以这里乐观返回 true，真正的失败由每次调用的返回值体现。
 */
export function available() {
  return fs.existsSync(OSASCRIPT);
}

// ── 脚本正文（常量，数据一律走 argv）───────────────────────────────────────

const SCRIPT_BANNER = `on run argv
	set t to item 1 of argv
	set m to item 2 of argv
	set sub to item 3 of argv
	set snd to item 4 of argv
	if sub is "" and snd is "" then
		display notification m with title t
	else if sub is "" then
		display notification m with title t sound name snd
	else if snd is "" then
		display notification m with title t subtitle sub
	else
		display notification m with title t subtitle sub sound name snd
	end if
	return "ok"
end run`;

// 确认框。`display dialog`（**不是** `display alert` —— 后者会挂住，见文件头实测记录）。
//
// ⚠️ 按钮的默认值**故意留给调用方**，但有一条硬约定：调用方应当把
// `default button` 与 `cancel button` 都设成最安全的那个（拒绝）。
// 理由：`default button` 是回车键的落点。把“允许”设成默认，等于
// 按一下回车就放行 —— 而这个框出现在你正在打字的终端前面时，
// 一个回车是极容易误触的。网关那边对 Apple Watch 的双击手势做过
// 同样的取舍（拒绝放第一位、不标 destructive），这里保持一致。
const SCRIPT_CONFIRM = `on run argv
	set t to item 1 of argv
	set m to item 2 of argv
	set b1 to item 3 of argv
	set b2 to item 4 of argv
	set b3 to item 5 of argv
	set dflt to item 6 of argv
	set n to (item 7 of argv) as integer
	try
		if b3 is "" then
			set r to display dialog m with title t buttons {b1, b2} default button dflt cancel button b1 with icon caution giving up after n
		else
			set r to display dialog m with title t buttons {b1, b2, b3} default button dflt cancel button b1 with icon caution giving up after n
		end if
		if gave up of r then return "__timeout__"
		return button returned of r
	on error number -128
		return b1
	end try
end run`;

// 脚本正文落盘后复用。固定目录（放系统临时目录），避免每次调用都做写盘抖动。
const SCRIPT_DIR = (() => {
  const dir = path.join(os.tmpdir(), 'agent-approval-alerts');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* 已存在即可 */
  }
  return dir;
})();

/** 把一段 AppleScript 正文落到文件里，返回路径；写不进去返回 null。 */
function scriptPath(name, text) {
  const file = path.join(SCRIPT_DIR, `${name}.applescript`);
  try {
    if (fs.readFileSync(file, 'utf8') !== text) fs.writeFileSync(file, text, 'utf8');
    return file;
  } catch {
    try {
      fs.writeFileSync(file, text, 'utf8');
      return file;
    } catch {
      return null;
    }
  }
}

/**
 * 跑一段 AppleScript。**永不抛**，失败返回 `{ ok:false, error }`。
 *
 * timeoutMs 必须给足：确认框会一直阻塞到用户点击或 `giving up after` 到期，
 * 而真实耗时是 `giving up after` **再加约 6~8 秒**（实测）。调用方按 N+15 留。
 */
function runScript(name, text, args, timeoutMs = 6000) {
  if (!available()) return { ok: false, error: '没有 osascript（不是 macOS？）' };
  const file = scriptPath(name, text);
  if (!file) return { ok: false, error: '脚本正文写不进去（临时目录不可写）' };
  const r = spawnSync(OSASCRIPT, [file, ...args], {
    encoding: 'utf8',
    timeout: Math.max(1000, timeoutMs),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.error) return { ok: false, error: r.error.message };
  if (r.status !== 0) {
    return { ok: false, error: (r.stderr || '').trim() || `osascript 退出码 ${r.status}` };
  }
  return { ok: true, stdout: (r.stdout || '').trim() };
}

// ── 三个原子能力 ──────────────────────────────────────────────────────────

/** 横幅通知。`sound` 传空字符串表示静音。 */
export function banner({ title, body, subtitle = '', sound = '' }) {
  return runScript(
    'banner',
    SCRIPT_BANNER,
    [String(title || ''), String(body || ''), String(subtitle || ''), String(sound || '')],
    6000
  );
}

/**
 * 模态确认框 —— **唯一能把「允许 / 拒绝」带回来的本地通道**。
 *
 * 返回：
 *   · 被点击的按钮文字（原样，含调用方传入的中文标签）
 *   · `'__timeout__'`  —— 到期自动放弃。**必须当成拒绝**，不能当成同意。
 *   · `null`            —— 弹不出来（没有 osascript / 无 GUI / 脚本不可写）。
 *                          同样必须当成拒绝。
 *
 * 这两条「不确定 = 拒绝」的约定是刻意统一的：确认通道的价值在于
 * **它能给出可信的 allow**。一旦允许「弹不出来也算过」，这个通道就从
 * 「多一条路」退化成「一个洞」。
 *
 * `ttlSeconds` 是对话框的存活秒数。真实阻塞时间约为它 +6~8 秒。
 */
export function confirm({
  title,
  body,
  buttons = ['拒绝', '允许'],
  defaultButton = null,
  ttlSeconds = 40,
}) {
  const b = buttons.slice(0, 3).map(String);
  while (b.length < 3) b.push('');
  // 默认落到第一个按钮（调用方按约定把「拒绝」放第一位）。
  const dflt = defaultButton && b.includes(String(defaultButton)) ? String(defaultButton) : b[0];
  const sec = Math.max(1, Math.min(600, Number(ttlSeconds) || 40));
  const r = runScript(
    'confirm',
    SCRIPT_CONFIRM,
    [String(title || ''), String(body || ''), b[0], b[1], b[2], dflt, String(sec)],
    (sec + 20) * 1000
  );
  if (!r.ok) return { ok: false, button: null, error: r.error };
  const btn = r.stdout || null;
  return { ok: true, button: btn, timedOut: btn === '__timeout__' };
}

/** 播放系统提示音。`times` 次，次间留 0.45s —— 连响比单响更容易被注意到。 */
export function beep(sound = soundName(), times = 1) {
  if (!fs.existsSync(AFPLAY)) return { ok: false, error: '没有 afplay' };
  const file = path.join(SOUND_DIR, `${sound}.aiff`);
  if (!fs.existsSync(file)) return { ok: false, error: `没有这个提示音：${sound}` };
  const n = Math.max(1, Math.min(6, Number(times) || 1));
  let last = { ok: true };
  const nap = (ms) => {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch {
      /* 不支持就略过 */
    }
  };
  for (let i = 0; i < n; i += 1) {
    last = spawnSync(AFPLAY, [file], { timeout: 4000, stdio: 'ignore' });
    if (i < n - 1) nap(450);
  }
  return { ok: !last.error, error: last.error && last.error.message };
}

/** 把 App 带到前台（让横幅落在你眼前）。`app` 可以是路径或名字。 */
export function activate(app = activateApp()) {
  if (!app) return { ok: false, error: '未指定 App' };
  const r = spawnSync(OPEN, ['-a', String(app)], { timeout: 5000, stdio: 'ignore' });
  return { ok: !r.error && r.status === 0, error: r.error && r.error.message };
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* ignore */
  }
}

// ── 统一入口 ──────────────────────────────────────────────────────────────

/**
 * 按醒目度发一条本地提醒。
 *
 * 返回 `{ shown, methods, errors, repeat }` —— `methods` 记下**实际生效**的手段，
 * 让调用方（和审计）能区分「喊过了」和「喊了但没人听得见」。
 * 这个区分很重要：如果手段全失败，用户就是**在完全不知情的情况下**
 * 被 fail-closed 拒了一整晚，那必须留痕。
 *
 * @param {object}   o
 * @param {string}   o.title           横幅第一行（粗体）
 * @param {string}   o.body            横幅第三行（正文）
 * @param {string}   [o.subtitle]      横幅第二行
 * @param {'quiet'|'normal'|'loud'} [o.level]     默认取 prominence()
 * @param {string}   [o.sound]         提示音名；`''` = 静音
 * @param {number}   [o.repeat]        重复遍数（默认按档位：loud=3，其余=1）
 * @param {number}   [o.gapMs]         每遍间隔（默认 900）
 * @param {boolean}  [o.withActivate]  是否把宿主 App 带到前台（默认 loud 档才做）
 */
export function notify({
  title,
  body,
  subtitle = '',
  level = null,
  sound = null,
  repeat = null,
  gapMs = 900,
  withActivate = null,
}) {
  const lv = level || prominence();
  const snd = sound === null ? (lv === 'quiet' ? '' : soundName()) : sound;
  // ⚠️ 默认**一律只发一条**。想连发必须显式传 repeat —— 理由见文件头
  // 「默认只发一条」那段：push_failed 累计 81 次，一次弹 3 条就是一场雪崩。
  const times = Math.max(1, Math.min(6, Number(repeat) || 1));
  const doActivate = withActivate === null ? lv === 'loud' : !!withActivate;

  const methods = [];
  const errors = [];

  if (!available()) {
    return { shown: false, methods, errors: ['没有 osascript，本地提醒不可用'], repeat: 0 };
  }

  // 先把宿主 App 拽到前台，再发横幅 —— 顺序反了的话，横幅会落在
  // 你切走之前的那个 Space 上，激活完成后你看到的反而是一片安静。
  if (doActivate) {
    const a = activate();
    if (a.ok) methods.push('activate');
    else errors.push(`activate: ${a.error}`);
  }

  let ok = 0;
  for (let i = 0; i < times; i += 1) {
    // 第 2 遍起在标题上标次数：与腕上确认卡片的「（第 N 次提醒）」同一个约定，
    // 让你知道这是同一条在追你，而不是来了 N 件新事。
    const t = times > 1 && i > 0 ? `${title}（第 ${i + 1} 次提醒）` : title;
    const r = banner({ title: t, body, subtitle, sound: snd });
    if (r.ok) ok += 1;
    else if (!errors.includes(`banner: ${r.error}`)) errors.push(`banner: ${r.error}`);

    if (snd && i < times - 1) {
      // `sound name` 由通知自己放，这里不再叠加 afplay ——
      // 两路同时响会互相盖住，反而是噪声。
      sleepSync(Math.max(200, gapMs));
    }
  }
  if (ok > 0) methods.push(times > 1 ? `banner×${ok}` : 'banner');
  if (snd && ok > 0) methods.push('sound');

  return { shown: ok > 0, methods, errors, repeat: ok };
}

export const SOUNDS = fs.existsSync(SOUND_DIR)
  ? fs.readdirSync(SOUND_DIR).filter((f) => f.endsWith('.aiff')).map((f) => f.replace(/\.aiff$/, ''))
  : [];
