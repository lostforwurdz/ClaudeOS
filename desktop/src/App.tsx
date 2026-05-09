import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

import "highlight.js/styles/atom-one-dark.css";

import type { Attachment, Workspace } from "@claudeos/runtime-client/contracts";

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

      const attachments = slot.pendingAttachments;

      try {
        const submitted = await api.submitRun({
          workspace_id: workspaceId,
          session_id: slot.session.id,
          input_id: inputId,
          instruction: trimmed,
          ...(attachments.length > 0 ? { attachments } : {}),
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

  const handleUpload = useCallback(
    async (workspaceId: string, files: File[]) => {
      for (const file of files) {
        try {
          const attachment = await api.uploadFile(workspaceId, file);
          dispatch({ type: "ATTACHMENT_ADDED", workspaceId, attachment });
        } catch (e) {
          dispatch({
            type: "ERROR_SET",
            workspaceId,
            error: `Upload failed (${file.name}): ${String(e)}`,
          });
        }
      }
    },
    [],
  );

  const handleRemoveAttachment = useCallback(
    (workspaceId: string, workspacePath: string) => {
      dispatch({ type: "ATTACHMENT_REMOVED", workspaceId, workspacePath });
    },
    [],
  );

  const handleRenameWorkspace = useCallback(
    async (workspaceId: string, currentName: string) => {
      const next = window.prompt("Rename workspace", currentName);
      if (!next || next.trim() === currentName) return;
      try {
        const updated = await api.renameWorkspace(workspaceId, next.trim());
        setWorkspaces((prev) =>
          prev.map((w) => (w.id === workspaceId ? updated : w)),
        );
        dispatch({ type: "WORKSPACE_RENAMED", workspace: updated });
      } catch (e) {
        setGlobalError(`Rename failed: ${String(e)}`);
      }
    },
    [],
  );

  const handleDeleteWorkspace = useCallback(
    async (workspaceId: string, name: string) => {
      const ok = window.confirm(
        `Delete workspace "${name}"? This drops its sessions and run history. The directory on disk is NOT touched.`,
      );
      if (!ok) return;
      try {
        await api.deleteWorkspace(workspaceId);
        // Tear down any open WS for this workspace before clearing state.
        const close = streamCloses.current.get(workspaceId);
        if (close) {
          close();
          streamCloses.current.delete(workspaceId);
        }
        setWorkspaces((prev) => prev.filter((w) => w.id !== workspaceId));
        dispatch({ type: "WORKSPACE_DELETED", workspaceId });
      } catch (e) {
        setGlobalError(`Delete failed: ${String(e)}`);
      }
    },
    [],
  );

  const handleCancel = useCallback(
    async (workspaceId: string) => {
      const slot = state.byId[workspaceId];
      const runId = slot?.activeRunId;
      if (!runId) return;
      try {
        await api.cancelRun(runId);
        // The harness emits run_failed on abort which the stream listener
        // already routes through RUN_FINISHED — no need to dispatch here.
      } catch (e) {
        dispatch({
          type: "ERROR_SET",
          workspaceId,
          error: `Cancel failed: ${String(e)}`,
        });
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
        onRename={(ws) => void handleRenameWorkspace(ws.id, ws.name)}
        onDelete={(ws) => void handleDeleteWorkspace(ws.id, ws.name)}
      />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {globalError && (
          <div style={{ background: "#3a1010", color: "#ff8c8c", padding: "6px 12px", fontSize: 12 }}>
            {globalError}
          </div>
        )}
        {activeSlot ? (
          <ChatView
            slot={activeSlot}
            onSend={(text) => void handleSend(activeSlot.workspace.id, text)}
            onUpload={(files) => void handleUpload(activeSlot.workspace.id, files)}
            onRemoveAttachment={(path) =>
              handleRemoveAttachment(activeSlot.workspace.id, path)
            }
            onCancel={() => void handleCancel(activeSlot.workspace.id)}
          />
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
  onRename: (ws: Workspace) => void;
  onDelete: (ws: Workspace) => void;
}

function Sidebar({
  all,
  open,
  activeId,
  onSelect,
  onClose,
  onNew,
  onRename,
  onDelete,
}: SidebarProps) {
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
              onRename={() => onRename(slot.workspace)}
              onDelete={() => onDelete(slot.workspace)}
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
            onRename={() => onRename(ws)}
            onDelete={() => onDelete(ws)}
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
  onRename: () => void;
  onDelete: () => void;
}

function SidebarRow({
  workspace,
  status,
  active,
  onSelect,
  onClose,
  onRename,
  onDelete,
}: SidebarRowProps) {
  const [hovered, setHovered] = useState(false);
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
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: "6px 14px",
        display: "flex",
        alignItems: "center",
        gap: 6,
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
      {hovered && (
        <>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRename();
            }}
            style={{ ...miniBtn, opacity: 0.5, fontSize: 12 }}
            title="Rename workspace"
          >
            ✎
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            style={{ ...miniBtn, opacity: 0.5, fontSize: 12, color: "#ff8c8c" }}
            title="Delete workspace (cascades sessions + runs)"
          >
            🗑
          </button>
        </>
      )}
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
  onUpload: (files: File[]) => void;
  onRemoveAttachment: (workspacePath: string) => void;
  onCancel: () => void;
}

function ChatView({ slot, onSend, onUpload, onRemoveAttachment, onCancel }: ChatViewProps) {
  const [input, setInput] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [slot.messages.length]);

  const submit = () => {
    if (!input.trim() || slot.streaming) return;
    onSend(input);
    setInput("");
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.types.includes("Files")) {
      e.dataTransfer.dropEffect = "copy";
      if (!dragActive) setDragActive(true);
    }
  };
  const handleDragLeave = (e: React.DragEvent) => {
    // Only clear when the cursor actually leaves the drop target — DOM
    // dispatches dragleave on every child crossing too.
    if (e.currentTarget === e.target) setDragActive(false);
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length > 0) onUpload(files);
  };

  const handleFilePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) onUpload(files);
    // Allow re-picking the same file later.
    e.target.value = "";
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

      <main
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 16,
          position: "relative",
          outline: dragActive ? "2px dashed #5fdcb6" : "none",
          outlineOffset: -8,
        }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {slot.messages.length === 0 && (
          <div style={{ opacity: 0.4, fontSize: 12 }}>
            {slot.session ? "Type a message below or drop files to attach." : "Connecting session…"}
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
        {dragActive && (
          <div
            style={{
              position: "absolute",
              inset: 16,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(20, 40, 32, 0.6)",
              color: "#5fdcb6",
              fontSize: 13,
              pointerEvents: "none",
              borderRadius: 4,
            }}
          >
            Drop to attach to next message
          </div>
        )}
      </main>

      {slot.pendingAttachments.length > 0 && (
        <AttachmentStrip
          attachments={slot.pendingAttachments}
          onRemove={onRemoveAttachment}
        />
      )}

      <footer
        style={{
          borderTop: "1px solid #1e1e1e",
          padding: 12,
          display: "flex",
          gap: 8,
          alignItems: "flex-start",
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFilePicked}
          style={{ display: "none" }}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={!slot.session}
          title="Attach files"
          style={{ ...btn, padding: "8px 10px" }}
        >
          📎
        </button>
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
        {slot.streaming ? (
          <button
            onClick={onCancel}
            style={{ ...btn, padding: "8px 16px", borderColor: "#5a2a2a", color: "#ff8c8c" }}
            title="Stop the running tool/turn"
          >
            Cancel
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={!slot.session || !input.trim()}
            style={{ ...btn, padding: "8px 16px" }}
          >
            Send
          </button>
        )}
      </footer>
      {slot.lastTurnStats && !slot.streaming && (
        <TurnStatsBar stats={slot.lastTurnStats} />
      )}
    </>
  );
}

function TurnStatsBar({ stats }: { stats: NonNullable<WorkspaceState["lastTurnStats"]> }) {
  const { usage, duration_ms, num_turns, cost_usd } = stats;
  const parts = [
    `${formatNum(usage.input_tokens)} in`,
    `${formatNum(usage.output_tokens)} out`,
    usage.cache_read_input_tokens > 0
      ? `${formatNum(usage.cache_read_input_tokens)} cache`
      : null,
    `$${cost_usd.toFixed(4)}`,
    `${(duration_ms / 1000).toFixed(1)}s`,
    num_turns > 1 ? `${num_turns} turns` : null,
  ].filter(Boolean);
  return (
    <div
      style={{
        borderTop: "1px solid #1e1e1e",
        padding: "4px 16px",
        fontSize: 10,
        color: "#777",
        fontFamily: "JetBrains Mono, Menlo, Consolas, monospace",
        letterSpacing: 0.2,
        background: "#0a0a0a",
      }}
      title="Last completed turn"
    >
      {parts.join(" · ")}
    </div>
  );
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

interface AttachmentStripProps {
  attachments: Attachment[];
  onRemove: (workspacePath: string) => void;
}

function AttachmentStrip({ attachments, onRemove }: AttachmentStripProps) {
  return (
    <div
      style={{
        borderTop: "1px solid #1e1e1e",
        padding: "8px 12px",
        display: "flex",
        flexWrap: "wrap",
        gap: 8,
        background: "#0a0a0a",
      }}
    >
      {attachments.map((a) => (
        <AttachmentChip key={a.workspace_path} attachment={a} onRemove={onRemove} />
      ))}
    </div>
  );
}

function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: Attachment;
  onRemove: (workspacePath: string) => void;
}) {
  const filename = attachment.workspace_path.split("/").pop() ?? attachment.workspace_path;
  // Strip the UUID-<rest> prefix for display so chips read like the original
  // filename instead of <uuid>-foo.png.
  const displayName = filename.replace(/^[a-f0-9-]{36}-/, "");
  const isImage = attachment.kind === "image";
  return (
    <div
      title={attachment.workspace_path}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 6px 4px 8px",
        background: "#161616",
        border: "1px solid #2a2a2a",
        borderRadius: 4,
        fontSize: 11,
        maxWidth: 200,
      }}
    >
      <span style={{ opacity: 0.6 }}>{isImage ? "🖼" : "📄"}</span>
      <span
        style={{
          overflow: "hidden",
          whiteSpace: "nowrap",
          textOverflow: "ellipsis",
        }}
      >
        {displayName}
      </span>
      <button
        onClick={() => onRemove(attachment.workspace_path)}
        title="Remove attachment"
        style={{ ...miniBtn, opacity: 0.55 }}
      >
        ×
      </button>
    </div>
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
      <MessageBody message={message} />
    </div>
  );
}

function MessageBody({ message }: { message: Message }) {
  // User and tool messages stay as preformatted text — user input often
  // contains code we don't want auto-formatted, and tool transcripts are
  // already JSON/log lines that look better verbatim.
  if (message.role !== "assistant") {
    return (
      <div style={{ whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.5 }}>
        {message.text || "…"}
      </div>
    );
  }
  // Assistant messages render through markdown so fenced code blocks get
  // syntax-highlighted, lists/headings/links display properly. ReactMarkdown
  // tolerates partial markdown during streaming — the user just sees
  // formatting "snap in" once a delimiter completes.
  return (
    <div className="md-body" style={{ fontSize: 13, lineHeight: 1.55 }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          a: ({ children, href, ...rest }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
              {children}
            </a>
          ),
        }}
      >
        {message.text || "…"}
      </ReactMarkdown>
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
