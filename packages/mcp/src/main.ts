#!/usr/bin/env node
/**
 * Atlas MCP server — agent interface over the control plane.
 * Requires a running Atlas server (ATLAS_URL, default http://127.0.0.1:4400).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const base = process.env.ATLAS_URL ?? "http://127.0.0.1:4400";
const token = process.env.ATLAS_CONTROL_TOKEN;

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  if (token) headers.set("x-atlas-token", token);
  const res = await fetch(`${base}${path}`, { ...init, headers });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep */
  }
  if (!res.ok) {
    throw new Error(typeof body === "string" ? body : JSON.stringify(body));
  }
  return body;
}

const tools = [
  {
    name: "atlas_workspace_create",
    description: "Create an Atlas simulation workspace",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Optional workspace id" },
        clockMode: { type: "string", enum: ["virtual", "realtime"] },
      },
    },
  },
  {
    name: "atlas_workspace_reset",
    description: "Delete/reset a workspace",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "atlas_issue_credentials",
    description: "Issue Razorpay or WhatsApp simulation credentials for a workspace",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        provider: { type: "string", enum: ["razorpay", "whatsapp"] },
      },
      required: ["workspaceId", "provider"],
    },
  },
  {
    name: "atlas_set_webhook",
    description: "Set consumer webhook target for razorpay or whatsapp",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        provider: { type: "string", enum: ["razorpay", "whatsapp"] },
        url: { type: "string" },
        secret: { type: "string" },
      },
      required: ["workspaceId", "provider", "url", "secret"],
    },
  },
  {
    name: "atlas_set_failures",
    description:
      "Set failure/chaos rules (fail payments, delay/duplicate/drop webhooks, WA rate limits)",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        rules: { type: "array", items: { type: "object" } },
      },
      required: ["workspaceId", "rules"],
    },
  },
  {
    name: "atlas_clock_advance",
    description: "Advance virtual clock and flush due webhooks",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        ms: { type: "number" },
      },
      required: ["workspaceId", "ms"],
    },
  },
  {
    name: "atlas_events_list",
    description: "List recent workspace events",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        limit: { type: "number" },
      },
      required: ["workspaceId"],
    },
  },
  {
    name: "atlas_razorpay_pay_order",
    description: "Force-pay a Razorpay order in the simulator (respects fail_next rules)",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        orderId: { type: "string" },
      },
      required: ["workspaceId", "orderId"],
    },
  },
  {
    name: "atlas_whatsapp_inbound",
    description: "Inject an inbound WhatsApp user message",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        from: { type: "string" },
        text: { type: "string" },
      },
      required: ["workspaceId", "from"],
    },
  },
  {
    name: "atlas_scenario_run",
    description: "Run a scenario document against a workspace",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        scenario: { type: "object" },
      },
      required: ["workspaceId", "scenario"],
    },
  },
  {
    name: "atlas_health",
    description: "Check Atlas server health",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

const server = new Server(
  { name: "atlas", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;

  try {
    let result: unknown;
    switch (name) {
      case "atlas_health":
        result = await api("/health");
        break;
      case "atlas_workspace_create":
        result = await api("/control/v1/workspaces", {
          method: "POST",
          body: JSON.stringify({
            id: args.id,
            clockMode: args.clockMode ?? "virtual",
          }),
        });
        break;
      case "atlas_workspace_reset":
        result = await api(`/control/v1/workspaces/${args.id}`, { method: "DELETE" });
        break;
      case "atlas_issue_credentials":
        result = await api(
          `/control/v1/workspaces/${args.workspaceId}/credentials/${args.provider}`,
          { method: "POST", body: "{}" },
        );
        break;
      case "atlas_set_webhook":
        result = await api(
          `/control/v1/workspaces/${args.workspaceId}/webhooks/${args.provider}`,
          {
            method: "PUT",
            body: JSON.stringify({
              url: args.url,
              secret: args.secret,
              appSecret: args.secret,
            }),
          },
        );
        break;
      case "atlas_set_failures":
        result = await api(`/control/v1/workspaces/${args.workspaceId}/failures`, {
          method: "POST",
          body: JSON.stringify({ rules: args.rules }),
        });
        break;
      case "atlas_clock_advance":
        result = await api(`/control/v1/workspaces/${args.workspaceId}/clock/advance`, {
          method: "POST",
          body: JSON.stringify({ ms: args.ms }),
        });
        break;
      case "atlas_events_list":
        result = await api(
          `/control/v1/workspaces/${args.workspaceId}/events?limit=${args.limit ?? 100}`,
        );
        break;
      case "atlas_razorpay_pay_order":
        result = await api(
          `/control/v1/workspaces/${args.workspaceId}/razorpay/orders/${args.orderId}/pay`,
          { method: "POST", body: "{}" },
        );
        break;
      case "atlas_whatsapp_inbound":
        result = await api(`/control/v1/workspaces/${args.workspaceId}/whatsapp/inbound`, {
          method: "POST",
          body: JSON.stringify({ from: args.from, text: args.text }),
        });
        break;
      case "atlas_scenario_run":
        result = await api(`/control/v1/workspaces/${args.workspaceId}/scenarios/run`, {
          method: "POST",
          body: JSON.stringify(args.scenario),
        });
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
