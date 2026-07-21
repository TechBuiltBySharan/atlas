# Consumer integration guide (Sociatribe and others)

Atlas is a drop-in simulation twin. Your app keeps its real Razorpay/WhatsApp client code; you only change base URLs and credentials.

## 1. Start Atlas

```bash
pnpm install
pnpm dev
# http://127.0.0.1:4400
```

## 2. Create a workspace + credentials

```bash
pnpm atlas -- workspace create sociatribe-local
pnpm atlas -- creds razorpay sociatribe-local
pnpm atlas -- creds whatsapp sociatribe-local
```

Point webhooks at your app:

```bash
pnpm atlas -- webhook razorpay sociatribe-local \
  http://127.0.0.1:3000/api/webhooks/razorpay \
  <webhookSecret from creds>

pnpm atlas -- webhook whatsapp sociatribe-local \
  http://127.0.0.1:3000/api/webhooks/whatsapp \
  <appSecret from creds>
```

## 3. App env overrides (recommended seams)

```env
RAZORPAY_API_BASE_URL=http://127.0.0.1:4400/razorpay
WHATSAPP_GRAPH_BASE_URL=http://127.0.0.1:4400/whatsapp/v22.0

# Use Atlas-issued key_id / key_secret / access_token / phone_number_id
```

In code (Sociatribe today hardcodes hosts — add these env seams):

```ts
const razorpayBase = process.env.RAZORPAY_API_BASE_URL ?? 'https://api.razorpay.com';
const graphBase =
  process.env.WHATSAPP_GRAPH_BASE_URL ??
  `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION ?? 'v22.0'}`;
```

## 4. Agent example (MCP)

With Atlas running and MCP configured:

> Create workspace `demo`, issue Razorpay creds, set webhook to my local app,
> fail the next 3 payments, delay the next webhook by 42 seconds, duplicate it,
> then pay the order and advance time.

Tools used: `atlas_workspace_create`, `atlas_issue_credentials`, `atlas_set_webhook`,
`atlas_set_failures`, `atlas_razorpay_pay_order`, `atlas_clock_advance`, `atlas_events_list`.

## 5. Important

Atlas is **not real money** and **not Meta**. Never point production traffic at it.
