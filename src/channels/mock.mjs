// mock 通道：不依赖任何手机端配置，把「选项」打到控制台。
// 配合内置的手机模拟页（/），可以在没有 Home Assistant 的情况下先跑通整条链路。

const LABEL = {
  L0: '无需确认',
  L1: '仅记审计',
  L2: '需要确认',
  L3: '高危，需要确认',
};

export function create(cfg = {}) {
  return {
    name: 'mock',
    async start() {},
    async stop() {},
    async push(record, ctx) {
      const lines = [];
      lines.push('');
      lines.push('┌─ ' + LABEL[record.tier] + ' [' + record.tier + '] ' + record.title);
      lines.push('│  ' + record.body);
      if (record.tier === 'L3') lines.push('│  该级别要求设备解锁，超时按默认选项结算');
      lines.push('│');
      for (const o of record.options) {
        lines.push(`│  [${o.label}] → POST ${ctx.baseUrl}/v1/decision`);
      }
      lines.push('│  或在浏览器打开 ' + ctx.baseUrl + '/ 点按钮');
      lines.push('│  过期时间 ' + new Date(record.expiresAt).toLocaleTimeString('zh-CN')
        + '（' + Math.round((record.expiresAt - record.createdAt) / 1000) + 's）');
      lines.push('└─');
      console.log(lines.join('\n'));
      return { ok: true, detail: 'console' };
    },
    async clear(record) {
      console.log(`[mock] 已结算 ${record.id} → ${record.verdict}（${record.decidedOptionId}，${record.latencyMs}ms）`);
    },
  };
}
