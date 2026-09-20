#!/usr/bin/env node
// `src/channels/device-readiness.mjs` 的纯函数测试。
//
// 存在的理由：这个模块回答一个**会被用来解释故障**的问题 ——
// 「这台手机现在到底能不能收到推送」。它一旦判错，后果不是报错难看，
// 而是把人引向错误的修复方向（比如让人去重装 HA App，而真因是实体被禁用了）。
//
// 所以这里测的全是**边界**，不是happy path：
//
//   1. `reporting: null` 必须真的可能出现。设备没注册（实体整个不在 /api/states
//      里出现）时，绝不能因为「一条存活传感器都没看见」就断言掉线 ——
//      那两种情况（没注册 vs 被禁用）在 HA 的公开 API 上**看起来一模一样**。
//
//   2. 只有**全部**存活传感器没值才判 false。四条里只要有一条报了真值
//      （哪怕是电量 1%），App 就是在线的；这时候判掉线会造成假警报。
//
//   3. 上下文传感器（ssid / bssid / connection_type）**不许**参与判定。
//      它们要 iOS 定位权限，被拒绝就常年 unavailable ——
//      拿它当判据会把「用户拒绝定位」误报成「手机掉线」。
//
//   4. 服务名一定要能剥干净。`notify.mobile_app_your_iphone` 里
//      既有 `notify` 域又有 `mobile_app_` 前缀，少剥一层就永远匹配不到实体。
//
//   node test/device-readiness.test.mjs

import {
  LIVENESS_SUFFIXES,
  CONTEXT_SUFFIXES,
  deviceSlugFromNotifyService,
  hasRealValue,
  assessDeviceReadiness,
  explainUnreachable,
} from '../src/channels/device-readiness.mjs';

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

// ── 造状态的小工具 ────────────────────────────────────────────────────────
const S = (entity_id, state) => ({ entity_id, state, attributes: {} });

/** 真实抓下来的现场：iPhone 注册过，但 App 没在连。 */
function realOfflineSnapshot() {
  return [
    S('binary_sensor.your_iphone_focus', 'off'),
    S('device_tracker.your_iphone', 'not_home'),
    S('sensor.your_iphone_app_version', 'unavailable'),
    S('sensor.your_iphone_battery_level', 'unavailable'),
    S('sensor.your_iphone_battery_state', 'unavailable'),
    S('sensor.your_iphone_last_update_trigger', 'unavailable'),
    S('sensor.your_iphone_connection_type', 'unavailable'),
    S('sensor.your_iphone_ssid', 'unavailable'),
    S('sensor.your_iphone_bssid', 'unavailable'),
    S('sensor.your_iphone_steps', 'unavailable'),
    S('sensor.some_other_device_app_version', '2026.9'),
  ];
}

// ── §1 deviceSlugFromNotifyService ────────────────────────────────────────
console.log('\n§1 deviceSlugFromNotifyService —— 把服务名剥成实体前缀');

check('mobile_app_your_iphone → your_iphone',
  deviceSlugFromNotifyService('mobile_app_your_iphone') === 'your_iphone');
check('notify.mobile_app_your_iphone → your_iphone（带域名也要剥掉）',
  deviceSlugFromNotifyService('notify.mobile_app_your_iphone') === 'your_iphone');
check('★ 少剥一层就会得到 notify_mobile_app_… 这种永远匹配不到的串',
  !deviceSlugFromNotifyService('notify.mobile_app_x').startsWith('notify'));
check('没写前缀也认：your_iphone → your_iphone',
  deviceSlugFromNotifyService('your_iphone') === 'your_iphone');
check('前后空格要清掉',
  deviceSlugFromNotifyService('  mobile_app_pixel_9  ') === 'pixel_9');
check('空值 → 空串（不抛）',
  deviceSlugFromNotifyService('') === '' && deviceSlugFromNotifyService(null) === '');
check('下划线设备名不会被过度剥离',
  deviceSlugFromNotifyService('mobile_app_your_iphone_2') === 'your_iphone_2');

// ── §2 hasRealValue ──────────────────────────────────────────────────────
console.log('\n§2 hasRealValue —— 什么算「有真实取值」');

check('"unavailable" 不算', hasRealValue('unavailable') === false);
check('"unknown" 不算', hasRealValue('unknown') === false);
check('空串不算', hasRealValue('') === false);
check('大小写混写也认出来：Unavailable 不算', hasRealValue('Unavailable') === false);
check('"0" 算（电量 0 也是一个真实读数）', hasRealValue('0') === true);
check('"2026.9.1" 算', hasRealValue('2026.9.1') === true);
check('"discharging" 算', hasRealValue('discharging') === true);
check('null / undefined 不算',
  hasRealValue(null) === false && hasRealValue(undefined) === false);

// ── §3 assessDeviceReadiness：判定本身 ────────────────────────────────────
console.log('\n§3 assessDeviceReadiness —— 判定「能不能收」');

const offline = assessDeviceReadiness(realOfflineSnapshot(), 'your_iphone');
check('★ 现场快照（四条存活传感器全 unavailable）→ reporting === false',
  offline.reporting === false, `实际 ${offline.reporting}`);
check('四条存活传感器都被认出来',
  offline.liveness.length === 4, `实际 ${offline.liveness.length} 条`);
check('判定理由里点名了「不需要 iOS 权限」（防止被误读成权限问题）',
  offline.reason.includes('权限'));
check('判定理由里点名了「App 没在连」',
  offline.reason.includes('App 没在连'));
check('传感器名只报字段尾（不带上设备前缀，避免 your_iphone_battery_level 这种啰嗦）',
  offline.liveness.every((x) => x.field && !x.field.includes('iphone'))
    && offline.reason.includes('battery_level'), offline.reason.slice(0, 120));

// 只要有一条报真值，就必须判在线
const oneAlive = realOfflineSnapshot().map((s) =>
  s.entity_id === 'sensor.your_iphone_battery_level' ? S(s.entity_id, '78') : s
);
check('★ 四条里只有一条报真值 → reporting === true（不许假警报）',
  assessDeviceReadiness(oneAlive, 'your_iphone').reporting === true);

const allAlive = [
  S('sensor.your_iphone_app_version', '2026.9.1'),
  S('sensor.your_iphone_battery_level', '78'),
  S('sensor.your_iphone_battery_state', 'charging'),
  S('sensor.your_iphone_last_update_trigger', 'signaled'),
];
const healthy = assessDeviceReadiness(allAlive, 'your_iphone');
check('全在线 → reporting === true',
  healthy.reporting === true);
check('判定理由里带上了读数，便于人肉核对',
  healthy.reason.includes('battery_level=78'));

// ★ 最关键的一条：判不了就必须说判不了
const noEntities = assessDeviceReadiness([S('sensor.other_app_version', '1.0')], 'your_iphone');
check('★ 实体完全不存在 → reporting === null（不许断言掉线）',
  noEntities.reporting === null, `实际 ${noEntities.reporting}`);
check('★ 实体不存在时，reason 明确说「判不了 / 不据此拦人」',
  noEntities.reason.includes('判不了'));

// 只有上下文传感器（存活传感器被用户禁用了）
const onlyContext = [
  S('sensor.your_iphone_connection_type', 'Wi-Fi'),
  S('sensor.your_iphone_ssid', 'HomeNet'),
];
const ctxOnly = assessDeviceReadiness(onlyContext, 'your_iphone');
check('★ 只剩上下文传感器（存活那几个被禁用）→ 仍然是 null，不判掉线',
  ctxOnly.reporting === null, `实际 ${ctxOnly.reporting}`);
check('这种情况的 reason 提到了「可能被禁用」',
  ctxOnly.reason.includes('禁用'));

// 上下文传感器不许影响判定
const offlineButContextAlive = realOfflineSnapshot().map((s) =>
  s.entity_id === 'sensor.your_iphone_ssid' ? S(s.entity_id, 'HomeNet') : s
);
check('★ ssid 有值、但存活传感器全没值 → 仍然判 false（ssid 需要定位权限，不作数）',
  assessDeviceReadiness(offlineButContextAlive, 'your_iphone').reporting === false);

// 上下文仍然被收集起来，供展示
check('上下文传感器会被单独收集（ssid / bssid / connection_type）',
  offline.context.length === 3, `实际 ${offline.context.length} 条`);

// 健壮性
check('states 不是数组 → null（不抛异常）',
  assessDeviceReadiness(null, 'your_iphone').reporting === null);
check('传进来的条目是 null 也不会崩',
  assessDeviceReadiness([null, undefined, S('sensor.your_iphone_battery_level', '3')], 'your_iphone')
    .reporting === true);
check('不会把别的设备的实体的算进来',
  assessDeviceReadiness(realOfflineSnapshot(), 'your_iphone').liveness
    .every((x) => x.entity_id.includes('your_iphone')));
check('恒不走 LIVENESS / CONTEXT 两个列表之外的实体',
  assessDeviceReadiness(realOfflineSnapshot(), 'your_iphone').entitiesSeen
    === offline.liveness.length + offline.context.length);
check('LIVENESS_SUFFIXES 里没有需要定位权限的项',
  LIVENESS_SUFFIXES.every((s) => !CONTEXT_SUFFIXES.includes(s)));

// 这行消息会原样出现在终端和腕上报错里，是纯文本 ——
// 混进 markdown 的 `**` 只会显示成两个星号，像乱码。
check('★ 三种判定结果的 reason 都不许出现 markdown 的 **',
  [offline, healthy, noEntities, ctxOnly].every((v) => !v.reason.includes('**')));

// ── §4 explainUnreachable：错误消息要能指路 ───────────────────────────────
console.log('\n§4 explainUnreachable —— 诊断消息必须给下一步');

const msg = explainUnreachable(offline, {
  device: 'iPhone',
  baseUrl: 'http://localhost:8123',
});

check('★ 消息里给出「同一网段」这一步（mDNS 不跨网段）',
  msg.includes('同一个网段'));
check('★ 消息里给出「打开 App 重连」这一步',
  msg.includes('Home Assistant App'));
check('★ 消息里给出「跑 approval net 自检」这一步',
  msg.includes('approval net'));
check('消息里带上网关访问 HA 的地址，便于核对是不是打错了地方',
  msg.includes('http://localhost:8123'));

// 上下文只有**有真实取值**时才展示 —— 掉线时它们同样是 unavailable，
// 那种情况下硬塞一行「ssid=unavailable」只是噪音。
check('掉线（上下文也没值）时不出现空的「上下文」行',
  !msg.includes('手机上报的上下文'));

// 但手机在线、只是别的环节坏了时，上下文必须带出来（这是排查的关键线索）
const msgWithCtx = explainUnreachable(
  assessDeviceReadiness(offlineButContextAlive, 'your_iphone'),
  { device: 'iPhone', baseUrl: 'http://localhost:8123' }
);
check('★ 上下文有值时，把 ssid 带出来（用于判「手机是不是换了 Wi-Fi」）',
  msgWithCtx.includes('ssid=HomeNet'), JSON.stringify(msgWithCtx.slice(0, 200)));

const msgHealthyCtx = explainUnreachable(
  assessDeviceReadiness(
    [...allAlive, S('sensor.your_iphone_connection_type', 'Wi-Fi'),
     S('sensor.your_iphone_bssid', 'aa:bb:cc:dd:ee:ff')],
    'your_iphone'
  ),
  { device: 'iPhone', baseUrl: 'http://localhost:8123' }
);
check('在线时也带上 connection_type / bssid，便于比对是否同一个 AP',
  msgHealthyCtx.includes('connection_type=Wi-Fi') && msgHealthyCtx.includes('bssid=aa:bb:cc:dd:ee:ff'));

const msgUnknown = explainUnreachable(noEntities, { device: 'iPhone', baseUrl: 'http://localhost:8123' });
check('★ 判不了时，不许把「手机掉线」当成结论',
  !msgUnknown.includes('把 iPhone 连回'));
check('判不了时，改给「服务名写错 / 地址漂移」两条真实的候选',
  msgUnknown.includes('notifyService') && msgUnknown.includes('approval net'));

// 三个分支都要干净 —— 只测掉线那一条会漏掉另一条（真的漏过一次：
// explainUnreachable 的「判不了」分支里留着 `**不是**`，终端里显示成两个星号）。
check('★ explainUnreachable 三个分支的纯文本里都不许出现 markdown 的 **',
  [msg, msgUnknown, explainUnreachable(healthy, { device: 'iPhone' })]
    .every((m) => !m.includes('**')));

// ── 汇总 ──────────────────────────────────────────────────────────────────
console.log('');
if (fail === 0) {
  console.log(`\x1b[32m✅ device-readiness 纯函数测试全部通过（${pass} 项通过）\x1b[0m`);
  process.exit(0);
} else {
  console.log(`\x1b[31m❌ ${fail} 项失败 / ${pass} 项通过\x1b[0m`);
  for (const f of failures) console.log(`   · ${f}`);
  process.exit(1);
}
