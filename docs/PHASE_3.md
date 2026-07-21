# Phase 3 — Productize (in progress)

> Status: **In progress** (2026-07-12)  
> Goal: Pluggable provider platform + generic consumer DX + inspect console foundation.

Baseline checkpoint: git commit `0a99396` (Phase 2 complete).

---

## What shipped so far

### Plugin architecture (foundation)

| Piece | Detail |
|---|---|
| `@atlas/provider-sdk` | `ProviderModule` contract + `ProviderRegistry` |
| Built-in modules | `razorpayModule`, `whatsappModule` in provider packages |
| Server registry | `ATLAS_PROVIDERS=razorpay,whatsapp` filter; auto-mount paths |
| Webhook signers | Delegated to provider modules via `store.setWebhookSigners()` |
| Generic control API | `GET /providers`, `POST …/credentials/:providerId`, `PUT …/webhooks/:providerId`, `POST …/providers/:id/ops/:opName` |
| Legacy routes | All Phase 2 control paths kept as aliases |
| Core types | `ProviderName` is `string`; credentials/webhooks are `Record<string, …>` |

### Scenario catalog (local)

- `scenarios/index.json` — tagged manifest pointing at `examples/*.scenario.json`
- CLI: `atlas scenario list` (see CLI help)

---

## Remaining (Phase 3)

- Inspect console at `/console`
- `atlas init` command
- `examples/quickstart-consumer` + GitHub Actions recipe
- Expanded `CONSUMER_GUIDE.md` product quickstart
- First post-registry provider slice (Stripe or Telegram)
- Console scenario browser

---

## Revert

To return to pre-Phase-3 state:

```bash
git log --oneline   # find baseline commit 0a99396
git checkout 0a99396 -- .   # restore tree (or git reset --hard 0a99396 to discard all Phase 3 commits)
```

---

## How to run

```bash
pnpm install
pnpm typecheck
pnpm dev

# List registered providers
curl -s localhost:4400/control/v1/providers | jq

# Generic credential issue
curl -s -X POST localhost:4400/control/v1/workspaces/demo/credentials/razorpay -d '{}'
```
