#!/usr/bin/env node
// HA 通道的单元测试：不连真机、不需要令牌、不碰网络。
//
// 存在的理由：`test/selftest.mjs` 跑的是 **mock** 通道，所以 HA 通道的
// 请求形状它一条都覆盖不到 —— `/api/services/notify.mobile_app_x`（点号）
// 这个 404 bug 就这样潜伏了两处，直到真的切到 ha 通道才炸出来。
// 这里用假 fetch 把 URL 与报文形状钉死。
//
//   node test/ha-channel.test.mjs

import { create, expandHint, describeForeignAction } from '../src/channels/ha.mjs';

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

/** 拦住 fetch，把每次调用记下来，返回一个可控的响应。
 *
 * 默认让 `/api/states` 返回一个空数组（合法 JSON），让 readiness 探测走到
 * "判不了"分支而不是报错 —— push() 仍会照常发。其它端点返回 text 默认值。
 */
function stubFetch({ ok = true, status = 200, text = '' } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    const u = String(url);
    const bodyText = u.includes('/api/states') ? '[]' : text;
    return { ok, status, text: async () => bodyText };
  };
  return calls;
}

/** 取「对 /api/services/ 的那次调用」—— readiness 探测可能在前面。 */
const serviceCall = (calls) => calls.find((c) => c.url.includes('/api/services/')) ?? null;

const record = {
  id: 'muTEST0001',
  tier: 'L2',
  title: 'Agent 想重建产物目录',
  body: 'rm -rf ./dist && npm run build',
  options: [
    { id: 'deny', label: '拒绝', verdict: 'deny', actionId: 'APR:muTEST0001:deny:aa:bb' },
    { id: 'approve', label: '仅此一次', verdict: 'allow', actionId: 'APR:muTEST0001:approve:cc:dd' },
  ],
};

function mk(extra = {}, deps = {}) {
  return create(
    { baseUrl: 'http://ha.test:8123', token: 'tok', notifyService: 'mobile_app_demo', ...extra },
    { onDecision: () => {}, ...deps }
  );
}

// ── 1. URL 形状：这是那个 404 bug 的护栏 ────────────────────────────────────
console.log('\n[1] REST 路径必须是斜杠分隔');

{
  const calls = stubFetch();
  await mk().push(record);
  const url = serviceCall(calls)?.url ?? '';
  check(
    'push 走 /api/services/notify/<服务名>（斜杠）',
    url === 'http://ha.test:8123/api/services/notify/mobile_app_demo',
    `实际 ${url}`
  );
  check('URL 里不出现点号写法 notify.mobile_app_demo', !url.includes('notify.mobile_app_demo'), `实际 ${url}`);
  check('baseUrl 结尾斜杠不会拼出双斜杠', !url.includes('//api'), `实际 ${url}`);
}

{
  const calls = stubFetch();
  await mk({ baseUrl: 'http://ha.test:8123/' }).push(record);
  check(
    'baseUrl 带尾斜杠也能正确拼接',
    serviceCall(calls)?.url === 'http://ha.test:8123/api/services/notify/mobile_app_demo',
    `实际 ${serviceCall(calls)?.url}`
  );
}

{
  const calls = stubFetch();
  await mk().clear(record);
  const c = serviceCall(calls);
  const url = c?.url ?? '';
  check('clear 也走斜杠路径', url.endsWith('/api/services/notify/mobile_app_demo'), `实际 ${url}`);
  check('clear 的报文是 clear_notification + 同一个 tag',
    c?.body?.message === 'clear_notification' && c?.body?.data?.tag === 'apr_muTEST0001',
    JSON.stringify(c?.body));
}

{
  const calls = stubFetch();
  await mk({ clearAfterDecision: false }).clear(record);
  check('clearAfterDecision=false 时不发清理消息', calls.length === 0, `实际发了 ${calls.length} 次`);
}

// ── 2. 通知报文形状 ────────────────────────────────────────────────────────
console.log('\n[2] 通知报文形状');

{
  const calls = stubFetch();
  await mk().push(record);
  const svc = serviceCall(calls);
  const b = svc.body;
  check('带 Authorization 头', svc.init.headers.Authorization === 'Bearer tok');
  check('title 取自记录', b.title === record.title);
  check(
    '正文 = 原文 + 展开提示',
    b.message === record.body + expandHint(record.options),
    JSON.stringify(b.message)
  );
  check(
    '提示里列出了全部按钮标签',
    b.message.includes('按钮在卡片底部') && b.message.includes('拒绝') && b.message.includes('仅此一次')
  );
  check(
    '允许/拒绝各带不同 SF Symbol 图标',
    b.data.actions[0].icon === 'sfsymbols:xmark.circle.fill' &&
      b.data.actions[1].icon === 'sfsymbols:checkmark.circle.fill',
    JSON.stringify(b.data.actions.map((x) => x.icon))
  );
  check('tag 带 apr_ 前缀（清理时靠它定位）', b.data.tag === 'apr_muTEST0001');
  check('group 固定为 agent-approval', b.data.group === 'agent-approval');
  check('按钮数 = 选项数', b.data.actions.length === 2);
  check(
    '按钮 action 就是一次性能力令牌',
    b.data.actions[0].action === 'APR:muTEST0001:deny:aa:bb' &&
      b.data.actions[1].action === 'APR:muTEST0001:approve:cc:dd'
  );
  check('按钮 title 是人看的标签', b.data.actions[1].title === '仅此一次');
}

// ── 2b. 长按展开提示 ────────────────────────────────────────────────────────
// 「HA 收到通知了，但通知上没有按钮可点」——iOS / watchOS **都不**默认展示动作
// 按钮，必须**展开**才看得见，而 Apple 不给任何视觉线索。两边的官方原文：
//   iPhone（actionable-notifications）：
//     "All devices support notification expanding by performing a right to left swipe
//      and pressing 'View' in the lock screen or pressing and holding. If you're not in
//      the lock screen, you can also pull the notification down to expand it."
//     → 锁屏上**从右往左滑**再点「查看」，或**长按**；不在锁屏时把通知**下拉**。
//   Apple Watch（Apple Watch 使用手册「查看和响应通知」）：
//     「旋转数码表冠以滚动到通知底部，然后轻点底部的一个按钮」
//     → 按钮在长视图**底部**，要滚表冠才出现；点卡片本体只会**打开 App**。
//
// ⚠️ 这条 2026-09-20 被真机推翻过一次：原先这里（以及代码注释、INSTALL/SETUP/SKILL）
// 都写着「watchOS 直接显示按钮」——错的，两边一样要展开，只是手势不同。
// 正文里这一行是用户唯一的自救线索，所以要钉住它的形状，且必须覆盖两个平台。
console.log('\n[2b] 展开提示（手机 + 手表）');

{
  check(
    '没有按钮就不追加提示',
    expandHint([]) === '' && expandHint(null) === '' && expandHint(undefined) === '',
    JSON.stringify([expandHint([]), expandHint(null), expandHint(undefined)])
  );

  const h = expandHint([{ label: '拒绝' }, { label: '仅此一次' }, { label: '查看详情' }]);
  check(
    '多个按钮用「 / 」连接',
    h === '\n按钮在卡片底部：手机长按展开，手表转表冠滚到底 → 「拒绝 / 仅此一次 / 查看详情」',
    JSON.stringify(h)
  );
  check('提示以换行开头（不和命令挤在同一行）', h.startsWith('\n'));
  // 两个平台的手势必须都说到 —— 只说手机，手表上的人就会以为「没有按钮」。
  check('提示同时覆盖手机与手表', h.includes('手机长按') && h.includes('手表转表冠'));

  // 真实 L3 预设：拒绝 / 仅此一次 / 查看详情 —— 三种 verdict 各一个图标
  const calls = stubFetch();
  await mk().push({
    ...record,
    tier: 'L3',
    options: [
      { id: 'deny', label: '拒绝', verdict: 'deny', actionId: 'APR:x:deny:1:2' },
      { id: 'approve', label: '仅此一次', verdict: 'allow', actionId: 'APR:x:approve:3:4' },
      { id: 'detail', label: '查看详情', verdict: 'defer', informative: true, actionId: 'APR:x:detail:5:6' },
    ],
  });
  const acts = serviceCall(calls).body.data.actions;
  check('「查看详情」用 info 图标', acts[2].icon === 'sfsymbols:info.circle', JSON.stringify(acts.map((x) => x.icon)));
  check('三个按钮的图标互不相同', new Set(acts.map((x) => x.icon)).size === 3, JSON.stringify(acts.map((x) => x.icon)));
  check('L3 正文也带展开提示', serviceCall(calls).body.message.includes('按钮在卡片底部'));
}

// ── 2b-2. 「点了通知却没产生决策」必须说出来 ─────────────────────────────────
// gateway 对非 `APR:` 的 action 统一返回 `{ ok: true, ignored: … }` —— 一条
// **没有信息量的成功返回**。而「点了通知主体」产生的
// `UNNotificationDefaultActionIdentifier` 恰好落在这个分支里，于是用户那句
// 「我点过了」被静默丢弃，事后完全无从查证（同一个模式在 `fetch failed` 上已经
// 踩过一次：错误被压掉，只剩形式上的成功）。
//
// 这两个字面量是 Apple 定的，必须**逐字**匹配 —— 拼错就退化成「不认识」，
// 于是这个测试的真正价值是钉住拼写。
console.log('\n[2b-2] 通知落点的翻译');

{
  const d = describeForeignAction('com.apple.UNNotificationDefaultActionIdentifier');
  check('认出「点了通知主体」', d.includes('点了通知主体') && d.includes('没有产生任何决策'), d);
  check('并指出两个平台的正确手势', d.includes('长按') && d.includes('表冠'), d);
  // 这段文字直接进 console —— 混进 Markdown 星号就会原样打出来。
  check('不含 Markdown 标记（它要进终端）', !d.includes('**') && !d.includes('`'), d);

  const x = describeForeignAction('com.apple.UNNotificationDismissActionIdentifier');
  check('认出「忽略 / 划掉通知」', x.includes('忽略') && x.includes('没有产生任何决策'), x);

  const o = describeForeignAction('APR:abc:allow:1:2');
  check('不认识的动作如实说明、不硬猜', o.includes('不是本网关签发'), o);
  check(
    '空值不抛异常',
    typeof describeForeignAction() === 'string' && typeof describeForeignAction(null) === 'string'
  );
  check('三个分支互不相同', new Set([d, x, o]).size === 3);
}

// ── 2c. 点通知直达审批页（url） ────────────────────────────────────────────
// iOS 上「点通知主体」**不需要展开**，只要 payload 带 \`url\` —— 这是
// 「按钮藏在展开层里」的退路。关键在**没配地址时必须不写 url**：
// 默认 host 是 127.0.0.1，手机访问不到，硬写进去只会得到一条点了没反应的
// 死链，那比没有更糟（用户会以为整套东西坏了）。
console.log('\n[2c] 点通知直达审批页');

{
  const c0 = stubFetch();
  await mk().push(record);
  const s0 = serviceCall(c0);
  check(
    '未配 publicBaseUrl 时不写 url（避免死链）',
    !('url' in s0.body.data),
    JSON.stringify(Object.keys(s0.body.data))
  );

  const c1 = stubFetch();
  await mk({ publicBaseUrl: 'http://192.168.1.5:7788' }).push(record);
  const s1 = serviceCall(c1);
  check(
    '配了就写 url，并带 focus=<id> 让页面自动置顶',
    s1.body.data.url === 'http://192.168.1.5:7788/phone.html?focus=muTEST0001',
    s1.body.data.url
  );
  check('url 挂在 data 下（不是顶层）', !('url' in s1.body), JSON.stringify(Object.keys(s1.body)));

  const c2 = stubFetch();
  await mk({ publicBaseUrl: 'http://192.168.1.5:7788/' }).push(record);
  const s2 = serviceCall(c2);
  check(
    'publicBaseUrl 尾斜杠不会拼出双斜杠',
    s2.body.data.url === 'http://192.168.1.5:7788/phone.html?focus=muTEST0001',
    s2.body.data.url
  );

  const c3 = stubFetch();
  await mk({ publicBaseUrl: 'http://192.168.1.5:7788', phoneAccessKey: 's3cret' }).push(record);
  const s3 = serviceCall(c3);
  check('配了口令就带上 k=', s3.body.data.url.endsWith('&k=s3cret'), s3.body.data.url);
}

// ── 3. 分级 → 提醒强度 ─────────────────────────────────────────────────────
// criticalFromTier 必须是一个**关得掉**的开关：设成 null 时，L3 也不能偷偷
// 发 critical 提醒音（critical 会绕过静音与专注模式）。
console.log('\n[3] 分级决定打断强度');

{
  const calls = stubFetch();
  await mk().push({ ...record, tier: 'L1' });
  const s = serviceCall(calls);
  check('L1 不设 interruption-level', s.body.data.push['interruption-level'] === undefined,
    JSON.stringify(s.body.data.push));
  check('L1 用普通声音', s.body.data.push.sound.critical === undefined);
}

{
  const calls = stubFetch();
  await mk().push({ ...record, tier: 'L2' });
  const s = serviceCall(calls);
  check('L2（timeSensitiveFromTier 默认值）→ time-sensitive',
    s.body.data.push['interruption-level'] === 'time-sensitive',
    JSON.stringify(s.body.data.push));
}

{
  // 出厂推荐配置就是 criticalFromTier: "L3"
  const calls = stubFetch();
  await mk({ criticalFromTier: 'L3' }).push({ ...record, tier: 'L2' });
  const s = serviceCall(calls);
  check('criticalFromTier=L3 时，L2 仍只是 time-sensitive',
    s.body.data.push['interruption-level'] === 'time-sensitive');
}

{
  const calls = stubFetch();
  await mk({ criticalFromTier: 'L3' }).push({ ...record, tier: 'L3' });
  const s = serviceCall(calls);
  const p = s.body.data.push;
  const a = s.body.data.actions;
  check('criticalFromTier=L3 时，L3 → critical 级别', p['interruption-level'] === 'critical', JSON.stringify(p));
  check('L3 → 临界音量声音', p.sound.critical === 1 && p.sound.volume === 1, JSON.stringify(p.sound));
  check('L3 → 每个按钮都要求解锁', a.every((x) => x.authenticationRequired === true), JSON.stringify(a));
}

{
  // null = 明确表示「不要用 critical」，必须真的关掉 —— 否则配置在撒谎
  const calls = stubFetch();
  await mk({ criticalFromTier: null }).push({ ...record, tier: 'L3' });
  const s = serviceCall(calls);
  const p = s.body.data.push;
  check('criticalFromTier=null 时 L3 退回 time-sensitive', p['interruption-level'] === 'time-sensitive', JSON.stringify(p));
  check('criticalFromTier=null 时 L3 也用普通声音', p.sound.critical === undefined, JSON.stringify(p.sound));
  check('关掉 critical 不影响按钮仍要求解锁',
    s.body.data.actions.every((x) => x.authenticationRequired === true));
}

{
  const calls = stubFetch();
  await mk().push({ ...record, tier: 'L1', options: [{ id: 'ok', label: '知道了', actionId: 'APR:x', requireUnlock: true }] });
  const s = serviceCall(calls);
  check('选项自带 requireUnlock 时也会要求解锁',
    s.body.data.actions[0].authenticationRequired === true);
}

// ── 4. 失败要抛错，且错误里带得上服务名 ───────────────────────────────────
console.log('\n[4] 推送失败要抛出可读错误');

{
  stubFetch({ ok: false, status: 404, text: '404: Not Found' });
  let err = null;
  try {
    await mk().push(record);
  } catch (e) {
    err = e;
  }
  check('非 2xx 会抛错（不会静默当成成功）', !!err, String(err));
  check('错误信息里带域.服务名，便于排查', /notify\.mobile_app_demo/.test(err?.message || ''), err?.message);
  check('错误信息里带状态码与响应体', /404/.test(err?.message || '') && /Not Found/.test(err?.message || ''));
}

// ── 5. 未配置令牌时不应假装就绪 ────────────────────────────────────────────
console.log('\n[5] 未配置令牌时如实降级');

{
  const calls = stubFetch();
  const ch = mk({ token: 'PASTE_TOKEN_HERE' });
  await ch.start();          // 不应建立连接
  check('令牌是占位符时 start() 不连、也不抛错', ch.connected === false);
  check('令牌是占位符时不发任何请求', calls.length === 0);
}

// ── 6. 设备掉线时不许白推（「总是卡死两分钟」的护栏） ──────────────────────
//
// 这一节钉的是 2026-09-20 查明的最深那条根因：
// HA 的本地推送**在设备掉线时照样回 200**（它只负责把消息交给推送服务，
// 不保证送达）。于是 push() 记 `pushOk: true` → 上层以为「卡片在路上」
// → 老老实实等满 TTL → 最后只留一句「120s 内未收到确认，按默认拒绝」。
// 用户体感就是「总是卡死」，而且翻审计也查不出原因。
//
// 现在 push() 在推之前先看设备在不在连；确认掉线就直接返回 ok:false，
// 交给上层的「快失败」分支（0.02 秒返回 + 一句能指路的诊断）。
console.log('\n[6] 设备掉线时不许白推');

/** 一份 /api/states：device `demo` 的四条存活传感器。
 *  value 传 null 表示「实体存在但没有值」= App 没在连。 */
function statesFixture(value) {
  const map = {
    app_version: '2025.9.1',
    battery_level: '82',
    battery_state: 'Charging',
    last_update_trigger: 'signaled',
  };
  return JSON.stringify(Object.keys(map).map((k) => ({
    entity_id: `sensor.demo_${k}`,
    state: value === null ? 'unavailable' : map[k],
  })));
}

/** 按调用次序返回不同的 /api/states —— 用来模拟「缓存比现实旧」。
 *  ⚠️ 必须同时实现 `text()` 与 `json()`：probeReadiness 走的是 `res.json()`，
 *  而 notify 那条路径读 `res.text()`。少一个就会静默退化成「判不了设备状态」。 */
function stubStatesSeq(seq) {
  const calls = [];
  let i = 0;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    const u = String(url);
    let text = '';
    if (u.includes('/api/states')) {
      text = seq[Math.min(i, seq.length - 1)];
      i += 1;
    }
    return {
      ok: true,
      status: 200,
      text: async () => text,
      json: async () => JSON.parse(text || 'null'),
    };
  };
  return calls;
}

const OFF = statesFixture(null);
const ON = statesFixture('online');

{
  // ① 确认掉线：一次 notify 都不该发
  const calls = stubStatesSeq([OFF]);
  const res = await mk().push(record);
  check('设备掉线时 push() 返回 ok:false', res.ok === false, JSON.stringify(res));
  check('返回里标明 deviceOffline（便于上层与审计区分）', res.deviceOffline === true, JSON.stringify(res));
  check('诊断里写清「App 没在连」，不是含糊的 500', /没在连/.test(res.detail || ''), res.detail);
  check('★ 掉线时压根不调 notify（否则又是一次 200 假象）',
    calls.filter((c) => c.url.includes('/api/services/')).length === 0,
    JSON.stringify(calls.map((c) => c.url)));
  check('掉线时探两次（缓存一次 + 强制复核一次）',
    calls.filter((c) => c.url.includes('/api/states')).length === 2,
    String(calls.filter((c) => c.url.includes('/api/states')).length));
}

{
  // ② 设备在线：照常推
  const calls = stubStatesSeq([ON]);
  const res = await mk().push(record);
  check('设备在线时照常推送，ok:true', res.ok === true, JSON.stringify(res));
  check('设备在线时确实发了一次 notify',
    calls.filter((c) => c.url.includes('/api/services/')).length === 1);
}

{
  // ③ 判不了（设备没注册 / 实体被禁用）时必须放行等待，不许拦人
  const calls = stubStatesSeq(['[]']);
  const res = await mk().push(record);
  check('判不了设备状态时不拦（宁可等，也不误拒）', res.ok === true, JSON.stringify(res));
  check('判不了时照常发 notify',
    calls.filter((c) => c.url.includes('/api/services/')).length === 1);
}

{
  // ④ ★ 推送成功不许反过来把「真探测」覆盖成「在线」
  //    次序：①缓存探测=掉线 ②强制复核=在线 ③之后的 readiness()=掉线
  const calls = stubStatesSeq([OFF, ON, OFF]);
  const ch = mk();
  const res = await ch.push(record);
  check('缓存说掉线但复核说在线 → 不误拦，照常推', res.ok === true, JSON.stringify(res));
  check('复核说在线时确实发了 notify',
    calls.filter((c) => c.url.includes('/api/services/')).length === 1);

  const after = await ch.readiness();
  check('★ 推送成功后缓存被作废，readiness() 重新问 HA（不撒谎报在线）',
    after.reporting === false, JSON.stringify(after));
  check('readiness() 确实又探了一次，不是拿缓存顶',
    calls.filter((c) => c.url.includes('/api/states')).length === 3,
    String(calls.filter((c) => c.url.includes('/api/states')).length));
}

{
  // ⑤ 自动补推的可辨识性：被划走又回来时，得让人看出来是同一件事
  const calls = stubStatesSeq([ON]);
  await mk().push({ ...record, renotify: 2 });
  const s = serviceCall(calls);
  check('补推标题标出次数（让你认出「划掉的那张回来了」）',
    s.body.title === 'Agent 想重建产物目录（第 2 次提醒）', s.body.title);
  check('补推仍用同一个 tag（是替换不是堆叠）',
    s.body.data.tag === 'apr_muTEST0001', s.body.data.tag);
}

// ── 汇总 ───────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(52));
console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  · ${f}`);
}
console.log('─'.repeat(52) + '\n');

process.exit(fail ? 1 : 0);
