/**
 * Thin wrapper around the `bd` CLI for the four memory operations the MCP
 * exposes. Injectable in tests via the `BdRunner` interface so the server
 * can run without a real `bd` install.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface BdRunner {
  remember(key: string, value: string): Promise<void>;
  recall(key: string): Promise<{ key: string; value: string } | null>;
  memories(search?: string): Promise<Array<{ key: string; value: string }>>;
  forget(key: string): Promise<boolean>;
}

export interface BdRunnerOptions {
  /** Path to the `bd` binary. Defaults to `bd` (resolved via PATH). */
  binary?: string;
}

/**
 * Run `bd <args>` and return stdout. Errors include the stderr tail so the
 * caller (and the agent reading the MCP error response) can see what went
 * wrong without re-running.
 */
async function runBd(binary: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP(binary, args, { maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const tail = (e.stderr ?? "").trim().split(/\r?\n/).slice(-3).join("\n");
    throw new Error(`bd ${args.join(" ")} failed: ${tail || e.message || "(no detail)"}`);
  }
}

export function createBdRunner(opts: BdRunnerOptions = {}): BdRunner {
  const binary = opts.binary ?? "bd";

  return {
    async remember(key, value) {
      await runBd(binary, ["remember", value, "--key", key]);
    },

    async recall(key) {
      // `bd recall <key> --json` returns the value JSON-encoded (typically a
      // bare string, possibly an object). Exits non-zero when the key is
      // unknown — we treat that as null instead of throwing.
      try {
        const stdout = await runBd(binary, ["recall", key, "--json"]);
        const parsed = JSON.parse(stdout) as unknown;
        const value = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
        return { key, value };
      } catch {
        return null;
      }
    },

    async memories(search) {
      const args = ["memories", "--json"];
      if (search && search.trim().length > 0) args.splice(1, 0, search);
      const stdout = await runBd(binary, args);
      // `bd memories --json` returns an object mapping key → value (string).
      // Convert to a stable list ordered by key for predictable output.
      const obj = JSON.parse(stdout) as Record<string, unknown>;
      return Object.entries(obj)
        .map(([key, raw]) => ({
          key,
          value: typeof raw === "string" ? raw : JSON.stringify(raw),
        }))
        .sort((a, b) => a.key.localeCompare(b.key));
    },

    async forget(key) {
      try {
        await runBd(binary, ["forget", key]);
        return true;
      } catch {
        return false;
      }
    },
  };
}
