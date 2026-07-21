import {
  type AtlasStore,
  type Workspace,
  createId,
  getWhatsAppCredentials,
  type WhatsAppCredentials,
} from "@atlas/core";

export type WaMessageStatus = "accepted" | "sent" | "delivered" | "read" | "failed";

export type WaMessage = {
  id: string;
  direction: "outbound" | "inbound";
  phoneNumberId: string;
  from: string;
  to: string;
  type: string;
  text?: string;
  templateName?: string;
  interactive?: unknown;
  status: WaMessageStatus;
  timestamp: number;
  error?: { code: number; message: string };
};

export type WaTemplate = {
  id: string;
  name: string;
  language: string;
  status: "APPROVED" | "PENDING" | "REJECTED";
  category: string;
};

export type WaConversation = {
  id: string;
  phoneNumberId: string;
  waId: string;
  messageIds: string[];
  updatedAt: number;
};

function ts(ws: Workspace, store: AtlasStore): number {
  return Math.floor(store.now(ws) / 1000);
}

export class WhatsAppService {
  constructor(private store: AtlasStore) {}

  private creds(ws: Workspace): WhatsAppCredentials {
    const c = getWhatsAppCredentials(ws);
    if (!c) throw Object.assign(new Error("WhatsApp credentials not issued"), { status: 401 });
    return c;
  }

  ensureDefaultTemplate(ws: Workspace): void {
    const existing = this.store.listEntities<WaTemplate>(ws, "whatsapp", "template");
    if (existing.length > 0) return;
    const tpl: WaTemplate = {
      id: createId("tpl", this.store.nextCounter(ws, "wa_tpl")),
      name: "hello_world",
      language: "en_US",
      status: "APPROVED",
      category: "UTILITY",
    };
    this.store.setEntity(ws, "whatsapp", "template", tpl.id, tpl);
  }

  listTemplates(ws: Workspace): WaTemplate[] {
    this.ensureDefaultTemplate(ws);
    return this.store.listEntities(ws, "whatsapp", "template");
  }

  createTemplate(
    ws: Workspace,
    input: { name: string; language?: string; category?: string },
  ): WaTemplate {
    const tpl: WaTemplate = {
      id: createId("tpl", this.store.nextCounter(ws, "wa_tpl")),
      name: input.name,
      language: input.language ?? "en_US",
      status: "APPROVED",
      category: input.category ?? "UTILITY",
    };
    this.store.setEntity(ws, "whatsapp", "template", tpl.id, tpl);
    this.store.appendEvent(ws, {
      provider: "whatsapp",
      type: "template.created",
      entityKind: "template",
      entityId: tpl.id,
    });
    return tpl;
  }

  private getOrCreateConversation(
    ws: Workspace,
    phoneNumberId: string,
    waId: string,
  ): WaConversation {
    const id = `${phoneNumberId}:${waId}`;
    const existing = this.store.getEntity<WaConversation>(ws, "whatsapp", "conversation", id);
    if (existing) return existing;
    const convo: WaConversation = {
      id,
      phoneNumberId,
      waId,
      messageIds: [],
      updatedAt: this.store.now(ws),
    };
    this.store.setEntity(ws, "whatsapp", "conversation", id, convo);
    return convo;
  }

  sendMessage(
    ws: Workspace,
    input: {
      to: string;
      type: string;
      text?: { body: string };
      template?: { name: string; language?: { code: string } };
      interactive?: unknown;
      status?: string;
      message_id?: string;
    },
  ): { messaging_product: string; contacts: unknown[]; messages: { id: string }[] } {
    const creds = this.creds(ws);

    // mark-as-read
    if (input.status === "read" && input.message_id) {
      const msg = this.store.getEntity<WaMessage>(ws, "whatsapp", "message", input.message_id);
      if (msg) {
        msg.status = "read";
        this.store.setEntity(ws, "whatsapp", "message", msg.id, msg);
        this.emitStatus(ws, msg, "read");
      }
      return { messaging_product: "whatsapp", contacts: [], messages: [{ id: input.message_id }] };
    }

    const rate = this.store.consumeFailureRule(ws, "whatsapp.rate_limit");
    if (rate) {
      throw Object.assign(new Error("Rate limit hit"), {
        status: 429,
        code: 130429,
        details: "Atlas rate limit rule",
      });
    }

    const fail = this.store.consumeFailureRule(ws, "whatsapp.send.fail_next");
    const id = `wamid.atlas.${this.store.nextCounter(ws, "wa_msg").toString(36)}`;
    const msg: WaMessage = {
      id,
      direction: "outbound",
      phoneNumberId: creds.phoneNumberId,
      from: creds.displayPhoneNumber,
      to: input.to.replace(/\D/g, ""),
      type: input.type,
      text: input.text?.body,
      templateName: input.template?.name,
      interactive: input.interactive,
      status: fail ? "failed" : "accepted",
      timestamp: ts(ws, this.store),
      error: fail
        ? {
            code: fail.code ?? 131026,
            message: fail.message ?? "Message undeliverable (Atlas failure rule)",
          }
        : undefined,
    };

    const convo = this.getOrCreateConversation(ws, creds.phoneNumberId, msg.to);
    convo.messageIds.push(id);
    convo.updatedAt = this.store.now(ws);
    this.store.setEntity(ws, "whatsapp", "conversation", convo.id, convo);
    this.store.setEntity(ws, "whatsapp", "message", id, msg);
    this.store.appendEvent(ws, {
      provider: "whatsapp",
      type: fail ? "message.send_failed" : "message.outbound",
      entityKind: "message",
      entityId: id,
    });

    if (fail) {
      this.emitStatus(ws, msg, "failed");
      throw Object.assign(new Error(msg.error!.message), {
        status: 400,
        code: msg.error!.code,
      });
    }

    // Auto-progress receipts on virtual clock ticks via scheduled immediate statuses
    this.progressReceipt(ws, msg, "sent");
    this.progressReceipt(ws, msg, "delivered");
    return {
      messaging_product: "whatsapp",
      contacts: [{ input: input.to, wa_id: msg.to }],
      messages: [{ id }],
    };
  }

  progressReceipt(ws: Workspace, msg: WaMessage, status: WaMessageStatus): void {
    if (msg.status === "failed") return;
    msg.status = status;
    this.store.setEntity(ws, "whatsapp", "message", msg.id, msg);
    this.emitStatus(ws, msg, status);
  }

  advanceReceipts(ws: Workspace, messageId: string, status: WaMessageStatus): WaMessage {
    const msg = this.store.getEntity<WaMessage>(ws, "whatsapp", "message", messageId);
    if (!msg) throw Object.assign(new Error("Message not found"), { status: 404 });
    this.progressReceipt(ws, msg, status);
    return msg;
  }

  injectInbound(
    ws: Workspace,
    input: {
      from: string;
      type?: string;
      text?: string;
      interactive?: unknown;
      button?: { payload: string; text: string };
    },
  ): WaMessage {
    const creds = this.creds(ws);
    const id = `wamid.atlas.in.${this.store.nextCounter(ws, "wa_msg").toString(36)}`;
    const from = input.from.replace(/\D/g, "");
    const type = input.type ?? (input.interactive || input.button ? "interactive" : "text");
    const msg: WaMessage = {
      id,
      direction: "inbound",
      phoneNumberId: creds.phoneNumberId,
      from,
      to: creds.phoneNumberId,
      type,
      text: input.text,
      interactive: input.interactive ?? input.button,
      status: "accepted",
      timestamp: ts(ws, this.store),
    };
    const convo = this.getOrCreateConversation(ws, creds.phoneNumberId, from);
    convo.messageIds.push(id);
    convo.updatedAt = this.store.now(ws);
    this.store.setEntity(ws, "whatsapp", "conversation", convo.id, convo);
    this.store.setEntity(ws, "whatsapp", "message", id, msg);
    this.store.appendEvent(ws, {
      provider: "whatsapp",
      type: "message.inbound",
      entityKind: "message",
      entityId: id,
    });

    const messagePayload: Record<string, unknown> = {
      from,
      id,
      timestamp: String(msg.timestamp),
      type,
    };
    if (type === "text") messagePayload.text = { body: input.text ?? "" };
    if (input.button) {
      messagePayload.type = "button";
      messagePayload.button = input.button;
    }
    if (input.interactive) {
      messagePayload.type = "interactive";
      messagePayload.interactive = input.interactive;
    }

    this.store.scheduleWebhook(ws, "whatsapp", "messages", {
      object: "whatsapp_business_account",
      entry: [
        {
          id: creds.wabaId,
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: creds.displayPhoneNumber,
                  phone_number_id: creds.phoneNumberId,
                },
                contacts: [{ profile: { name: "Atlas User" }, wa_id: from }],
                messages: [messagePayload],
              },
            },
          ],
        },
      ],
    });
    return msg;
  }

  injectFlowSubmission(
    ws: Workspace,
    input: { from: string; flowName?: string; responseJson: Record<string, unknown> },
  ): WaMessage {
    return this.injectInbound(ws, {
      from: input.from,
      type: "interactive",
      interactive: {
        type: "nfm_reply",
        nfm_reply: {
          name: input.flowName ?? "flow",
          body: "Sent",
          response_json: JSON.stringify(input.responseJson),
        },
      },
    });
  }

  private emitStatus(ws: Workspace, msg: WaMessage, status: WaMessageStatus): void {
    const creds = this.creds(ws);
    this.store.scheduleWebhook(ws, "whatsapp", `status.${status}`, {
      object: "whatsapp_business_account",
      entry: [
        {
          id: creds.wabaId,
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: creds.displayPhoneNumber,
                  phone_number_id: creds.phoneNumberId,
                },
                statuses: [
                  {
                    id: msg.id,
                    status,
                    timestamp: String(ts(ws, this.store)),
                    recipient_id: msg.to,
                    ...(status === "failed" && msg.error
                      ? { errors: [{ code: msg.error.code, title: msg.error.message }] }
                      : {}),
                  },
                ],
              },
            },
          ],
        },
      ],
    });
  }

  getPhone(ws: Workspace) {
    const creds = this.creds(ws);
    return {
      id: creds.phoneNumberId,
      display_phone_number: creds.displayPhoneNumber,
      verified_name: "Atlas Simulator",
      quality_rating: "GREEN",
    };
  }
}
