/**
 * Resolve the claude binary that ships inside the packaged ClaudeOS app.
 *
 * dcp.9 bundles `@anthropic-ai/claude-code` via the `packages/claude-cli`
 * sidecar so end users don't have to install Claude Code separately. The
 * sidecar's `node_modules` tree is copied verbatim into the packaged app's
 * resources by electron-builder; this module is the single place that
 * knows how to find the right binary on disk.
 *
 * Pure module — no Electron imports, no spawning. Tested with an injectable
 * existence check.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export type FileExists = (path: string) => boolean;

export interface ResolveBundledClaudeInputs {
  /**
   * Where the packaged app's `resources` directory lives. In Electron this is
   * `process.resourcesPath`; we accept it as a string so the resolver stays
   * pure for tests.
   */
  resourcesPath: string;
  /**
   * Set when running from `electron .` against the live source tree. Used as
   * the dev-time fallback so `npm run dev` users also get the bundled CLI.
   */
  electronMainDir?: string;
  /** Override `process.platform` for cross-platform tests. */
  platform?: NodeJS.Platform;
  /** Injectable filesystem check; defaults to `existsSync`. */
  exists?: FileExists;
  /** True when running under `app.isPackaged`; chooses the candidate set. */
  packaged?: boolean;
}

/**
 * The claude binary file name as `npm install` actually drops it. Despite the
 * `.exe` suffix the same name is used on Linux and macOS — Anthropic's
 * publish pipeline reuses one name for all platforms.
 */
const BINARY_NAME = "claude.exe";

/**
 * Returns the absolute path to the bundled `claude` binary, or `null` when
 * no copy of the sidecar is present (e.g. running from a clean checkout
 * without having run `npm --prefix packages/claude-cli install` yet).
 *
 * Resolution order:
 *   1. **Packaged**: `<resourcesPath>/claude-cli/node_modules/@anthropic-ai/claude-code/bin/<BINARY_NAME>`
 *   2. **Dev**: walk up from `electronMainDir` to the repo root and look in
 *      `packages/claude-cli/node_modules/...` so a developer iterating with
 *      `npm run dev` gets the bundled CLI too.
 */
export function resolveBundledClaude(inputs: ResolveBundledClaudeInputs): string | null {
  const exists = inputs.exists ?? existsSync;
  const platform = inputs.platform ?? process.platform;
  const candidates = inputs.packaged
    ? packagedCandidates(inputs.resourcesPath)
    : devCandidates(inputs.electronMainDir, platform);

  for (const path of candidates) {
    if (exists(path)) return path;
  }
  return null;
}

function packagedCandidates(resourcesPath: string): string[] {
  return [
    join(
      resourcesPath,
      "claude-cli",
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
      BINARY_NAME,
    ),
  ];
}

function devCandidates(
  electronMainDir: string | undefined,
  _platform: NodeJS.Platform,
): string[] {
  if (!electronMainDir) return [];
  // From `desktop/out/electron/main.js`: ../../.. = repo root.
  // From `desktop/electron/main.ts` (raw layout): ../.. = repo root.
  const repoRoots = [
    resolve(electronMainDir, "..", "..", ".."),
    resolve(electronMainDir, "..", ".."),
  ];
  return repoRoots.map((root) =>
    join(root, "packages", "claude-cli", "node_modules", "@anthropic-ai", "claude-code", "bin", BINARY_NAME),
  );
}
