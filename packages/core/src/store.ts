import {
  type AtlasEvent,
  type FailureRule,
  type ProviderName,
  type ScheduledWebhook,
  type WebhookTarget,
  type Workspace,
  createId,
  entityKey,
  generateFlowsKeyPair,
  hmacSha256Hex,
  randomSecret,
} from "./types.js";

export class AtlasStore {
  private workspaces = new Map<string, Workspace>();

  createWorkspace(id?: string, clockMode: "virtual" | "realtime" = "virtual"): Workspace {
    const workspaceId = id ?? createId("ws", this.workspaces.size + 1);
    if (this.workspaces.has(workspaceId)) {
      throw new Error(`Workspace already exists: ${workspaceId}`);
    }
    const now = Date.now();
    const ws: Workspace = {
      id: workspaceId,
      createdAt: now,
      clockMs: now,
      clockMode,
      events: [],
      entities: new Map(),
      failureRules: [],
      webhooks: {},
      credentials: {},
      scheduledWebhooks: [],
      counters: {},
    };
    this.workspaces.set(workspaceId, ws);
    this.appendEvent(ws, { type: "workspace.created" });
    return ws;
  }

  getWorkspace(id: string): Workspace {
    const ws = this.workspaces.get(id);
    if (!ws) throw new Error(`Workspace not found: ${id}`);
    return ws;
  }

  tryGetWorkspace(id: string): Workspace | undefined {
    return this.workspaces.get(id);
  }

  listWorkspaces(): Workspace[] {
    return [...this.workspaces.values()];
  }

  deleteWorkspace(id: string): void {
    if (!this.workspaces.delete(id)) throw new Error(`Workspace not found: ${id}`);
  }

  /** Replace or insert a fully formed workspace (used by SQLite hydrate). */
  importWorkspace(ws: Workspace): void {
    this.workspaces.set(ws.id, ws);
  }

  now(ws: Workspace): number {
    return ws.clockMode === "realtime" ? Date.now() : ws.clockMs;
  }

  async advanceClock(ws: Workspace, ms: number): Promise<ScheduledWebhook[]> {
    if (ms < 0) throw new Error("Cannot advance clock by negative ms");
    ws.clockMs += ms;
    this.appendEvent(ws, { type: "clock.advanced", data: { ms, now: ws.clockMs } });
    return this.flushDueWebhooks(ws);
  }

  nextCounter(ws: Workspace, key: string): number {
    const n = (ws.counters[key] ?? 0) + 1;
    ws.counters[key] = n;
    return n;
  }

  appendEvent(
    ws: Workspace,
    partial: Omit<AtlasEvent, "id" | "at" | "workspaceId"> & { id?: string },
  ): AtlasEvent {
    const event: AtlasEvent = {
      id: partial.id ?? createId("evt", this.nextCounter(ws, "event")),
      at: this.now(ws),
      workspaceId: ws.id,
      ...partial,
    };
    ws.events.push(event);
    return event;
  }

  setEntity(ws: Workspace, provider: ProviderName, kind: string, id: string, value: unknown): void {
    ws.entities.set(entityKey(provider, kind, id), value);
  }

  getEntity<T>(ws: Workspace, provider: ProviderName, kind: string, id: string): T | undefined {
    return ws.entities.get(entityKey(provider, kind, id)) as T | undefined;
  }

  listEntities<T>(ws: Workspace, provider: ProviderName, kind: string): T[] {
    const prefix = `${provider}:${kind}:`;
    const out: T[] = [];
    for (const [key, value] of ws.entities) {
      if (key.startsWith(prefix)) out.push(value as T);
    }
    return out;
  }

  setFailureRules(ws: Workspace, rules: FailureRule[]): void {
    ws.failureRules = rules;
    this.appendEvent(ws, { type: "failures.set", data: { rules } });
  }

  consumeFailureRule<T extends FailureRule["type"]>(
    ws: Workspace,
    type: T,
    match?: (rule: Extract<FailureRule, { type: T }>) => boolean,
  ): Extract<FailureRule, { type: T }> | undefined {
    const idx = ws.failureRules.findIndex((r) => {
      if (r.type !== type) return false;
      return match ? match(r as Extract<FailureRule, { type: T }>) : true;
    });
    if (idx < 0) return undefined;
    const rule = ws.failureRules[idx] as Extract<FailureRule, { type: T }>;

    if ("count" in rule) {
      const nextCount = rule.count - 1;
      if (nextCount <= 0) ws.failureRules.splice(idx, 1);
      else ws.failureRules[idx] = { ...rule, count: nextCount };
    } else if ("remaining" in rule) {
      const next = rule.remaining - 1;
      if (next <= 0) ws.failureRules.splice(idx, 1);
      else ws.failureRules[idx] = { ...rule, remaining: next };
    } else {
      ws.failureRules.splice(idx, 1);
    }
    return rule;
  }

  setWebhook(ws: Workspace, provider: ProviderName, target: WebhookTarget): void {
    ws.webhooks[provider] = target;
    this.appendEvent(ws, {
      provider,
      type: "webhook.target.set",
      data: { url: target.url },
    });
  }

  issueRazorpayCredentials(ws: Workspace): NonNullable<Workspace["credentials"]["razorpay"]> {
    const n = this.nextCounter(ws, "rzp_key");
    const creds = {
      keyId: `rzp_test_atlas_${n}`,
      keySecret: randomSecret(16),
      webhookSecret: randomSecret(16),
    };
    ws.credentials.razorpay = creds;
    this.appendEvent(ws, { provider: "razorpay", type: "credentials.issued" });
    return creds;
  }

  issueWhatsAppCredentials(
    ws: Workspace,
    opts?: Partial<NonNullable<Workspace["credentials"]["whatsapp"]>>,
  ): NonNullable<Workspace["credentials"]["whatsapp"]> {
    const n = this.nextCounter(ws, "wa_phone");
    const pair = generateFlowsKeyPair();
    const creds = {
      accessToken: opts?.accessToken ?? `atlas_wa_token_${randomSecret(12)}`,
      phoneNumberId: opts?.phoneNumberId ?? `100000${n}`,
      displayPhoneNumber: opts?.displayPhoneNumber ?? `+1555000${String(n).padStart(4, "0")}`,
      wabaId: opts?.wabaId ?? `waba_${n}`,
      appSecret: opts?.appSecret ?? randomSecret(16),
      verifyToken: opts?.verifyToken ?? `atlas_verify_${n}`,
      flowsPrivateKeyPem: opts?.flowsPrivateKeyPem ?? pair.privateKeyPem,
      flowsPublicKeyPem: opts?.flowsPublicKeyPem ?? pair.publicKeyPem,
      consumerFlowsPublicKeyPem: opts?.consumerFlowsPublicKeyPem,
    };
    ws.credentials.whatsapp = creds;
    this.appendEvent(ws, { provider: "whatsapp", type: "credentials.issued" });
    return creds;
  }

  findWorkspaceByRazorpayKey(keyId: string): Workspace | undefined {
    for (const ws of this.workspaces.values()) {
      if (ws.credentials.razorpay?.keyId === keyId) return ws;
    }
    return undefined;
  }

  findWorkspaceByWhatsAppToken(token: string): Workspace | undefined {
    for (const ws of this.workspaces.values()) {
      if (ws.credentials.whatsapp?.accessToken === token) return ws;
    }
    return undefined;
  }

  findWorkspaceByPhoneNumberId(phoneNumberId: string): Workspace | undefined {
    for (const ws of this.workspaces.values()) {
      if (ws.credentials.whatsapp?.phoneNumberId === phoneNumberId) return ws;
    }
    return undefined;
  }

  /**
   * Schedule a provider webhook. Applies delay/duplicate/drop failure rules.
   * Returns the scheduled jobs (0..N). Does not deliver unless due immediately.
   */
  scheduleWebhook(
    ws: Workspace,
    provider: ProviderName,
    event: string,
    payload: unknown,
  ): ScheduledWebhook[] {
    const target = ws.webhooks[provider];
    if (!target) {
      this.appendEvent(ws, {
        provider,
        type: "webhook.skipped_no_target",
        data: { event },
      });
      return [];
    }

    const drop = this.consumeFailureRule(
      ws,
      "webhook.drop",
      (r) => r.provider === provider && (!r.event || r.event === event),
    );
    if (drop) {
      const dropped: ScheduledWebhook = {
        id: createId("wh", this.nextCounter(ws, "webhook")),
        provider,
        event,
        payload,
        body: JSON.stringify(payload),
        headers: {},
        dueAt: this.now(ws),
        attempts: 0,
        status: "dropped",
      };
      ws.scheduledWebhooks.push(dropped);
      this.appendEvent(ws, { provider, type: "webhook.dropped", data: { event } });
      return [dropped];
    }

    let delayMs = 0;
    const delayRule = this.consumeFailureRule(
      ws,
      "webhook.delay",
      (r) => r.provider === provider && (!r.event || r.event === event),
    );
    if (delayRule) delayMs = delayRule.ms;

    let copies = 1;
    const dup = this.consumeFailureRule(
      ws,
      "webhook.duplicate",
      (r) => r.provider === provider && (!r.event || r.event === event),
    );
    if (dup) copies = 2;

    // Frozen now — this is the exact string the signature below is computed
    // over, and delivery must send these same bytes even if `payload` embeds a
    // reference to an entity that a later synchronous call goes on to mutate.
    const body = JSON.stringify(payload);
    const headers = this.buildWebhookHeaders(provider, target, body);
    const jobs: ScheduledWebhook[] = [];
    for (let i = 0; i < copies; i++) {
      const job: ScheduledWebhook = {
        id: createId("wh", this.nextCounter(ws, "webhook")),
        provider,
        event,
        payload,
        body,
        headers,
        dueAt: this.now(ws) + delayMs,
        attempts: 0,
        status: "scheduled",
      };
      ws.scheduledWebhooks.push(job);
      jobs.push(job);
      this.appendEvent(ws, {
        provider,
        type: "webhook.scheduled",
        data: { event, dueAt: job.dueAt, copy: i + 1, delayMs },
      });
    }

    // Deliver immediately if due
    void this.flushDueWebhooks(ws);
    return jobs;
  }

  buildWebhookHeaders(
    provider: ProviderName,
    target: WebhookTarget,
    body: string,
  ): Record<string, string> {
    if (provider === "razorpay") {
      return {
        "Content-Type": "application/json",
        "X-Razorpay-Signature": hmacSha256Hex(target.secret, body),
        "User-Agent": "Atlas-Razorpay-Simulator/0.1",
      };
    }
    const secret = target.appSecret ?? target.secret;
    return {
      "Content-Type": "application/json",
      "X-Hub-Signature-256": `sha256=${hmacSha256Hex(secret, body)}`,
      "User-Agent": "Atlas-WhatsApp-Simulator/0.1",
    };
  }

  async flushDueWebhooks(ws: Workspace): Promise<ScheduledWebhook[]> {
    const now = this.now(ws);
    const due = ws.scheduledWebhooks.filter((j) => j.status === "scheduled" && j.dueAt <= now);
    for (const job of due) {
      await this.deliverWebhook(ws, job);
    }
    return due;
  }

  private async deliverWebhook(ws: Workspace, job: ScheduledWebhook): Promise<void> {
    const target = ws.webhooks[job.provider];
    if (!target) {
      job.status = "failed";
      job.error = "no webhook target";
      return;
    }
    // Claim the job synchronously, before the first await below. scheduleWebhook
    // fires flushDueWebhooks without awaiting it, so back-to-back scheduleWebhook
    // calls (e.g. subscription creation firing authenticated then active in one
    // synchronous burst) can re-enter flushDueWebhooks before this job's fetch
    // resolves — its status must stop matching the "scheduled" filter before that
    // happens, or the re-entrant flush delivers it a second time.
    job.status = "sending";
    job.attempts += 1;
    try {
      const res = await fetch(target.url, {
        method: "POST",
        headers: job.headers,
        body: job.body,
      });
      job.responseStatus = res.status;
      job.status = res.ok ? "delivered" : "failed";
      if (!res.ok) job.error = `HTTP ${res.status}`;
      this.appendEvent(ws, {
        provider: job.provider,
        type: res.ok ? "webhook.delivered" : "webhook.delivery_failed",
        data: {
          event: job.event,
          status: res.status,
          jobId: job.id,
        },
      });
    } catch (err) {
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
      this.appendEvent(ws, {
        provider: job.provider,
        type: "webhook.delivery_failed",
        data: { event: job.event, error: job.error, jobId: job.id },
      });
    }
  }
}

export const globalStore = new AtlasStore();
