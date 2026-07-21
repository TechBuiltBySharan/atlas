import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AtlasStore } from "./store.js";
import type {
  FailureRule,
  RazorpayCredentials,
  ScheduledWebhook,
  WebhookTarget,
  WhatsAppCredentials,
  Workspace,
} from "./types.js";

type SerializedWorkspace = {
  id: string;
  createdAt: number;
  clockMs: number;
  clockMode: "virtual" | "realtime";
  events: Workspace["events"];
  entities: Array<[string, unknown]>;
  failureRules: FailureRule[];
  webhooks: {
    razorpay?: WebhookTarget;
    whatsapp?: WebhookTarget;
  };
  credentials: {
    razorpay?: RazorpayCredentials;
    whatsapp?: WhatsAppCredentials;
  };
  scheduledWebhooks: ScheduledWebhook[];
  counters: Record<string, number>;
};

function serializeWorkspace(ws: Workspace): SerializedWorkspace {
  return {
    id: ws.id,
    createdAt: ws.createdAt,
    clockMs: ws.clockMs,
    clockMode: ws.clockMode,
    events: ws.events,
    entities: [...ws.entities.entries()],
    failureRules: ws.failureRules,
    webhooks: ws.webhooks,
    credentials: ws.credentials,
    scheduledWebhooks: ws.scheduledWebhooks,
    counters: ws.counters,
  };
}

function deserializeWorkspace(raw: SerializedWorkspace): Workspace {
  return {
    id: raw.id,
    createdAt: raw.createdAt,
    clockMs: raw.clockMs,
    clockMode: raw.clockMode,
    events: raw.events ?? [],
    entities: new Map(raw.entities ?? []),
    failureRules: raw.failureRules ?? [],
    webhooks: raw.webhooks ?? {},
    credentials: raw.credentials ?? {},
    scheduledWebhooks: raw.scheduledWebhooks ?? [],
    counters: raw.counters ?? {},
  };
}

export class SqliteWorkspaceStore {
  private db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  loadAll(store: AtlasStore): number {
    const rows = this.db.prepare("SELECT id, payload FROM workspaces").all() as Array<{
      id: string;
      payload: string;
    }>;
    let n = 0;
    for (const row of rows) {
      try {
        const raw = JSON.parse(row.payload) as SerializedWorkspace;
        store.importWorkspace(deserializeWorkspace(raw));
        n += 1;
      } catch (err) {
        console.error(`[atlas-sqlite] failed to load workspace ${row.id}:`, err);
      }
    }
    return n;
  }

  saveAll(store: AtlasStore): void {
    for (const ws of store.listWorkspaces()) {
      this.saveWorkspace(ws);
    }
  }

  saveWorkspace(ws: Workspace): void {
    const payload = JSON.stringify(serializeWorkspace(ws));
    this.db
      .prepare(
        `INSERT INTO workspaces (id, payload, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
      )
      .run(ws.id, payload, Date.now());
  }

  deleteWorkspace(id: string): void {
    this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
  }

  close(): void {
    this.db.close();
  }
}

export type StoreMode = "memory" | "sqlite";

export function createStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): { store: AtlasStore; sqlite: SqliteWorkspaceStore | null; mode: StoreMode } {
  const mode = (env.ATLAS_STORE === "sqlite" ? "sqlite" : "memory") as StoreMode;
  const store = new AtlasStore();
  if (mode !== "sqlite") return { store, sqlite: null, mode };

  const filePath = env.ATLAS_SQLITE_PATH ?? "./data/atlas.sqlite";
  const sqlite = new SqliteWorkspaceStore(filePath);
  const n = sqlite.loadAll(store);
  console.log(`[atlas-sqlite] loaded ${n} workspace(s) from ${filePath}`);
  return { store, sqlite, mode };
}
