#!/usr/bin/env python3
"""代 Home Assistant 发 mDNS 广播（_home-assistant._tcp.local.）。

为什么需要这个东西
------------------
HA 自己跑在 Python 3.14 的 venv（~/.ha-venv314）里，而 macOS 的「本地网络」
权限只发给了 python3.13 —— 3.14 那个二进制没被授权，launchd 后台任务又永远
不会弹授权框，于是 HA 的 zeroconf 组播包被内核静默丢弃：
  · HA 日志里能看到「Sending to (224.0.0.251, 5353)」且**不报错**，
    但网络上抓不到任何一个包；
  · iPhone 上的 HA App「搜索服务器」永远搜不到；
  · netwatch 体检判定「广播=(无)→地址漂移」，每 120 秒重启一次 HA。

所以这里用一个**已经被授权的解释器**（~/.ha-venv/bin/python3，3.13）来发
同样的广播。它只是个「广播代理」：HA 本体照旧跑 3.14，HTTP/WebSocket/推送
全都不经过这里。

用法
----
    ~/.ha-venv/bin/python3 scripts/ha-mdns-advertiser.py

退出码：0 = 正常退出；1 = 启动失败（缺依赖 / 拿不到 HA 信息）。
"""

import argparse
import json
import os
import socket
import sys
import time
import urllib.request

TYPE = '_home-assistant._tcp.local.'
HA_BASE = 'https://localhost:8123'
CONFIG_JSON = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'config.json'
)


def log(msg):
    print(f'[ha-mdns] {time.strftime("%Y-%m-%d %H:%M:%S")} {msg}', flush=True)


def get_token():
    try:
        with open(CONFIG_JSON, encoding='utf-8') as fh:
            return json.load(fh)['channels']['ha']['token']
    except Exception as exc:  # noqa: BLE001
        log(f'读不到 HA 令牌（{exc}），广播里将不带 internal_url')
        return ''


def _ssl_context():
    """HA 用的是自签证书，必须带上它自己的 CA，否则 CERTIFICATE_VERIFY_FAILED。"""
    import ssl

    ca = os.path.join(os.path.expanduser('~/.homeassistant'), 'ssl', 'hass-ca.pem')
    try:
        return ssl.create_default_context(cafile=ca)
    except Exception:  # noqa: BLE001
        return ssl._create_unverified_context()  # noqa: SLF001


def ha_get(path_, token):
    req = urllib.request.Request(
        f'{HA_BASE}{path_}', headers={'Authorization': f'Bearer {token}'}
    )
    with urllib.request.urlopen(req, timeout=10, context=_ssl_context()) as resp:
        return json.loads(resp.read().decode('utf-8'))


def instance_uuid():
    """/api/config 里没有 uuid，HA 自己的实例 id 存在 .storage/core.uuid。"""
    p = os.path.join(os.path.expanduser('~/.homeassistant'), '.storage', 'core.uuid')
    try:
        with open(p, encoding='utf-8') as fh:
            return json.load(fh)['data']['uuid']
    except Exception:  # noqa: BLE001
        return ''


def local_ipv4():
    """拿出口网卡的 IPv4（不发包的那种，避免又踩一次路由问题）。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('192.168.31.1', 1))
        return s.getsockname()[0]
    except OSError:
        return '127.0.0.1'
    finally:
        s.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--interval', type=float, default=60.0,
                    help='重新核对 HA 信息并刷新的间隔（秒）')
    args = ap.parse_args()

    try:
        from zeroconf import ServiceInfo, Zeroconf
    except ImportError as exc:
        log(f'缺少 zeroconf 依赖：{exc} —— 请用 ~/.ha-venv/bin/python3 运行')
        return 1

    token = get_token()
    zc = Zeroconf()
    registered_name = None
    last_sig = None

    try:
        while True:
            try:
                cfg = ha_get('/api/config', token) if token else {}
            except Exception as exc:  # noqa: BLE001
                log(f'读 HA 配置失败（HA 还没起来？）：{exc}')
                cfg = {}

            # 第一次拿不到就快速重试（最多 10 秒），别让首播的 TXT 缺字段 ——
            # mDNS 的 TXT 缓存 TTL 是 75 分钟，首播缺了要等很久才刷得过来。
            if not cfg and token:
                for _ in range(5):
                    time.sleep(2)
                    try:
                        cfg = ha_get('/api/config', token)
                    except Exception:  # noqa: BLE001
                        cfg = {}
                    if cfg:
                        log('重试后拿到了 HA 配置')
                        break

            ip = local_ipv4()
            props = {
                'location_name': cfg.get('location_name') or 'Agent Approval',
                'uuid': cfg.get('uuid') or instance_uuid(),
                'version': cfg.get('version') or '',
                'external_url': cfg.get('external_url') or '',
                'internal_url': cfg.get('internal_url')
                or f'http://{socket.gethostname().split(".")[0]}.local:8123',
                'base_url': cfg.get('internal_url') or '',
            }
            props['base_url'] = props['external_url'] or props['internal_url']
            name = f"{props['location_name'].replace('.', ' ')}.{TYPE}"
            sig = (name, ip, json.dumps(props, sort_keys=True))

            if sig != last_sig:
                if registered_name:
                    try:
                        zc.unregister_service(
                            ServiceInfo(TYPE, registered_name)
                        )
                    except Exception:  # noqa: BLE001
                        pass
                info = ServiceInfo(
                    TYPE,
                    name,
                    addresses=[socket.inet_aton(ip)],
                    port=8123,
                    properties=props,
                    server=f"{cfg.get('uuid') or 'ha'}.local.",
                )
                try:
                    zc.register_service(info)
                    registered_name = name
                    last_sig = sig
                    log(f'已广播 {name} → {ip}:8123（internal_url={props["internal_url"]}）')
                except Exception as exc:  # noqa: BLE001
                    log(f'注册失败：{exc}')

            time.sleep(args.interval)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            zc.unregister_all_services()
        except Exception:  # noqa: BLE001
            pass
        zc.close()
        log('已停止广播')

    return 0


if __name__ == '__main__':
    sys.exit(main())
