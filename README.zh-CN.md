# agent-watch-approval（腕上确认网关）

> 把 Agent 运行中需要拍板的选项推到 iPhone / Apple Watch，腕上决策后回传给 Agent。L0/L1 静默放行。

Push L2/L3 tool calls to iPhone / Apple Watch — decide on the wrist, return the verdict to the Agent. L0/L1 silent-pass.

> [English version](./README.md) | 中文（本文）

---

## 这是什么

一个常驻本地的网关，夹在 Agent 和 Home Assistant 之间。每次工具调用会被分类到 L0–L3；L2/L3 会以一次性、签名过的卡片形式推到你的 iPhone（再通过 HA 伴侣 App 镜像到 Apple Watch）。你在手腕上点 Allow / Deny，决策回传到 Agent。

- **L0** 静默放行（只读路径）
- **L1** 仅留审计
- **L2** 推一张 time-sensitive 卡片
- **L3** 推一张 critical 卡片，并且**永远不会在会话内自动放行**

## 为什么这么设计

代码里从不破坏的三条铁律：

1. **默认拒绝。** 超时、验签失败、通道不可达 → `deny`。
2. **一次性。** action ID 里那串令牌用过即废，重放直接丢。
3. **审计留痕。** 每次决策都落 `audit.jsonl`，含动作哈希。

那个 HMAC 签名的 action 令牌（`APR:<id>:<option>:<nonce>:<sig>`）就是决策权限本身，网关不向设备泄漏任何长期密钥。WebSocket 回程意味着 Mac 不需要端口映射或公网回调。

## 腕上那条路断了怎么办

「默认拒绝」不等于「只剩一句拒绝」。hook 的判定恒为 `deny`（所以它不依赖宿主的权限模式），
但问题会继续往下走 —— 四步降级，都不必你离开工作流：

| 步 | 兜底手段 | 怎么走 |
| --- | --- | --- |
| ① | 本机一次性授权 | 你点过「允许这一次」后 `approval confirm` 落下的那张。在所有策略之前检查，不受任何开关影响。 |
| ② | **拦住 + 标记 → Agent 用宿主原本的确认框再问你** | **默认**（`ask_user`）：reason 首行是 `[approval: action_required=ask_user]`，Agent 据此调 `AskUserQuestion` —— 宿主本来就有的那个确认框。 |
| ③ | 转场到网关自带的本地审批页 | 显式开启：`APPROVAL_PUSH_FAIL_POLICY=local`。先探可达再开，不会留废标签页。 |
| ④ | 就停在拒绝 + 写 `blocked-last.json` | 以上都不适用时。 |

② 之所以是默认，是因为它把「用**原本的方式**询问」落在了宿主自己的确认框上，而不是另造一个。
为什么不用 `permissionDecision:"ask"`？因为 ask 的效果**取决于权限模式** —— 需要审批的路径上它确实会弹框，
但在沙箱快速路径上宿主本来就不问人，ask 变不出框、命令照跑。`deny` 不赌模式，「询问」由 ② 补上。

`APPROVAL_PUSH_FAIL_POLICY` 可选 `ask_user`（默认）/ `deny` / `local` / `ask`。

## 快速开始

```bash
# 1. 安装（前置条件只有 HA 和 iPhone 上的 HA App）
npm install
npm run doctor                # HA 可达？令牌有效？

# 2. 启动
npm start                     # mock 通道跑在 http://127.0.0.1:7788
                              # 浏览器打开它 —— 那就是你的 iPhone 模拟器

# 3. 准备上真机
#    装步骤看 INSTALL.md（一步一步），原理与坑看 SETUP.md（完整手册）
```

## 测试

```bash
npm run selftest                     # 92 项网关端到端
npm run test:hook                    # 92 项 hook 协议（真起子进程）
npm run test:risk                    # 80 项风险分级
node test/local-grant.test.mjs       # 66 项本机一次性确认状态机
npm run test:ha-channel              # 59 项 HA 通道往返
node test/device-readiness.test.mjs  # 45 项设备可收性
node test/net-doctor.test.mjs        # 35 项地址漂移检测
node test/store-resilience.test.mjs  # 29 项存储容错
# 合计：498 项通过（8 套）
# （node test/mcp-e2e.mjs 另外需要活网关）
```

## 链接

- 官网：<https://watch-alert.coderknock.com/>
- 技能页：<https://skillhub.cn/skills/indiv-coderknock/wrist-approval-gateway>
- 安装指南：[INSTALL.md](./INSTALL.md)
- 完整手册（原理与坑）：[SETUP.md](./SETUP.md)
- 官网源码：[promo/](./promo/)

## 目录结构

```
src/
  gateway.mjs              # HTTP 服务、决策装配
  core/
    bind.mjs               # action 令牌、HMAC、规范化 JSON
    risk.mjs               # L0–L3 分级
    store.mjs              # 待决 + 审计 + sweep
    local-grant.mjs        # 本机一次性授权（推送失败时的兜底）
  channels/
    ha.mjs                 # Home Assistant WebSocket + REST
    device-readiness.mjs   # 「这台手机现在到底能不能收」
    pushcut.mjs            # 备选：Pushcut 通道
    mock.mjs               # 进程内模拟器

bin/
  approve-hook.mjs         # Agent 宿主的 PreToolUse hook
  approval-confirm.mjs     # `approval confirm --yes` 命令行

mcp/approval-mcp.mjs       # MCP 服务，暴露 /v1/approvals
public/phone.html          # 浏览器充当 iPhone 模拟器
scripts/                   # 安装 / 修复 / 体检 / 地址漂移看门狗
test/                      # 8 套测试，498 项断言
```

## 许可证

MIT（或你选定的协议 —— 公开发布前请确认）。