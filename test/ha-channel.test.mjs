#!/usr/bin/env node
// HA 通道的单元测试：不连真机、不需要令牌、不碰网络。
//
// 存在的理由：`test/selftest.mjs` 跑的是 **mock** 通道，所以 HA 通道的
// 请求形状它一条都覆盖不到 —— `/api/services/notify.mobile_app_x`（点号）
// 这个 404 bug 就这样潜伏了两处，直到真的切到 ha 通道才炸出来。
// 这里用假 fetch 把 URL 与报文形状钉死。
//
//   node test/ha-channel.test.mjs

import { create, expandHint } from '../src/channels/ha.mjs';

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

/** 拦住 fetch，把每次调用记下来，返回一个可控的响应。 */
function stubFetch({ ok = true, status = 200, text = '' } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    return { ok, status, text: async () => text };
  };
  return calls;
}

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
  const url = calls[0]?.url ?? '';
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
    calls[0]?.url === 'http://ha.test:8123/api/services/notify/mobile_app_demo',
    `实际 ${calls[0]?.url}`
  );
}

{
  const calls = stubFetch();
  await mk().clear(record);
  const url = calls[0]?.url ?? '';
  check('clear 也走斜杠路径', url.endsWith('/api/services/notify/mobile_app_demo'), `实际 ${url}`);
  check('clear 的报文是 clear_notification + 同一个 tag',
    calls[0]?.body?.message === 'clear_notification' && calls[0]?.body?.data?.tag === 'apr_muTEST0001',
    JSON.stringify(calls[0]?.body));
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
  const b = calls[0].body;
  check('带 Authorization 头', calls[0].init.headers.Authorization === 'Bearer tok');
  check('title 取自记录', b.title === record.title);
  check(
    '正文 = 原文 + 长按展开提示',
    b.message === record.body + expandHint(record.options),
    JSON.stringify(b.message)
  );
  check(
    '提示里列出了全部按钮标签',
    b.message.includes('长按这张卡片') && b.message.includes('拒绝') && b.message.includes('仅此一次')
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
// 「HA 收到通知了，但手机上没有按钮可点」——iOS 不默认展示动作按钮，必须
// **展开**才看得见，而 Apple 不给任何视觉线索。官方原文（actionable-notifications）：
//   "All devices support notification expanding by performing a right to left swipe
//    and pressing 'View' in the lock screen or pressing and holding. If you're not in
//    the lock screen, you can also pull the notification down to expand it."
// 即：锁屏上**从右往左滑**再点「查看」，或**长按**；不在锁屏时可以把通知**下拉**。
// 正文里这一行是用户唯一的自救线索，所以要钉住它的形状。
console.log('\n[2b] 长按展开提示');

{
  check(
    '没有按钮就不追加提示',
    expandHint([]) === '' && expandHint(null) === '' && expandHint(undefined) === '',
    JSON.stringify([expandHint([]), expandHint(null), expandHint(undefined)])
  );

  const h = expandHint([{ label: '拒绝' }, { label: '仅此一次' }, { label: '查看详情' }]);
  check('多个按钮用「 / 」连接', h === '\n长按这张卡片 → 展开「拒绝 / 仅此一次 / 查看详情」', JSON.stringify(h));
  check('提示以换行开头（不和命令挤在同一行）', h.startsWith('\n'));

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
  const acts = calls[0].body.data.actions;
  check('「查看详情」用 info 图标', acts[2].icon === 'sfsymbols:info.circle', JSON.stringify(acts.map((x) => x.icon)));
  check('三个按钮的图标互不相同', new Set(acts.map((x) => x.icon)).size === 3, JSON.stringify(acts.map((x) => x.icon)));
  check('L3 正文也带长按提示', calls[0].body.message.includes('长按这张卡片'));
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
  check(
    '未配 publicBaseUrl 时不写 url（避免死链）',
    !('url' in c0[0].body.data),
    JSON.stringify(Object.keys(c0[0].body.data))
  );

  const c1 = stubFetch();
  await mk({ publicBaseUrl: 'http://192.168.1.5:7788' }).push(record);
  check(
    '配了就写 url，并带 focus=<id> 让页面自动置顶',
    c1[0].body.data.url === 'http://192.168.1.5:7788/phone.html?focus=muTEST0001',
    c1[0].body.data.url
  );
  check('url 挂在 data 下（不是顶层）', !('url' in c1[0].body), JSON.stringify(Object.keys(c1[0].body)));

  const c2 = stubFetch();
  await mk({ publicBaseUrl: 'http://192.168.1.5:7788/' }).push(record);
  check(
    'publicBaseUrl 尾斜杠不会拼出双斜杠',
    c2[0].body.data.url === 'http://192.168.1.5:7788/phone.html?focus=muTEST0001',
    c2[0].body.data.url
  );

  const c3 = stubFetch();
  await mk({ publicBaseUrl: 'http://192.168.1.5:7788', phoneAccessKey: 's3cret' }).push(record);
  check('配了口令就带上 k=', c3[0].body.data.url.endsWith('&k=s3cret'), c3[0].body.data.url);
}

// ── 3. 分级 → 提醒强度 ─────────────────────────────────────────────────────
// criticalFromTier 必须是一个**关得掉**的开关：设成 null 时，L3 也不能偷偷
// 发 critical 提醒音（critical 会绕过静音与专注模式）。
console.log('\n[3] 分级决定打断强度');

{
  const calls = stubFetch();
  await mk().push({ ...record, tier: 'L1' });
  check('L1 不设 interruption-level', calls[0].body.data.push['interruption-level'] === undefined,
    JSON.stringify(calls[0].body.data.push));
  check('L1 用普通声音', calls[0].body.data.push.sound.critical === undefined);
}

{
  const calls = stubFetch();
  await mk().push({ ...record, tier: 'L2' });
  check('L2（timeSensitiveFromTier 默认值）→ time-sensitive',
    calls[0].body.data.push['interruption-level'] === 'time-sensitive',
    JSON.stringify(calls[0].body.data.push));
}

{
  // 出厂推荐配置就是 criticalFromTier: "L3"
  const calls = stubFetch();
  await mk({ criticalFromTier: 'L3' }).push({ ...record, tier: 'L2' });
  check('criticalFromTier=L3 时，L2 仍只是 time-sensitive',
    calls[0].body.data.push['interruption-level'] === 'time-sensitive');
}

{
  const calls = stubFetch();
  await mk({ criticalFromTier: 'L3' }).push({ ...record, tier: 'L3' });
  const p = calls[0].body.data.push;
  const a = calls[0].body.data.actions;
  check('criticalFromTier=L3 时，L3 → critical 级别', p['interruption-level'] === 'critical', JSON.stringify(p));
  check('L3 → 临界音量声音', p.sound.critical === 1 && p.sound.volume === 1, JSON.stringify(p.sound));
  check('L3 → 每个按钮都要求解锁', a.every((x) => x.authenticationRequired === true), JSON.stringify(a));
}

{
  // null = 明确表示「不要用 critical」，必须真的关掉 —— 否则配置在撒谎
  const calls = stubFetch();
  await mk({ criticalFromTier: null }).push({ ...record, tier: 'L3' });
  const p = calls[0].body.data.push;
  check('criticalFromTier=null 时 L3 退回 time-sensitive', p['interruption-level'] === 'time-sensitive', JSON.stringify(p));
  check('criticalFromTier=null 时 L3 也用普通声音', p.sound.critical === undefined, JSON.stringify(p.sound));
  check('关掉 critical 不影响按钮仍要求解锁',
    calls[0].body.data.actions.every((x) => x.authenticationRequired === true));
}

{
  const calls = stubFetch();
  await mk().push({ ...record, tier: 'L1', options: [{ id: 'ok', label: '知道了', actionId: 'APR:x', requireUnlock: true }] });
  check('选项自带 requireUnlock 时也会要求解锁',
    calls[0].body.data.actions[0].authenticationRequired === true);
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

// ── 汇总 ───────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(52));
console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  · ${f}`);
}
console.log('─'.repeat(52) + '\n');

process.exit(fail ? 1 : 0);
