import { type AtlasStore, type Workspace, getWhatsAppCredentials } from "@atlas/core";
import { Hono } from "hono";
import { z } from "zod";
import { handleFlowsEndpoint } from "./flows-crypto.js";
import { WhatsAppService } from "./service.js";

export {
  decryptFlowsRequest,
  encryptFlowsRequest,
  encryptFlowsResponse,
  handleFlowsEndpoint,
} from "./flows-crypto.js";
export type { FlowAction, FlowsEncryptedBody } from "./flows-crypto.js";

type Vars = {
  Variables: {
    workspace: Workspace;
  };
};

function graphError(
  c: { json: (body: unknown, status: number) => Response },
  status: number,
  message: string,
  code = 100,
) {
  return c.json(
    {
      error: {
        message,
        type: "OAuthException",
        code,
        fbtrace_id: "atlas_sim",
      },
    },
    status,
  );
}

export function createWhatsAppApp(store: AtlasStore): Hono<Vars> {
  const app = new Hono<Vars>();
  const svc = new WhatsAppService(store);

  // Meta → Atlas Flows data-exchange (no bearer; workspace via header or first WA workspace)
  app.post("/flows", async (c) => {
    const headerWs = c.req.header("x-atlas-workspace");
    const ws =
      (headerWs ? store.tryGetWorkspace(headerWs) : undefined) ??
      store.listWorkspaces().find((w) => getWhatsAppCredentials(w)?.flowsPrivateKeyPem);
    const waCreds = ws ? getWhatsAppCredentials(ws) : undefined;
    if (!ws || !waCreds?.flowsPrivateKeyPem) {
      return c.json({ error: "No workspace with Flows keys" }, 400);
    }
    const body = await c.req.json().catch(() => null);
    if (!body?.encrypted_aes_key) return c.json({ error: "Invalid Flows body" }, 400);
    try {
      const ciphertext = handleFlowsEndpoint(body, waCreds.flowsPrivateKeyPem);
      store.appendEvent(ws, {
        provider: "whatsapp",
        type: "flows.endpoint",
        data: { action: "handled" },
      });
      return new Response(ciphertext, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.use("/*", async (c, next) => {
    if (c.req.path.endsWith("/flows") && c.req.method === "POST") {
      await next();
      return;
    }
    if (c.req.method === "GET" && c.req.query("hub.mode")) {
      await next();
      return;
    }
    const auth = c.req.header("authorization");
    if (!auth?.startsWith("Bearer ")) return graphError(c, 401, "Invalid OAuth access token.", 190);
    const token = auth.slice(7);
    const headerWs = c.req.header("x-atlas-workspace");
    const ws =
      (headerWs ? store.tryGetWorkspace(headerWs) : undefined) ??
      store.findWorkspaceByWhatsAppToken(token);
    const waAuthCreds = ws ? getWhatsAppCredentials(ws) : undefined;
    if (!ws || !waAuthCreds || waAuthCreds.accessToken !== token) {
      return graphError(c, 401, "Invalid OAuth access token.", 190);
    }
    c.set("workspace", ws);
    await next();
  });

  app.get("/:phoneNumberId", (c) => {
    const ws = c.get("workspace");
    const phone = svc.getPhone(ws);
    if (c.req.param("phoneNumberId") !== phone.id) {
      return graphError(c, 404, "Phone number not found");
    }
    return c.json(phone);
  });

  app.post("/:phoneNumberId/messages", async (c) => {
    const ws = c.get("workspace");
    const phone = svc.getPhone(ws);
    if (c.req.param("phoneNumberId") !== phone.id) {
      return graphError(c, 404, "Phone number not found");
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = z
      .object({
        messaging_product: z.literal("whatsapp").optional(),
        to: z.string().optional(),
        type: z.string().optional(),
        text: z.object({ body: z.string() }).optional(),
        template: z
          .object({
            name: z.string(),
            language: z.object({ code: z.string() }).optional(),
          })
          .optional(),
        interactive: z.unknown().optional(),
        status: z.string().optional(),
        message_id: z.string().optional(),
      })
      .safeParse(body);
    if (!parsed.success) return graphError(c, 400, parsed.error.message);
    try {
      return c.json(
        svc.sendMessage(ws, {
          to: parsed.data.to ?? "",
          type: parsed.data.type ?? "text",
          text: parsed.data.text,
          template: parsed.data.template,
          interactive: parsed.data.interactive,
          status: parsed.data.status,
          message_id: parsed.data.message_id,
        }),
      );
    } catch (err) {
      const status = (err as { status?: number }).status ?? 400;
      const code = (err as { code?: number }).code ?? 100;
      return graphError(c, status, err instanceof Error ? err.message : String(err), code);
    }
  });

  app.get("/:wabaId/message_templates", (c) => {
    const ws = c.get("workspace");
    const data = svc.listTemplates(ws);
    return c.json({ data, paging: { cursors: { before: "atlas", after: "atlas" } } });
  });

  app.post("/:wabaId/message_templates", async (c) => {
    const ws = c.get("workspace");
    const body = await c.req.json().catch(() => ({}));
    const parsed = z
      .object({
        name: z.string(),
        language: z.string().optional(),
        category: z.string().optional(),
      })
      .safeParse(body);
    if (!parsed.success) return graphError(c, 400, parsed.error.message);
    const tpl = svc.createTemplate(ws, parsed.data);
    return c.json({ id: tpl.id, status: tpl.status });
  });

  return app;
}

export { WhatsAppService };
export type { WaMessage, WaMessageStatus, WaTemplate, WaConversation } from "./service.js";
