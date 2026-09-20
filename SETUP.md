# Agent 确认推送 · 部署说明

把 Agent 运行中需要拍板的选项推到 iPhone / Apple Watch，用户在手腕上选择后回传给 Agent。

已通过 460 项自检（`approval test`：80 项分级 + 44 项 HA 通道单元 + 61 项 hook 协议
+ 66 项「本机一次性确认」状态机 + 35 项 net-doctor 纯函数 + 45 项设备可收性
+ 26 项存储容错 + 82 项端到端 + 21 项 MCP），
涵盖风险分级、令牌签发、重放拦截、签名篡改、超时兜底、hook 放行与拒绝、审计留痕、
会话白名单的作用域与撤销、HA 通道的请求形状
（`/api/services/<域>/<服务>` 那条 404 坑）、局域网地址漂移的判定
（主机名大小写、注释不当配置、网段比对、重启判据）、
「手机到底能不能收到」（存活传感器判据与它的两个禁区）、
「推送失败时的一次性放行」（签发 / 单次消费 / 绑定一致 / TTL / 签名 / 写盘容错），
以及「坏路径不许把网关进程带走」（持久化 / 审计 / 定时器的容错）。

> **只想照着装一遍？看 [`INSTALL.md`](INSTALL.md)。**
> 它把九步安装压成一份「敲什么 + 怎么知道成了」的清单（每步带验收判据，
> 并标出哪几步只有人能在普通终端或手机上做），遇到问题再回本文查原理。
> 本文（`SETUP.md`）是**完整手册**：原理、代码证据、每一处踩过的坑。

---

## 0. 先跑起来看看（不需要任何手机配置）

```bash
approval gw                   # 起网关，默认 127.0.0.1:7788，通道 mock
```

浏览器打开 <http://127.0.0.1:7788/> —— 那个页面扮演你的 iPhone，
拿到的就是推送里同一串一次性令牌，所以每一次点击都走完整的
验签 + nonce + 动作哈希校验链路。点「造一条测试确认」即可看到全过程。

### 0.1 统一入口：`approval`

本文档里所有操作都通过 `approval` 这一个命令完成，它装在
`~/.local/bin/approval`（已加入 PATH，任何目录都能直接调）。

| 命令 | 作用 |
|---|---|
| `approval doctor` | 环境体检：HA 可达性 / 日志 / 局域网发现 / 手机推送能力 / 网关配置 |
| `approval mdns` | 单独看局域网上能否发现这台 HA |
| `approval net` | **推送链路体检（9 项）**：地址漂移 + **手机上的 HA App 在不在线**（换过网/VPN 后先跑这个，见 1.2.1） |
| `approval net --repair` | 发现漂移就重启 HA 让它按当前地址重新广播 |
| `approval netwatch install` | 装上地址漂移看门狗（每 120 秒自检，坏了自动修；**必须在普通终端里跑**） |
| `approval link` | 真机往返测试：HA → iPhone/手表 → 点按钮 → 回传（第 1.5 节） |
| `approval test` | 跑八套测试（80 项分级 + 44 项 HA 通道 + 61 项 hook + 66 项本机一次性确认 + 35 项 net-doctor + 45 项设备可收性 + 26 项存储容错 + 82 项网关自检 + 21 项 MCP 往返）。前八套纯本地必跑；第九套要活的网关，跑不了会标「按设计跳过」而不是判失败（见 2.2） |
| `approval test --with-push` | 同上，但允许 MCP 那套**真推一张卡片到手机**（网关是 `ha` 通道时才会问，见 1.6.1） |
| `approval ha status` | HA 运行状态 + 日志 ERROR 数 |
| `approval ha install` | 设成开机自启（**必须在普通终端里跑**，见 1.1.3） |
| `approval ha restart` / `logs` | 重启 HA / 实时跟日志 |
| `approval gw status` | 网关服务状态（含 HA 连通性、待确认数、错误日志尾部） |
| `approval gw install` | 网关设成开机自启（**必须在普通终端里跑**，见 1.1.4） |
| `approval gw restart` / `logs` / `plist` | 重启网关服务 / 跟日志 / 只生成校验 plist 不装载 |
| `approval autostart` | 一次把 HA + 网关都设成开机自启（**必须在普通终端里跑**） |
| `approval tier [命令…]` | 问「这条命令会被判成几级、要不要推送」；不带参数则列出内置安全探针（见 1.7） |
| `approval health` | 网关健康 |
| `approval sessions` | 看/撤「本会话内允许」白名单（见 4.1） |
| `approval pending` / `audit` | 当前待确认列表 / 确认审计日志 |
| `approval phone` | 手机模拟器地址 |
| `approval gw` | 前台起网关 |
| `approval dir` | 打印项目目录绝对路径 |

**为什么要有它**：项目里的脚本原本都按「在项目目录下运行」写相对路径，
一旦在家目录里直接跑 `node scripts/verify-ha.mjs doctor`，就会报

```
Error: Cannot find module '~/scripts/verify-ha.mjs'
```

因为 node 是按**当前工作目录**解析相对路径的，而家目录下没有 `scripts/` 这个目录。
`approval` 内部全部调用了绝对路径，所以不存在这个问题。下文若出现
`node scripts/...` 的等价写法，都只是备查。

---

## 1. 手机侧准备（只有你能做）

### 1.1 在 Mac 上装 Home Assistant（已完成，此处备查）

HA 已经装好并在 `http://localhost:8123` 运行：

| 项 | 值 |
|---|---|
| 版本 | 2026.2.3 |
| 虚拟环境 | `~/.ha-venv` |
| 配置目录 | `~/.homeassistant` |
| 监听 | `*:8123` —— 局域网内手机可直接访问，不需要端口映射 |
| 局域网地址 | `http://192.168.x.x:8123`（en0） |
| mDNS 广播 | `_home-assistant._tcp.local.`，名字是「Agent Approval」 |
| 引导向导 | **已全部完成**，管理员账号 `admin` 已创建 |
| 开机自启 | plist 已就绪，装载方法见 1.1.3 |
| 当前日志 | ERROR 0，WARNING 1（`zlib_ng` 性能提示，无害） |

从零重装的话，`~/.homeassistant` 里那份 2023 年的残留配置可以复用。安装命令：

```bash
~/.workbuddy/binaries/python/versions/3.13.12/bin/python3 \
  -m venv ~/.ha-venv
~/.ha-venv/bin/pip install --upgrade pip
~/.ha-venv/bin/pip install homeassistant
```

装的时候踩到三个坑，换机器会再遇到，记在这里：

**坑 1 · 日志文件属主。** 2023 年那次 HA 是以 root 跑的，留下一个 root 属主的
`home-assistant.log`，于是启动直接死在
`PermissionError: [Errno 13] Permission denied`。修法是把这些文件 **move** 走 ——
move 只需要目录的写权限，不需要文件的属主权限，所以普通用户也能挪：

```bash
cd ~/.homeassistant && mkdir -p logs-2023-backup && \
  mv home-assistant.log* logs-2023-backup/ 2>/dev/null
```

**坑 2 · 官方 PyPI 在本机不可达。** 会让所有依赖安装慢到像卡死 ——
105 MB 的 `home-assistant-frontend` 包，5 分钟只下了 5 MB。统一改走清华镜像：

```bash
mkdir -p ~/.config/uv && cat > ~/.config/uv/uv.toml <<'EOF'
index-url = "https://pypi.tuna.tsinghua.edu.cn/simple"
EOF
```

HA 运行时会自己调 `uv pip install` 补依赖，`~/.ha-venv/pip.conf` 和 LaunchAgent
里的 `UV_INDEX_URL` 也都指向了同一个镜像，三处都改才不会漏。

**坑 3 · 不要用 `default_config`。** 见下。

#### 1.1.1 为什么 `configuration.yaml` 里没有 `default_config`

`default_config` 一口气拉起 20 个集成，其中 bluetooth / usb / dhcp / ssdp /
zeroconf / stream / go2rtc / energy / media_source / my / cloud /
assist_pipeline 这些跟「推送通知」毫无关系。它们的依赖只要有一个装不上，
整棵依赖树就级联失败，而 `mobile_app` 挂在 `default_config` 底下会被一起拖死 ——
结果就是推送根本发不出去。实测日志就是这么炸的：

```
Setup failed for 'ffmpeg'            ← ha-ffmpeg 缺失
Setup failed for 'tts'               ← 因为 ffmpeg 挂了
Setup failed for 'assist_pipeline'   ← 因为 tts 挂了
Setup failed for 'cloud'             ← 因为 assist_pipeline 挂了
Setup failed for 'mobile_app'        ← 因为 cloud 挂了
```

关键事实：**`mobile_app` 的真实依赖里没有 `cloud`**。它只依赖
`http / intent / person / tag / webhook / websocket_api`，另外需要一个 `PyNaCl` 包。
它是被 `default_config` 硬捆在一起才陪葬的。

所以现在 `configuration.yaml` 只列这条链路真正需要的集成。结果是**零缺失依赖
启动、日志零 ERROR**：

```yaml
homeassistant:
  name: Agent Approval
  time_zone: Asia/Shanghai      # 不设的话手表上卡片的时间会差 8 小时
frontend:                       # Web UI
onboarding:                     # 首次运行引导向导
mobile_app:                     # ★ 推送投递与通知按钮全靠它
zeroconf:                       # ★ 局域网发现，手机「搜索服务器」靠它
http:
webhook:
websocket_api:
intent:
person:
tag:
recorder:                       # 留一份本地历史，方便在 UI 里回看
history:
logbook:
sun:
automation: !include automations.yaml
script: !include scripts.yaml
scene: !include scenes.yaml
```

#### 1.1.2 裁剪时唯一不能砍的例外：`zeroconf`

上面那张清单是「按需裁剪」的结果，但**裁剪踩过一次坑，必须记住这个例外**。

砍掉 `zeroconf` 之后，HA 在网页里、在本机、在日志里全都完全正常 ——
**只有手机搜不到服务器**。因为 `zeroconf` 负责把 HA 自己以
`_home-assistant._tcp.local.` 的 mDNS 服务广播到局域网，而 iPhone 上 HA App
首次添加服务器时「正在搜索」列表里的条目，找的正是这条广播。

实测症状与判据：

| 检查项 | 砍掉 zeroconf 时 | 说明 |
|---|---|---|
| 网页 `localhost:8123` | 正常 | 所以很容易误判成「HA 没问题」 |
| `lsof -iTCP:8123 -sTCP:LISTEN` | `*:8123` 正常 | 监听在通配地址，局域网确实可达 |
| 从局域网 IP 自连 | HTTP 200 正常 | 说明不是网络/防火墙问题 |
| 手机 App「搜索服务器」 | **空** | 唯一的异常信号 |
| `_home-assistant._tcp` 广播 | **不存在** | 根因 |

它的依赖 `network`（需要 `ifaddr` 包）会被 manifest 自动解析，不用额外装东西。

**不用自动发现也能连上**：在手机 App 里手动填局域网地址即可，
`ipconfig getifaddr en0` 查到的地址，例如 `http://192.168.x.x:8123`。
把发现修好只是为了那个「正在搜索」列表能直接列出来。

复核命令：

```bash
approval mdns          # 应该列出 地址/端口/internal_url
approval doctor        # 第 4 步会同时做静态与动态检查
```

> 想恢复完整 HA 功能，把那堆集成换回一行 `default_config:` 即可，但得先把
> bleak / habluetooth / bluetooth-adapters / ha-ffmpeg / pymicro-vad / mutagen
> 等十几个包按 HA 要求的版本装齐 —— 注意 HA 要求的 bleak 是 2.1.1，而
> `~/.ha-venv` 里现在是 3.0.2，它会想降级。
> 备份在 `configuration.yaml.bak-2023`、`configuration.yaml.bak-20260919-000642`
> 和 `configuration.yaml.bak-20260919-0021xx`。

#### 1.1.3 开机自启

LaunchAgent 已写好在 `~/Library/LaunchAgents/cn.local.homeassistant.plist`
（`plutil -lint` 通过，`RunAtLoad` + `KeepAlive`）。

装载这一步**只能由你在自己的终端里做**：Agent 会话跑在 macOS 沙箱里，
而 `launchctl` 装载作业需要访问 `com.apple.xpc.launchd` 这个 mach 服务，
沙箱会拒绝 —— 表现为 `Bootstrap failed: 5: Input/output error`。
用 `/bin/echo` 做一个最小作业去试也是同样的错，所以可以排除是 plist 写错。

```bash
approval ha install     # 装载并启动（会先清掉临时实例）
approval ha status      # 随时看状态 + 日志 ERROR 数
approval ha restart     # 重启
approval ha logs        # 实时跟日志
approval ha uninstall   # 卸掉开机自启
```

### 1.2 iPhone 能连到 HA —— 这一步最容易卡住

本机的现状（2026-09-19 复测）：HA 监听 `*:8123`、macOS 防火墙关闭、
从局域网地址自连返回 200。**HA 对外公布的身份现在是一个 Bonjour 名字**
`http://<your-mac>.local:8123`，不再钉某个具体 IP —— 原因见 1.2.1。

所以手机连不上时，问题几乎一定在「发现」或「手机侧」，不在 HA 本身：

1. **先确认发现是通的**：`approval mdns`
   应该列出**本机当前地址**:8123。没有的话看 1.1.2。
2. **手机和 Mac 在同一个网段**（别连访客网络：访客网络常禁用组播、还隔离设备）。
   ⚠️ **mDNS 不跨网段** —— `192.168.0.x` 上的 Mac 和 `192.168.31.x` 上的手机
   互相发现不了。「Mac 接了有线、手机连的是另一个路由器/网段」是最常见的翻车原因。
3. **搜不到就直接手动填** `http://<your-mac>.local:8123`。
   填**名字**而不是 IP —— 以后换网、换 IP 都不用再改。
4. **出门在外**：装 Tailscale（Mac 和 iPhone 都登同一账号），用 Tailscale
   给的地址。这也是本方案推荐的做法 —— 不需要公网端口映射，
   且端点只在你自己的组网内可达。

> 地址会变、而且 HA 不会自己跟上 —— **别把 IP 写进配置，钉「名字」**。
> 完整分析、两层修法（`internal_url` 钉 Bonjour 名 + 地址漂移看门狗）
> 与诊断命令都在下一节 **1.2.1**。

#### 1.2.1 局域网地址会变 —— 怎么让它不再成为问题

**结论：不要把 IP 写进任何配置，钉「名字」。** 这源于 HA 的一个实现细节：

> `components/zeroconf/__init__.py` 里，HA 的 mDNS 广播
> **只在启动那一刻注册一次**（`async_setup` → `_async_get_local_service_info`
> → `async_register_service`），**全文件没有任何网络变化监听**。
> 所以 HA 跑起来之后本机 IP 一变，广播里的地址就**永远停在旧值**，不重启不会自愈。

实测过的完整症状链（真的发生过一次）：

```
HA 01:04:00 启动，当时 Mac 在旧 WiFi 网段 192.168.x.x
  → 之后 Mac 换到有线 192.168.0.5，而广播里仍是 192.168.x.x
  → iPhone 上 HA App 拿着旧地址连不上 → 本地推送通道建不起来
  → 每次 notify.mobile_app_* 都返回 500 → 手表收不到确认卡片
  → hook 只能按 FALLBACK 兜底（L3 → deny），Agent 直接卡住
```

两层修法，都已经落地：

| 层 | 做法 | 效果 |
|---|---|---|
| **治本** | `~/.homeassistant/configuration.yaml` 的 `homeassistant:` 下写 `internal_url: "http://<本机 LocalHostName>.local:8123"` | 广播里带的是稳定名字，iPhone 每次连接前用 mDNS 重新解析它 → **IP 随便变都能跟上，连 HA 都不用重启** |
| **兜底** | `approval netwatch install` 装看门狗（每 120 秒体检一次） | IP 真变了（A 记录层面）就自动重启 HA 重新广播 |

诊断与修复：

```bash
approval net              # 体检 9 项：地址漂移 + 手机上的 HA App 在不在线（只读，不改任何东西）
approval net --repair     # 发现漂移就重启 HA 让它按当前地址重新广播
approval net --json       # 机器可读输出
approval netwatch status  # 看门狗装没装、修过几次
approval netwatch install # 装上定时看门狗（必须在普通终端跑）
```

> **⚠️ 看门狗的触发判据只能是「漂移本身」，绝不能是「体检里出现了 bad」。**
> （2026-09-20 实测踩到，代价是 HA 被反复踢）
>
> 起因：`net-doctor.mjs` 的 `main()` 原先用 `hasBad`（**任何一条** bad 级发现）
> 去触发 `restartHa`。而 bad 里包含 §1.2.2 的「手机上的 HA App 没在连」——
> 于是手机一掉线，看门狗每 120 秒就重启一次 HA（实测 HA 每 **2 分 33 秒**重启一次，
> 精确得像钟表）。每次重启又掐断手机的 local push websocket，于是变成
> **「手机连不上 → 重启 HA → 手机更连不上」的死循环** —— 那个 bug 把
> 「手机连不上」放大成了「永远连不上」。
>
> 更坑的是日志：它写的是「检测到漂移：广播=192.168.x.x 本机=192.168.x.x」
> —— 两边明明一模一样，把排查方向彻底带偏（真正的触发原因一个字都没提）。
>
> 现在判据收紧成 `needsRebroadcast(report)`：**只有 `drifted` 或「压根没广播」
> 才重启 HA**（这两件重启确实治得好）；其它 bad 只记账，日志写
> 「体检不通过（非地址漂移，不重启 HA）：<真正的原因>」。
> `test/net-doctor.test.mjs` §6 用 7 条断言把这个判据钉住了 ——
> 这个 bug 之所以能活这么久，正是因为**没有任何测试覆盖 `main()` 的触发决策**。
>
> 一句话判据：**重启是「让 HA 重新广播」的手段，不是「把体检做绿」的手段。**

#### 1.2.2 地址修好了，手机还是收不到 —— 查「App 在不在线」

**这是上一条的下游，而且两件事必须分开看。** 地址对了只说明「Mac ↔ HA 通了」，
不等于「手机收得到」。2026-09-19 实测遇到过：`approval net` 前 8 项全绿，
而 iPhone 上的 HA App 早就掉线了 —— 每次 notify 依然 500。

所以体检加了第 9 项，判据是 HA 里的一组**副作用**：

| 传感器 | 需不需要 iOS 权限 | 用途 |
|---|---|---|
| `sensor.<设备>_app_version` | 不需要 | **判据**：App 活着就会报 |
| `sensor.<设备>_battery_level` | 不需要 | **判据**：同上 |
| `sensor.<设备>_battery_state` | 不需要 | **判据**：同上 |
| `sensor.<设备>_last_update_trigger` | 不需要 | **判据**：同上 |
| `sensor.<设备>_connection_type` / `_ssid` / `_bssid` | **需要定位权限** | 只作上下文展示，**不作判据** |

判定逻辑（三条都要守住，否则会误报）：

- 四条判据里**只要有一条**有真实取值 ⇒ App 在线上报，通道健在。
- 四条**全是** `unavailable` ⇒ App 没在连，推送必 500。
- **一条都找不到**（设备没注册，或这些实体被禁用了）⇒ **判不了**，返回「未知」，
  **不据此拦人**。因为「没注册」和「被禁用」在 HA 的公开 API 上看起来一模一样，
  这时候给一个方向就是给一个错的方向。

```bash
approval net        # 第 9 项会直接告诉你：App 在线 / 没在连 / 判不了
curl -s http://127.0.0.1:7788/healthz | grep -E 'channelReady|deviceReady'
```

注意 `/healthz` 现在报**两个**字段，别混：

- `channelReady` —— 传输层：网关 ↔ HA 的 WebSocket 握手成功。
- `deviceReady` —— 设备层：那台手机在不在 HA 上（`true` / `false` / `null` 判不了）。

两者可以「一真一假」，实测就是这么翻车的：`channelReady: true` 而每条推送都 500。
把这两个概念合并成一个布尔值，自检结果就会自相矛盾，并把排查方向整个带偏。

修法就两步（前两步缺一不可）：

1. 把 iPhone 连回与 Mac **同一个网段**的网络 —— mDNS 不跨网段。
2. 打开 iPhone 上的 Home Assistant App，确认它指向
   `http://<本机 LocalHostName>.local:8123`。**App 连上后才会把推送通道注册到 HA**；
   在那之前 HA 侧的 `notify.mobile_app_*` 必然 500（日志里是
   `KeyError: 'push_token'`）。

> 顺带：推送失败时的报错已经不再是裸的 500，而是一段带上诊断的说明
> （见 `src/channels/device-readiness.mjs` 的 `explainUnreachable`）。
> 它会明确说「这不是权限问题」、并给出上面这两步 —— 因为看到 500 的人
> 第一反应通常是去重装 App 或查权限，而真因多半是网络。

三条替代路线（按推荐度）：

1. **在路由器上给这台 Mac 绑 DHCP 保留 / 静态 IP** —— 让 IP 根本不变，最省事，
   但要动路由器。
2. **Bonjour 名字**（上面已落地）—— 不用动路由器，IP 变了自动跟随；
   前提是手机和 Mac 在同一个网段。
3. **Tailscale** —— 跨网络也成立、地址永不变，代价是两端都跑一个 VPN。

> ⚠️ 三个和「重启 HA」有关的坑，别踩：
>
> 1. `POST /api/services/homeassistant/restart` **并不会让 HA 自己重启** ——
>    `homeassistant/__main__.py` 第 184 行只是 `return RESTART_EXIT_CODE`，
>    真正把它拉起来的是 **launchd 的 `KeepAlive`**。所以 HA 若没有 launchd 托管
>    （例如被 nohup 拉起来的），这个请求等于**把它直接杀掉、且没人再拉**。
>    实测就这么把 HA 弄停过一次（端口再没回来）。
> 2. 因此 `approval ha restart` 已改成走 `net-doctor --restart-ha` 这一份实现：
>    有托管就 `launchctl kickstart -k`，没托管就「停掉 → 用
>    `scripts/run-detached.py` 重新拉起」，并且**最后一定确认 8123 回来了**。
> 3. `approval net` 会告诉你 HA 到底有没有 launchd 托管。**没托管意味着
>    重启 Mac 之后它也不会自己起来** —— 去跑 `approval autostart`。

### 1.3 装 Home Assistant App 并开启手表

1. App Store 装 **Home Assistant**，登录你刚建的服务器。
2. **Apple Watch 上也要装 HA 的 Watch App**。Apple 官方明确：
   > Apple Watch Actions on watchOS require the Watch App to be installed.

   不装 Watch App，手表上不会出现动作按钮，只能看到通知。
3. iPhone 的「Watch」App → 通知 → Home Assistant → 选 **Mirror my iPhone**，
   或自定义允许通知。
4. **⚠️ 通知只在 iPhone 锁屏 / 息屏时才会镜像到手表。**

   iOS 的规则是：手机屏幕亮着、并且你正在用它，通知就只留在手机上，手表不响。
   所以「**手机收到了、手表收不到**」的第一嫌疑不是链路问题，而是这条 ——
   **按一下侧边键让屏幕黑掉，别碰手机，然后再推一次。**

   实测就踩过：坐在电脑前手里拿着手机等通知，手表一次都没响过，
   一度以为是 Watch App 没装。

#### 1.3.1 ⚠️ 手机连上了 ≠ 能推送：还差推送凭据

**这是本项目第二个「一半正常」的坑，务必先查。** 手机在 HA 里注册成功后，
设备注册表、实体列表（`device_tracker`、各种 `sensor`）都会立刻出现，
看起来一切正常 —— 但 `notify.mobile_app_*` 服务**可能依然不存在**。

原因在 HA 的 `mobile_app/util.py`：

```python
def supports_push(hass, webhook_id) -> bool:
    app_data = config_entry.data[ATTR_APP_DATA]
    return (
        (ATTR_PUSH_TOKEN in app_data and ATTR_PUSH_URL in app_data)
    ) or ATTR_PUSH_WEBSOCKET_CHANNEL in app_data
```

而 `notify.py` 的 `push_registrations()` 会把 `supports_push` 为假的设备**直接跳过**：

```python
for webhook_id, entry in ...:
    if not supports_push(hass, webhook_id):
        continue                      # ← 于是没有 notify.mobile_app_* 服务
```

也就是说：**设备注册**（webhook + 实体）和**推送能力**（app_data 里的凭据）
是两件独立的事，前者成功不代表后者存在。实测踩到的状态就是
设备条目齐全、`app_data` 却是**空字典**。

判据（不用令牌就能查）：

```bash
approval doctor      # 第 5 步「手机推送能力」
```

本机**当时就卡在这里**：`<Your iPhone>` 已在 HA 里注册（设备条目、实体都在），
但 `app_data` 是 **0 项**，所以 `supports_push()` 返回 false，
`notify.mobile_app_your_iphone` 这个服务当时**还不存在**。

> ✅ **2026-09-19 更正**：这一段描述的是历史状态。现在 `app_data` 已经有值了
> （`{"push_websocket_channel": true}`，见 1.3.2 的绕法），
> `notify.mobile_app_your_iphone` 已存在，且**往返已实测跑通**
> （审计里多条 `decidedBy: "ha"`，延迟 4–8 秒）。下面那段「为什么当年会卡住」
> 的原因分析仍然成立，保留备查。

**关键事实：iOS 上「本地推送」救不了这个场景。** 读 iOS App 源码
（`Sources/Shared/API/HAAPI.swift`）能看到 `app_data` 是怎么来的：

```swift
if let pushID = Current.settingsStore.pushID {
    var appData: [String: Any] = [
        "push_url": AppConstants.Firebase.pushURLString,
        "push_token": pushID,
    ]
```

`app_data` **只在拿到 `pushID` 时才写入**，写的就是 `push_token` + `push_url`
这一对。iOS 端**从不**发送 `push_websocket_channel`（全仓库检索 0 命中）。
所以 iOS 上 `supports_push()` 只能靠**远程推送注册成功**才为真。

> 走远程推送**不需要 Nabu Casa 订阅** —— App 注册到 HA 自己的推送网关，
> 额度每天 300 条。它甚至比本地推送更合适：**在外面用蜂窝网也能收到**，
> 而本地推送必须连着家里 Wi-Fi 才行。

修法（都在 iPhone 上，按顺序）：

1. **系统设置 → 通知 → Home Assistant → 允许通知**（最常见的失败原因）
2. App → **设置 → 通知设置** → 点最上面「**权限**」那一行。
   显示「已启用」才对；显示「已禁用 / 拒绝」就点它 —— 会弹系统权限申请，
   若之前已拒绝过则直接跳到系统设置页
3. App → **设置 → 调试** → 看「**推送ID**」是否写着「未注册远程通知」。
   写着就说明确实没注册成功（调试入口可能要先**摇一摇手机**才出现）
4. **上滑杀掉 App 再重新打开**，让它重新注册
5. 回来跑 `approval doctor`，看第 5 步是否转成 ✅

⚠️ **中文界面里没有「伴侣应用」这个入口。** App 设置的一级入口实际是：
服务器 / 常规设置 / **通知设置** / 定位设置 / 动作 / 隐私 / Apple Watch /
Thread /（旧版）iOS 操作 / 调试。官方文档那句 "Settings → Companion App"
是英文旧版的叫法。

另外「本地推送」**不是开关**：它在「通知设置」里只是一行**状态**
（可用（N）/ 已禁用 / 正在建立 / 不可用 / 不支持）加一个「重试本地推送」按钮；
真正可编辑的地方在「**设置 → 服务器 → 点你那条服务器**」里的内网 SSID 配置。
所以你觉得它「没办法编辑」是正常的，那个位置本来就不是可编辑的。

弄好后 `notify.mobile_app_<设备名>` 才会出现。App 上报后会走
`update_registration` webhook，HA 会**自动重新注册** notify 服务，
**不需要重启 HA**。

#### 1.3.2 ⚠️ 中国大陆的硬阻塞：Firebase 不可达

上面那条路（等 App 上报 `app_data`）在**大陆网络下走不通**。实测确认：

`Sources/App/Notifications/NotificationManager.swift`：

```swift
extension NotificationManager: MessagingDelegate {
    func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        Current.settingsStore.pushID = fcmToken     // ← pushID 来自 FCM
        ... api.updateRegistration()                // ← 之后才上报 app_data
    }
}
```

该文件 `import FirebaseMessaging`，`Package.resolved` 锁着 `firebase-ios-sdk`，
`AppDelegate` 里有 `FirebaseApp.configure()`。**pushID 只能从 Firebase 拿。**

而同一网络下直连测试的结果是：

| 目标 | 结果 |
|---|---|
| `firebaseinstallations.googleapis.com` | **000（8s 超时）** |
| `fcmregistrations.googleapis.com` | **000（8s 超时）** |
| `apple.com`（对照） | 200（0.11s） |

⇒ App 拿不到 FCM token → `pushID` 恒为 nil → `app_data` 恒为 `{}` →
`notify.mobile_app_*` **永远不会注册**。权限全开也没用，卡在 Google 那一跳。

##### 绕法：手动补 `push_websocket_channel`（本项目当前采用）

`app_data.push_websocket_channel` 在 HA 里只是 `supports_push()` 用来
「不要跳过这台设备」的标记，**真正投递走的是运行时建立的 WebSocket 通道**
（App 的 LocalPushManager 自己注册的，所以「通知设置 → 本地推送」显示「可用」）。

> 「可用（0）」里的 **0 是连接建立以来收到的消息条数**，不是错误码。
> 状态显示「可用」本身就是健康信号。

补上这个标记后 HA 就会注册 `notify.mobile_app_your_iphone`，全程不碰 Google：

```bash
# 1. 备份
cp ~/.homeassistant/.storage/core.config_entries{,.bak-$(date +%Y%m%d-%H%M%S)}
# 2. 停 HA，把 "app_data":{} 改成 "app_data":{"push_websocket_channel":true}
#    ⚠️ .storage 里是紧凑 JSON —— 冒号后面没有空格，别按格式化后的样子去匹配
# 3. 重启 HA
```

**这个绕法的代价，务必知道**：

- 只在**在家 + App 在运行**时才可能送达（本地推送依赖内网 URL 与活跃 WebSocket），
  蜂窝网下收不到 —— 而远程推送本来可以
- 不是官方支持的路径。将来 App 若真拿到 pushID，会用它真实的 `app_data` 覆盖这个
  注入值（`{**config_entry.data, **data}`，不会冲突，但会回到 FCM 依赖）
- 想彻底解决只有两条路：给 iPhone 挂代理让 FCM 通（令牌会轮换，需长期开着，不现实），
  或者换一条不依赖 Google 的推送通道 —— 仓库里 `src/channels/pushcut.mjs`
  是现成的备选；国内还可考虑 Bark 这类「自建服务器 + APNs」的方案

### 1.4 拿到两个值

| 值 | 在哪拿 |
|---|---|
| 长期访问令牌 | HA 里点左下角你的用户名 → 安全 → 长期访问令牌 → 创建 |
| 通知服务名 | 开发者工具 → 操作，搜索 `notify.mobile_app`，去掉前缀 `notify.` 就是要填的值；也可用 `approval link` 自动列出 |

本机当前这台已注册设备的服务名（由设备名算出来，非猜测）：

| 项 | 值 |
|---|---|
| 设备名 | `<Your iPhone>` |
| 设备型号 | iPhone14,2（iOS 27.0，App 2026.9.1） |
| 拼接公式 | `slugify("mobile_app_" + 设备名)` —— 见 `notify/legacy.py` 的 `async_register_services` |
| 结果服务名 | **`notify.mobile_app_your_iphone`** |
| 填进 config.json | `mobile_app_your_iphone` |

> 注意 `的` 会被 `text-unidecode` 转写成 `de`，所以是 `your_de_iphone`
> 而不是 `your_iphone`。**改设备名会让服务名跟着变**，config.json 要同步改。

### 1.5 先验证手表往返，再切通道（重要）

**顺序别搞反。** 整条链路里，网关自身的逻辑已经被 `test/selftest.mjs` 的 63 条
断言覆盖了；真正无法在 Mac 上单机验证的只有一段：

```
HA →（本地推送 WebSocket，或 FCM/APNs 远程推送）→ iPhone → 手表镜像通知 → 表上点按钮 → HA 事件 → 网关
```

这段必须真机测。所以先用下面这条命令把它单独打通，再切通道 —— 否则一旦没反应，
你分不清是「HA 到手表这一跳断了」还是「网关逻辑有 bug」。

```bash
# 环境体检（不需要令牌）
approval doctor

# 完整往返测试（把手表放在手边）
approval link --token <刚创建的令牌>
```

`link` 会依次做五件事，并把断在哪一步直接指出来：

1. 校验令牌是否真的能用（401 会被明确报出来，而不是含糊的超时）
2. 列出所有 `notify.mobile_app_*` 服务，一个都没有时告诉你手机侧漏了哪一步
3. 建立 WebSocket 并订阅 `mobile_app_notification_action`
4. 发一张带两个按钮的测试卡片
5. **等你在手表上点它**，收到回传就打印耗时和 HA 原样的字段名

它顺带还当一次「字段核对」：把 HA 回传事件的完整内容打出来。
你会看到**只有一个 `action`** —— 这是正常的，不是漏了字段：

iOS App 按下通知按钮时会**同时**发两个事件：

| 事件 | 事件数据里有什么 |
| --- | --- |
| `mobile_app_notification_action`（**我们订阅的**） | `action`、`action_data`（可选）、`reply_text`（可选）。**没有任何设备信息** |
| `ios.notification_action_fired`（旧版，同一时刻也发） | `actionName`、`categoryName`、`sourceDevicePermanentID` / `sourceDeviceName` / `sourceDeviceID` |

出处：`Sources/Shared/API/HAAPI.swift` 里的 `mobileAppNotificationActionEvent()` 第一行就是
`var eventData = [String: Any]()`，只塞那三个键；设备信息在
`sharedEventDeviceInfo` 里，被 `tag_scanned` 那类事件用。

两个结论，都能省你很多时间：

1. **不要**在 `mobile_app_notification_action` 上读 `sourceDeviceName` —— 读到的永远是 `null`。
2. **就算**改订阅旧事件，也**分不出「手机点的还是手表点的」**。`sourceDeviceName` 是 HA 里
   那台设备的注册名（本机就是 `mobile_app_your_iphone`）；手表上点的时候，
   手机可达就转发给手机去发、不可达才自己发，两种情况用的是同一份服务器配置 ——
   报出来都是手机的名。「是手机还是手表点的」在 HA 侧是一个**信息缺口**，
   所以 `ha.mjs` 干脆留空，不编一个看起来像真的的值。

另外**别**顺手把 `ios.notification_action_fired` 加进订阅：一次点击会变成两条事件，
第二条必然撞上一次性令牌的重放保护（`nonce_replayed` / HTTP 409），
只是往日志里多塞一条没意义的拒绝记录。

手表上按钮没出现？先看 `doctor` 的第 5 步 —— 十有八九是 Apple Watch 上
还没装 Home Assistant 的 Watch App。这是 Apple 的硬性要求，绕不过去。

### 1.6 切到 HA 通道

编辑 `config.json`：

```json
{
  "channel": "ha",
  "channels": {
    "ha": {
      "baseUrl": "http://localhost:8123",
      "token": "刚才创建的长期访问令牌",
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

上面这些值就是本机的实际情况（`notifyService` 的来历见 1.4）——
你只需要把 `channel` 从 `"mock"` 改成 `"ha"`、把 `token` 换成真令牌。

重启网关，`/healthz` 里 `channelReady` 为 `true` 就说明 WebSocket 已连上 HA。

> `token` 只存在本机 `config.json` 里，不会进入任何通知内容。真正的按钮令牌是
> 网关用 `data/secret` 现签的一次性 HMAC，不含任何长期凭据。

#### 1.6.1 两个「吵醒你」的旋钮

都按档位设（`L0` / `L1` / `L2` / `L3`），**高档位包含低档位**：

| 键 | 作用 | 本机取值 | 关掉的办法 |
| --- | --- | --- | --- |
| `timeSensitiveFromTier` | 从哪档起用 `time-sensitive`：能穿透「专注模式」，但**不**绕过静音 | `"L2"` | 设成 `"L3"` |
| `criticalFromTier` | 从哪档起用 `critical`：**绕过静音开关** + 临界音量提示音 | `"L3"` | 设成 `null` |

两点容易踩：

1. **两者是同一个开关的两个档，`critical` 优先。** 而且 `criticalFromTier: null`
   时 L3 也只会是 `time-sensitive` + 普通提示音 —— 不会「关不掉地」继续发 critical 铃声。
   （这里原先写的是 `record.tier === 'L3'` 就发 critical 声音，等于 `criticalFromTier`
   设成 `null` 也关不掉。现在改成跟同一开关走，`test/ha-channel.test.mjs` 盯着这条。）
2. **`critical` 能不能真的响，取决于 iPhone 上的权限。**
   iOS 设置 → 通知 → Home Assistant → **关键警报**。
   没开的话这条 L3 通知可能不响，而 HA App 在代码里**不做权限检查**
   （`LocalPushEvent.swift` 直接构造 `.criticalSoundNamed`），所以从日志看不出问题。
   要确认就实机发一条 L3 试。

另外：**watchOS 上永远用默认提示音**（`LocalPushEvent.swift` 里 `#if os(watchOS) return defaultSound`），
所以这两个旋钮只影响手机端；手表振不振得到，只看镜像有没有开。

#### 1.6.2 手机上怎么点到那个按钮

iOS 的通知**不会**把动作按钮摊开显示，必须**展开**才看得见（详见「已知限制」里那一条）。
展开的手势：锁屏上**从右往左滑**再点「查看」，或**长按**；不在锁屏时把通知**下拉**。
**Apple Watch 上则是直接显示按钮**，所以「手表好用」并不代表「手机也能用」。

想少一个步骤，可以走通知的 `url` 字段 —— **点通知主体不需要展开**。
配上下面两个键，点一下就直接打开手机上的审批页（那一条会自动置顶高亮）：

| 键 | 作用 | 取舍 |
| --- | --- | --- |
| `publicBaseUrl` | 手机可达的网关地址，如 `http://192.168.1.5:7788`。填了才会往通知里写 `url` | **留空 = 不写 url**。默认 `host` 是 `127.0.0.1`，手机访问不到，硬写进去只会得到一条「点了没反应」的死链 —— 那比没有更糟 |
| `phoneAccessKey` | 审批页口令。配了之后，不带 `?k=` 的请求拿不到页面 | 建议**和上面一起配**。不配的话，同网段任何人都能打开审批页并替你按 |

启用 `publicBaseUrl` 的前提是**网关监听局域网**：把 `config.json` 的 `host`
从 `127.0.0.1` 改成 `0.0.0.0`（或本机 LAN IP），然后重启网关。自检：

```bash
curl -s "http://<本机LAN IP>:7788/phone.html?k=<phoneAccessKey>" | head -3
```

**安全边界，别误解**：审批页口令只挡住「打开页面」。真正防止伪造决策的是每个按钮里
那串一次性令牌（`APR:<id>:<选项>:<nonce>:<签名>`，见第 4 节）—— 它单次消费、有 TTL、
且绑定到具体动作。所以即使有人打开页面，也只能看到「有哪些待确认项」，
不能凭空造一个批准。尽管如此，**把接口暴露到局域网之前，先想清楚这个网段上都有谁。**

---

## 2. 接上 Agent（两个入口，建议都开）

> **当前接线状态**
>
> | 入口 | 状态 | 说明 |
> |---|---|---|
> | MCP | **已接入** `~/.workbuddy/mcp.json` | 但还没在连接器管理页点「信任」，见 2.2 |
> | hook | **已写入** `~/.workbuddy/settings.json` | 只注册 `PreToolUse`；要重启会话或走 `/hooks` 才生效，见 2.1 |
>
> 什么时候可以先不开 hook：MCP 是「按需调用」型的 —— 只有 Agent 想问你的时候才会用，
> 网关没跑时最多是那个工具调用报错，不影响你日常用 Agent。
> 而 hook 是**全局拦截**：它会拦下每一次工具调用，并且推送/网关出问题时一律
> **fail-closed 拦住**（不再有「降级成 ask」这回事，原因见 2.1 末尾）。
> 万一真被拦下了，2.1 末尾的「本机一次性确认」给你一条显式的放行通道。

### 2.1 hook：拦截危险工具调用

在 `~/.workbuddy/settings.json` 里加 `hooks`（与 Claude Code 的 schema 同构）：

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

> **只注册 `PreToolUse` 一个事件，是刻意的。**
>
> 权威依据只有本机 CLI 自带的那份 hook 参考：
> `/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/dist/web-ui/docs/cn/cli/hooks.md`。
> 它列出的事件一共 9 个 —— `PreToolUse`、`PostToolUse`、`Notification`、
> `UserPromptSubmit`、`Stop`、`SubagentStop`、`PreCompact`、`SessionStart`、`SessionEnd`。
> **里面没有 `PermissionRequest`。** 这份文档早先在这里写过 `PermissionRequest`，
> 是照 Claude Code 的 schema 想当然写的；写进 `settings.json` 也只是条死配置，永远不会被触发。
> 公开文档站（`workbuddy.cn/docs`）**没有 hooks 页面**，所以只能以本机 CLI 文档为准。
> `bin/approve-hook.mjs` 里保留着 `PermissionRequest` 的分支输出 —— 那是给别的宿主用的兼容层，
> 留着无害，但**不要**把它注册进 `settings.json`。

> **`timeout` 必须显式写，而且必须大于 `BUDGET`（默认 150s）。**
>
> 同一份文档写明：hook 默认超时 **60 秒**。`approve-hook.mjs` 现在是「创建即返回、
> 本地轮询等待」：阻塞时长由 `BUDGET`（`APPROVAL_HOOK_BUDGET`，默认 150s）封顶，
> `timeout` 要大于它。上面给的 `180` 正好够；若你把 `BUDGET` 调到 150 以上，
> 这里也要跟着放大到 `BUDGET + 30` 以上。
>
> **历史教训（2026-09-19 修掉的「卡死」bug）**：旧设计把 `ttl` 和阻塞时长设成同一个数
> （`wait = ttl`），而 `timeout` 只有 180。L2 默认 ttl 300s 时，宿主会在 180s 把 hook
> 杀掉、按「hook 超时」fail-closed 拒绝 —— 现象就是「任务卡死两分钟后失败」，
> 而那条待确认卡在网关里继续挂到它自己的 300s。改成 `wait: 0` + 本地轮询 + `BUDGET`
> 封顶后，**宿主杀 hook 之前 hook 一定已经有了结论**，不会再出现这种挂死。

`matcher` 里刻意不含 `Read|Glob|Grep`：这些恒为 L0，拦它们只是白白多付一次
进程启动开销（hook 是**每个匹配到的工具调用都起一个进程**）。`command` 用绝对 node
路径再跟上脚本绝对路径，不依赖脚本的 shebang 和执行位 —— hook 的执行环境不保证
`PATH` 跟交互 shell 一致。

**hook 的配置里没有 `env` 字段**（文档给的字段只有 `type` / `command` / `prompt` / `timeout`）。
要传下面这些环境变量，只有两条路：写进 shell profile 让 hook 继承，或者直接内联在命令里：

```
APPROVAL_FALLBACK_L2=allow /opt/homebrew/bin/node /path/to/agent-approval/bin/approve-hook.mjs
```

可调环境变量：`APPROVAL_GATEWAY_URL`、`APPROVAL_TTL_L2`（默认 120）、
`APPROVAL_TTL_L3`（默认 120）、`APPROVAL_FALLBACK_L2`（默认 `deny`）、
`APPROVAL_FALLBACK_L3`（默认 `deny`）、`APPROVAL_HOOK_BUDGET`（默认 150，
本地阻塞等待的硬上限，必须小于 `timeout`）、`APPROVAL_DATA_DIR`（默认取
`config.json` 的 `dataDir`；只有测试会用到）。

> ⚠️ **`ask` 不是这里的一个可选项。** 它在这个宿主里等于「放行」，
> 所以 `fallbackFor()` 会把 `ask` 降级成 `deny` 并在 stderr 打一条警告。
> 想「弹个框问一下」，走下面 **2.1.3** 的 `approval confirm`。原因见本节的
> 「`ask` 到底是什么意思」那一节 —— 那一节早先写错了，2026-09-19 已按活体实测改掉。

> **「改完是否立刻生效」—— 别想当然，分两种会话。**
>
> 文档说 hook 在启动时拍快照、外部修改要在 `/hooks` 审查才应用。但本机实测：
> 2026-09-19 01:50:54 写入 `settings.json` 后，**新开的任务**在几秒内就触发了
> 这条 hook（网关立刻收到 hook 发起的确认），而且**当时那个还开着的老会话**
> 也触发了。也就是说本机两种情形实测都生效了 —— 但这**不能当成通用结论**
> （宿主版本、会话状态、是否在 `/hooks` 审查过都可能影响），**不要**据「我这次
> 没重启也生效了」去推断「改 hook 永远不用重启」。
> 三条证据（都指向「已生效」，但只证明当时那次生效了）：
>
> 1. 网关审计里 01:51–01:57 出现 7 条 `tool: Bash` 的确认，而我没有手动推过任何一条；
> 2. 时间点与「写入配置」严格对齐（写入后 7 秒开始）；
> 3. **反向探针**：把网关停掉，再发一条 L3 命令，结果被 hook 拦下并返回
>    「确认网关不可达（`http://127.0.0.1:7788`）」—— 如果 hook 没生效，这条命令会
>    直接正常跑完。
>
> 所以：**判断某会话有没有接上 hook，用行为探针，不要用 atime 或「没重启=没生效」
> 这种推理。** 想确认注册状态仍然可以跑一遍 `/hooks`；新任务则见 2.1.2。
>
> 两个操作教训：
>
> - **验证「某机制是否生效」时，不要用间接证据。** 我一开始看 `bin/approve-hook.mjs`
>   的 `atime` —— 但自己刚做过语法校验，`atime` 早被更新了，完全无法区分「hook 执行过」
>   和「我 `node --check` 过」。要探针就造一个**只有该机制生效才会出现的结果**。
> - **探针本身要无害。** 我用的探针（一条 `dd` 写空设备的命令）即使 hook 没生效、
>   真的被执行，也什么都不做。

> **第一次打开 hook 时的建议**：保持默认，**不要**去设 `APPROVAL_FALLBACK_*`。
>
> 默认是 `deny`，即「确认没送到你手上 = 不放行」。代价是：网关没在跑时，
> 你的 Agent 做任何 L2/L3 操作都会被直接拒绝，而原因不会写进报错里 ——
> 所以真正该做的是 **2.1.1**（让网关开机自启）+ `approval doctor`，
> **不是**把失败路径改成放行。
>
> 这里原先建议「头一周把 `APPROVAL_FALLBACK_L3` 设成 `ask`，网关掉线时
> 退化成桌面弹窗」。**那条建议是错的**，两层都错：
>
> - 那阵子 `APPROVAL_FALLBACK_L3` 被硬编码的 `deny` 绕过，设了也不生效；
> - 更关键的是，`ask` 在这个宿主里**根本不弹框，而是等于放行**（见下）。
>
> 现在被拦住时该怎么办：看 `data/blocked-last.json`（hook 会自动记下最近一条），
> 或者直接用下面这套流程。

**hook 的四种输出**（`bin/approve-hook.mjs` 里的 `fallbackFor()` 就是这条界线）

| 情形 | L2 | L3 | 说明 |
|---|---|---|---|
| L0 / L1 工具 | 无输出 | 无输出 | 交回原本的权限流程，**不静默提权** |
| 你在手表/手机上点了「允许」 | `allow` | `allow` | |
| 你点了「拒绝」 | `deny` | `deny` | |
| **超时未确认** | `deny` | `deny` | 卡片已送到你手上，你看到了没答 →「没答就是没同意」。本地轮询到点没拿到结论就 deny。**这是策略默认，不受 FALLBACK 影响** |
| **确认没能送到你手上** | `deny`（默认） | `deny`（默认） | 三条路径：网关返回非 2xx、网关不可达/异常、**推送失败（`pushOk:false`）** |
| ↑ 但你在弹框里点过「允许这一次」 | `allow` | `allow` | 一次性授权命中 → 放行**一次**，随即失效 |

最后两行是唯一受配置影响的情形，默认值都是 `deny`。第三条路径（推送失败）
现在会先去查 `data/local-grants.json` 里那张一次性授权，见 **2.1.3**。

> **这里修过两个 bug，第二个是本次的核心。**
>
> **① 死开关。** 原先的代码是 `tier === 'L3' ? 'deny' : FALLBACK[tier]`，
> 出现在**三处**（网关非 2xx、超时未确认、网关不可达）—— 于是 `APPROVAL_FALLBACK_L3`
> 在它唯一该生效的场景（网关掉线）里被硬编码绕过了。文档还建议你「头一周设成 `ask`」，
> 等于让你调一个根本不存在的旋钮，而且没有任何断言会红 —— 因为
> `bin/approve-hook.mjs` 当时**一个测试都没有**。现在 `test/hook.test.mjs`（61 项）
> 真起子进程、喂真实 stdin 把这几条路径钉死了。
> 顺带在 `src/core/risk.mjs` 补了一条：`shred` / `srm`（安全擦除，刻意让数据不可恢复）
> 原先不在任何规则里，掉到默认的 L2 —— 比 `rm -rf ~/Documents` 的 L3 还低，方向是反的。
>
> **② 默认值本身是个 fail-open 漏洞。** `APPROVAL_FALLBACK_L2` 的默认值原来是 `ask`，
> 而 `ask` 在这个宿主里等于**放行**（不是弹窗，见下）。也就是说：
> **推送最可能失败的那条路径，反而是唯一一条会静默放行的路径。**
> 现在默认改成 `deny`，并且显式配 `ask` 也会被降级成 `deny` + stderr 警告。
> 这个漏洞是被用户的报障牵出来的：「推送到手表失败…已按 deny 处理，这个处理不对」。

> **`ask` 到底是什么意思 —— 我先前写错了，2026-09-19 按活体实测改正。**
>
> **旧结论（错误）**：`ask` 会交给「正常权限流程」= 弹原生确认框，所以
> `FALLBACK = ask` 的语义是「降级成桌面弹窗，绝不静默放行」。
>
> **正确结论**：**本构建的 WorkBuddy 不实现 `ask`。输出 `ask` 等于放行。**
>
> 错误的来源：我反读的是 **SDK 回调型 hook** 那条路（`control_request` →
> `hook_callback` → `aggregateResults`），那里确实完整实现了 `ask`。
> 但 `settings.json` 里的 **command 型 hook** 走的是另一条路，那条路上没有 `ask` 分支：
>
> ```js
> // HookExecutor.parseHookOutput()
> let ep = { allowed: 0 === eA, exitCode: eA ?? -1, ... };   // 初值 = 「exit 0 即 allowed」
> if (eA.hookSpecificOutput?.permissionDecision) {
>   const el = eA.hookSpecificOutput.permissionDecision;
>   "deny"  === el ? (ep.allowed = false, ep.blockSource = "json", ep.blocking = true)
> : "allow" === el && (ep.allowed = true);
>   // ← "ask" 没有分支，直接落到初值 allowed = (exitCode === 0) = true
> }
>
> // SessionToolManager.executePreToolUseHooks()
> let ed = eu.allowed;
> "deny" === el ? ed = false : "allow" === el && (ed = true);   // ← 同样漏掉 ask
> return { allowed: ed, ... };                                  // 调用方只读 .allowed
> ```
>
> 两处的 `catch` 也都是 `{ allowed: true }` —— hook 自己崩了同样是放行。
> 合起来就是：**`deny` → 拦住；其余一切（`ask` / 空输出 / 崩溃）→ 放行。**
>
> **活体 A/B（推送必然失败的前提下，2026-09-19）**：
>
> | 探针 | 钩子输出 | 结果 |
> |---|---|---|
> | L2 `git push`（在无 git 仓库的目录里） | `ask` | **命令执行了**（`fatal: not a git repository`，exit 0） |
> | L3 `rm -rf <不存在的路径>` | `deny` | **被拦住**（拒绝原因回给了 Agent） |
>
> 旁证：宿主日志里同一时刻是
> `[BashTool] sandbox path active, skipping 8-Phase permission check` →
> hook 输出「已按 ask 处理」→ `[BashTool] execute start` →
> `[SandboxOrchestrator] OUTCOME | outcome=sandbox-success | prompted=false`。
> **`prompted=false` —— 根本没有弹框。**
>
> 顺带说明 `ask` 唯一可能弹框的地方是 `HandleInterruptions`
> （`hasForcedAskDecision()` → `permissionDecision === "ask"` → 写进 `providerData`
> → 日志 `Approval dialog shown for tool: X`）。但那条路只在**宿主自己判定需要批准**
> 时才走，沙箱快速路径不经过它 —— 所以它跟 `settings.json` 的 command hook 无关。
>
> **怎么自己复核**（这条结论可证伪，别只信文档）：把网关停掉，然后跑
> `approval tier` 里那条 L2 探针，看命令有没有真的跑起来。
> 想更省事就跑 `approval test` —— `test/hook.test.mjs` §4/§5 把这几种降级路径
> 全钉住了（包括「显式设成 `ask` 时也必须是 `deny`」）。

#### 2.1.1 网关必须开机自启，否则 hook 会静默降级

hook 的每一跳都要问网关。网关不在 → 所有 L2/L3 都走「网关不可达」分支
（L2 降级成桌面弹窗、L3 fail-closed 直接拒），而**报错里不会写原因**。

原先网关是在某个 Agent 会话里用 `scripts/run-detached.py` 拉起来的 —— 那种进程
**重启 Mac 就没了**。现在有了正经的 LaunchAgent：

```bash
# 必须在普通终端里跑：沙箱禁止 launchctl bootstrap（报 Bootstrap failed: 5）
approval autostart          # 一次装好 HA + 网关两个 LaunchAgent
# 或者分开装：
approval gw install         # 只装网关
approval ha install         # 只装 HA
```

plist 由 `scripts/gateway-service.sh` **生成**（不是静态文件），所以里面的路径
永远跟实际安装位置一致。两个必须对的字段：

- `WorkingDirectory` = 项目根 —— 因为 `config.json` 里 `dataDir` 写的是相对路径 `./data`
- `ProgramArguments[0]` = `/opt/homebrew/bin/node` 绝对路径 —— launchd 的 PATH 很干净

`approval gw status` 会同时报三件事，因为**缺一不可**：网关在不在跑、
HA 在不在跑、`/healthz` 里报的通道是否就绪。

> **一个容易误判的坑：`KeepAlive` 与端口被占是相互放大的。**
> 若 7788 已被一个临时网关占着，launchd 拉起的那个会立刻因 `EADDRINUSE` 退出，
> 然后每 `ThrottleInterval` 秒重试一次 —— 表现为「装好了但一直起不来」，
> 日志里刷满 EADDRINUSE。所以 install 会先清掉占用 7788 的非 launchd 进程
> （那些进程里未结算的待确认记录会丢，已结算的审计不受影响）。
>
> 另外 `launchctl list` 显示「无」是正常的 —— 它只列**已装载的 LaunchAgent**，
> 而临时进程不在里面。要看真实状态用 `approval gw status`。

#### 2.1.2 为什么「其他任务不触发」—— hook 是会话启动时的快照

**这是本项目最容易被误判的一件事。** 权威文档
（`cli/dist/web-ui/docs/cn/cli/hooks.md` 第 789–794 行）原文：

> 直接编辑设置文件中的 hooks **不会立即生效**。CodeBuddy Code：
> 1. 在**启动时**捕获 hooks 的**快照**
> 2. 在**整个会话期间使用此快照**
> 3. 如果 hooks 在外部被修改，**会发出警告**
> 4. **需要在 `/hooks` 菜单中审查才能应用更改**

所以在 `settings.json` 里写入 hook 之后，**当时已经开着的那些任务不会看到它** ——
它们手里拿的是自己启动那一刻的快照，里面根本没有这条 hook。表现就是你遇到的：
「新任务里有需要确认的内容，但手机、手表一点动静都没有」。

**怎么判断到底是哪一类问题 —— 别猜，看审计：**

```bash
approval audit 10     # 看最近记录里有没有 decidedBy = "ha"
```

- **有 `decidedBy: "ha"`** → hook 在工作、卡片也送到了。那你抱怨的那个任务多半是
  **旧会话**（如上），或者它压根没执行 L2/L3 命令。
- **一条都没有** → hook 或网关真的没通，去查 2.1.1 和网关日志。

**验证「新任务能不能触发」的正确做法**：别去日志里翻间接证据，而是
**造一个只有该机制生效才会出现的结果**。本项目内置了安全探针：

```bash
approval tier          # 列出「判为 L2/L3 但执行效果为零」的探针命令
```

首选探针 `rm -rf ~/WorkBuddy/agent-approval/.probe-no-such-dir` —— 路径不存在，
所以真被执行也是空操作；但分级确实是 L3，会真的推一张卡。

> **实测（2026-09-19）**：用一个一次性定时任务造了个**全新** WorkBuddy 任务，
> 让它执行这条探针 → 审计立刻多出一条 `created L3`，**4.3 秒后**
> `settled allow`、`decidedBy: "ha"`。那个任务的会话 ID 是新的
> （`854c0b76-…`，与当时对话中的 `9d5ad743-…` 不同）。
> ⇒ **新任务能触发，推送也能到达；卡住的只是旧会话。**

**修法**（按代价从低到高）：

1. **重启 WorkBuddy** —— 之后开的任务都带 hook。最省事，推荐。
2. 对每个还开着的旧会话走一次 `/hooks` 审查（文档给的官方路径）。
3. 不想重启就在那个旧会话里跑一次 `approval audit`，里面没有它自己的记录
   就说明确实没接上。

> **两种「以为没触发」的情形，别和上面混为一谈：**
>
> - **Agent 在对话里问你要不要确认，那不算 hook。** 当前 hook 的 matcher 是
>   `Bash|Edit|Write|MultiEdit|NotebookEdit|WebFetch|mcp__.*` —— 交互式提问
>   不在这个集合里（即使进来，未知工具也只会判 L1，不推送）。
> - **命令本身没被判成 L2/L3。** 用 `approval tier "<命令>"` 一查就知道。
>   分级是**基于文本正则**的，所以有两种反直觉情况：L0/L1 的命令不推；
>   而**文本里提到**危险字符串的命令会被判高（`node -e "… rm -rf …"` 这种）。

#### 2.1.3 推送失败时怎么办：本机一次性确认（`approval confirm`）

**这一节回答的是用户报的那个问题**：

> 「推送到手表失败（`notify.mobile_app_your_iphone` 返回 500），已按 deny 处理。
> 这个处理不对，如果推送失败，请在 WorkBuddy 弹出选项供确认。」

「处理不对」是对的 —— 而且比看上去更糟：当时 `APPROVAL_FALLBACK_L2` 的默认值是
`ask`，而 `ask` 在这个宿主里**等于放行**（见上一节）。所以推送失败时，
L2 命令既没有弹框、也没有被拦住，而是**静默执行了**。

**为什么不能直接让 hook 弹框。** `permissionDecision: "ask"` 是唯一语义上
「交给宿主弹框」的取值，但这个构建没实现它（证据见上一节）。
所以「弹框给选项」只能由 **Agent 调用 `AskUserQuestion`** 来完成 ——
那是 WorkBuddy 真正会弹的原生框（宿主日志：
`[HandleInterruptions] Approval dialog shown for tool: AskUserQuestion`）。

**完整流程：**

```
① 推送失败（HA 500 / 网关失联）
     ↓  hook 立刻 deny 拦住（fail-closed），并把这条写进 data/blocked-last.json
② Agent 看到拒绝原因，用 AskUserQuestion 弹框问你：
     「刚才那条 <命令> 没推送到你手上，要允许这一次吗？」
     ↓  你选「允许这一次」
③ Agent 执行  approval confirm --yes
     ↓  落一张绑定到**这条命令**的一次性授权（默认 10 分钟、只能用一次）
④ Agent 重试同一条命令
     ↓  hook 先查授权表 → 命中 → allow 一次，随即失效
```

**你自己会用到的手势：**

```bash
approval confirm                      # 不带参数：确认「最近一次被拦下的命令」
                                      # 会先把命令摘要/档位/被拦原因/拦于多久前打印出来
approval confirm --yes                # 跳过追问直接签发（Agent 用；你在弹框里已答过）
approval confirm --list               # 看当前有效的一次性授权
approval confirm --revoke             # 收回全部（或 --revoke <短binding> 收一条）
approval confirm --ttl 60 --yes       # 自定义有效期
```

**这条路的强度（以及它不是什么）：**

| 有 | 没有 |
|---|---|
| 绑定到 `tool + 规范化 input` 的 sha256 —— 换一条命令立刻失效 | **不是安全边界**。本机 agent 能读 `data/secret`、也有 TTY，技术上可以自己签发 |
| 一次性消费（用完即摘） | 不防对抗 —— 它防的是「手改文件」和「误放行」 |
| HMAC 签名 —— 手改 JSON 不改签名会被判 `bad-sig` 并作废 | 不替代推送通道：真正的边界仍然是「卡片能送到你手上」 |
| 有 TTL（默认 600s，下限 30s） | |
| 每次签发/消费/拒绝都留痕：本地 `data/local-confirm.log`
  ＋ 网关审计 `local_confirm_issued` / `_used` / `_rejected` | |

> **留痕是这条路唯一的防线，所以它是强制的。** 因为这条路径绕过了推送，
> 是整条链路上**唯一没有设备侧记录**的决定 —— 事后想查「谁在什么时候
> 用本地确认放行了什么」，只能靠审计。为此给网关加了个
> `POST /v1/audit`（只认上面三个固定事件名，不接受任意内容）。
>
> 用 `approval audit 20` 就能看到它们混在正常记录里。

**先修根因，再谈放行。** 这条通道是「推送坏了也别停工」的兜底，
不是长期方案。推送失败通常有确定的原因（HA 没起 / iPhone 掉线 / IP 漂移）：

```bash
approval doctor          # 环境体检：HA 可达性 / mDNS 广播 / 手机推送能力
approval net             # IP 漂移体检（HA 的 mDNS 广播只在启动时注册一次）
approval net --repair    # 漂移了就重启 HA 让它重新广播
```

**回归测试**：`test/hook.test.mjs` §9（22 项）把整条链走完了 ——
无授权时拦住、非交互下不许签发、签发后放行一次、第二次就失效、
另一条命令蹭不到、收回后立刻回到 deny、审计真的落了两条。

### 2.2 MCP：让 Agent 主动问人

**这一步已经帮你做好了。** `~/.workbuddy/mcp.json` 里已存在 `approval` 条目
（原有 27 个服务一个没动，写入用「临时文件 + 原子替换」以免中途失败写坏配置）：

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

> `command` 用 Homebrew 的软链 `/opt/homebrew/bin/node`，而不是带版本号的
> Cellar 路径 —— brew 升级 node 后软链会自动指向新版本，不会失效。

暴露 5 个工具：`request_approval`、`list_pending_approvals`、`cancel_approval`、
`verify_approval`、`get_approval_audit`。

**还需要你做一件事**：MCP 配置不会自动生效 —— 到连接器管理页右上角的
「自定义连接器」入口，对 `approval` 这条点「信任」。

点完可以这样验证（不需要手机，网关在跑就行）：

```bash
approval test          # 80 项分级 + 44 项 HA 通道 + 61 项 hook
                       # + 66 项本机一次性确认 + 35 项 net-doctor
                       # + 82 项网关 + 21 项 MCP
```

它会真启一个 MCP 子进程走完整 JSON-RPC 握手，发一条确认请求，
再冒充「用户在手表上点了批准」，核对 MCP 侧拿到的结论。
共 21 项断言，覆盖了 `selftest.mjs` 没覆盖的 MCP 路径。

⚠️ 这一套打的是**当前正在跑的网关**（`APPROVAL_GATEWAY_URL`，默认 7788）。
网关已经切到 `ha` 通道时，它会**真往你手机推一张卡片**，并留下一条待确认
（得手点掉或等超时）—— 所以没给 `--with-push` 时 `mcp-e2e` 会主动拦下来并给出两个选择。
想在真机上顺带验证一次就 `approval test --with-push`；
不想被打扰就把 `config.json` 的 `"channel"` 临时改回 `"mock"` 再重启网关
（另外四套测试都用各自的临时 mock 配置，不受影响）。

**退出码约定（后面这几套里只有 `mcp-e2e` 会「跳过」）：**

| 退出码 | 含义 | `approval test` 的处置 |
|---|---|---|
| `0` | 断言全过 | 继续 |
| `1` | **真的失败**（断言没过 / 未捕获异常） | 整条命令 `exit 1` |
| `2` | **按设计跳过**（网关没起 / `ha` 通道又没给 `--with-push`） | 打印 `⏭ 按设计跳过（不算失败）`，**不影响退出码** |

前八套是纯本地的（各自用临时 mock 配置），所以「没起网关」不该让整条 `approval test` 变红 ——
`mcp-e2e` 用 `exit 2` 表达「我跑不了，但这不代表坏了」，`approval test` 认这个约定。

### 2.3 顺带：任务完成时也推一条

在 `settings.json` 里再加一个 `Stop` hook。`Stop` **不支持 `matcher`**（按文档，只有
`PreToolUse` / `PostToolUse` / `Notification` / `PreCompact` / `SessionStart` / `SessionEnd`
支持匹配器），所以直接省掉这个字段：

```json
"Stop": [
  { "hooks": [ { "type": "command",
    "command": "/opt/homebrew/bin/node /path/to/agent-approval/bin/approve-hook.mjs --notify Agent 已完成" } ] }
]
```

`--notify` 那条路是**发完就走**（不等确认），所以这里不用像 2.1 那样加大 `timeout`，
默认 60 秒足够。

> 这一段目前**没有写进** `settings.json` —— 它会在你每次回答结束时都推一条通知，
> 头几天多半嫌吵。想要就自己按上面加。

---

## 3. 风险分级规则

| 级别 | 判定示例 | 行为 |
|---|---|---|
| L0 | `Read`、`ls`、`git status`、`curl -I`、只读 gh 查询 | 不推送，不介入权限 |
| L1 | `Edit`、`git add/commit`、`node script.mjs`、`rm -rf node_modules` | 不推送，仅记审计 |
| L2 | `git push`、`gh pr create`、`curl -X POST`、`wrangler deploy` | 推到手表，默认拒绝 |
| L3 | `git push --force`、`git reset --hard`、`sudo`、`npm publish`、`rm -rf ~/…` | 推到手表 + 要求解锁，120s 超时拒绝 |

特殊处理：`rm` 会看目标路径与是否递归。

| 形态 | 档位 |
|---|---|
| 目标落在 `node_modules` / `dist` / `/tmp` 这类常规清理目录 | L1（推送只会消耗你的耐心） |
| 非递归删单个文件，目标不在上述目录 | L2（该问，但不该要解锁） |
| **递归**删除（`-r` / `-rf`），目标不在上述目录 | L3 |

> `rm` 这里修过一个 bug：原先不看 `recursive` 标志，于是 `rm -f 单个文件` 也报
> 「**递归**删除」并判 L3 —— 提示语和实际规则对不上，agent 清理一个临时文件就会触发
> L3 解锁确认。现在按递归与否分开。

**分级里最容易错的方向不是「把危险的判低了」，而是「把无害的判高了」。**
未知命令默认落 L2（会推送），于是一批日常命令曾经全都在推送：
`cd ~`、`export PATH=...`、`bash -n x`、`node --check x`，
甚至本机自己的 `approval test`。打扰预算一旦被这种噪音消耗完，你就会开始无脑点「允许」，
整个方案等于白接。现在这些分别落到：

| 命令 | 档位 | 理由 |
|---|---|---|
| `cd` / `export` / `unset` / `set` / `source` | L0 | 只影响当前复合命令的解释环境 |
| `bash -n` / `node --check` / `python -m py_compile` | L0 | 语法校验，只解析不执行 |
| `for` / `while` / `if` / `case` / `done` / `fi` … | L0 | 控制流骨架，本身不执行任何外部命令 |
| `approval …` | L1 | 本机控制工具；只能撤销放行、不能授予，放这档不会变后门 |

控制流这一条是 2026-09-19 补的。**当时正开着这个会话，我自己敲了一条
`for f in …; do …; done`，它就掉进了「未能识别的命令」默认 L2 并推了一张卡到你手表上。**
循环是多常见的写法 —— 这条不修，打扰预算会被持续消耗。

骨架不推，但**绝不能把循环体里的危险命令一起洗白**。做法是在 `splitSegments()`
里把 `do` / `then` / `else` 前缀剥掉，让循环体作为独立分段参与判定（这也是为什么
`for f in a; do sudo true; done` 仍是 L3）：

```bash
approval tier 'for f in *; do rm -rf ~/Documents; done'   # L3 —— 循环体照常判
approval tier 'for f in *; do echo "$f"; done'            # L0 —— 骨架不推
```

> ⚠️ **这条修复带来的已知取舍**：档位是「看哪一段命中了最高档的规则」，所以一条
> **完全没被任何规则认识**的命令，只要前面有一段命中 L0 的骨架或前缀，整条就会落 L0。
> 例如 `for f in *; do frobnicate "$f"; done` 与 `cd ~ && frobnicate "$f"` 都是 L0。
> 后者在补骨架规则**之前就是这个行为**，所以骨架只是把同一性质延伸过去，
> 不是新开的口子。真要收紧必须两处一起改 —— `risk.test.mjs` 的第 [7] 组
> 把这两个 case 钉住了，就是为了防止以后有人只改一半。

`test/risk.test.mjs`（80 项）专门盯这个方向，也盯住「复合命令里带个 `cd` 或管道
不能把危险段稀释掉」（`cd ~ && rm -rf ~/Documents` 仍是 L3）。


自定义规则写在 `config.json` 的 `risk.extraL2Patterns` / `extraL3Patterns` /
`extraL0Patterns`，以及 `risk.forceTierByTool`。

---

## 4. 安全模型

1. **按钮就是一次性能力令牌**。`APR:<id>:<选项>:<nonce>:<签名>`，网关验
   HMAC 后才认。伪造一条 HA 事件也批不动。
2. **nonce 用过即废**，重放返回 409（自检里有覆盖）。
3. **动作绑定哈希**。每次确认记录 `sha256(工具名 + 规范化入参)`；
   `verify_approval` 可比对你此刻要做的动作是否还是当初批准的那一件。
4. **默认拒绝**。超时、验签失败、网关不可达，结果都是拒绝。
5. **HA 通道没有公网入口**。回程走 HA 的 WebSocket 事件，
   Mac 不需要端口映射，也没有「令牌放在 URL 里」的问题。
6. **通知正文脱敏**。锁屏就能看到，所以只放动作摘要；密钥、文件内容、
   客户数据一律不进通知。这条需要在写 `body` 时自觉遵守。
7. **不提供永久白名单**。L3 只有「仅此一次」；L2 的「本会话内允许」也只在当前会话有效，
   而且**作用域窄到 (会话, 工具, 档位) 三元组**，详见 4.1。放宽权限必须回到桌面做。

#### 4.1 「本会话内允许」到底放行了什么

这个按钮一度是个**空按钮** —— 它和「仅此一次」产生的效果完全一样，下一件同样的事还会
再问你一遍，而本节这句话早就写着它「只在当前会话有效」。**文档承诺了、实现没有。**
一个说话不算话的按钮会训练出盲点式点击，那比没有这个按钮更危险，所以把它补齐了。

命中白名单时的行为：**不推送任何通知**，直接按允许结算，审计里记 `decidedBy: "session-allow"`。

作用域（宁窄勿宽）：

| 维度 | 规则 |
| --- | --- |
| 会话 | 只对**同一个 `session_id`** 生效。换会话照旧问 |
| 工具 | 只对**同一个工具**生效。同会话里换个工具照旧问 |
| 档位 | 只对**同一个档位**生效 |
| **L3** | **永不参与**。授予与命中两侧都拦 —— 就算你在同会话同工具上点过允许，下一件 L3 照样来问 |

三重上限，任一条命中都让这条授权消失：

1. **有有效期**：默认 30 分钟（`defaults.sessionAllowTtlSeconds` 可改）；
2. **只存内存**：网关一重启就清空（故意的 fail-closed 偏置）；
3. **随时可撤**：

```bash
approval sessions                          # 看现在有哪些事被静默放行
approval sessions revoke                   # 全撤
approval sessions revoke Bash              # 只撤 Bash
```

每次授予 / 命中 / 撤销都写审计（`session_allow_granted` / `session_allow_hit` /
`session_allow_revoked`）。`test/selftest.mjs` 第 8 节有 16 条断言专门盯这套约束，
包括「L3 即使同会话同工具也照旧要问」。

### 已知限制

- **Agent 会话的沙箱会挡住几件事**，别被误导：
  - `launchctl` 装载作业 → `Bootstrap failed: 5: Input/output error`（mach 服务被拒）；
  - 写 `~/.ha-venv` → HA 自己补依赖时报 `Operation not permitted (os error 1)`；
  - `ps` / `pgrep` 看不到别的进程 → 会把「HA 明明还活着」误判成「进程已死」
    （用 `lsof -nP -iTCP:8123 -sTCP:LISTEN` 判断才可靠）。

  所以涉及 HA 进程管理与开机自启的动作，都在你自己的终端里做。
- **HA 的日志里没有 INFO 级启动横幅**。所以「日志零 ERROR」是主要健康信号，
  别因为看不到 `Starting Home Assistant` 就以为没起来 —— 用
  `approval ha status` 或 curl 一下 8123 更直接。
- **数日志错误一定要带时间戳前缀**。HA 的日志行形如
  `2026-09-19 00:15:44.779 ERROR (MainThread) [logger] ...`，行首是时间戳而不是
  级别，所以 `grep '^ERROR'` 永远匹配不到 —— 它会在有错的时候照样报「零 ERROR」。
  这个坑真的踩了：连续两次汇报「日志零 ERROR」，而日志里躺着一条 ffmpeg 报错。
- **分级只看命令文本的正则，所以「文本里提到危险命令」也会被当成危险命令。**
  实例：我往 `SETUP.md` 写一段说明，那段文本里带了一个 `dd` 写设备的字面量 ——
  结果**写文件这条命令本身**被判成 L3、推到手表、120 秒没人点然后被拒，
  文档一个字都没写进去。写 README、写 echo、写测试数据时都会遇到。
  这是纯文本分类的固有代价，**没有干净的修法**：先剥掉引号内容看起来能解，但会同时
  放过 `sh -c "sudo ..."` 这类真实风险，得不偿失。遇到了就：
  用 `Edit` 工具改文件（它被判 L1，不推送），或者把命令拆开写。
  正确写法是 `grep -cE '^[0-9-]+ [0-9:.]+ ERROR'`。
  （更普遍的教训：一个永远不会报失败的检查，比没有检查更危险。）
- **hook 是「会话启动那一刻」的快照 —— 所以已经开着的任务不会看到新写的 hook。**
  权威文档（`hooks.md` 第 789–794 行）明说：启动时捕获快照、整个会话用这份快照、
  外部修改只**发警告**、**需要在 `/hooks` 菜单审查才能应用**。实测：
  在 `settings.json` 里写入 hook 之后，**新起的任务立刻生效**（用一个一次性定时任务
  造了个全新会话来验证：探针命令一发出就被拦，**4.3 秒**后 `decidedBy: "ha"`），
  而**当时已经开着的任务里一点动静都没有**。这就是「其他任务不触发」的真正原因 ——
  不是配置错，是快照旧。修法与自检方法见 2.1.2。
- **「重启 HA」的语义完全取决于谁托管它 —— 这个坑真的把 HA 弄停过一次。**
  `POST /api/services/homeassistant/restart` 只是让 HA 进程 `return 100`
  （`homeassistant/__main__.py:184`），真正把它拉起来的是 **launchd 的 `KeepAlive`**。
  HA 若被 nohup / `run-detached.py` 拉起（没有 launchd 托管），这个请求等于
  **把它直接杀掉、没人再拉**。所以 `approval ha restart` 已统一走
  `net-doctor --restart-ha`：有托管就 `kickstart -k`，没托管就「停掉 → 重新拉起」，
  并**最后一定确认 8123 回来了**。用 `approval net` 可以查当前托管状态。详见 1.2.1。
- **同一个「重启」坑在网关上也有一份，已经一起修掉了。**
  `gateway-service.sh` 原先的 `restart` 在「作业未装载」时会转发给 `install`，
  而 `install` 是「先 `kill_stray` 杀掉正在跑的网关 → 再 `launchctl bootstrap`」——
  沙箱里 bootstrap 必失败，于是 `restart` 的实际效果是
  **「把网关杀掉，然后告诉你装载失败」**。现在 `restart` 就地脱管重启、不碰 launchctl；
  而 `install` 若 bootstrap 失败，也会**先脱管把网关拉回来再报错**。
  可复用的规则：**任何「重启外部服务」的自动化，都必须自己确认它回来了**，
  而且「这个服务是怎么被托管的」直接决定了重启请求的语义。
- **一条持久化错误曾经把整个网关进程带走 —— 定时器里不许有未捕获异常。**
  实测日志：

  ```
  Error: EPERM: operation not permitted, rename '.../pending.json.tmp' -> '.../pending.json'
      at Store._persist (src/core/store.mjs) ← renameSync 抛
      at Store.settle
      at Store.sweep                        ← 2 秒一次的 setInterval
      at Timeout._onTimeout (node:timers)
  ```

  后果不是「少存一条记录」，而是**网关死掉**：hook 全部走「网关不可达」分支
  （L2 一直问、L3 直接拒），用户体感是「我的命令突然全被拒了」，
  而终端上根本看不到那条真正的错误。修法分三层，都必要：

  1. `_persist()` / `_persistNonces()` / `audit()` **一律不抛** —— 原子改名不行就退化成
     直接覆盖写；都失败就大声抱怨并留着内存里的数据（审批不受影响，只是重启会丢）。
     审计写不进去也必须喊出来，**不许静默**。
  2. `sweep()` 再加一层 try/catch —— 周期任务因为一次意外就杀掉整个服务，
     是最不划算的失败方式。
  3. `gateway.mjs` 装了 `uncaughtException` / `unhandledRejection`：**记录 + 继续运行**。
     这是**故意选择「活着」而不是「干净地死」**：网关活着但状态有点脏 ⇒ 审批照常走、
     最多多点一次；网关死掉 ⇒ 所有危险操作被拒。失败模式要按「可用性 > 洁癖」排序。
     每一笔都会落到 stderr 和 `approval audit` 里（`event: "gateway_error"`），不是静默吞掉。

  回归测试在 `test/store-resilience.test.mjs`（26 项），
  用猴补丁确定性地制造 EPERM，并**特意断言「异常是被 `_persist` 内部兜住的」**——
  只断言「不抛」会让测试假绿（异常被外层 catch 接住也算不抛，但那样并没有修好）。
- **本地推送没有 fallback，这是本机推送链路的硬边界。**
  因为 Firebase 不可达（见 1.3.2），本机永远拿不到 `push_token` / `push_url`，
  只能靠「本地推送」这一条腿。HA 的 `mobile_app/notify.py` 是这样判断的：
  本地通道在 → 发过去并**等 10 秒**（`PUSH_CONFIRM_TIMEOUT`）要 App 回确认；
  没确认 → 拆掉通道 → 回退**远程推送** → 而远程推送要的两个键都不存在 →
  抛 `KeyError: 'push_token'`，**通知就此丢失，日志里只剩一条看不懂的 traceback**
  （HA 日志里确实躺着一条：`2026-09-19 01:08:48`）。
  ⇒ **判断「推送好不好」不能只看网关返回的 `pushOk`** —— 它只说明 HA 收下了这次
  服务调用，不代表落到了你设备上。要确认送达，看审计里有没有 `decidedBy: "ha"`。
  想根治只有换一条不依赖 Google 的通道（`src/channels/pushcut.mjs` 现成，
  国内也可以用 Bark 这类「自建服务器 + APNs」方案）。
- **控制流骨架会让「未被识别的命令」落到 L0**（取舍理由见第 3 节）。
  `for f in *; do frobnicate "$f"; done` 和 `cd ~ && frobnicate` 都不推送。
  这是**有意**的「噪音优先」取舍，不是漏判；`risk.test.mjs` 第 [7] 组把它钉住了，
  以后要收紧必须两处一起改。
- **多 hook 的执行顺序**。如果同一事件上还配了别的 hook 并且它会改写工具入参，
  理论上存在「我们批准的是 A，实际执行的是 B」的窗口。缓解办法：把本 hook 放在
  配置里的最后一条，并且只信任你亲自写的其他 hook。
- **长时间等待曾会把任务卡死（2026-09-19 已修）**。旧设计 `wait = ttl` 且
  `timeout: 180`，L2 默认 ttl 300s 时，宿主会在 180s 把 hook 杀掉、按「hook 超时」
  fail-closed 拒绝，而那张待确认卡还挂在网关里到 300s —— 现象就是「任务卡死
  两分钟后失败」。现在改成 **`wait: 0` + 本地轮询**（每 2s 轮询一次
  `GET /v1/approvals/<id>`），阻塞时长由 `BUDGET`（`APPROVAL_HOOK_BUDGET`，
  默认 150s）封顶，`timeout`（180）> `BUDGET`，所以宿主杀 hook 之前一定有结论。
  轮询端点返回里补了 `deviceName`，故「放行理由带设备信息」的断言仍然成立。
- **手表上的按钮由 iPhone 代发（已在源码确认，不再是猜测）**。
  `Sources/WatchApp/Notifications/WatchPushActionSender.swift` 的 `send()` 规则是：
  手机「立刻可达」就 `sendViaPhone` 把动作转发给手机去发（走 WatchConnectivity），
  只有够不着手机时才用自己那份服务器配置发（`api.handlePushAction`）。
  后果有两个：
  1. 蜂窝版手表脱离手机时的行为要实机验证；
  2. **HA 侧永远分不出这次点击来自手表还是手机** —— 两条路径用的是同一份 server 配置，
     报的都是手机那台设备的注册名（本机 `mobile_app_your_iphone`）。
     所以 `ha.mjs` 把 `deviceName` 留成 `null`，审计里只有 `source: "ha"` ——
     宁可不填，也不填一个看起来像真的、其实会误导排查的值。
- **通知动作事件只有 `action` 一个必需字段**，天然没有设备信息。
  iOS 一次点击会**同时**发两个事件：`ios.notification_action_fired`（带
  `sourceDeviceName` 等）和 `mobile_app_notification_action`（只有
  `action` / `action_data` / `reply_text`）。我们只订阅后者，理由见 1.5。
- **手表上不能打开 URL、不能跑快捷指令**。这是 watchOS 的限制，
  所以按钮只能走「后台 HTTP 请求」型动作，不能做成「打开链接」。
- 自建 iOS App + APNs 那条路的硬约束：`UNNotificationCategory` 的按钮标题
  必须预先注册，不能逐条动态，所以只能做固定几个选项（批准 / 拒绝 / 仅此一次 / 详情）。
- **iOS 不会把动作按钮摊在通知上 —— 必须「展开」才看得见，而 Apple 不给任何提示。**
  这正是反复收到的那个反馈「手机收到通知了，但通知上没有按钮可点」的根因。
  HA 官方文档（`actionable-notifications`）原话：

  > All devices support notification expanding by performing a right to left swipe and
  > pressing 'View' in the lock screen or pressing and holding. If you're not in the
  > lock screen, you can also pull the notification down to expand it.

  即三条路：锁屏上**从右往左滑**再点「查看」、**长按**、或（不在锁屏时）把通知**下拉**。
  **可操作通知与普通通知的外观完全一样** —— 没有任何线索告诉你需要展开它。
  而 **Apple Watch 反而直接把按钮显示出来**，所以现象就是
  「手表一直好用，手机找不到按钮」——「手表能用」并不代表「手机也能用」。
  两条应对已落到代码里：
  1. 通知正文尾部追加一行「长按这张卡片 → 展开「…」」（`expandHint()`），
     把「需要展开」这件事直接用文字说出来；
  2. 每个按钮配 SF Symbol 图标（须 `sfsymbols:` 前缀，仅 SF Symbols 库可用，
     需 iOS App ≥ 2021.10），展开后一眼分清 允许（勾）/ 拒绝（叉）/ 详情（i）。
  还有第三条退路：`data.url` 是**点通知主体**就能用的（不需要展开）。
  配上 `publicBaseUrl` 之后，点一下通知直接打开审批页并在页面上点按钮 —— 见 1.6。
- **`authenticationRequired: true` 会让按钮在锁屏上「看得见但点不动」。**
  官方文档：`If true, the device needs to be unlocked to use the action`。
  网关对 **L3 的每个按钮**都加了这一项（`ha.mjs` 里
  `if (record.tier === 'L3' || o.requireUnlock)`）—— 这是**有意的**安全设计，
  别为了「点起来方便」把它摘掉。
- **审计里「推送失败」曾经被记成「超时未确认」—— 已修，但值得记住这个教训。**
  现象：排障时看到一批 `expired / source=timeout`，于是往「用户没理它」的方向查，
  而真相是那些通知**压根没送出去**（实测 81 次 push_failed 被记成 90 条超时）。
  根因：hook 判定完就 `process.exit(0)` 走了，网关侧那条记录没人结算，
  要等自己的 sweeper 到 `expiresAt` 才落 `expired`。
  现在 hook 放弃等待时会主动 `POST /v1/approvals/<id>/cancel`，审计记
  `reason=cancelled` + `source=push-failed`：「没送到」和「送到了没人点」
  一眼可分。同一族的第二个洞是 `wait > 0` 的调用方（MCP `request_approval` 等）
  在推送失败时照样空等满 TTL —— 现在改成**立即结算**，实测 **120 秒 → 0.02 秒**。
  可复用的规则：**凡是「等一个可能永远不来的东西」，都要先判断它还有没有可能来。**

---

## 5. 目录结构

```
agent-approval/
├── src/
│   ├── gateway.mjs          确认中枢：签发、校验、审计、等待
│   ├── core/
│   │   ├── risk.mjs         L0-L3 分级引擎
│   │   ├── bind.mjs         动作哈希 / nonce / HMAC / 令牌编解码
│   │   ├── local-grant.mjs  推送失败时的一次性授权（签发/单次消费/签名/TTL，见 2.1.3）
│   │   └── store.mjs        待决持久化、等待者唤醒、JSONL 审计、会话白名单
│   └── channels/
│       ├── index.mjs        通道注册表
│       ├── mock.mjs         控制台（无需手机配置即可验证）
│       ├── ha.mjs           Home Assistant：REST 推送 + WS 事件回程 + 设备可收性探测
│       ├── device-readiness.mjs  「这台手机现在到底能不能收到」的判定与诊断话术（见 1.2.2）
│       └── pushcut.mjs      Pushcut 备选（后台 HTTP action 回程）
├── bin/approve-hook.mjs     hook 入口
├── bin/approval-confirm.mjs 本机一次性确认的签发/查看（approval confirm，见 2.1.3）
├── mcp/approval-mcp.mjs     MCP stdio 服务
├── scripts/
│   ├── verify-ha.mjs        HA 链路验证器（doctor 体检 / link 手表往返实测）
│   ├── probe-mdns.py        探测 HA 的 _home-assistant._tcp 广播（手机发现）
│   ├── net-doctor.mjs       推送链路体检（9 项：地址漂移 + 设备在线）+ 修复（approval net）
│   ├── run-detached.py      双 fork 脱离会话跑命令（等手表点击时必备，见 1.5）
│   ├── probe-tier.mjs       问「这条命令会被判成几级」+ 内置安全探针清单（见 2.1.2）
│   ├── gateway-service.sh   网关服务管理（install/uninstall/restart/status/logs/plist，见 2.1.1）
│   ├── netwatch-service.sh  地址漂移看门狗服务管理（每 120s 自检，坏了自动修，见 1.2.1）
│   └── ha-service.sh        HA 服务管理（install/uninstall/restart/status/logs）
├── logs/                    网关服务的 stdout/stderr（launchd 写，已 gitignore）
├── public/phone.html        手机模拟器 / 兜底确认页
├── test/
│   ├── risk.test.mjs        80 项风险分级回归（盯「无害命令被误判成要推送」的噪音）
│   ├── ha-channel.test.mjs  44 项 HA 通道单元测试（假 fetch，钉死请求形状）
│   ├── hook.test.mjs        61 项 hook 协议测试（真起子进程，喂真实 stdin；
│   │                        §9 覆盖「推送失败 → 拦住 → 本机确认 → 放行一次」全链，
│   │                        §10 钉死「改写 description 仍须命中」的回归）
│   ├── local-grant.test.mjs 66 项「本机一次性确认」状态机（签发 / 单次消费 / 绑定 /
│   │                        TTL / 签名篡改 / 写盘容错，全程临时目录；
│   │                        §13 钉死绑定只绑动作、不绑信封）
│   ├── net-doctor.test.mjs  35 项 net-doctor 纯函数测试（主机名大小写 / 注释不当配置 / 网段判定 / 重启判据）
│   ├── device-readiness.test.mjs  45 项设备可收性测试（判据 / 两个禁区 / 假警报防护）
│   ├── store-resilience.test.mjs  26 项存储容错测试（坏路径不许把网关进程带走）
│   ├── selftest.mjs         82 项端到端自检（分级 + 令牌 + hook + 会话白名单 + 留痕端点）
│   └── mcp-e2e.mjs          21 项 MCP 入口往返自测
└── data/                    密钥、待决快照、审计日志（不要提交）
```

## 6. 常用命令

```bash
# ── 日常：用 approval（任何目录都能跑）──────────────────────
approval gw                                # 起网关（前台）
approval test                              # 80 + 30 + 55 + 55 + 28 + 45 + 26 + 82 + 21 项自检
approval health                            # 通道是否就绪
approval pending                           # 当前待确认
approval audit 20                          # 最近 20 条审计
approval sessions                          # 被静默放行的都在这里（可撤）

# ── 推送失败时的兜底：本机一次性确认（见 2.1.3）────────────
approval confirm                           # 确认「最近一次被拦下的命令」，会先打印摘要
approval confirm --yes                     # 跳过追问直接签发（Agent 用）
approval confirm --list                    # 看当前有效的一次性授权
approval confirm --revoke                  # 收回全部（或 --revoke <短binding>）

# ── Home Assistant 链路 ──────────────────────────────────
approval doctor                            # 环境体检（不需要令牌）
approval link --token <令牌>                # 手表往返实测
approval mdns                              # 单独查局域网上能否发现 HA
approval net                               # 推送链路体检：地址漂移 + 手机 App 在不在线
approval net --repair                      # 发现漂移就重启 HA 重新广播
approval netwatch status                   # 看门狗装没装、修过几次
approval netwatch install                  # 装上看门狗（需你自己的终端）
approval ha status                         # HA 运行状态 + 日志 ERROR 数
approval ha restart                        # 重启 HA（内部走 net-doctor，确保它一定回得来）
approval ha logs                           # 实时跟日志
approval ha install                        # 设成开机自启（需你自己的终端）

# ── 「推送为什么没到」的三步定位 ─────────────────────────
approval net                               # ① 地址与设备：9 项体检，能直接指出是哪一层
approval audit 10                          #   ② 有没有 decidedBy: "ha"（有 → hook 与推送都通）
curl -s http://127.0.0.1:7788/healthz      #   ③ channelReady（传输）/ deviceReady（设备）分开看
approval tier "rm -rf /tmp/x"              #   ④ 命令到底会不会被判成要推送

# ── 直接看 HA 日志 ───────────────────────────────────────
tail -f ~/.homeassistant/home-assistant.log

# ── 等价的原始命令（必须先 cd 进项目目录）──────────────────
cd "$(approval dir)"
node src/gateway.mjs
node test/selftest.mjs
node test/mcp-e2e.mjs
node test/device-readiness.test.mjs
node test/store-resilience.test.mjs
node scripts/verify-ha.mjs doctor
node scripts/verify-ha.mjs link --token <令牌>
~/.ha-venv/bin/python3 scripts/probe-mdns.py
bash scripts/ha-service.sh status
```
