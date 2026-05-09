import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { WorktreeError, provisionWorktree, type GitRunner } from "./worktrees.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "claudeos-worktrees-"));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

interface CallLog {
  args: string[];
  cwd: string;
}

function recordingGit(opts: {
  topLevel?: string;
  worktreeAddFails?: boolean;
}): { git: GitRunner; calls: CallLog[] } {
  const calls: CallLog[] = [];
  const git: GitRunner = {
    async run(args, cwd) {
      calls.push({ args, cwd });
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        if (opts.topLevel === undefined) {
          throw new Error("not a git repository");
        }
        return { stdout: `${opts.topLevel}\n`, stderr: "" };
      }
      if (args[0] === "worktree" && args[1] === "add" && opts.worktreeAddFails) {
        throw new Error("worktree add failed");
      }
      return { stdout: "", stderr: "" };
    },
  };
  return { git, calls };
}

test("provisionWorktree throws not_a_repo when workspace dir is not a git repo", async () => {
  const { git } = recordingGit({});
  await assert.rejects(
    provisionWorktree({
      workspaceDir: "/nope",
      workspaceId: "ws-1",
      runName: "tests",
      options: { git, rootDir: tmpRoot },
    }),
    (err: Error) => err instanceof WorktreeError && (err as WorktreeError).code === "not_a_repo",
  );
});

test("provisionWorktree calls 'git worktree add -b <branch> <path> HEAD' under the workspace dir", async () => {
  const { git, calls } = recordingGit({ topLevel: "/path/to/repo" });
  const path = await provisionWorktree({
    workspaceDir: "/path/to/repo",
    workspaceId: "ws-1",
    runName: "impl",
    options: { git, rootDir: tmpRoot },
  });
  assert.equal(path, join(tmpRoot, "ws-1", "impl"));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args, [
    "worktree",
    "add",
    "-b",
    "claudeos/ws-1/impl",
    join(tmpRoot, "ws-1", "impl"),
    "HEAD",
  ]);
  assert.equal(calls[1].cwd, "/path/to/repo");
});

test("provisionWorktree throws 'exists' when the target path is already populated", async () => {
  const target = join(tmpRoot, "ws-1", "impl");
  // Pre-create the directory so existsSync returns true.
  const fs = await import("node:fs");
  fs.mkdirSync(target, { recursive: true });

  const { git } = recordingGit({ topLevel: "/path/to/repo" });
  await assert.rejects(
    provisionWorktree({
      workspaceDir: "/path/to/repo",
      workspaceId: "ws-1",
      runName: "impl",
      options: { git, rootDir: tmpRoot },
    }),
    (err: Error) => err instanceof WorktreeError && (err as WorktreeError).code === "exists",
  );
});

test("provisionWorktree throws git_failed and surfaces the error message when git itself errors", async () => {
  const { git } = recordingGit({ topLevel: "/repo", worktreeAddFails: true });
  await assert.rejects(
    provisionWorktree({
      workspaceDir: "/repo",
      workspaceId: "ws-1",
      runName: "impl",
      options: { git, rootDir: tmpRoot },
    }),
    (err: Error) => {
      return (
        err instanceof WorktreeError &&
        (err as WorktreeError).code === "git_failed" &&
        /worktree add failed/.test(err.message)
      );
    },
  );
});

test("provisionWorktree creates the parent dir even if it didn't exist", async () => {
  const fakeRoot = join(tmpRoot, "deeply", "nested", "root");
  const { git } = recordingGit({ topLevel: "/repo" });
  await provisionWorktree({
    workspaceDir: "/repo",
    workspaceId: "ws-x",
    runName: "z",
    options: { git, rootDir: fakeRoot },
  });
  assert.ok(
    existsSync(join(fakeRoot, "ws-x")),
    "parent dir for the worktree must be created",
  );
});
