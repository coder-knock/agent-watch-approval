#!/bin/zsh
# 恢复三个 launchd 任务（在**普通终端**里跑，不要在 Agent 沙箱里跑 ——
# 沙箱里 launchctl bootstrap 会报 "Bootstrap failed: 5: Input/output error"）。
#
#   bash ~/WorkBuddy/agent-approval/scripts/restore-launchd.sh
#
# 2026-09-21 背景：
#   · netwatch 每 120 秒体检一次，发现 HA 的 mDNS 广播不见了就重启 HA；
#     而 Python 3.14 没有「本地网络」权限，广播永远修不好 → 死循环重启
#     → 每次退出触发 Python 3.14 收尾段错误弹窗。
#   · 已给 net-doctor 加熔断（连续 3 次修不好就冷却 6 小时，不再重启）。
#   · 已用 ~/.ha-venv（python3.13，有本地网络权限）写了广播代理，
#     代 HA 发 _home-assistant._tcp 广播。
set -u

AGENTS="$HOME/Library/LaunchAgents"
LABELS=(
  "cn.local.homeassistant"
  "cn.local.agent-approval-netwatch"
  "cn.local.ha-mdns-advertiser"
)

# HA 现在可能是「脱离 launchd 手动跑着的」实例：先停掉，再交给 launchd，
# 否则 launchd 拉起的第二个实例会撞上 "Please stop the existing instance"。
if ! launchctl print "gui/$(id -u)/cn.local.homeassistant" >/dev/null 2>&1; then
  pid="$(pgrep -f 'ha-venv314/bin/hass' | head -1)"
  if [ -n "${pid:-}" ]; then
    echo "→ HA 当前脱离 launchd 运行（pid $pid），先停掉再交给 launchd"
    kill "$pid" 2>/dev/null
    for _ in $(seq 1 20); do
      pgrep -f 'ha-venv314/bin/hass' >/dev/null 2>&1 || break
      sleep 1
    done
    pgrep -f 'ha-venv314/bin/hass' >/dev/null 2>&1 && kill -9 "$(pgrep -f 'ha-venv314/bin/hass' | head -1)" 2>/dev/null
  fi
fi

# 广播代理现在可能是我为了「立刻恢复广播」用 open -a 临时拉起的实例，
# 交给 launchd 之前先停掉，免得两个实例抢同一个服务名（会变成 "Agent Approval (2)"）。
pkill -f 'ha-mdns-advertiser' 2>/dev/null && echo "→ 已停掉临时拉起的广播代理实例"

for label in "${LABELS[@]}"; do
  plist="$AGENTS/$label.plist"
  [ -f "$plist" ] || { echo "⚠️  跳过 $label（没有 $plist）"; continue; }

  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null
  if launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null; then
    echo "✅ $label 已注册"
  else
    echo "❌ $label 注册失败（用 launchctl bootstrap gui/$(id -u) $plist 看详细报错）"
  fi
done

echo ""
echo "当前状态："
for label in "${LABELS[@]}"; do
  if launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
    echo "  ✅ $label"
  else
    echo "  ❌ $label"
  fi
done
