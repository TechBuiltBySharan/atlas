# Using Atlas with Sociatribe

> End-to-end playbook: run Sociatribe against Atlas instead of real Razorpay / Meta.
>
> Agents: read [`AGENTS.md`](./AGENTS.md) first, then this file.
> Phase 2: [`PHASE_2.md`](./PHASE_2.md). Env template: [`examples/sociatribe.env.example`](../examples/sociatribe.env.example).

---

## Status (Phase 2)

Sociatribe already has base-URL seams:

- `RAZORPAY_API_BASE_URL` (default `https://api.razorpay.com`)
- `WHATSAPP_GRAPH_BASE_URL` (default Graph host + version)

Integration is **configure env + Atlas bootstrap** — not “add seams.”

Optional Playwright checkout:

```env
NEXT_PUBLIC_RAZORPAY_CHECKOUT_JS_URL=http://127.0.0.1:4400/razorpay/checkout.js
```

---

## Goal

1. Sociatribe local/staging talks to Atlas for Razorpay + WhatsApp HTTP.
2. Atlas posts signed webhooks back to Sociatribe’s real handlers.
3. You (or an agent) can force fail/delay/duplicate paths without spending money or waiting on Meta.
4. Ticket purchase, membership subscription, and WA Flow submission work against Atlas.

---

## Step 1 — Start both processes

```bash
# Terminal A — Atlas (Node 22+)
cd /Volumes/DevAPFS/github/atlas
pnpm install && pnpm dev
# http://127.0.0.1:4400

# Or: pnpm compose:up

# Terminal B — Sociatribe
cd /Volumes/DevAPFS/github/sociatribe
pnpm dev
# http://127.0.0.1:3000 (or your usual port)
```

---

## Step 2 — Bootstrap workspace (preferred)

```bash
cd /Volumes/DevAPFS/github/atlas
pnpm atlas -- bootstrap sociatribe-local --webhook-base http://127.0.0.1:3000
```

Creates workspace, issues Razorpay + WhatsApp credentials, points webhooks at Sociatribe’s `/api/webhooks/razorpay` and `/api/webhooks/whatsapp`. Copy printed values into Sociatribe (see `examples/sociatribe.env.example`).

### Manual equivalent

```bash
pnpm atlas -- workspace create sociatribe-local
pnpm atlas -- creds razorpay sociatribe-local
pnpm atlas -- creds whatsapp sociatribe-local

pnpm atlas -- webhook razorpay sociatribe-local \
  http://127.0.0.1:3000/api/webhooks/razorpay \
  <webhookSecret>

pnpm atlas -- webhook whatsapp sociatribe-local \
  http://127.0.0.1:3000/api/webhooks/whatsapp \
  <appSecret>
```

If Sociatribe uses per-brand WA paths (`/api/webhooks/whatsapp/[token]`), use that full URL instead.

---

## Step 3 — Configure Sociatribe

```env
RAZORPAY_API_BASE_URL=http://127.0.0.1:4400/razorpay
WHATSAPP_GRAPH_BASE_URL=http://127.0.0.1:4400/whatsapp/v22.0
```

### Payments
- Active payment provider `key_id` / `key_secret` = Atlas Razorpay creds
- Webhook secret on that provider row = Atlas `webhookSecret`

### WhatsApp
- `access_token` = Atlas token
- `phone_number_id` = Atlas phoneNumberId
- `WHATSAPP_WEBHOOK_VERIFY_TOKEN` = Atlas `verifyToken` (if exercising GET challenge)
- App secret for signature / Flows = Atlas `appSecret`
- Flows: Atlas issues `flowsPublicKeyPem`; use control `flows/consumer-public-key` + `flows/post-to-consumer`, or keep `flow-submission` injection for `nfm_reply`

Exact DB columns live in Sociatribe’s `payment_providers` / `waba_configs` — use existing admin UI or seed scripts.

---

## Step 4 — Happy paths to try

### A. Ticket / cart payment (Orders + checkout.js)

1. Start checkout in Sociatribe (creates Razorpay order on Atlas).
2. Complete via Atlas fake checkout or control:  
   `pnpm atlas -- razorpay pay sociatribe-local <order_id>`
3. Sociatribe webhook handler fulfills as in production.
4. Scenario pack: `examples/ticket-purchase.scenario.json`

### B. Membership subscription

1. Create plan + subscription via Sociatribe → Atlas `/v1/plans`, `/v1/subscriptions`.
2. Charge: `POST /control/v1/workspaces/…/razorpay/subscriptions/:id/charge`
3. Expect `subscription.charged` + invoice; pack: `examples/subscription-lifecycle.scenario.json`

### C. Payment link

Create link → pay via control `payment-links/:id/pay` → `payment_link.paid` webhook.

### D. WhatsApp notify + Flow

1. Trigger Sociatribe WA send; Atlas emits status webhooks.
2. Inject reply: `pnpm atlas -- whatsapp inbound sociatribe-local 9198XXXXXXXX "hi"`
3. Flow submit: control `whatsapp/flow-submission` or encrypted `POST /whatsapp/v22.0/flows`
4. Pack: `examples/wa-flow-submit.scenario.json`

### E. Settlements (admin)

`GET /razorpay/v1/settlements` and `/v1/settlements/recon/combined` against Atlas keys.

---

## Step 5 — Chaos path (north-star)

```bash
pnpm atlas -- failures sociatribe-local examples/north-star.scenario.json
# or a rules.json with fail_next + delay + duplicate
pnpm atlas -- razorpay pay sociatribe-local <order_id>
pnpm atlas -- clock advance sociatribe-local 42000
```

Expect: failures then capture; two `payment.captured` webhooks after clock advance; idempotent fulfillment.

---

## Prompt to paste into Claude / Codex / Cursor

```text
You are integrating Sociatribe with Project Atlas (stateful provider simulator).

Atlas repo: /Volumes/DevAPFS/github/atlas
Sociatribe repo: /Volumes/DevAPFS/github/sociatribe

Read first:
1. /Volumes/DevAPFS/github/atlas/docs/AGENTS.md
2. /Volumes/DevAPFS/github/atlas/docs/SOCIATRIBE.md
3. /Volumes/DevAPFS/github/atlas/docs/PHASE_2.md

Task:
1. Seams already exist — set RAZORPAY_API_BASE_URL and WHATSAPP_GRAPH_BASE_URL to Atlas.
2. Run `pnpm atlas -- bootstrap sociatribe-local --webhook-base http://127.0.0.1:3000`
   and wire printed creds into Sociatribe.
3. Do NOT mock Razorpay/WhatsApp — use Atlas.
4. Verify ticket order capture, one subscription charge, and one WA flow submission.

Atlas: http://127.0.0.1:4400 (Node 22+)
```

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Sociatribe still hits real Razorpay/Meta | Env base URLs unset |
| `401` from Atlas Razorpay | Wrong keyId/keySecret vs workspace creds |
| Webhooks never arrive | Atlas webhook URL wrong; Sociatribe not reachable from Atlas process |
| Signature failures | Consumer verifying with a different secret than Atlas issued |
| Delayed webhook “never” comes | Forgot `clock.advance` (virtual clock) |
| Payment always succeeds when you wanted failures | Failure rules consumed; re-`failures.set` |
| SQLite / `node:sqlite` errors | Need Node ≥ 22 |

---

## What Atlas does *not* replace yet for Sociatribe

- Razorpay Partner OAuth (`auth.razorpay.com`)
- Full payouts / disputes / Route
- Dualhook (keep `DUALHOOK_BASE_URL` as today)
- Hosted multi-tenant Atlas cloud

Phase 2 covers subscriptions, fake checkout.js, settlements subset, Flows crypto, scenario packs, and optional SQLite.
