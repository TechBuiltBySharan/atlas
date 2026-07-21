import type { AtlasStore } from "@atlas/core";
import type { ProviderModule, ProviderId } from "./types.js";

export class ProviderRegistry {
  private readonly modules = new Map<ProviderId, ProviderModule>();

  constructor(modules: ProviderModule[]) {
    for (const mod of modules) {
      if (this.modules.has(mod.id)) {
        throw new Error(`Duplicate provider id: ${mod.id}`);
      }
      this.modules.set(mod.id, mod);
    }
  }

  static fromEnv(
    all: ProviderModule[],
    env: NodeJS.ProcessEnv = process.env,
  ): ProviderRegistry {
    const raw = env.ATLAS_PROVIDERS?.trim();
    if (!raw) return new ProviderRegistry(all);
    const allowed = new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    const selected = all.filter((m) => allowed.has(m.id));
    if (selected.length === 0) {
      throw new Error(`ATLAS_PROVIDERS matched no modules: ${raw}`);
    }
    return new ProviderRegistry(selected);
  }

  list(): ProviderModule[] {
    return [...this.modules.values()];
  }

  get(id: ProviderId): ProviderModule | undefined {
    return this.modules.get(id);
  }

  require(id: ProviderId): ProviderModule {
    const mod = this.get(id);
    if (!mod) throw new Error(`Unknown provider: ${id}`);
    return mod;
  }

  attachToStore(store: AtlasStore): void {
    store.setWebhookSigners(
      Object.fromEntries(this.list().map((m) => [m.id, m.signWebhook])),
    );
  }
}
