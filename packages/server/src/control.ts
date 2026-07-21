import {
  AtlasStore,
  type FailureRule,
  runScenario,
} from "@atlas/core";
import { RazorpayService } from "@atlas/providers-razorpay";
import { WhatsAppService } from "@atlas/providers-whatsapp";
import { Hono } from "hono";
import { z } from "zod";

const failureRuleSchema = z.union([
  z.object({
    type: z.literal("razorpay.payment.fail_next"),
    count: z.number().int().positive(),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal("whatsapp.send.fail_next"),
    count: z.number().int().positive(),
    code: z.number().optional(),
    message: z.string().optional(),
  }),
  z.object({
    type: z.literal("whatsapp.rate_limit"),
    remaining: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("webhook.delay"),
    provider: z.enum(["razorpay", "whatsapp"]),
    ms: z.number().int().nonnegative(),
    count: z.number().int().positive(),
    event: z.string().optional(),
  }),
  z.object({
    type: z.literal("webhook.duplicate"),
    provider: z.enum(["razorpay", "whatsapp"]),
    count: z.number().int().positive(),
    event: z.string().optional(),
  }),
  z.object({
    type: z.literal("webhook.drop"),
    provider: z.enum(["razorpay", "whatsapp"]),
    count: z.number().int().positive(),
    event: z.string().optional(),
  }),
]);

function serializeWorkspace(ws: ReturnType<AtlasStore["getWorkspace"]>) {
  return {
    id: ws.id,
    createdAt: ws.createdAt,
    clockMs: ws.clockMs,
    clockMode: ws.clockMode,
    credentials: {
      razorpay: ws.credentials.razorpay
        ? {
            keyId: ws.credentials.razorpay.keyId,
            keySecret: ws.credentials.razorpay.keySecret,
            webhookSecret: ws.credentials.razorpay.webhookSecret,
          }
        : null,
      whatsapp: ws.credentials.whatsapp
        ? {
            accessToken: ws.credentials.whatsapp.accessToken,
            phoneNumberId: ws.credentials.whatsapp.phoneNumberId,
            displayPhoneNumber: ws.credentials.whatsapp.displayPhoneNumber,
            wabaId: ws.credentials.whatsapp.wabaId,
            appSecret: ws.credentials.whatsapp.appSecret,
            verifyToken: ws.credentials.whatsapp.verifyToken,
            flowsPublicKeyPem: ws.credentials.whatsapp.flowsPublicKeyPem,
            consumerFlowsPublicKeyPem: ws.credentials.whatsapp.consumerFlowsPublicKeyPem ?? null,
          }
        : null,
    },
    webhooks: ws.webhooks,
    failureRules: ws.failureRules,
    eventCount: ws.events.length,
    entityCount: ws.entities.size,
    scheduledWebhooks: ws.scheduledWebhooks.map((j) => ({
      id: j.id,
      provider: j.provider,
      event: j.event,
      dueAt: j.dueAt,
      status: j.status,
      responseStatus: j.responseStatus,
    })),
  };
}

export function createControlApp(store: AtlasStore): Hono {
  const app = new Hono();
  const razorpay = new RazorpayService(store);
  const whatsapp = new WhatsAppService(store);

  app.use("/*", async (c, next) => {
    const token = process.env.ATLAS_CONTROL_TOKEN;
    if (token) {
      const got = c.req.header("x-atlas-token") ?? c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
      if (got !== token) return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });

  app.post("/workspaces", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z
      .object({
        id: z.string().min(1).optional(),
        clockMode: z.enum(["virtual", "realtime"]).optional(),
      })
      .safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    try {
      const ws = store.createWorkspace(parsed.data.id, parsed.data.clockMode ?? "virtual");
      return c.json(serializeWorkspace(ws), 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.get("/workspaces", (c) => {
    return c.json({
      items: store.listWorkspaces().map(serializeWorkspace),
    });
  });

  app.get("/workspaces/:id", (c) => {
    try {
      return c.json(serializeWorkspace(store.getWorkspace(c.req.param("id"))));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
  });

  app.delete("/workspaces/:id", (c) => {
    try {
      store.deleteWorkspace(c.req.param("id"));
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
  });

  app.post("/workspaces/:id/credentials/razorpay", (c) => {
    try {
      const ws = store.getWorkspace(c.req.param("id"));
      const creds = store.issueRazorpayCredentials(ws);
      return c.json(creds);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
  });

  app.post("/workspaces/:id/credentials/whatsapp", async (c) => {
    try {
      const ws = store.getWorkspace(c.req.param("id"));
      const body = await c.req.json().catch(() => ({}));
      const creds = store.issueWhatsAppCredentials(ws, body);
      return c.json(creds);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
  });

  app.put("/workspaces/:id/webhooks/razorpay", async (c) => {
    try {
      const ws = store.getWorkspace(c.req.param("id"));
      const body = z
        .object({ url: z.string().url(), secret: z.string().min(1) })
        .parse(await c.req.json());
      store.setWebhook(ws, "razorpay", body);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.put("/workspaces/:id/webhooks/whatsapp", async (c) => {
    try {
      const ws = store.getWorkspace(c.req.param("id"));
      const body = z
        .object({
          url: z.string().url(),
          secret: z.string().min(1),
          appSecret: z.string().optional(),
        })
        .parse(await c.req.json());
      store.setWebhook(ws, "whatsapp", body);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/workspaces/:id/clock/advance", async (c) => {
    try {
      const ws = store.getWorkspace(c.req.param("id"));
      const body = z.object({ ms: z.number().int().nonnegative() }).parse(await c.req.json());
      const due = await store.advanceClock(ws, body.ms);
      return c.json({ now: store.now(ws), flushed: due.map((j) => j.id) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.get("/workspaces/:id/events", (c) => {
    try {
      const ws = store.getWorkspace(c.req.param("id"));
      const limit = Number(c.req.query("limit") ?? 100);
      return c.json({ items: ws.events.slice(-limit) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
  });

  app.get("/workspaces/:id/entities", (c) => {
    try {
      const ws = store.getWorkspace(c.req.param("id"));
      const items = [...ws.entities.entries()].map(([key, value]) => ({ key, value }));
      return c.json({ items });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
  });

  app.post("/workspaces/:id/failures", async (c) => {
    try {
      const ws = store.getWorkspace(c.req.param("id"));
      const body = z.object({ rules: z.array(failureRuleSchema) }).parse(await c.req.json());
      store.setFailureRules(ws, body.rules as FailureRule[]);
      return c.json({ ok: true, rules: ws.failureRules });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/workspaces/:id/scenarios/run", async (c) => {
    try {
      const ws = store.getWorkspace(c.req.param("id"));
      const body = await c.req.json();
      const result = await runScenario(store, ws, body);
      return c.json(result, result.ok ? 200 : 422);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/workspaces/:id/razorpay/payments/:paymentId/capture", (c) => {
    try {
      const ws = store.getWorkspace(c.req.param("id"));
      const payment = razorpay.capturePayment(ws, c.req.param("paymentId"));
      return c.json(payment);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/workspaces/:id/razorpay/orders/:orderId/pay", async (c) => {
    try {
      const ws = store.getWorkspace(c.req.param("id"));
      const order = razorpay.getOrder(ws, c.req.param("orderId"));
      if (!order) return c.json({ error: "Order not found" }, 404);
      const body = await c.req.json().catch(() => ({}));
      const capture = body.capture !== false;
      const payment = razorpay.attemptPayment(ws, {
        amount: order.amount,
        currency: order.currency,
        order_id: order.id,
        capture,
      });
      return c.json(payment);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/workspaces/:id/razorpay/payment-links/:linkId/pay", (c) => {
    try {
      const ws = store.getWorkspace(c.req.param("id"));
      return c.json(razorpay.payPaymentLink(ws, c.req.param("linkId")));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/workspaces/:id/razorpay/subscriptions/:subId/charge", (c) => {
    try {
      const ws = store.getWorkspace(c.req.param("id"));
      return c.json(razorpay.chargeSubscription(ws, c.req.param("subId")));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/workspaces/:id/razorpay/subscriptions/:subId/status", async (c) => {
    try {
      const ws = store.getWorkspace(c.req.param("id"));
      const body = z
        .object({
          status: z.enum([
            "created",
            "authenticated",
            "active",
            "pending",
            "halted",
            "paused",
            "cancelled",
            "completed",
          ]),
        })
        .parse(await c.req.json());
      return c.json(razorpay.setSubscriptionStatus(ws, c.req.param("subId"), body.status));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/workspaces/:id/razorpay/subscriptions/:subId/pause", (c) => {
    try {
      const ws = store.getWorkspace(c.req.param("id"));
      return c.json(razorpay.pauseSubscription(ws, c.req.param("subId")));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/workspaces/:id/razorpay/subscriptions/:subId/resume", (c) => {
    try {
      const ws = store.getWorkspace(c.req.param("id"));
      return c.json(razorpay.resumeSubscription(ws, c.req.param("subId")));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.patch("/workspaces/:id/razorpay/subscriptions/:subId", async (c) => {
    try {
      const ws = store.getWorkspace(c.req.param("id"));
      const body = z
        .object({
          quantity: z.number().int().positive().optional(),
          total_count: z.number().int().positive().optional(),
          notes: z.record(z.string()).optional(),
        })
        .parse(await c.req.json());
      return c.json(razorpay.updateSubscription(ws, c.req.param("subId"), body));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/workspaces/:id/whatsapp/inbound", async (c) => {
    try {
      const ws = store.getWorkspace(c.req.param("id"));
      const body = z
        .object({
          from: z.string(),
          type: z.string().optional(),
          text: z.string().optional(),
          interactive: z.unknown().optional(),
          button: z.object({ payload: z.string(), text: z.string() }).optional(),
        })
        .parse(await c.req.json());
      const msg = whatsapp.injectInbound(ws, body);
      return c.json(msg);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/workspaces/:id/whatsapp/flow-submission", async (c) => {
    try {
      const ws = store.getWorkspace(c.req.param("id"));
      const body = z
        .object({
          from: z.string(),
          flowName: z.string().optional(),
          responseJson: z.record(z.unknown()),
        })
        .parse(await c.req.json());
      const msg = whatsapp.injectFlowSubmission(ws, body);
      return c.json(msg);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/workspaces/:id/whatsapp/receipts", async (c) => {
    try {
      const ws = store.getWorkspace(c.req.param("id"));
      const body = z
        .object({
          messageId: z.string(),
          status: z.enum(["sent", "delivered", "read", "failed"]),
        })
        .parse(await c.req.json());
      const msg = whatsapp.advanceReceipts(ws, body.messageId, body.status);
      return c.json(msg);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.put("/workspaces/:id/whatsapp/flows/consumer-public-key", async (c) => {
    try {
      const ws = store.getWorkspace(c.req.param("id"));
      if (!ws.credentials.whatsapp) return c.json({ error: "WhatsApp credentials not issued" }, 400);
      const body = z.object({ publicKeyPem: z.string().min(1) }).parse(await c.req.json());
      ws.credentials.whatsapp.consumerFlowsPublicKeyPem = body.publicKeyPem;
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/workspaces/:id/whatsapp/flows/post-to-consumer", async (c) => {
    try {
      const ws = store.getWorkspace(c.req.param("id"));
      const creds = ws.credentials.whatsapp;
      if (!creds) return c.json({ error: "WhatsApp credentials not issued" }, 400);
      const body = z
        .object({
          url: z.string().url().optional(),
          action: z.object({
            version: z.string().default("7.3"),
            action: z.string(),
            screen: z.string().optional(),
            data: z.record(z.unknown()).optional(),
            flow_token: z.string().optional(),
          }),
          publicKeyPem: z.string().optional(),
        })
        .parse(await c.req.json());
      const { encryptFlowsRequest } = await import("@atlas/providers-whatsapp");
      const pem = body.publicKeyPem ?? creds.consumerFlowsPublicKeyPem;
      if (!pem) return c.json({ error: "consumerFlowsPublicKeyPem not set" }, 400);
      const target =
        body.url ??
        ws.webhooks.whatsapp?.url?.replace(/\/whatsapp(?:\/[^/]+)?$/, "/whatsapp/flows") ??
        null;
      if (!target) return c.json({ error: "No flows URL (pass url or set whatsapp webhook)" }, 400);
      const encrypted = encryptFlowsRequest(body.action, pem);
      const res = await fetch(target, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Hub-Signature-256": `sha256=${(await import("@atlas/core")).hmacSha256Hex(creds.appSecret, JSON.stringify(encrypted))}`,
        },
        body: JSON.stringify(encrypted),
      });
      const text = await res.text();
      return c.json({ status: res.status, body: text.slice(0, 2000) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  return app;
}
