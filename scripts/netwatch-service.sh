#!/bin/bash
# 局域网地址漂移看门狗：定时体检，发现 HA 广播的地址与本机当前地址不一致就自动修。
#
# 为什么需要它：HA 的 zeroconf 集成**只在启动那一刻**注册一次 mDNS 广播
# （components/zeroconf/__init__.py: async_setup → _async_get_local_service_info
# → async_register_service），全文件没有地址变化监听。所以 Mac 换了 Wi-Fi、
# 换了网段、被路由器重新分配 IP 之后，广播里的地址会一直停在旧值，直到 HA 重启。
# 期间 iPhone 上 HA App 拿着旧地址连不上 → 本地推送建不起来 → notify 全部 500
# → 手表收不到确认卡片。
#
# 这个脚本把「重启 HA 让广播跟上」这件事变成自动的：
#   StartInterval 120 秒跑一次 net-doctor.mjs --once
#   没漂移 → 一声不吭退出
#   有漂移 → 自动重启 HA 重新广播，并记一行日志到 logs/net-watch.log
#
# 注意：HA 重启动作本身由 net-doctor 负责「确保 HA 活着」（它会在没有 launchd
# 托管时改用「停掉再拉起」的路径）—— 详见 net-doctor.mjs 里 repair 那一段注释。
#
# 用法：
#   bash scripts/netwatch-service.sh install     # 装成定时任务（必须在普通终端跑）
#   bash scripts/netwatch-service.sh uninstall
#   bash scripts/netwatch-service.sh status
#   bash scripts/netwatch-service.sh run         # 立刻手动跑一次（等价 approval net --once）

set -uo pipefail

LABEL="cn.local.agent-approval-netwatch"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
DIR="${AGENT_APPROVAL_DIR:-/path/to/agent-approval}"
NODE="/opt/homebrew/bin/node"
UID_NUM="$(id -u)"
INTERVAL="${NETWATCH_INTERVAL:-120}"

c_ok()   { printf '\033[32m✅\033[0m %s\n' "$1"; }
c_bad()  { printf '\033[31m❌\033[0m %s\n' "$1"; }
c_warn() { printf '\033[33m⚠️ \033[0m %s\n' "$1"; }
c_dim()  { printf '\033[2m%s\033[0m\n' "$1"; }

write_plist() {
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <!-- 跑一次体检；有漂移就自动修。--once 让它平时保持安静。 -->
    <key>ProgramArguments</key>
    <array>
        <string>${NODE}</string>
        <string>${DIR}/scripts/net-doctor.mjs</string>
        <string>--once</string>
        <string>--repair</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${DIR}</string>

    <!-- 每 ${INTERVAL} 秒一次。改频率：编辑这个 plist 的 StartInterval。 -->
    <key>StartInterval</key>
    <integer>${INTERVAL}</integer>

    <key>RunAtLoad</key>
    <true/>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>

    <key>StandardOutPath</key>
    <string>${DIR}/logs/netwatch-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${DIR}/logs/netwatch-stderr.log</string>
</dict>
</plist>
PLIST_EOF
}

cmd_install() {
  [ -x "$NODE" ] || { c_bad "找不到 $NODE"; return 1; }
  [ -f "$DIR/scripts/net-doctor.mjs" ] || { c_bad "找不到 net-doctor.mjs"; return 1; }

  write_plist
  plutil -lint "$PLIST" >/dev/null || { c_bad "plist 格式有误"; return 1; }
  c_ok "已生成 $PLIST（每 ${INTERVAL}s 一次）"

  launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true
  sleep 1

  if launchctl bootstrap "gui/${UID_NUM}" "$PLIST" 2>&1; then
    c_ok "已装载 $LABEL"
  else
    c_bad "装载失败。若报 Bootstrap failed: 5，说明这次是在受限环境里跑的 —— 请在普通终端重试。"
    c_dim "   手动安装：launchctl bootstrap gui/${UID_NUM} $PLIST"
    return 1
  fi

  echo
  c_ok "看门狗已上线：HA 广播地址一旦跟不上本机 IP，120 秒内自动重启 HA 修好。"
  c_dim "   日志： tail -f $DIR/logs/net-watch.log"
  c_dim "   卸载： bash scripts/netwatch-service.sh uninstall"
}

cmd_uninstall() {
  launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null \
    && c_ok "已卸载 $LABEL" || c_warn "本来就没装载"
  c_dim "plist 文件保留在 $PLIST，需要彻底删除请手动 rm。"
}

cmd_status() {
  echo
  if launchctl print "gui/${UID_NUM}/${LABEL}" >/dev/null 2>&1; then
    c_ok "$LABEL 已装载"
    launchctl print "gui/${UID_NUM}/${LABEL}" 2>/dev/null \
      | grep -E 'state =|last exit code|runs =' | sed 's/^/   /'
  else
    c_warn "$LABEL 未装载 —— 地址漂移不会被自动修"
    c_dim "   装上：bash scripts/netwatch-service.sh install"
  fi

  local log="$DIR/logs/net-watch.log"
  echo
  if [ -f "$log" ]; then
    c_ok "最近几条修复记录（$log）："
    tail -5 "$log" | sed 's/^/   /'
  else
    c_dim "还没有修复记录（$log 不存在）—— 要么没漂移过，要么还没装。"
  fi
  echo
}

cmd_run() {
  exec "$NODE" "$DIR/scripts/net-doctor.mjs" --once "$@"
}

case "${1:-status}" in
  install)   cmd_install ;;
  uninstall) cmd_uninstall ;;
  status)    cmd_status ;;
  run)       shift; cmd_run "$@" ;;
  plist)     write_plist; plutil -lint "$PLIST" && c_ok "已生成并校验：$PLIST" ;;
  *)
    echo "用法：bash scripts/netwatch-service.sh {install|uninstall|status|run|plist}"
    exit 2
    ;;
esac
