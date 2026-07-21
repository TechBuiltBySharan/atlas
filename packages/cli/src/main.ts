#!/usr/bin/env node
const base = process.env.ATLAS_URL ?? "http://127.0.0.1:4400";
const token = process.env.ATLAS_CONTROL_TOKEN;

async function apiRaw(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: unknown }> {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  if (token) headers.set("x-atlas-token", token);
  const res = await fetch(`${base}${path}`, { ...init, headers });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { ok: res.ok, status: res.status, body };
}

async function api(path: string, init?: RequestInit) {
  const result = await apiRaw(path, init);
  if (!result.ok) {
    console.error(JSON.stringify(result.body, null, 2));
    process.exitCode = 1;
    return undefined;
  }
  console.log(JSON.stringify(result.body, null, 2));
  return result.body;
}

function usage() {
  console.log(`Atlas CLI

Usage:
  atlas health
  atlas bootstrap [workspaceId] [--webhook-base <url>]
  atlas workspace create [id]
  atlas workspace get <id>
  atlas workspace reset <id>
  atlas creds razorpay <workspaceId>
  atlas creds whatsapp <workspaceId>
  atlas webhook razorpay <workspaceId> <url> <secret>
  atlas webhook whatsapp <workspaceId> <url> <secret>
  atlas failures <workspaceId> <rules.json>
  atlas clock advance <workspaceId> <ms>
  atlas events <workspaceId>
  atlas scenario run <workspaceId> <file.json>
  atlas razorpay pay <workspaceId> <orderId>
  atlas razorpay pay-link <workspaceId> <paymentLinkId>
  atlas razorpay charge-sub <workspaceId> <subscriptionId>
  atlas whatsapp inbound <workspaceId> <from> <text>

Env:
  ATLAS_URL              default http://127.0.0.1:4400
  ATLAS_CONTROL_TOKEN    optional control token
`);
}

type CredsRzp = { keyId: string; keySecret: string; webhookSecret: string };
type CredsWa = {
  accessToken: string;
  phoneNumberId: string;
  displayPhoneNumber: string;
  wabaId: string;
  appSecret: string;
  verifyToken: string;
};

async function bootstrap(workspaceId: string, webhookBase?: string) {
  const health = await apiRaw("/health");
  if (!health.ok) {
    console.error(`Atlas is not reachable at ${base}. Start it with: pnpm dev  OR  docker compose up`);
    process.exitCode = 1;
    return;
  }

  let ws = await apiRaw(`/control/v1/workspaces/${workspaceId}`);
  if (!ws.ok) {
    ws = await apiRaw("/control/v1/workspaces", {
      method: "POST",
      body: JSON.stringify({ id: workspaceId }),
    });
    if (!ws.ok) {
      console.error(JSON.stringify(ws.body, null, 2));
      process.exitCode = 1;
      return;
    }
  }

  const existing = ws.body as {
    credentials?: { razorpay?: CredsRzp | null; whatsapp?: CredsWa | null };
  };

  let rzp = existing.credentials?.razorpay ?? null;
  if (!rzp) {
    const issued = await apiRaw(`/control/v1/workspaces/${workspaceId}/credentials/razorpay`, {
      method: "POST",
      body: "{}",
    });
    if (!issued.ok) {
      console.error(JSON.stringify(issued.body, null, 2));
      process.exitCode = 1;
      return;
    }
    rzp = issued.body as CredsRzp;
  }

  let wa = existing.credentials?.whatsapp ?? null;
  if (!wa) {
    const issued = await apiRaw(`/control/v1/workspaces/${workspaceId}/credentials/whatsapp`, {
      method: "POST",
      body: "{}",
    });
    if (!issued.ok) {
      console.error(JSON.stringify(issued.body, null, 2));
      process.exitCode = 1;
      return;
    }
    wa = issued.body as CredsWa;
  }

  const baseUrl = (webhookBase ?? "http://127.0.0.1:3000").replace(/\/$/, "");
  await apiRaw(`/control/v1/workspaces/${workspaceId}/webhooks/razorpay`, {
    method: "PUT",
    body: JSON.stringify({
      url: `${baseUrl}/api/webhooks/razorpay`,
      secret: rzp.webhookSecret,
    }),
  });
  await apiRaw(`/control/v1/workspaces/${workspaceId}/webhooks/whatsapp`, {
    method: "PUT",
    body: JSON.stringify({
      url: `${baseUrl}/api/webhooks/whatsapp`,
      secret: wa.appSecret,
      appSecret: wa.appSecret,
    }),
  });

  console.log(`# Atlas bootstrap — workspace: ${workspaceId}`);
  console.log(`# Atlas URL: ${base}`);
  console.log(`# Webhooks → ${baseUrl}/api/webhooks/{razorpay,whatsapp}`);
  console.log("");
  console.log("# ── Sociatribe .env.local (paste) ─────────────────────────────");
  console.log(`RAZORPAY_API_BASE_URL=${base}/razorpay`);
  console.log(`WHATSAPP_GRAPH_BASE_URL=${base}/whatsapp/v22.0`);
  console.log(`NEXT_PUBLIC_RAZORPAY_CHECKOUT_JS_URL=${base}/razorpay/checkout.js`);
  console.log(`RAZORPAY_PLATFORM_KEY_ID=${rzp.keyId}`);
  console.log(`RAZORPAY_PLATFORM_KEY_SECRET=${rzp.keySecret}`);
  console.log(`RAZORPAY_PLATFORM_WEBHOOK_SECRET=${rzp.webhookSecret}`);
  console.log(`WHATSAPP_ACCESS_TOKEN=${wa.accessToken}`);
  console.log(`WHATSAPP_PHONE_NUMBER_ID=${wa.phoneNumberId}`);
  console.log(`WHATSAPP_BUSINESS_ACCOUNT_ID=${wa.wabaId}`);
  console.log(`WHATSAPP_WEBHOOK_VERIFY_TOKEN=${wa.verifyToken}`);
  console.log(`WHATSAPP_APP_SECRET=${wa.appSecret}`);
  console.log("");
  console.log("# Also seed payment_providers / waba_configs with the same secrets if using DB-backed creds.");
  console.log(`# See examples/sociatribe.env.example`);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    usage();
    return;
  }

  switch (cmd) {
    case "health":
      return api("/health");
    case "bootstrap": {
      const id = args[0] && !args[0].startsWith("--") ? args[0] : "sociatribe-local";
      const wbIdx = args.indexOf("--webhook-base");
      const webhookBase = wbIdx >= 0 ? args[wbIdx + 1] : undefined;
      return bootstrap(id, webhookBase);
    }
    case "workspace": {
      const sub = args[0];
      if (sub === "create") {
        return api("/control/v1/workspaces", {
          method: "POST",
          body: JSON.stringify(args[1] ? { id: args[1] } : {}),
        });
      }
      if (sub === "get" && args[1]) return api(`/control/v1/workspaces/${args[1]}`);
      if (sub === "reset" && args[1]) {
        return api(`/control/v1/workspaces/${args[1]}`, { method: "DELETE" });
      }
      break;
    }
    case "creds": {
      const provider = args[0];
      const id = args[1];
      if (!provider || !id) break;
      return api(`/control/v1/workspaces/${id}/credentials/${provider}`, {
        method: "POST",
        body: "{}",
      });
    }
    case "webhook": {
      const provider = args[0];
      const id = args[1];
      const url = args[2];
      const secret = args[3];
      if (!provider || !id || !url || !secret) break;
      return api(`/control/v1/workspaces/${id}/webhooks/${provider}`, {
        method: "PUT",
        body: JSON.stringify({ url, secret, appSecret: secret }),
      });
    }
    case "failures": {
      const id = args[0];
      const file = args[1];
      if (!id || !file) break;
      const { readFile } = await import("node:fs/promises");
      const rules = JSON.parse(await readFile(file, "utf8"));
      return api(`/control/v1/workspaces/${id}/failures`, {
        method: "POST",
        body: JSON.stringify(Array.isArray(rules) ? { rules } : rules),
      });
    }
    case "clock": {
      if (args[0] === "advance" && args[1] && args[2]) {
        return api(`/control/v1/workspaces/${args[1]}/clock/advance`, {
          method: "POST",
          body: JSON.stringify({ ms: Number(args[2]) }),
        });
      }
      break;
    }
    case "events":
      if (args[0]) return api(`/control/v1/workspaces/${args[0]}/events`);
      break;
    case "scenario": {
      if (args[0] === "run" && args[1] && args[2]) {
        const { readFile } = await import("node:fs/promises");
        const scenario = JSON.parse(await readFile(args[2], "utf8"));
        return api(`/control/v1/workspaces/${args[1]}/scenarios/run`, {
          method: "POST",
          body: JSON.stringify(scenario),
        });
      }
      break;
    }
    case "razorpay": {
      if (args[0] === "pay" && args[1] && args[2]) {
        return api(`/control/v1/workspaces/${args[1]}/razorpay/orders/${args[2]}/pay`, {
          method: "POST",
          body: "{}",
        });
      }
      if (args[0] === "pay-link" && args[1] && args[2]) {
        return api(`/control/v1/workspaces/${args[1]}/razorpay/payment-links/${args[2]}/pay`, {
          method: "POST",
          body: "{}",
        });
      }
      if (args[0] === "charge-sub" && args[1] && args[2]) {
        return api(`/control/v1/workspaces/${args[1]}/razorpay/subscriptions/${args[2]}/charge`, {
          method: "POST",
          body: "{}",
        });
      }
      break;
    }
    case "whatsapp": {
      if (args[0] === "inbound" && args[1] && args[2] && args[3]) {
        return api(`/control/v1/workspaces/${args[1]}/whatsapp/inbound`, {
          method: "POST",
          body: JSON.stringify({ from: args[2], text: args[3] }),
        });
      }
      break;
    }
  }

  usage();
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
