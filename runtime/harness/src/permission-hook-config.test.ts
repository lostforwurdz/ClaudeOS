import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  buildPermissionHookConfig,
  persistPermissionDecision,
} from "./permission-hook-config.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "claudeos-perm-test-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("buildPermissionHookConfig writes a valid --settings JSON wired to the hook script", () => {
  const handle = buildPermissionHookConfig({
    hookBinaryPath: "/abs/path/to/permission-hook.js",
    runId: "run-1",
    rootDir: root,
  });
  try {
    const json = JSON.parse(readFileSync(handle.settingsPath, "utf8"));
    assert.ok(json.hooks?.PreToolUse, "settings must define a PreToolUse hook");
    assert.equal(json.hooks.PreToolUse[0].matcher, "*", "matcher must be * to fire on every tool");
    const cmd = json.hooks.PreToolUse[0].hooks[0].command;
    assert.match(cmd, /node /);
    assert.match(cmd, /permission-hook\.js/);
  } finally {
    handle.cleanup();
  }
});

test("buildPermissionHookConfig creates the per-run scratch directory", () => {
  const handle = buildPermissionHookConfig({
    hookBinaryPath: "/abs/permission-hook.js",
    runId: "run-2",
    rootDir: root,
  });
  try {
    // Both the parent scratch dir and the per-run subdir must exist; the
    // hook reads decisions.json from `<scratchDir>/<runId>/decisions.json`.
    assert.ok(existsSync(handle.scratchDir));
    assert.ok(existsSync(join(handle.scratchDir, "run-2")));
  } finally {
    handle.cleanup();
  }
});

test("buildPermissionHookConfig shell-quotes hook paths with spaces", () => {
  const handle = buildPermissionHookConfig({
    hookBinaryPath: "/Applications/My App/permission-hook.js",
    runId: "run-3",
    rootDir: root,
  });
  try {
    const json = JSON.parse(readFileSync(handle.settingsPath, "utf8"));
    const cmd = json.hooks.PreToolUse[0].hooks[0].command as string;
    assert.match(cmd, /"\/Applications\/My App\/permission-hook\.js"/);
  } finally {
    handle.cleanup();
  }
});

test("buildPermissionHookConfig.cleanup removes the settings file and scratch dir", () => {
  const handle = buildPermissionHookConfig({
    hookBinaryPath: "/x.js",
    runId: "run-4",
    rootDir: root,
  });
  assert.ok(existsSync(handle.settingsPath));
  handle.cleanup();
  assert.ok(!existsSync(handle.settingsPath));
  assert.ok(!existsSync(handle.scratchDir));
});

test("persistPermissionDecision creates decisions.json keyed by tool_use_id", () => {
  const handle = buildPermissionHookConfig({
    hookBinaryPath: "/x.js",
    runId: "run-5",
    rootDir: root,
  });
  try {
    persistPermissionDecision({
      scratchDir: handle.scratchDir,
      runId: handle.runId,
      toolUseId: "toolu_first",
      behavior: "allow",
      reason: "user clicked allow",
    });
    const path = join(handle.scratchDir, handle.runId, "decisions.json");
    const decisions = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(decisions, {
      toolu_first: { behavior: "allow", reason: "user clicked allow" },
    });
  } finally {
    handle.cleanup();
  }
});

// ----------------------------------------------------------------------------
// a17.8 — extraHooks materialization (workspace-scoped PostToolUse / Stop).
// The PreToolUse permission hook must keep firing alongside whatever extras
// the workspace defines.
// ----------------------------------------------------------------------------

test("buildPermissionHookConfig leaves PostToolUse/Stop unset when extraHooks is undefined", () => {
  const handle = buildPermissionHookConfig({
    hookBinaryPath: "/x.js",
    runId: "run-extra-none",
    rootDir: root,
  });
  try {
    const json = JSON.parse(readFileSync(handle.settingsPath, "utf8"));
    assert.equal(
      json.hooks.PostToolUse,
      undefined,
      "PostToolUse must be absent when no extras supplied",
    );
    assert.equal(json.hooks.Stop, undefined);
    assert.ok(json.hooks.PreToolUse, "PreToolUse must always remain");
  } finally {
    handle.cleanup();
  }
});

test("buildPermissionHookConfig with extraHooks.PostToolUse adds one entry per command", () => {
  const handle = buildPermissionHookConfig({
    hookBinaryPath: "/x.js",
    runId: "run-extra-ptu",
    rootDir: root,
    extraHooks: { PostToolUse: ["echo done", "npm run lint"] },
  });
  try {
    const json = JSON.parse(readFileSync(handle.settingsPath, "utf8"));
    assert.equal(json.hooks.PostToolUse.length, 2);
    assert.deepEqual(json.hooks.PostToolUse[0], {
      matcher: "*",
      hooks: [{ type: "command", command: "echo done" }],
    });
    assert.deepEqual(json.hooks.PostToolUse[1], {
      matcher: "*",
      hooks: [{ type: "command", command: "npm run lint" }],
    });
    // PreToolUse permission hook must still fire alongside.
    assert.equal(json.hooks.PreToolUse.length, 1);
    assert.match(json.hooks.PreToolUse[0].hooks[0].command, /\/x\.js/);
  } finally {
    handle.cleanup();
  }
});

test("buildPermissionHookConfig with extraHooks.Stop adds one entry per command", () => {
  const handle = buildPermissionHookConfig({
    hookBinaryPath: "/x.js",
    runId: "run-extra-stop",
    rootDir: root,
    extraHooks: { Stop: ["npm test", "echo done"] },
  });
  try {
    const json = JSON.parse(readFileSync(handle.settingsPath, "utf8"));
    assert.equal(json.hooks.Stop.length, 2);
    assert.equal(json.hooks.Stop[0].hooks[0].command, "npm test");
    assert.equal(json.hooks.Stop[1].hooks[0].command, "echo done");
    assert.equal(
      json.hooks.PostToolUse,
      undefined,
      "Stop-only extras must not invent a PostToolUse key",
    );
  } finally {
    handle.cleanup();
  }
});

test("buildPermissionHookConfig with both PostToolUse and Stop materializes them side-by-side", () => {
  const handle = buildPermissionHookConfig({
    hookBinaryPath: "/x.js",
    runId: "run-extra-both",
    rootDir: root,
    extraHooks: {
      PostToolUse: ["fmt"],
      Stop: ["test"],
    },
  });
  try {
    const json = JSON.parse(readFileSync(handle.settingsPath, "utf8"));
    assert.equal(json.hooks.PostToolUse[0].hooks[0].command, "fmt");
    assert.equal(json.hooks.Stop[0].hooks[0].command, "test");
    assert.match(
      json.hooks.PreToolUse[0].hooks[0].command,
      /\/x\.js/,
      "ClaudeOS PreToolUse permission hook must remain wired alongside extras",
    );
  } finally {
    handle.cleanup();
  }
});

test("buildPermissionHookConfig drops empty extraHooks arrays without inventing keys", () => {
  const handle = buildPermissionHookConfig({
    hookBinaryPath: "/x.js",
    runId: "run-extra-empty",
    rootDir: root,
    extraHooks: { PostToolUse: [], Stop: [] },
  });
  try {
    const json = JSON.parse(readFileSync(handle.settingsPath, "utf8"));
    assert.equal(json.hooks.PostToolUse, undefined);
    assert.equal(json.hooks.Stop, undefined);
    assert.ok(json.hooks.PreToolUse, "PreToolUse always present");
  } finally {
    handle.cleanup();
  }
});

test("persistPermissionDecision merges multiple decisions into one file", () => {
  const handle = buildPermissionHookConfig({
    hookBinaryPath: "/x.js",
    runId: "run-6",
    rootDir: root,
  });
  try {
    persistPermissionDecision({
      scratchDir: handle.scratchDir,
      runId: handle.runId,
      toolUseId: "toolu_a",
      behavior: "allow",
    });
    persistPermissionDecision({
      scratchDir: handle.scratchDir,
      runId: handle.runId,
      toolUseId: "toolu_b",
      behavior: "deny",
      reason: "blocked by user",
    });
    const decisions = JSON.parse(
      readFileSync(join(handle.scratchDir, handle.runId, "decisions.json"), "utf8"),
    );
    assert.deepEqual(decisions, {
      toolu_a: { behavior: "allow" },
      toolu_b: { behavior: "deny", reason: "blocked by user" },
    });
  } finally {
    handle.cleanup();
  }
});
