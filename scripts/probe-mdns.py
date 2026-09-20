#!/usr/bin/env python3
"""确认 Home Assistant 在局域网里的 mDNS 广播是否可见。

为什么单独做这个探针：iPhone 上 HA App 的「搜索服务器」靠的就是
_home-assistant._tcp.local. 这条广播。如果 HA 的 zeroconf 集成没加载，
HA 在网页和本机一切正常，但手机永远搜不到 —— 这种「一半正常」的故障
只看日志和端口是查不出来的。

退出码：0 = 找到广播，1 = 没找到，2 = 跑不起来（缺少依赖等）。

用法：
    ~/.ha-venv/bin/python3 scripts/probe-mdns.py
    ~/.ha-venv/bin/python3 scripts/probe-mdns.py --json
    ~/.ha-venv/bin/python3 scripts/probe-mdns.py --timeout 12
"""

import argparse
import asyncio
import json
import socket
import sys

TYPE = "_home-assistant._tcp.local."


def _fmt_addr(raw: bytes) -> str:
    try:
        fam = socket.AF_INET if len(raw) == 4 else socket.AF_INET6
        return socket.inet_ntop(fam, raw)
    except Exception:
        return repr(raw)


def _decode(v):
    return v.decode("utf-8", "replace") if isinstance(v, (bytes, bytearray)) else str(v)


async def run(timeout: float):
    # 延迟导入：缺包时给出明确的退出码而不是 traceback
    from zeroconf import ServiceStateChange
    from zeroconf.asyncio import (
        AsyncServiceBrowser,
        AsyncServiceInfo,
        AsyncZeroconf,
    )

    found_names = set()

    def on_change(zeroconf=None, service_type=None, name=None,
                  state_change=None, **_kw):
        if state_change is ServiceStateChange.Added and name:
            found_names.add(name)

    azc = AsyncZeroconf()
    browser = AsyncServiceBrowser(azc.zeroconf, TYPE, handlers=[on_change])
    await asyncio.sleep(timeout)
    await browser.async_cancel()

    results = []
    for name in sorted(found_names):
        info = AsyncServiceInfo(TYPE, name)
        if not await info.async_request(azc.zeroconf, 4000):
            results.append({"name": name, "error": "信息请求超时"})
            continue
        props = {
            _decode(k): _decode(v)
            for k, v in (info.properties or {}).items()
            if _decode(v)
        }
        results.append({
            "name": name,
            "addresses": [_fmt_addr(a) for a in info.addresses],
            "port": info.port,
            "properties": props,
        })

    await azc.async_close()
    return results


def main():
    ap = argparse.ArgumentParser(description="探测 HA 的 mDNS 广播")
    ap.add_argument("--timeout", type=float, default=8.0,
                    help="监听秒数，默认 8")
    ap.add_argument("--json", action="store_true", help="以 JSON 输出")
    args = ap.parse_args()

    try:
        results = asyncio.run(run(args.timeout))
    except ImportError as e:
        if args.json:
            print(json.dumps({"ok": False, "reason": f"缺少依赖: {e}"},
                             ensure_ascii=False))
        else:
            print(f"跑不起来：缺少依赖（{e}）", file=sys.stderr)
            print("请用装了 zeroconf 包的解释器，例如 ~/.ha-venv/bin/python3",
                  file=sys.stderr)
        return 2
    except OSError as e:
        if args.json:
            print(json.dumps({"ok": False, "reason": f"网络层错误: {e}"},
                             ensure_ascii=False))
        else:
            print(f"跑不起来：{e}", file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps({"ok": bool(results), "services": results},
                         ensure_ascii=False, indent=2))
        return 0 if results else 1

    if not results:
        print(f"没找到 {TYPE} 的广播。")
        print("常见原因：")
        print("  1. configuration.yaml 里缺 zeroconf: —— HA 不会广播自己")
        print("  2. HA 刚重启完还没广播，等十几秒再试")
        print("  3. 本机所在网络禁止组播（部分企业/访客 Wi-Fi）")
        return 1

    print(f"找到 {len(results)} 条广播：\n")
    for r in results:
        print(f"  服务名 : {r['name']}")
        if "error" in r:
            print(f"  {r['error']}")
            continue
        print(f"  地址   : {r['addresses']}")
        print(f"  端口   : {r['port']}")
        for k, v in r["properties"].items():
            print(f"  {k:20s} = {v}")
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
