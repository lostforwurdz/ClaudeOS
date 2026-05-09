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
