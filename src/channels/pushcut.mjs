// Pushcut 通道（备选方案，与 HA 通道并存时可选其一）。
//
// 与 HA 通道的关键差别：Pushcut 的按钮走的是「后台 HTTP 请求」，所以
// 设备必须能把请求打到网关 —— 同局域网直接用内网地址，出门在外需要
// Tailscale 之类的组网。也正因为要把地址放进按钮，令牌必须是一次性的。
//
// 免费版限制：最多 3 条通知定义、每条通知 1 个动作，且不能用动态 JSON。
// 要用多选项必须 Pro。

export function create(cfg) {
  const webhookUrl = cfg.webhookUrl || '';
  const callbackBase = String(cfg.callbackBase || 'http://127.0.0.1:7788').replace(/\/+$/, '');

  return {
    name: 'pushcut',

    async start() {},

    async stop() {},

    async push(record) {
      if (!webhookUrl || webhookUrl.includes('XXXX')) {
        throw new Error('Pushcut webhookUrl 未配置');
      }

      const actions = record.options.map((o) => ({
        name: o.label,
        // 按钮按下时由 iPhone 在后台直接发这个请求，不打开任何 App（手表上也一样）
        url: `${callbackBase}/v1/decision`,
        urlBackgroundOptions: {
          httpMethod: 'POST',
          httpContentType: 'application/json',
          httpBody: JSON.stringify({ action: o.actionId, channel: 'pushcut' }),
        },
        keepNotification: false,
      }));

      const body = {
        title: record.title,
        text: record.body,
        isTimeSensitive: record.tier !== 'L0',
        id: `apr_${record.id}`,
        actions,
      };

      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`Pushcut 返回 ${res.status}: ${t.slice(0, 300)}`);
      }
      return { ok: true, detail: 'pushcut webhook' };
    },

    async clear(record) {
      // Pushcut 没有独立的撤回接口；通知在点击后自动消失（keepNotification: false）
    },
  };
}
