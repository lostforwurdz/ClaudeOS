import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import type { FastifyInstance } from "fastify";

import type { Page, RunSummary, Session, Workspace } from "@claudeos/runtime-client/contracts";

import { createServer } from "./index.js";

let tmpDir: string;
let app: FastifyInstance | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "claudeos-history-"));
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

async function createSession(
  server: FastifyInstance,
  workspaceId: string,
): Promise<Session> {
  const res = await server.inject({
    method: "POST",
    url: "/sessions",
    payload: { workspace_id: workspaceId },
  });
  assert.equal(res.statusCode, 200);
  return res.json() as Session;
}

test("GET /workspaces/:id/sessions returns sessions newest-first", async () => {
  app = await makeServer();
  const ws = await createWorkspace(app);
  const s1 = await createSession(app, ws.id);
  await new Promise((r) => setTimeout(r, 5));
  const s2 = await createSession(app, ws.id);
  await new Promise((r) => setTimeout(r, 5));
  const s3 = await createSession(app, ws.id);

  const res = await app.inject({ method: "GET", url: `/workspaces/${ws.id}/sessions` });
  assert.equal(res.statusCode, 200);
  const page = res.json() as Page<Session>;
  assert.equal(page.items.length, 3);
  assert.equal(page.items[0].id, s3.id, "newest first");
  assert.equal(page.items[1].id, s2.id);
  assert.equal(page.items[2].id, s1.id);
  assert.equal(page.next_before, null, "no more pages when below limit");
});

test("GET /workspaces/:id/sessions paginates via ?limit and ?before", async () => {
  app = await makeServer();
  const ws = await createWorkspace(app);
  const created: Session[] = [];
  for (let i = 0; i < 4; i++) {
    created.push(await createSession(app, ws.id));
    await new Promise((r) => setTimeout(r, 5));
  }
  // Newest-first expected order: created[3], [2], [1], [0]
  const first = await app.inject({
    method: "GET",
    url: `/workspaces/${ws.id}/sessions?limit=2`,
  });
  assert.equal(first.statusCode, 200);
  const page1 = first.json() as Page<Session>;
  assert.equal(page1.items.length, 2);
  assert.equal(page1.items[0].id, created[3].id);
  assert.equal(page1.items[1].id, created[2].id);
  assert.ok(page1.next_before, "next_before set when page is full");

  const second = await app.inject({
    method: "GET",
    url: `/workspaces/${ws.id}/sessions?limit=2&before=${encodeURIComponent(page1.next_before!)}`,
  });
  assert.equal(second.statusCode, 200);
  const page2 = second.json() as Page<Session>;
  assert.equal(page2.items.length, 2);
  assert.equal(page2.items[0].id, created[1].id);
  assert.equal(page2.items[1].id, created[0].id);
});

test("GET /workspaces/:id/sessions returns 404 for unknown workspace", async () => {
  app = await makeServer();
  const res = await app.inject({
    method: "GET",
    url: "/workspaces/does-not-exist/sessions",
  });
  assert.equal(res.statusCode, 404);
});

test("GET /workspaces/:id/sessions only returns that workspace's sessions", async () => {
  app = await makeServer();
  const a = await createWorkspace(app, "a");
  const b = await createWorkspace(app, "b");
  await createSession(app, a.id);
  await createSession(app, b.id);
  await createSession(app, b.id);

  const res = await app.inject({ method: "GET", url: `/workspaces/${a.id}/sessions` });
  const page = res.json() as Page<Session>;
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].workspace_id, a.id);
});

test("GET /workspaces/:id/sessions rejects invalid limit/before", async () => {
  app = await makeServer();
  const ws = await createWorkspace(app);
  const tooBig = await app.inject({
    method: "GET",
    url: `/workspaces/${ws.id}/sessions?limit=999`,
  });
  assert.equal(tooBig.statusCode, 400);
  const badBefore = await app.inject({
    method: "GET",
    url: `/workspaces/${ws.id}/sessions?before=not-a-date`,
  });
  assert.equal(badBefore.statusCode, 400);
});

test("GET /sessions/:id/runs returns 404 for unknown session", async () => {
  app = await makeServer();
  const res = await app.inject({ method: "GET", url: "/sessions/missing/runs" });
  assert.equal(res.statusCode, 404);
});

test("GET /sessions/:id/runs returns empty page for a session with no runs", async () => {
  app = await makeServer();
  const ws = await createWorkspace(app);
  const session = await createSession(app, ws.id);
  const res = await app.inject({ method: "GET", url: `/sessions/${session.id}/runs` });
  assert.equal(res.statusCode, 200);
  const page = res.json() as Page<RunSummary>;
  assert.deepEqual(page.items, []);
  assert.equal(page.next_before, null);
});
