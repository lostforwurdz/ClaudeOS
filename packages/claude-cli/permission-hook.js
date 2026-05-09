#!/usr/bin/env node
/**
 * ClaudeOS PreToolUse permission hook (xh4.2).
 *
 * Wired into every claude run via a generated --settings JSON. On each tool
 * invocation claude calls this script with the hook payload on stdin; we
 * either defer (no decision yet — let the desktop modal collect one) or
 * return the user's saved decision (on resume).
 *
 * Decisions live in a per-run scratch file:
 *   $CLAUDEOS_SCRATCH_DIR/$CLAUDEOS_RUN_ID/decisions.json
 * keyed by tool_use_id. Schema: { "<tool_use_id>": { "behavior": "allow"|"deny", "reason"?: string } }
 *
 * Pure script: no claudeos deps, no network. The harness owns the scratch
 * file lifecycle.
 */

const fs = require("node:fs");
const path = require("node:path");

function defer(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "defer",
      ...(reason ? { permissionDecisionReason: reason } : {}),
    },
  };
}

function decide(behavior, reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: behavior,
      ...(reason ? { permissionDecisionReason: reason } : {}),
    },
  };
}

function readPayload() {
  try {
    const raw = fs.readFileSync(0, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readDecisions(filepath) {
  try {
    return JSON.parse(fs.readFileSync(filepath, "utf8"));
  } catch {
    return {};
  }
}

function main() {
  const payload = readPayload();
  // Without a payload we can't decide anything — defer and let claudeos collect input.
  // (Defaulting to defer rather than allow keeps the safe-by-default posture.)
  if (!payload || typeof payload !== "object") {
    process.stdout.write(JSON.stringify(defer("hook payload missing or unparseable")));
    return;
  }

  const runId = process.env.CLAUDEOS_RUN_ID;
  const scratchDir = process.env.CLAUDEOS_SCRATCH_DIR;

  // Without scratch wiring the harness is misconfigured — defer so the user
  // sees the prompt rather than silently bypassing.
  if (!runId || !scratchDir) {
    process.stdout.write(
      JSON.stringify(defer("CLAUDEOS_RUN_ID/CLAUDEOS_SCRATCH_DIR not set; deferring")),
    );
    return;
  }

  const decisionsPath = path.join(scratchDir, runId, "decisions.json");
  const decisions = readDecisions(decisionsPath);
  const toolUseId = payload.tool_use_id;
  const entry = toolUseId ? decisions[toolUseId] : undefined;

  if (!entry) {
    // First time we've seen this tool_use_id — let claudeos collect a decision.
    process.stdout.write(JSON.stringify(defer()));
    return;
  }

  // Pre-decided on resume — honor what the user said.
  if (entry.behavior === "allow" || entry.behavior === "deny") {
    process.stdout.write(JSON.stringify(decide(entry.behavior, entry.reason)));
    return;
  }

  // Unknown shape — fall back to defer so we don't accidentally allow.
  process.stdout.write(JSON.stringify(defer("scratch entry malformed; deferring")));
}

main();
