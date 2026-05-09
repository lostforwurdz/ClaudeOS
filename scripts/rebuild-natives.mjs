#!/usr/bin/env node
/**
 * Idempotent native-module rebuild for the dual-ABI dance between Node and
 * Electron (kobramaz-nor). better-sqlite3 must be built against:
 *   - Node's NODE_MODULE_VERSION for `npm run api-server:test` (raw node:test)
 *   - Electron's NODE_MODULE_VERSION for `npm run desktop:dev` (electron child)
 *
 * This script reads/writes a `.abi-target` sentinel next to the compiled
 * binary so subsequent runs against the same target are a no-op.
 *
 * Usage: node scripts/rebuild-natives.mjs <node|electron>
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(HERE, "..", "..");
const API_SERVER_DIR = join(REPO_ROOT, "runtime", "api-server");
const SQLITE_DIR = join(API_SERVER_DIR, "node_modules", "better-sqlite3");
const BINARY = join(SQLITE_DIR, "build", "Release", "better_sqlite3.node");
const SENTINEL = join(SQLITE_DIR, ".abi-target");

const target = process.argv[2];
if (target !== "node" && target !== "electron") {
  console.error("usage: scripts/rebuild-natives.mjs <node|electron>");
  process.exit(2);
}

const current = existsSync(SENTINEL) ? readFileSync(SENTINEL, "utf8").trim() : null;
if (existsSync(BINARY) && current === target) {
  console.log(`[rebuild-natives] better-sqlite3 already built for ${target} — skipping.`);
  process.exit(0);
}

// Clear sentinel first so a mid-rebuild crash doesn't leave a stale claim.
if (existsSync(SENTINEL)) rmSync(SENTINEL);

console.log(`[rebuild-natives] rebuilding better-sqlite3 for ${target}...`);
if (target === "node") {
  execFileSync("npm", ["rebuild", "better-sqlite3"], {
    cwd: API_SERVER_DIR,
    stdio: "inherit",
  });
} else {
  execFileSync(
    "npx",
    [
      "electron-rebuild",
      "-m",
      "../runtime/api-server",
      "-w",
      "better-sqlite3",
      "--force",
      "--build-from-source",
    ],
    {
      cwd: join(REPO_ROOT, "desktop"),
      stdio: "inherit",
    },
  );
}
writeFileSync(SENTINEL, target + "\n");
console.log(`[rebuild-natives] done — sentinel: ${target}`);
