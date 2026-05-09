import { mkdtempSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import type { FastifyInstance } from "fastify";

import type { ActiveRun, Workspace } from "@claudeos/runtime-client/contracts";

import { createServer } from "./index.js";

let tmpDir: string;
let dbPath: string;
let app: FastifyInstance | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "claudeos-active-runs-"));
  dbPath = join(tmpDir, "test.db");
});
afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

async function setup(): Promise<{ server: FastifyInstance; ws: Workspace }> {
  const server = await createServer({ dbPath });
  const wsRes = await server.inject({
    method: "POST",
    url: "/workspaces",
    payload: { name: "active-runs-ws", dir: tmpDir },
  });
  const ws = wsRes.json() as Workspace;
  return { server, ws };
}

/**
 * Bypass the harness to seed runs in specific states. The api-server's
 * own dispatch path always starts a real Claude Code child, which we
 * can't run in unit tests; this helper writes directly to the SQLite db.
 */
function seedRun(
  workspaceId: string,
  status: "running" | "completed" | "failed",
  startedAt: string,
): { sessionId: string; runId: string } {
  const sessionId = `session-${Math.random().toString(36).slice(2, 10)}`;
  const runId = `run-${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.prepare(
    `INSERT INTO sessions (id, workspace_id, claude_session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(sessionId, workspaceId, "claude-test", now, now);
  db.prepare(
    `INSERT INTO runs (id, session_id, input_id, status, started_at, request_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(runId, sessionId, `in-${runId}`, status, startedAt, "{}");
  db.close();
  return { sessionId, runId };
}

test("GET /active-runs returns [] when nothing is running", async () => {
  const { server } = await setup();
  app = server;
  const res = await server.inject({ method: "GET", url: "/active-runs" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), []);
});

test("GET /active-runs lists only status='running' rows, newest-first", async () => {
  const { server, ws } = await setup();
  app = server;
  const a = seedRun(ws.id, "running", "2026-05-09T10:00:00Z");
  const b = seedRun(ws.id, "completed", "2026-05-09T11:00:00Z");
  const c = seedRun(ws.id, "running", "2026-05-09T12:00:00Z");
  void b;

  const res = await server.inject({ method: "GET", url: "/active-runs" });
  const items = res.json() as ActiveRun[];
  assert.equal(items.length, 2);
  // Newest-first by started_at: c then a
  assert.equal(items[0].run.id, c.runId);
  assert.equal(items[1].run.id, a.runId);
});

test("GET /active-runs joins workspace metadata so the dashboard renders without lookups", async () => {
  const { server, ws } = await setup();
  app = server;
  const { runId, sessionId } = seedRun(ws.id, "running", "2026-05-09T10:00:00Z");

  const res = await server.inject({ method: "GET", url: "/active-runs" });
  const items = res.json() as ActiveRun[];
  assert.equal(items[0].run.id, runId);
  assert.equal(items[0].session_id, sessionId);
  assert.equal(items[0].workspace_id, ws.id);
  assert.equal(items[0].workspace_name, "active-runs-ws");
  assert.equal(items[0].claude_session_id, "claude-test");
});
