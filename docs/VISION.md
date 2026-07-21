# Project Atlas — Vision

> Working name: **Atlas**  
> Status: Phase 1 in progress  
> Tagline: *Every external dependency should be replaceable with a deterministic simulator.*

---

## 1. The problem

Modern products are not self-contained. They are glued to other companies’ platforms:

- Payments (Razorpay, Stripe, PayPal)
- Messaging (WhatsApp, Telegram, Slack, SMS)
- Email (Gmail, SES, Resend)
- Calendars, commerce, identity, shipping, tax…

When you need to **test** or **demo** a real flow — ticket purchase, subscription renewal, WhatsApp checkout, refund + receipt — you hit the same wall:

| Approach | Why it fails confidence |
|---|---|
| **Real sandbox / live APIs** | Slow, flaky, rate-limited, sometimes paid, hard to force edge cases (duplicate webhooks, 42s delays, partial failures) |
| **Mocks / stubs / fakes** | Too dead. No shared state across calls. No webhook lifecycle. No “what happens if payment fails then succeeds on retry?” |
| **Record/replay** | Brittle. Breaks when payloads evolve. Doesn’t let you *author* chaos. |
| **UI-driven agent clicking** | Non-deterministic, expensive, and still blocked by captchas / sandboxes |

What teams actually need is something in between:

> A **stateful simulation engine** that speaks the provider’s language, keeps living state, emits real webhooks, and can be steered deterministically — by tests, by staging, or by an agent.

That is Atlas.

---

## 2. What Atlas is

Atlas is an **independent simulation platform**.

It is not a test helper library for one app.  
It is not a collection of Jest mocks.  
It is a **service** that pretends to be Razorpay, WhatsApp, and (later) many other providers — with enough life that your application cannot tell the difference for the flows you care about.

### Philosophy in one sentence

**Not mocks. Not fakes. Not stubs. A stateful simulation engine.**

### Product thesis

1. **Wire-compatible** — consumer apps point base URLs at Atlas and keep their real client code.
2. **Stateful** — create order → capture payment → refund shares one world.
3. **Deterministic** — seedable IDs, virtual clock, replayable scenarios.
4. **Chaos-native** — delays, retries, duplicates, rate limits, and failures are first-class.
5. **Agent-native** — coding agents and humans drive the same control plane (MCP / API / CLI).
6. **Multi-tenant** — one Atlas serves many apps and environments via workspaces.
7. **Provider-pluggable** — Razorpay and WhatsApp first; Stripe, Telegram, Slack, Calendar, Gmail, Shopify later.

### What Atlas is *not*

- Not a full clone of every provider API on day one
- Not a replacement for production payment rails
- Not an agent that *is* the product (the agent sits on top of a deterministic control plane)
- Not Sociatribe-specific infrastructure (Sociatribe is customer #1, not the product definition)

---

## 3. Who it is for

### Primary users

| User | Job to be done |
|---|---|
| **Backend / full-stack engineers** | Run integration and E2E tests without burning money or waiting on sandboxes |
| **Platform / QA engineers** | Stage realistic payment + messaging flows; force edge cases on demand |
| **Coding agents (Cursor, CI agents)** | Author and execute scenarios in natural language against a stable API |
| **Product / founder teams** | Demo full journeys in staging without Meta approval delays or Razorpay test friction |

### Secondary users (later)

- Open-source maintainers who want “spin up Stripe + Slack simulators” in one Docker compose
- Agencies building many WhatsApp/commerce apps
- Educators teaching webhook-driven architectures

---

## 4. The novel wedge: agent-native simulation

Most simulators (if they exist at all) are UI dashboards or YAML fixtures.

Atlas’s distinctive bet:

> Instead of an AI clicking through a UI, an agent asks the simulator:
>
> *“Create three failed Razorpay payments, delay the webhook by 42 seconds, send a duplicate callback, then verify the order eventually settles.”*

That requires:

1. A **control plane** that can express those operations precisely
2. A **runtime** that executes them against living provider state
3. An **MCP / agent interface** that maps natural language → control plane calls

The agent is a power interface.  
The control plane is the product truth.  
CI and humans use the same primitives.

---

## 5. Core product surfaces

```text
┌─────────────────────────────────────────────────────────────┐
│                     Consumer applications                    │
│         (Sociatribe, future Stripe/WA apps, …)              │
└───────────────────────────┬─────────────────────────────────┘
                            │ Provider-shaped HTTP
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                 Atlas Provider Plugins                       │
│         Razorpay · WhatsApp · (Stripe · …)                   │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│                      Atlas Core                              │
│  Workspaces · State · Event bus · Virtual clock              │
│  Webhook dispatcher · Failure injection · Scenario engine    │
└───────────────────────────┬─────────────────────────────────┘
                            │
          ┌─────────────────┼─────────────────┐
          ▼                 ▼                 ▼
   Control REST API      CLI / SDK         MCP Agent
```

### 5.1 Provider APIs

Drop-in HTTP surfaces that mimic real providers enough for real clients:

- Razorpay: `/v1/orders`, `/v1/payments`, `/v1/refunds`, payment links, signed webhooks
- WhatsApp Cloud API: send/receive messages, templates, statuses, rate-limit errors

### 5.2 Control plane

Atlas-native API for steering the simulation:

- Create / reset workspaces
- Inject failures, delays, duplicates
- Advance virtual time
- Inspect entities and event history
- Run named scenarios and assertions

### 5.3 Agent / MCP

Tools such as:

- `atlas.workspace.create`
- `atlas.razorpay.create_failed_payments`
- `atlas.webhook.delay`
- `atlas.webhook.duplicate`
- `atlas.time.advance`
- `atlas.assert.order_settled`

### 5.4 Optional console (later)

A thin inspect UI for humans: entities, timeline, scenario runner. Not required for Phase 1.

---

## 6. How people use Atlas

### Local development

```bash
docker compose up atlas
# point app env:
# RAZORPAY_API_BASE_URL=http://localhost:4400/razorpay
# WHATSAPP_GRAPH_BASE_URL=http://localhost:4400/whatsapp
```

App code stays the same. Atlas holds state and fires webhooks back to the app.

### CI / automated tests

1. Start Atlas (or use a shared CI instance with an ephemeral workspace)
2. Seed a scenario (or let the app create orders/messages normally)
3. Inject chaos via control API
4. Assert via control API and/or app database

### Staging

Long-lived workspaces per environment. Product and support can “pay” and “message” without real money or Meta production risk.

### Agent-assisted debugging

Developer or coding agent describes the failure mode in English; MCP translates to control-plane operations; Atlas executes; agent verifies outcomes.

---

## 7. Provider roadmap

### Phase 1 (this release) — first live slice

- Core engine
- Razorpay simulator (orders, payments, refunds, webhooks, delays, retries, failures)
- WhatsApp simulator (templates, conversations, inbound/outbound, delivery/read receipts, failures, rate limits; flow submissions / interactive replies at a basic level)
- Control API + CLI
- MCP server
- Docs + Phase 1 status

### Phase 2 — deepen + Sociatribe as reference consumer

- Higher Razorpay fidelity (payment links, subscriptions, settlements subset)
- WhatsApp Flows encryption path
- Official Sociatribe base-URL integration guide
- Scenario packs for ticket purchase / subscription

### Phase 3 — productize

- Stripe provider
- Telegram / Slack providers
- Hosted Atlas cloud (multi-tenant SaaS)
- Scenario marketplace / shared packs
- Inspect console

### Later

Google Calendar, Gmail, Shopify, SES, Twilio, and whatever else teams glue into products.

---

## 8. Design principles

1. **Fidelity where it matters** — implement the paths real apps hit; deepen on demand. Do not chase 100% API parity before the first live slice works.
2. **Determinism by default** — same seed + same scenario ⇒ same IDs and timeline.
3. **Real webhooks or it didn’t happen** — outbound provider calls must be able to produce inbound callbacks the consumer’s real handlers accept (signatures included).
4. **Chaos is a feature** — delays, duplicates, out-of-order delivery, rate limits, and partial failures are APIs, not afterthoughts.
5. **Workspace isolation** — every consumer/env gets a sandbox; no cross-talk.
6. **Provider plugins are boring** — they map HTTP ↔ core state machines; cleverness lives in the core.
7. **Agent on top, never instead** — natural language is a UX; scripts and APIs remain the contract.
8. **Independent product** — Sociatribe validates the thesis; Atlas must make sense for a stranger’s Stripe+Slack app too.

---

## 9. Success criteria

Atlas is succeeding when:

1. A real app can complete a paid checkout against Atlas with **zero** calls to `api.razorpay.com`.
2. The same app can complete a WhatsApp message round-trip against Atlas with **zero** calls to `graph.facebook.com`.
3. A test or agent can force: failed payments → delayed webhook → duplicate callback → eventual settle — and assert it.
4. A second, unrelated app can adopt Atlas by changing base URLs and secrets only.
5. Engineers prefer Atlas over sandboxes for day-to-day confidence.

---

## 10. Competitive landscape (honest)

| Category | Examples | Gap Atlas fills |
|---|---|---|
| Provider sandboxes | Razorpay test mode, Meta test numbers | Limited chaos control; slow; not agent-native |
| HTTP mock servers | WireMock, MockServer, MSW | Stateless or fixture-bound; weak multi-step provider semantics |
| Local stacks | LocalStack (AWS) | Great for AWS; no Razorpay/WhatsApp; not a general provider sim framework |
| Contract testing | Pact | Verifies shapes; does not simulate living provider behavior |
| Recording proxies | VCR, Polly | Replay ≠ authorable chaos |

Atlas aims to be **LocalStack for SaaS providers**, with an agent-native control plane.

---

## 11. Naming & positioning

- **Working name:** Atlas
- **Positioning line:** *Stateful simulators for the APIs your product depends on.*
- **Category:** Simulation platform / provider twin / deterministic chaos for external deps

The name is a placeholder and can change. The category should not.

---

## 12. Non-goals (near term)

- Processing real money
- Being a production proxy/failover for live providers
- Pixel-perfect checkout.js / WhatsApp Business App UI clones
- Guaranteeing full Graph / Razorpay API coverage
- Building a large admin SaaS UI before the runtime is excellent

---

## 13. North star scenario

The scenario that must always work, forever:

```text
Agent / CI → Atlas control plane:

  1. Create workspace "demo"
  2. Configure webhook target → https://app.example/api/webhooks/razorpay
  3. App creates Razorpay order via Atlas
  4. Inject: fail payment ×3
  5. Inject: delay next webhook by 42s (virtual time)
  6. Inject: duplicate payment.captured callback
  7. Capture payment successfully
  8. Assert: order settled, app received exactly the expected webhook set
  9. Send WhatsApp template + inbound reply via Atlas
 10. Assert: delivery + read receipts observed
```

When that loop is boringly reliable, Atlas is real.

---

## 14. Closing

Software increasingly *is* integration. Testing integration against dead mocks produces false confidence. Testing against live vendors produces expense and flakiness.

Atlas exists to give teams a third option: **a living twin of the outside world**, under their control, deterministic when they need it, chaotic when they ask for it, and speakable by agents.

Phase 1 proves the slice. Everything after that is more providers and more product.
