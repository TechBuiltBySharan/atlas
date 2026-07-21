import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createAtlasApp } from "../src/index.js";

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

describe("Atlas Phase 1 live slice", () => {
  it("fails payments, delays+duplicates webhook, then settles order", async () => {
    const app = createAtlasApp();
    const receiver = await listen();

    const wsRes = await app.request("/control/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "phase1" }),
    });
    expect(wsRes.status).toBe(201);

    const credRes = await app.request("/control/v1/workspaces/phase1/credentials/razorpay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const creds = await credRes.json();
    expect(creds.keyId).toBeTruthy();

    await app.request("/control/v1/workspaces/phase1/webhooks/razorpay", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: receiver.url, secret: creds.webhookSecret }),
    });

    await app.request("/control/v1/workspaces/phase1/failures", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rules: [
          { type: "razorpay.payment.fail_next", count: 3 },
          {
            type: "webhook.delay",
            provider: "razorpay",
            ms: 42000,
            count: 1,
            event: "payment.captured",
          },
          {
            type: "webhook.duplicate",
            provider: "razorpay",
            count: 1,
            event: "payment.captured",
          },
        ],
      }),
    });

    const auth = Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString("base64");
    const orderRes = await app.request("/razorpay/v1/orders", {
      method: "POST",
      headers: {
        authorization: `Basic ${auth}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ amount: 50000, currency: "INR", receipt: "ticket-1" }),
    });
    const order = await orderRes.json();
    expect(order.id).toMatch(/^order_/);

    for (let i = 0; i < 3; i++) {
      const failRes = await app.request("/razorpay/v1/payments", {
        method: "POST",
        headers: {
          authorization: `Basic ${auth}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ amount: 50000, order_id: order.id }),
      });
      const failed = await failRes.json();
      expect(failed.status).toBe("failed");
    }

    const payRes = await app.request("/control/v1/workspaces/phase1/razorpay/orders/" + order.id + "/pay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const paid = await payRes.json();
    expect(paid.status).toBe("captured");

    // delayed capture webhook — payment.failed may already have arrived
    await new Promise((r) => setTimeout(r, 30));
    const capturedBefore = receiver.bodies.filter((b) => b.includes("payment.captured"));
    expect(capturedBefore.length).toBe(0);

    await app.request("/control/v1/workspaces/phase1/clock/advance", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ms: 42000 }),
    });
    await new Promise((r) => setTimeout(r, 80));

    const captured = receiver.bodies.filter((b) => b.includes("payment.captured"));
    expect(captured.length).toBeGreaterThanOrEqual(2);

    const orderGet = await app.request(`/razorpay/v1/orders/${order.id}`, {
      headers: { authorization: `Basic ${auth}` },
    });
    const settled = await orderGet.json();
    expect(settled.status).toBe("paid");

    await receiver.close();
  });

  it("sends WhatsApp message and injects inbound reply", async () => {
    const app = createAtlasApp();
    const receiver = await listen();

    await app.request("/control/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "wa" }),
    });
    const credRes = await app.request("/control/v1/workspaces/wa/credentials/whatsapp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const creds = await credRes.json();

    await app.request("/control/v1/workspaces/wa/webhooks/whatsapp", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: receiver.url, secret: creds.appSecret, appSecret: creds.appSecret }),
    });

    const sendRes = await app.request(`/whatsapp/v22.0/${creds.phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${creds.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: "919876543210",
        type: "text",
        text: { body: "Your ticket is confirmed" },
      }),
    });
    const sent = await sendRes.json();
    expect(sent.messages[0].id).toBeTruthy();

    await new Promise((r) => setTimeout(r, 50));
    expect(receiver.bodies.some((b) => b.includes("\"status\":\"sent\""))).toBe(true);

    await app.request("/control/v1/workspaces/wa/whatsapp/inbound", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "919876543210", text: "Thanks!" }),
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(receiver.bodies.some((b) => b.includes("Thanks!"))).toBe(true);

    await receiver.close();
  });
});
