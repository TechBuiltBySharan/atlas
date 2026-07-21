import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Bundles packages/cli (the merged serve + control-plane CLI) and its @atlas/*
// workspace dependencies into a single standalone ESM file, then writes a clean
// package.json for it — the published atlas-engine package never depends on
// pnpm's workspace:* protocol, so a plain `npm publish` works from the output dir.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(repoRoot, "dist-atlas-engine");
const rootPkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(repoRoot, "packages/cli/src/main.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: path.join(outDir, "atlas.js"),
  // Only the real npm packages stay external — everything under @atlas/* is a
  // workspace:* package with no published npm counterpart, so it must be bundled in.
  external: ["hono", "@hono/node-server", "zod"],
});
chmodSync(path.join(outDir, "atlas.js"), 0o755);

const publishPkg = {
  name: "atlas-engine",
  version: rootPkg.version,
  description: "Stateful simulator for the external provider APIs your product depends on — Razorpay, WhatsApp, and more. Deterministic, chaos-native, agent-ready.",
  type: "module",
  license: "MIT",
  homepage: "https://github.com/TechBuiltBySharan/atlas",
  repository: { type: "git", url: "git+https://github.com/TechBuiltBySharan/atlas.git" },
  bugs: { url: "https://github.com/TechBuiltBySharan/atlas/issues" },
  keywords: [
    "simulation", "mock", "razorpay", "whatsapp", "testing", "staging",
    "webhook", "chaos-engineering", "mcp", "cli",
  ],
  engines: { node: ">=22" },
  bin: { atlas: "./atlas.js" },
  files: ["atlas.js", "README.md", "LICENSE"],
  dependencies: { hono: "^4.7.4", "@hono/node-server": "^1.14.1", zod: "^3.24.2" },
};

writeFileSync(path.join(outDir, "package.json"), JSON.stringify(publishPkg, null, 2) + "\n");
copyFileSync(path.join(repoRoot, "LICENSE"), path.join(outDir, "LICENSE"));

writeFileSync(
  path.join(outDir, "README.md"),
  `# atlas-engine

Stateful simulator for the external provider APIs your product depends on — Razorpay, WhatsApp, and more.
Not mocks, not stubs — deterministic, chaos-native, agent-ready.

Full docs, source, and contributing guide: https://github.com/TechBuiltBySharan/atlas

## Install

\`\`\`bash
npm install -g atlas-engine
\`\`\`

## Quick start

\`\`\`bash
atlas serve
# → http://127.0.0.1:4400

# in another shell
atlas health
atlas bootstrap my-app --webhook-base http://127.0.0.1:3000
\`\`\`

See \`atlas help\` for the full command list, or the [Consumer Guide](https://github.com/TechBuiltBySharan/atlas/blob/main/docs/CONSUMER_GUIDE.md).
`,
);

console.log(`Built atlas-engine → ${outDir}`);
