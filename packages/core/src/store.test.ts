import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { AtlasStore, hmacSha256Hex, runScenario } from "../src/index.js";

describe("AtlasStore", () => {
  const stores: AtlasStore[] = [];
  afterEach(() => {
    stores.length = 0;
  });

  function store() {
    const s = new AtlasStore();
    stores.push(s);
    return s;
  }

  it("creates isolated workspaces with virtual clock", async () => {
    const s = store();
    const ws = s.createWorkspace("demo");
    expect(ws.id).toBe("demo");
    expect(ws.clockMode).toBe("virtual");
    const t0 = s.now(ws);
    await s.advanceClock(ws, 1000);
    expect(s.now(ws)).toBe(t0 + 1000);
  });

  it("issues razorpay credentials and finds workspace by key", () => {
    const s = store();
    const ws = s.createWorkspace("rzp");
    const creds = s.issueRazorpayCredentials(ws);
    expect(creds.keyId.startsWith("rzp_test_atlas_")).toBe(true);
    expect(s.findWorkspaceByRazorpayKey(creds.keyId)?.id).toBe("rzp");
  });

  it("delays, duplicates, and delivers signed razorpay webhooks", async () => {
    const s = store();
    const ws = s.createWorkspace("wh");
    const creds = s.issueRazorpayCredentials(ws);

    const received: { body: string; sig: string | null }[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        received.push({ body, sig: req.headers["x-razorpay-signature"] as string });
        res.writeHead(200);
        res.end("ok");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    const url = `http://127.0.0.1:${addr.port}/hook`;

    s.setWebhook(ws, "razorpay", { url, secret: creds.webhookSecret });
    s.setFailureRules(ws, [
      { type: "webhook.delay", provider: "razorpay", ms: 5000, count: 1 },
      { type: "webhook.duplicate", provider: "razorpay", count: 1 },
    ]);

    const payload = { event: "payment.captured", payload: { payment: { entity: { id: "pay_1" } } } };
    s.scheduleWebhook(ws, "razorpay", "payment.captured", payload);
    expect(received).toHaveLength(0);

    await s.advanceClock(ws, 5000);
    // allow fetch to settle
    await new Promise((r) => setTimeout(r, 50));

    expect(received.length).toBeGreaterThanOrEqual(2);
    for (const r of received) {
      expect(r.sig).toBe(hmacSha256Hex(creds.webhookSecret, r.body));
    }

    server.close();
  });

  it("delivered body always matches the signed body, even if the payload's underlying entity is mutated before delivery runs", async () => {
    // Regression: scheduleWebhook signed a body snapshot, but deliverWebhook used
    // to re-serialize job.payload at send time. Real providers do this for real —
    // subscription creation fires two webhook-triggering status transitions
    // (authenticated, then active) synchronously against the same mutable
    // subscription object, before either delivery's fire-and-forget fetch runs.
    const s = store();
    const ws = s.createWorkspace("mutation");
    const creds = s.issueRazorpayCredentials(ws);

    const received: { body: string; sig: string | null }[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        received.push({
          body: Buffer.concat(chunks).toString("utf8"),
          sig: req.headers["x-razorpay-signature"] as string,
        });
        res.writeHead(200);
        res.end("ok");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    s.setWebhook(ws, "razorpay", { url: `http://127.0.0.1:${addr.port}/hook`, secret: creds.webhookSecret });

    // A mutable "entity" shared by two payloads, exactly as a live subscription
    // object would be shared across its authenticated → active webhook payloads.
    const sharedEntity = { id: "sub_1", status: "authenticated" };
    s.scheduleWebhook(ws, "razorpay", "subscription.authenticated", { event: "subscription.authenticated", payload: { subscription: { entity: sharedEntity } } });
    // Mutate before either delivery's fetch has actually run (both scheduleWebhook
    // calls happen synchronously; delivery is fire-and-forget).
    sharedEntity.status = "active";
    s.scheduleWebhook(ws, "razorpay", "subscription.activated", { event: "subscription.activated", payload: { subscription: { entity: sharedEntity } } });

    await new Promise((r) => setTimeout(r, 50));

    expect(received).toHaveLength(2);
    for (const r of received) {
      expect(r.sig).toBe(hmacSha256Hex(creds.webhookSecret, r.body));
    }
    // The first delivery's body must reflect the state at schedule time
    // ("authenticated"), not the mutated state by the time it was sent.
    expect(received[0]!.body).toContain('"status":"authenticated"');
    expect(received[1]!.body).toContain('"status":"active"');

    server.close();
  });

  it("runs a scenario that sets failures and asserts webhooks", async () => {
    const s = store();
    const ws = s.createWorkspace("scen");
    const creds = s.issueRazorpayCredentials(ws);

    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    s.setWebhook(ws, "razorpay", {
      url: `http://127.0.0.1:${addr.port}/hook`,
      secret: creds.webhookSecret,
    });

    s.scheduleWebhook(ws, "razorpay", "payment.captured", { event: "payment.captured" });
    await new Promise((r) => setTimeout(r, 30));

    const result = await runScenario(s, ws, {
      name: "basic",
      steps: [
        { op: "assert.webhook", provider: "razorpay", event: "payment.captured", minCount: 1 },
      ],
    });
    expect(result.ok).toBe(true);
    server.close();
  });
});
