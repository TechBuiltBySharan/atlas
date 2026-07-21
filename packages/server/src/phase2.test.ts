import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AtlasStore, SqliteWorkspaceStore, scenarioSchema } from "@atlas/core";
import { encryptFlowsRequest } from "@atlas/providers-whatsapp";
import { createAtlasApp } from "../src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function listen(): Promise<{ url: string; close: () => Promise<void>; bodies: string[] }> {
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200);
      res.end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  return {
    url: `http://127.0.0.1:${addr.port}/hook`,
    bodies,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

function loadScenario(name: string) {
  const raw = JSON.parse(
    readFileSync(path.join(repoRoot, "examples", `${name}.scenario.json`), "utf8"),
  );
  return scenarioSchema.parse(raw);
}

describe("Atlas Phase 2", () => {
  it("ticket-purchase: order → checkout complete → scenario pack", async () => {
    const app = createAtlasApp();
    const receiver = await listen();

    await app.request("/control/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "ticket" }),
    });
    const creds = await (
      await app.request("/control/v1/workspaces/ticket/credentials/razorpay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).json();

    await app.request("/control/v1/workspaces/ticket/webhooks/razorpay", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: receiver.url, secret: creds.webhookSecret }),
    });

    const auth = Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString("base64");
    const order = await (
      await app.request("/razorpay/v1/orders", {
        method: "POST",
        headers: {
          authorization: `Basic ${auth}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ amount: 25000, currency: "INR", receipt: "tix-1" }),
      })
    ).json();

    const complete = await (
      await app.request("/razorpay/v1/checkout/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: creds.keyId, order_id: order.id }),
      })
    ).json();
    expect(complete.razorpay_payment_id).toMatch(/^pay_/);
    expect(complete.razorpay_signature).toBeTruthy();

    await new Promise((r) => setTimeout(r, 40));
    expect(receiver.bodies.some((b) => b.includes("payment.captured"))).toBe(true);

    const scenario = loadScenario("ticket-purchase");
    const run = await (
      await app.request("/control/v1/workspaces/ticket/scenarios/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(scenario),
      })
    ).json();
    expect(run.ok).toBe(true);
    await receiver.close();
  });

  it("subscription webhooks: created(internal) + authenticated/activated/charged/pending/halted/paused/resumed/updated/completed/cancelled", async () => {
    const app = createAtlasApp();
    const receiver = await listen();

    await app.request("/control/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "sub-events" }),
    });
    const creds = await (
      await app.request("/control/v1/workspaces/sub-events/credentials/razorpay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).json();
    await app.request("/control/v1/workspaces/sub-events/webhooks/razorpay", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: receiver.url, secret: creds.webhookSecret }),
    });

    const auth = Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString("base64");
    const plan = await (
      await app.request("/razorpay/v1/plans", {
        method: "POST",
        headers: {
          authorization: `Basic ${auth}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          period: "monthly",
          interval: 1,
          item: { name: "Membership", amount: 10000, currency: "INR" },
        }),
      })
    ).json();

    const subscription = await (
      await app.request("/razorpay/v1/subscriptions", {
        method: "POST",
        headers: {
          authorization: `Basic ${auth}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ plan_id: plan.id, total_count: 2 }),
      })
    ).json();
    await new Promise((r) => setTimeout(r, 40));

    const events = () =>
      receiver.bodies.map((b) => {
        try {
          return (JSON.parse(b) as { event?: string }).event;
        } catch {
          return undefined;
        }
      });

    expect(events()).toContain("subscription.authenticated");
    expect(events()).toContain("subscription.activated");
    expect(events()).not.toContain("subscription.created"); // Atlas-internal only

    // updated
    await app.request(`/razorpay/v1/subscriptions/${subscription.id}`, {
      method: "PATCH",
      headers: {
        authorization: `Basic ${auth}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ quantity: 2, notes: { seat: "A" } }),
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(events()).toContain("subscription.updated");

    // pause / resume
    await app.request(`/razorpay/v1/subscriptions/${subscription.id}/pause`, {
      method: "POST",
      headers: { authorization: `Basic ${auth}` },
    });
    await app.request(`/razorpay/v1/subscriptions/${subscription.id}/resume`, {
      method: "POST",
      headers: { authorization: `Basic ${auth}` },
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(events()).toContain("subscription.paused");
    expect(events()).toContain("subscription.resumed");

    // pending → halted via fail_next
    await app.request("/control/v1/workspaces/sub-events/failures", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rules: [{ type: "razorpay.payment.fail_next", count: 1 }] }),
    });
    await app.request(
      `/control/v1/workspaces/sub-events/razorpay/subscriptions/${subscription.id}/charge`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    await app.request(
      `/control/v1/workspaces/sub-events/razorpay/subscriptions/${subscription.id}/charge`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    await new Promise((r) => setTimeout(r, 40));
    expect(events()).toContain("subscription.pending");
    expect(events()).toContain("subscription.halted");

    // fresh sub for charge → completed + cancel path
    const sub2 = await (
      await app.request("/razorpay/v1/subscriptions", {
        method: "POST",
        headers: {
          authorization: `Basic ${auth}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ plan_id: plan.id, total_count: 1 }),
      })
    ).json();
    await app.request(
      `/control/v1/workspaces/sub-events/razorpay/subscriptions/${sub2.id}/charge`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    await new Promise((r) => setTimeout(r, 40));
    expect(events()).toContain("subscription.charged");
    expect(events()).toContain("subscription.completed");

    const sub3 = await (
      await app.request("/razorpay/v1/subscriptions", {
        method: "POST",
        headers: {
          authorization: `Basic ${auth}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ plan_id: plan.id, total_count: 12 }),
      })
    ).json();
    await app.request(`/razorpay/v1/subscriptions/${sub3.id}/cancel`, {
      method: "POST",
      headers: {
        authorization: `Basic ${auth}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(events()).toContain("subscription.cancelled");

    // internal created is in event log
    const evRes = await (
      await app.request("/control/v1/workspaces/sub-events/events")
    ).json();
    const types = (evRes.items as Array<{ type: string }>).map((e) => e.type);
    expect(types).toContain("subscription.created");

    await receiver.close();
  });

  it("subscription-lifecycle: plan → charge → invoice + pack", async () => {
    const app = createAtlasApp();
    const receiver = await listen();

    await app.request("/control/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "sub" }),
    });
    const creds = await (
      await app.request("/control/v1/workspaces/sub/credentials/razorpay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).json();
    await app.request("/control/v1/workspaces/sub/webhooks/razorpay", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: receiver.url, secret: creds.webhookSecret }),
    });

    const auth = Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString("base64");
    const plan = await (
      await app.request("/razorpay/v1/plans", {
        method: "POST",
        headers: {
          authorization: `Basic ${auth}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          period: "monthly",
          interval: 1,
          item: { name: "Membership", amount: 99900, currency: "INR" },
        }),
      })
    ).json();
    expect(plan.id).toMatch(/^plan_/);

    const subscription = await (
      await app.request("/razorpay/v1/subscriptions", {
        method: "POST",
        headers: {
          authorization: `Basic ${auth}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ plan_id: plan.id, total_count: 12 }),
      })
    ).json();
    expect(subscription.status).toBe("active");

    const charged = await (
      await app.request(`/control/v1/workspaces/sub/razorpay/subscriptions/${subscription.id}/charge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).json();
    expect(charged.invoice.status).toBe("paid");
    expect(charged.payment.subscription_id).toBe(subscription.id);

    await new Promise((r) => setTimeout(r, 40));

    const scenario = loadScenario("subscription-lifecycle");
    const run = await (
      await app.request("/control/v1/workspaces/sub/scenarios/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(scenario),
      })
    ).json();
    expect(run.ok).toBe(true);
    await receiver.close();
  });

  it("wa-flow-submit: injection + Flows crypto endpoint", async () => {
    const app = createAtlasApp();
    const receiver = await listen();

    await app.request("/control/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "flow" }),
    });
    const creds = await (
      await app.request("/control/v1/workspaces/flow/credentials/whatsapp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).json();
    await app.request("/control/v1/workspaces/flow/webhooks/whatsapp", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: receiver.url,
        secret: creds.appSecret,
        appSecret: creds.appSecret,
        verifyToken: creds.verifyToken,
      }),
    });

    const injected = await (
      await app.request("/control/v1/workspaces/flow/whatsapp/flow-submission", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          from: "919999000111",
          flowName: "ticket_details",
          responseJson: { seat: "A1" },
        }),
      })
    ).json();
    expect(injected.id).toBeTruthy();
    await new Promise((r) => setTimeout(r, 40));

    const scenario = loadScenario("wa-flow-submit");
    const run = await (
      await app.request("/control/v1/workspaces/flow/scenarios/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(scenario),
      })
    ).json();
    expect(run.ok).toBe(true);

    const pub = creds.flowsPublicKeyPem as string;
    expect(pub).toContain("BEGIN PUBLIC KEY");
    const body = encryptFlowsRequest({ version: "7.3", action: "ping" }, pub);
    const flowRes = await app.request("/whatsapp/v22.0/flows", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-atlas-workspace": "flow",
      },
      body: JSON.stringify(body),
    });
    expect(flowRes.status).toBe(200);
    const cipher = await flowRes.text();
    expect(cipher.length).toBeGreaterThan(10);

    await receiver.close();
  });

  it("settlements recon subset responds", async () => {
    const app = createAtlasApp();
    await app.request("/control/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "setl" }),
    });
    const creds = await (
      await app.request("/control/v1/workspaces/setl/credentials/razorpay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).json();
    const auth = Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString("base64");
    const list = await (
      await app.request("/razorpay/v1/settlements", {
        headers: { authorization: `Basic ${auth}` },
      })
    ).json();
    expect(list.items.length).toBeGreaterThan(0);
    const recon = await (
      await app.request("/razorpay/v1/settlements/recon/combined", {
        headers: { authorization: `Basic ${auth}` },
      })
    ).json();
    expect(recon.entity).toBeTruthy();
  });

  it("sqlite store survives restart", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "atlas-sqlite-"));
    const dbPath = path.join(dir, "atlas.sqlite");
    try {
      const store1 = new AtlasStore();
      const sqlite1 = new SqliteWorkspaceStore(dbPath);
      const ws = store1.createWorkspace("persist-me");
      store1.issueRazorpayCredentials(ws);
      sqlite1.saveAll(store1);
      sqlite1.close();

      const store2 = new AtlasStore();
      const sqlite2 = new SqliteWorkspaceStore(dbPath);
      expect(sqlite2.loadAll(store2)).toBe(1);
      const loaded = store2.getWorkspace("persist-me");
      expect(loaded.credentials.razorpay?.keyId).toMatch(/^rzp_test_atlas_/);
      sqlite2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checkout.js is served", async () => {
    const app = createAtlasApp();
    const res = await app.request("/razorpay/checkout.js");
    expect(res.status).toBe(200);
    const js = await res.text();
    expect(js).toContain("Razorpay");
    expect(js).toContain("checkout/complete");
  });
});
