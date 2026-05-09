/**
 * Per-workspace chat state and a pure reducer that drives it.
 *
 * Each workspace the user opens gets its own slot keyed by `workspace.id`. A
 * slot survives tab switches, so a long-running tool call in workspace A
 * keeps streaming into A's message list while the user reads workspace B.
 *
 * The reducer is intentionally pure: every transition is a deterministic
 * function of (state, action), with no side effects, no fetches, and no
 * timers. The view layer (App.tsx) owns the side-effect side of the world —
 * fetch calls, WebSocket lifecycle, sessionId generation — and dispatches
 * the resulting facts.
 */

import type {
  RunEvent,
  Session,
  Workspace,
} from "@claudeos/runtime-client/contracts";

export interface Message {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
}

export interface WorkspaceState {
  workspace: Workspace;
  session: Session | null;
  messages: Message[];
  streaming: boolean;
  error: string | null;
  /** Server-assigned run id of the in-flight run, if any. */
  activeRunId: string | null;
}

export interface AppState {
  byId: Record<string, WorkspaceState>;
  /** Insertion order of opened workspaces. Used to render the tab strip. */
  openOrder: string[];
  activeId: string | null;
}

export const initialAppState: AppState = {
  byId: {},
  openOrder: [],
  activeId: null,
};

export type Action =
  | { type: "WORKSPACE_OPENED"; workspace: Workspace }
  | { type: "WORKSPACE_CLOSED"; workspaceId: string }
  | { type: "WORKSPACE_ACTIVATED"; workspaceId: string }
  | { type: "SESSION_BOUND"; workspaceId: string; session: Session }
  | {
      type: "USER_SENT";
      workspaceId: string;
      message: Message;
      runId: string;
    }
  | { type: "RUN_EVENT"; workspaceId: string; event: RunEvent }
  | { type: "RUN_FINISHED"; workspaceId: string; error?: string | null }
  | { type: "ERROR_SET"; workspaceId: string; error: string | null };

export function appReducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "WORKSPACE_OPENED": {
      const id = action.workspace.id;
      if (state.byId[id]) {
        // Already open — just activate it.
        return { ...state, activeId: id };
      }
      const slot: WorkspaceState = {
        workspace: action.workspace,
        session: null,
        messages: [],
        streaming: false,
        error: null,
        activeRunId: null,
      };
      return {
        byId: { ...state.byId, [id]: slot },
        openOrder: [...state.openOrder, id],
        activeId: id,
      };
    }

    case "WORKSPACE_CLOSED": {
      const id = action.workspaceId;
      if (!state.byId[id]) return state;
      const { [id]: _removed, ...rest } = state.byId;
      const order = state.openOrder.filter((x) => x !== id);
      // If we closed the active tab, fall back to the previous open one.
      const activeId =
        state.activeId === id
          ? (order[order.length - 1] ?? null)
          : state.activeId;
      return { byId: rest, openOrder: order, activeId };
    }

    case "WORKSPACE_ACTIVATED": {
      if (!state.byId[action.workspaceId]) return state;
      return { ...state, activeId: action.workspaceId };
    }

    case "SESSION_BOUND":
      return updateSlot(state, action.workspaceId, (s) => ({
        ...s,
        session: action.session,
      }));

    case "USER_SENT":
      return updateSlot(state, action.workspaceId, (s) => ({
        ...s,
        messages: [...s.messages, action.message],
        streaming: true,
        error: null,
        activeRunId: action.runId,
      }));

    case "RUN_EVENT":
      return updateSlot(state, action.workspaceId, (s) => ({
        ...s,
        messages: applyEvent(s.messages, action.event),
        // Keep claude_session_id binding in sync the moment we see it stream by.
        session:
          s.session && action.event.type === "run_started"
            ? {
                ...s.session,
                claude_session_id:
                  action.event.payload.claude_session_id || s.session.claude_session_id,
              }
            : s.session,
      }));

    case "RUN_FINISHED":
      return updateSlot(state, action.workspaceId, (s) => ({
        ...s,
        streaming: false,
        activeRunId: null,
        error: action.error ?? s.error,
      }));

    case "ERROR_SET":
      return updateSlot(state, action.workspaceId, (s) => ({
        ...s,
        error: action.error,
      }));

    default: {
      const _exhaustive: never = action;
      void _exhaustive;
      return state;
    }
  }
}

function updateSlot(
  state: AppState,
  workspaceId: string,
  fn: (slot: WorkspaceState) => WorkspaceState,
): AppState {
  const slot = state.byId[workspaceId];
  if (!slot) return state;
  return { ...state, byId: { ...state.byId, [workspaceId]: fn(slot) } };
}

/**
 * Reduce a `RunEvent` into an updated message list. Pulled out of the reducer
 * because it's the only event-routing logic and benefits from being unit
 * tested in isolation.
 */
export function applyEvent(messages: Message[], event: RunEvent): Message[] {
  if (event.type === "text_delta") {
    const messageId = event.payload.message_id || `assistant-${event.sequence}`;
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx === -1) {
      return [
        ...messages,
        { id: messageId, role: "assistant", text: event.payload.text },
      ];
    }
    const next = messages.slice();
    next[idx] = { ...next[idx], text: next[idx].text + event.payload.text };
    return next;
  }
  if (event.type === "tool_call") {
    return [
      ...messages,
      {
        id: `tool-call-${event.payload.tool_use_id}`,
        role: "tool",
        text: `→ ${event.payload.name}(${JSON.stringify(event.payload.input)})`,
      },
    ];
  }
  if (event.type === "tool_result") {
    const text =
      typeof event.payload.content === "string"
        ? event.payload.content
        : JSON.stringify(event.payload.content);
    return [
      ...messages,
      {
        id: `tool-result-${event.payload.tool_use_id}`,
        role: "tool",
        text: `← ${event.payload.is_error ? "[error] " : ""}${text}`,
      },
    ];
  }
  return messages;
}
