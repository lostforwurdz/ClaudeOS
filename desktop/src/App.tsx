import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

import "highlight.js/styles/atom-one-dark.css";

import type {
  Attachment,
  RunEvent,
  RunSummary,
  Session,
  Workspace,
} from "@claudeos/runtime-client/contracts";

import { api } from "./api.js";
import {
  applyEvent,
  appReducer,
  initialAppState,
  type Message,
  type WorkspaceState,
} from "./state.js";

type CloseFn = () => void;

// xh5.1: small typed wrapper around localStorage so settings keys live in one
// place. Persisted across launches; per-machine, not per-user (single-user OS).
const PREF_DEFAULT_WORKSPACE_DIR = "claudeos.pref.defaultWorkspaceDir";

function readPref(key: string): string | null {
  try {
    return typeof window !== "undefined" ? window.localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function writePref(key: string, value: string): void {
  try {
    if (typeof window === "undefined") return;
    if (value.length === 0) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // ignore — private mode, quota, etc.
  }
}

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

  // window.prompt() is disabled in Electron (chromium doesn't ship it), so
  // we drive create/rename through a small in-app modal instead. The handlers
  // open the modal; the modal calls back with the values (or null on cancel).
  const [activePrompt, setActivePrompt] = useState<ActivePrompt | null>(null);

  const handleCreateWorkspace = useCallback(() => {
    const defaultDir = readPref(PREF_DEFAULT_WORKSPACE_DIR) ?? "";
    setActivePrompt({
      title: "Create workspace",
      submitLabel: "Create",
      fields: [
        { name: "name", label: "Name", placeholder: "my-project" },
        {
          name: "dir",
          label: "Directory (absolute path)",
          placeholder: "/home/me/projects/my-project",
          defaultValue: defaultDir,
        },
      ],
      onSubmit: async (values) => {
        setActivePrompt(null);
        const name = values.name?.trim();
        const dir = values.dir?.trim();
        if (!name || !dir) return;
        try {
          const ws = await api.createWorkspace({ name, dir });
          setWorkspaces((prev) => [ws, ...prev]);
          void openWorkspace(ws);
        } catch (e) {
          setGlobalError(String(e));
        }
      },
    });
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
    (workspaceId: string, currentName: string) => {
      setActivePrompt({
        title: "Rename workspace",
        submitLabel: "Rename",
        fields: [
          { name: "name", label: "Name", defaultValue: currentName, placeholder: currentName },
        ],
        onSubmit: async (values) => {
          setActivePrompt(null);
          const next = values.name?.trim();
          if (!next || next === currentName) return;
          try {
            const updated = await api.renameWorkspace(workspaceId, next);
            setWorkspaces((prev) =>
              prev.map((w) => (w.id === workspaceId ? updated : w)),
            );
            dispatch({ type: "WORKSPACE_RENAMED", workspace: updated });
          } catch (e) {
            setGlobalError(`Rename failed: ${String(e)}`);
          }
        },
      });
    },
    [],
  );

  const handleOpenSettings = useCallback(() => {
    setActivePrompt({
      title: "Settings",
      submitLabel: "Save",
      fields: [
        {
          name: "defaultWorkspaceDir",
          label: "Default workspace directory (pre-fills the create-workspace dialog)",
          placeholder: "/home/me/projects",
          defaultValue: readPref(PREF_DEFAULT_WORKSPACE_DIR) ?? "",
        },
      ],
      onSubmit: (values) => {
        setActivePrompt(null);
        writePref(PREF_DEFAULT_WORKSPACE_DIR, (values.defaultWorkspaceDir ?? "").trim());
      },
    });
  }, []);

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

  const handlePermissionDecision = useCallback(
    async (workspaceId: string, decision: "allow" | "deny") => {
      const slot = state.byId[workspaceId];
      const pending = slot?.pendingPermission;
      if (!pending) return;
      try {
        await api.respondToPermission(pending.runId, { decision });
        dispatch({ type: "PERMISSION_RESOLVED", workspaceId });
      } catch (e) {
        dispatch({
          type: "ERROR_SET",
          workspaceId,
          error: `Permission response failed: ${String(e)}`,
        });
      }
    },
    [state.byId],
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

  // xh5.4: global keyboard shortcuts. Registered on window so they fire from
  // anywhere except inside the active prompt modal (which captures Enter
  // for its own submit). Skips matching when the user is typing into an
  // input/textarea other than the chat composer (e.g. the modal fields).
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      // Don't intercept while the prompt/settings modal is open — let it own
      // its own keyboard handling.
      if (activePrompt) return;
      const mod = event.metaKey || event.ctrlKey;
      const target = event.target as HTMLElement | null;
      const isComposer =
        target?.tagName === "TEXTAREA" &&
        target.getAttribute("data-claudeos-composer") === "true";
      const isInput = target instanceof HTMLInputElement;

      // Cmd/Ctrl+Shift+N — new workspace (always)
      if (mod && event.shiftKey && (event.key === "N" || event.key === "n")) {
        event.preventDefault();
        handleCreateWorkspace();
        return;
      }
      // Cmd/Ctrl+L — focus the chat composer (always)
      if (mod && !event.shiftKey && (event.key === "L" || event.key === "l")) {
        const composer = document.querySelector<HTMLTextAreaElement>(
          'textarea[data-claudeos-composer="true"]',
        );
        if (composer) {
          event.preventDefault();
          composer.focus();
        }
        return;
      }
      // Cmd/Ctrl+/ — toggle the shortcuts cheat sheet (always)
      if (mod && event.key === "/") {
        event.preventDefault();
        setShowShortcutsHelp((s) => !s);
        return;
      }
      // Cmd/Ctrl+1..9 — activate the Nth open workspace tab (always)
      if (mod && /^[1-9]$/.test(event.key)) {
        const idx = Number(event.key) - 1;
        const targetId = state.openOrder[idx];
        if (targetId) {
          event.preventDefault();
          activateWorkspace(targetId);
        }
        return;
      }
      // Escape — cancel active run, but only when the user isn't editing
      // text (escape inside an input usually means "blur this field").
      if (event.key === "Escape" && !isComposer && !isInput) {
        if (activeSlot && activeSlot.streaming) {
          event.preventDefault();
          void handleCancel(activeSlot.workspace.id);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    activePrompt,
    activeSlot,
    activateWorkspace,
    handleCancel,
    handleCreateWorkspace,
    state.openOrder,
  ]);
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
        onOpenSettings={handleOpenSettings}
      />
      {activePrompt && (
        <PromptDialog
          prompt={activePrompt}
          onCancel={() => setActivePrompt(null)}
        />
      )}
      {showShortcutsHelp && (
        <ShortcutsCheatsheet onClose={() => setShowShortcutsHelp(false)} />
      )}
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
            onPermissionDecision={(decision) =>
              void handlePermissionDecision(activeSlot.workspace.id, decision)
            }
            onToggleHistory={() =>
              dispatch({ type: "HISTORY_TOGGLED", workspaceId: activeSlot.workspace.id })
            }
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
  onOpenSettings: () => void;
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
  onOpenSettings,
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
        <div style={{ display: "flex", gap: 4 }}>
          <button onClick={onOpenSettings} style={btn} title="Settings">⚙</button>
          <button onClick={onNew} style={btn} title="Create new workspace (Ctrl+Shift+N)">+</button>
        </div>
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
  onPermissionDecision: (decision: "allow" | "deny") => void;
  onToggleHistory: () => void;
}

function ChatView({
  slot,
  onSend,
  onUpload,
  onRemoveAttachment,
  onCancel,
  onPermissionDecision,
  onToggleHistory,
}: ChatViewProps) {
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
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
          {slot.session && !slot.historyMode && (
            <span style={{ opacity: 0.5, fontSize: 11 }}>
              session: {slot.session.id.slice(0, 8)}…
              {slot.session.claude_session_id &&
                ` ↔ ${slot.session.claude_session_id.slice(0, 8)}…`}
            </span>
          )}
          <button
            onClick={onToggleHistory}
            title={slot.historyMode ? "Back to chat" : "Browse past sessions"}
            style={{
              background: slot.historyMode ? "#1f3a4a" : "#1f1f1f",
              color: "#e5e5e5",
              border: `1px solid ${slot.historyMode ? "#3a5a6a" : "#2a2a2a"}`,
              borderRadius: 4,
              padding: "3px 9px",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            {slot.historyMode ? "← Chat" : "History"}
          </button>
        </div>
      </header>

      {slot.historyMode ? (
        <HistoryPanel workspaceId={slot.workspace.id} />
      ) : (
        <>
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

      {slot.pendingPermission && (
        <PermissionPromptModal
          permission={slot.pendingPermission}
          onAllow={() => onPermissionDecision("allow")}
          onDeny={() => onPermissionDecision("deny")}
        />
      )}

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
          data-claudeos-composer="true"
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
            title="Stop the running tool/turn (Esc)"
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
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// HistoryPanel (xh5.2): browse past sessions/runs/events for a workspace.
// Read-only — no resume yet.
// ---------------------------------------------------------------------------

interface HistoryPanelProps {
  workspaceId: string;
}

function HistoryPanel({ workspaceId }: HistoryPanelProps) {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const page = await api.listSessions(workspaceId, { limit: 50 });
        if (!cancelled) setSessions(page.items);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  if (error) {
    return (
      <main style={{ flex: 1, padding: 16, fontSize: 12, color: "#ff8c8c" }}>
        Failed to load history: {error}
      </main>
    );
  }
  if (sessions === null) {
    return (
      <main style={{ flex: 1, padding: 16, fontSize: 12, opacity: 0.5 }}>
        Loading history…
      </main>
    );
  }
  if (sessions.length === 0) {
    return (
      <main style={{ flex: 1, padding: 16, fontSize: 12, opacity: 0.5 }}>
        No past sessions for this workspace yet.
      </main>
    );
  }

  return (
    <main style={{ flex: 1, overflowY: "auto", padding: 16 }}>
      <div style={{ fontSize: 11, opacity: 0.5, marginBottom: 8 }}>
        {sessions.length} past {sessions.length === 1 ? "session" : "sessions"}
      </div>
      {sessions.map((s) => (
        <SessionRow
          key={s.id}
          session={s}
          expanded={expanded === s.id}
          onToggle={() => setExpanded(expanded === s.id ? null : s.id)}
        />
      ))}
    </main>
  );
}

interface SessionRowProps {
  session: Session;
  expanded: boolean;
  onToggle: () => void;
}

function SessionRow({ session, expanded, onToggle }: SessionRowProps) {
  return (
    <div
      style={{
        border: "1px solid #1e1e1e",
        borderRadius: 4,
        marginBottom: 8,
        overflow: "hidden",
      }}
    >
      <div
        onClick={onToggle}
        style={{
          padding: "8px 12px",
          cursor: "pointer",
          background: expanded ? "rgba(255,255,255,0.04)" : "transparent",
          display: "flex",
          alignItems: "center",
          gap: 12,
          fontSize: 12,
        }}
      >
        <span style={{ opacity: 0.6, fontFamily: "monospace" }}>
          {session.id.slice(0, 8)}
        </span>
        <span style={{ opacity: 0.7 }}>{formatTimestamp(session.created_at)}</span>
        {session.claude_session_id && (
          <span style={{ opacity: 0.4, fontSize: 11, fontFamily: "monospace" }}>
            ↔ {session.claude_session_id.slice(0, 8)}
          </span>
        )}
        <span style={{ marginLeft: "auto", opacity: 0.4, fontSize: 10 }}>
          {expanded ? "▲" : "▼"}
        </span>
      </div>
      {expanded && <SessionRuns sessionId={session.id} />}
    </div>
  );
}

function SessionRuns({ sessionId }: { sessionId: string }) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const page = await api.listRunsForSession(sessionId, { limit: 50 });
        if (!cancelled) setRuns(page.items);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (error) {
    return <div style={{ padding: 12, fontSize: 11, color: "#ff8c8c" }}>{error}</div>;
  }
  if (runs === null) {
    return <div style={{ padding: 12, fontSize: 11, opacity: 0.5 }}>Loading runs…</div>;
  }
  if (runs.length === 0) {
    return <div style={{ padding: 12, fontSize: 11, opacity: 0.5 }}>No runs.</div>;
  }
  return (
    <div style={{ borderTop: "1px solid #1e1e1e" }}>
      {runs.map((r) => (
        <RunRow
          key={r.id}
          run={r}
          expanded={expandedRun === r.id}
          onToggle={() => setExpandedRun(expandedRun === r.id ? null : r.id)}
        />
      ))}
    </div>
  );
}

function RunRow({
  run,
  expanded,
  onToggle,
}: {
  run: RunSummary;
  expanded: boolean;
  onToggle: () => void;
}) {
  const statusColor =
    run.status === "completed"
      ? "#5fdcb6"
      : run.status === "failed"
        ? "#ff8c8c"
        : run.status === "cancelled"
          ? "#c8a85f"
          : "#7ec8e8";
  return (
    <div style={{ borderBottom: "1px solid #161616" }}>
      <div
        onClick={onToggle}
        style={{
          padding: "6px 14px 6px 28px",
          cursor: "pointer",
          background: expanded ? "rgba(255,255,255,0.03)" : "transparent",
          display: "flex",
          alignItems: "center",
          gap: 10,
          fontSize: 11,
        }}
      >
        <span style={{ color: statusColor, fontFamily: "monospace" }}>
          {run.status}
        </span>
        <span style={{ opacity: 0.6 }}>{formatTimestamp(run.started_at)}</span>
        <span style={{ opacity: 0.4, fontFamily: "monospace" }}>
          {run.id.slice(0, 8)}
        </span>
        <span style={{ marginLeft: "auto", opacity: 0.4, fontSize: 10 }}>
          {expanded ? "▲" : "▼"}
        </span>
      </div>
      {expanded && <RunEventsView runId={run.id} />}
    </div>
  );
}

function RunEventsView({ runId }: { runId: string }) {
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const events = await api.listRunEvents(runId);
        if (cancelled) return;
        // Replay the persisted events through the same reducer the live chat
        // uses so deltas merge into a single assistant message and tool
        // call/result pairs render as the same collapsible blocks.
        let msgs: Message[] = [];
        for (const ev of events as RunEvent[]) {
          msgs = applyEvent(msgs, ev);
        }
        setMessages(msgs);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId]);

  if (error) {
    return <div style={{ padding: 12, fontSize: 11, color: "#ff8c8c" }}>{error}</div>;
  }
  if (messages === null) {
    return <div style={{ padding: 12, fontSize: 11, opacity: 0.5 }}>Loading…</div>;
  }
  if (messages.length === 0) {
    return (
      <div style={{ padding: 12, fontSize: 11, opacity: 0.5 }}>No events recorded.</div>
    );
  }
  return (
    <div style={{ padding: "8px 28px 14px", background: "rgba(0,0,0,0.2)" }}>
      {messages.map((m) => (
        <MessageView key={m.id} message={m} />
      ))}
    </div>
  );
}

// xh5.4: shortcuts cheat sheet shown via Cmd/Ctrl+/. Lightweight modal — no
// portal, no ReactDOM.createPortal, just an absolute-positioned overlay.
function ShortcutsCheatsheet({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const rows: Array<[string, string]> = [
    ["Ctrl+Shift+N", "New workspace"],
    ["Ctrl+L", "Focus the chat composer"],
    ["Ctrl+1 … Ctrl+9", "Switch to the Nth open workspace"],
    ["Enter (in composer)", "Send message"],
    ["Shift+Enter (in composer)", "Newline"],
    ["Escape", "Cancel the running turn"],
    ["Ctrl+/", "Toggle this cheat sheet"],
  ];
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#141414",
          border: "1px solid #2a2a2a",
          borderRadius: 6,
          padding: 18,
          width: 380,
          fontSize: 12,
          lineHeight: 1.6,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
          Keyboard shortcuts
        </div>
        {rows.map(([keys, label]) => (
          <div
            key={keys}
            style={{ display: "flex", justifyContent: "space-between", gap: 16 }}
          >
            <code
              style={{
                color: "#7ec8e8",
                fontFamily: "JetBrains Mono, Menlo, Consolas, monospace",
              }}
            >
              {keys}
            </code>
            <span style={{ opacity: 0.7 }}>{label}</span>
          </div>
        ))}
        <div style={{ marginTop: 14, opacity: 0.4, fontSize: 11 }}>
          Click outside or press Escape to dismiss.
        </div>
      </div>
    </div>
  );
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
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

interface PermissionPromptModalProps {
  permission: NonNullable<WorkspaceState["pendingPermission"]>;
  onAllow: () => void;
  onDeny: () => void;
}

function PermissionPromptModal({ permission, onAllow, onDeny }: PermissionPromptModalProps) {
  const inputJson = (() => {
    try {
      return JSON.stringify(permission.input, null, 2);
    } catch {
      return String(permission.input);
    }
  })();
  return (
    <div
      style={{
        borderTop: "1px solid #5a4810",
        background: "#1a1605",
        padding: "12px 16px",
      }}
    >
      <div
        style={{
          fontSize: 11,
          letterSpacing: 0.4,
          textTransform: "uppercase",
          color: "#e0c167",
          marginBottom: 6,
        }}
      >
        Claude wants to use a tool
      </div>
      <div style={{ fontSize: 13, marginBottom: 8 }}>
        <strong style={{ color: "#e0c167" }}>{permission.toolName}</strong>
      </div>
      <pre
        style={{
          background: "#0e0e0e",
          border: "1px solid #2a2a2a",
          borderRadius: 4,
          padding: "8px 10px",
          margin: 0,
          fontSize: 11,
          fontFamily: "JetBrains Mono, Menlo, Consolas, monospace",
          maxHeight: 160,
          overflowY: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {inputJson}
      </pre>
      {permission.reason && (
        <div style={{ marginTop: 6, fontSize: 11, color: "#b0b0b0" }}>
          {permission.reason}
        </div>
      )}
      <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
        <button
          onClick={onAllow}
          style={{
            ...btn,
            padding: "6px 14px",
            background: "#1a3a2a",
            borderColor: "#2d6444",
            color: "#5fdcb6",
          }}
        >
          Allow
        </button>
        <button
          onClick={onDeny}
          style={{
            ...btn,
            padding: "6px 14px",
            background: "#3a1010",
            borderColor: "#5a2a2a",
            color: "#ff8c8c",
          }}
        >
          Deny
        </button>
      </div>
    </div>
  );
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
  if (message.role === "tool" && message.toolDir) {
    return <ToolMessageBody message={message} />;
  }
  if (message.role !== "assistant") {
    return (
      <div style={{ whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.5 }}>
        {message.text || "…"}
      </div>
    );
  }
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

function ToolMessageBody({ message }: { message: Message }) {
  const [open, setOpen] = useState(false);
  const isCall = message.toolDir === "call";
  const isError = message.toolIsError;

  const bodyData = isCall ? message.toolInput : message.toolContent;
  const bodyJson =
    bodyData === undefined || bodyData === null
      ? null
      : typeof bodyData === "string"
        ? bodyData
        : JSON.stringify(bodyData, null, 2);

  const borderColor = isError ? "#5a2020" : isCall ? "#1e3a4a" : "#1a3a2a";
  const accentColor = isError ? "#ff8c8c" : isCall ? "#7ec8e8" : "#5fdcb6";
  const arrow = isCall ? "→" : "←";

  return (
    <div
      style={{
        border: `1px solid ${borderColor}`,
        borderRadius: 4,
        fontSize: 12,
        lineHeight: 1.4,
        overflow: "hidden",
      }}
    >
      <div
        onClick={() => bodyJson && setOpen((o) => !o)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 9px",
          cursor: bodyJson ? "pointer" : "default",
          userSelect: "none",
          background: "rgba(255,255,255,0.03)",
        }}
      >
        <span style={{ color: accentColor, fontFamily: "monospace" }}>{arrow}</span>
        <span style={{ color: accentColor, fontFamily: "monospace", fontWeight: 600 }}>
          {message.toolName ?? (isCall ? "tool_call" : "tool_result")}
        </span>
        {isError && (
          <span
            style={{
              background: "#5a2020",
              color: "#ff8c8c",
              fontSize: 10,
              padding: "1px 5px",
              borderRadius: 3,
              marginLeft: 2,
            }}
          >
            error
          </span>
        )}
        {bodyJson && (
          <span style={{ marginLeft: "auto", opacity: 0.4, fontSize: 10 }}>
            {open ? "▲" : "▼"}
          </span>
        )}
      </div>
      {open && bodyJson && (
        <div className="md-body" style={{ borderTop: `1px solid ${borderColor}` }}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
          >
            {"```json\n" + bodyJson + "\n```"}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}

interface PromptField {
  name: string;
  label: string;
  placeholder?: string;
  defaultValue?: string;
}

interface ActivePrompt {
  title: string;
  submitLabel: string;
  fields: PromptField[];
  onSubmit: (values: Record<string, string>) => void;
}

function PromptDialog({
  prompt,
  onCancel,
}: {
  prompt: ActivePrompt;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(prompt.fields.map((f) => [f.name, f.defaultValue ?? ""])),
  );
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    firstFieldRef.current?.focus();
    firstFieldRef.current?.select();
  }, []);

  const submit = () => prompt.onSubmit(values);

  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#0e0e0e",
          border: "1px solid #2a2a2a",
          borderRadius: 6,
          padding: 20,
          width: 440,
          maxWidth: "90vw",
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>{prompt.title}</div>
        {prompt.fields.map((field, i) => (
          <div key={field.name} style={{ marginBottom: 10 }}>
            <label
              style={{
                display: "block",
                fontSize: 11,
                opacity: 0.7,
                marginBottom: 4,
                letterSpacing: 0.2,
              }}
            >
              {field.label}
            </label>
            <input
              ref={i === 0 ? firstFieldRef : null}
              value={values[field.name] ?? ""}
              onChange={(e) =>
                setValues((prev) => ({ ...prev, [field.name]: e.target.value }))
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
                if (e.key === "Escape") onCancel();
              }}
              placeholder={field.placeholder}
              style={{
                width: "100%",
                background: "#161616",
                color: "#e5e5e5",
                border: "1px solid #2a2a2a",
                borderRadius: 4,
                padding: "8px 10px",
                fontSize: 13,
                fontFamily: "inherit",
                boxSizing: "border-box",
              }}
            />
          </div>
        ))}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
          <button onClick={onCancel} style={{ ...btn, padding: "6px 14px" }}>
            Cancel
          </button>
          <button
            onClick={submit}
            style={{
              ...btn,
              padding: "6px 14px",
              background: "#1a3a2a",
              borderColor: "#2d6444",
              color: "#5fdcb6",
            }}
          >
            {prompt.submitLabel}
          </button>
        </div>
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
