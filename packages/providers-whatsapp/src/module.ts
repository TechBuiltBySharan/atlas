import {
  type WebhookTarget,
  type WhatsAppCredentials,
  type Workspace,
  hmacSha256Hex,
} from "@atlas/core";
import type { ProviderModule } from "@atlas/provider-sdk";
import { z } from "zod";
import { createWhatsAppApp } from "./index.js";
import { WhatsAppService } from "./service.js";

function signWhatsAppWebhook(
  target: WebhookTarget,
  body: string,
  _creds: unknown,
): Record<string, string> {
  const secret = target.appSecret ?? target.secret;
  return {
    "Content-Type": "application/json",
    "X-Hub-Signature-256": `sha256=${hmacSha256Hex(secret, body)}`,
    "User-Agent": "Atlas-WhatsApp-Simulator/0.1",
  };
}

export const whatsappModule: ProviderModule = {
  id: "whatsapp",
  displayName: "WhatsApp Cloud API",
  description: "Messages, templates, delivery receipts, Flows encryption",
  mountPaths: ["/whatsapp/v22.0", "/whatsapp"],
  createApp: createWhatsAppApp,
  issueCredentials: (store, ws, opts) => store.issueWhatsAppCredentials(ws, opts as Partial<WhatsAppCredentials>),
  getCredentials: (ws) => ws.credentials.whatsapp as WhatsAppCredentials | undefined,
  setCredentials: (ws, creds) => {
    ws.credentials.whatsapp = creds;
  },
  redactCredentials: (creds) => {
    const c = creds as WhatsAppCredentials;
    return {
      accessToken: c.accessToken,
      phoneNumberId: c.phoneNumberId,
      displayPhoneNumber: c.displayPhoneNumber,
      wabaId: c.wabaId,
      appSecret: c.appSecret,
      verifyToken: c.verifyToken,
      flowsPublicKeyPem: c.flowsPublicKeyPem,
      consumerFlowsPublicKeyPem: c.consumerFlowsPublicKeyPem ?? null,
    };
  },
  signWebhook: signWhatsAppWebhook,
  failureRuleSchemas: [
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
  ],
  bootstrapHints: (atlasBaseUrl, creds) => {
    const c = creds as WhatsAppCredentials;
    return {
      webhookPathSegment: "whatsapp",
      envVars: {
        WHATSAPP_GRAPH_BASE_URL: `${atlasBaseUrl}/whatsapp/v22.0`,
        WHATSAPP_ACCESS_TOKEN: c.accessToken,
        WHATSAPP_PHONE_NUMBER_ID: c.phoneNumberId,
        WHATSAPP_WABA_ID: c.wabaId,
        WHATSAPP_APP_SECRET: c.appSecret,
        WHATSAPP_VERIFY_TOKEN: c.verifyToken,
      },
    };
  },
  controlOps: [
    {
      name: "inbound",
      method: "POST",
      summary: "Inject an inbound user message",
      handler: async ({ store, workspace, body }) => {
        const whatsapp = new WhatsAppService(store);
        const parsed = z
          .object({
            from: z.string(),
            type: z.string().optional(),
            text: z.string().optional(),
            interactive: z.unknown().optional(),
            button: z.object({ payload: z.string(), text: z.string() }).optional(),
          })
          .parse(body);
        return whatsapp.injectInbound(workspace, parsed);
      },
    },
    {
      name: "flow-submission",
      method: "POST",
      summary: "Inject a Flows nfm_reply submission",
      handler: async ({ store, workspace, body }) => {
        const whatsapp = new WhatsAppService(store);
        const parsed = z
          .object({
            from: z.string(),
            flowName: z.string().optional(),
            responseJson: z.record(z.unknown()),
          })
          .parse(body);
        return whatsapp.injectFlowSubmission(workspace, parsed);
      },
    },
    {
      name: "receipts.advance",
      method: "POST",
      summary: "Advance message delivery/read receipts",
      handler: async ({ store, workspace, body }) => {
        const whatsapp = new WhatsAppService(store);
        const parsed = z
          .object({
            messageId: z.string(),
            status: z.enum(["sent", "delivered", "read", "failed"]),
          })
          .parse(body);
        return whatsapp.advanceReceipts(workspace, parsed.messageId, parsed.status);
      },
    },
  ],
};

export function getWhatsAppCredentials(ws: Workspace): WhatsAppCredentials | undefined {
  return ws.credentials.whatsapp as WhatsAppCredentials | undefined;
}
