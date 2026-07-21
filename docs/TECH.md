# Project Atlas — Technical & Implementation Guide

> Companion to [`VISION.md`](./VISION.md).  
> This document defines how Atlas is built. Phase 1 + Phase 2 are shipped; later phases extend it.

---

## 1. Goals for Phase 1

Deliver a **first live slice**:

1. Runnable Atlas server (local / Docker-friendly)
2. Core engine: workspaces, state, event bus, virtual clock, webhook dispatcher, failure injection
3. Razorpay provider (orders, payments, refunds, signed webhooks, delays/retries/failures)
4. WhatsApp provider (messages in/out, templates, delivery/read receipts, failures, rate limits; basic interactive replies)
5. Control REST API + CLI
6. MCP server for agent control
7. Tests proving the north-star scenario subset
8. Docs: vision, tech, phase-1 status

Out of Phase 1 (Phase 2 closed many of these — see [`PHASE_2.md`](./PHASE_2.md)):

- Full Razorpay/Graph parity (subscriptions, checkout.js, settlements subset, Flows crypto are in Phase 2)
- Hosted cloud multi-tenant SaaS
- Inspect UI console
- Stripe / other providers
- Sociatribe code changes (consumer guide + seams already present)

---

## 2. Repository layout

Monorepo (pnpm workspaces):

```text
atlas/
  docs/
    VISION.md
    TECH.md
    PHASE_1.md
  packages/
    core/                 # engine: state, clock, events, webhooks, scenarios, failures
    providers-razorpay/   # Razorpay-compatible HTTP + state machines
    providers-whatsapp/   # WhatsApp Graph-compatible HTTP + state machines
    server/               # HTTP server mounting providers + control API
    mcp/                  # MCP tool server over control API
    cli/                  # atlas CLI
  examples/
    north-star.scenario.json
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
  README.md
```

**Language:** TypeScript (Node 20+)  
**HTTP:** Hono (lightweight, fast, easy to mount sub-apps)  
**Validation:** Zod  
**Tests:** Vitest  
**Package manager:** pnpm

Rationale: TypeScript matches the ecosystem of first consumers (Sociatribe et al.), MCP tooling is excellent in TS, and one language keeps Phase 1 small.

---

## 3. Architecture

```text
                    ┌──────────────┐
                    │  MCP / CLI   │
                    └──────┬───────┘
                           │ Control API
                           ▼
┌──────────────────────────────────────────────────────────┐
│                         Server                            │
│  /control/*     /razorpay/v1/*     /whatsapp/v22.0/*     │
└──────────┬───────────────┬──────────────────┬────────────┘
           │               │                  │
           ▼               ▼                  ▼
        Core           Razorpay            WhatsApp
     (workspace)       Provider            Provider
           │               │                  │
           └───────────────┴──────────────────┘
                           │
                    In-memory store
                 (memory default; ATLAS_STORE=sqlite optional)
```

### 3.1 Core concepts

| Concept | Meaning |
|---|---|
| **Workspace** | Isolated simulation universe (per app/env/CI run). Owns state, clock, webhook config, failure rules. |
| **Entity** | Provider object: order, payment, conversation, message, … |
| **Event** | Append-only log entry (created, paid, webhook_dispatched, …) |
| **Clock** | Virtual time. Scenarios can `advance(ms)` without waiting in real time. |
| **Webhook target** | Consumer URL + secret Atlas signs and POSTs to |
| **Failure rule** | Declarative chaos: fail next N payments, delay webhooks, duplicate, rate-limit |
| **Scenario** | Ordered list of control operations + assertions |

### 3.2 Request routing

Consumer apps call:

- `http://localhost:4400/razorpay/v1/...` with Basic auth (`key_id:key_secret`)
- `http://localhost:4400/whatsapp/v22.0/...` with `Authorization: Bearer <token>`

Workspace resolution (Phase 1):

1. Header `X-Atlas-Workspace: <id>` if present
2. Else API key / token mapped to a workspace (keys created via control API)
3. Else `default` workspace

### 3.3 Webhook dispatcher

When provider state transitions warrant a callback:

1. Build provider-shaped payload
2. Apply failure rules (delay, drop, duplicate, corrupt signature — Phase 1 supports delay/duplicate/fail)
3. Schedule on virtual clock
4. POST to workspace webhook target with correct signature headers
5. Record delivery attempt + response status in event log
6. Retry per rule (optional)

Razorpay signature: `X-Razorpay-Signature = HMAC_SHA256(rawBody, webhook_secret)`  
WhatsApp signature (optional in Phase 1): `X-Hub-Signature-256 = sha256=HMAC_SHA256(rawBody, app_secret)`

### 3.4 Virtual clock

- `clock.now()` returns simulated epoch ms
- `clock.advance(ms)` flushes due timers (webhook delays, scheduled status updates)
- Real-time mode available for staging demos (`ATLAS_CLOCK=realtime`)

Tests should always use virtual clock.

---

## 4. Razorpay provider (Phase 1)

### 4.1 Implemented endpoints

| Method | Path | Behavior |
|---|---|---|
| POST | `/v1/orders` | Create order (`created`) |
| GET | `/v1/orders/:id` | Fetch order |
| POST | `/v1/payments` | Create/capture payment against order (sim helper + compatible fields) |
| GET | `/v1/payments/:id` | Fetch payment |
| POST | `/v1/payments/:id/capture` | Capture authorized payment |
| POST | `/v1/payments/:id/refund` | Full/partial refund |
| GET | `/v1/payments/:id/refunds` | List refunds |
| POST | `/v1/payment_links` | Create payment link |
| GET | `/v1/payment_links/:id` | Fetch link |
| GET | `/v1/payments` | List (supports `payment_link_id`) |

Auth: HTTP Basic `key_id:key_secret` (workspace credentials issued by control API).

### 4.2 State machines

**Order:** `created` → `paid` | `attempted` → `paid`

**Payment:** `created` → `authorized` → `captured` | `failed`  
Also: `captured` → `refunded` (via refunds)

**Payment link:** `created` → `paid` | `expired` | `cancelled`

### 4.3 Webhooks emitted

- `payment.authorized`
- `payment.captured`
- `payment.failed`
- `order.paid`
- `refund.processed`
- `payment_link.paid`

Payload shape mirrors Razorpay’s `{ event, payload: { payment?: { entity }, … } }`.

### 4.4 Control operations (Razorpay)

- `payments.fail_next` — next N payment attempts fail
- `payments.capture` — force capture for order/payment
- `webhook.delay` — delay next M webhooks by N ms (virtual); optional `event` filter
- `webhook.duplicate` — send next webhook twice; optional `event` filter
- `webhook.drop` — drop next M webhooks; optional `event` filter

---

## 5. WhatsApp provider (Phase 1)

### 5.1 Implemented endpoints

| Method | Path | Behavior |
|---|---|---|
| POST | `/{phoneNumberId}/messages` | Send text / template / interactive |
| GET | `/{phoneNumberId}` | Phone metadata |
| POST | `/{phoneNumberId}/messages` (status mark read) | Mark inbound as read |
| GET | `/{wabaId}/message_templates` | List templates |
| POST | `/{wabaId}/message_templates` | Register template (sim) |

Auth: `Bearer` token bound to workspace + phone number id.

### 5.2 State

- **Conversation** keyed by `(phoneNumberId, waId)`
- **Message** with status timeline: `accepted` → `sent` → `delivered` → `read` | `failed`
- **Template** registry per WABA
- **Rate limit counters** per phoneNumberId

### 5.3 Inbound simulation (control API)

Control endpoints simulate the outside world:

- Inject inbound user message
- Inject interactive button/list reply
- Inject flow submission (`nfm_reply` JSON) **and** encrypted Flows endpoint (`POST /flows`)
- Force failure / rate limit on next outbound sends
- Advance receipt timeline (`sent` → `delivered` → `read`)

Atlas then POSTs Meta-shaped webhooks to the workspace WhatsApp webhook target.

### 5.4 Webhook shape

```json
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "WABA_ID",
    "changes": [{
      "field": "messages",
      "value": {
        "messaging_product": "whatsapp",
        "metadata": { "display_phone_number": "...", "phone_number_id": "..." },
        "messages": [ /* inbound */ ],
        "statuses": [ /* receipts */ ]
      }
    }]
  }]
}
```

---

## 6. Control API

Base: `/control/v1`

| Method | Path | Purpose |
|---|---|---|
| POST | `/workspaces` | Create workspace |
| GET | `/workspaces/:id` | Inspect |
| DELETE | `/workspaces/:id` | Reset/delete |
| POST | `/workspaces/:id/credentials/razorpay` | Issue key_id/secret/webhook_secret |
| POST | `/workspaces/:id/credentials/whatsapp` | Issue token/phone/waba/app_secret |
| PUT | `/workspaces/:id/webhooks/razorpay` | Set target URL + secret |
| PUT | `/workspaces/:id/webhooks/whatsapp` | Set target URL + verify/app secrets |
| POST | `/workspaces/:id/clock/advance` | Advance virtual time |
| GET | `/workspaces/:id/events` | Event log |
| GET | `/workspaces/:id/entities` | Dump entities |
| POST | `/workspaces/:id/failures` | Upsert failure rules |
| POST | `/workspaces/:id/scenarios/run` | Run scenario document |
| POST | `/workspaces/:id/razorpay/orders/:orderId/pay` | Force-pay order |
| POST | `/workspaces/:id/razorpay/payment-links/:linkId/pay` | Pay payment link |
| POST | `/workspaces/:id/razorpay/subscriptions/:subId/charge` | Charge subscription |
| POST | `/workspaces/:id/razorpay/subscriptions/:subId/status` | Force subscription status |
| POST | `/workspaces/:id/whatsapp/inbound` | Inject inbound message |
| POST | `/workspaces/:id/whatsapp/flow-submission` | Inject Flows `nfm_reply` |
| POST | `/workspaces/:id/whatsapp/receipts` | Advance receipts |
| PUT | `/workspaces/:id/whatsapp/flows/consumer-public-key` | Set consumer Flows pubkey |
| POST | `/workspaces/:id/whatsapp/flows/post-to-consumer` | POST encrypted Flows action |

Health: `GET /health`

---

## 7. Scenario format

```json
{
  "name": "failed-then-settle",
  "steps": [
    { "op": "failures.set", "rules": [{ "type": "razorpay.payment.fail_next", "count": 3 }] },
    { "op": "failures.set", "rules": [{ "type": "webhook.delay", "provider": "razorpay", "ms": 42000, "count": 1 }] },
    { "op": "failures.set", "rules": [{ "type": "webhook.duplicate", "provider": "razorpay", "count": 1 }] },
    { "op": "await.entity", "provider": "razorpay", "kind": "order", "status": "paid", "timeoutMs": 60000 },
    { "op": "clock.advance", "ms": 42000 },
    { "op": "assert.webhook", "provider": "razorpay", "event": "payment.captured", "minCount": 2 }
  ]
}
```

Scenarios are data. MCP and CLI are just authors/runners of this data.

---

## 8. MCP tools (Phase 1)

| Tool | Maps to |
|---|---|
| `atlas_workspace_create` | POST `/workspaces` |
| `atlas_workspace_reset` | DELETE `/workspaces/:id` |
| `atlas_set_webhook` | PUT webhooks |
| `atlas_set_failures` | POST failures |
| `atlas_clock_advance` | POST clock/advance |
| `atlas_events_list` | GET events |
| `atlas_razorpay_capture` | Force capture |
| `atlas_whatsapp_inbound` | Inject inbound |
| `atlas_scenario_run` | Run scenario JSON |
| `atlas_assert` | Lightweight assertions helper |

MCP talks to a running Atlas server (default `http://127.0.0.1:4400`).

---

## 9. Persistence

**Phase 1:** in-memory `Map` store per workspace. Process restart clears state. Fine for local + CI.

**Phase 2:** optional SQLite (`ATLAS_STORE=sqlite`, `ATLAS_SQLITE_PATH`) via Node 22 `node:sqlite`. Workspaces hydrate on boot and flush after requests.

No Redis/Postgres required for the first live slice.

---

## 10. Security posture

Atlas is a **dev/staging tool**, not a production payment proxy.

Phase 1 defaults:

- Binds to `127.0.0.1` unless `ATLAS_HOST=0.0.0.0`
- Control API optionally gated by `ATLAS_CONTROL_TOKEN`
- Provider credentials are simulation secrets only
- Clear banner in logs: `ATLAS SIMULATION — NOT REAL MONEY`

Never point production payment traffic at Atlas.

---

## 11. Consumer integration (Sociatribe example)

Minimal app changes (documented, not shipped in Phase 1):

```ts
// razorpay.ts
const base = process.env.RAZORPAY_API_BASE_URL ?? 'https://api.razorpay.com';
await fetch(`${base}/v1/orders`, …);

// whatsapp client.ts
const graph = process.env.WHATSAPP_GRAPH_BASE_URL
  ?? `https://graph.facebook.com/${version}`;
```

Then:

```env
RAZORPAY_API_BASE_URL=http://127.0.0.1:4400/razorpay
WHATSAPP_GRAPH_BASE_URL=http://127.0.0.1:4400/whatsapp/v22.0
# use Atlas-issued keys/tokens
```

Webhook URLs in Atlas control config point back at the app’s real handlers.

---

## 12. Testing strategy

| Layer | What |
|---|---|
| Unit | State machines, signature helpers, clock scheduling |
| Integration | Provider HTTP + webhook delivery to a local mock receiver |
| Scenario | North-star JSON scenario in Vitest |

CI: `pnpm test` must pass without network access to Razorpay/Meta.

---

## 13. Implementation order (Phase 1 execution)

1. Docs (vision + tech) ✅
2. Monorepo scaffold + `@atlas/core`
3. `@atlas/server` with health + control API skeleton
4. Razorpay provider + webhooks + failure rules
5. WhatsApp provider + inbound/receipts
6. Scenario runner
7. CLI + MCP
8. Tests + north-star example
9. `docs/PHASE_1.md` completion report
10. Root README

---

## 14. Coding conventions

- ESM + TypeScript strict
- No `any` without justification
- Zod at HTTP boundaries
- Pure core functions where practical; I/O at server edges
- Prefer small modules over god-objects
- Every provider action appends an event

---

## 15. Open decisions (locked for Phase 1)

| Decision | Choice |
|---|---|
| Language | TypeScript / Node 20 |
| HTTP framework | Hono |
| Persistence | In-memory |
| Clock default | Virtual |
| Agent interface | MCP over control API |
| Port | `4400` |
| Razorpay mount | `/razorpay` |
| WhatsApp mount | `/whatsapp` |

---

## 16. Definition of done (Phase 1)

Phase 1 is done when:

1. `pnpm install && pnpm dev` starts Atlas on `:4400`
2. Creating an order + capturing a payment via Razorpay-compatible API emits a signed `payment.captured` webhook to a test receiver
3. Failure rules can fail N payments, delay a webhook, and duplicate it
4. WhatsApp send produces status webhooks; control API can inject inbound messages
5. MCP tools can drive the above
6. Vitest covers the core happy path + chaos path
7. `docs/PHASE_1.md` lists what shipped and what did not

That is the first live slice.
