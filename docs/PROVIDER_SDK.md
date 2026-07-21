# Authoring an Atlas provider

Atlas providers implement the `ProviderModule` contract from [`@atlas/provider-sdk`](../packages/provider-sdk).

## Contract

| Field | Purpose |
|---|---|
| `id` | Stable slug (`stripe`, `telegram`, …) |
| `displayName` | Human label |
| `mountPaths` | HTTP mounts on the Atlas server (e.g. `/stripe/v1`) |
| `createApp(store)` | Hono sub-app (provider-shaped HTTP) |
| `issueCredentials` | Create simulation secrets for a workspace |
| `getCredentials` / `setCredentials` | Read/write workspace creds |
| `signWebhook` | Build outbound webhook headers for consumer handlers |
| `failureRuleSchemas` | Zod schemas for provider-specific chaos rules |
| `bootstrapHints` | Env var block for consumer quickstart |
| `controlOps` | Optional simulation helpers exposed at `/control/v1/.../ops/:name` |

## Steps to add a provider

1. Create `packages/providers-<name>/` with `createXxxApp` + `XxxService` (copy Razorpay/WhatsApp shape).
2. Add `src/module.ts` exporting `xxxModule: ProviderModule`.
3. Register in [`packages/server/src/providers.ts`](../packages/server/src/providers.ts).
4. Add scenario packs under `examples/` and entries in `scenarios/index.json`.
5. Do **not** edit `@atlas/core` type unions — extend via registry only.

## Generic control API

```bash
POST /control/v1/workspaces/:id/credentials/:providerId
PUT  /control/v1/workspaces/:id/webhooks/:providerId
POST /control/v1/workspaces/:id/providers/:providerId/ops/:opName
```

Legacy per-provider routes remain for backward compatibility.

## Environment

| Variable | Purpose |
|---|---|
| `ATLAS_PROVIDERS` | Comma-separated provider ids to load (default: all built-ins) |

## Example

See [`packages/providers-razorpay/src/module.ts`](../packages/providers-razorpay/src/module.ts).
