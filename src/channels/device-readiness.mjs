// 「这台手机现在到底能不能收到推送」—— 判定逻辑。
//
// 为什么需要这个文件
// ------------------
// 硬事实 13 说「`pushOk: true` 只代表 HA 收下了调用，不代表送达」。
// 同一类谎言还有第二个面孔：**网关自报 `channelReady: true`**。
// `channelReady` 原本取的是 `authed` —— 即「网关↔HA 的 WebSocket 握手成功」。
// 那是**传输层**的健康度，跟「手机能不能收」完全是两件事。
//
// 实测踩到：HA 一切正常、幂等通道握手成功、`channelReady: true`，
// 但 iPhone 上的 HA App 早就掉线了 —— 每次 `notify.mobile_app_*` 都 500
// （`KeyError: 'push_token'`）。于是钩子按 deny 处理，用户看到的是
// 「推送到手表失败（HA 服务 … 返回 500）」这种既不解释原因、也不给下一步的消息。
//
// 怎么在 HA 的公开 API 上判定「手机掉线」
// --------------------------------------
// HA 没有暴露「推送通道是否已注册」的接口（读过 `components/mobile_app/`：
// `push_websocket_channel` 只存在于 config entry 的 data 里，既没有 WS 命令
// 也没有 REST 端点）。所以只能从**可观测的副作用**反推：
//
//   App 连着 HA 时会持续上报一组**默认启用、且不需要任何 iOS 权限**的传感器：
//     sensor.<dev>_app_version          版本号，只要 App 活着就会报
//     sensor.<dev>_battery_level        电量，同上
//     sensor.<dev>_battery_state        充电状态，同上
//     sensor.<dev>_last_update_trigger  最后一次上报的触发源，同上
//
//   这四条只要**有一条**有真实取值，就说明 App 正在上报 ⇒ 通道健在。
//   四条**全部** `unavailable` ⇒ App 没在连 ⇒ 推送必 500。
//
// ⚠️ 两个必须守住的边界：
//
// 1. **只有「实体存在但没值」才敢下结论。** 被用户禁用（disabled_by）的实体会
//    从 `/api/states` 里整个消失。如果这四条一个都没出现，我们**无法区分**
//    「用户把它们禁用了」和「设备压根没注册」—— 所以那种情况返回 `reporting: null`
//    （未知），**不下任何判断**。宁可说不知道，也不要给一个错的方向。
//
// 2. **不在这个文件里读 ssid / bssid / connection_type 当判据。**
//    那三条需要 iOS 的定位权限，用户拒绝就会常年 unavailable ——
//    拿它判「掉线」会误报。它们只作为**附加上下文**展示。
//
// 这个文件是纯函数：喂一个 `/api/states` 的数组进来，出一个判定。
// 所以测试不需要起 HA（见 test/device-readiness.test.mjs）。

/** 判定「App 在不在线」的传感器后缀：默认启用、不需要 iOS 权限。 */
export const LIVENESS_SUFFIXES = [
  'app_version',
  'battery_level',
  'battery_state',
  'last_update_trigger',
];

/** 只作为附加上下文展示的传感器后缀（需要定位权限，不能当判据）。 */
export const CONTEXT_SUFFIXES = ['connection_type', 'ssid', 'bssid'];

/** HA 里表示「没有值」的状态串。 */
const NONE_STATES = new Set(['unavailable', 'unknown', 'none', '', 'null']);

/**
 * 从 notify 服务名推出实体的前缀。
 *
 *   mobile_app_your_iphone  →  your_iphone
 *   your_iphone             →  your_iphone（容忍没写前缀）
 *
 * 注意 `mobile_app_` 前面的 notify 域要连着斜杠一起剥掉，
 * 否则会得到 `notify_mobile_app_...` 这种永远匹配不到的串。
 */
export function deviceSlugFromNotifyService(notifyService) {
  let s = String(notifyService || '').trim();
  if (!s) return '';
  // 容忍把域名一起写进来：notify.mobile_app_x / notify/mobile_app_x
  s = s.replace(/^notify[./]/, '');
  s = s.replace(/^mobile_app_/, '');
  return s;
}

/** 状态算不算「有真实取值」。 */
export function hasRealValue(state) {
  return !NONE_STATES.has(String(state ?? '').trim().toLowerCase());
}

/**
 * 判定一台设备现在能不能收推送。
 *
 * @param {Array<{entity_id:string,state:string}>} states  `/api/states` 的原始数组
 * @param {string} slug  设备实体前缀，见 deviceSlugFromNotifyService
 * @returns {{
 *   slug: string,
 *   entitiesSeen: number,
 *   liveness: Array<{entity_id:string,state:string,real:boolean}>,
 *   context: Array<{entity_id:string,state:string}>,
 *   reporting: boolean|null,
 *   reason: string
 * }}
 *   `reporting`：
 *     true  —— 至少一条存活传感器有真实取值，App 正在上报
 *     false —— 存活传感器都存在，但全部没有取值，App 没在连（推送必失败）
 *     null  —— 判不了（设备没注册 / 实体被禁用 / 名字对不上），不要据此拦人
 */
export function assessDeviceReadiness(states, slug) {
  const list = Array.isArray(states) ? states : [];
  const want = deviceSlugFromNotifyService(slug) || String(slug || '');
  const prefix = `sensor.${want}_`;

  const liveness = [];
  const context = [];

  for (const s of list) {
    const id = String(s && s.entity_id ? s.entity_id : '');
    if (!id.startsWith(prefix)) continue;
    const tail = id.slice(prefix.length);
    const state = String(s.state ?? '');
    if (LIVENESS_SUFFIXES.includes(tail)) {
      liveness.push({ entity_id: id, field: tail, state, real: hasRealValue(state) });
    } else if (CONTEXT_SUFFIXES.includes(tail)) {
      context.push({ entity_id: id, field: tail, state });
    }
  }

  const entitiesSeen = liveness.length + context.length;

  if (liveness.length === 0) {
    return {
      slug: want,
      entitiesSeen,
      liveness,
      context,
      reporting: null,
      reason:
        entitiesSeen === 0
          ? `在 HA 里找不到任何 sensor.${want}_* 实体 —— 这台设备可能从没注册过，` +
            `或者被整个禁用了。判不了「能不能收」，不据此拦人。`
          : `只找到上下文传感器、没找到存活传感器（${LIVENESS_SUFFIXES.join(' / ')}）` +
            `—— 它们可能被禁用了。判不了「能不能收」，不据此拦人。`,
    };
  }

  const alive = liveness.filter((x) => x.real);
  if (alive.length > 0) {
    return {
      slug: want,
      entitiesSeen,
      liveness,
      context,
      reporting: true,
      reason:
        `App 正在上报（${alive.map((x) => `${x.field}=${x.state}`).join('、')}）` +
        `—— 推送通道健在。`,
    };
  }

  return {
    slug: want,
    entitiesSeen,
    liveness,
    context,
    reporting: false,
    // ⚠️ 这条消息会原样出现在终端 / 腕上确认卡片的报错里，是**纯文本**。
    // 所以不要写 markdown 的 `**`（终端里只会看到两个星号，像乱码一样）。
    // 强调用「全部」这种词就够了。
    reason:
      `App 没在连：${liveness.length} 条存活传感器（${liveness
        .map((x) => x.field)
        .join(' / ')}）全部是「没有值」。` +
      `这四条都默认启用、且不需要任何 iOS 权限，所以这不是权限问题 —— ` +
      `是 iPhone 上的 HA App 现在连不上 HA。`,
  };
}

/**
 * 把判定结果翻译成一条**可执行**的说明。
 *
 * 原则：诊断消息的价值不在于「报了什么错」，而在于「看完知道下一步做什么」。
 * 所以每一句都必须是「去手机上做某件事」这种动作。
 */
export function explainUnreachable(verdict, ctx = {}) {
  const device = ctx.device || verdict.slug || '那台设备';
  const baseUrl = ctx.baseUrl || '';
  const lines = [];

  lines.push(`【诊断】${verdict.reason}`);

  if (verdict.reporting === false) {
    lines.push('');
    lines.push('  要让推送恢复，按顺序做（前两步必须都满足）：');
    lines.push(
      '  1. 把 iPhone 连回与 Mac 同一个网段的网络 ——' +
        'mDNS 不跨网段，不同网段下 App 永远发现不了这台 HA。'
    );
    lines.push(
      `  2. 打开 iPhone 上的 Home Assistant App，确认它指向 ` +
        `http://<LocalHostName>.local:8123（钉 Bonjour 名字，不要钉 IP）；` +
        `连上后它才会把推送通道注册到 HA。`
    );
    lines.push(
      '  3. 自检：跑 `approval net`，看「本机出口地址」和手机是不是同一个网段；' +
        '再跑 `approval test --with-push` 真发一条。'
    );
  } else if (verdict.reporting === null) {
    lines.push('');
    lines.push('  这一次推送失败不是「手机掉线」这一类原因（那一条判不了）。');
    lines.push('  往下查顺序：');
    lines.push('  · 服务名写错了吗 → config.json 的 channels.ha.notifyService 要和 HA 里一致');
    lines.push('  · 地址漂移了吗   → `approval net`（比对广播地址 vs 本机当前地址）');
  }

  const ctxBits = (verdict.context || [])
    .filter((x) => hasRealValue(x.state))
    .map((x) => `${x.field || x.entity_id}=${x.state}`);
  if (ctxBits.length) {
    lines.push('');
    lines.push(`  手机上报的上下文：${ctxBits.join('、')}`);
  }
  if (baseUrl) {
    lines.push(`  网关访问 HA 的地址：${baseUrl}`);
  }

  return lines.join('\n');
}
