/**
 * ClaudeOS shared contracts.
 *
 * Single source of truth for the desktop ↔ api-server ↔ harness data shapes.
 * Designed against Claude Code's stream-json output. No prompt-layer machinery,
 * no model proxy abstraction, no multi-tenant fields.
 */

// ============================================================================
// Domain
// ============================================================================

export interface Workspace {
  id: string;
  name: string;
  dir: string;
  created_at: string;
  updated_at: string;
}

export interface Session {
  id: string;
  workspace_id: string;
  /** Bound after the first run completes; null until then. */
  claude_session_id: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Run request (desktop → api-server → harness)
// ============================================================================

export interface RunRequest {
  workspace_id: string;
  session_id: string;
  input_id: string;

  instruction: string;
  attachments?: Attachment[];

  model?: string;
  append_system_prompt?: string;
  permission_mode?: PermissionMode;
  add_dirs?: string[];
  mcp_servers?: McpServerConfig[];

  timeout_seconds?: number;
  debug?: boolean;
}

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions";

export interface Attachment {
  kind: "image" | "file";
  /** Path relative to the workspace directory. */
  workspace_path: string;
  mime_type: string;
}

export interface McpServerConfig {
  name: string;
  type: "stdio" | "sse" | "http";
  command?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

// ============================================================================
// Run events (harness → api-server → desktop, NDJSON over stdout, fan-out via WS)
// ============================================================================

export interface RunEventBase {
  session_id: string;
  input_id: string;
  /** Monotonic per (session_id, input_id). */
  sequence: number;
  /** ISO 8601. */
  timestamp: string;
}

export type RunEvent =
  | RunStartedEvent
  | TextDeltaEvent
  | ThinkingDeltaEvent
  | ToolCallEvent
  | ToolResultEvent
  | CompactionStartEvent
  | CompactionEndEvent
  | PermissionRequestEvent
  | RunCompletedEvent
  | RunFailedEvent;

export interface RunStartedEvent extends RunEventBase {
  type: "run_started";
  payload: {
    claude_session_id: string;
    model: string;
    tools: string[];
    mcp_servers: string[];
    permission_mode: string;
    cwd: string;
  };
}

export interface TextDeltaEvent extends RunEventBase {
  type: "text_delta";
  payload: { message_id: string; text: string };
}

export interface ThinkingDeltaEvent extends RunEventBase {
  type: "thinking_delta";
  payload: { message_id: string; text: string };
}

export interface ToolCallEvent extends RunEventBase {
  type: "tool_call";
  payload: {
    message_id: string;
    tool_use_id: string;
    name: string;
    input: unknown;
  };
}

export interface ToolResultEvent extends RunEventBase {
  type: "tool_result";
  payload: { tool_use_id: string; content: unknown; is_error: boolean };
}

export interface CompactionStartEvent extends RunEventBase {
  type: "compaction_start";
  payload: { trigger: "auto" | "manual" };
}

export interface CompactionEndEvent extends RunEventBase {
  type: "compaction_end";
  payload: Record<string, never>;
}

export interface PermissionRequestEvent extends RunEventBase {
  type: "permission_request";
  payload: {
    tool_use_id: string;
    tool_name: string;
    input: unknown;
    reason: string;
  };
}

export interface RunCompletedEvent extends RunEventBase {
  type: "run_completed";
  payload: {
    duration_ms: number;
    num_turns: number;
    usage: TokenUsage;
    cost_usd: number;
    result: string;
  };
}

export interface RunFailedEvent extends RunEventBase {
  type: "run_failed";
  payload: { error: string; subtype: string };
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

// ============================================================================
// HTTP API surface (desktop ↔ api-server)
// ============================================================================

export interface CreateWorkspaceBody {
  name: string;
  dir: string;
  /**
   * Optional template name to seed the workspace dir with. The template's
   * files are copied in before the workspace row is inserted; the request
   * fails if any seed file would clobber an existing one in `dir`.
   */
  template?: string;
}

export interface TemplateSummary {
  name: string;
  description: string;
}

export interface CreateSessionBody {
  workspace_id: string;
  /**
   * Optional: fork a new session from an existing Claude conversation. The
   * new session's first run will resume that conversation via --resume.
   * Used by the run-history browser's "Fork from here" affordance (rec-6).
   */
  fork_from_claude_session_id?: string;
}

export interface SubmitRunResponse {
  run_id: string;
  session_id: string;
  input_id: string;
}

export interface RunSummary {
  id: string;
  session_id: string;
  input_id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  started_at: string;
  completed_at: string | null;
}

/**
 * Paginated list response. `next_before` is the cursor for the next page —
 * pass it as the `before` query param to fetch older items. `null` when
 * there are no more items.
 */
export interface Page<T> {
  items: T[];
  next_before: string | null;
}
