import { createHmac, generateKeyPairSync, randomBytes } from "node:crypto";

export type ProviderName = string;

export type AtlasEvent = {
  id: string;
  at: number;
  workspaceId: string;
  provider?: ProviderName;
  type: string;
  entityKind?: string;
  entityId?: string;
  data?: unknown;
};

export type WebhookTarget = {
  url: string;
  secret: string;
  /** Optional Meta app secret for X-Hub-Signature-256 */
  appSecret?: string;
};

export type FailureRule =
  | { type: "razorpay.payment.fail_next"; count: number; reason?: string }
  | { type: "whatsapp.send.fail_next"; count: number; code?: number; message?: string }
  | { type: "whatsapp.rate_limit"; remaining: number }
  | { type: "webhook.delay"; provider: ProviderName; ms: number; count: number; event?: string }
  | { type: "webhook.duplicate"; provider: ProviderName; count: number; event?: string }
  | { type: "webhook.drop"; provider: ProviderName; count: number; event?: string };

export type ScheduledWebhook = {
  id: string;
  provider: ProviderName;
  event: string;
  payload: unknown;
  /**
   * The exact JSON body the signature in `headers` was computed over, frozen at
   * schedule time. Delivery MUST send this string verbatim rather than
   * re-serializing `payload` — if `payload` embeds a reference to a mutable
   * entity (e.g. a subscription that a later, synchronous call flips to a new
   * status before this job's async delivery runs), a fresh re-serialization at
   * delivery time can drift from what was signed, and the consumer's signature
   * check correctly rejects it.
   */
  body: string;
  headers: Record<string, string>;
  dueAt: number;
  attempts: number;
  status: "scheduled" | "sending" | "delivered" | "failed" | "dropped";
  responseStatus?: number;
  error?: string;
};

export type RazorpayCredentials = {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
};

export type WhatsAppCredentials = {
  accessToken: string;
  phoneNumberId: string;
  displayPhoneNumber: string;
  wabaId: string;
  appSecret: string;
  verifyToken: string;
  flowsPrivateKeyPem: string;
  flowsPublicKeyPem: string;
  consumerFlowsPublicKeyPem?: string;
};

export function getRazorpayCredentials(ws: Workspace): RazorpayCredentials | undefined {
  return ws.credentials.razorpay as RazorpayCredentials | undefined;
}

export function getWhatsAppCredentials(ws: Workspace): WhatsAppCredentials | undefined {
  return ws.credentials.whatsapp as WhatsAppCredentials | undefined;
}

export type Workspace = {
  id: string;
  createdAt: number;
  clockMs: number;
  clockMode: "virtual" | "realtime";
  events: AtlasEvent[];
  entities: Map<string, unknown>;
  failureRules: FailureRule[];
  webhooks: Record<string, WebhookTarget | undefined>;
  credentials: Record<string, unknown>;
  scheduledWebhooks: ScheduledWebhook[];
  /** Sequential counters for deterministic-ish IDs */
  counters: Record<string, number>;
};

export function createId(prefix: string, n: number): string {
  return `${prefix}_${n.toString(36).padStart(8, "0")}`;
}

export function randomSecret(bytes = 24): string {
  return randomBytes(bytes).toString("hex");
}

export function generateFlowsKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { privateKeyPem: privateKey, publicKeyPem: publicKey };
}

export function hmacSha256Hex(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export function entityKey(provider: ProviderName, kind: string, id: string): string {
  return `${provider}:${kind}:${id}`;
}
