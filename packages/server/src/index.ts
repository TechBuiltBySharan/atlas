import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AtlasStore } from "@atlas/core";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createControlApp } from "./control.js";
import { createProviderRegistry } from "./providers.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const siteDir = path.join(repoRoot, "site");
const docsDir = path.join(repoRoot, "docs");

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

async function serveFile(root: string, reqPath: string): Promise<Response | null> {
  const cleaned = reqPath.replace(/^\/+/, "") || "index.html";
  const full = path.normalize(path.join(root, cleaned));
  if (!full.startsWith(root)) return null;
  try {
    const data = await readFile(full);
    const ext = path.extname(full).toLowerCase();
    return new Response(data, {
      headers: {
        "content-type": mime[ext] ?? "application/octet-stream",
        "cache-control": "no-cache",
      },
    });
  } catch {
    return null;
  }
}

export function createAtlasApp(
  store = new AtlasStore(),
  registry = createProviderRegistry(),
): Hono {
  const app = new Hono();
  registry.attachToStore(store);

  // Consumer apps' frontends (checkout.js, browser-driven flows) run on a
  // different origin than Atlas — permissive CORS is fine here since this is
  // a local simulator with no real credentials or money at stake.
  app.use("*", cors());

  app.get("/health", (c) =>
    c.json({
      ok: true,
      service: "atlas",
      version: "0.2.0",
      banner: "ATLAS SIMULATION — NOT REAL MONEY / NOT REAL META",
      workspaces: store.listWorkspaces().length,
      providers: registry.list().map((m) => m.id),
    }),
  );

  app.route("/control/v1", createControlApp(store, registry));

  const mounted = new Set<string>();
  for (const mod of registry.list()) {
    for (const mountPath of mod.mountPaths) {
      if (mounted.has(mountPath)) continue;
      mounted.add(mountPath);
      app.route(mountPath, mod.createApp(store));
    }
  }

  app.get("/docs/*", async (c) => {
    const sub = c.req.path.replace(/^\/docs\/?/, "");
    const res = await serveFile(docsDir, sub);
    return res ?? c.json({ error: "Not found", path: c.req.path }, 404);
  });

  app.get("/", async (c) => {
    const res = await serveFile(siteDir, "index.html");
    return res ?? c.json({ error: "Landing page missing" }, 500);
  });

  app.get("/styles.css", async (c) => {
    const res = await serveFile(siteDir, "styles.css");
    return res ?? c.json({ error: "Not found" }, 404);
  });

  app.get("/main.js", async (c) => {
    const res = await serveFile(siteDir, "main.js");
    return res ?? c.json({ error: "Not found" }, 404);
  });

  app.notFound((c) => c.json({ error: "Not found", path: c.req.path }, 404));

  return app;
}

export { AtlasStore };
