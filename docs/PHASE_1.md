# Phase 1 — First Live Slice

> Status: **Complete** (2026-07-11)  
> Goal: prove Atlas as an independent stateful simulation platform with Razorpay + WhatsApp providers, control plane, CLI, and MCP.

---

## What shipped

### Documentation

| Doc | Purpose |
|---|---|
| [`docs/VISION.md`](./VISION.md) | Long-form product vision, philosophy, roadmap, north-star scenario |
| [`docs/TECH.md`](./TECH.md) | Architecture, APIs, scenario format, implementation plan |
| [`docs/CONSUMER_GUIDE.md`](./CONSUMER_GUIDE.md) | How apps (e.g. Sociatribe) point at Atlas |
| [`docs/PHASE_1.md`](./PHASE_1.md) | This completion report |
| [`README.md`](../README.md) | Quick start |
| [`site/`](../site/) | Marketing landing page (served at `/` with the Atlas server) |

### Core engine (`@atlas/core`)

- Workspaces (isolated simulation universes)
- In-memory entity store + append-only event log
- Virtual clock with `advance(ms)` that flushes due webhooks
- Webhook dispatcher with HMAC signing
  - Razorpay: `X-Razorpay-Signature`
  - WhatsApp: `X-Hub-Signature-256`
- Failure / chaos rules:
  - `razorpay.payment.fail_next`
  - `whatsapp.send.fail_next`
  - `whatsapp.rate_limit`
  - `webhook.delay` / `webhook.duplicate` / `webhook.drop` (optional `event` filter)
- Scenario runner (JSON steps + assertions)
- Credential issuance for Razorpay + WhatsApp

### Razorpay provider (`@atlas/providers-razorpay`)

Mounted at `/razorpay/v1/*` (Basic auth):

- Orders: create, get
- Payments: create/attempt, get, capture, list
- Refunds: create, list
- Payment links: create, get
- Webhooks: `payment.authorized`, `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`, `payment_link.paid`
- State machines for order / payment / link / refund

### WhatsApp provider (`@atlas/providers-whatsapp`)

Mounted at `/whatsapp/v22.0/*` (Bearer token):

- Send text / template / interactive messages
- Mark-as-read
- Phone metadata
- Template list/create (sim)
- Auto status progression: `accepted` → `sent` → `delivered`
- Control-plane inbound injection (text, button, interactive)
- Basic flow submission injection (`nfm_reply` JSON — not full encrypted Flows protocol)
- Rate-limit + send-failure rules
- Meta-shaped webhook payloads for messages + statuses

### Server (`@atlas/server`)

- `GET /health`
- Control API under `/control/v1/*` (optional `ATLAS_CONTROL_TOKEN`)
- Default bind: `127.0.0.1:4400`
- Banner: `ATLAS SIMULATION — NOT REAL MONEY / NOT REAL META`

### CLI (`@atlas/cli`)

```bash
pnpm atlas -- health
pnpm atlas -- workspace create demo
pnpm atlas -- creds razorpay demo
pnpm atlas -- webhook razorpay demo http://localhost:3000/hook <secret>
pnpm atlas -- failures demo rules.json
pnpm atlas -- clock advance demo 42000
pnpm atlas -- razorpay pay demo order_…
pnpm atlas -- whatsapp inbound demo 9198… "hello"
pnpm atlas -- scenario run demo examples/north-star.scenario.json
```

### MCP (`@atlas/mcp`)

Agent tools over the same control plane:

- `atlas_workspace_create` / `atlas_workspace_reset`
- `atlas_issue_credentials`
- `atlas_set_webhook` / `atlas_set_failures`
- `atlas_clock_advance` / `atlas_events_list`
- `atlas_razorpay_pay_order`
- `atlas_whatsapp_inbound`
- `atlas_scenario_run`
- `atlas_health`

### Examples & tests

- `examples/north-star.scenario.json` — fail ×3, delay+duplicate `payment.captured`, assert settle
- Vitest: 4 core tests + 2 Phase 1 integration tests (all passing)
- `pnpm -r typecheck` clean

---

## North-star proof (automated)

The Phase 1 integration test proves:

1. Create workspace + Razorpay credentials
2. Set webhook receiver
3. Set rules: fail next 3 payments; delay+duplicate next `payment.captured` by 42s (virtual)
4. Create order via Razorpay-compatible API
5. Three payment attempts → `failed`
6. Fourth attempt → `captured`, order → `paid`
7. Before clock advance: no `payment.captured` webhook delivered
8. After `clock.advance(42000)`: ≥2 signed `payment.captured` deliveries (duplicate)

WhatsApp path: outbound send emits status webhooks; control inbound injects a user reply webhook.

---

## How to run

```bash
pnpm install
pnpm test          # core + phase1 live slice
pnpm dev           # server on :4400
pnpm atlas -- health
pnpm mcp           # stdio MCP server (needs Atlas running)
```

---

## Explicitly not in Phase 1

| Item | Why deferred |
|---|---|
| Full Razorpay API parity (subscriptions, settlements, OAuth, checkout.js) | Fidelity where it matters first |
| Full WhatsApp Flows RSA-OAEP encryption round-trip | Basic `nfm_reply` injection covers Sociatribe-style flow *data* testing; crypto later |
| Stripe / Telegram / Slack / etc. | Phase 2+ providers |
| SQLite / durable persistence | In-memory is enough for local + CI |
| Inspect UI console | Control API + CLI + MCP first |
| Sociatribe code changes | Documented in `CONSUMER_GUIDE.md`; app PR is a separate workstream |
| Hosted Atlas cloud | Productize after more providers |

---

## Package map

```text
packages/
  core/                  engine
  providers-razorpay/    Razorpay twin
  providers-whatsapp/    WhatsApp twin
  server/                HTTP entrypoint
  cli/                   human control
  mcp/                   agent control
```

---

## Recommended Phase 2

1. Sociatribe base-URL seams (`RAZORPAY_API_BASE_URL`, `WHATSAPP_GRAPH_BASE_URL`) + staging wiring
2. Razorpay subscriptions + payment-link edge cases Sociatribe actually uses
3. WhatsApp Flows encryption compatibility
4. Scenario packs: ticket purchase, subscription renew, refund+receipt
5. Optional SQLite persistence for long-lived staging workspaces
6. Thin inspect UI (entity timeline)

---

## Verdict

Phase 1 delivers the first **live slice**: a real process you can point HTTP clients at, with living state, signed webhooks, virtual time, chaos rules, and an agent-native control plane.

It is intentionally small. It is intentionally independent. It is ready to be the twin that Sociatribe — and later other products — run against instead of burning money on sandboxes or trusting dead mocks.
