/**
 * LLMRunner interface + string-keyed registry.
 *
 * vk3.1: structural abstraction layer so future runners (Codex CLI, Gemini
 * CLI, Aider, direct API — kobramaz-prz) can be registered alongside
 * ClaudeCodeRunner without touching dispatch logic in the api-server.
 */

import type { RunRequest } from "@claudeos/runtime-client/contracts";
import type { HarnessOptions, HarnessResult } from "./claude-code.js";
import { ClaudeCodeRunner } from "./claude-code.js";

// ----------------------------------------------------------------------------
// Public interface
// ----------------------------------------------------------------------------

export interface LLMRunner {
  run(request: RunRequest, options: HarnessOptions): Promise<HarnessResult>;
}

/**
 * String union of known runner kinds. Widened to `string` in the DB column
 * and Workspace contract so the registry can accept future values without a
 * contract change, but the literal union here documents the current set.
 */
export type RunnerKind = "claude-code";

export const DEFAULT_RUNNER_KIND: RunnerKind = "claude-code";

// ----------------------------------------------------------------------------
// Error class — mirrors TemplateError's constructor signature
// ----------------------------------------------------------------------------

export class UnknownRunnerError extends Error {
  constructor(public readonly kind: string) {
    super(`Unknown runner kind: "${kind}". Registered kinds: claude-code`);
    this.name = "UnknownRunnerError";
  }
}

// ----------------------------------------------------------------------------
// Registry
// ----------------------------------------------------------------------------

/**
 * Singleton instances per kind. Runners are stateless across calls so one
 * instance per kind is safe and avoids allocation per request.
 */
const registry: Map<string, LLMRunner> = new Map<string, LLMRunner>([
  ["claude-code", new ClaudeCodeRunner()],
]);

/**
 * Look up a runner by kind string. Throws `UnknownRunnerError` for
 * unrecognised kinds. Defaults to `"claude-code"` when called with no args.
 */
export function getRunner(kind: string = DEFAULT_RUNNER_KIND): LLMRunner {
  const runner = registry.get(kind);
  if (!runner) throw new UnknownRunnerError(kind);
  return runner;
}
