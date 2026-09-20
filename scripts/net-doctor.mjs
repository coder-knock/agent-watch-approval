#!/usr/bin/env node
// 局域网地址漂移体检器 —— 专治「本地 HA 的 IP 会一直变动」。
//
// ── 根因（2026-09-19 从 HA 源码逐行确认，不是推测）────────────────────────
// zeroconf 集成只在 HA **启动那一刻**注册一次 mDNS 广播：
//
//   homeassistant/components/zeroconf/__init__.py
//     async_setup()                                  ← 只跑一次
//       → _async_get_local_service_info(hass)        ← 此刻算好地址与 URL
//       → async_when_setup_or_start(hass, "frontend", _async_zeroconf_hass_start)
//           → aio_zc.async_register_service(local_service_info, allow_name_change=True)
//
// 全文件没有 EVENT_NETWORK、没有 ip-address-changed 监听。
// 也就是说：**HA 启动之后本机 IP 一变，广播里的地址就永远停在旧值**，
// 不重启 HA 不会自愈。
//
// 实测症状链：HA 01:04:00 启动时 Mac 还在旧 WiFi 网段 192.168.31.99 →
//   之后 Mac 换到 192.168.0.5 → 广播里至今仍是 192.168.31.99 →
//   iPhone 上 HA App 拿着旧地址永远连不上 → 本地推送通道建不起来 →
//   每次 notify.mobile_app_* 都 500 → 手表收不到卡片 → hook 按 deny 兜底。
//
// ── 两种修法，本脚本把两件都做了 ───────────────────────────────────────────
//   A. 治本：让 HA 用「名字」而不是「IP」标识自己。把 configuration.yaml 里
//      homeassistant: 下的 internal_url 写成 <本机 LocalHostName>.local:8123。
//      广播里带的就是这个稳定名字，iPhone 每次连接时用 mDNS 重新解析它，
//      **IP 变了自动跟随，HA 连重启都不用**。
//   B. 兜底：IP 真变了就催 HA 重新广播一次（--repair，走
//      POST /api/services/homeassistant/restart，不依赖 launchctl，沙箱里也能用）。
//
// ── 为什么 A 还不够、B 仍需要 ─────────────────────────────────────────────
// 广播里除了 internal_url 还有 **A 记录**（parsed_addresses = 本机各网卡 IP）。
// iPhone 上 HA App 的「搜索服务器」先看到 A 记录才会去取 URL；A 记录停在旧网段
// 时，App 的发现列表本身就指向一个连不上的地址。所以地址变了还是要重播一次。
//
// ── 体检的 9 项 ───────────────────────────────────────────────────────────
//   ① 本机出口地址          ② HA 有没有在广播
//   ③ 广播地址 vs 本机当前地址（★ 漂移就在这里现形）
//   ④ 广播里的 internal_url 是裸 IP 还是稳定名字
//   ⑤ HA 配置层的 internal_url      ⑥ configuration.yaml 是否已写死
//   ⑦ 网关是不是走回环访问 HA       ⑧ HA 有没有 launchd 托管
//   ⑨ ★ 手机上的 HA App 在不在线
//
// ⚠️ 第 ⑨ 项是后来补的，补的理由值得记着：前 8 项查的全是「Mac ↔ HA 之间的寻址」，
//    而**寻址对了不等于手机收得到**。实测遇到过 8 项全绿、iPhone 上的 HA App
//    却早就掉线的情况 —— 那时每次 notify 都 500，用户体感是「推送坏了」，
//    但照前 8 项看一切正常。一个体检器如果答不出「那为什么收不到」，
//    它给的就是虚假的安心。
//
// ── 用法 ─────────────────────────────────────────────────────────────────
//   approval net                 体检（只读，不改任何东西）
//   approval net --json          同上，JSON 输出（给程序/自动化消费）
//   approval net --repair        发现漂移就重启 HA 让它重新广播，然后复检
//   approval net --once          给 LaunchAgent 周期调用：没漂移就一声不吭
//   approval net --timeout 10    mDNS 监听秒数（默认 6）
//
// 退出码：0 = 无漂移；1 = 有漂移；2 = 跑不起来（HA 没起 / 缺依赖）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dgram from 'node:dgram';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assessDeviceReadiness } from '../src/channels/device-readiness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const HA_PY = path.join(os.homedir(), '.ha-venv', 'bin', 'python3');
const MDNS_PROBE = path.join(HERE, 'probe-mdns.py');
const HA_CONFIG_YAML = path.join(os.homedir(), '.homeassistant', 'configuration.yaml');
const LOG_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'net-watch.log');

// ── 输出小工具（与 verify-ha.mjs 保持一致的视觉语言）──────────────────────
const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const args = (() => {
  const out = { _: [] };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      out[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    } else out._.push(a);
  }
  return out;
})();

const QUIET = args.once === 'true';
const JSON_OUT = args.json === 'true';
const DO_REPAIR = args.repair === 'true' || QUIET;
const MDNS_TIMEOUT = Number(args.timeout || (QUIET ? 4 : 6));

function say(msg) {
  if (!QUIET && !JSON_OUT) console.log(msg);
}

// ── 事实采集 ──────────────────────────────────────────────────────────────

/** 本机默认出口 IPv4。用一个「连出去但不真发包」的 UDP socket 问内核要，
 *  拿到的一定是路由表真正会用到的那个地址 —— 比遍历网卡更接近「别人眼中的我」。 */
function defaultIPv4() {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    sock.on('error', () => {
      try { sock.close(); } catch {}
      resolve(null);
    });
    try {
      sock.connect(80, '8.8.8.8', () => {
        let addr = null;
        try { addr = sock.address().address; } catch {}
        try { sock.close(); } catch {}
        resolve(addr && !addr.startsWith('127.') ? addr : null);
      });
    } catch {
      try { sock.close(); } catch {}
      resolve(null);
    }
  });
}

/** 所有非回环、非自分配(169.254)的 IPv4，附带所在网卡名。 */
function allLanIPv4s() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const [name, list] of Object.entries(ifaces)) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.address.startsWith('169.254.')) continue; // 自分配地址 = 没拿到 DHCP
      out.push({ iface: name, address: a.address, netmask: a.netmask });
    }
  }
  return out;
}

/** 形如 192.168.0.5 → 192.168.0.0/24 的网络前缀，用来判断是否跨网段。
 *  导出给测试用（纯函数，无副作用）。 */
export function slash24(ip) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.\d+$/.exec(String(ip || ''));
  return m ? `${m[1]}.${m[2]}.${m[3]}.0/24` : null;
}

function run(cmd, argv, opts = {}) {
  try {
    return execFileSync(cmd, argv, { encoding: 'utf8', timeout: 30000, ...opts }).trim();
  } catch {
    return null;
  }
}

/** Mac 的 Bonjour 名（LocalHostName）。它在本机所有 IP 变化时保持不变，
 *  所以是「稳定标识」的最佳候选 —— iPhone 端 mDNS 能直接解析。 */
function localHostName() {
  return run('/usr/sbin/scutil', ['--get', 'LocalHostName']) || null;
}

function loadHaCfg() {
  for (const f of ['config.json', 'config.example.json']) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    try {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      return cfg.channels?.ha || {};
    } catch {}
  }
  return {};
}

/** 读 HA 的 mDNS 广播。依赖 ~/.ha-venv 里的 zeroconf 包（HA 自己就用它）。 */
function haBroadcast(timeoutSec) {
  if (!fs.existsSync(HA_PY) || !fs.existsSync(MDNS_PROBE)) {
    return { ok: false, reason: '找不到 ~/.ha-venv/bin/python3 或 scripts/probe-mdns.py' };
  }
  const raw = run(HA_PY, [MDNS_PROBE, '--json', '--timeout', String(timeoutSec)]);
  if (!raw) return { ok: false, reason: 'mDNS 探测进程没跑起来' };
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'mDNS 探测输出不是合法 JSON' };
  }
  if (!j.ok || !j.services?.length) return { ok: true, services: [] };
  return { ok: true, services: j.services };
}

async function haApiConfig(baseUrl, token) {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/config`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/** 目标设备现在能不能收到推送（判定逻辑在 src/channels/device-readiness.mjs）。
 *
 *  为什么这个医生要管这件事：前 8 项查的全是「Mac ↔ HA 之间的寻址」，
 *  而寻址对了**不等于**手机收得到 —— 实测 8 项全绿、手机 App 却掉线的那种。
 *  既然这个医生存在的意义就是回答「推送为什么没到」，就必须把最后一段也查了。 */
async function probeDevice(baseUrl, token, notifyService) {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/states`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return {
        slug: notifyService, liveness: [], context: [], entitiesSeen: 0, reporting: null,
        reason: `读 /api/states 失败（HTTP ${res.status}），判不了设备状态。`,
      };
    }
    return assessDeviceReadiness(await res.json(), notifyService);
  } catch (e) {
    return {
      slug: notifyService, liveness: [], context: [], entitiesSeen: 0, reporting: null,
      reason: `连不上 HA（${e.message}），判不了设备状态。`,
    };
  }
}

/** 从 configuration.yaml 文本里取 homeassistant: 块下的 internal_url。
 *  只认「缩进在 homeassistant: 之下」的那一行 —— 不能用全文正则，
 *  否则注释里出现的例子（本文件注释里就有）会被当成真配置读出来。
 *  导出给 test/net-doctor.test.mjs 用。 */
export function parseYamlInternalUrl(text) {
  const lines = String(text).split('\n');
  let inHa = false;
  for (const line of lines) {
    if (/^homeassistant:\s*$/.test(line)) { inHa = true; continue; }
    if (inHa && /^\S/.test(line)) inHa = false;
    if (!inHa) continue;
    const m = /^\s+internal_url:\s*(\S+)\s*(?:#.*)?$/.exec(line);
    if (m) return m[1].replace(/^["']|["']$/g, '');
  }
  return null;
}

/** 本机 configuration.yaml 里是否已经写死了 internal_url（判断「钉名字」落没落地）。 */
function yamlInternalUrl() {
  if (!fs.existsSync(HA_CONFIG_YAML)) return null;
  return parseYamlInternalUrl(fs.readFileSync(HA_CONFIG_YAML, 'utf8'));
}

export function hostOf(url) {
  try { return new URL(url).hostname; } catch { return null; }
}

/** HA 有没有被 launchd 托管 —— 这决定了「重启」这个动作安不安全：
 *  有托管 → 收到重启请求后进程退出，launchd 的 KeepAlive 会把它拉起来；
 *  没托管 → 同一请求就是把 HA 直接杀掉，没人再拉。返回 yes / no / unknown。 */
function supervision() {
  try {
    execFileSync('/bin/launchctl', ['print', `gui/${process.getuid()}/${HA_LABEL}`], {
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000,
    });
    return 'yes';
  } catch (e) {
    const msg = `${e?.stderr || ''}${e?.stdout || ''}${e?.message || ''}`;
    if (/could not find service|service .* not found|not find service/i.test(msg)) return 'no';
    return 'unknown'; // 沙箱里读不到 —— 不臆断，宁可不说
  }
}

export const isBareIp = (h) => !!h && /^\d+\.\d+\.\d+\.\d+$/.test(h);

// ★ 重启 HA 的唯一正当理由：**广播本身不对**。
//
// 踩过的坑（2026-09-20 实测，代价是 HA 每 2 分 33 秒被踢一次）：
// 这里原先写的是 `hasBad`（体检里**任何一条** bad 级发现）去触发 restartHa。
// 但 bad 里有一条是「手机上的 HA App 没在连」—— 那**重启 HA 根本治不好**，
// 反而每次重启都把手机与 HA 之间的 local push websocket 掐断，于是变成：
// 手机没连 → 重启 HA → 手机更连不上 → 120 秒后重来一轮，永远好不了。
// 用户体感正是「HA 和手机连接不稳定」，而日志里还写着
// 「检测到漂移：广播=192.168.31.99 本机=192.168.31.99」（两边明明一模一样）。
//
// 正确判据只有两条，都在「广播」这一层：
//   · drifted          —— 广播里带的是旧地址（zeroconf 只在 HA 启动时注册一次）
//   · !broadcastFound  —— 压根没广播（得重启 HA 才会重新注册）
// 其它 bad（手机掉线、internal_url 过期……）只记账、不动 HA。
export function needsRebroadcast(report) {
  if (!report) return false;
  return report.drifted === true || report.broadcastFound === false;
}

// ── 主流程 ────────────────────────────────────────────────────────────────

async function collect() {
  const haCfg = loadHaCfg();
  const baseUrl = haCfg.baseUrl || 'http://localhost:8123';
  const token = haCfg.token || '';
  const notifyService = haCfg.notifyService || null;

  const defIp = await defaultIPv4();
  const nics = allLanIPv4s();
  const hostName = localHostName();
  const stableName = hostName ? `${hostName}.local` : null;
  const yamlUrl = yamlInternalUrl();

  const bc = haBroadcast(MDNS_TIMEOUT);
  const apicfg = await haApiConfig(baseUrl, token);

  const svc = bc.services?.[0] || null;
  const advertised = svc?.addresses || [];
  const internalUrl = svc?.properties?.internal_url || null;
  const broadcastHost = isBareIp(hostOf(internalUrl)) ? hostOf(internalUrl) : null;

  const apiInternal = apicfg.ok ? (apicfg.data.internal_url || null) : null;
  const apiHostName = isBareIp(hostOf(apiInternal)) ? hostOf(apiInternal) : null;

  // ── 判定 ────────────────────────────────────────────────────────────
  const findings = [];
  const add = (level, title, detail, hint) => findings.push({ level, title, detail, hint });

  // 1. 本机出口地址
  if (!defIp && !nics.length) {
    add('bad', '本机没有任何可用的局域网地址',
      '所有网卡都是回环或 169.254 自分配 —— 说明根本没连上网',
      '先确认 Wi-Fi / 网线接通，能 ping 通路由器网关');
  } else {
    add('ok', '本机出口地址', `${defIp || '(判定不出默认出口)'}　网卡：${nics.map((n) => `${n.iface}=${n.address}`).join(' ') || '(无)'}`);
  }

  // 2. HA 有没有在广播
  if (!bc.ok) {
    add('bad', 'mDNS 探测跑不起来', bc.reason, '确认 ~/.ha-venv 里有 zeroconf 包');
  } else if (!svc) {
    add('bad', '没发现 HA 的 mDNS 广播',
      'iPhone 上 HA App 的「搜索服务器」靠的就是这条广播，没有它手机搜不到 HA',
      '确认 configuration.yaml 里有 zeroconf: 且 HA 已重启；部分访客 Wi-Fi 禁组播');
  } else {
    add('ok', '发现 HA 广播', `${svc.name} → ${advertised.join(', ') || '(无地址)'}:${svc.port}`);
  }

  // 3. ★核心：广播里的地址含不含本机当前地址
  let drifted = false;
  if (svc && defIp) {
    const hit = advertised.includes(defIp);
    if (hit) {
      add('ok', '广播地址与本机一致', `${defIp} 在广播列表里`);
    } else {
      drifted = true;
      const sameNet = advertised.some((a) => slash24(a) === slash24(defIp));
      add('bad', '★ 广播地址是旧的（地址漂移）',
        `广播说自己是 ${advertised.join(', ') || '(空)'}，本机现在其实是 ${defIp}` +
        `　${sameNet ? '（同网段，只是换了主机位）' : '（★ 跨网段了：广播还在旧网段）'}`,
        'zeroconf 只在 HA 启动时注册一次，IP 变了不会自愈。' +
        '修法：approval net --repair（重启 HA 重新广播）。' +
        (sameNet ? '' : ' 跨网段时手机必须和 Mac 在同一个网段，mDNS 不跨网段。'));
    }
  } else if (svc && !defIp) {
    add('warn', '判不出本机出口地址，无法比对广播', '跳过漂移判定');
  }

  // 4. 广播里的 internal_url：是裸 IP 还是稳定名字
  if (svc) {
    const bh = hostOf(internalUrl);
    if (!internalUrl) {
      add('warn', '广播里没带 internal_url', 'HA 算不出自己的 URL', '给 HA 配一个 internal_url');
    } else if (isBareIp(bh)) {
      const stale = defIp && bh !== defIp;
      add(stale ? 'bad' : 'warn',
        stale ? '★ 广播里的 internal_url 是过期 IP' : '广播里的 internal_url 是裸 IP',
        `${internalUrl}　（裸 IP 的地址一旦换网就永久失效）`,
        stableName
          ? `改成稳定名字：http://${stableName}:8123（写进 configuration.yaml 的 homeassistant: 下）`
          : '把 internal_url 改成 Bonjour 名字');
    } else if (stableName && bh && bh.toLowerCase() === stableName.toLowerCase()) {
      // 注意：URL 解析出的 hostname 已经被小写化（your-mac.local），
      // 而 scutil 给的是 Your-Mac.local —— 必须忽略大小写比，否则误报。
      add('ok', '广播里的 internal_url 已是稳定名字', internalUrl);
    } else {
      add('warn', '广播里的 internal_url 是一个非本机名字', internalUrl, '确认这个名字在本机能解析');
    }
  }

  // 5. HA 配置层的 internal_url
  if (apicfg.ok) {
    const apiHost = hostOf(apiInternal);
    if (!apiInternal) {
      add('warn', 'HA 配置里没有 internal_url（靠自动探测）',
        'HA 会拿启动瞬间的 IP 当自己的地址 —— 这正是 IP 变化后失效的源头',
        stableName ? `建议固定成 http://${stableName}:8123` : '建议固定成 Bonjour 名字');
    } else if (isBareIp(apiHost)) {
      add('warn', 'HA 的 internal_url 是裸 IP', apiInternal,
        stableName ? `建议固定成 http://${stableName}:8123` : '建议固定成 Bonjour 名字');
    } else {
      add('ok', 'HA 的 internal_url 是稳定名字', apiInternal);
    }
  } else {
    add('bad', '读不到 HA 的 /api/config',
      apicfg.reason || `HTTP ${apicfg.status}`,
      'HA 没在跑，或 config.json 里的令牌不对');
  }

  // 6. configuration.yaml 是否已落地
  if (yamlUrl) {
    add('ok', 'configuration.yaml 已写死 internal_url', yamlUrl);
  } else {
    add('warn', 'configuration.yaml 里没写 internal_url',
      '当前依赖 HA 自动探测，IP 一变就偏',
      stableName ? `加上：internal_url: http://${stableName}:8123` : '加上 internal_url');
  }

  // 7. 网关侧
  const gwHost = hostOf(baseUrl);
  if (gwHost === 'localhost' || gwHost === '127.0.0.1' || gwHost === '::1') {
    add('ok', '网关走本机回环访问 HA', `${baseUrl}（不受 IP 漂移影响，设计正确）`);
  } else {
    add('warn', '网关不是走回环访问 HA', `${baseUrl}　建议改成 http://localhost:8123`);
  }

  // 8. HA 有没有被 launchd 托管（决定「重启」安不安全、重启 Mac 后会不会自动起来）
  const sup = supervision();
  if (sup === 'no') {
    add('warn', 'HA 没有 launchd 托管',
      '收到「重启」请求时它会直接退出，而没有人把它拉起来；重启 Mac 后也不会自动起',
      '在普通终端跑：approval ha install（沙箱里装不了 LaunchAgent）');
  } else if (sup === 'yes') {
    add('ok', 'HA 由 launchd 托管', 'KeepAlive 生效，重启与开机自启都由它兜住');
  }

  // 9. 目标设备（手机）现在能不能收到推送
  //
  // 前 8 项查的全是「Mac ↔ HA 之间」的寻址。但**寻址对了不等于手机收得到**：
  // 实测遇到过 8 项全绿、而 iPhone 上的 HA App 早就掉线的情况 ——
  // 那时每次 notify 都 500，用户的体感是「推送坏了」。
  // 既然这个医生存在的意义就是回答「推送为什么没到」，就必须把这一段也查了。
  //
  // 判定原理与边界见 src/channels/device-readiness.mjs 的头部注释。
  let readiness = null;
  if (notifyService && apicfg.ok) {
    readiness = await probeDevice(baseUrl, token, notifyService);
    const dev = notifyService.replace(/^mobile_app_/, '');
    if (readiness.reporting === true) {
      add('ok', '手机上的 HA App 在线（推送通道健在）', readiness.reason);
    } else if (readiness.reporting === false) {
      add('bad', '★ 手机上的 HA App 没在连（推送必 500）',
        readiness.reason,
        '把 iPhone 连回与 Mac 同一个网段的网络，再打开 HA App 确认它指向 ' +
        'http://<LocalHostName>.local:8123 —— App 连上后才会把推送通道注册到 HA。' +
        `（本条查的是设备 ${dev}）`);
    } else {
      add('warn', '判不了手机在不在线（不是故障，是信息不足）', readiness.reason,
        `确认 config.json 的 channels.ha.notifyService 与 HA 里的设备名一致（当前：${notifyService}）`);
    }
  } else if (notifyService && !apicfg.ok) {
    add('warn', 'HA 读不到，跳过「手机在不在线」这一项', '先解决上面第 5 项的 /api/config 问题');
  } else {
    add('warn', 'config.json 里没配 notifyService，跳过「手机在不在线」这一项',
      '没有它就无法判断推送会发给谁', '在 channels.ha.notifyService 里写 mobile_app_<设备名>');
  }

  return {
    hostName, stableName, defIp, nics, baseUrl, notifyService,
    advertised, internalUrl, apiInternal, yamlUrl, supervision: sup,
    broadcastFound: !!svc, drifted, readiness, findings,
  };
}

// ── 修复：让 HA 按当前地址重新广播 ────────────────────────────────────────
//
// ⚠️ 这里踩过一个**会把 HA 彻底弄停**的坑，必须写清楚：
//
//   `POST /api/services/homeassistant/restart` 并不让 HA 自己重启 ——
//   homeassistant/__main__.py 第 184 行只是 `return RESTART_EXIT_CODE`（值 100），
//   真正把进程重新拉起来的是 **launchd 的 KeepAlive**（plist 里 KeepAlive=true）。
//   所以如果 HA 当初是用 nohup / run-detached.py 起的（没有 launchd 托管），
//   「请求重启」= 把它直接杀掉，之后**再也没人拉起来**。
//   实测就因为这个把 HA 停过一次（发出重启请求后端口再没回来）。
//
// 所以修复分两条路，并且最后必须兜住「HA 一定要活着」：
//   ① 有 launchd 托管 → launchctl kickstart -k（最干净，launchd 记账正确）
//   ② 没有托管       → 先 SIGTERM 再（必要时）SIGKILL，然后用 run-detached.py 重新拉起
//   ③ 无论走哪条，最后都确认端口回来了；没回来就直接拉起，绝不留下一个死掉的 HA
//
// 可复用的教训：**任何「重启外部服务」的自动化，都必须自己确认它回来了。**
// 不能假设「发个重启请求就完事」—— 服务是怎么被托管的，决定了重启请求的语义完全不同。

const RUN_DETACHED = path.join(HERE, 'run-detached.py');
const HASS_BIN = path.join(os.homedir(), '.ha-venv', 'bin', 'hass');
const HA_DIR = path.join(os.homedir(), '.homeassistant');
const HA_LABEL = 'cn.local.homeassistant';

/** 当前占着 8123 的 PID（没有则 null）。ps 在沙箱里被拒，lsof 可以。 */
function haPid() {
  const out = run('/usr/sbin/lsof', ['-nP', '-iTCP:8123', '-sTCP:LISTEN', '-t']);
  return out ? out.split('\n').filter(Boolean)[0] : null;
}

async function waitPort(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (haPid()) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

function spawnDetachedHa() {
  say(`${C.cyan('·')} 用脱离会话方式拉起 HA…`);
  run('/usr/bin/python3', [
    RUN_DETACHED,
    '--cd', HA_DIR,
    '--log', path.join(HA_DIR, 'ha-detached.log'),
    '--', HASS_BIN, '--config', HA_DIR,
  ]);
}

/** 「请求 HA 自己退出」——只有在有托管（launchd KeepAlive）时才有意义。 */
async function requestHaRestart(baseUrl, token) {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/services/homeassistant/restart`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(10000),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function restartHa(baseUrl, token) {
  // ① 有没有 launchd 托管？读不到就按「没有」处理 ——
  //    因为②那条路在任何情况下都不会把 HA 弄丢，而把「有托管」误判成「没托管」
  //    最坏结果也只是多杀一次进程，随后被我们重新拉起。
  let supervised = false;
  try {
    execFileSync('/bin/launchctl', ['print', `gui/${process.getuid()}/${HA_LABEL}`], {
      stdio: 'ignore', timeout: 8000,
    });
    supervised = true;
  } catch {}

  if (supervised) {
    say(`${C.cyan('·')} HA 由 launchd 托管 → kickstart -k`);
    try {
      execFileSync('/bin/launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${HA_LABEL}`], { timeout: 15000 });
    } catch (e) {
      say(`${C.yellow('⚠️ ')} kickstart 失败（${e.message}），退回「请求 HA 自己重启」`);
      await requestHaRestart(baseUrl, token);
    }
  } else {
    say(`${C.yellow('⚠️ ')} HA 没有 launchd 托管：只发重启请求会把它直接杀掉、没人拉起`);
    say(`${C.dim('   改成「停掉 → 重新拉起」，并保证最后它一定活着')}`);
    const pid = haPid();
    if (pid) {
      try { process.kill(Number(pid), 'SIGTERM'); } catch {}
      await new Promise((r) => setTimeout(r, 3000));
      if (haPid()) { try { process.kill(Number(pid), 'SIGKILL'); } catch {} }
    }
    await waitPort(15000);
    spawnDetachedHa();
  }

  // ③ 兜底：无论走哪条路，HA 必须活着
  if (!(await waitPort(90000))) {
    say(`${C.yellow('⚠️ ')} 90 秒内没起来，直接拉起`);
    spawnDetachedHa();
    if (!(await waitPort(90000))) {
      return { ok: false, reason: 'HA 拉不起来，看 approval ha logs' };
    }
  }
  // 再等 zeroconf 把新地址广播出去
  await new Promise((r) => setTimeout(r, 12000));
  return { ok: true, supervised };
}

function appendLog(line) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

// ── 渲染 ──────────────────────────────────────────────────────────────────

function render(r) {
  console.log(`${C.bold('局域网地址漂移体检')}  ${C.dim('（Mac ↔ iPhone 之间只有 mDNS 一条自动寻址通道）')}\n`);

  const icon = { ok: '✅', warn: '⚠️ ', bad: '❌' };
  const color = { ok: C.green, warn: C.yellow, bad: C.red };
  for (const f of r.findings) {
    console.log(`${icon[f.level]} ${color[f.level](f.title)}`);
    if (f.detail) console.log(`   ${f.detail}`);
    if (f.hint && f.level !== 'ok') console.log(`   ${C.dim('→ ' + f.hint)}`);
  }

  const bad = r.findings.filter((f) => f.level === 'bad').length;
  const warn = r.findings.filter((f) => f.level === 'warn').length;

  console.log('');
  if (bad) {
    console.log(C.red(`结论：有 ${bad} 处硬问题${warn ? `、${warn} 处隐患` : ''}。`));
    if (r.drifted) {
      console.log(C.dim('  修：approval net --repair   （重启 HA 让它按当前地址重新广播）'));
    }
  } else if (warn) {
    console.log(C.yellow(`结论：现在能用，但有 ${warn} 处隐患：`));
    for (const f of r.findings.filter((x) => x.level === 'warn')) {
      console.log(C.dim(`   · ${f.title}`));
    }
  } else {
    console.log(C.green('结论：地址稳定，手机按 mDNS 就能找到 HA。'));
  }

  // ★ 「地址没问题」不等于「推得出去」。
  // 这一条必须单独说，否则用户会拿「体检全绿」当成「推送应该没问题」。
  if (r.readiness) {
    if (r.readiness.reporting === false) {
      console.log(C.red('\n  ⚠️ 但推送仍然发不出去：手机上的 HA App 现在没在连。'));
      console.log(C.dim('     地址修好了也白搭 —— 手机必须先在 HA 上连上，推送通道才有地方注册。'));
      console.log(C.dim('     见上面第 9 项的「→ 下一步」。'));
    } else if (r.readiness.reporting === true) {
      console.log(C.green('\n  手机端也确认在线：推送链路从 Mac 一路通到设备。'));
    } else {
      console.log(C.dim('\n  手机在不在线：判不了（信息不足，不等于坏了）。'));
    }
  }

  console.log(C.dim('\n  提示：mDNS 不跨网段 —— Mac 和 iPhone 必须在同一个网段，'));
  console.log(C.dim('        否则本地推送永远建不起来（跨网络场景请上 Tailscale）。'));
}

// ── 入口 ──────────────────────────────────────────────────────────────────
// 只有被直接执行时才跑主流程；被 test/net-doctor.test.mjs import 时
// 只暴露纯函数（parseYamlInternalUrl / slash24 / hostOf / isBareIp / needsRebroadcast），不起网络请求。

async function main() {
  // --restart-ha：只做「重启并确认它活着」，不跑体检。
  // 给 scripts/ha-service.sh restart 用 —— 这样「重启 HA」只有一条实现，
  // 也就不会再出现「发了重启请求、HA 却没人拉起」的那种事故。
  if (args['restart-ha'] === 'true') {
    const c = loadHaCfg();
    const rep = await restartHa(c.baseUrl || 'http://localhost:8123', c.token || '');
    if (rep.ok) {
      console.log(`${C.green('✅')} HA 已重启，8123 在监听（托管：${rep.supervised ? 'launchd' : '无 —— 已由本脚本重新拉起'}）`);
      return 0;
    }
    console.log(`${C.red('❌')} ${rep.reason}`);
    return 1;
  }

  const r = await collect();

  if (JSON_OUT) {
    console.log(JSON.stringify({
      ok: r.findings.every((f) => f.level !== 'bad'),
      drifted: r.drifted,
      hostName: r.hostName,
      stableName: r.stableName,
      defaultIPv4: r.defIp,
      nics: r.nics,
      advertised: r.advertised,
      advertisedInternalUrl: r.internalUrl,
      configuredInternalUrl: r.apiInternal,
      yamlInternalUrl: r.yamlUrl,
      supervision: r.supervision,
      findings: r.findings,
    }, null, 2));
    return r.findings.some((f) => f.level === 'bad') ? 1 : 0;
  }

  const hasBad = r.findings.some((f) => f.level === 'bad');

  if (QUIET) {
    // LaunchAgent 模式：平时一声不吭，只有出问题才说话并留日志。
    // ★ 重启的判据是 needsRebroadcast（广播本身不对），**不是 hasBad** ——
    //   拿 hasBad 触发过一次「每 120 秒重启 HA」的死循环，详见该函数注释。
    if (needsRebroadcast(r) && DO_REPAIR) {
      appendLog(`检测到地址漂移：广播=${r.advertised.join(',') || '(无)'} 本机=${r.defIp} → 触发修复`);
      const rep = await restartHa(r.baseUrl, loadHaCfg().token || '');
      appendLog(rep.ok ? '修复完成（HA 已重启并重新广播）' : `修复失败：${rep.reason}`);
      const after = await collect();
      if (needsRebroadcast(after)) {
        console.log(`[net-watch] 地址漂移自动修复后仍未恢复：广播=${after.advertised.join(',') || '(无)'} 本机=${after.defIp}（详见 ${LOG_FILE}）`);
        return 1;
      }
      appendLog(`修复后广播=${after.advertised.join(',') || '(无)'}`);
    } else if (hasBad) {
      // 体检有问题，但问题不在广播上 —— 只记账，绝不重启 HA。
      const titles = r.findings.filter((f) => f.level === 'bad').map((f) => f.title).join('；');
      appendLog(`体检不通过（非地址漂移，不重启 HA）：${titles}`);
    }
    return hasBad ? 1 : 0;
  }

  render(r);

  if (DO_REPAIR && needsRebroadcast(r)) {
    console.log('');
    const rep = await restartHa(r.baseUrl, loadHaCfg().token || '');
    if (!rep.ok) {
      console.log(`${C.red('❌')} 修复失败：${rep.reason}`);
      return 1;
    }
    console.log(`${C.green('✅')} HA 已重启并重新广播`);
    console.log('');
    const after = await collect();
    render(after);
    return after.findings.some((f) => f.level === 'bad') ? 1 : 0;
  }

  return hasBad ? 1 : 0;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  process.exit(await main());
}
