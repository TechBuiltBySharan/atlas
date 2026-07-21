# Phase 2 — Deepen the twins

> Status: **Complete** (2026-07-11)  
> Goal: Sociatribe can run ticket purchase, membership subscription, and WhatsApp Flow submission against Atlas locally/CI.

---

## What shipped

### DX

| Piece | Detail |
|---|---|
| Docker | `Dockerfile` (Node 22) + `docker-compose.yml` with optional SQLite volume |
| Bootstrap | `pnpm atlas -- bootstrap <workspaceId> --webhook-base <url>` |
| Env example | `examples/sociatribe.env.example` |
| Scripts | `pnpm compose:up` / `compose:down` / `bootstrap` |

### Razorpay deepen

- **Plans** — `POST/GET /razorpay/v1/plans`
- **Subscriptions** — create (auto-activate), get, cancel; control charge + status
- **Webhooks** — `subscription.authenticated` / `activated` / `charged` / `pending` / `halted` / `paused` / `resumed` / `updated` / `completed` / `cancelled` (`subscription.created` is Atlas-internal only)
- **Pause / resume / patch** — `POST …/pause`, `POST …/resume`, `PATCH /v1/subscriptions/:id`
- **Invoices** — created on subscription charge; `GET /v1/invoices/:id`
- **Fake checkout.js** — `/razorpay/checkout.js` + `POST /v1/checkout/complete` (HMAC `order_id|payment_id`)
- **Settlements** — list + `GET /v1/settlements/recon/combined` subset for admin UI

### WhatsApp Flows

- RSA-OAEP + AES-128-GCM round-trip (`@atlas/providers-whatsapp` crypto helpers)
- Workspace credentials include `flowsPrivateKeyPem` / `flowsPublicKeyPem`
- `POST /whatsapp/v22.0/flows` — Meta-shaped encrypted endpoint (no bearer)
- Control: set consumer public key + `post-to-consumer` (still keep plain `flow-submission` injection)

### Scenario packs

| File | Purpose |
|---|---|
| `examples/ticket-purchase.scenario.json` | Order paid + payment captured |
| `examples/subscription-lifecycle.scenario.json` | Plan + active sub + charged invoice |
| `examples/wa-flow-submit.scenario.json` | Inbound flow message + webhook |
| `examples/refund-after-capture.scenario.json` | Optional refund assert |
| `examples/north-star.scenario.json` | Phase 1 chaos (unchanged) |

CI runner: `packages/server/src/phase2.test.ts` exercises live HTTP + packs.

### Persistence

```bash
ATLAS_STORE=sqlite
ATLAS_SQLITE_PATH=./data/atlas.sqlite   # default
```

- Default remains **memory** (CI-friendly)
- SQLite via Node 22 `node:sqlite`; workspaces hydrate on boot and flush after requests
- Requires **Node ≥ 22** (`engines` + Dockerfile)

---

## Acceptance (Phase 2)

| Check | Status |
|---|---|
| Compose / bootstrap / sociatribe env example | Done |
| Subscriptions + invoice GETs + webhooks | Done |
| Fake checkout.js for Playwright | Done |
| Settlements / recon subset | Done |
| Flows crypto + injection kept | Done |
| Scenario packs + Vitest runner | Done |
| Optional SQLite survives restart | Done |
| Docs + landing roadmap refresh | Done |

---

## How to run (Sociatribe path)

```bash
# Terminal A
cd /path/to/atlas
pnpm install   # Node 22+
pnpm dev

# Bootstrap workspace + print env hints
pnpm atlas -- bootstrap sociatribe-local --webhook-base http://127.0.0.1:3000

# Terminal B — Sociatribe with seams (already present):
# RAZORPAY_API_BASE_URL=http://127.0.0.1:4400/razorpay
# WHATSAPP_GRAPH_BASE_URL=http://127.0.0.1:4400/whatsapp/v22.0
# + keys/tokens from bootstrap
```

Or: `pnpm compose:up` then bootstrap against `http://127.0.0.1:4400`.

---

## Tests

```bash
pnpm test
# core + providers-whatsapp (Flows crypto) + server (phase1 + phase2)
```

---

## Explicitly out of Phase 2

- Stripe / Telegram / Slack providers
- Hosted multi-tenant cloud console
- Full Razorpay payouts / disputes / Route
- Full Meta Flows builder UI parity
- Replacing Sociatribe Dualhook

---

## Next (Phase 3 sketch)

Stripe twin · Telegram · Slack · inspect console · hosted staging · scenario marketplace.
