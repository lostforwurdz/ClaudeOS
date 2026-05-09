import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import type { FastifyInstance } from "fastify";

import type { PermissionRequestPayload } from "@claudeos/harness";

import { openDb } from "./db.js";
import { EventBus } from "./event-bus.js";
import { createServer } from "./index.js";
import { RunManager } from "./runs.js";

let tmpDir: string;
let app: FastifyInstance | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "claudeos-permission-"));
});
afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

test("RunManager.respondToPermission resolves a pending awaitPermissionDecision call", async () => {
  const db = openDb(join(tmpDir, "test.db"));
  const bus = new EventBus();
  const runs = new RunManager(db, bus);
  const runId = "run-1";

  const payload: PermissionRequestPayload = {
    tool_use_id: "toolu_x",
    tool_name: "Bash",
    input: { command: "ls" },
    reason: "",
  };

  // Simulate the harness setting up a pending permission via the same map
  // path runs.execute() uses. This is what the test surface needs to verify.
  const pending = new Promise<{ behavior: "allow" | "deny"; reason?: string }>(
    (resolve, reject) => {
      // @ts-expect-error — reach into private map for the test contract; the
      // alternative is a public registerPending() method that only tests use.
      runs.pendingPermissions.set(runId, { payload, resolve, reject });
    },
  );

  const ok = runs.respondToPermission(runId, { behavior: "allow", reason: "ok" });
  assert.equal(ok, true);
  const decided = await pending;
  assert.deepEqual(decided, { behavior: "allow", reason: "ok" });
  // Slot must be drained after a successful response.
  assert.equal(runs.getPendingPermission(runId), null);
  db.close();
});

test("RunManager.respondToPermission returns false when no pending permission", () => {
  const db = openDb(join(tmpDir, "test.db"));
  const bus = new EventBus();
  const runs = new RunManager(db, bus);
  const ok = runs.respondToPermission("nope", { behavior: "allow" });
  assert.equal(ok, false);
  db.close();
});

test("RunManager.cancel drains a pending permission with a rejection", async () => {
  const db = openDb(join(tmpDir, "test.db"));
  const bus = new EventBus();
  const runs = new RunManager(db, bus);
  const runId = "run-cancel";

  // Stage a pending permission AND an active abort controller (cancel checks both).
  const ac = new AbortController();
  // @ts-expect-error — same private-map reach as above
  runs.active.set(runId, ac);

  const payload: PermissionRequestPayload = {
    tool_use_id: "toolu_y",
    tool_name: "Bash",
    input: {},
    reason: "",
  };
  const pending = new Promise<unknown>((resolve, reject) => {
    // @ts-expect-error
    runs.pendingPermissions.set(runId, { payload, resolve, reject });
  });

  const ok = runs.cancel(runId);
  assert.equal(ok, true);
  await assert.rejects(pending, /cancelled/i);
  db.close();
});

test("POST /runs/:id/permission validates body shape", async () => {
  app = await createServer({ dbPath: join(tmpDir, "test.db") });
  const res = await app.inject({
    method: "POST",
    url: "/runs/whatever/permission",
    payload: { decision: "yolo" }, // invalid enum
  });
  assert.equal(res.statusCode, 400);
});

test("POST /runs/:id/permission returns 404 when no pending permission for this run", async () => {
  app = await createServer({ dbPath: join(tmpDir, "test.db") });
  const res = await app.inject({
    method: "POST",
    url: "/runs/no-such-run/permission",
    payload: { decision: "allow" },
  });
  assert.equal(res.statusCode, 404);
});
