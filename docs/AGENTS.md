# Atlas — Agent Guide

> **Give this file to Claude, Codex, Cursor, or any coding agent** when working with Atlas.
>
> Read this first. Then use [`docs/TECH.md`](docs/TECH.md) for API detail and
> [`docs/SOCIATRIBE.md`](docs/SOCIATRIBE.md) when the consumer is Sociatribe.

---

## What Atlas is (one paragraph)

Atlas is an **independent stateful simulation platform**. It pretends to be external providers (Razorpay, WhatsApp, later Stripe/Slack/…) so apps can test and stage real flows without paying sandboxes or relying on dead mocks. Consumer apps keep their real client code and point **base URLs** at Atlas. Chaos (fail payments, delay/duplicate webhooks, rate limits) is first-class via a **control plane**. Agents drive Atlas through **MCP tools** or the same HTTP control API — never by inventing mocks inside the consumer app.

**Not mocks. Not fakes. Not stubs. A stateful simulation engine.**

---

## Hard rules for agents

1. **Do not mock Razorpay/WhatsApp inside the consumer** when Atlas is available — retarget the app to Atlas instead.
2. **Never point production traffic at Atlas.** Simulation only.
3. **Prefer the control plane** (`/control/v1/*`, CLI, or MCP) for chaos and assertions — don’t scrape UI.
4. **Determinism first:** use virtual clock (`clock.advance`) instead of `sleep` for webhook delays.
5. **Credentials come from Atlas** (`credentials/razorpay`, `credentials/whatsapp`) — don’t invent random secrets that don’t match the workspace.
6. **Webhooks must hit the consumer’s real handlers** (e.g. Sociatribe `/api/webhooks/razorpay`), signed with Atlas-issued secrets.
7. If the consumer hardcodes `api.razorpay.com` / `graph.facebook.com`, **add env base-URL seams first** — that is required wiring, not optional polish.

---

## Quick mental model

```text
Consumer app  ──HTTP (provider-shaped)──►  Atlas providers (/razorpay, /whatsapp)
     ▲                                            │
     │         signed webhooks                    │
     └────────────────────────────────────────────┘
                                                  │
Control / MCP / CLI  ──chaos & inspect────────────┘
```

| Surface | Base | Auth |
|---|---|---|
| Razorpay twin | `http://127.0.0.1:4400/razorpay/v1/*` | Basic `keyId:keySecret` |
| WhatsApp twin | `http://127.0.0.1:4400/whatsapp/v22.0/*` | Bearer access token |
| Control plane | `http://127.0.0.1:4400/control/v1/*` | Optional `X-Atlas-Token` |
| Landing / docs | `http://127.0.0.1:4400/` and `/docs/*` | — |

Default port: **4400**. Env: `ATLAS_URL`, `ATLAS_CONTROL_TOKEN`, `ATLAS_HOST`, `ATLAS_PORT`, `ATLAS_STORE` (`memory`|`sqlite`), `ATLAS_SQLITE_PATH`.
Requires **Node ≥ 22**.

---

## Start Atlas

```bash
cd /path/to/atlas
pnpm install
pnpm dev          # server + landing on :4400
# optional:
pnpm atlas -- …   # CLI against ATLAS_URL
pnpm mcp          # stdio MCP (needs server running)
```

Health check: `GET /health`

---

## Standard workflow (any consumer)

1. **Start Atlas** (`pnpm dev`).
2. **Create workspace:** `POST /control/v1/workspaces` `{ "id": "my-app-local" }`.
3. **Issue credentials** for razorpay and/or whatsapp.
4. **Set webhook targets** to the consumer’s real webhook URLs + Atlas secrets.
5. **Wire consumer env** to Atlas base URLs + issued keys/tokens.
6. **Exercise the app flow** (create order, send WA message, etc.).
7. **Inject chaos** via failure rules when testing edge cases.
8. **Advance clock** to flush delayed webhooks.
9. **Inspect** `/events`, `/entities`, or scenario assertions.

### Minimal curl sketch

```bash
curl -s -X POST localhost:4400/control/v1/workspaces \
  -H 'content-type: application/json' -d '{"id":"demo"}'

curl -s -X POST localhost:4400/control/v1/workspaces/demo/credentials/razorpay \
  -H 'content-type: application/json' -d '{}'

curl -s -X PUT localhost:4400/control/v1/workspaces/demo/webhooks/razorpay \
  -H 'content-type: application/json' \
  -d '{"url":"http://127.0.0.1:3000/api/webhooks/razorpay","secret":"<webhookSecret>"}'
```

---

## What Phase 1 can do

### Core
- Workspaces, in-memory state, event log
- Virtual clock + `clock.advance`
- Webhook dispatcher with signatures
- Failure rules (see below)
- Scenario runner (JSON steps)

### Razorpay
- Orders, payments (attempt/capture), refunds, payment links
- Plans, subscriptions (activate/charge/cancel/pause/resume/update), invoices
- Fake `checkout.js` + `/v1/checkout/complete`
- Settlements list + recon combined subset
- Webhooks: payment/order/refund/link + subscription authenticated/activated/charged/pending/halted/paused/resumed/updated/completed/cancelled (`created` is internal)

### WhatsApp
- Send text/template/interactive; mark read
- Templates list/create (sim)
- Status webhooks: sent / delivered / read / failed
- Control: inject inbound, interactive reply, flow `nfm_reply`, advance receipts
- Flows RSA-OAEP/AES endpoint (`POST /whatsapp/.../flows`) + control post-to-consumer
- Rate-limit + send-fail rules

### Persistence / DX
- Default in-memory store; optional `ATLAS_STORE=sqlite` (Node 22+)
- `atlas bootstrap`, Docker Compose, scenario packs under `examples/`

### Not yet (don’t assume)
- Stripe and other providers
- Full Razorpay OAuth / payouts / disputes
- Hosted multi-tenant cloud console

---

## Failure rules (chaos)

`POST /control/v1/workspaces/:id/failures` with `{ "rules": [ ... ] }`:

| Rule | Effect |
|---|---|
| `{ "type":"razorpay.payment.fail_next", "count":3 }` | Next 3 payment attempts fail |
| `{ "type":"webhook.delay", "provider":"razorpay", "ms":42000, "count":1, "event":"payment.captured" }` | Delay matching webhooks |
| `{ "type":"webhook.duplicate", "provider":"razorpay", "count":1, "event":"payment.captured" }` | Deliver twice |
| `{ "type":"webhook.drop", "provider":"razorpay", "count":1 }` | Drop webhook |
| `{ "type":"whatsapp.send.fail_next", "count":1 }` | Next WA send fails |
| `{ "type":"whatsapp.rate_limit", "remaining":0 }` | Next sends hit 429 |

Optional `event` on webhook rules scopes chaos to a specific event name.

After delays: `POST /control/v1/workspaces/:id/clock/advance` `{ "ms": 42000 }`.

---

## MCP tools

When MCP is connected (`pnpm mcp`, `ATLAS_URL=http://127.0.0.1:4400`):

| Tool | Purpose |
|---|---|
| `atlas_health` | Server health |
| `atlas_workspace_create` / `atlas_workspace_reset` | Workspace lifecycle |
| `atlas_issue_credentials` | razorpay \| whatsapp |
| `atlas_set_webhook` | Point Atlas → consumer |
| `atlas_set_failures` | Chaos rules |
| `atlas_clock_advance` | Virtual time |
| `atlas_events_list` | Inspect timeline |
| `atlas_razorpay_pay_order` | Force-pay an order (respects fail_next) |
| `atlas_whatsapp_inbound` | Inject user message |
| `atlas_scenario_run` | Run scenario JSON |

**Example agent prompt:**

> Using Atlas workspace `sociatribe-local`: fail the next 3 Razorpay payments, delay `payment.captured` by 42s, duplicate it, pay the open order, advance the clock, and confirm two signed capture webhooks were delivered.

---

## CLI cheatsheet

```bash
pnpm atlas -- bootstrap sociatribe-local --webhook-base http://127.0.0.1:3000
pnpm atlas -- health
pnpm atlas -- workspace create sociatribe-local
pnpm atlas -- creds razorpay sociatribe-local
pnpm atlas -- creds whatsapp sociatribe-local
pnpm atlas -- webhook razorpay sociatribe-local http://127.0.0.1:3000/api/webhooks/razorpay <secret>
pnpm atlas -- failures sociatribe-local rules.json
pnpm atlas -- clock advance sociatribe-local 42000
pnpm atlas -- razorpay pay sociatribe-local order_…
pnpm atlas -- whatsapp inbound sociatribe-local 9198… "hello"
pnpm atlas -- events sociatribe-local
pnpm atlas -- scenario run sociatribe-local examples/ticket-purchase.scenario.json
```

---

## Doc map (what to open next)

| If you need… | Open |
|---|---|
| Product vision / why | [`docs/VISION.md`](docs/VISION.md) |
| Architecture & API shapes | [`docs/TECH.md`](docs/TECH.md) |
| Generic consumer wiring | [`docs/CONSUMER_GUIDE.md`](docs/CONSUMER_GUIDE.md) |
| **Sociatribe specifically** | [`docs/SOCIATRIBE.md`](docs/SOCIATRIBE.md) |
| What Phase 1 shipped | [`docs/PHASE_1.md`](docs/PHASE_1.md) |
| What Phase 2 shipped | [`docs/PHASE_2.md`](docs/PHASE_2.md) |
| This agent briefing | [`AGENTS.md`](AGENTS.md) (you are here) |

---

## Suggested first task for an agent integrating a consumer

1. Confirm Atlas is running (`GET /health`) on Node 22+.
2. Confirm consumer has `RAZORPAY_API_BASE_URL` / `WHATSAPP_GRAPH_BASE_URL` (or equivalent).
3. `pnpm atlas -- bootstrap <id> --webhook-base <consumer>` (or create workspace + credentials + webhooks).
4. Document env vars for local/staging `.env`.
5. Run ticket / subscription / WA flow against Atlas; then one chaos path (fail → delay → duplicate → settle).
