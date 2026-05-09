/**
 * Manual smoke test: spawn real `claude` and verify the runner produces
 * a coherent event sequence. Run with `node smoke.mjs` from runtime/harness.
 *
 * Consumes real Claude API quota — keep instructions trivial.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runHarness } from "./dist/index.js";

const workspaceDir = mkdtempSync(join(tmpdir(), "claudeos-smoke-"));
console.log("workspace:", workspaceDir);

const events = [];
const t0 = Date.now();

const result = await runHarness(
  {
    workspace_id: "smoke-ws",
    session_id: "smoke-sess",
    input_id: "smoke-in",
    instruction: "Reply with the single word OK and nothing else. Do not call any tools.",
    permission_mode: "default",
  },
  {
    workspaceDir,
    onEvent: (e) => {
      events.push(e);
      const summary =
        e.type === "text_delta"
          ? `text_delta(${JSON.stringify(e.payload.text)})`
          : e.type === "run_started"
          ? `run_started(model=${e.payload.model}, claude_session=${e.payload.claude_session_id.slice(0, 8)}…, tools=${e.payload.tools.length})`
          : e.type === "run_completed"
          ? `run_completed(turns=${e.payload.num_turns}, cost=$${e.payload.cost_usd}, in=${e.payload.usage.input_tokens}, out=${e.payload.usage.output_tokens})`
          : e.type;
      console.log(`  [${e.sequence}] ${summary}`);
    },
  },
);

const elapsed = Date.now() - t0;
console.log("---");
console.log("exit:", result.exitCode);
console.log("claude_session_id:", result.claudeSessionId);
console.log("events:", events.length);
console.log("elapsed:", elapsed, "ms");
console.log("---");

const types = events.reduce((acc, e) => {
  acc[e.type] = (acc[e.type] || 0) + 1;
  return acc;
}, {});
console.log("event type counts:", types);

const firstType = events[0]?.type;
const lastType = events[events.length - 1]?.type;
const ok =
  result.exitCode === 0 &&
  firstType === "run_started" &&
  lastType === "run_completed" &&
  result.claudeSessionId !== null;

console.log(ok ? "SMOKE: PASS" : "SMOKE: FAIL");
process.exit(ok ? 0 : 1);
