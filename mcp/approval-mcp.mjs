#!/usr/bin/env node
// MCP stdio server：给 Agent 一个「主动请求确认」的工具。
// hook 只能拦工具权限；这个入口让 Agent 在别的事情上也能问人 ——
// 比如「这份报告要不要发出去」「这两个方案选哪个」。
//
// 注册（~/.workbuddy/mcp.json）：
//   "approval": { "command": "node", "args": ["<绝对路径>/mcp/approval-mcp.mjs"] }

const GATEWAY = (process.env.APPROVAL_GATEWAY_URL || 'http://127.0.0.1:7788').replace(/\/+$/, '');

const TOOLS = [
  {
    name: 'request_approval',
    description:
      '把一个需要用户拍板的决策推到用户的 iPhone 和 Apple Watch，并等待用户在手腕上选择。' +
      '适用于有外部副作用或不可逆的操作、以及需要用户在若干方案中二选一的场合。' +
      '返回用户在手机/手表上选定的结果；若超时未响应则按默认选项（拒绝）结算。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '通知标题，建议不超过 12 个汉字' },
        body: {
          type: 'string',
          description: '一句话说明要确认什么、影响是什么。手表扬声器小，控制在 2 行以内，且不要包含密钥或敏感数据。',
        },
        risk_tier: {
          type: 'string',
          enum: ['L2', 'L3'],
          description: 'L2 为外部副作用（推送 GitHub、调用写接口等）；L3 为不可逆或高危操作，会要求设备解锁。',
        },
        action: {
          type: 'string',
          description: '将要执行的动作的原文，用于计算绑定哈希，便于事后核对「批准的是什么」',
        },
        options: {
          type: 'array',
          description: '自定义选项，最多 3 个。不传则使用默认的「拒绝 / 仅此一次 / 本会话内允许」。第一个选项会被放在手表双击位置，建议放保守选项。',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string', description: '按钮文案，不超过 6 个汉字' },
              verdict: { type: 'string', enum: ['allow', 'deny'] },
            },
            required: ['id', 'label'],
          },
        },
        ttl_seconds: { type: 'number', description: '超时秒数，默认 L2 为 300、L3 为 120' },
        wait_seconds: { type: 'number', description: '本次阻塞等待的最长秒数，默认与 ttl 一致' },
      },
      required: ['body'],
    },
  },
  {
    name: 'list_pending_approvals',
    description: '列出仍在等待用户确认的请求，用于了解是否有事情卡在用户那边。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'cancel_approval',
    description: '撤回一个还没被确认的请求（例如 Agent 自己已经决定不做了）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'request_approval 返回的请求 id' },
        reason: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'verify_approval',
    description:
      '核对某个已通过的确认，是否与「你此刻准备执行的动作」完全一致。' +
      '在动手之前调用它可以防住「批准了 A 却去做了 B」的情况。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        action: { type: 'string', description: '你此刻准备执行的动作原文，需与申请时一致' },
        tool: { type: 'string' },
        tool_input: { type: 'object' },
      },
      required: ['id', 'action'],
    },
  },
  {
    name: 'get_approval_audit',
    description: '读取确认审计日志：谁、何时、什么动作、多久回应、选了哪个选项。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '默认 30 条' } },
    },
  },
];

async function callGateway(pathname, body) {
  const res = await fetch(GATEWAY + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, json: { raw: text } };
  }
}

async function getGateway(pathname) {
  const res = await fetch(GATEWAY + pathname);
  return { status: res.status, json: await res.json() };
}

function text(s) {
  return { content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }] };
}

async function runTool(name, args) {
  switch (name) {
    case 'request_approval': {
      const binding = (a) => a;
      const payload = {
        tool: args.tool || 'MCP:request_approval',
        tool_input: args.tool_input || { action: args.action || args.body },
        tier: args.risk_tier || 'L2',
        title: args.title || 'Agent 请求确认',
        body: args.body,
        options: args.options,
        ttl: args.ttl_seconds,
        wait: args.wait_seconds || args.ttl_seconds,
        requester: 'mcp',
      };
      const { json } = await callGateway('/v1/approvals', payload);
      if (json.error) return text(`发起确认失败：${json.error}`);
      const verdictCn = json.verdict === 'allow' ? '已批准' : '被拒绝';
      return text([
        `结果：${verdictCn}`,
        `选项：${json.optionId}`,
        `状态：${json.status}`,
        `id：${json.id}`,
        `绑定哈希：${json.binding}`,
        json.latencyMs != null ? `用户响应耗时：${Math.round(json.latencyMs / 100) / 10}s` : '',
        json.decidedBy ? `决策来源：${json.decidedBy}${json.deviceName ? ' / ' + json.deviceName : ''}` : '',
        json.pushOk === false ? `注意：推送失败（${json.pushDetail}）` : '',
        '',
        '在真正执行前，请用 verify_approval 核对 action 与申请时一致。',
      ].filter(Boolean).join('\n'));
    }
    case 'list_pending_approvals': {
      const { json } = await getGateway('/v1/approvals?status=pending');
      if (!json.items || !json.items.length) return text('当前没有等待确认的请求。');
      return text(json.items.map((i) =>
        `- ${i.id} [${i.tier}] ${i.title}｜${i.body}｜剩余 ${Math.round(i.remainingMs / 1000)}s`).join('\n'));
    }
    case 'cancel_approval': {
      const { json } = await callGateway(`/v1/approvals/${encodeURIComponent(args.id)}/decide`, {
        option_id: 'deny', source: 'agent-cancel',
      });
      return text(json.message || JSON.stringify(json));
    }
    case 'verify_approval': {
      const { json } = await callGateway('/v1/verify', {
        id: args.id,
        tool: args.tool || 'MCP:request_approval',
        tool_input: args.tool_input || { action: args.action },
      });
      return text(json.ok
        ? '一致：该确认对应的正是你此刻准备执行的动作，可以继续。'
        : `不一致，请停止并重新发起确认。\n${JSON.stringify(json, null, 2)}`);
    }
    case 'get_approval_audit': {
      const { json } = await getGateway(`/v1/audit?limit=${Number(args.limit || 30)}`);
      return text(json.items || []);
    }
    default:
      throw new Error(`未知工具 ${name}`);
  }
}

// ── JSON-RPC over stdio（换行分隔）─────────────────────────────────────────
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const { id, method, params } = msg;

    if (method === 'initialize') {
      reply(id, {
        protocolVersion: (params && params.protocolVersion) || '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'approval-gateway', version: '0.1.0' },
      });
      continue;
    }
    if (method === 'notifications/initialized' || method === 'initialized') continue;
    if (method === 'ping') { reply(id, {}); continue; }
    if (method === 'tools/list') { reply(id, { tools: TOOLS }); continue; }
    if (method === 'tools/call') {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      try {
        reply(id, await runTool(name, args));
      } catch (e) {
        const hint = /ECONNREFUSED|fetch failed/i.test(String(e.message))
          ? `确认网关不可达（${GATEWAY}），请先启动 approval-gateway。`
          : e.message;
        reply(id, { content: [{ type: 'text', text: '调用失败：' + hint }], isError: true });
      }
      continue;
    }
    if (id !== undefined) replyError(id, -32601, `未实现的方法 ${method}`);
  }
});

process.stdin.on('end', () => process.exit(0));
