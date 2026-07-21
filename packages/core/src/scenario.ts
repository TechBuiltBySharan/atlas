import { z } from "zod";
import type { AtlasStore } from "./store.js";
import type { FailureRule, ProviderName, Workspace } from "./types.js";

const failureRuleSchema: z.ZodType<FailureRule> = z.union([
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

const stepSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("failures.set"),
    rules: z.array(failureRuleSchema),
  }),
  z.object({
    op: z.literal("clock.advance"),
    ms: z.number().int().nonnegative(),
  }),
  z.object({
    op: z.literal("await.entity"),
    provider: z.enum(["razorpay", "whatsapp"]),
    kind: z.string(),
    status: z.string().optional(),
    id: z.string().optional(),
    timeoutMs: z.number().int().positive().default(5_000),
  }),
  z.object({
    op: z.literal("assert.webhook"),
    provider: z.enum(["razorpay", "whatsapp"]),
    event: z.string(),
    minCount: z.number().int().nonnegative().default(1),
  }),
  z.object({
    op: z.literal("assert.entity"),
    provider: z.enum(["razorpay", "whatsapp"]),
    kind: z.string(),
    id: z.string().optional(),
    status: z.string().optional(),
    minCount: z.number().int().nonnegative().optional(),
  }),
]);

export const scenarioSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  steps: z.array(stepSchema),
});

export type Scenario = z.infer<typeof scenarioSchema>;
export type ScenarioStep = z.infer<typeof stepSchema>;

export type StepResult = {
  op: string;
  ok: boolean;
  detail?: string;
};

export type ScenarioResult = {
  name: string;
  ok: boolean;
  steps: StepResult[];
};

function entityStatus(value: unknown): string | undefined {
  if (value && typeof value === "object" && "status" in value) {
    const s = (value as { status?: unknown }).status;
    return typeof s === "string" ? s : undefined;
  }
  return undefined;
}

export async function runScenario(
  store: AtlasStore,
  ws: Workspace,
  raw: unknown,
): Promise<ScenarioResult> {
  const scenario = scenarioSchema.parse(raw);
  const steps: StepResult[] = [];

  for (const step of scenario.steps) {
    try {
      switch (step.op) {
        case "failures.set": {
          store.setFailureRules(ws, step.rules);
          steps.push({ op: step.op, ok: true, detail: `${step.rules.length} rules` });
          break;
        }
        case "clock.advance": {
          await store.advanceClock(ws, step.ms);
          steps.push({ op: step.op, ok: true, detail: `+${step.ms}ms` });
          break;
        }
        case "await.entity": {
          const deadline = store.now(ws) + step.timeoutMs;
          let found = false;
          while (store.now(ws) <= deadline) {
            const entities = step.id
              ? [store.getEntity(ws, step.provider, step.kind, step.id)].filter(Boolean)
              : store.listEntities(ws, step.provider, step.kind);
            found = entities.some((e) => !step.status || entityStatus(e) === step.status);
            if (found) break;
            // In virtual mode, awaiting without advance would spin forever —
            // bump 1ms so callers can combine with clock.advance steps.
            if (ws.clockMode === "virtual") {
              await store.advanceClock(ws, 1);
            } else {
              await new Promise((r) => setTimeout(r, 25));
            }
            if (ws.clockMode === "virtual" && store.now(ws) > deadline) break;
          }
          steps.push({
            op: step.op,
            ok: found,
            detail: found ? "matched" : `timeout waiting for ${step.kind}${step.status ? ` status=${step.status}` : ""}`,
          });
          if (!found) return { name: scenario.name, ok: false, steps };
          break;
        }
        case "assert.webhook": {
          const count = ws.events.filter((e) => {
            if (e.provider !== step.provider) return false;
            if (e.type !== "webhook.delivered" && e.type !== "webhook.scheduled") return false;
            const data = e.data as { event?: string } | undefined;
            return data?.event === step.event;
          }).length;
          const ok = count >= step.minCount;
          steps.push({
            op: step.op,
            ok,
            detail: `count=${count} min=${step.minCount}`,
          });
          if (!ok) return { name: scenario.name, ok: false, steps };
          break;
        }
        case "assert.entity": {
          const entities = step.id
            ? [store.getEntity(ws, step.provider as ProviderName, step.kind, step.id)].filter(Boolean)
            : store.listEntities(ws, step.provider, step.kind);
          const matched = entities.filter((e) => !step.status || entityStatus(e) === step.status);
          const ok =
            step.minCount !== undefined
              ? matched.length >= step.minCount
              : matched.length > 0;
          steps.push({
            op: step.op,
            ok,
            detail: `matched=${matched.length}`,
          });
          if (!ok) return { name: scenario.name, ok: false, steps };
          break;
        }
      }
    } catch (err) {
      steps.push({
        op: step.op,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
      return { name: scenario.name, ok: false, steps };
    }
  }

  return { name: scenario.name, ok: steps.every((s) => s.ok), steps };
}
