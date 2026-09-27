#!/bin/bash
# 确认网关（agent-approval gateway）的后台服务管理。
#
# 为什么需要这个脚本：网关原先是在某个 Agent 会话里用 run-detached.py 拉起来的，
# 那种进程**重启 Mac 就没了**。而 hook 是全局生效的 —— 网关一没，所有 L2/L3 的命令
# 都会走到「网关不可达」分支（L2 降级 ask、L3 fail-closed deny），要么一直问你、
# 要么直接把你自己的命令拒掉。所以网关必须是个开机自启的守护进程。
#
# ⚠️ 与 ha-service.sh 同样的限制：WorkBuddy 的 Agent 会话跑在 macOS 沙箱里，
# launchctl 的 bootstrap 需要 com.apple.xpc.launchd 这个 mach 服务，沙箱会拒绝，
# 报「Bootstrap failed: 5: Input/output error」（连 /bin/echo 这种最小作业都装不进去，
# 所以可以排除是配置写错）。**install / uninstall 必须由你在自己的终端里跑。**
# status / logs 在沙箱里可以正常用。
#
# 用法：
#   bash scripts/gateway-service.sh install     # 装成开机自启并立即启动
#   bash scripts/gateway-service.sh uninstall   # 卸掉（不会杀你手动起的进程）
#   bash scripts/gateway-service.sh restart     # 重启
#   bash scripts/gateway-service.sh status      # 看状态（含端到端链路自检）
#   bash scripts/gateway-service.sh logs        # 实时跟日志
#   bash scripts/gateway-service.sh plist       # 只生成+校验 plist，不装载（用于检查配置）

set -uo pipefail

LABEL="cn.local.agent-approval-gateway"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="/opt/homebrew/bin/node"
LOGDIR="$DIR/logs"
OUT="$LOGDIR/gateway.out.log"
ERR="$LOGDIR/gateway.err.log"
PORT=7788
UID_NUM="$(id -u)"

c_ok()   { printf '\033[32m✅\033[0m %s\n' "$1"; }
c_bad()  { printf '\033[31m❌\033[0m %s\n' "$1"; }
c_warn() { printf '\033[33m⚠️ \033[0m %s\n' "$1"; }
c_dim()  { printf '\033[2m%s\033[0m\n' "$1"; }

port_up()   { lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; }
loaded()    { launchctl print "gui/${UID_NUM}/${LABEL}" >/dev/null 2>&1; }
healthz()   { curl -s --max-time 4 "http://127.0.0.1:$PORT/healthz" 2>/dev/null; }

# 自签 TLS 的 CA 路径（没有就输出空）—— 取自 config.json，配置是单一真源。
#
# 为什么必须有这个函数
# --------------------
# HA 自 2026-09-20 起在 8123 上启用了 HTTPS，用的是**自签 CA**。
# node 的 fetch / WebSocket（undici）只认系统根证书，不信任自签 CA，
# 于是每一次推送都失败，而报错只有一句话 —— `TypeError: fetch failed`
# （真因 `UNABLE_TO_VERIFY_LEAF_SIGNATURE` 藏在 `err.cause` 里）。
#
# 而 NODE_EXTRA_CA_CERTS **只能在进程启动那一刻生效**，没法在代码里补。
# 所以每条启动路径都得带上它，漏一条 = 那条路径上推送静默失效：
#   ① launchd（write_plist 生成 plist 时注入）
#   ② launchctl 不可用时的脱管兜底（spawn_detached 里 export）
# 实测就踩到过 ② —— 网关当时是脱管跑着的，plist 改了完全不生效。
#
# 用 plutil 取值（它在现代 macOS 上能直接读 JSON），避免为了读一个字段
# 引入 jq / python 依赖。
ca_file() {
  [ -f "$DIR/config.json" ] || return 0
  plutil -extract channels.ha.caFile raw -o - "$DIR/config.json" 2>/dev/null || true
}

# 清掉任何不在 launchd 名下的网关实例。
# 必须先做：端口被占时，launchd 拉起的那个会立刻因「地址已在使用」退出，
# 而 KeepAlive 会让它每 10 秒重试一次 —— 表现为「装好了但一直起不来」。
kill_stray() {
  local pids
  pids="$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null || true)"
  [ -z "$pids" ] && return 0
  c_warn "端口 $PORT 被非 launchd 进程占用（PID: $pids），先停掉"
  c_dim  "   （该进程里未结算的待确认记录会丢；已结算的审计不受影响）"
  for p in $pids; do kill "$p" 2>/dev/null || true; done
  for _ in $(seq 1 20); do port_up || break; sleep 0.5; done
  if port_up; then
    c_warn "普通停止无效，强制结束"
    for p in $pids; do kill -9 "$p" 2>/dev/null || true; done
    sleep 1
  fi
}

write_plist() {
  mkdir -p "$LOGDIR"

  # 自签 TLS 的 CA —— 见下面 ca_file() 的说明。
  # 这段必须由本函数自己生成：`install` 会**整个重写** plist，
  # 手工往 plist 里加的变量会被无声冲掉（踩过一次）。
  local ca ca_block=""
  ca="$(ca_file)"
  if [ -n "$ca" ]; then
    ca_block="        <key>NODE_EXTRA_CA_CERTS</key>
        <string>${ca}</string>"
  fi

  cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${NODE}</string>
        <string>${DIR}/src/gateway.mjs</string>
    </array>

    <!-- config.json 里的 dataDir 是相对路径 ./data，所以工作目录必须是项目根 -->
    <key>WorkingDirectory</key>
    <string>${DIR}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
${ca_block}
    </dict>

    <key>LimitLoadToSessionType</key>
    <array>
        <string>Aqua</string>
        <string>Background</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <!-- 崩了自动拉起。注意 KeepAlive 与端口冲突是相互放大的：
         若端口被别的进程占着，这个作业会每 ThrottleInterval 秒重试一次。 -->
    <key>KeepAlive</key>
    <true/>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>ExitTimeOut</key>
    <integer>10</integer>

    <key>StandardOutPath</key>
    <string>${OUT}</string>

    <key>StandardErrorPath</key>
    <string>${ERR}</string>
</dict>
</plist>
PLISTEOF
}

# 用 run-detached.py 把网关双 fork 脱离当前会话拉起。
#
# ⚠️ 这是「launchctl 用不了」时的兜底，存在的理由和 ha-service.sh 那边一模一样：
# 脚本里先 kill_stray 再 launchctl bootstrap，而沙箱里 bootstrap 必失败 ——
# 如果不兜底，就等于**把网关杀掉之后没人再拉**。
# 而网关一死，所有 L2/L3 命令都会走「网关不可达」分支（L2 一直问你、L3 直接拒）。
# 「重启外部服务的自动化，必须自己确认它回来了」—— 这条教训在 HA 那边踩过一次，
# 不要在网关这边再踩第二次。
spawn_detached() {
  local log="$LOGDIR/gateway-detached.log"
  mkdir -p "$LOGDIR"

  # HA 用自签证书时，必须在这里注入 CA —— 脱管进程不读 plist，
  # 不注入就等于推送一直报「fetch failed」而看不出原因。见 ca_file()。
  local ca
  ca="$(ca_file)"
  if [ -n "$ca" ]; then
    if [ -f "$ca" ]; then
      export NODE_EXTRA_CA_CERTS="$ca"
    else
      c_warn "config 里的 caFile 不存在：$ca（HTTPS 会握手失败）"
    fi
  fi

  /usr/bin/python3 "$DIR/scripts/run-detached.py" \
    --cd "$DIR" --log "$log" -- "$NODE" "$DIR/src/gateway.mjs" >/dev/null 2>&1 || true
  local i
  for i in $(seq 1 40); do
    if port_up; then return 0; fi
    sleep 0.5
  done
  return 1
}

cmd_install() {
  [ -x "$NODE" ] || { c_bad "找不到 $NODE"; return 1; }
  [ -f "$DIR/src/gateway.mjs" ] || { c_bad "找不到 $DIR/src/gateway.mjs"; return 1; }
  [ -f "$DIR/config.json" ] || { c_bad "找不到 $DIR/config.json —— 先复制 config.example.json 并填令牌"; return 1; }

  write_plist
  plutil -lint "$PLIST" >/dev/null || { c_bad "plist 格式有误"; return 1; }

  kill_stray
  launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true   # 已在载就先卸，保证用最新 plist
  sleep 1

  if launchctl bootstrap "gui/${UID_NUM}" "$PLIST" 2>&1; then
    c_ok "已装载 $LABEL"
  else
    # 装载失败（最常见：在沙箱/受限环境里跑，报 Bootstrap failed: 5）。
    # 此时网关已经被 kill_stray 杀掉了 —— **必须先把它拉回来再报错**，
    # 否则用户拿到一句「装载失败」，而环境里其实已经没网关了，
    # 接下来每条 L2/L3 命令都会被拒，症状和原因完全对不上。
    c_warn "装载失败（受限环境里 launchctl 不可用）。已自动改用脱管方式把网关拉起来。"
    if spawn_detached; then
      c_ok "网关已在跑（脱管方式，重启 Mac 后不会自动起）"
      c_dim "   要真正开机自启，请在**普通终端**里重跑：bash scripts/gateway-service.sh install"
      echo
      cmd_status
      return 0
    fi
    c_bad "装载失败，而且脱管拉起也没成功 —— 现在没有网关在跑！"
    c_dim "   手动起一个：  $NODE $DIR/src/gateway.mjs"
    return 1
  fi

  printf '   等待网关就绪'
  local i
  for i in $(seq 1 30); do
    if port_up; then printf '\n'; c_ok "$PORT 已监听（约 ${i}s）"; break; fi
    printf '.'; sleep 1
  done
  port_up || { printf '\n'; c_bad "30 秒内没起来，看日志：bash scripts/gateway-service.sh logs"; return 1; }

  echo
  local h; h="$(healthz)"
  if [ -n "$h" ]; then c_ok "健康检查：$h"; else c_warn "端口开着但 /healthz 无响应"; fi

  echo
  c_ok "已设成开机自启。重启 Mac 后会自动拉起。"
  c_dim "   状态：  bash scripts/gateway-service.sh status"
  c_dim "   卸载：  bash scripts/gateway-service.sh uninstall"
  echo
  c_warn "还差一步：Home Assistant 也必须是自启的，否则卡片推不出去。"
  c_dim "   检查：  launchctl print gui/${UID_NUM}/cn.local.homeassistant >/dev/null && echo 已装载 || echo 未装载"
  c_dim "   安装：  bash scripts/ha-service.sh install"
}

cmd_uninstall() {
  if launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null; then c_ok "已卸载 $LABEL"; else c_warn "本来就没装载"; fi
  c_dim "plist 文件保留在 $PLIST，需要彻底删除请手动 rm。"
  c_dim "注意：这里**不会**去杀你手动起的网关 —— 若还占着 $PORT，那是你自己的进程。"
}

cmd_restart() {
  if loaded; then
    launchctl kickstart -k "gui/${UID_NUM}/${LABEL}" && c_ok "已重启" || c_bad "重启失败"
  else
    # ⚠️ 这里**不再**转发给 cmd_install。
    #
    # 原先的写法是「没装载 → 走 install」，而 install 会先 kill_stray 再 bootstrap。
    # 在受限环境里 bootstrap 必失败 —— 于是 `restart` 的实际效果是
    # 「把网关杀掉，然后告诉你装载失败」。用户想重启，得到的是停服。
    #
    # 「restart 的语义就是把正在跑的那个换个新的」，所以这里就地脱管重启，
    # 不去碰 launchctl；要开机自启，那是 install / autostart 的事。
    c_warn "作业未装载 —— 就地脱管重启（不碰 launchctl，避免受限环境里把网关弄停）"
    kill_stray
    if spawn_detached; then
      local pid; pid="$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null | head -1)"
      c_ok "已重启（PID ${pid:-?}）"
      c_dim "   要开机自启，请在**普通终端**里跑：bash scripts/gateway-service.sh install"
    else
      c_bad "重启失败 —— 现在没有网关在跑！"
      c_dim "   手动起一个：  $NODE $DIR/src/gateway.mjs"
      return 1
    fi
  fi
  sleep 2
  cmd_status
}

cmd_status() {
  echo
  if loaded; then c_ok "$LABEL 已装载（开机自启生效）"
  else c_warn "$LABEL 未装载 —— 当前实例是临时拉起的，重启 Mac 就没了"; fi

  if port_up; then
    local pid; pid="$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null | head -1)"
    c_ok "$PORT 正在监听（PID $pid）"
  else
    c_bad "$PORT 没有监听 —— 网关没在跑。hook 会走「网关不可达」分支（L2 问你、L3 直接拒）"
    echo
    return
  fi

  local h; h="$(healthz)"
  if [ -z "$h" ]; then
    c_bad "/healthz 无响应"
  else
    # 用 node 解析，避免依赖 jq
    "$NODE" -e '
      let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        let j; try { j = JSON.parse(s); } catch { console.log("❌ /healthz 不是合法 JSON：" + s); process.exit(0); }
        console.log("✅ 通道 " + j.channel + "｜就绪 " + j.channelReady + "｜待确认 " + j.pending);
        if (j.channel === "ha" && j.channelReady !== true)
          console.log("⚠️  HA 通道未就绪 —— 卡片发不出去");
        if (j.pending > 0)
          console.log("⚠️  有 " + j.pending + " 条待确认卡在队列里");
      })' <<< "$h"
  fi

  # HA 也要活着，否则网关「发送成功」只是 HA 收下了，不代表送达（HA 的 notify 是异步的）
  if lsof -nP -iTCP:8123 -sTCP:LISTEN >/dev/null 2>&1; then
    c_ok "Home Assistant（8123）在跑"
  else
    c_bad "Home Assistant（8123）没在跑 —— 确认卡片无法送达手机/手表"
  fi

  echo
  if [ -f "$ERR" ] && [ -s "$ERR" ]; then
    echo "最近 3 条网关错误输出："
    tail -3 "$ERR" | sed 's/^/     /'
  else
    c_dim "（网关错误日志为空）"
  fi
  echo
}

cmd_logs() {
  if [ -f "$OUT" ] || [ -f "$ERR" ]; then
    exec tail -f "$OUT" "$ERR" 2>/dev/null
  fi
  c_bad "还没有日志文件 $OUT —— 先用 install 启动服务"
  return 1
}

# 只写盘 + 校验，不碰 launchctl。给「先看一眼要装什么」和受限环境下的验证用。
cmd_plist() {
  write_plist
  plutil -lint "$PLIST" || { c_bad "plist 格式有误"; return 1; }
  c_ok "已生成并校验：$PLIST"
  c_dim "（未装载。要真正生效请在普通终端跑 install）"
  echo
  cat "$PLIST"
}

case "${1:-status}" in
  install)   cmd_install ;;
  uninstall) cmd_uninstall ;;
  restart)   cmd_restart ;;
  status)    cmd_status ;;
  logs)      cmd_logs ;;
  plist)     cmd_plist ;;
  *)
    echo "用法：bash scripts/gateway-service.sh {install|uninstall|restart|status|logs|plist}"
    exit 2
    ;;
esac
