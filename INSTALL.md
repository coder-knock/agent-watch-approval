# 逐步安装

从零把这套「腕上确认网关」装到能用。**按顺序做，每步都有验收判据 —— 上一节不过，不要往下走。**

原理、坑的成因、代码证据都在 `SETUP.md`（完整手册）。本文只回答
「**现在该敲什么、怎么知道成了**」，每步末尾给出该去 `SETUP.md` 哪一节看细节。

```
总览
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 ①  环境前提            node / python / 项目位置 / approval 入口     ~2 分钟
 ②  装 Home Assistant   本地 venv，裁掉无关集成                      ~15 分钟
 ③  让 HA 用「名字」对外  internal_url 钉 Bonjour 名（别钉 IP）        ~2 分钟
 ④  手机侧              同网段 + App + Watch App + 通知镜像   ★只有你能做
 ⑤  打通推送凭据        doctor 第 5 步；大陆走 websocket 绕法  ★只有你能做
 ⑥  拿两个值 + 验往返    令牌、服务名，先真机点一次                    ~5 分钟
 ⑦  切到 HA 通道        config.json → channel:"ha"                   ~1 分钟
 ⑧  接上 Agent          hook + 开机自启 + MCP                 ★自启要普通终端
 ⑨  验收                460 项测试 + 一条行为探针                     ~2 分钟
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

> **两条顺序铁律**，颠倒了会浪费时间：
> 1. **先验证真机往返（⑥），再切通道（⑦）。** 否则一旦没反应，你分不清是
>    「HA→手表这一跳断了」还是「网关有 bug」。
> 2. **先让网关开机自启（⑧），再开 hook。** 否则网关一没跑，所有 L2/L3 命令
>    都会被拒，而报错里不写原因。

---

## ① 环境前提

```bash
node -v                                    # 需要 ≥ 22
approval dir                               # 应该打印项目根目录
approval health                            # 网关没起会报「连不上」，此时是对的
```

| 项 | 本机取值 | 换机器时要改的地方 |
|---|---|---|
| 项目根 | `/path/to/agent-approval` | `~/.local/bin/approval` 里的 `DIR=` |
| node | `/opt/homebrew/bin/node` | `settings.json` / `mcp.json` 里的 `command` |
| `approval` 入口 | `~/.local/bin/approval` | 装到任意 PATH 目录，**注意用登录 shell 才在 PATH 里** |
| Python | `~/.workbuddy/binaries/python/versions/3.13.12/bin/python3` | 装 HA 用（②） |

**验收**：`approval dir` 打印出正确的绝对路径。

> 为什么所有操作都走 `approval` 这一个入口：项目内的脚本按「在项目目录下运行」
> 写相对路径，在家目录直接跑 `node scripts/xxx.mjs` 会报
> `Cannot find module '~/scripts/xxx.mjs'`。
> `approval` 内部全部用绝对路径。详见 `SETUP.md` §0.1。

---

## ② 装 Home Assistant

```bash
# 1) 建虚拟环境
~/.workbuddy/binaries/python/versions/3.13.12/bin/python3 -m venv ~/.ha-venv
~/.ha-venv/bin/pip install --upgrade pip
~/.ha-venv/bin/pip install homeassistant

# 2) 换 PyPI 镜像（官方源在本机不可达，105MB 的 frontend 包会卡到像死机）
mkdir -p ~/.config/uv && cat > ~/.config/uv/uv.toml <<'EOF'
index-url = "https://pypi.tuna.tsinghua.edu.cn/simple"
EOF

# 3) 若 ~/.homeassistant 有 2023 年的残留（root 属主日志会让启动直接死）
cd ~/.homeassistant && mkdir -p logs-2023-backup && \
  mv home-assistant.log* logs-2023-backup/ 2>/dev/null
```

然后写 `~/.homeassistant/configuration.yaml`，**只列这条链路真正需要的集成**：

```yaml
homeassistant:
  name: Agent Approval
  time_zone: Asia/Shanghai      # 不设的话手表卡片时间差 8 小时
  internal_url: "http://<your-mac>.local:8123"   # ★ 见第 ③ 步
frontend:
onboarding:
mobile_app:                     # ★ 推送投递与通知按钮全靠它
zeroconf:                       # ★ 手机「搜索服务器」靠它，别砍
http:
webhook:
websocket_api:
intent:
person:
tag:
recorder:
history:
logbook:
sun:
automation: !include automations.yaml
script: !include scripts.yaml
scene: !include scenes.yaml
```

**不要写 `default_config`。** 它会一口气拉起 20 个集成，其中 ffmpeg / tts /
cloud 等跟推送毫无关系，任一装不上就级联失败 —— 而 `mobile_app` 挂在它底下，
会被一起拖死，表现就是**推送根本发不出去**。实测的级联日志长这样：

```
Setup failed for 'ffmpeg' → 'tts' → 'assist_pipeline' → 'cloud' → 'mobile_app'
```

启动后完成网页引导向导（`http://localhost:8123`），建管理员账号。

**验收**：`curl -s -o /dev/null -w '%{http_code}' http://localhost:8123` → `200`。

> 裁剪时唯一不能砍的例外是 `zeroconf`：砍掉后 HA 网页正常、监听正常、
> 局域网自连 200，**只有手机搜不到服务器**（判据是 `_home-assistant._tcp` 广播不存在）。
> 详见 `SETUP.md` §1.1 → §1.1.2。

---

## ③ 让 HA 用「名字」对外，而不是 IP

```bash
# 本机的 Bonjour 名（写进上面 configuration.yaml 的 internal_url）
scutil --get LocalHostName
```

**为什么必须钉名字**：HA 的 mDNS 广播**只在启动那一刻注册一次**，
代码里没有任何网络变化监听。所以 HA 跑起来之后 IP 一变，广播里就是旧地址、
不重启不会自愈，而手机拿着旧地址连不上 → 本地推送建不起来 →
**每次 `notify.mobile_app_*` 都返回 500**。钉 Bonjour 名字后，手机每次连接前
重新解析，**IP 随便变都能跟上，连 HA 都不用重启**。

**验收**：`approval mdns` 列出的 `internal_url` 是
`http://<名字>.local:8123`，**不是** `http://192.168.x.x:8123`。

> 完整症状链、两层修法（钉名字 + 地址漂移看门狗）见 `SETUP.md` §1.2.1。

---

## ④ 手机侧 ★ 只有你能做

1. **iPhone 与 Mac 连同一个网段** —— 别连访客网络。
   ⚠️ **mDNS 不跨网段**：「Mac 接有线、手机连另一个路由器」是最常见的翻车原因。
2. App Store 装 **Home Assistant**，登录你刚建的服务器。
   搜不到就直接手填 `http://<LocalHostName>.local:8123`（填**名字**不填 IP）。
3. **Apple Watch 上也要装 HA 的 Watch App。** Apple 官方要求：
   *Apple Watch Actions on watchOS require the Watch App to be installed.*
   不装 Watch App，手表上**不会出现动作按钮**，只能看到通知。
4. iPhone 的「Watch」App → 通知 → Home Assistant → 选 **Mirror my iPhone**。

> ⚠️ **通知只在 iPhone 锁屏 / 息屏时才镜像到手表。** 手机屏幕亮着且你正在用它，
> 通知只留在手机上。所以「手机收到了、手表不响」的第一嫌疑不是链路，
> 而是**按一下侧边键让屏幕黑掉，别碰手机，再推一次**。

**验收**：`approval net` 的第 9 项说手机 App **在线**（不是「没在连」）。

---

## ⑤ 打通推送凭据 ★ 只有你能做

**手机连上了 ≠ 能推送。** 设备注册（webhook + 实体）和推送能力
（`app_data` 里的凭据）是**两件独立的事**：设备条目、传感器全都齐全，
`notify.mobile_app_*` 服务却可能**根本不存在**。

```bash
approval doctor      # 看第 5 步「手机推送能力」
```

### 情况 A：第 5 步已经是 ✅

跳过本节，直接去 ⑥。

### 情况 B：服务不存在 —— 先试标准路（有代理 / 能连 Google 的环境）

按顺序在 iPhone 上做：

1. 系统设置 → 通知 → Home Assistant → **允许通知**
2. App → 设置 → **通知设置** → 点最上面「**权限**」那一行，显示「已启用」才对
3. App → 设置 → **调试** → 看「**推送ID**」是否写着「未注册远程通知」
   （调试入口可能要**摇一摇手机**才出现）
4. **上滑杀掉 App 再重开**，让它重新注册
5. 回来 `approval doctor` 看第 5 步是否转 ✅

> ⚠️ 中文界面里**没有「伴侣应用」这个入口**。一级入口实际是：服务器 / 常规设置 /
> **通知设置** / 定位设置 / 动作 / 隐私 / Apple Watch / Thread / 调试。
> 官方文档那句 "Settings → Companion App" 是英文旧版叫法。

### 情况 C：中国大陆（FCM 不可达）—— 用 websocket 标记绕开

实测本机直连 Google 的结果：

| 目标 | 结果 |
|---|---|
| `firebaseinstallations.googleapis.com` | **000（8s 超时）** |
| `fcmregistrations.googleapis.com` | **000（8s 超时）** |
| `apple.com`（对照） | 200（0.11s） |

App 拿不到 FCM token → `pushID` 恒为 nil → `app_data` 恒为 `{}` →
**`notify.mobile_app_*` 永远不会注册**，权限全开也没用。

```bash
# 1) 备份
cp ~/.homeassistant/.storage/core.config_entries{,.bak-$(date +%Y%m%d-%H%M%S)}
# 2) 停 HA，把 "app_data":{} 改成 "app_data":{"push_websocket_channel":true}
#    ⚠️ .storage 里是紧凑 JSON —— 冒号后面没有空格，别按格式化后的样子去匹配
# 3) 重启 HA： approval ha restart
```

`push_websocket_channel` 只是 `supports_push()` 用来「不要跳过这台设备」的标记，
**真正投递走的是运行时建立的 WebSocket 通道**，全程不碰 Google。

**这个绕法的代价，务必知道：**

- 只在**在家 + App 在运行**时才可能送达（本地推送依赖内网 URL 与活跃 WebSocket），
  蜂窝网下收不到
- 不是官方支持的路径。将来 App 若真拿到 pushID，会用它真实的 `app_data` 覆盖这个注入值
- 要彻底解决只有两条路：给 iPhone 挂代理让 FCM 通（令牌轮换，不现实），
  或换一条不依赖 Google 的通道（仓库里 `src/channels/pushcut.mjs` 是现成备选）

**验收**：`approval doctor` 第 5 步 ✅，且下面这条能列出你的设备：

```bash
approval link --token <还没创建？先去 ⑥ 创建>
```

> 完整分析（iOS App 源码里 `app_data` 怎么来的、`supports_push()` 的判定）见
> `SETUP.md` §1.3.1 → §1.3.2。

---

## ⑥ 拿两个值 + 先验往返

| 值 | 在哪拿 |
|---|---|
| **长期访问令牌** | HA 网页 → 左下角你的用户名 → 安全 → 长期访问令牌 → 创建 |
| **通知服务名** | 开发者工具 → 操作 → 搜 `notify.mobile_app`，**去掉前缀 `notify.`** 就是要填的值 |

服务名是**算出来的**，不是随便起的：`slugify("mobile_app_" + 设备名)`。
例：设备名 `<Your iPhone>` → `notify.mobile_app_your_iphone`
（`的` 被转写成 `de`，所以是 `your_de_iphone` 而不是 `your_iphone`）。
**改设备名会让服务名跟着变**，`config.json` 要同步改。

```bash
# 完整往返：HA → iPhone/手表 → 你点按钮 → 回传（把手表放身边）
approval link --token <刚才创建的令牌>
```

它会依次做五件事，**断在哪一步直接告诉你**：校验令牌 → 列出所有
`notify.mobile_app_*` 服务 → 建 WebSocket 订阅 →
发一张带两个按钮的测试卡片 → **等你在手表上点它**。

**验收**：`link` 打印出回传耗时和 HA 原样字段名。

> 你会看到事件里**只有一个 `action`**，这是正常的，不是漏字段 ——
> `mobile_app_notification_action` 里本来就没有设备信息（设备信息在另一个
> 旧事件 `ios.notification_action_fired` 上）。
> **别**顺手把那个旧事件也加进订阅：一次点击会变成两条事件，
> 第二条必然撞上一次性令牌的重放保护（HTTP 409）。
> 详见 `SETUP.md` §1.5。

---

## ⑦ 切到 HA 通道

编辑 `config.json` —— 只需改 `channel` 和 `token` 两处：

```json
{
  "channel": "ha",
  "channels": {
    "ha": {
      "baseUrl": "http://localhost:8123",
      "token": "⑥ 里创建的长期访问令牌",
      "notifyService": "mobile_app_your_iphone",
      "timeSensitiveFromTier": "L2",
      "criticalFromTier": "L3",
      "clearAfterDecision": true,
      "publicBaseUrl": "",
      "phoneAccessKey": ""
    }
  }
}
```

```bash
approval gw restart        # 或 approval gw 前台起一个看日志
approval health            # 看 channelReady
```

**验收**：`/healthz` 里 `channelReady: true`（WebSocket 已连上 HA）。

> `channelReady` 和 `deviceReady` 是**两个**东西，别混：
> 前者是「网关 ↔ HA 握手成功」，后者是「那台手机在不在 HA 上」。
> 两者可以一真一假 —— 实测就是这么翻车的（`channelReady: true` 而每条推送都 500）。
>
> ⚠️ `timeSensitiveFromTier` / `criticalFromTier` 是「吵醒你」的两个旋钮：
> `time-sensitive` 穿透专注模式但**不**绕过静音；`critical` **绕过静音**。
> 关掉 critical 就把 `criticalFromTier` 设成 `null`。详见 `SETUP.md` §1.6.1。

---

## ⑧ 接上 Agent ★ 自启那步要普通终端

### 8.1 让网关/ HA 开机自启（**必须在普通终端里跑**）

Agent 会话跑在 macOS 沙箱里，`launchctl` 装载作业会被拒绝
（报 `Bootstrap failed: 5: Input/output error`，用最小作业试也一样，可以排除 plist 写错）。

```bash
approval autostart      # 一次装好 HA + 网关两个 LaunchAgent
# 或者分开：approval ha install / approval gw install

approval netwatch install   # 顺带装地址漂移看门狗（每 120 秒自检，只在漂移时才动 HA）
```

**验收**：`approval gw status` 同时报「网关在跑 + HA 在跑 + 通道就绪」——**缺一不可**。
另外 `approval netwatch status` 应显示看门狗已装载。

> 看门狗是可选的兜底，但建议装：③ 的 Bonjour 名字管「按名寻址」，
> 它管「服务发现」—— mDNS 广播只在 HA 启动时注册一次，IP 变了就停在旧地址。
> 两层分工不同，不是重复劳动。

> `launchctl list` 显示「无」是正常的：它只列**已装载的 LaunchAgent**，
> 临时进程不在里面。要看真实状态用 `approval gw status`。
>
> 另一个坑：若 7788 已被临时网关占着，launchd 拉起的那个会因 `EADDRINUSE`
> 反复退出 —— 表现为「装好了但一直起不来」。`install` 会先清掉占用者。

### 8.2 hook：拦截危险工具调用

在 `~/.workbuddy/settings.json` 里加：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Edit|Write|MultiEdit|NotebookEdit|WebFetch|mcp__.*",
        "hooks": [
          {
            "type": "command",
            "command": "/opt/homebrew/bin/node /path/to/agent-approval/bin/approve-hook.mjs",
            "timeout": 180
          }
        ]
      }
    ]
  }
}
```

三个**不能改错**的点：

1. **只注册 `PreToolUse`。** 事件一共 9 个，里面**没有 `PermissionRequest`** ——
   照 Claude Code 的 schema 猜事件名会写出永不触发的死配置。
2. **`timeout` 必须显式写，且大于 `BUDGET`（默认 150s）。** 默认超时只有 **60 秒**，
   写小了宿主会在 hook 拿到结论前把它杀掉，现象是「任务卡死两分钟后失败」。
3. **`matcher` 里刻意不含 `Read|Glob|Grep`** —— 它们恒为 L0，
   而 hook 是**每个匹配到的工具调用都起一个进程**，拦它们只是白付启动开销。

**验收**（造一个「只有 hook 生效才会出现的结果」，别翻日志找间接证据）：

```bash
approval tier      # 列出「判为 L2/L3 但执行效果为零」的安全探针
```

挑首选那条跑一下 → 手机/手表应该收到卡片。

> ⚠️ **`ask` 不是这里的一个可选项。** 在这个构建的 WorkBuddy 里输出 `ask`
> **等于放行**，所以 `fallbackFor()` 会把它降级成 `deny` 并打一条 stderr 警告。
> 想「弹个框问一下」，见 `SETUP.md` §2.1.3 的 `approval confirm`。
>
> ⚠️ **第一次开 hook，保持默认，不要设 `APPROVAL_FALLBACK_*`。** 默认 `deny` 的
> 意思是「确认没送到你手上 = 不放行」。网关没跑时你会被拒，正确做法是
> 8.1 让网关自启，**不是**把失败路径改成放行。

### 8.3 MCP：让 Agent 主动问人（可选但推荐）

往 `~/.workbuddy/mcp.json` 加（**别覆盖已有的服务**）：

```json
{
  "approval": {
    "type": "stdio",
    "command": "/opt/homebrew/bin/node",
    "args": ["/path/to/agent-approval/mcp/approval-mcp.mjs"],
    "env": { "APPROVAL_GATEWAY_URL": "http://127.0.0.1:7788" }
  }
}
```

暴露 5 个工具：`request_approval`、`list_pending_approvals`、`cancel_approval`、
`verify_approval`、`get_approval_audit`。

**还需要你手动做一步**：MCP 配置不会自动生效 —— 到连接器管理页右上角的
**「自定义连接器」**入口，对 `approval` 这条点**「信任」**。

### 8.4 任务完成时也推一条（**默认不开**）

在 `settings.json` 加一个 `Stop` hook。`Stop` **不支持 `matcher`**，直接省掉该字段：

```json
"Stop": [
  { "hooks": [ { "type": "command",
    "command": "/opt/homebrew/bin/node /path/to/agent-approval/bin/approve-hook.mjs --notify Agent 已完成" } ] }
]
```

`--notify` 那条路**发完就走、不等确认**，所以不用像 8.2 那样放大 `timeout`。
每次回答结束都推一条，头几天多半嫌吵 —— 想要再加。

---

## ⑨ 验收

```bash
approval test        # 九套，共 460 项
```

| 套件 | 项数 | 说明 |
|---|---|---|
| 风险分级 | 80 | 纯本地 |
| HA 通道 | 30 | 纯本地（假 fetch） |
| hook 协议 | 61 | 真起子进程喂 stdin |
| 本机一次性确认 | 66 | 纯本地（临时目录） |
| net-doctor | 28 | 纯本地 |
| 设备可收性 | 45 | 纯本地 |
| 存储容错 | 26 | 纯本地 |
| 网关自检 | 82 | 临时 mock 配置 |
| MCP 往返 | 21 | **需要活的网关** |

**退出码约定**：`0` = 通过，`1` = 真的失败，`2` = 按设计跳过。
第九套要活的网关；网关没起、或网关在 `ha` 通道又没给 `--with-push` 时，
它会打印 `⏭ 按设计跳过（不算失败）` 且**不影响退出码** —— 前八套纯本地，应该永远是绿的。

想连第九套也真跑（**会真推一张卡片到你手机**）：

```bash
approval test --with-push
```

最后做一次真实闭环验收：

```bash
approval net                 # 链路体检 9 项，应该 9 项全 ✅
approval tier                # 挑一条安全探针
# 跑那条探针 → 手表收到卡片 → 点「允许」 → 命令被执行
approval audit 5             # 应能看到 decidedBy:"ha" 的记录
```

---

## 附录 A：只有你能做的步骤（沙箱做不了）

| 步骤 | 为什么 |
|---|---|
| ④ ⑤ 手机侧全部 | 需要物理接触 iPhone / Apple Watch |
| ⑧ 8.1 `approval autostart` | `launchctl` 需要访问 `com.apple.xpc.launchd`，沙箱拒绝 |
| ⑧ 8.3 点「信任」 | MCP 连接器授权只能由人在界面上点 |
| ③④ 手机与 Mac 同网段 | 网络切换只有你能操作 |

---

## 附录 B：卡住了看哪一节

| 症状 | 去哪 |
|---|---|
| 推送全 500，`channelReady: true` | `approval net` 看第 9 项；`SETUP.md` §1.2.2 |
| 推送曾经好好的、某天开始全 500 | `SETUP.md` §1.2.1（地址漂移） |
| **推送忽好忽坏 / HA 与手机连接「不稳定」** | 先查 `logs/net-watch.log`：若里面反复出现「检测到漂移：广播=X 本机=X」（**两边一样**），就是看门狗误触发，HA 每 120 秒被重启一次、每次掐断手机的推送通道。判据已收紧（只看广播），见 `SETUP.md` §1.2.1 |
| HA 每隔 2~3 分钟自己重启一次 | 同上。`tail -f ~/.homeassistant/home-assistant.log` 里每条 `aiohttp_fast_zlib` WARNING 就是一次启动，间隔精确到秒即是被看门狗踢的 |
| 手机搜不到服务器 | `SETUP.md` §1.1.2（`zeroconf` 被砍了？） |
| 手表上按钮不出现 | `SETUP.md` §1.3（Watch App 没装？） |
| **手机收到通知了，但通知上没有按钮可点** | **不是故障**：iOS 必须**展开**通知才显示按钮（锁屏上从右往左滑再点「查看」，或长按；不在锁屏时把通知下拉），而 Apple 不给任何视觉线索；**手表反而是直接显示的** —— 所以「手表好用」不代表手机也好用。想让「点一下」就能操作，配 `publicBaseUrl`，见 `SETUP.md` §1.6.2 |
| 审计里一堆「超时未确认」，可你根本没收到通知 | 看那条的 `reason` / `source`：`cancelled` + `source=push-failed` 才是「压根没送到」（去查 `approval net` 第 9 项），`expired` + `source=timeout` 才是「送到了、没人点」。两者处置完全不同 |
| 手机收到了、手表不响 | 屏幕亮着时通知不镜像，按侧边键黑屏再试 |
| `notify.mobile_app_*` 服务不存在 | `SETUP.md` §1.3.1 → §1.3.2 |
| 某个任务不触发，其他正常 | `SETUP.md` §2.1.2（旧会话拿的是启动快照） |
| 提示 `KeyError: 'push_token'` | `SETUP.md` §1.3.2 |
| 任务卡死两分钟后失败 | `SETUP.md` §2.1（hook `timeout` < `BUDGET`） |
| 网关莫名自己没了 | `SETUP.md` §2.1.1 + 硬事实 17 |
| 所有命令突然全被拒 | 网关没在跑 → `approval gw status` |
| `curl localhost:8123` 返回 502，但 `approval ha status` 全绿 | **不是 HA 的问题**：沙箱注入的 `HTTP_PROXY` 把 localhost 请求也拦了。加 `--noproxy '*'` 再测（立刻 200），或者干脆别用 curl 测 |
| hook 报 `fetch failed`，像网关连不上 HA | 同上：**网关是 node 进程，不读 `HTTP_PROXY`**，回环一直通。看 `approval net` 里「✅ 网关走本机回环访问 HA」；真因通常是手机没在连（notify 返回 500） |
| 推送失败被拦住，想放行这一次 | `SETUP.md` §2.1.3（`approval confirm`） |
| 不知道某条命令会不会打扰我 | `approval tier "<命令>"` |

> 判 HA 死活的唯一权威：`approval ha status` + `approval net`。
> **502 与 `fetch failed` 都不是判据。**（`ha status` 偶尔报一条
> `aiohttp.server Error handling request from ::1` 的 ERROR，多半就是被代理拦掉的那次探针留下的。）

---

## 附录 C：卸载 / 回退

```bash
# 回退到「不推送、不拦截」的安全状态
approval gw uninstall        # 网关取消开机自启
approval ha uninstall        # HA 取消开机自启
# 把 config.json 的 channel 改回 "mock"
# 把 settings.json 里的 hooks 段删掉（或走 /hooks 审查）
```

`data/` 里是密钥与审计（`secret` / `audit.jsonl` / `local-grants.json`），
**删掉等于放弃历史留痕**。`logs/` 可以随便删。
