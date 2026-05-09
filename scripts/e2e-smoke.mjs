/**
 * End-to-end smoke for ClaudeOS Phase 1.
 *
 * Spawns the api-server, exercises the full HTTP + WebSocket flow that the
 * desktop performs (workspace → session → run → stream → resume), and
 * verifies the harness streams real Claude Code events back through the
 * pipeline. Consumes real Claude credits — keep instructions trivial.
 *
 * Run with `node scripts/e2e-smoke.mjs` from the repo root.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const REPO = process.cwd();
const PORT = 7901;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_BASE = `ws://127.0.0.1:${PORT}`;
const DB = join(tmpdir(), `claudeos-e2e-${process.pid}.db`);
const WORKSPACE_DIR = mkdtempSync(join(tmpdir(), "claudeos-e2e-ws-"));

const log = (s) => console.log(`[e2e] ${s}`);
const fail = (s) => {
  console.error(`[e2e] FAIL: ${s}`);
  process.exit(1);
};

// --- spawn api-server -------------------------------------------------------

log(`workspace dir: ${WORKSPACE_DIR}`);
log(`db: ${DB}`);

const server = spawn(
  process.execPath,
  [join(REPO, "runtime", "api-server", "dist", "index.mjs")],
  {
    env: {
      ...process.env,
      CLAUDEOS_PORT: String(PORT),
      CLAUDEOS_HOST: "127.0.0.1",
      CLAUDEOS_DB_PATH: DB,
    },
    stdio: ["ignore", "inherit", "inherit"],
  },
);

let serverExitCode = null;
server.on("exit", (code) => {
  serverExitCode = code;
});

// Wait for /health.
const T0 = Date.now();
while (Date.now() - T0 < 10_000) {
  try {
    const res = await fetch(`${BASE}/health`);
    if (res.ok) break;
  } catch {
    // not yet
  }
  await sleep(150);
}
if (serverExitCode !== null) fail(`api-server exited (${serverExitCode}) before becoming ready`);
log("api-server ready");

try {
  await runFlow();
  log("PASS");
  process.exit(0);
} catch (e) {
  fail(String(e));
} finally {
  server.kill("SIGTERM");
  await sleep(300);
  if (!server.killed) server.kill("SIGKILL");
  rmSync(DB, { force: true });
  rmSync(`${DB}-wal`, { force: true });
  rmSync(`${DB}-shm`, { force: true });
  rmSync(WORKSPACE_DIR, { recursive: true, force: true });
}

// --- flow -------------------------------------------------------------------

async function runFlow() {
  // 1. Create workspace.
  const ws = await postJson("/workspaces", { name: "e2e", dir: WORKSPACE_DIR });
  log(`workspace ${ws.id.slice(0, 8)}…`);

  // 2. Create session.
  const session = await postJson("/sessions", { workspace_id: ws.id });
  log(`session ${session.id.slice(0, 8)}…`);
  if (session.claude_session_id !== null) fail("new session should have null claude_session_id");

  // 3. First run: submit + stream.
  const run1 = await postJson("/runs", {
    workspace_id: ws.id,
    session_id: session.id,
    input_id: "in-1",
    instruction:
      "Reply with just the single word READY and do not call any tools.",
  });
  log(`run1 ${run1.run_id.slice(0, 8)}…`);

  const events1 = await streamEvents(run1.run_id);
  assertEvents(events1, "run1");

  // 4. Confirm session was bound to a claude_session_id.
  const refreshed = await getJson(`/sessions/${session.id}`);
  if (!refreshed.claude_session_id) fail("session should have claude_session_id after run1");
  log(`session bound ↔ ${refreshed.claude_session_id.slice(0, 8)}…`);

  // 5. Second run on same session — exercises --resume.
  const run2 = await postJson("/runs", {
    workspace_id: ws.id,
    session_id: session.id,
    input_id: "in-2",
    instruction: "Reply with just the single word DONE.",
  });
  log(`run2 ${run2.run_id.slice(0, 8)}…`);

  const events2 = await streamEvents(run2.run_id);
  assertEvents(events2, "run2");

  // 6. Replay endpoint returns the same events.
  const replay = await getJson(`/runs/${run2.run_id}/events`);
  if (replay.length !== events2.length) {
    fail(`replay length mismatch (live=${events2.length}, replay=${replay.length})`);
  }
  log(`replay ok (${replay.length} events)`);
}

function assertEvents(events, label) {
  if (events.length === 0) fail(`${label}: no events received`);
  const first = events[0].type;
  const last = events[events.length - 1].type;
  if (first === "run_failed") {
    fail(`${label}: first event is run_failed — payload: ${JSON.stringify(events[0].payload)}`);
  }
  if (first !== "run_started") fail(`${label}: first event ${first} (expected run_started)`);
  if (last !== "run_completed" && last !== "run_failed") {
    fail(`${label}: last event ${last} (expected run_completed or run_failed)`);
  }
  if (last === "run_failed") {
    const e = events[events.length - 1];
    fail(`${label}: run_failed — ${JSON.stringify(e.payload)}`);
  }
  // Sequence numbers must be monotonic.
  for (let i = 1; i < events.length; i++) {
    if (events[i].sequence <= events[i - 1].sequence) {
      fail(`${label}: non-monotonic sequence at index ${i}`);
    }
  }
  const types = events.reduce((acc, e) => {
    acc[e.type] = (acc[e.type] || 0) + 1;
    return acc;
  }, {});
  log(`${label} events: ${JSON.stringify(types)}`);
}

// --- HTTP + WS helpers ------------------------------------------------------

async function postJson(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}`);
  return res.json();
}

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json();
}

function streamEvents(runId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/runs/${runId}/stream`);
    const events = [];
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`stream timeout (${events.length} events received)`));
    }, 120_000);
    ws.on("message", (data) => {
      try {
        events.push(JSON.parse(data.toString()));
      } catch {
        // ignore
      }
    });
    ws.on("close", () => {
      clearTimeout(timeout);
      resolve(events);
    });
    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
