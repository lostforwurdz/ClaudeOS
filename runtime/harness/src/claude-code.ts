/**
 * ClaudeOS Claude Code subprocess runner.
 *
 * Spawns `claude --print --output-format stream-json --include-partial-messages`
 * and translates its NDJSON stream into ClaudeOS RunEvents.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";

import type {
  RunEvent,
  RunRequest,
  TokenUsage,
} from "@claudeos/runtime-client/contracts";

import { materializeMcpConfig, type MaterializedMcpConfig } from "./mcp-config.js";
import { buildStreamUserMessage, needsStreamInput } from "./stream-input.js";

export interface HarnessOptions {
  /** Absolute path to the workspace directory. Set as CWD and as --add-dir. */
  workspaceDir: string;
  /** Path to the claude binary; defaults to "claude" on PATH. */
  claudeBinary?: string;
  /** OAuth token; defaults to process.env.CLAUDE_CODE_OAUTH_TOKEN. */
  claudeOauthToken?: string;
  /** Existing claude session id to resume; null/undefined for a new session. */
  resumeClaudeSessionId?: string | null;
  /** Receives each RunEvent as it streams. */
  onEvent: (event: RunEvent) => void;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
}

export interface HarnessResult {
  /** The claude session id observed in the stream (init or resumed). */
  claudeSessionId: string | null;
  /** Final exit code from the claude subprocess. */
  exitCode: number;
}

const KILL_GRACE_MS = 5_000;

export async function runHarness(
  request: RunRequest,
  options: HarnessOptions,
): Promise<HarnessResult> {
  // Materialize MCP overlays before building argv; cleanup happens in `finally`
  // so a tempfile is never leaked on spawn/parse errors.
  const mcpConfig =
    request.mcp_servers && request.mcp_servers.length > 0
      ? materializeMcpConfig(request.mcp_servers)
      : null;

  try {
    const useStreamInput = needsStreamInput(request);
    const args = buildArgs(request, options, mcpConfig, useStreamInput);
    const env = buildEnv(options);
    const binary = options.claudeBinary ?? "claude";

    // Always pipe stdin so the type narrows to a writable stream regardless of
    // whether we send a stream-json user message. In text-input mode we just
    // close it immediately, which claude treats as "no stdin payload".
    const child = spawn(binary, args, {
      cwd: options.workspaceDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (useStreamInput) {
      const userMessage = await buildStreamUserMessage(request, {
        workspaceDir: options.workspaceDir,
      });
      writeStreamInput(child.stdin, userMessage);
    } else {
      child.stdin.end();
    }

    const state: ParserState = {
      request,
      claudeSessionId: null,
      sequence: 0,
      currentMessageId: null,
      contentBlockTypes: new Map(),
      terminalEmitted: false,
      onEvent: options.onEvent,
    };

    attachCancellation(child, options.signal);

    const stderrChunks: string[] = [];
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk.toString()));

    const stdoutClosed = new Promise<void>((resolve) => {
      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => handleLine(line, state));
      rl.on("close", () => resolve());
    });

    const exitCode = await new Promise<number>((resolve) => {
      child.on("exit", (code) => resolve(code ?? -1));
    });
    await stdoutClosed;

    if (!state.terminalEmitted) {
      emit(state, {
        type: "run_failed",
        payload: {
          error:
            stderrChunks.join("").trim() ||
            `claude exited with code ${exitCode} before emitting a result event`,
          subtype: "harness_no_result",
        },
      });
    }

    return { claudeSessionId: state.claudeSessionId, exitCode };
  } finally {
    mcpConfig?.cleanup();
  }
}

// ----------------------------------------------------------------------------
// Argv + env
// ----------------------------------------------------------------------------

/**
 * Build claude argv. Exported for unit tests that verify --mcp-config wiring
 * without spawning a subprocess.
 */
export function buildArgs(
  request: RunRequest,
  options: HarnessOptions,
  mcpConfig: MaterializedMcpConfig | null = null,
  useStreamInput = false,
): string[] {
  // --add-dir is variadic: it consumes every following non-flag token until the
  // next flag. If it lands directly before the positional prompt, claude swallows
  // the prompt as a directory and aborts with "Input must be provided either
  // through stdin or as a prompt argument when using --print". So all --add-dir
  // values must precede the next flag, and in practice we put them at the head.
  const args: string[] = ["--add-dir", options.workspaceDir];
  for (const dir of request.add_dirs ?? []) {
    args.push("--add-dir", dir);
  }

  args.push(
    "--print",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
  );

  if (useStreamInput) {
    args.push("--input-format", "stream-json");
  }
  if (mcpConfig) {
    args.push("--mcp-config", mcpConfig.path);
  }
  if (options.resumeClaudeSessionId) {
    args.push("--resume", options.resumeClaudeSessionId);
  }
  if (request.model) {
    args.push("--model", request.model);
  }
  if (request.append_system_prompt) {
    args.push("--append-system-prompt", request.append_system_prompt);
  }
  if (request.permission_mode) {
    args.push("--permission-mode", request.permission_mode);
  }

  // Positional prompt only in text-input mode. Stream-json delivers the prompt
  // through stdin as a typed user message.
  if (!useStreamInput) {
    args.push(request.instruction);
  }
  return args;
}

function writeStreamInput(
  stdin: Writable,
  message: { type: "user"; message: { role: "user"; content: unknown[] } },
): void {
  stdin.write(`${JSON.stringify(message)}\n`);
  stdin.end();
}

function buildEnv(options: HarnessOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const token = options.claudeOauthToken ?? process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (token) {
    env.CLAUDE_CODE_OAUTH_TOKEN = token;
  }
  return env;
}

function attachCancellation(
  child: ChildProcessByStdio<Writable, Readable, Readable>,
  signal: AbortSignal | undefined,
): void {
  if (!signal) return;
  if (signal.aborted) {
    child.kill("SIGTERM");
    return;
  }
  signal.addEventListener(
    "abort",
    () => {
      child.kill("SIGTERM");
      const force = setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, KILL_GRACE_MS);
      force.unref();
    },
    { once: true },
  );
}

// ----------------------------------------------------------------------------
// Stream-json parser + event mapper
// ----------------------------------------------------------------------------

/**
 * Parse a sequence of stream-json lines into RunEvents without spawning a
 * subprocess. Exposed for testing and for replaying captured Claude Code
 * transcripts.
 */
export function parseStream(
  request: RunRequest,
  lines: Iterable<string>,
): RunEvent[] {
  const events: RunEvent[] = [];
  const state: ParserState = {
    request,
    claudeSessionId: null,
    sequence: 0,
    currentMessageId: null,
    contentBlockTypes: new Map(),
    terminalEmitted: false,
    onEvent: (e) => events.push(e),
  };
  for (const line of lines) handleLine(line, state);
  return events;
}

interface ParserState {
  request: RunRequest;
  claudeSessionId: string | null;
  sequence: number;
  currentMessageId: string | null;
  /** Maps content block index → block type so deltas can be routed. */
  contentBlockTypes: Map<number, string>;
  terminalEmitted: boolean;
  onEvent: (event: RunEvent) => void;
}

function handleLine(line: string, state: ParserState): void {
  const trimmed = line.trim();
  if (!trimmed) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (!isObject(parsed)) return;

  const type = parsed.type;
  if (type === "system") {
    handleSystem(parsed, state);
  } else if (type === "stream_event") {
    handleStreamEvent(parsed, state);
  } else if (type === "assistant") {
    handleAssistant(parsed, state);
  } else if (type === "user") {
    handleUser(parsed, state);
  } else if (type === "result") {
    handleResult(parsed, state);
  }
  // Unknown types are ignored — Claude Code may add new ones.
}

function handleSystem(message: Record<string, unknown>, state: ParserState): void {
  const subtype = message.subtype;
  if (subtype === "init") {
    const sessionId = stringOr(message.session_id, "");
    if (sessionId) state.claudeSessionId = sessionId;
    emit(state, {
      type: "run_started",
      payload: {
        claude_session_id: sessionId,
        model: stringOr(message.model, ""),
        tools: stringArray(message.tools),
        mcp_servers: mcpServerNames(message.mcp_servers),
        permission_mode: stringOr(message.permissionMode, "default"),
        cwd: stringOr(message.cwd, ""),
      },
    });
  } else if (subtype === "compact_boundary") {
    const meta = isObject(message.compact_metadata) ? message.compact_metadata : {};
    const trigger = meta.trigger === "manual" ? "manual" : "auto";
    emit(state, {
      type: "compaction_start",
      payload: { trigger },
    });
    emit(state, {
      type: "compaction_end",
      payload: {},
    });
  }
}

function handleStreamEvent(
  message: Record<string, unknown>,
  state: ParserState,
): void {
  const event = isObject(message.event) ? message.event : null;
  if (!event) return;
  const eventType = event.type;

  if (eventType === "message_start") {
    const inner = isObject(event.message) ? event.message : null;
    if (inner) {
      const id = stringOr(inner.id, "");
      if (id) state.currentMessageId = id;
    }
    state.contentBlockTypes.clear();
    return;
  }

  if (eventType === "content_block_start") {
    const index = numberOr(event.index, -1);
    const block = isObject(event.content_block) ? event.content_block : null;
    if (index >= 0 && block) {
      state.contentBlockTypes.set(index, stringOr(block.type, ""));
    }
    return;
  }

  if (eventType === "content_block_delta") {
    const index = numberOr(event.index, -1);
    const delta = isObject(event.delta) ? event.delta : null;
    if (!delta || index < 0) return;
    const blockType = state.contentBlockTypes.get(index) ?? "";
    const messageId = state.currentMessageId ?? "";
    const deltaType = delta.type;

    if (deltaType === "text_delta" && (blockType === "text" || blockType === "")) {
      emit(state, {
        type: "text_delta",
        payload: { message_id: messageId, text: stringOr(delta.text, "") },
      });
    } else if (deltaType === "thinking_delta") {
      emit(state, {
        type: "thinking_delta",
        payload: { message_id: messageId, text: stringOr(delta.thinking, "") },
      });
    }
    // input_json_delta and signature_delta are ignored — tool_call events are
    // emitted from the complete `assistant` message instead.
    return;
  }

  if (eventType === "content_block_stop") {
    const index = numberOr(event.index, -1);
    if (index >= 0) state.contentBlockTypes.delete(index);
    return;
  }

  if (eventType === "message_stop") {
    state.currentMessageId = null;
    state.contentBlockTypes.clear();
    return;
  }
}

function handleAssistant(
  message: Record<string, unknown>,
  state: ParserState,
): void {
  const inner = isObject(message.message) ? message.message : null;
  if (!inner) return;
  const messageId = stringOr(inner.id, "");
  const content = Array.isArray(inner.content) ? inner.content : [];
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block.type === "tool_use") {
      emit(state, {
        type: "tool_call",
        payload: {
          message_id: messageId,
          tool_use_id: stringOr(block.id, ""),
          name: stringOr(block.name, ""),
          input: block.input ?? null,
        },
      });
    }
  }
}

function handleUser(
  message: Record<string, unknown>,
  state: ParserState,
): void {
  const inner = isObject(message.message) ? message.message : null;
  if (!inner) return;
  const content = Array.isArray(inner.content) ? inner.content : [];
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block.type === "tool_result") {
      emit(state, {
        type: "tool_result",
        payload: {
          tool_use_id: stringOr(block.tool_use_id, ""),
          content: block.content ?? null,
          is_error: block.is_error === true,
        },
      });
    }
  }
}

function handleResult(
  message: Record<string, unknown>,
  state: ParserState,
): void {
  const sessionId = stringOr(message.session_id, "");
  if (sessionId && !state.claudeSessionId) state.claudeSessionId = sessionId;

  const subtype = stringOr(message.subtype, "unknown");
  const isError = message.is_error === true || subtype !== "success";

  if (isError) {
    emit(state, {
      type: "run_failed",
      payload: {
        error: stringOr(message.result, "") || `claude returned subtype "${subtype}"`,
        subtype,
      },
    });
  } else {
    emit(state, {
      type: "run_completed",
      payload: {
        duration_ms: numberOr(message.duration_ms, 0),
        num_turns: numberOr(message.num_turns, 0),
        usage: parseUsage(message.usage),
        cost_usd: numberOr(message.total_cost_usd, 0),
        result: stringOr(message.result, ""),
      },
    });
  }
}

// ----------------------------------------------------------------------------
// Emit helpers
// ----------------------------------------------------------------------------

type EventPayload = Pick<RunEvent, "type" | "payload">;

function emit(state: ParserState, partial: EventPayload): void {
  const event = {
    session_id: state.request.session_id,
    input_id: state.request.input_id,
    sequence: state.sequence++,
    timestamp: new Date().toISOString(),
    type: partial.type,
    payload: partial.payload,
  } as RunEvent;
  if (event.type === "run_completed" || event.type === "run_failed") {
    state.terminalEmitted = true;
  }
  state.onEvent(event);
}

// ----------------------------------------------------------------------------
// Type guards
// ----------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function mcpServerNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isObject)
    .map((s) => stringOr(s.name, ""))
    .filter((n) => n.length > 0);
}

function parseUsage(value: unknown): TokenUsage {
  const u = isObject(value) ? value : {};
  return {
    input_tokens: numberOr(u.input_tokens, 0),
    output_tokens: numberOr(u.output_tokens, 0),
    cache_creation_input_tokens: numberOr(u.cache_creation_input_tokens, 0),
    cache_read_input_tokens: numberOr(u.cache_read_input_tokens, 0),
  };
}
