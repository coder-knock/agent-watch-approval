---
name: wrist-approval-gateway
displayName: 腕上确认网关
displayNameEn: Wrist Approval Gateway
version: 0.4.0
description: |
  Push L2/L3 tool calls to iPhone / Apple Watch — decide on the wrist,
  return the verdict to the Agent. When the wrist path fails the hook still
  denies (fail-closed), but the question is not dropped: the reason carries a
  marker that tells the Agent to re-ask you with the host's OWN confirm dialog,
  so you are always asked once by the UI you already use. L0/L1 silent-pass;
  L3 never auto-allows.

  把 Agent 运行中需要拍板的选项推到 iPhone / Apple Watch，腕上决策后
  回传给 Agent。腕上那条路断了，hook 仍然输出 deny（fail-closed）——
  但问题不会被丢掉：reason 里带上标记，由 Agent 用**宿主原本的确认框**
  再问你一次，所以「问你」这件事始终由你本来就在用的界面承担。
  L0/L1 静默放行；L3 永不自动放行。

homepage: https://watch-alert.coderknock.com/
repository: https://github.com/coder-knock/agent-watch-approval
license: MIT
author: coder-knock

tags:
  - approval
  - permission
  - hook
  - apple-watch
  - iphone
  - home-assistant
  - mcp
  - claude-code
  - safety

categories:
  - 安全与权限 (Safety & Permissions)
  - Agent 工具集成 (Agent Tool Integration)

platforms:
  - macos
  - ios
  - watchos

node: ">=20"
runtime: Node.js (ESM)

install:
  npm: agent-watch-approval
  from_source: |
    git clone https://github.com/coder-knock/agent-watch-approval.git
    cd agent-watch-approval && npm install

entrypoints:
  cli:
    approve-hook: bin/approve-hook.mjs
    approval-gateway: src/gateway.mjs
    approval-mcp: mcp/approval-mcp.mjs
  http:
    - POST /v1/approvals
    - POST /v1/decision
    - GET  /healthz
    - GET  /phone.html
  mcp:
    server: mcp/approval-mcp.mjs
    tools:
      - verify_approval
      - get_approval_audit
      - list_pending

# ── 一句话说明 ─────────────────────────────────────────────────────────────
tagline: |
  Decide on the wrist — push L2/L3 tool calls to Apple Watch, never auto-allow L3.
  决策权落在手腕上 —— L2/L3 推到 Apple Watch，L3 永不自动放行。

# ── 它解决什么问题 ─────────────────────────────────────────────────────────
problem: |
  Agent 跑 L2/L3 工具调用（写文件、发消息、执行 shell）时，确认这件事没有可靠的落点：

  · 宿主自己弹框 —— 但 Agent 跑在 headless（`-p`）时根本没人接，那个框不会出现；
  · 卡在宿主 UI 上等人 —— 人不在电脑前，任务就一直挂着；
  · 干脆放过去 —— 这一刀该不该砍，没人问过你。

  也就是说：**决策点要么不在你手上，要么不在你能及时够到的地方。**
  常见做法是「推送失败就拦住」，但那只是把「没人问你」变成了「什么都干不了」——
  用户的原话是「只有提醒，不能确认」。

# ── 它怎么解决 ─────────────────────────────────────────────────────────────
solution: |
  本地常驻一个 Node 网关。Agent 的 hook 把工具调用送到网关，网关做风险分级：

  | 档位 | 含义 | 处置 |
  | --- | --- | --- |
  | L0 | 只读 / 噪声 | 静默放行 |
  | L1 | 写本地、可审计 | 放行 + 留痕 |
  | L2 | 改文件 / 发消息 | 推 time-sensitive 通知 |
  | L3 | 删数据 / 不可逆 | 推 critical + 永不自动放行 |

  L2/L3 推成一张带「允许 / 拒绝」按钮的卡片，到 iPhone / Apple Watch。
  用户点按钮 → HA 事件回程 → 网关结算 → 回写 hook。三条不妥协：

  1. 默认拒绝：超时 / 验签失败 / 通道不可达一律 deny。
  2. 一次性：按钮里那串 HMAC 签过的 action ID 用过即废。
  3. 审计留痕：每笔落 JSONL，含动作哈希 + 决策来源。

  **推送失败不等于只能拒掉。** hook 的判定恒为 deny（不赌权限模式），
  但 deny 不是终点 —— 确认会自动换一条路继续走，四步降级，都不必你离开工作流：

  | 步 | 手段 | 说明 |
  | --- | --- | --- |
  | ① | 本机一次性授权 | 你刚点过「允许这一次」时 `approval confirm` 落下的那张；在所有策略之前，不受任何开关影响 |
  | ② | **拦住 + 标记，由 Agent 用宿主原生确认框问你** | **默认策略** `ask_user`：reason 首行带 `[approval: action_required=ask_user]`，Agent 据此调 AskUserQuestion |
  | ③ | 转场网关自带的本地审批页（先探可达再开） | 显式 `APPROVAL_PUSH_FAIL_POLICY=local` |
  | ④ | 就停在 deny + 写 `blocked-last.json` | 以上都不成；`APPROVAL_PUSH_FAIL_POLICY=deny` 可跳过 ②③ 直接到这里 |

  ② 之所以是默认，是因为它把「用**原本的方式**询问」落在了 AskUserQuestion 上 ——
  那是宿主本来就有的原生确认框，不另造界面。
  为什么默认不是 `permissionDecision:"ask"`：ask 的效果**取决于权限模式**
  （需要审批的场景确实弹框，但沙箱快速路径上宿主本来就不问人，ask 变不出框、
  命令照跑）。deny 的行为不依赖模式，而「询问」由 ② 补上 —— 既不赌模式，也不丢询问。
  **L3 高危与 L2 走同一套降级，但永不自动放行、也不降级成放行**：④ 的落点始终是 deny。

# ── 关键能力 ──────────────────────────────────────────────────────────────
capabilities:
  - name: 风险分级 L0–L3
    detail: 内置 Bash / Write / Edit / MCP 等规则，可被 config 覆盖
  - name: HA WebSocket 回程
    detail: 网关主动连 HA 订阅 mobile_app_notification_action 事件；Mac 不需要端口映射
  - name: HMAC 签名 action 令牌
    detail: APR:<id>:<option>:<nonce>:<sig>，单次消费 + TTL + 绑定到具体动作
  - name: 设备可收性探测
    detail: 推送前先确认手机在不在 HA（不是 WebSocket 握手成功就以为能收到）
  - name: iOS 划走自动补推
    detail: 通知被划走时按 renotifySeconds 重推，标题带「第 N 次提醒」
  - name: 本机一次性授权（兜底第 ① 步）
    detail: 推送失败时，`approval confirm --yes` 落一张单次授权到本机；
            「记住你刚才那次答复」靠它，而「再问你一次」靠下面的 ask
  - name: 用宿主原本的方式询问（兜底第 ② 步，默认）
    detail: |
      **默认策略** `ask_user`。推送失败时 hook 仍然输出 deny，但 reason 第一行带
      `[approval: action_required=ask_user]` 标记 + 两步指令，Agent 的循环据此调
      **AskUserQuestion** —— 那是宿主本来就有的原生确认框（走 HandleInterruptions）。
      于是「问你」这件事由你已经在用的界面承担，不另造确认界面，也不赌权限模式。
      显式传 `--ask` 还能给它带上可选项文本（如「允许这一次 / 本会话内允许 / 拒绝」）。
  - name: 转场本地审批页（兜底第 ③ 步，可选）
    detail: |
      打开网关自带的 /phone.html（先探可达再开，401/404 一律不开废标签页），
      你在那一页点「仅此一次 / 本会话内允许」，决策经 /v1/decision 回到 hook。
      连续 3 次转场都没人点就熔断，不再反复弹。`APPROVAL_PUSH_FAIL_POLICY=local` 启用。
      这是四步里唯一能把决策**直接带回** hook 的兜底。
  - name: 纯拦截模式（兜底第 ④ 步）
    detail: |
      `APPROVAL_PUSH_FAIL_POLICY=deny`：不带标记、不给下一步，就停在 deny 并写
      `blocked-last.json`。想完全自己接管降级流程（自己读 blocked-last.json 决定）时用它。
  - name: 会话白名单
    detail: L2 的「本会话内允许」是真正的「本会话内允许」，不是字面意义上的同义反复
  - name: MCP 入口
    detail: Agent 可主动调 verify_approval / get_approval_audit / list_pending
  - name: 管理面板
    detail: |
      /admin.html（与 /phone.html 共用 phoneAccessKey），用浏览器查看历史推送与决策。
      数据接口：/v1/approvals /v1/audit /v1/audit/summary /v1/audit/trace/:id
      —— 全部支持按 tier / 时间窗 / 关键字过滤，对人和 AI 都一样。

# ── 谁不能用 ───────────────────────────────────────────────────────────────
not_for:
  - 不想装 HA 的人（HA 是推送通道，必须）
  - 只有 Android 的用户（HA 通道只测过 iOS）
  - 需要在 ARM Linux 服务器上跑（没测过；Node ≥ 20 应该可以但需自验证）

# ── 测试覆盖 ───────────────────────────────────────────────────────────────
tests:
  total_assertions: 498
  suites:
    - { name: selftest,         count: 92, what: "网关端到端" }
    - { name: hook,             count: 92, what: "hook 协议（真起子进程）" }
    - { name: risk,             count: 80, what: "风险分级回归" }
    - { name: local-grant,      count: 66, what: "本机一次性确认状态机" }
    - { name: ha-channel,       count: 59, what: "HA 通道往返" }
    - { name: device-readiness, count: 45, what: "设备可收性" }
    - { name: net-doctor,       count: 35, what: "地址漂移纯函数" }
    - { name: store-resilience, count: 29, what: "存储容错" }
    - { name: mcp-e2e,          count: 21, what: "MCP 入口往返（要活网关，不计入 498）" }

# ── 文档 ──────────────────────────────────────────────────────────────────
docs:
  - { path: README.md,         lang: en,  desc: "英文入口" }
  - { path: README.zh-CN.md,   lang: zh-CN, desc: "中文入口" }
  - { path: INSTALL.md,        lang: zh-CN, desc: "九步安装清单（每步有验收判据）" }
  - { path: SETUP.md,          lang: zh-CN, desc: "完整手册：原理、坑、代码证据" }

# ── 链接 ──────────────────────────────────────────────────────────────────
links:
  landing_page: https://watch-alert.coderknock.com/
  skill_page:   https://skillhub.cn/skills/indiv-coderknock/wrist-approval-gateway
  repository:   https://github.com/coder-knock/agent-watch-approval

# ── 关键词（中英） ─────────────────────────────────────────────────────────
keywords:
  en: [agent, approval, permission, hook, iphone, apple-watch, home-assistant, mcp, claude-code, wrist-approval, fail-closed, hmac]
  zh: [Agent, 确认, 推送, 权限, Apple Watch, iPhone, Home Assistant, 安全, 拦截, 签名]

# ── 安全模型 ───────────────────────────────────────────────────────────────
security:
  model: default-deny
  token_format: "APR:<id>:<option>:<nonce>:<sig>"
  token_ttl: "per-tier (L2/L3 default 120s; config.json: defaults.ttlSeconds)"
  audit: |
    每次决策落 data/audit.jsonl，含 binding（动作哈希）+ decidedBy + deviceName。
    所有「本机一次性授权」走 POST /v1/audit 上报一条 local_confirm_issued / _used / _rejected。
  threat_model:
    - 设备脱机 → readiness 探测返回 deviceOffline，调用方 fail-fast
    - 通道不可达 → 拦住，并走四步降级（见下）；判定恒为 deny，不依赖权限模式
    - 网关死掉 → 同上（不是「一律 deny」就完事，也不是「一律放行」）
    - 用户划走通知 → 按 renotifySeconds 自动补推，直到决策或 TTL 用完
    - 推送失败 → 四步降级：① 本机一次性授权 → ② 默认 ask_user（拦住 + 标记，
      由 Agent 用宿主原生确认框问你）→ ③ 可选 local 转场本地审批页 →
      ④ 停在 deny + 写 blocked-last.json。
      每一步都不放宽「没送到 = 没同意」：转场后没人点仍然 deny；
      无人值守时标记没人处理，命令就停在拦住。
    - 为什么默认不是 permissionDecision:"ask" → ask 的效果取决于权限模式
      （沙箱快速路径上宿主本来就不问人，它不阻止执行）；deny 不赌模式，
      「询问」交给 ② 的 AskUserQuestion 承担。完整的两层机制与代码出处见
      SETUP.md 的 2.1.4 与「历史证据」一节。

# ── 变更记录 ───────────────────────────────────────────────────────────────
changelog:
  - version: 0.4.0
    date: 2026-09-20
    notes: |
      把「ask 到底算什么」彻底定案，并据此重建降级链路。0.3.0 定的
      「默认 L2 → ask」方向对但仍不准确：反读 executePreToolUseHooks 后确认
      **ask 自己不拦**（调用方只判 deny / allow 两个分支），它的真实作用是被
      hasForcedAskDecision 读到 → 从而禁止自动放行、把决定交回宿主常规权限流程。
      于是「弹不弹框」取决于宿主原本会不会问你：需要审批的场景真弹
      （实测确认），沙箱快速路径上宿主本来就不问人，ask 变不出框、命令照跑。
      · 默认策略改为 **deny + ask_user**：判定恒为 deny（不赌权限模式），
        reason 第一行带 `[approval: action_required=ask_user]`，由 Agent 调
        **AskUserQuestion** —— 那是宿主**原本的询问方式**。
        「降级也是用原本的方式询问」由此落地。
      · 三条降级路径（网关非 2xx / 网关不可达 / 推送失败）统一到同一个策略解析
        （degradePolicyFor）与同一段 reason 措辞（degradeReasonLines），
        修掉「同一个原因、两种处置」的分裂。
      · 新增 `APPROVAL_PUSH_FAIL_POLICY` = `ask_user`(默认) / `deny` / `local` / `ask`；
        `APPROVAL_FALLBACK_L2|L3` 保留但默认 deny、仅显式设置才生效。
      · 修一个静默失效 bug：`degradePolicyFor` 曾把 `fallbackFor()` 的返回值
        当条件判断，而它恒为 deny/ask/allow 三者之一 → `ask_user` 默认值永远到不了。
      · reason 措辞改为一律跟着策略走（此前 policy=allow 时却写着「已拦住」，
        与真实判定相反，而 reason 是事后回溯的唯一线索）。
      · 测试覆盖 498 项断言（8 套）。
  - version: 0.3.0
    date: 2026-09-20
    notes: |
      修正一个**很贵的方向性错误**：此前认为「本构建的 WorkBuddy 不实现
      permissionDecision:"ask"，输出 ask 等于静默放行」，因此把 ask 强制降级成 deny。
      反读宿主实现（aggregateResults 的显式 ask 分支 / HandleInterruptions 注入
      原生确认框 / hasForcedAskDecision 阻止自动放行 / headless 走 denyForNonInteractive）
      证实：**ask 是一等取值**，既不会被当成「没有决定」，在无人值守时也仍落成 deny。
      ⚠️ 这一版据此把默认档位设成「L2 → ask」，方向对了但仍不准确 ——
      ask 自己不拦，它的真实作用是禁止自动放行。**最终结论见 0.4.0。**
      · 新增兜底第 ③ 步：转场网关自带的 /phone.html（先探可达再开，
        401/404 一律不开废标签页），并带 30s 最小间隔 + 3 次未答熔断。
        决策成功后熔断计数复位，reason 里区分「本机审批页确认」与「手机/手表确认」。
      · /v1/audit 白名单扩到 5 个事件：local_confirm_issued / _used / _rejected /
        local_handoff / handback_to_host。
      · mac-alert.mjs：本地提醒统一出口（quiet/normal/loud），**默认只发一条**，
        修掉此前连发 3 条的问题。
      · net-doctor 从「只写日志」升级为主动播报设备掉线/恢复（跳变才喊，
        持续掉线按 15 分钟再喊一次）。
      · store：rename EPERM 后只告警一次（此前 2 秒一次刷屏，实测 26 行里 26 行）；
        覆盖写失败改为独立计数，否则首次失败会被 rename 那次计数吞掉。
      · 网关端口冲突不再变成僵尸进程（认得出是自己就退出 0，否则诊断后退出 1）。
      · handoff-state.json 里的审批页 URL 抹掉口令（该文件是给人排查用的）。
  - version: 0.2.0
    date: 2026-09-20
    notes: |
      新增：
      · /admin.html + 配套过滤端点（/v1/approvals /v1/audit
        支持 tier / q / since / limit / offset；/v1/audit/summary、
        /v1/audit/trace/:id）。
      · AskUserQuestion fallback：APPROVAL_PUSH_FAIL_POLICY=ask_user
        在推送失败时把 reason 第一行改成可机器 grep 的标记，让写过
        AskUserQuestion 处理逻辑的 Agent 自己弹窗拿授权。
      · /v1/approvals 响应新增 deviceOffline / pushFailureReason 字段
        （device_offline / push_4xx / push_5xx / channel_error / unknown）。
      · src/core/store.queryApprovals() / queryAudit() / summarizeAudit() / auditTrailFor()
        给管理面板与未来的过滤式审计使用。
      测试覆盖 472 项断言（新增 33 项）。
  - version: 0.1.0
    date: 2026-09-20
    notes: |
      初次发布。
      核心能力：L0–L3 分级、HA WebSocket 回程、HMAC 一次性令牌、
      设备可收性探测、iOS 划走自动补推、本机一次性授权兜底、
      会话白名单、MCP 入口。
      测试覆盖 439 项断言。