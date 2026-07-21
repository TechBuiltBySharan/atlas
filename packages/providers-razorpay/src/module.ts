import {
  type RazorpayCredentials,
  type WebhookTarget,
  type Workspace,
  hmacSha256Hex,
} from "@atlas/core";
import type { ProviderModule } from "@atlas/provider-sdk";
import { z } from "zod";
import { createRazorpayApp } from "./index.js";
import { RazorpayService } from "./service.js";

function signRazorpayWebhook(
  target: WebhookTarget,
  body: string,
  _creds: unknown,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Razorpay-Signature": hmacSha256Hex(target.secret, body),
    "User-Agent": "Atlas-Razorpay-Simulator/0.1",
  };
}

export const razorpayModule: ProviderModule = {
  id: "razorpay",
  displayName: "Razorpay",
  description: "Orders, payments, refunds, subscriptions, payment links, settlements",
  mountPaths: ["/razorpay"],
  createApp: createRazorpayApp,
  issueCredentials: (store, ws) => store.issueRazorpayCredentials(ws),
  getCredentials: (ws) => ws.credentials.razorpay as RazorpayCredentials | undefined,
  setCredentials: (ws, creds) => {
    ws.credentials.razorpay = creds;
  },
  redactCredentials: (creds) => creds,
  signWebhook: signRazorpayWebhook,
  failureRuleSchemas: [
    z.object({
      type: z.literal("razorpay.payment.fail_next"),
      count: z.number().int().positive(),
      reason: z.string().optional(),
    }),
  ],
  bootstrapHints: (atlasBaseUrl, creds) => {
    const c = creds as RazorpayCredentials;
    return {
      webhookPathSegment: "razorpay",
      envVars: {
        RAZORPAY_API_BASE_URL: `${atlasBaseUrl}/razorpay`,
        NEXT_PUBLIC_RAZORPAY_CHECKOUT_JS_URL: `${atlasBaseUrl}/razorpay/checkout.js`,
        RAZORPAY_PLATFORM_KEY_ID: c.keyId,
        RAZORPAY_PLATFORM_KEY_SECRET: c.keySecret,
        RAZORPAY_PLATFORM_WEBHOOK_SECRET: c.webhookSecret,
      },
    };
  },
  controlOps: [
    {
      name: "orders.pay",
      method: "POST",
      summary: "Force-pay an order (respects fail_next rules)",
      handler: async ({ store, workspace, params, body }) => {
        const razorpay = new RazorpayService(store);
        const parsed = z
          .object({
            orderId: z.string(),
            capture: z.boolean().optional(),
          })
          .parse({ ...(body as object), orderId: params.orderId ?? (body as { orderId?: string })?.orderId });
        const order = razorpay.getOrder(workspace, parsed.orderId);
        if (!order) throw new Error("Order not found");
        return razorpay.attemptPayment(workspace, {
          amount: order.amount,
          currency: order.currency,
          order_id: order.id,
          capture: parsed.capture !== false,
        });
      },
    },
    {
      name: "payment-links.pay",
      method: "POST",
      summary: "Pay a payment link",
      handler: ({ store, workspace, params, body }) => {
        const razorpay = new RazorpayService(store);
        const parsed = z
          .object({ linkId: z.string() })
          .parse({ ...(body as object), linkId: params.linkId ?? (body as { linkId?: string })?.linkId });
        return razorpay.payPaymentLink(workspace, parsed.linkId);
      },
    },
    {
      name: "subscriptions.charge",
      method: "POST",
      summary: "Charge a subscription",
      handler: ({ store, workspace, params, body }) => {
        const razorpay = new RazorpayService(store);
        const parsed = z
          .object({ subId: z.string() })
          .parse({ ...(body as object), subId: params.subId ?? (body as { subId?: string })?.subId });
        return razorpay.chargeSubscription(workspace, parsed.subId);
      },
    },
  ],
};

export function getRazorpayCredentials(ws: Workspace): RazorpayCredentials | undefined {
  return ws.credentials.razorpay as RazorpayCredentials | undefined;
}
