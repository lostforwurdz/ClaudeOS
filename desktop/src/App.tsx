import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import type { Workspace } from "@claudeos/runtime-client/contracts";

import { api } from "./api.js";
import {
  appReducer,
  initialAppState,
  type Message,
  type WorkspaceState,
} from "./state.js";

type CloseFn = () => void;

export function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [state, dispatch] = useReducer(appReducer, initialAppState);

  // Per-workspace WebSocket close handles. Held in a ref so closing them
  // doesn't trigger React re-renders.
  const streamCloses = useRef<Map<string, CloseFn>>(new Map());

  // Bootstrap workspace list.
  useEffect(() => {
    api
      .listWorkspaces()
      .then(setWorkspaces)
      .catch((e) => setGlobalError(String(e)));
  }, []);

  // Tear down any open streams on unmount.
  useEffect(() => {
    return () => {
      for (const close of streamCloses.current.values()) close();
      streamCloses.current.clear();
    };
  }, []);

  const openWorkspace = useCallback(async (ws: Workspace) => {
    dispatch({ type: "WORKSPACE_OPENED", workspace: ws });
    try {
      const session = await api.createSession({ workspace_id: ws.id });
      dispatch({ type: "SESSION_BOUND", workspaceId: ws.id, session });
    } catch (e) {
      dispatch({ type: "ERROR_SET", workspaceId: ws.id, error: String(e) });
    }
  }, []);

  const activateWorkspace = useCallback((id: string) => {
    dispatch({ type: "WORKSPACE_ACTIVATED", workspaceId: id });
  }, []);

  const closeWorkspaceTab = useCallback((id: string) => {
    const close = streamCloses.current.get(id);
    if (close) {
      close();
      streamCloses.current.delete(id);
    }
    dispatch({ type: "WORKSPACE_CLOSED", workspaceId: id });
  }, []);

  const handleCreateWorkspace = useCallback(async () => {
    const name = window.prompt("Workspace name?");
    if (!name) return;
    const dir = window.prompt("Workspace directory (absolute path)?");
    if (!dir) return;
    try {
      const ws = await api.createWorkspace({ name, dir });
      setWorkspaces((prev) => [ws, ...prev]);
      void openWorkspace(ws);
    } catch (e) {
      setGlobalError(String(e));
    }
  }, [openWorkspace]);

  const handleSend = useCallback(
    async (workspaceId: string, text: string) => {
      const slot = state.byId[workspaceId];
      if (!slot || !slot.session) return;
      const trimmed = text.trim();
      if (!trimmed) return;

      const inputId = `in-${Date.now()}`;
      const userMessage: Message = {
        id: `user-${inputId}`,
        role: "user",
        text: trimmed,
      };

      try {
        const submitted = await api.submitRun({
          workspace_id: workspaceId,
          session_id: slot.session.id,
          input_id: inputId,
          instruction: trimmed,
        });
        dispatch({
          type: "USER_SENT",
          workspaceId,
          message: userMessage,
          runId: submitted.run_id,
        });

        const close = api.streamRun(submitted.run_id, (event) => {
          dispatch({ type: "RUN_EVENT", workspaceId, event });
          if (event.type === "run_completed" || event.type === "run_failed") {
            dispatch({
              type: "RUN_FINISHED",
              workspaceId,
              error: event.type === "run_failed" ? event.payload.error : null,
            });
            const c = streamCloses.current.get(workspaceId);
            if (c) {
              c();
              streamCloses.current.delete(workspaceId);
            }
          }
        });
        streamCloses.current.set(workspaceId, close);
      } catch (e) {
        dispatch({ type: "ERROR_SET", workspaceId, error: String(e) });
      }
    },
    [state.byId],
  );

  const activeSlot = state.activeId ? state.byId[state.activeId] : null;
  const openWorkspaces = state.openOrder.map((id) => state.byId[id]);

  return (
    <div style={{ display: "flex", height: "100vh", color: "#e5e5e5", background: "#0e0e0e" }}>
      <Sidebar
        all={workspaces}
        open={openWorkspaces}
        activeId={state.activeId}
        onSelect={(ws) => {
          if (state.byId[ws.id]) activateWorkspace(ws.id);
          else void openWorkspace(ws);
        }}
        onClose={closeWorkspaceTab}
        onNew={handleCreateWorkspace}
      />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {globalError && (
          <div style={{ background: "#3a1010", color: "#ff8c8c", padding: "6px 12px", fontSize: 12 }}>
            {globalError}
          </div>
        )}
        {activeSlot ? (
          <ChatView slot={activeSlot} onSend={(text) => void handleSend(activeSlot.workspace.id, text)} />
        ) : (
          <Empty hasWorkspaces={workspaces.length > 0} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

interface SidebarProps {
  all: Workspace[];
  open: WorkspaceState[];
  activeId: string | null;
  onSelect: (ws: Workspace) => void;
  onClose: (workspaceId: string) => void;
  onNew: () => void;
}

function Sidebar({ all, open, activeId, onSelect, onClose, onNew }: SidebarProps) {
  const openIds = new Set(open.map((s) => s.workspace.id));
  return (
    <aside
      style={{
        width: 240,
        borderRight: "1px solid #1e1e1e",
        background: "#0a0a0a",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          padding: "10px 14px",
          borderBottom: "1px solid #1e1e1e",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <strong style={{ fontSize: 13, letterSpacing: -0.2 }}>ClaudeOS</strong>
        <button onClick={onNew} style={btn} title="Create new workspace">+</button>
      </div>

      {open.length > 0 && (
        <div style={{ padding: "8px 0", borderBottom: "1px solid #1e1e1e" }}>
          <SectionLabel>Open</SectionLabel>
          {open.map((slot) => (
            <SidebarRow
              key={slot.workspace.id}
              workspace={slot.workspace}
              status={slot.streaming ? "streaming" : slot.error ? "error" : "idle"}
              active={activeId === slot.workspace.id}
              onSelect={() => onSelect(slot.workspace)}
              onClose={() => onClose(slot.workspace.id)}
            />
          ))}
        </div>
      )}

      <div style={{ padding: "8px 0", overflowY: "auto", flex: 1 }}>
        <SectionLabel>All workspaces</SectionLabel>
        {all.length === 0 && (
          <div style={{ padding: "4px 14px", fontSize: 11, opacity: 0.4 }}>
            No workspaces yet.
          </div>
        )}
        {all.map((ws) => (
          <SidebarRow
            key={ws.id}
            workspace={ws}
            status={openIds.has(ws.id) ? "open" : "closed"}
            active={activeId === ws.id}
            onSelect={() => onSelect(ws)}
          />
        ))}
      </div>
    </aside>
  );
}

interface SidebarRowProps {
  workspace: Workspace;
  status: "streaming" | "error" | "idle" | "open" | "closed";
  active: boolean;
  onSelect: () => void;
  onClose?: () => void;
}

function SidebarRow({ workspace, status, active, onSelect, onClose }: SidebarRowProps) {
  const dotColor = {
    streaming: "#5fdcb6",
    error: "#ff6464",
    idle: "#777",
    open: "#444",
    closed: "transparent",
  }[status];
  return (
    <div
      onClick={onSelect}
      style={{
        padding: "6px 14px",
        display: "flex",
        alignItems: "center",
        gap: 8,
        cursor: "pointer",
        background: active ? "#1a1a1a" : "transparent",
        fontSize: 12,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 3,
          background: dotColor,
          flexShrink: 0,
        }}
      />
      <span
        style={{
          flex: 1,
          overflow: "hidden",
          whiteSpace: "nowrap",
          textOverflow: "ellipsis",
          opacity: status === "closed" ? 0.55 : 1,
        }}
        title={workspace.dir}
      >
        {workspace.name}
      </span>
      {onClose && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          style={{ ...miniBtn, opacity: 0.5 }}
          title="Close tab"
        >
          ×
        </button>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "0 14px 4px",
        fontSize: 9,
        letterSpacing: 0.6,
        textTransform: "uppercase",
        opacity: 0.4,
      }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChatView (one per active workspace)
// ---------------------------------------------------------------------------

interface ChatViewProps {
  slot: WorkspaceState;
  onSend: (text: string) => void;
}

function ChatView({ slot, onSend }: ChatViewProps) {
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [slot.messages.length]);

  const submit = () => {
    if (!input.trim() || slot.streaming) return;
    onSend(input);
    setInput("");
  };

  return (
    <>
      <header
        style={{
          padding: "10px 16px",
          borderBottom: "1px solid #1e1e1e",
          display: "flex",
          gap: 12,
          alignItems: "center",
          fontSize: 12,
        }}
      >
        <strong style={{ fontSize: 13 }}>{slot.workspace.name}</strong>
        <span style={{ opacity: 0.4 }}>{slot.workspace.dir}</span>
        {slot.session && (
          <span style={{ marginLeft: "auto", opacity: 0.5, fontSize: 11 }}>
            session: {slot.session.id.slice(0, 8)}…
            {slot.session.claude_session_id &&
              ` ↔ ${slot.session.claude_session_id.slice(0, 8)}…`}
          </span>
        )}
      </header>

      <main style={{ flex: 1, overflowY: "auto", padding: 16 }}>
        {slot.messages.length === 0 && (
          <div style={{ opacity: 0.4, fontSize: 12 }}>
            {slot.session ? "Type a message below." : "Connecting session…"}
          </div>
        )}
        {slot.messages.map((m) => (
          <MessageView key={m.id} message={m} />
        ))}
        {slot.error && (
          <div style={{ color: "#ff6464", fontSize: 12, marginTop: 8 }}>
            error: {slot.error}
          </div>
        )}
        <div ref={messagesEndRef} />
      </main>

      <footer
        style={{
          borderTop: "1px solid #1e1e1e",
          padding: 12,
          display: "flex",
          gap: 8,
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={slot.session ? "Message Claude…" : "Waiting for session…"}
          disabled={!slot.session || slot.streaming}
          style={{
            flex: 1,
            minHeight: 40,
            maxHeight: 200,
            background: "#161616",
            color: "#e5e5e5",
            border: "1px solid #2a2a2a",
            borderRadius: 4,
            padding: 8,
            fontSize: 13,
            fontFamily: "inherit",
            resize: "vertical",
          }}
        />
        <button
          onClick={submit}
          disabled={!slot.session || !input.trim() || slot.streaming}
          style={{ ...btn, padding: "8px 16px" }}
        >
          {slot.streaming ? "…" : "Send"}
        </button>
      </footer>
    </>
  );
}

function MessageView({ message }: { message: Message }) {
  const color =
    message.role === "user" ? "#9bc1ff" : message.role === "tool" ? "#c9a657" : "#e5e5e5";
  return (
    <div style={{ marginBottom: 14 }}>
      <div
        style={{
          fontSize: 10,
          opacity: 0.5,
          color,
          textTransform: "uppercase",
          letterSpacing: 0.4,
        }}
      >
        {message.role}
      </div>
      <div style={{ whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.5 }}>
        {message.text || "…"}
      </div>
    </div>
  );
}

function Empty({ hasWorkspaces }: { hasWorkspaces: boolean }) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        opacity: 0.45,
        fontSize: 13,
      }}
    >
      {hasWorkspaces
        ? "Select a workspace from the sidebar to open it."
        : "Create a workspace from the sidebar to begin."}
    </div>
  );
}

const btn: React.CSSProperties = {
  background: "#1f1f1f",
  color: "#e5e5e5",
  border: "1px solid #2a2a2a",
  borderRadius: 4,
  padding: "4px 10px",
  fontSize: 12,
  cursor: "pointer",
};

const miniBtn: React.CSSProperties = {
  background: "transparent",
  color: "#e5e5e5",
  border: "none",
  padding: "0 4px",
  fontSize: 14,
  lineHeight: 1,
  cursor: "pointer",
};
