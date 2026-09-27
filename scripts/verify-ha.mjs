#!/usr/bin/env node
// Home Assistant 链路验证器。
//
// 为什么需要它：整个方案里，网关自身的逻辑已经被 test/selftest.mjs 的 63 条
// 断言覆盖了；真正无法在 Mac 上单机验证的只有一段 ——
//     HA → iPhone 推送 → 手表镜像通知 → 表冠/点击某个按钮 → HA 事件 → 网关
// 这段必须真机测。本脚本把这段变成一条命令，并且把「哪一环断了」直接指出来。
//
// 用法（推荐用装在 PATH 里的 approval 包装器，任何目录都能直接跑）：
//   approval doctor                       # 环境体检，不需要令牌
//   approval link                         # 完整往返测试（需要令牌）
//   approval link --wait 180              # 给手表多点时间
//   approval link --notify mobile_app_your_iphone
//
// 直接调本文件也行，但**必须在项目目录下**：
//   cd <agent-approval 目录> && node scripts/verify-ha.mjs doctor
// 因为 node 是按当前工作目录解析相对路径的，在家目录里跑会报
//   Error: Cannot find module '<home>/scripts/verify-ha.mjs'
// 这也是 approval 包装器存在的理由 —— 它内部自己切目录。
//
// 参数缺省时自动读 config.json 的 channels.ha。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// ── 输出小工具 ────────────────────────────────────────────────────────────
const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};
const ok = (s) => console.log(`${C.green('✅')} ${s}`);
const bad = (s) => console.log(`${C.red('❌')} ${s}`);
const warn = (s) => console.log(`${C.yellow('⚠️ ')} ${s}`);
const info = (s) => console.log(`${C.cyan('·')} ${s}`);
const step = (n, s) => console.log(`\n${C.bold(`[${n}] ${s}`)}`);

// ── 参数解析 ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      out[k] = v;
    } else out._.push(a);
  }
  return out;
}

function loadConfig() {
  for (const f of ['config.json', 'config.example.json']) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) {
      try {
        return { cfg: JSON.parse(fs.readFileSync(p, 'utf8')), from: f };
      } catch (e) {
        console.error(`读取 ${f} 失败：${e.message}`);
      }
    }
  }
  return { cfg: { channels: { ha: {} } }, from: null };
}

const args = parseArgs(process.argv.slice(2));
const mode = args._[0] || 'link';
const { cfg, from } = loadConfig();
const haCfg = (cfg.channels && cfg.channels.ha) || {};

let baseUrl = String(args.baseUrl || haCfg.baseUrl || 'http://localhost:8123').replace(/\/+$/, '');
let token = args.token || process.env.HA_TOKEN || haCfg.token || '';
let notifyService = args.notify || haCfg.notifyService || '';
const waitSec = Number(args.wait || 120);

// ── 工具函数 ──────────────────────────────────────────────────────────────
async function apiGet(p) {
  const res = await fetch(`${baseUrl}${p}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  return { status: res.status, text };
}

async function apiPost(p, body) {
  const res = await fetch(`${baseUrl}${p}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text };
}

function wsUrl() {
  const u = new URL(baseUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/api/websocket';
  u.search = '';
  return u.toString();
}

// 读 HA 的配置条目，找出已注册的手机，以及它们有没有推送能力。
//
// 为什么要单独查这个：HA 的 supports_push() 判定是
//     (push_token in app_data and push_url in app_data) or push_websocket_channel in app_data
// app_data 里没有这些凭据时，push_registrations() 会直接把该设备跳过 ——
// 结果是「手机明明注册成功了、传感器一堆」，但 notify.mobile_app_* 服务根本不存在。
// 只看服务列表的报错完全看不出是这个原因，所以这里把中间状态摊开。
function readMobileAppDevices() {
  const p = path.join(process.env.HOME || '', '.homeassistant',
                      '.storage', 'core.config_entries');
  if (!fs.existsSync(p)) return null;
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(p, 'utf8'))?.data?.entries;
  } catch {
    return null;
  }
  if (!Array.isArray(entries)) return null;

  return entries
    .filter((e) => e.domain === 'mobile_app')
    .map((e) => {
      const d = e.data || {};
      const app = d.app_data || {};
      const cloudPush = !!(app.push_token && app.push_url);
      const localPush = app.push_websocket_channel === true;
      return {
        name: d.device_name || e.title || '(未命名)',
        model: d.model || '',
        os: `${d.os_name || ''} ${d.os_version || ''}`.trim(),
        appVersion: d.app_version || '',
        cloudPush,
        localPush,
        canPush: cloudPush || localPush,
        appDataKeys: Object.keys(app),
      };
    });
}

// ── doctor：不开令牌的环境体检 ────────────────────────────────────────────
async function doctor() {
  console.log(C.bold('\n=== Home Assistant 环境体检 ===\n'));

  step(1, 'HTTP 是否可达');
  let code = '000';
  try {
    const res = await fetch(`${baseUrl}/onboarding.html`, { redirect: 'manual' });
    code = String(res.status);
  } catch (e) {
    bad(`连不上 ${baseUrl} —— ${e.message}`);
    info('检查 HA 是否在跑：lsof -nP -iTCP:8123 -sTCP:LISTEN');
    return 1;
  }
  if (code === '200') ok(`${baseUrl}/onboarding.html → 200，前端服务正常`);
  else if (code === '302') ok(`${baseUrl} → 302，正在重定向（引导向导或登录页）`);
  else warn(`返回 ${code}，非预期但服务在线`);

  // 各步骤把结论记在这里，第 7 步据此只列「你还没做的事」。
  // 否则体检会把早就完成的步骤（装 App、加服务器）又催一遍，
  // 让人误以为「我做的没生效」。
  const state = {
    onboardingDone: true,   // 拿不到结论时按「已做」处理，避免误催
    phoneRegistered: false,
    canPush: false,
    tokenSet: false,
  };

  step(2, '引导向导状态');
  // HA 的 /api/onboarding 不返回步骤标题，这里补一份人话标签。
  const STEP_LABEL = {
    user: '创建管理员账号（用户名 + 密码）',
    core_config: '设置家庭名称与单位',
    analytics: '分析数据共享选择（建议关掉）',
    integration: '添加第一个集成（可直接跳过）',
  };
  try {
    const res = await fetch(`${baseUrl}/api/onboarding`, {
      headers: { 'Content-Type': 'application/json' },
    });
    if (res.status === 200) {
      const steps = await res.json();
      const pending = (Array.isArray(steps) ? steps : []).filter((s) => !s.done);
      if (pending.length === 0) ok('引导向导已完成，可以登录了');
      else {
        state.onboardingDone = false;
        warn(`引导向导还有 ${pending.length} 步未完成：`);
        for (const s of pending) {
          info(`  ${STEP_LABEL[s.step] || s.step}${s.title ? `（${s.title}）` : ''}`);
        }
        info(`在浏览器打开 ${baseUrl} 完成它`);
      }
    } else if (res.status === 404) {
      // 404 是好事：HA 在引导全部走完后会把 /api/onboarding 关掉。
      // 这里原来用的是 warn（⚠️），把「好消息」渲染成「注意」是误导，改成 ok。
      ok('引导已完成（/api/onboarding 已关闭）');
    } else {
      warn(`/api/onboarding 返回 ${res.status}`);
    }
  } catch (e) {
    warn(`探测引导状态失败：${e.message}`);
  }

  step(3, '配置与日志');
  const cfgDir = path.join(process.env.HOME || '', '.homeassistant');
  const logPath = path.join(cfgDir, 'home-assistant.log');
  if (fs.existsSync(logPath)) {
    const lines = fs.readFileSync(logPath, 'utf8').split('\n');
    // ⚠️ HA 的日志行以时间戳开头：
    //    2026-09-19 00:21:53.140 WARNING (MainThread) [logger] ...
    // 行首不是级别，所以 `l.startsWith('ERROR')` 永远为 false —— 那会让体检
    // 在所有情况下都报「零 ERROR」，把真实故障掩盖掉。必须带时间戳前缀匹配。
    const errs = lines.filter((l) => /^\d{4}-\d{2}-\d{2} [\d:.]+ ERROR/.test(l));
    const warns = lines.filter((l) => /^\d{4}-\d{2}-\d{2} [\d:.]+ WARNING/.test(l));
    const setupFails = lines.filter((l) => /Setup failed for|not found/.test(l));
    if (errs.length === 0) ok(`日志零 ERROR（${logPath}）`);
    else bad(`日志有 ${errs.length} 条 ERROR：`);
    if (errs.length) for (const l of errs.slice(0, 6)) info('  ' + l.slice(0, 160));
    // WARNING 不是一视同仁的。有些是环境噪音（zlib 性能提示、自定义集成提示），
    // 有些是货真价实的信号（比如局域网里有设备正拿着错凭据反复登录）。
    // 混成一张长列表会让人养成「WARNING 一律跳过」的习惯，所以分成两类分开说。
    const NOISY = /zlib_ng and isal|We found a custom integration|took longer than/;
    const noteworthy = warns.filter((l) => !NOISY.test(l));
    const noisy = warns.filter((l) => NOISY.test(l));
    if (noteworthy.length) {
      warn(`有 ${noteworthy.length} 条 WARNING 值得看一眼：`);
      for (const l of noteworthy.slice(0, 4)) info('  ' + l.slice(0, 150));
      const authFails = noteworthy.filter((l) => /invalid authentication/i.test(l));
      if (authFails.length) {
        info(`其中 ${authFails.length} 条是「局域网内有设备用错凭据登录」——`);
        info('常见的两种情况：手机 App 第一次配对失败留下的（对上时间点就不用管）；');
        info('或手机端着旧令牌在反复重试（那就说明推送凭据一直没同步成功，见第 5 步）。');
      }
    }
    if (noisy.length) {
      info(`另有 ${noisy.length} 条环境噪音 WARNING，可忽略：`);
      for (const l of noisy.slice(0, 4)) info('  ' + l.slice(0, 150));
    }
    if (setupFails.length) {
      warn(`有 ${setupFails.length} 条集成加载失败记录：`);
      for (const l of setupFails.slice(0, 6)) info('  ' + l.slice(0, 160));
    }
    // 日志里是否提过这些关键集成 —— 未注册设备前 mobile_app 很安静是正常的
    for (const dom of ['mobile_app', 'zeroconf']) {
      const n = lines.filter((l) => l.includes(dom)).length;
      info(`日志中提及 ${dom} 的行数：${n}`);
    }
  } else {
    warn(`找不到日志 ${logPath}`);
  }

  step(4, '局域网发现（手机能不能搜到这台 HA）');
  // 这一步是踩坑加出来的。之前为了精简依赖，把 zeroconf 一起从配置里删了 ——
  // 结果 HA 在本机和网页里一切正常，手机 App 的「搜索服务器」却永远是空的。
  // 原因是 zeroconf 负责把 HA 以 _home-assistant._tcp.local. 广播到局域网，
  // 而手机 App 的自动发现找的正是这条广播。
  const yamlPath = path.join(cfgDir, 'configuration.yaml');
  let yamlHasZeroconf = false;
  if (fs.existsSync(yamlPath)) {
    const y = fs.readFileSync(yamlPath, 'utf8');
    yamlHasZeroconf = /^\s*zeroconf\s*:/m.test(y);
  }
  if (yamlHasZeroconf) {
    ok('configuration.yaml 里有 zeroconf:，HA 会广播自己');
  } else {
    bad('configuration.yaml 里没有 zeroconf: —— 手机的「搜索服务器」会一直是空的');
    info('在 configuration.yaml 里加一行 zeroconf:，然后重启 HA。');
    info('（它的 network 依赖会被自动解析，不需要额外装包。）');
  }

  // 动态复核：真去局域网上听这条广播。
  // 不用 dns-sd —— 它重定向到管道时是块缓冲的，没到 tty 就什么都不输出，
  // 会稳定地给出「没找到」这种假阴性。改用 HA venv 里的 zeroconf 库。
  const probe = path.join(ROOT, 'scripts', 'probe-mdns.py');
  const py = process.env.HA_PYTHON
    || path.join(process.env.HOME || '', '.ha-venv', 'bin', 'python3');
  let mdns = null;
  if (fs.existsSync(probe) && fs.existsSync(py)) {
    const cmd = `"${py}" "${probe}" --json --timeout 7`;
    try {
      mdns = JSON.parse(execSync(cmd, { timeout: 25000, encoding: 'utf8' }));
    } catch (e) {
      // 探针「没找到」时退出码为 1，execSync 会抛，但 stdout 里仍有 JSON
      try { mdns = JSON.parse(String(e.stdout || '')); } catch { mdns = null; }
    }
  }
  if (mdns && mdns.ok) {
    const s = mdns.services[0];
    ok(`mDNS 广播可见：${(s.addresses || []).join(', ')}:${s.port}`);
    info(`手机 App 的「搜索服务器」应该会列出「${(s.properties || {}).location_name || s.name}」`);
  } else if (mdns) {
    bad('mDNS 广播不可见 —— 手机的「搜索服务器」搜不到就是这里的问题');
    info('先确认上一行「有 zeroconf:」是 ✅；是的话再等十几秒重试（刚重启完还没广播）。');
    info('单独复核：approval mdns');
  } else {
    warn('跳过动态检查（找不到 python 或 probe-mdns.py），只能依赖上面的静态判断');
  }

  // 给出不依赖发现的兜底地址
  let lanIp = '';
  try {
    lanIp = execSync('ipconfig getifaddr en0', { timeout: 3000, encoding: 'utf8' }).trim();
  } catch { /* 忽略 */ }
  if (lanIp) {
    info(`本机局域网地址：${lanIp}`);
    info(`手机上若搜不到，直接手动填这个地址也能连上：http://${lanIp}:8123`);
  } else {
    info('读不到 en0 的地址，手动确认：ipconfig getifaddr en0');
  }

  step(5, '手机推送能力');
  const phones = readMobileAppDevices();
  if (phones === null) {
    warn('读不到 .storage/core.config_entries，跳过这项（不影响其它检查）');
  } else if (phones.length === 0) {
    warn('还没有任何手机注册到 HA —— 先在 iPhone 的 HA App 里添加服务器并登录');
  } else {
    state.phoneRegistered = true;
    for (const ph of phones) {
      if (ph.canPush) {
        state.canPush = true;
        const how = [ph.cloudPush && '云端推送', ph.localPush && '本地推送']
          .filter(Boolean).join(' + ');
        ok(`${ph.name}（${ph.model || ph.os}）可推送：${how}`);
      } else {
        bad(`${ph.name}（${ph.model || ph.os}）已注册，但**没有上传推送凭据**`);
        info('HA 会跳过它，不注册 notify.mobile_app_* 服务 —— 推送发不出去。');
        info('app_data 为空 ⇒ 这台 iPhone 还没拿到 pushID。');
        info('（iOS 端只在拿到 pushID 时才写 app_data，写的是 push_url + push_token 一对；');
        info(' 而且 iOS App 从不发送 push_websocket_channel —— 所以「本地推送」救不了这里。）');
        info('');
        info('在 iPhone 上按顺序做：');
        info('  1. 系统设置 → 通知 → Home Assistant → 允许通知');
        info('  2. App → 设置 → 通知设置 → 点最上面「权限」那一行');
        info('     显示「已启用」才对；显示「已禁用/拒绝」就点它（会跳到系统设置）');
        info('  3. App → 设置 → 调试 → 看「推送ID」是否显示「未注册远程通知」');
        info('     （调试入口可能要摇一摇手机才出现）');
        info('  4. 上滑杀掉 App 再打开，让它重新注册推送');
        info('');
        info('⚠️ 中文界面里**没有**「伴侣应用」这个入口 —— 只有「通知设置」，别去找它。');
      }
    }
  }

  step(6, '网关配置');
  if (from) info(`配置来源：${from}`);
  const ch = cfg.channel || '(未设置)';
  if (ch === 'ha') ok('channel = "ha"（HA 通道已启用）');
  else warn(`channel = "${ch}"，还是 mock。手机端配置完成后改成 "ha"`);
  if (!token || token.startsWith('PASTE_')) {
    warn('channels.ha.token 还没填长期访问令牌');
  } else {
    state.tokenSet = true;
    ok('channels.ha.token 已填写');
  }
  if (!notifyService || /your_iphone|PASTE_/.test(notifyService)) {
    warn('channels.ha.notifyService 还是占位值，需要换成真实设备名');
  } else {
    ok(`channels.ha.notifyService = ${notifyService}`);
  }
  if (/localhost|127\.0\.0\.1/.test(baseUrl)) {
    info('baseUrl 指向本机。如果 HA 和网关在同一台 Mac 上，这是对的。');
  }

  step(7, '下一步');
  // 只列「还没做的」。原来这里是固定 5 条 —— 手机早就装好、服务器早加好了，
  // 却仍在催你"去装 App、去加服务器"，很容易被误读成「我做的没生效」。
  const todo = [];
  if (!state.onboardingDone) {
    todo.push(`浏览器打开 ${baseUrl}，把引导向导走完（账号若已建好就直接登录）`);
  }
  if (!state.phoneRegistered) {
    todo.push(`iPhone 装 Home Assistant App，添加服务器时选搜到的那个；`
      + `搜不到就手动填 ${lanIp ? `http://${lanIp}:8123` : 'http://<Mac的局域网IP>:8123'}`);
  } else if (!state.canPush) {
    todo.push('iPhone → HA App → 设置 → 伴侣应用 → 通知 → 允许通知，'
      + '并把「本地推送」也打开，然后切回 App 前台停一会儿');
  }
  if (state.phoneRegistered) {
    todo.push('Apple Watch 上装 Home Assistant 的 Watch App（不装的话表上只有通知、没有按钮）');
  }
  if (!state.tokenSet) {
    todo.push('HA 网页里点左下角用户名 → 安全 → 长期访问令牌 → 创建（只显示一次，复制后立刻用）');
    todo.push(`创建后跑往返测试（把手表戴手腕上）：${C.dim('approval link --token <贴进来>')}`);
  } else if (!state.canPush) {
    todo.push(`手机侧那步做完，再跑往返测试：${C.dim('approval link')}`);
  } else {
    todo.push(`跑往返测试（把手表戴手腕上）：${C.dim('approval link')}`);
  }
  if (state.canPush && state.tokenSet && ch !== 'ha') {
    todo.push(`往返测通后，把 config.json 的 channel 从 "${ch}" 改成 "ha"，然后重启网关`);
  }

  if (todo.length === 0) {
    ok('该做的都做完了 —— 跑一次 approval link 确认往返即可');
  } else {
    todo.forEach((t, i) => console.log(`  ${C.bold(`${i + 1}.`)} ${t}`));
  }
  console.log();
  return 0;
}

// ── link：完整往返测试 ────────────────────────────────────────────────────
async function link() {
  console.log(C.bold('\n=== HA → iPhone/Watch → Mac 往返测试 ===\n'));
  if (from) info(`读取配置：${from}`);
  info(`HA 地址：${baseUrl}`);

  // [1] 令牌可用性
  step(1, '校验长期访问令牌');
  if (!token || token.startsWith('PASTE_')) {
    bad('没有令牌。用 --token <令牌> 传入，或先写进 config.json 的 channels.ha.token');
    return 1;
  }
  try {
    const { status, text } = await apiGet('/api/');
    if (status === 401) {
      bad('令牌无效（HA 返回 401）。可能复制时漏了字符，或令牌已被删除。');
      return 1;
    }
    if (status !== 200) {
      bad(`/api/ 返回 ${status}：${text.slice(0, 200)}`);
      return 1;
    }
    ok(`令牌有效（${text.trim()}）`);
  } catch (e) {
    bad(`连不上 ${baseUrl} —— ${e.message}`);
    return 1;
  }

  // [2] 找到 notify 服务
  step(2, '查找手机通知服务');
  let services = [];
  try {
    const { status, text } = await apiGet('/api/services');
    if (status !== 200) {
      bad(`/api/services 返回 ${status}`);
      return 1;
    }
    const all = JSON.parse(text);
    const notify = all.find((d) => d.domain === 'notify');
    const names = notify ? Object.keys(notify.services || {}) : [];
    services = names.filter((n) => n.startsWith('mobile_app_'));
    const others = names.filter((n) => !n.startsWith('mobile_app_'));
    if (services.length === 0) {
      bad('没有找到任何 notify.mobile_app_* 服务。');
      console.log();
      // 分成两种完全不同的情况 —— 否则会一直往「手机没连上」的方向瞎查。
      const phones = readMobileAppDevices();
      if (phones && phones.length > 0 && phones.every((p) => !p.canPush)) {
        info(`已注册的设备：${phones.map((p) => p.name).join('、')} —— 手机是连上的`);
        console.log();
        bad('但它们都没有上传推送凭据，所以 HA 没有为它们注册 notify 服务。');
        console.log(`     ${C.bold('这才是真正的原因，不是手机没连上。')}`);
        console.log();
        info('在 iPhone 上修：');
        console.log(`     ${C.bold('a.')} 打开 HA App → 设置 → 伴侣应用 → 通知 → 允许通知`);
        console.log(`     ${C.bold('b.')} 把「本地推送」打开（不需要 Nabu Casa 也能推）`);
        console.log(`     ${C.bold('c.')} iOS 系统设置 → 通知 → Home Assistant 也确认是允许`);
        console.log(`     ${C.bold('d.')} 把 App 切回前台停一会儿，让它把凭据同步给 HA`);
        console.log();
        info('弄完再跑一次本命令。');
      } else if (phones && phones.length === 0) {
        info('HA 里还没有任何手机注册 —— 先在 iPhone 的 HA App 里添加服务器并登录。');
      } else {
        info('没有找到可推送的手机。逐条确认：');
        console.log(`     ${C.bold('a.')} iPhone 上装了 Home Assistant App 并登录了同一个账号`);
        console.log(`     ${C.bold('b.')} App 的通知权限已允许`);
        console.log(`     ${C.bold('c.')} App 里「设置 → 伴侣应用 → 通知 → 本地推送」已打开`);
      }
      console.log();
      if (others.length) info(`（当前非 mobile_app 的 notify 服务：${others.join(', ')}）`);
      return 1;
    }
    ok(`找到 ${services.length} 个手机通知服务：${services.join(', ')}`);
  } catch (e) {
    bad(`读取服务列表失败：${e.message}`);
    return 1;
  }

  if (!notifyService || /your_iphone|PASTE_/.test(notifyService)) {
    if (services.length === 1) {
      notifyService = services[0];
      info(`未指定 --notify，自动选用唯一的那个：${notifyService}`);
    } else {
      warn('有多个设备，请用 --notify <名字> 指定要推到哪一台');
      return 1;
    }
  } else if (!services.includes(notifyService)) {
    warn(`--notify 指定的 "${notifyService}" 不在服务列表里，改用 ${services[0]}`);
    notifyService = services[0];
  }
  info(`本次目标设备：notify.${notifyService}`);

  // [3] WebSocket 订阅回程事件
  step(3, '建立 WebSocket 并订阅按钮事件');
  const nonce = crypto.randomBytes(4).toString('hex');
  const testAction = `APRVERIFY:${nonce}`;
  const events = [];

  const wsResult = await new Promise((resolve) => {
    let ws;
    try {
      ws = new WebSocket(wsUrl());
    } catch (e) {
      return resolve({ ok: false, why: `WebSocket 构造失败：${e.message}` });
    }
    let id = 0;
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      resolve({ ok: false, why: '握手超时（15 秒）' });
    }, 15000);

    ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.type === 'auth_required') {
        ws.send(JSON.stringify({ type: 'auth', access_token: token }));
      } else if (m.type === 'auth_invalid') {
        clearTimeout(timer);
        resolve({ ok: false, why: `鉴权被拒：${m.message}` });
      } else if (m.type === 'auth_ok') {
        ws.send(JSON.stringify({
          id: ++id,
          type: 'subscribe_events',
          event_type: 'mobile_app_notification_action',
        }));
      } else if (m.type === 'result' && m.id === 1) {
        if (m.success) {
          clearTimeout(timer);
          resolve({ ok: true, ws });
        } else {
          clearTimeout(timer);
          resolve({ ok: false, why: `订阅失败：${JSON.stringify(m.error)}` });
        }
      } else if (m.type === 'event') {
        events.push(m.event);
      }
    });
    ws.addEventListener('error', () => {});
  });

  if (!wsResult.ok) {
    bad(`WebSocket 环节失败：${wsResult.why}`);
    return 1;
  }
  ok('已订阅 mobile_app_notification_action —— 你在手表上按下的按钮会从这里回来');

  // [4] 发出测试卡片
  step(4, '发出一张带按钮的测试通知');
  const body = {
    message: `点一下卡片上的按钮试试。点完这里会立刻显示结果。\n指纹 ${nonce}`,
    title: 'Agent 确认通道 · 往返测试',
    data: {
      tag: `aprverify_${nonce}`,
      group: 'agent-approval',
      push: {
        'interruption-level': 'time-sensitive',
        sound: { name: 'default' },
      },
      actions: [
        { action: testAction, title: '✅ 我在手表上按到了' },
        { action: `APRVERIFY:${nonce}:ignore`, title: '忽略', destructive: true },
      ],
    },
  };
  try {
    // ⚠️ REST 调用服务的路径是 /api/services/<域>/<服务>，用**斜杠**分隔。
    // 写成 /api/services/notify.mobile_app_x（点号）会得到 404 Not Found ——
    // 点号是 YAML/自动化里的写法，不是 REST 路径的写法。这个 bug 一直潜伏着，
    // 因为在此之前没有长期访问令牌，这一步从没真正跑起来过。
    const { status, text } = await apiPost(`/api/services/notify/${notifyService}`, body);
    if (status >= 400) {
      bad(`发送失败，HA 返回 ${status}：${text.slice(0, 400)}`);
      return 1;
    }
    ok('已投递给 HA，正常情况 1–3 秒内 iPhone 会响');
  } catch (e) {
    bad(`发送失败：${e.message}`);
    return 1;
  }

  console.log();
  console.log(C.bold('  ── 现在请照做，这一步只能在真机上验证 ──'));
  console.log(`  ${C.bold('1.')} 手机应该弹出通知。先别在手机上点。`);
  console.log(`  ${C.bold('2.')} 锁屏（或把手机屏幕扣下去），让通知镜像到 Apple Watch。`);
  console.log(`  ${C.bold('3.')} 抬腕看到卡片后，${C.bold('先别点卡片本体')} —— ` +
              C.bold('旋转数码表冠把卡片滚到最底部') + `，`);
  console.log(`      按钮就在最下面 → 点「✅ 我在手表上按到了」。`);
  console.log(`  ${C.dim('      ⚠️ 点卡片本体 = 打开 HA App，不产生任何决策。')}` +
              C.dim('按钮在长视图底部，滚表冠才出现 —— 这是 Apple 的设计，不是坏了。'));
  console.log(`  ${C.dim('      手机上同理：长按卡片展开（锁屏右→左滑点「查看」；非锁屏时下拉）。')}`);
  console.log();

  // [5] 等事件回来
  step(5, `等待手表回传（最多 ${waitSec} 秒）`);
  const t0 = Date.now();
  const found = await new Promise((resolve) => {
    const tick = setInterval(() => {
      const hit = events.find((e) => {
        const d = e.data || {};
        return String(d.action || d.actionName || '').startsWith(testAction);
      });
      if (hit) {
        clearInterval(tick);
        resolve(hit);
        return;
      }
      if ((Date.now() - t0) / 1000 > waitSec) {
        clearInterval(tick);
        resolve(null);
      }
      process.stdout.write(
        `\r${C.dim(`  已等待 ${Math.floor((Date.now() - t0) / 1000)}s …`)}`
      );
    }, 500);
  });
  process.stdout.write('\r' + ' '.repeat(40) + '\r');

  try { wsResult.ws.close(); } catch {}

  if (found) {
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const d = found.data || {};
    ok(C.bold(`往返成功！耗时 ${secs} 秒`));
    console.log();
    info('HA 回传的事件内容（用于核对字段名）：');
    for (const [k, v] of Object.entries(d)) {
      info(`  ${k} = ${JSON.stringify(v)}`);
    }
    console.log();
    // 只出现 action 是**正常的**，不是漏字段。iOS App 按一次通知按钮会同时发两个事件：
    //   mobile_app_notification_action  → { action, action_data?, reply_text? }   ← 我们订阅的
    //   ios.notification_action_fired   → { actionName, categoryName, sourceDeviceName, ... }
    // 设备信息只在旧事件里，而旧事件报的永远是「手机那台设备的注册名」——
    // 手表点了也分不出来。所以 ha.mjs 不再读 deviceName，这里把结论直接说清楚，
    // 免得下次再有人以为「少打了一个字段」。
    if (!('sourceDeviceName' in d)) {
      info(C.dim('↑ 只有 action 是正常的：iOS 一次点击会同时发两个事件，设备信息只在'));
      info(C.dim('  旧事件 ios.notification_action_fired 上，而那个事件也分不出'));
      info(C.dim('  「手机点的还是手表点的」（两者报的都是手机那台设备的注册名）。'));
      info(C.dim('  详见 SETUP.md §1.5。'));
      console.log();
    }
    console.log(`  ${C.green('这条链路已经打通：')}HA → iPhone → 手表镜像 → 表上点按钮 → HA 事件 → 网关`);
    console.log();
    console.log(`  ${C.bold('接下来把它接进 Agent：')}`);
    console.log(`   1. 把 channels.ha.token 与 notifyService 填进 ${from || 'config.json'}`);
    console.log(`   2. 把 ${C.cyan('"channel": "mock"')} 改成 ${C.cyan('"channel": "ha"')}`);
    console.log(`   3. 重启网关，然后跑 ${C.cyan('npm run selftest')} 确认没破坏别的逻辑`);
    console.log(`   4. 按 SETUP.md 把 hook 与 MCP 接进 ~/.workbuddy/settings.json 和 mcp.json`);
    console.log();
    return 0;
  }

  bad(`等了 ${waitSec} 秒没收到回传。`);
  console.log();
  info('按这个顺序排查（前两条覆盖绝大多数情况）：');
  console.log(`  ${C.bold('1.')} 推的那一刻，iPhone 是**锁屏**的吗？`);
  console.log(`     ${C.dim('iOS 只在 iPhone 锁屏 / 息屏时才把通知镜像到手表。')}`);
  console.log(`     ${C.dim('手机亮着、你正拿着它看，通知就只会留在手机上 ——')}`);
  console.log(`     ${C.dim('这就是最常见的「手机收到了、手表收不到」。')}`);
  console.log(`     ${C.dim('测法：按一下侧边键让屏幕黑掉，别碰手机，然后再推一次。')}`);
  console.log(`  ${C.bold('2.')} 镜像开关开了吗？`);
  console.log(`     ${C.dim('iPhone 上的「Watch」App → 通知 → Home Assistant →「镜像我的 iPhone」。')}`);
  console.log(`     ${C.dim('选成「关闭」的话，通知完全不会到手表。')}`);
  console.log(`  ${C.bold('3.')} 手表上装了 Home Assistant 的 Watch App 吗？`);
  console.log(`     ${C.dim('没装 Watch App 时通知可能能镜像过去，但**没有按钮** ——')}`);
  console.log(`     ${C.dim('Apple 的限制：手表只镜像 iPhone 已注册的 UNNotificationAction。')}`);
  console.log(`  ${C.bold('4.')} 先把链路问题和手表问题分开：在**手机**上点一次按钮。`);
  console.log(`     ${C.dim('手机能回传 ⇒ 通知通道 + 回传通道都是好的，剩下纯粹是手表镜像。')}`);
  console.log(`  ${C.bold('5.')} 是不是点了「忽略」？那只回传 :ignore 结尾的 action，脚本判为未命中。`);
  console.log(`  ${C.bold('6.')} 加大等待时间再试：${C.dim('--wait 300')}`);
  console.log();
  return 1;
}

// ── 入口 ──────────────────────────────────────────────────────────────────
const commands = { doctor, link };
const fn = commands[mode];
if (!fn) {
  console.error(`未知模式 "${mode}"。可用：${Object.keys(commands).join(' / ')}`);
  process.exit(2);
}
process.on('unhandledRejection', (e) => {
  console.error('\n未捕获的异常：', e && e.message ? e.message : e);
  process.exit(1);
});
process.exit(await fn());
