import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import type { FastifyInstance } from "fastify";

import type { Session, Workspace } from "@claudeos/runtime-client/contracts";

import { createServer } from "./index.js";

let tmpDir: string;
let app: FastifyInstance | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "claudeos-workspaces-"));
});
afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

async function makeServer(): Promise<FastifyInstance> {
  return createServer({ dbPath: join(tmpDir, "test.db") });
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

test("PATCH /workspaces/:id renames the workspace and bumps updated_at", async () => {
  app = await makeServer();
  const ws = await createWorkspace(app, "old name");
  // Force a different timestamp by waiting a tick.
  await new Promise((r) => setTimeout(r, 10));

  const res = await app.inject({
    method: "PATCH",
    url: `/workspaces/${ws.id}`,
    payload: { name: "new name" },
  });
  assert.equal(res.statusCode, 200);
  const updated = res.json() as Workspace;
  assert.equal(updated.name, "new name");
  assert.equal(updated.id, ws.id);
  assert.notEqual(updated.updated_at, ws.updated_at, "updated_at must advance");
});

test("PATCH /workspaces/:id rejects an empty name", async () => {
  app = await makeServer();
  const ws = await createWorkspace(app);
  const res = await app.inject({
    method: "PATCH",
    url: `/workspaces/${ws.id}`,
    payload: { name: "" },
  });
  assert.equal(res.statusCode, 400);
});

test("PATCH /workspaces/:id returns 404 for unknown workspace", async () => {
  app = await makeServer();
  const res = await app.inject({
    method: "PATCH",
    url: "/workspaces/does-not-exist",
    payload: { name: "x" },
  });
  assert.equal(res.statusCode, 404);
});

test("DELETE /workspaces/:id cascades sessions associated with the workspace", async () => {
  app = await makeServer();
  const ws = await createWorkspace(app);
  // Create a session under this workspace so we can verify the cascade.
  const sessionRes = await app.inject({
    method: "POST",
    url: "/sessions",
    payload: { workspace_id: ws.id },
  });
  assert.equal(sessionRes.statusCode, 200);
  const session = sessionRes.json() as Session;

  const del = await app.inject({ method: "DELETE", url: `/workspaces/${ws.id}` });
  assert.equal(del.statusCode, 200);
  assert.deepEqual(del.json(), { ok: true });

  // Workspace gone.
  const after = await app.inject({ method: "GET", url: `/workspaces/${ws.id}` });
  assert.equal(after.statusCode, 404);

  // Session cascaded.
  const sessionAfter = await app.inject({
    method: "GET",
    url: `/sessions/${session.id}`,
  });
  assert.equal(sessionAfter.statusCode, 404, "session must be cascade-deleted");
});

test("DELETE /workspaces/:id returns 404 for unknown workspace", async () => {
  app = await makeServer();
  const res = await app.inject({
    method: "DELETE",
    url: "/workspaces/missing",
  });
  assert.equal(res.statusCode, 404);
});
