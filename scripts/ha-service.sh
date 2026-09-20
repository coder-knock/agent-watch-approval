#!/bin/bash
# Home Assistant 服务管理。
#
# 为什么需要这个脚本：WorkBuddy 的 Agent 会话运行在 macOS 沙箱里，而
# launchctl 的作业装载接口需要访问 com.apple.xpc.launchd 这个 mach 服务，
# 沙箱会拒绝 —— 表现为 launchctl bootstrap 报「Bootstrap failed: 5:
# Input/output error」（连 /bin/echo 这种最小作业都装不进去，可排除配置问题）。
# 所以「装成开机自启」这一步必须由你在自己的终端里执行。
#
# 用法：
#   bash scripts/ha-service.sh install     # 装成开机自启并立即启动
#   bash scripts/ha-service.sh uninstall   # 卸掉开机自启
#   bash scripts/ha-service.sh status      # 看运行状态与日志错误数
#   bash scripts/ha-service.sh restart     # 重启
#   bash scripts/ha-service.sh logs        # 实时跟日志

set -uo pipefail

LABEL="cn.local.homeassistant"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
HA_DIR="$HOME/.homeassistant"
VENV="$HOME/.ha-venv"
UID_NUM="$(id -u)"

c_ok()   { printf '\033[32m✅\033[0m %s\n' "$1"; }
c_bad()  { printf '\033[31m❌\033[0m %s\n' "$1"; }
c_warn() { printf '\033[33m⚠️ \033[0m %s\n' "$1"; }
c_dim()  { printf '\033[2m%s\033[0m\n' "$1"; }

port_up() {
  lsof -nP -iTCP:8123 -sTCP:LISTEN >/dev/null 2>&1
}

loaded() {
  launchctl print "gui/${UID_NUM}/${LABEL}" >/dev/null 2>&1
}

# 杀掉任何不属于 launchd 的 HA 实例（比如 Agent 用 detach 方式拉起来的），
# 否则端口被占，launchd 里的 HA 会立刻因为「已在运行」而退出。
kill_stray() {
  local pids
  pids="$(lsof -nP -iTCP:8123 -sTCP:LISTEN -t 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    c_warn "端口 8123 被占用（PID: $pids），先停掉它"
    for p in $pids; do kill "$p" 2>/dev/null || true; done
    for _ in $(seq 1 20); do port_up || break; sleep 0.5; done
    if port_up; then
      c_warn "普通停止无效，强制结束"
      for p in $pids; do kill -9 "$p" 2>/dev/null || true; done
      sleep 1
    fi
  fi
}

cmd_install() {
  if [ ! -f "$PLIST" ]; then
    c_bad "找不到 $PLIST"
    return 1
  fi
  if [ ! -x "$VENV/bin/hass" ]; then
    c_bad "找不到 $VENV/bin/hass，Home Assistant 可能没装好"
    return 1
  fi
  plutil -lint "$PLIST" >/dev/null || { c_bad "plist 格式有误"; return 1; }

  kill_stray

  # 已在载就先卸掉，保证用的是最新一份 plist
  launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true
  sleep 1

  if launchctl bootstrap "gui/${UID_NUM}" "$PLIST" 2>&1; then
    c_ok "已装载 $LABEL"
  else
    c_bad "装载失败。若报 Bootstrap failed: 5，说明这次也是在一个受限环境里跑的 —— 请在普通终端重试。"
    return 1
  fi

  printf '   等待 Home Assistant 就绪'
  for i in $(seq 1 60); do
    if port_up; then printf '\n'; c_ok "8123 已监听（约 ${i}s）"; break; fi
    printf '.'
    sleep 1
  done
  port_up || { printf '\n'; c_bad "60 秒内没起来，看日志：bash scripts/ha-service.sh logs"; return 1; }

  echo
  c_ok "已设成开机自启。重启 Mac 后会自动拉起。"
  c_dim "   网页：  http://localhost:8123"
  c_dim "   卸载：  bash scripts/ha-service.sh uninstall"
}

cmd_uninstall() {
  launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null && c_ok "已卸载 $LABEL" || c_warn "本来就没装载"
  kill_stray
  c_dim "plist 文件保留在 $PLIST，需要彻底删除请手动 rm。"
}

cmd_restart() {
  # ⚠️ 不要走「launchctl kickstart，失败就退回 install」这条老路：
  #   · install 里是 launchctl bootstrap —— 沙箱里必然失败（Bootstrap failed: 5）；
  #   · 而「请求 HA 自己重启」（POST /api/services/homeassistant/restart）更危险：
  #     homeassistant/__main__.py 第 184 行只是 `return RESTART_EXIT_CODE`，
  #     真正把它拉起来的是 launchd 的 KeepAlive。**没有托管时那个请求等于把它杀掉**，
  #     实测就这么把 HA 弄停过一次（端口再没回来）。
  # 所以统一交给 net-doctor 的唯一一份重启实现：有托管就 kickstart，
  # 没托管就「停掉再拉起」，并且最后一定确认 8123 回来了。
  exec /opt/homebrew/bin/node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/net-doctor.mjs" --restart-ha
}

cmd_status() {
  echo
  if loaded; then c_ok "$LABEL 已装载"; else c_warn "$LABEL 未装载（当前实例可能是临时启动的）"; fi

  if port_up; then
    c_ok "8123 正在监听"
    local code
    code="$(curl -s --max-time 4 -o /dev/null -w '%{http_code}' http://127.0.0.1:8123/onboarding.html 2>/dev/null)"
    case "$code" in
      200) c_ok "前端可访问（/onboarding.html → 200）" ;;
      000) c_bad "端口开着但 HTTP 无响应" ;;
      *)   c_warn "前端返回 $code" ;;
    esac
  else
    c_bad "8123 没有监听 —— Home Assistant 没在跑"
  fi

  local log="$HA_DIR/home-assistant.log"
  if [ -f "$log" ]; then
    # ⚠️ 匹配模式必须带时间戳前缀。HA 的日志行形如
    #    2026-09-19 00:21:53.140 WARNING (MainThread) [logger] ...
    # 行首是时间戳而不是级别，所以 `grep '^ERROR'` 永远匹配不到任何东西 ——
    # 它会让体检脚本在所有情况下都欢快地报「零 ERROR」，把真实故障掩盖掉。
    # 这个坑实际踩过一次：连续两次汇报「日志零 ERROR」，而日志里明明有报错。
    local pat='^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:.]+ ERROR'
    # 同理，grep -c 零匹配时会既打印 0 又返回退出码 1，
    # 所以这里只能 `|| true`，不能 `|| echo 0`（会多出一行）。
    local n
    n="$(grep -cE "$pat" "$log" 2>/dev/null || true)"
    n="${n:-0}"
    if [ "$n" = "0" ]; then c_ok "日志零 ERROR"
    else
      c_bad "日志有 $n 条 ERROR（最近 5 条）："
      grep -E "$pat" "$log" | tail -5 | sed 's/^/     /'
    fi
  else
    c_warn "找不到日志 $log"
  fi
  echo
}

cmd_logs() {
  exec tail -f "$HA_DIR/home-assistant.log"
}

case "${1:-status}" in
  install)   cmd_install ;;
  uninstall) cmd_uninstall ;;
  restart)   cmd_restart ;;
  status)    cmd_status ;;
  logs)      cmd_logs ;;
  *)
    echo "用法：bash scripts/ha-service.sh {install|uninstall|restart|status|logs}"
    exit 2
    ;;
esac
