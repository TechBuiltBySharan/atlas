import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { once } from "node:events";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(repoRoot, "dist-atlas-engine");
const expectedVersion = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
const published = JSON.parse(readFileSync(path.join(distDir, "package.json"), "utf8"));
if (published.version !== expectedVersion) {
  throw new Error(`built version ${published.version} does not match root ${expectedVersion}`);
}
const refType = process.env.GITHUB_REF_TYPE;
const refName = process.env.GITHUB_REF_NAME;
if (refType === "tag" && refName !== `v${expectedVersion}`) {
  throw new Error(`release tag ${refName} does not match package version v${expectedVersion}`);
}

const packed = JSON.parse(execFileSync("npm", ["pack", "--json"], {
  cwd: distDir,
  encoding: "utf8",
  shell: process.platform === "win32",
}));
const tarball = path.join(distDir, packed[0].filename);
const names = new Set(packed[0].files.map((file) => file.path));
for (const required of ["atlas.js", "package.json", "README.md", "LICENSE", "site/index.html", "docs/CONSUMER_GUIDE.md"]) {
  if (!names.has(required)) throw new Error(`published package is missing ${required}`);
}
if ([...names].some((name) => name.includes(".env") || name.includes("node_modules") || name.startsWith("data/"))) {
  throw new Error("published package contains a forbidden path");
}

const temp = mkdtempSync(path.join(tmpdir(), "atlas-package-"));
let child;
try {
  execFileSync("npm", ["init", "-y"], { cwd: temp, stdio: "ignore", shell: process.platform === "win32" });
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
    cwd: temp,
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  const port = await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") return reject(new Error("unable to reserve port"));
      const selected = address.port;
      probe.close((error) => error ? reject(error) : resolve(selected));
    });
  });
  child = spawn(process.execPath, [path.join(temp, "node_modules", "atlas-engine", "atlas.js"), "serve"], {
    cwd: temp,
    env: { ...process.env, ATLAS_PORT: String(port), ATLAS_HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let lastError;
  let health;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) { health = await response.json(); break; }
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!health) throw new Error(`packaged server did not become ready: ${lastError ?? "unknown error"}`);
  if (health.version !== expectedVersion) throw new Error(`health reports ${health.version}, expected ${expectedVersion}`);
  const landing = await fetch(`http://127.0.0.1:${port}/`);
  if (!landing.ok || !(await landing.text()).includes("Atlas")) throw new Error("packaged landing page is unavailable");
  console.log(`atlas-engine ${expectedVersion} package smoke passed on ${process.platform}`);
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  }
  rmSync(tarball, { force: true });
  rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}


