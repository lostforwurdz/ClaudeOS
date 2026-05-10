// a17.8 — per-workspace hooks tests.
//
// Three groups:
// 1. PATCH /workspaces/:id refine matrix (accept/reject the new shape).
// 2. parseWorkspaceHooks defensive parsing (drives via direct DB writes
//    so we can inject malformed/edge-case rows without going through the API).
// 3. Migration: rows that pre-date the hooks_json column read back as
//    `hooks: null` after openDb's idempotent ALTER TABLE.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";

import type { Workspace } from "@claudeos/runtime-client/contracts";

import { openDb } from "./db.js";
import { createServer } from "./index.js";

let tmpDir: string;
let app: FastifyInstance | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "claudeos-workspaces-hooks-"));
});
afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

function dbPath(): string {
  return join(tmpDir, "test.db");
}

async function makeServer(): Promise<FastifyInstance> {
  return createServer({ dbPath: dbPath() });
}

async function createWorkspace(server: FastifyInstance, name = "ws"): Promise<Workspace> {
  const res = await server.inject({
    method: "POST",
    url: "/workspaces",
    payload: { name, dir: tmpDir },
  });
  assert.equal(res.statusCode, 200);
  return res.json() as Workspace;
}

// ----------------------------------------------------------------------------
// 1. PATCH refine matrix
// ----------------------------------------------------------------------------

test("PATCH /workspaces/:id rejects an empty body (refine: at least one of {name, hooks})", async () => {
  app = await makeServer();
  const ws = await createWorkspace(app);
  const res = await app.inject({
    method: "PATCH",
    url: `/workspaces/${ws.id}`,
    payload: {},
  });
  assert.equal(res.statusCode, 400);
});

test("PATCH /workspaces/:id accepts {name} alone and leaves hooks unchanged", async () => {
  app = await makeServer();
  const ws = await createWorkspace(app, "old");
  const res = await app.inject({
    method: "PATCH",
    url: `/workspaces/${ws.id}`,
    payload: { name: "new" },
  });
  assert.equal(res.statusCode, 200);
  const updated = res.json() as Workspace;
  assert.equal(updated.name, "new");
  assert.equal(updated.hooks ?? null, null, "hooks must remain null when only name is sent");
});

test("PATCH /workspaces/:id accepts {hooks} alone and persists post_tool_use + stop", async () => {
  app = await makeServer();
  const ws = await createWorkspace(app);
  const res = await app.inject({
    method: "PATCH",
    url: `/workspaces/${ws.id}`,
    payload: {
      hooks: { post_tool_use: ["echo done"], stop: ["npm test"] },
    },
  });
  assert.equal(res.statusCode, 200);
  const updated = res.json() as Workspace;
  assert.deepEqual(updated.hooks, {
    post_tool_use: ["echo done"],
    stop: ["npm test"],
  });
});

test("PATCH /workspaces/:id accepts {name, hooks} together", async () => {
  app = await makeServer();
  const ws = await createWorkspace(app, "old");
  const res = await app.inject({
    method: "PATCH",
    url: `/workspaces/${ws.id}`,
    payload: {
      name: "renamed",
      hooks: { post_tool_use: ["x"] },
    },
  });
  assert.equal(res.statusCode, 200);
  const updated = res.json() as Workspace;
  assert.equal(updated.name, "renamed");
  assert.deepEqual(updated.hooks, { post_tool_use: ["x"] });
});

test("PATCH /workspaces/:id with {hooks: null} clears previously-set hooks", async () => {
  app = await makeServer();
  const ws = await createWorkspace(app);
  // Seed hooks first.
  const seed = await app.inject({
    method: "PATCH",
    url: `/workspaces/${ws.id}`,
    payload: { hooks: { post_tool_use: ["seed"] } },
  });
  assert.equal(seed.statusCode, 200);
  assert.deepEqual((seed.json() as Workspace).hooks, { post_tool_use: ["seed"] });

  // Now clear with explicit null.
  const cleared = await app.inject({
    method: "PATCH",
    url: `/workspaces/${ws.id}`,
    payload: { hooks: null },
  });
  assert.equal(cleared.statusCode, 200);
  assert.equal((cleared.json() as Workspace).hooks ?? null, null);
});

test("PATCH /workspaces/:id rejects empty-string entries inside hooks arrays", async () => {
  app = await makeServer();
  const ws = await createWorkspace(app);
  const res = await app.inject({
    method: "PATCH",
    url: `/workspaces/${ws.id}`,
    payload: { hooks: { post_tool_use: [""] } },
  });
  // HooksSchema declares z.array(z.string().min(1)) — empty strings must fail.
  assert.equal(res.statusCode, 400);
});

test("PATCH /workspaces/:id with {hooks: {}} stores hooks as null (every array stripped)", async () => {
  // setHooks strips empty arrays; with no recognized arrays the row's
  // hooks_json becomes NULL and the response surfaces hooks: null.
  app = await makeServer();
  const ws = await createWorkspace(app);
  const res = await app.inject({
    method: "PATCH",
    url: `/workspaces/${ws.id}`,
    payload: { hooks: {} },
  });
  assert.equal(res.statusCode, 200);
  assert.equal((res.json() as Workspace).hooks ?? null, null);
});

// ----------------------------------------------------------------------------
// 2. parseWorkspaceHooks defensive parsing — driven via direct DB writes.
// ----------------------------------------------------------------------------

async function injectHooksJson(workspaceId: string, value: string | null): Promise<void> {
  // Open a sibling connection to the same on-disk DB and overwrite hooks_json
  // for one row. WAL mode means the server's connection sees the change on
  // its next read.
  const db = new Database(dbPath());
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.prepare(`UPDATE workspaces SET hooks_json = ? WHERE id = ?`).run(value, workspaceId);
  db.close();
}

async function readWorkspace(server: FastifyInstance, id: string): Promise<Workspace> {
  const res = await server.inject({ method: "GET", url: `/workspaces/${id}` });
  assert.equal(res.statusCode, 200);
  return res.json() as Workspace;
}

test("parseWorkspaceHooks returns null when hooks_json is NULL", async () => {
  app = await makeServer();
  const ws = await createWorkspace(app);
  await injectHooksJson(ws.id, null);
  const after = await readWorkspace(app, ws.id);
  assert.equal(after.hooks ?? null, null);
});

test("parseWorkspaceHooks returns null when hooks_json is an empty string", async () => {
  app = await makeServer();
  const ws = await createWorkspace(app);
  await injectHooksJson(ws.id, "");
  const after = await readWorkspace(app, ws.id);
  assert.equal(after.hooks ?? null, null);
});

test("parseWorkspaceHooks returns null on malformed JSON instead of throwing", async () => {
  app = await makeServer();
  const ws = await createWorkspace(app);
  await injectHooksJson(ws.id, "{not valid json");
  const after = await readWorkspace(app, ws.id);
  assert.equal(after.hooks ?? null, null);
});

test("parseWorkspaceHooks drops non-array fields silently", async () => {
  app = await makeServer();
  const ws = await createWorkspace(app);
  await injectHooksJson(
    ws.id,
    JSON.stringify({ post_tool_use: "not an array", stop: 42 }),
  );
  const after = await readWorkspace(app, ws.id);
  // Both fields rejected → empty object surfaces as hooks: {}.
  assert.deepEqual(after.hooks, {});
});

test("parseWorkspaceHooks filters mixed-type entries and keeps only strings", async () => {
  app = await makeServer();
  const ws = await createWorkspace(app);
  await injectHooksJson(
    ws.id,
    JSON.stringify({
      post_tool_use: ["ok-1", 42, null, "ok-2", { cmd: "x" }],
      stop: [true, "stop-1"],
    }),
  );
  const after = await readWorkspace(app, ws.id);
  assert.deepEqual(after.hooks, {
    post_tool_use: ["ok-1", "ok-2"],
    stop: ["stop-1"],
  });
});

// ----------------------------------------------------------------------------
// 3. Migration: pre-existing rows missing hooks_json read back as null.
// ----------------------------------------------------------------------------

test("openDb adds hooks_json to legacy tables and existing rows read back as hooks: null", async () => {
  // Build a "pre-a17.8" DB by hand — workspaces table without hooks_json, one
  // row inserted directly. Then call openDb (which runs the idempotent ALTER
  // TABLE migration) and confirm via the API that the row is intact and
  // surfaces hooks: null.
  const path = dbPath();
  const legacy = new Database(path);
  legacy.pragma("journal_mode = WAL");
  legacy.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      dir TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const now = new Date().toISOString();
  legacy
    .prepare(
      `INSERT INTO workspaces (id, name, dir, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run("legacy-ws", "old", tmpDir, now, now);
  legacy.close();

  // openDb runs migrations as a side effect.
  const migrated = openDb(path);
  const cols = migrated
    .prepare(`PRAGMA table_info(workspaces)`)
    .all() as Array<{ name: string }>;
  migrated.close();
  assert.ok(
    cols.some((c) => c.name === "hooks_json"),
    "migration must add hooks_json column",
  );

  // Now boot the server against the migrated DB and read the legacy row.
  app = await makeServer();
  const res = await app.inject({ method: "GET", url: "/workspaces/legacy-ws" });
  assert.equal(res.statusCode, 200);
  const ws = res.json() as Workspace;
  assert.equal(ws.id, "legacy-ws");
  assert.equal(ws.name, "old");
  assert.equal(ws.hooks ?? null, null, "legacy row must surface hooks: null");
});

test("openDb is idempotent: calling twice does not duplicate the hooks_json column", async () => {
  const path = dbPath();
  // First call creates the table fresh (SCHEMA includes hooks_json).
  openDb(path).close();
  // Second call must not throw "duplicate column name" from ALTER TABLE.
  const second = openDb(path);
  const cols = second.prepare(`PRAGMA table_info(workspaces)`).all() as Array<{ name: string }>;
  second.close();
  const hooksCols = cols.filter((c) => c.name === "hooks_json");
  assert.equal(hooksCols.length, 1, "hooks_json column must appear exactly once");
});
