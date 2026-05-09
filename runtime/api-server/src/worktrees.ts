/**
 * Git worktree provisioning for parallel runs (kobramaz-a17.3).
 *
 * Each parallel run inside a workspace gets its own throwaway git worktree
 * so file edits don't collide. Worktrees live under
 * `~/.claudeos/worktrees/<workspace-id>/<run-name>/` by default and check
 * out a fresh branch from the workspace's current HEAD.
 *
 * Pure module — the `git` invocation is injectable for tests.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface GitRunner {
  run(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }>;
}

const realGitRunner: GitRunner = {
  async run(args, cwd) {
    const { stdout, stderr } = await execFileP("git", args, {
      cwd,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { stdout, stderr };
  },
};

export interface WorktreeOptions {
  /** Override the runner — tests pass a stub that records invocations. */
  git?: GitRunner;
  /** Override the worktree-root dir. Defaults to ~/.claudeos/worktrees. */
  rootDir?: string;
}

export class WorktreeError extends Error {
  constructor(
    message: string,
    public readonly code: "not_a_repo" | "git_failed" | "exists",
  ) {
    super(message);
    this.name = "WorktreeError";
  }
}

export function defaultWorktreeRoot(): string {
  return process.env.CLAUDEOS_WORKTREE_ROOT ?? join(homedir(), ".claudeos", "worktrees");
}

/**
 * Provision a fresh worktree for a parallel run. Creates a unique branch
 * (`claudeos/<workspace-id>/<run-name>`) so the user can `git diff` and
 * merge later. Returns the absolute worktree path.
 */
export async function provisionWorktree(args: {
  workspaceDir: string;
  workspaceId: string;
  runName: string;
  options?: WorktreeOptions;
}): Promise<string> {
  const git = args.options?.git ?? realGitRunner;
  const root = args.options?.rootDir ?? defaultWorktreeRoot();

  // Pre-flight: workspaceDir must be a git repo. Without this check `git
  // worktree add` fails with a confusing message.
  try {
    await git.run(["rev-parse", "--show-toplevel"], args.workspaceDir);
  } catch (err) {
    throw new WorktreeError(
      `${args.workspaceDir} is not inside a git repository: ${(err as Error).message}`,
      "not_a_repo",
    );
  }

  const branchName = `claudeos/${args.workspaceId}/${args.runName}`;
  const worktreePath = join(root, args.workspaceId, args.runName);

  if (existsSync(worktreePath)) {
    throw new WorktreeError(
      `worktree path already exists: ${worktreePath}`,
      "exists",
    );
  }

  mkdirSync(dirname(worktreePath), { recursive: true });

  try {
    await git.run(
      ["worktree", "add", "-b", branchName, worktreePath, "HEAD"],
      args.workspaceDir,
    );
  } catch (err) {
    throw new WorktreeError(
      `git worktree add failed: ${(err as Error).message}`,
      "git_failed",
    );
  }

  return worktreePath;
}

/**
 * Best-effort worktree prune. Errors are swallowed because stale worktrees
 * are recoverable manually (`git worktree prune`) and we don't want
 * cleanup failures to crash the api-server.
 */
export async function pruneWorktree(args: {
  workspaceDir: string;
  worktreePath: string;
  options?: WorktreeOptions;
}): Promise<void> {
  const git = args.options?.git ?? realGitRunner;
  try {
    await git.run(
      ["worktree", "remove", "--force", args.worktreePath],
      args.workspaceDir,
    );
  } catch {
    // ignore — caller can still inspect the leftover dir; `git worktree
    // prune` from the main repo will clean up any dangling refs.
  }
}
