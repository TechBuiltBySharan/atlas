# Atlas

Stateful simulation platform for external provider APIs.

> Not mocks. Not fakes. Not stubs. A stateful simulation engine.

## Docs

- [Agent guide](docs/AGENTS.md) — **give this to Claude/Codex/Cursor**
- [Sociatribe playbook](docs/SOCIATRIBE.md) — wire Sociatribe to Atlas
- [Vision](docs/VISION.md) — why Atlas exists (long form)
- [Tech & implementation](docs/TECH.md) — architecture and APIs
- [Consumer guide](docs/CONSUMER_GUIDE.md) — generic app wiring
- [Phase 1 status](docs/PHASE_1.md) — first live slice
- [Phase 2 status](docs/PHASE_2.md) — deepen twins for Sociatribe
- [Phase 3 status](docs/PHASE_3.md) — plugin architecture (in progress)
- [Provider SDK](docs/PROVIDER_SDK.md) — build a new provider module
- Root pointer: [`AGENTS.md`](AGENTS.md)

## Quick start

Install the published CLI with Node 22+:

```bash
npm install -g atlas-engine
atlas serve
# API + landing page → http://127.0.0.1:4400
```

In another terminal:

```bash
atlas health
atlas bootstrap my-app --webhook-base http://127.0.0.1:3000
```

To contribute from source:

```bash
pnpm install
pnpm test
pnpm dev
pnpm atlas -- bootstrap sociatribe-local --webhook-base http://127.0.0.1:3000
```

Point your app at:

```env
RAZORPAY_API_BASE_URL=http://127.0.0.1:4400/razorpay
WHATSAPP_GRAPH_BASE_URL=http://127.0.0.1:4400/whatsapp/v22.0
# optional Playwright:
# NEXT_PUBLIC_RAZORPAY_CHECKOUT_JS_URL=http://127.0.0.1:4400/razorpay/checkout.js
```

Docker: `pnpm compose:up` (set `ATLAS_STORE=sqlite` for durable data under `/data`).

## Agent / MCP

```bash
pnpm dev   # terminal 1
pnpm mcp   # terminal 2 — stdio MCP; set ATLAS_URL if needed
```

Example agent prompt:

> Create three failed Razorpay payments, delay the payment.captured webhook by 42 seconds, send a duplicate callback, then verify the order settles.

## Packages

| Package | Role |
|---|---|
| `@atlas/core` | Workspaces, clock, events, webhooks, failures, scenarios |
| `@atlas/provider-sdk` | Provider module contract + registry |
| `@atlas/providers-razorpay` | Razorpay-compatible API |
| `@atlas/providers-whatsapp` | WhatsApp Graph-compatible API |
| `@atlas/server` | HTTP server |
| `@atlas/cli` | CLI |
| `@atlas/mcp` | MCP tools for coding agents |

## License

MIT
