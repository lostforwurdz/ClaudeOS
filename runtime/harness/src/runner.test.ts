/**
 * vk3.1: Tests for the LLMRunner registry.
 *
 * ClaudeCodeRunner.run() delegation is tested via a fake claudeBinary that
 * exits immediately — we verify the harness is invoked with the correct args
 * rather than spawning a real claude binary.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ClaudeCodeRunner,
  DEFAULT_RUNNER_KIND,
  UnknownRunnerError,
  getRunner,
} from "./index.js";

// ----------------------------------------------------------------------------
// Registry lookup
// ----------------------------------------------------------------------------

test("getRunner() with no arg returns an instance that satisfies LLMRunner", () => {
  const runner = getRunner();
  assert.equal(typeof runner.run, "function");
});

test("getRunner('claude-code') returns a ClaudeCodeRunner", () => {
  const runner = getRunner("claude-code");
  assert.ok(runner instanceof ClaudeCodeRunner);
});

test("getRunner() default arg matches DEFAULT_RUNNER_KIND", () => {
  assert.equal(DEFAULT_RUNNER_KIND, "claude-code");
  // Both paths return the same singleton instance.
  assert.strictEqual(getRunner(), getRunner(DEFAULT_RUNNER_KIND));
});

test("getRunner('nonsense') throws UnknownRunnerError", () => {
  assert.throws(
    () => getRunner("nonsense"),
    (err: unknown) => {
      assert.ok(err instanceof UnknownRunnerError);
      assert.equal(err.kind, "nonsense");
      assert.match(err.message, /Unknown runner kind: "nonsense"/);
      return true;
    },
  );
});

test("UnknownRunnerError.name is 'UnknownRunnerError'", () => {
  const err = new UnknownRunnerError("bad-kind");
  assert.equal(err.name, "UnknownRunnerError");
  assert.ok(err instanceof Error);
});

// ----------------------------------------------------------------------------
// ClaudeCodeRunner.run() delegates to runHarness
// ----------------------------------------------------------------------------

test("ClaudeCodeRunner.run() delegates to runHarness — exit-0 stub binary", async () => {
  // Create a temp dir to serve as the workspace.
  const tmpDir = mkdtempSync(join(tmpdir(), "claudeos-runner-test-"));

  // Write a tiny shell script that exits 0 immediately. This lets runHarness
  // complete its spawn/stream cycle without a real claude binary while still
  // exercising the real code path (no mocking at the module level).
  const stubBin = join(tmpDir, "fake-claude.sh");
  writeFileSync(stubBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const events: unknown[] = [];
  let caughtError: unknown = null;

  try {
    const runner = new ClaudeCodeRunner();
    await runner.run(
      {
        workspace_id: "ws-1",
        session_id: "sess-1",
        input_id: "in-1",
        instruction: "hello",
      },
      {
        workspaceDir: tmpDir,
        claudeBinary: stubBin,
        onEvent: (e) => events.push(e),
      },
    );
  } catch (err) {
    caughtError = err;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  // runHarness must complete without throwing. The stub exits 0 with no
  // output, so no terminal event is emitted — the harness synthesises a
  // run_failed("harness_no_result"). That is still a successful delegation:
  // the runner called runHarness and got a result.
  assert.equal(caughtError, null, `ClaudeCodeRunner.run() must not throw: ${caughtError}`);
  // run_failed is emitted when the binary exits without producing a result.
  assert.equal(events.length, 1);
  const ev = events[0] as { type: string; payload: { subtype: string } };
  assert.equal(ev.type, "run_failed");
  assert.equal(ev.payload.subtype, "harness_no_result");
});
