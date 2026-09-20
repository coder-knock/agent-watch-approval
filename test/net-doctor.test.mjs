#!/usr/bin/env node
// `scripts/net-doctor.mjs` 的纯函数测试。
//
// 存在的理由：这个脚本负责判断「HA 广播的地址是不是过期了」，
// 而它的判定建立在四个很容易写错的纯函数上，每一个都真的写错过：
//
//   1. hostOf() —— URL 会把主机名**小写化**：
//        new URL('http://Your-Mac.local:8123').hostname
//          === 'your-mac.local'
//      而 scutil 给的是 'Your-Mac.local'。第一版用 === 直接比，
//      结果一个完全正常的配置被报成「非本机名字」。必须忽略大小写。
//
//   2. parseYamlInternalUrl() —— 它要读 configuration.yaml 里 homeassistant:
//      块下的 internal_url。第一版用全文正则扫，而 configuration.yaml 的
//      **注释里就写着 internal_url: http://... 作为示例** —— 于是注释被当成真配置。
//      正确做法是只在 homeassistant: 的缩进范围内找，且行首不能是 #。
//
//   3. slash24() —— 判「跨网段」用。广播说 192.168.31.99、本机是 192.168.0.5，
//      要能看出这俩不是同一个 /24，而不是笼统说一句「地址不一致」。
//
//   4. needsRebroadcast() —— 「什么时候该重启 HA」。第一版拿 `hasBad`
//      （体检里**任何一条** bad）当判据，而 bad 里包含「手机上的 HA App 没在连」——
//      重启 HA 治不好手机掉线，却每次都会掐断手机的 local push websocket，
//      于是变成**每 120 秒重启一次**的死循环（实测 HA 每 2m33s 重启一次），
//      日志还谎报成「检测到漂移：广播=192.168.31.99 本机=192.168.31.99」
//      —— 两边明明一模一样。重启只对「广播不对」有意义，判据必须收紧。
//      这个 bug 的危害在于：它把「手机连不上」放大成「永远连不上」。
//
//   node test/net-doctor.test.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  parseYamlInternalUrl,
  slash24,
  hostOf,
  isBareIp,
  needsRebroadcast,
} from '../scripts/net-doctor.mjs';

let pass = 0;
let fail = 0;
let skip = 0;
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

function skipCheck(name) {
  skip++;
  console.log(`  ○ ${name}（跳过：本机没有该文件）`);
}

// ── §1 hostOf：URL → 主机名 ───────────────────────────────────────────────
console.log('\n§1 hostOf —— 注意 URL 会把主机名小写化');

check('http://Your-Mac.local:8123 → 全小写',
  hostOf('http://Your-Mac.local:8123') === 'your-mac.local',
  `实际得到 ${hostOf('http://Your-Mac.local:8123')}`);
check('http://192.168.0.5:8123 → 原样返回 IP',
  hostOf('http://192.168.0.5:8123') === '192.168.0.5');
check('http://localhost:8123 → localhost',
  hostOf('http://localhost:8123') === 'localhost');
check('大小写不一致时忽略大小写也比得中',
  hostOf('http://Your-Mac.local:8123')
    === 'Your-Mac.local'.toLowerCase());
check('不是 URL → null（不抛异常）',
  hostOf('这不是一个 URL') === null);
check('空值 → null',
  hostOf(null) === null && hostOf('') === null);

// ── §2 isBareIp：裸 IP 判断 ───────────────────────────────────────────────
console.log('\n§2 isBareIp —— 区分「裸 IP」与「稳定名字」');

check('192.168.0.5 是裸 IP', isBareIp('192.168.0.5') === true);
check('Bonjour 名不是裸 IP', isBareIp('your-mac.local') === false);
check('IP 后面多一段不算', isBareIp('192.168.0.5.6') === false);
check('null / undefined 都不是', isBareIp(null) === false && isBareIp(undefined) === false);

// ── §3 slash24：网段前缀 ──────────────────────────────────────────────────
console.log('\n§3 slash24 —— 判断是否跨网段');

check('192.168.0.5 → 192.168.0.0/24', slash24('192.168.0.5') === '192.168.0.0/24');
check('192.168.31.99 → 192.168.31.0/24', slash24('192.168.31.99') === '192.168.31.0/24');
check('★ 旧网段 vs 新网段 判为不同（这正是「地址漂移」的核心症状）',
  slash24('192.168.31.99') !== slash24('192.168.0.5'));
check('同网段不同主机位判为相同',
  slash24('192.168.0.5') === slash24('192.168.0.99'));
check('10.0.0.1 → 10.0.0.0/24', slash24('10.0.0.1') === '10.0.0.0/24');
check('非 IP → null', slash24('abc') === null && slash24(null) === null);

// ── §4 parseYamlInternalUrl：从 HA 配置里取出 internal_url ────────────────
console.log('\n§4 parseYamlInternalUrl —— 只在 homeassistant: 块里找，别把注释当配置');

check('正常嵌套：取到值',
  parseYamlInternalUrl([
    'homeassistant:',
    '  name: Agent Approval',
    '  internal_url: "http://foo.local:8123"',
    'frontend:',
  ].join('\n')) === 'http://foo.local:8123');

check('去引号（单引号也一样）',
  parseYamlInternalUrl('homeassistant:\n  internal_url: \'http://a.local:8123\'\n')
    === 'http://a.local:8123');

check('★ 行首是 # 的注释不能被当成配置',
  parseYamlInternalUrl([
    'homeassistant:',
    '  # internal_url: http://注释里的示例不算:8123',
    '  name: X',
  ].join('\n')) === null);

check('★ 缩进在 homeassistant 之外的 internal_url 不算',
  parseYamlInternalUrl([
    'homeassistant:',
    '  name: X',
    '',
    'http:',
    '  internal_url: http://别处的:8123',
  ].join('\n')) === null);

check('值后面带行内注释 → 只取值',
  parseYamlInternalUrl('homeassistant:\n  internal_url: http://a.local:8123  # 说明\n')
    === 'http://a.local:8123');

check('没有 homeassistant: 块 → null',
  parseYamlInternalUrl('frontend:\n  internal_url: http://x.local:8123\n') === null);

check('homeassistant: 存在但没写 → null',
  parseYamlInternalUrl('homeassistant:\n  name: X\n') === null);

check('空文本 → null', parseYamlInternalUrl('') === null);

// ── §5 本机真实配置的回归保护 ─────────────────────────────────────────────
// 这一段是「治本方案（把 internal_url 钉成 Bonjour 名字）」的守门人：
// 一旦有人把 internal_url 改回裸 IP，或者干脆删掉，这里就会红。
console.log('\n§5 本机真实 configuration.yaml —— 守着「钉名字」这个决定');

const YAML_PATH = path.join(os.homedir(), '.homeassistant', 'configuration.yaml');
if (!fs.existsSync(YAML_PATH)) {
  skipCheck('本机 configuration.yaml 未写死 internal_url 的检查');
} else {
  const real = parseYamlInternalUrl(fs.readFileSync(YAML_PATH, 'utf8'));
  check('configuration.yaml 里确实写了 internal_url', !!real, `实际 ${JSON.stringify(real)}`);
  if (real) {
    const h = hostOf(real);
    check('★ 它不是一个裸 IP（裸 IP 换网即失效）', isBareIp(h) === false, `host=${h}`);
    let localName = null;
    try {
      localName = execFileSync('/usr/sbin/scutil', ['--get', 'LocalHostName'],
        { encoding: 'utf8', timeout: 5000 }).trim();
    } catch {}
    if (localName) {
      check('★ 它等于本机 Bonjour 名（IP 变了也能跟随）',
        h === `${localName}.local`.toLowerCase(),
        `host=${h}，期望 ${`${localName}.local`.toLowerCase()}`);
      check('端口是 8123', new URL(real).port === '8123');
    } else {
      skipCheck('与 Bonjour 名一致的检查');
    }
  }
}

// ── §6 needsRebroadcast：什么时候才该重启 HA ──────────────────────────────
// ★ 这一节是「每 120 秒重启 HA」那个死循环的守门人。
// 判据只看「广播」这一层；体检里的其它 bad（典型：手机 App 掉线）一律不许触发重启。
console.log('\n§6 needsRebroadcast —— 只有「广播不对」才该重启 HA');

const 报告 = (over = {}) => ({
  drifted: false,
  broadcastFound: true,
  findings: [],
  ...over,
});

check('★ 广播正常 + 手机离线（2026-09-20 真实现场）→ 不重启',
  needsRebroadcast(报告({
    findings: [{ level: 'bad', title: '★ 手机上的 HA App 没在连（推送必 500）' }],
  })) === false,
  '这正是那个每 120 秒重启一次 HA 的死循环');
check('★ 任何其它 bad 级发现都不足以触发重启（只看广播层）',
  needsRebroadcast(报告({
    findings: [{ level: 'bad', title: '★ 广播里的 internal_url 是过期 IP' }],
  })) === false);
check('广播地址是旧的（真漂移）→ 重启',
  needsRebroadcast(报告({ drifted: true })) === true);
check('压根没广播 → 重启（重启 HA 才会重新注册）',
  needsRebroadcast(报告({ broadcastFound: false })) === true);
check('无漂移且广播在 → 不重启',
  needsRebroadcast(报告()) === false);
check('报告缺失 → 不重启（宁可不动，不臆断）',
  needsRebroadcast(null) === false && needsRebroadcast(undefined) === false);
check('drifted 是假值时按「不漂移」处理（用 === true 而不是真值判断）',
  needsRebroadcast(报告({ drifted: 0 })) === false);

// ── 汇总 ──────────────────────────────────────────────────────────────────
console.log('');
if (fail === 0) {
  console.log(`\x1b[32m✅ net-doctor 纯函数测试全部通过（${pass} 项通过${skip ? `，${skip} 项跳过` : ''}）\x1b[0m`);
  process.exit(0);
} else {
  console.log(`\x1b[31m❌ ${fail} 项失败 / ${pass} 项通过\x1b[0m`);
  for (const f of failures) console.log(`   · ${f}`);
  process.exit(1);
}
