import { type AtlasStore, type Workspace, hmacSha256Hex } from "@atlas/core";
import { Hono } from "hono";
import { z } from "zod";
import { checkoutJsSource } from "./checkout.js";
import { RazorpayService } from "./service.js";

type Vars = {
  Variables: {
    workspace: Workspace;
    keyId: string;
  };
};

function parseBasicAuth(header: string | undefined): { keyId: string; keySecret: string } | null {
  if (!header?.startsWith("Basic ")) return null;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  if (idx < 0) return null;
  return { keyId: decoded.slice(0, idx), keySecret: decoded.slice(idx + 1) };
}

function error(c: { json: (body: unknown, status: number) => Response }, status: number, description: string) {
  return c.json(
    {
      error: {
        code: "BAD_REQUEST_ERROR",
        description,
      },
    },
    status,
  );
}

export function createRazorpayApp(store: AtlasStore): Hono<Vars> {
  const app = new Hono<Vars>();
  const svc = new RazorpayService(store);

  app.get("/checkout.js", (c) => {
    const url = new URL(c.req.url);
    const origin = `${url.protocol}//${url.host}`;
    return new Response(checkoutJsSource(origin), {
      headers: {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "no-cache",
      },
    });
  });

  app.post("/v1/checkout/complete", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z
      .object({
        key: z.string(),
        order_id: z.string(),
        amount: z.union([z.number(), z.string()]).optional(),
      })
      .safeParse(body);
    if (!parsed.success) return error(c, 400, parsed.error.message);
    const ws = store.findWorkspaceByRazorpayKey(parsed.data.key);
    if (!ws?.credentials.razorpay) return error(c, 401, "Invalid API key");
    const order = svc.getOrder(ws, parsed.data.order_id);
    if (!order) return error(c, 400, "Order not found");
    try {
      const payment = svc.attemptPayment(ws, {
        amount: order.amount,
        currency: order.currency,
        order_id: order.id,
        capture: true,
      });
      if (payment.status !== "captured") {
        return error(c, 400, payment.error_description ?? "Payment failed");
      }
      const signature = hmacSha256Hex(
        ws.credentials.razorpay.keySecret,
        `${order.id}|${payment.id}`,
      );
      return c.json({
        razorpay_payment_id: payment.id,
        razorpay_order_id: order.id,
        razorpay_signature: signature,
      });
    } catch (err) {
      const status = (err as { status?: number }).status ?? 400;
      return error(c, status, err instanceof Error ? err.message : String(err));
    }
  });

  app.use("/v1/*", async (c, next) => {
    // checkout/complete is public (key in body)
    if (c.req.path.endsWith("/checkout/complete")) {
      await next();
      return;
    }
    const auth = parseBasicAuth(c.req.header("authorization"));
    if (!auth) return error(c, 401, "Authentication failed");
    const headerWs = c.req.header("x-atlas-workspace");
    const ws =
      (headerWs ? store.tryGetWorkspace(headerWs) : undefined) ??
      store.findWorkspaceByRazorpayKey(auth.keyId);
    if (!ws?.credentials.razorpay) return error(c, 401, "Invalid API key");
    if (ws.credentials.razorpay.keySecret !== auth.keySecret) {
      return error(c, 401, "Invalid API key");
    }
    c.set("workspace", ws);
    c.set("keyId", auth.keyId);
    await next();
  });

  app.post("/v1/orders", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z
      .object({
        amount: z.number().int().positive(),
        currency: z.string().default("INR"),
        receipt: z.string().optional(),
        notes: z.record(z.string()).optional(),
      })
      .safeParse(body);
    if (!parsed.success) return error(c, 400, parsed.error.message);
    return c.json(svc.createOrder(c.get("workspace"), parsed.data));
  });

  app.get("/v1/orders/:id", (c) => {
    const order = svc.getOrder(c.get("workspace"), c.req.param("id"));
    if (!order) return error(c, 400, "Order not found");
    return c.json(order);
  });

  app.post("/v1/payment_links", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z
      .object({
        amount: z.number().int().positive(),
        currency: z.string().default("INR"),
        description: z.string().optional(),
        customer: z.record(z.string()).optional(),
        notes: z.record(z.string()).optional(),
      })
      .safeParse(body);
    if (!parsed.success) return error(c, 400, parsed.error.message);
    return c.json(svc.createPaymentLink(c.get("workspace"), parsed.data));
  });

  app.get("/v1/payment_links/:id", (c) => {
    const link = svc.getPaymentLink(c.get("workspace"), c.req.param("id"));
    if (!link) return error(c, 400, "Payment link not found");
    return c.json(link);
  });

  app.get("/v1/payments", (c) => {
    const paymentLinkId = c.req.query("payment_link_id") ?? undefined;
    return c.json({
      entity: "collection",
      count: svc.listPayments(c.get("workspace"), paymentLinkId).length,
      items: svc.listPayments(c.get("workspace"), paymentLinkId),
    });
  });

  app.post("/v1/payments", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z
      .object({
        amount: z.number().int().positive(),
        currency: z.string().default("INR"),
        order_id: z.string().optional(),
        payment_link_id: z.string().optional(),
        method: z.string().optional(),
        email: z.string().optional(),
        contact: z.string().optional(),
        notes: z.record(z.string()).optional(),
        capture: z.boolean().optional(),
      })
      .safeParse(body);
    if (!parsed.success) return error(c, 400, parsed.error.message);
    try {
      return c.json(svc.attemptPayment(c.get("workspace"), parsed.data));
    } catch (err) {
      const status = (err as { status?: number }).status ?? 400;
      return error(c, status, err instanceof Error ? err.message : String(err));
    }
  });

  app.get("/v1/payments/:id", (c) => {
    const payment = svc.getPayment(c.get("workspace"), c.req.param("id"));
    if (!payment) return error(c, 400, "Payment not found");
    if (payment.status === "captured" && !payment.invoice_id) {
      svc.ensureInvoiceForPayment(c.get("workspace"), payment);
    }
    return c.json(svc.getPayment(c.get("workspace"), c.req.param("id")));
  });

  app.post("/v1/payments/:id/capture", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const amount = typeof body.amount === "number" ? body.amount : undefined;
    try {
      return c.json(svc.capturePayment(c.get("workspace"), c.req.param("id"), amount));
    } catch (err) {
      const status = (err as { status?: number }).status ?? 400;
      return error(c, status, err instanceof Error ? err.message : String(err));
    }
  });

  app.post("/v1/payments/:id/refund", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z
      .object({
        amount: z.number().int().positive().optional(),
        notes: z.record(z.string()).optional(),
        receipt: z.string().optional(),
      })
      .safeParse(body);
    if (!parsed.success) return error(c, 400, parsed.error.message);
    try {
      return c.json(svc.refundPayment(c.get("workspace"), c.req.param("id"), parsed.data));
    } catch (err) {
      const status = (err as { status?: number }).status ?? 400;
      return error(c, status, err instanceof Error ? err.message : String(err));
    }
  });

  app.get("/v1/payments/:id/refunds", (c) => {
    const items = svc.listRefunds(c.get("workspace"), c.req.param("id"));
    return c.json({ entity: "collection", count: items.length, items });
  });

  app.post("/v1/plans", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z
      .object({
        period: z.string(),
        interval: z.number().int().positive(),
        item: z.object({
          name: z.string(),
          amount: z.number().int().nonnegative().optional(),
          unit_amount: z.number().int().nonnegative().optional(),
          currency: z.string().optional(),
          description: z.string().optional(),
        }),
        notes: z.record(z.string()).optional(),
      })
      .safeParse(body);
    if (!parsed.success) return error(c, 400, parsed.error.message);
    return c.json(svc.createPlan(c.get("workspace"), parsed.data));
  });

  app.get("/v1/plans/:id", (c) => {
    const plan = svc.getPlan(c.get("workspace"), c.req.param("id"));
    if (!plan) return error(c, 400, "Plan not found");
    return c.json(plan);
  });

  app.post("/v1/subscriptions", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z
      .object({
        plan_id: z.string(),
        total_count: z.number().int().positive(),
        quantity: z.number().int().positive().optional(),
        notes: z.record(z.string()).optional(),
        customer_notify: z.number().optional(),
      })
      .safeParse(body);
    if (!parsed.success) return error(c, 400, parsed.error.message);
    try {
      return c.json(svc.createSubscription(c.get("workspace"), parsed.data));
    } catch (err) {
      const status = (err as { status?: number }).status ?? 400;
      return error(c, status, err instanceof Error ? err.message : String(err));
    }
  });

  app.get("/v1/subscriptions/:id", (c) => {
    const sub = svc.getSubscription(c.get("workspace"), c.req.param("id"));
    if (!sub) return error(c, 400, "Subscription not found");
    return c.json(sub);
  });

  app.patch("/v1/subscriptions/:id", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z
      .object({
        quantity: z.number().int().positive().optional(),
        total_count: z.number().int().positive().optional(),
        notes: z.record(z.string()).optional(),
      })
      .safeParse(body);
    if (!parsed.success) return error(c, 400, parsed.error.message);
    try {
      return c.json(svc.updateSubscription(c.get("workspace"), c.req.param("id"), parsed.data));
    } catch (err) {
      const status = (err as { status?: number }).status ?? 400;
      return error(c, status, err instanceof Error ? err.message : String(err));
    }
  });

  app.post("/v1/subscriptions/:id/pause", (c) => {
    try {
      return c.json(svc.pauseSubscription(c.get("workspace"), c.req.param("id")));
    } catch (err) {
      const status = (err as { status?: number }).status ?? 400;
      return error(c, status, err instanceof Error ? err.message : String(err));
    }
  });

  app.post("/v1/subscriptions/:id/resume", (c) => {
    try {
      return c.json(svc.resumeSubscription(c.get("workspace"), c.req.param("id")));
    } catch (err) {
      const status = (err as { status?: number }).status ?? 400;
      return error(c, status, err instanceof Error ? err.message : String(err));
    }
  });

  app.post("/v1/subscriptions/:id/cancel", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const cancelAtCycleEnd = body.cancel_at_cycle_end === 1 || body.cancel_at_cycle_end === true;
    try {
      return c.json(svc.cancelSubscription(c.get("workspace"), c.req.param("id"), cancelAtCycleEnd));
    } catch (err) {
      const status = (err as { status?: number }).status ?? 400;
      return error(c, status, err instanceof Error ? err.message : String(err));
    }
  });

  app.get("/v1/invoices/:id", (c) => {
    const inv = svc.getInvoice(c.get("workspace"), c.req.param("id"));
    if (!inv) return error(c, 400, "Invoice not found");
    return c.json(inv);
  });

  app.get("/v1/settlements", (c) => {
    const items = svc.listSettlements(c.get("workspace"));
    return c.json({ entity: "collection", count: items.length, items });
  });

  app.get("/v1/settlements/recon/combined", (c) => {
    return c.json(svc.settlementsRecon(c.get("workspace")));
  });

  return app;
}

export { RazorpayService };
export * from "./types.js";
