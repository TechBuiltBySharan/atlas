import { serve } from "@hono/node-server";
import { createStoreFromEnv } from "@atlas/core";
import { createAtlasApp } from "./index.js";

const host = process.env.ATLAS_HOST ?? "127.0.0.1";
const port = Number(process.env.ATLAS_PORT ?? 4400);

const { store, sqlite, mode } = createStoreFromEnv();
const app = createAtlasApp(store);

if (sqlite) {
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (!dirty) return;
    dirty = false;
    try {
      sqlite.saveAll(store);
    } catch (err) {
      console.error("[atlas-sqlite] save failed:", err);
    }
  };
  const markDirty = () => {
    dirty = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 250);
  };
  const originalFetch = app.fetch.bind(app);
  app.fetch = (async (request, ...rest) => {
    const res = await originalFetch(request, ...rest);
    markDirty();
    return res;
  }) as typeof app.fetch;

  const shutdown = () => {
    flush();
    sqlite.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

console.log("══════════════════════════════════════════════════");
console.log("  ATLAS SIMULATION — NOT REAL MONEY / NOT REAL META");
console.log("══════════════════════════════════════════════════");
console.log(`  listening on http://${host}:${port}`);
console.log(`  store      ${mode}`);
console.log(`  health     GET  /health`);
console.log(`  control    /control/v1/*`);
console.log(`  razorpay   /razorpay/v1/*`);
console.log(`  whatsapp   /whatsapp/v22.0/*`);
console.log("══════════════════════════════════════════════════");

serve({ fetch: app.fetch, hostname: host, port });
