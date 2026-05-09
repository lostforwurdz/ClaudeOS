/**
 * Builds the per-run --settings JSON that wires the ClaudeOS PreToolUse
 * permission hook into a `claude -p` invocation (xh4.2).
 *
 * The settings file lives in the OS tempdir alongside the per-run scratch
 * directory. The hook script reads CLAUDEOS_RUN_ID + CLAUDEOS_SCRATCH_DIR
 * from the spawn env to find its decisions file.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface PermissionHookConfig {
  /** Absolute path to the generated --settings JSON file. */
  settingsPath: string;
  /** Per-run scratch dir; the hook reads decisions.json from here. */
  scratchDir: string;
  /** RunId env var the hook expects. */
  runId: string;
  /** Cleanup function — removes the settings file and scratch dir. */
  cleanup(): void;
}

export interface BuildPermissionHookConfigInput {
  /** Absolute path to the bundled hook launcher (`packages/claude-cli/permission-hook.js`). */
  hookBinaryPath: string;
  /** Stable id for this harness invocation (typically the api-server's run id). */
  runId: string;
  /** Optional override for testing; defaults to `os.tmpdir()`. */
  rootDir?: string;
}

/**
 * Generate the `claude --settings` JSON wiring our PreToolUse hook to fire
 * for every tool call. Returns absolute paths plus a cleanup function.
 *
 * Settings shape (per https://code.claude.com/docs/en/hooks):
 *   {
 *     "hooks": {
 *       "PreToolUse": [{
 *         "matcher": "*",
 *         "hooks": [{ "type": "command", "command": "node /path/permission-hook.js" }]
 *       }]
 *     }
 *   }
 */
export function buildPermissionHookConfig(
  input: BuildPermissionHookConfigInput,
): PermissionHookConfig {
  const root = input.rootDir ?? tmpdir();
  const dir = join(root, `claudeos-perm-${input.runId}`);
  const scratchDir = join(dir, "scratch");
  const settingsPath = join(dir, "settings.json");

  mkdirSync(scratchDir, { recursive: true });
  mkdirSync(join(scratchDir, input.runId), { recursive: true });

  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: `node ${shellQuote(input.hookBinaryPath)}`,
            },
          ],
        },
      ],
    },
  };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });

  return {
    settingsPath,
    scratchDir,
    runId: input.runId,
    cleanup() {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
}

/**
 * Persist a per-tool_use_id decision for the hook to read on the next claude
 * invocation. The hook script keys decisions by `tool_use_id` and returns the
 * saved `behavior` (allow/deny) when it sees the same id again on resume.
 */
export interface PersistDecisionInput {
  scratchDir: string;
  runId: string;
  toolUseId: string;
  behavior: "allow" | "deny";
  reason?: string;
}

export function persistPermissionDecision(input: PersistDecisionInput): void {
  const path = join(input.scratchDir, input.runId, "decisions.json");
  let current: Record<string, { behavior: "allow" | "deny"; reason?: string }> = {};
  try {
    current = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // empty / missing — start fresh
  }
  current[input.toolUseId] = {
    behavior: input.behavior,
    ...(input.reason ? { reason: input.reason } : {}),
  };
  writeFileSync(path, JSON.stringify(current, null, 2), { mode: 0o600 });
}

/** Conservative shell-quote for the command path embedded in the settings JSON. */
function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(s)) return s;
  return `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}
