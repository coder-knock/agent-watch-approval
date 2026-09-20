# agent-watch-approval

> Push L2/L3 tool calls to iPhone / Apple Watch — decide on the wrist, return the verdict to the Agent. L0/L1 silent-pass.

把 Agent 运行中需要拍板的选项推到 iPhone / Apple Watch，腕上决策后回传给 Agent。

---

## What this is

A small local gateway that sits between an Agent and a Home Assistant install.
Every tool call is classified L0–L3; L2/L3 are pushed as a one-shot, signed card
to your iPhone (or Apple Watch via the HA companion app). You tap Allow / Deny
on the wrist and the verdict round-trips back. No public ingress, no third-party
push provider, no long-lived secrets on the device.

- **L0** silent-pass (read-only paths)
- **L1** audit only
- **L2** push a time-sensitive card
- **L3** push a critical card, never auto-allows even within a session

## Why this design

Three rules the code never breaks:

1. **Default-deny.** Timeout, signature failure, channel unreachable → `deny`.
2. **Single-use.** The token inside the action ID is one-shot; replays are dropped.
3. **Audit trail.** Every decision lands in `audit.jsonl` with the action hash.

The HMAC-signed action token (`APR:<id>:<option>:<nonce>:<sig>`) carries the
decision authority — no long-lived key ever leaves the gateway. WebSocket
round-trip means the Mac needs no port forwarding or public callback.

## Quick start

```bash
# 1. Install (HA + iPhone App are the only prerequisites)
npm install
npm run doctor                # HA reachable? token valid?

# 2. Run
npm start                     # mock channel at http://127.0.0.1:7788
                              # open it in a browser — that's your iPhone simulator

# 3. When ready for the real watch
#    see INSTALL.md (step-by-step) and SETUP.md (full manual)
```

## Tests

```bash
npm run selftest              # 82 gateway e2e
npm run test:ha-channel       # 44 channel round-trip
npm run test:risk             # 80 risk classification
npm run test:hook             # 61 hook protocol
node test/local-grant.test.mjs # 66 local-confirm state machine
node test/device-readiness.test.mjs  # 45 device-readiness
node test/store-resilience.test.mjs  # 26 storage fault-tolerance
node test/net-doctor.test.mjs        # 35 net-drift detection
# Total: 439 passing
```

## Links

- Landing page: <https://watch-alert.coderknock.com/>
- Skill page: <https://skillhub.cn/skills/user_69f76828/wrist-approval-gateway>
- Install guide: [INSTALL.md](./INSTALL.md)
- Full manual (why & how): [SETUP.md](./SETUP.md)
- Promo site source: [promo/](./promo/)

## Layout

```
src/
  gateway.mjs              # HTTP server, decision wiring
  core/
    bind.mjs               # action token, HMAC, canonical JSON
    risk.mjs               # L0–L3 classification
    store.mjs              # pending + audit + sweep
    local-grant.mjs        # one-shot local confirm (push-failure fallback)
  channels/
    ha.mjs                 # Home Assistant WebSocket + REST
    device-readiness.mjs   # "is the phone actually online?"
    pushcut.mjs            # optional Pushcut fallback
    mock.mjs               # in-process simulator

bin/
  approve-hook.mjs         # PreToolUse hook for Agent hosts
  approval-confirm.mjs     # `approval confirm --yes` CLI

mcp/approval-mcp.mjs       # MCP server exposing /v1/approvals
public/phone.html          # browser-as-iPhone simulator
scripts/                   # install, repair, doctor, netwatch
test/                      # 8 suites, 439 tests
```

## License

MIT (or whatever you choose — update before public distribution).