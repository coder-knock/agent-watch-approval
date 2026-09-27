// Home Assistant 通道。
//
// 两个关键设计：
// 1. 回程完全不需要公网入口。网关用 WebSocket 主动连到 HA，订阅
//    mobile_app_notification_action 事件；用户按下的按钮以事件形式回到网关。
//    因此 Mac 不需要端口映射 / 内网穿透 / 公网回调地址 —— 这是 HA 通道相对
//    Pushcut 通道最大的结构性优势，也省掉了「把令牌放进 URL」的全部风险。
// 2. 通知按钮的 action 标识就是那个一次性能力令牌（APR:...），
//    网关用 HMAC 验签后才认。别人伪造一条 HA 事件也批不动。

const TS_ORDER = { L0: 0, L1: 1, L2: 2, L3: 3 };

import {
  deviceSlugFromNotifyService,
  assessDeviceReadiness,
  explainUnreachable,
  diagnoseHaUnreachable,
} from './device-readiness.mjs';

// ── iOS / watchOS 通知按钮的可发现性 ─────────────────────────────────────────
//
// **两个平台都不把动作按钮画在通知正面**，都得先「展开」，只是手势不一样：
//
//   · iPhone —— 锁屏上「右→左滑 → 点『查看』」，或**长按**；
//               不在锁屏时把通知**下拉**。
//     官方原话：All devices support notification expanding by performing a
//     right to left swipe and pressing 'View' in the lock screen or pressing
//     and holding. If you're not in the lock screen, you can also pull the
//     notification down to expand it.
//
//   · Apple Watch —— **旋转数码表冠向下滚到长视图底部**，按钮在底部。
//     官方原话：「旋转数码表冠以滚动到通知底部，然后轻点底部的一个按钮」；
//     Apple Developer 对长视图的分层描述也是「**底部**包含『关闭』按钮和
//     所有已注册的操作按钮」。
//
// ⚠️ 这里原先写着「Apple Watch 是**直接显示**按钮的」——**那是错的**。
// 2026-09-20 真机推翻：在手表上点通知卡片，得到的是「打开了 HA App」，
// 不是按钮列表 —— 因为按钮在长视图底部，没滚到那儿就是看不见。
// 「手表直接显示」这个臆测还派生出一条更糟的推论「手表好用不代表手机好用」，
// 一并作废：**两边一样难发现，只是手势不同**。
//
// ⚠️ 真正危险的还不是「找不到按钮」，而是**用户以为自己点过了**：
// 点「通知主体」（而不是按钮）时，Apple 触发的是 UNNotificationDefaultActionIdentifier
// ——系统关掉通知、**直接启动 App**，不经过任何 action。网关侧什么都没收到，
// fail-closed 于是拦下。在用户眼里就成了「我明明同意了，它却说没同意」。
//
// 两个平台都不给任何视觉线索（可操作通知和普通通知长得一模一样），
// 所以**把提示写进正文**是唯一能让用户自己发现的途径（Apple 没有别的钩子可挂）。
// ⚠️ 提示必须同时覆盖手机和手表：同一条正文两边都会显示，而两边手势不同。
export function expandHint(options) {
  const opts = Array.isArray(options) ? options : [];
  if (!opts.length) return '';
  return `\n按钮在卡片底部：手机长按展开，手表转表冠滚到底 → 「${opts.map((o) => o.label).join(' / ')}」`;
}

// ── 「点了通知，却没有产生决策」──────────────────────────────────────────────
//
// 通知上点下去**不一定**是按钮。Apple 的长视图有三种落点，只有第一种才是决策：
//
//   · 操作按钮          → 报**所选操作**的标识符        ← 只有这个能推进决策
//   · 「忽略」按钮      → `UNNotificationDismissActionIdentifier`
//   · 卡片的**其他地方** → `UNNotificationDefaultActionIdentifier`
//
// 第三种是**最危险的误判源**：系统关掉通知、**直接启动 App**，用户主观上
// 「我点过这张卡片了」，但实际没有任何 action 产生 → 网关什么都没收到 →
// fail-closed 拦下 → 用户看到的是「我明明同意了，它却说没同意」。
//
// 更糟的是这两个字面量是**普通字符串**，HA 原样塞进 event 的 `action` 字段，
// 于是落进 gateway 的 `!startsWith('APR:')` 分支被**静默忽略** ——
// 一条 `{ ok: true, ignored }` 扔掉，日志里一个字都没有。
// 这正是本项目修过两次的同一个模式（参见 `fetch failed` 那次）：
// **错误被压成一个没有信息量的成功返回**。所以这里把落点翻译成人话，
// 在忽略之前先说出来。
//
// 识别不了也不算错：那是别的 App / 别的自动化发的动作，如实说明即可。
const DEFAULT_ACTION = 'com.apple.UNNotificationDefaultActionIdentifier';
const DISMISS_ACTION = 'com.apple.UNNotificationDismissActionIdentifier';

export function describeForeignAction(action) {
  const a = String(action == null ? '' : action);
  if (a === DEFAULT_ACTION) {
    // ⚠️ 这里**不要**写 Markdown 的 `**粗体**` —— 这段文字是直接进 console 的，
    // 星号会原样打出来。同一条文案若还要给文档用，另写一份短的。
    return '这是「点了通知主体」（不是按钮）触发的默认动作：系统据此打开了 App，'
      + '没有产生任何决策。要决策，请展开卡片后点按钮 —— '
      + '手机长按展开，手表转数码表冠滚到卡片底部。';
  }
  if (a === DISMISS_ACTION) {
    return '这是「忽略 / 划掉通知」触发的动作：通知被关闭了，没有产生任何决策。';
  }
  return '不是本网关签发的一次性令牌，也不是已知的 iOS 通知落点 —— '
    + '可能是别的 App 或自动化发的，与本网关无关。';
}

// SF Symbols 图标（需 iOS App ≥ 2021.10）。只在按钮展开后可见，
// 作用是在三个按钮里一眼分清哪个是允许、哪个是拒绝。
const ACTION_ICON = {
  allow: 'sfsymbols:checkmark.circle.fill',
  deny: 'sfsymbols:xmark.circle.fill',
  defer: 'sfsymbols:info.circle',
};

function wsUrlFrom(baseUrl) {
  const u = new URL(baseUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/api/websocket';
  u.search = '';
  return u.toString();
}

export function create(cfg, deps) {
  const baseUrl = String(cfg.baseUrl || 'http://localhost:8123').replace(/\/+$/, '');
  const token = cfg.token || '';
  const notifyService = cfg.notifyService || 'mobile_app_iphone';
  const tsFrom = cfg.timeSensitiveFromTier || 'L2';
  const criticalFrom = cfg.criticalFromTier || null;
  const clearAfter = cfg.clearAfterDecision !== false;
  // 「点一下通知就能操作」的手机可达地址（可选，如 http://192.168.1.5:7788）。
  //
  // 存在的理由：iOS **不会**在通知上直接显示按钮，必须展开
  //（锁屏右→左滑点 View、或长按；非锁屏下拉）才看得见，而 Apple 不给任何
  // 视觉线索。但「点通知主体」不需要展开 —— 只要通知带了 `url`，点一下
  // 就能打开网页。于是手机上多出一条更短的路径：
  //   点通知 → 打开审批页（那条自动置顶高亮）→ 在页面上点按钮
  //
  // 留空则**不设** url。默认 host 是 127.0.0.1，手机根本访问不到，
  // 硬写进 url 只会制造一条「点了没反应」的死链 —— 比没有更糟。
  // 启用前提：把 config 的 host 改成局域网地址（如 0.0.0.0 或本机 LAN IP）。
  const publicBaseUrl = String(cfg.publicBaseUrl || '').replace(/\/+$/, '');
  // 页面口令。配了之后，不带 `?k=` 的请求打不开审批页。
  // 为什么挡页面就够：每个 actionId 里都带着一次性 nonce + HMAC 签名，
  // 它本身就是「能决策」的凭证，而 phone.html 是拿到 actionId 的唯一途径。
  // 打不开页面 = 无从伪造决策，所以没必要再在 /v1/decision 上加一层校验。
  const phoneAccessKey = String(cfg.phoneAccessKey || '');

  let ws = null;
  let msgId = 0;
  let backoff = 1000;
  let stopped = false;
  let authed = false;

  // ⚠️ REST 调用服务的路径是 /api/services/<域>/<服务>，用**斜杠**分隔。
  // 写成 /api/services/notify.mobile_app_x（点号）会得到 404 Not Found ——
  // 点号是 YAML / 自动化里的写法，不是 REST 路径的写法。
  // （这个坑踩过两次：scripts/verify-ha.mjs 一次，这里的 push/clear 一次。）
  async function callService(domain, service, body) {
    const res = await fetch(`${baseUrl}/api/services/${domain}/${service}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HA 服务 ${domain}.${service} 返回 ${res.status}: ${text.slice(0, 300)}`);
    }
    return text;
  }

  const callNotify = (body) => callService('notify', notifyService, body);

  function send(obj) {
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify(obj));
  }

  function connect() {
    if (stopped) return;
    let ws_;
    try {
      ws_ = new WebSocket(wsUrlFrom(baseUrl));
    } catch (e) {
      console.error('[ha] WebSocket 建立失败：', e.message);
      return scheduleReconnect();
    }
    ws = ws_;

    ws.addEventListener('open', () => {
      backoff = 1000;
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }

      if (msg.type === 'auth_required') {
        send({ type: 'auth', access_token: token });
        return;
      }
      if (msg.type === 'auth_invalid') {
        console.error('[ha] 鉴权失败，请检查长期访问令牌。HA 原话：', msg.message);
        return;
      }
      if (msg.type === 'auth_ok') {
        authed = true;
        console.log('[ha] 已连接 Home Assistant，订阅移动端通知动作事件');
        // ⚠️ 只订阅这一个事件，别顺手把 ios.notification_action_fired 也加进来：
        // iOS App 按一次按钮会**同时**发两个事件（见下面 event 分支的注释），
        // 订阅两个就会一次点击收到两条；第二条必撞上一次性令牌的重放保护，
        // 在日志里留下一条没意义的 rejected / nonce_replayed。
        send({ id: ++msgId, type: 'subscribe_events', event_type: 'mobile_app_notification_action' });
        return;
      }
      if (msg.type === 'event') {
        const d = (msg.event && msg.event.data) || {};
        // actionName 是「旧事件」的字段名，留着是为了兼容。
        const action = d.action || d.actionName;
        if (action) {
          const out = deps.onDecision(action, {
            source: 'ha',
            // ⚠️ 这里**刻意不读** sourceDeviceName / triggerSource —— 这个事件上根本没有这两个字段。
            //
            // iOS App 按下通知按钮时（HAAPI.handlePushAction）会同时发两个事件：
            //   ios.notification_action_fired
            //     { sourceDevicePermanentID, sourceDeviceName, sourceDeviceID,
            //       actionName, categoryName?, action_data? }
            //   mobile_app_notification_action
            //     { action, action_data?, reply_text? }        ← 只有这三个可能键，我们订阅的是它
            // 第二条来自 mobileAppNotificationActionEvent()，函数体第一行是
            // `var eventData = [String: Any]()`，不含任何设备信息。
            //
            // 而且**就算改订阅旧事件也分不出手机 / 手表**：
            // sourceDeviceName 取的是 HA 里那台设备的注册名（本机是
            // mobile_app_your_iphone）。手表上点的时候
            // （WatchPushActionSender.send → 手机可达就转发给手机发、不可达才自己发），
            // 两种情况发出来的都是同一份 server 配置 → 报的永远是手机的名。
            // 「这次点的是手机还是手表」在 HA 侧是一个信息缺口，如实留空。
            //
            // 安全上不依赖这个字段：认的是 action 里那个一次性令牌 + HMAC 验签。
            deviceName: null,
          });
          // ⚠️ 这个返回值**以前是丢掉的** —— 而它恰好是「用户点了通知、
          // 却什么都没发生」的唯一线索：gateway 对非 `APR:` 的 action 返回
          // `{ ok: true, ignored: '非本网关的 action' }`，一条成功返回扔掉，
          // 日志里一个字都没有。见 describeForeignAction 的注释。
          //
          // 只处理 `ignored` 这一种：真正的拒绝（签名不符 / 令牌重放）store
          // 已经连原因一起记进审计日志了，这里再说一遍只会把日志弄乱。
          if (out && out.ignored) {
            console.log(
              `[ha] 收到一个不产生决策的动作，已忽略：${action}\n`
              + `     ↳ ${describeForeignAction(action)}`
            );
          }
        }
        return;
      }
      if (msg.type === 'result' && msg.success === false) {
        console.error('[ha] 订阅失败：', msg.error && msg.error.message);
      }
    });

    ws.addEventListener('close', () => {
      authed = false;
      if (!stopped) scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // 详细原因由 close / message 分支给出，这里避免刷屏
    });
  }

  function scheduleReconnect() {
    if (stopped) return;
    const wait = backoff;
    backoff = Math.min(backoff * 2, 30000);
    setTimeout(connect, wait);
  }

  // ── 设备可收性探测 ──────────────────────────────────────────────────────
  //
  // `authed`（= 上面那个 `connected`）只说明**网关↔HA 的 WebSocket 握手成功**，
  // 那是传输层。它跟「手机能不能收到」是两件事 —— 实测遇到过：
  // HA 完全正常、握手成功，但 iPhone 上的 HA App 早就掉线，于是每次 notify 都
  // 500（KeyError: 'push_token'），而自检还在报 channelReady: true。
  // 这个自相矛盾的自检结果会把排查方向整个带偏。
  //
  // 所以单独探测一次「目标设备在不在线」。判定原理与边界见
  // src/channels/device-readiness.mjs 的头部注释（一句话：App 在线时会持续上报
  // 四条默认启用、不需要任何 iOS 权限的传感器；四条全没值就是掉线）。
  //
  // 缓存 45 秒：/healthz 每次都要问它，而它是一次 /api/states 往返。
  const READINESS_TTL_MS = 45_000;
  let readinessCache = { at: 0, value: null };

  async function probeReadiness(force = false) {
    const now = Date.now();
    if (!force && readinessCache.value && now - readinessCache.at < READINESS_TTL_MS) {
      return readinessCache.value;
    }

    const slug = deviceSlugFromNotifyService(notifyService);
    let value;
    try {
      const res = await fetch(`${baseUrl}/api/states`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        value = {
          slug, liveness: [], context: [], entitiesSeen: 0, reporting: null,
          reason: `读 /api/states 失败（HTTP ${res.status}），判不了设备状态。`,
        };
      } else {
        value = assessDeviceReadiness(await res.json(), slug);
      }
    } catch (e) {
      // 别只写 `e.message`：undici 把所有底层错误都压成「fetch failed」，
      // 真因在 `e.cause` 里。这里换成一个会主动探测「HA 在哪个协议上」的诊断，
      // 把「协议不匹配 / 自签证书不受信 / 端口没人听」分清楚。
      value = {
        slug, liveness: [], context: [], entitiesSeen: 0, reporting: null,
        reason: await diagnoseHaUnreachable(baseUrl, e),
      };
    }

    readinessCache = { at: now, value };
    return value;
  }

  return {
    name: 'ha',

    async start() {
      if (!token || token.startsWith('PASTE_')) {
        console.warn('[ha] 尚未配置长期访问令牌，推送与回程都不可用。请先按 SETUP 步骤获取令牌。');
        return;
      }
      connect();
    },

    async stop() {
      stopped = true;
      try { ws && ws.close(); } catch { /* ignore */ }
    },

    get connected() {
      return authed;
    },

    /**
     * 「目标设备现在真的能收到吗」。
     *
     * ⚠️ 和上面的 `connected` **不是一回事**，别混：
     *   connected  传输层 —— 网关↔HA 的 WebSocket 握手成功
     *   readiness  设备层 —— 那台手机/手表在不在 HA 上
     *
     * 两者可以同时为「一真一假」，而且实测就是这么翻车的。
     * 返回 `{ reporting: true|false|null, reason, ... }`，`null` 表示判不了
     * （设备没注册 / 实体被禁用）。`null` 时**不要**当成掉线处理。
     */
    async readiness() {
      return probeReadiness(false);
    },

    async push(record) {
      // ★ 推之前先确认目标设备真的在连 —— 否则这一推必然是白等。
      //
      // 这是「总是卡死两分钟」的真根因。HA 的本地推送在**手机没注册推送通道**时
      // **照样回 200**（它只是把消息交给了推送服务，不保证送达），于是：
      //   手机掉线 → callNotify 回 200 → 我们记 pushOk: true
      //   → 上层认为「卡片在路上」，老老实实等满 TTL
      //   → 最后一句「120s 内未收到确认，按默认拒绝」。
      // 用户体感就是「总是卡死」，而且毫无线索可查。
      //
      // 缓存说掉线时**必须再强制探一次**：READINESS_TTL_MS 是 45 秒，
      // 手机刚连回来时缓存可能还是旧的 false —— 拿旧结论去拒绝就是误拦。
      // 强制探测是一次 /api/states 往返（约几十毫秒），只在「疑似掉线」时发生。
      const cachedReadiness = await probeReadiness(false).catch(() => null);
      if (cachedReadiness && cachedReadiness.reporting === false) {
        const fresh = await probeReadiness(true).catch(() => null);
        if (fresh && fresh.reporting === false) {
          return {
            ok: false,
            deviceOffline: true,
            detail: explainUnreachable(fresh, { device: notifyService, baseUrl }),
          };
        }
      }

      const ts = TS_ORDER[record.tier] >= TS_ORDER[tsFrom];
      const critical = criticalFrom && TS_ORDER[record.tier] >= TS_ORDER[criticalFrom];

      const actions = record.options.map((o) => {
        const a = {
          action: o.actionId,
          title: o.label,
        };
        if (o.destructive) a.destructive = true;
        if (record.tier === 'L3' || o.requireUnlock) a.authenticationRequired = true;
        if (o.behavior) a.behavior = o.behavior;
        const icon = ACTION_ICON[o.verdict];
        if (icon) a.icon = icon;
        return a;
      });

      const push = {};
      if (critical) {
        push['interruption-level'] = 'critical';
      } else if (ts) {
        push['interruption-level'] = 'time-sensitive';
      }
      // 声音和打断级别共用**同一个** criticalFromTier 开关。
      // 这里原先写的是 `record.tier === 'L3'` —— 那意味着即使把 criticalFromTier 设成 null
      // （= 明确表示「不要用 critical」），L3 照样会发 critical 提醒音。
      // critical 音会绕过静音开关与专注模式，属于「吵醒你」的能力，
      // 关不掉就是在配置里撒谎。所以改成跟着同一个开关走。
      //
      // 注意：watchOS 上 iOS 永远用默认声音（LocalPushEvent.swift 里 `#if os(watchOS)
      // return defaultSound`），所以这一项只影响手机端。
      // 另：iOS 端构造 .criticalSoundNamed 时**没有**权限检查，
      // 能不能真的响取决于 iPhone 有没有给 HA 授予「关键警报」权限。
      push.sound = critical
        ? { name: 'default', critical: 1, volume: 1 }
        : { name: 'default' };

      const body = {
        message: record.body + expandHint(record.options),
        // 补推时标出次数。iOS 上通知可以被划走（没有「不可划走」的通知），
        // 网关会在 pending 期间自动补推 —— 这个后缀让用户知道
        // 「刚才划掉的那张又回来了」，而不是以为来了个新请求。
        // 仍用同一个 tag（`apr_<id>`），所以是**替换**而不是堆叠。
        title: record.renotify
          ? `${record.title}（第 ${record.renotify} 次提醒）`
          : record.title,
        data: {
          tag: `apr_${record.id}`,
          group: 'agent-approval',
          push,
          actions,
        },
      };

      // 「点通知主体」这条通道 —— iOS 上它**不需要展开**，正好补上
      // 「按钮藏在展开层里、而 Apple 不给提示」的那个缺口。
      // phone.html 认识 ?focus=<id>，会把这一条置顶高亮，点进来不用在列表里找。
      if (publicBaseUrl) {
        const q = new URLSearchParams({ focus: record.id });
        if (phoneAccessKey) q.set('k', phoneAccessKey);
        body.data.url = `${publicBaseUrl}/phone.html?${q}`;
      }

      try {
        await callNotify(body);
      } catch (err) {
        // 把不透明的 500 换成一条**能指路**的诊断。
        //
        // 原先这里直接把 HA 的原话往上抛，用户在腕上/终端看到的是
        // 「HA 服务 notify.mobile_app_x 返回 500: 500 Internal Server Error …」——
        // 既不说明原因，也不给下一步。而这一族失败（设备掉线）恰恰是
        // **最常见**的一种，完全可以从 HA 的公开 API 上判出来。
        const v = await probeReadiness(true).catch(() => null);
        const hint = v ? explainUnreachable(v, { device: notifyService, baseUrl }) : '';
        const wrapped = new Error(hint ? `${err.message}\n\n${hint}` : err.message);
        wrapped.cause = err;
        wrapped.diagnosis = v || null;
        wrapped.status = /返回 (\d{3})/.exec(err.message)?.[1] || null;
        throw wrapped;
      }

      // ⚠️ 这里**绝不能**把缓存断言成「在线」。
      //
      // `callNotify` 回 200 只说明 HA 收下了调用，**不说明设备收到了** ——
      // 本地推送在设备掉线时照样回 200。原先这里写的是
      // `reporting: true` + 「刚才这条推送成功了，设备在线。」，
      // 等于**用一条假证据覆盖掉真探测**：
      //   探测明明说「App 没在连」→ 一次 200 就改回「在线」
      //   → /healthz 报 deviceReady: true → push() 也不肯快失败
      //   → 上层空等满 TTL。整条链路上再没有任何一处说真话。
      //
      // 唯一诚实的做法是**作废缓存**：让下一次 /healthz 与下一次 push()
      // 重新去问 HA 要真值（存活传感器有没有取值）。
      readinessCache = { at: 0, value: null };
      return { ok: true, detail: `notify.${notifyService}` };
    },

    async clear(record) {
      if (!clearAfter) return;
      try {
        await callNotify({
          message: 'clear_notification',
          data: { tag: `apr_${record.id}` },
        });
      } catch {
        /* 清理失败不影响决策本身 */
      }
    },
  };
}
