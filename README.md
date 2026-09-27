# agent-watch-approval

> Push L2/L3 tool calls to iPhone / Apple Watch — decide on the wrist, return the verdict to the Agent. L0/L1 silent-pass.

把 Agent 运行中需要拍板的选项推到 iPhone / Apple Watch，腕上决策后回传给 Agent。

> [English (this file)](./README.md) · [中文](./README.zh-CN.md)

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

## When the wrist path is down

Default-deny does **not** mean "you get nothing but a refusal". The hook's verdict
is always `deny` (so it never depends on the host's permission mode), but the
question keeps travelling — four fallback steps, none of which pull you out of
your workflow:

| Step | Fallback | How |
| --- | --- | --- |
| ① | Local one-shot grant | The one `approval confirm` wrote after you picked "allow once". Checked before every policy, not affected by any switch. |
| ② | **Block + marker → Agent re-asks with the host's own dialog** | **Default** (`ask_user`): the reason starts with `[approval: action_required=ask_user]`, so the Agent calls `AskUserQuestion` — the confirm dialog the host already has. |
| ③ | Hand off to the gateway's local approval page | Opt-in: `APPROVAL_PUSH_FAIL_POLICY=local`. Probes reachability first, so no dead browser tabs. |
| ④ | Just stay denied + write `blocked-last.json` | When nothing above applies. |

Step ② is the default because it puts "ask the usual way" on the host's own
dialog instead of inventing another confirmation UI. Why not
`permissionDecision:"ask"`? Because ask's effect **depends on the permission
mode** — it really does pop a dialog in approval-requiring paths, but on the
sandbox fast path the host asks nobody, so ask can't produce a dialog and the
command runs. `deny` doesn't gamble on the mode, and step ② covers the asking.

`APPROVAL_PUSH_FAIL_POLICY` accepts `ask_user` (default) / `deny` / `local` / `ask`.

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
npm run selftest                     # 92 gateway end-to-end
npm run test:hook                    # 92 hook protocol (spawns a real subprocess)
npm run test:risk                    # 80 risk classification
node test/local-grant.test.mjs       # 66 local one-shot confirm state machine
npm run test:ha-channel              # 59 HA channel round-trip
node test/device-readiness.test.mjs  # 45 device reachability
node test/net-doctor.test.mjs        # 35 address-drift detection
node test/store-resilience.test.mjs  # 29 storage fault-tolerance
# Total: 498 passing across 8 suites
# (node test/mcp-e2e.mjs additionally needs a live gateway)
```

## Links

- Landing page: <https://watch-alert.coderknock.com/>
- Skill page: <https://skillhub.cn/skills/indiv-coderknock/wrist-approval-gateway>
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
test/                      # 8 suites, 498 assertions
```

## License

MIT (or whatever you choose — update before public distribution).