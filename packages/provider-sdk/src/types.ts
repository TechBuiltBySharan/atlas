import type { AtlasStore, WebhookTarget, Workspace } from "@atlas/core";
import type { Hono } from "hono";
import type { z } from "zod";

export type ProviderId = string;

export type WebhookSigner = (
  target: WebhookTarget,
  body: string,
  creds: unknown,
) => Record<string, string>;

export type BootstrapHints = {
  envVars: Record<string, string>;
  webhookPathSegment: string;
};

export type ControlOpContext = {
  store: AtlasStore;
  workspace: Workspace;
  params: Record<string, string>;
  body: unknown;
};

export type ControlOpHandler = (ctx: ControlOpContext) => Promise<unknown> | unknown;

export type ControlOpDef = {
  name: string;
  method: "POST" | "PUT" | "PATCH";
  summary: string;
  handler: ControlOpHandler;
};

export type ProviderModule = {
  id: ProviderId;
  displayName: string;
  description: string;
  mountPaths: string[];
  createApp: (store: AtlasStore) => Hono<any>;
  issueCredentials: (store: AtlasStore, ws: Workspace, opts?: unknown) => unknown;
  getCredentials: (ws: Workspace) => unknown | undefined;
  setCredentials: (ws: Workspace, creds: unknown) => void;
  redactCredentials?: (creds: unknown) => unknown;
  signWebhook: WebhookSigner;
  failureRuleSchemas: z.ZodType<unknown>[];
  bootstrapHints: (atlasBaseUrl: string, creds: unknown) => BootstrapHints;
  controlOps?: ControlOpDef[];
  /** Register legacy per-provider control routes (backward compatibility). */
  registerLegacyControlRoutes?: (app: Hono, store: AtlasStore) => void;
};
