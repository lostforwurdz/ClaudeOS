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
import { findMode, MODES } from "./modes.js";
import {
  applyEvent,
  appReducer,
  initialAppState,
  type Message,
  type WorkspaceState,
} from "./state.js";

type CloseFn = () => void;

// rec-3: in-flight parallel run tracked at App level. Status starts at
// "running" and is refreshed by the FanOutPanel poll loop. latestText is
// the last assistant text snippet pulled from /runs/:id/events when the
// run completes; running tiles show "—" until then.
interface FanOutRun {
  run_id: string;
  session_id: string;
  worktree_path: string;
  name: string;
  status: "running" | "completed" | "failed" | "cancelled";
  latestText: string;
}

interface FanOutPromptInput {
  name: string;
  instruction: string;
}

// xh5.1: small typed wrapper around localStorage so settings keys live in one
// place. Persisted across launches; per-machine, not per-user (single-user OS).
const PREF_DEFAULT_WORKSPACE_DIR = "claudeos.pref.defaultWorkspaceDir";
const PREF_THEME = "claudeos.pref.theme";
type Theme = "dark" | "light";

function readTheme(): Theme {
  const v = readPref(PREF_THEME);
  return v === "light" ? "light" : "dark";
}

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

      // rec-7: merge the active mode's preset into the run request. Empty
      // strings collapse to absent fields so the api-server's defaults
      // apply when the user is in "default" mode.
      const mode = findMode(slot.modeId);
      try {
        const submitted = await api.submitRun({
          workspace_id: workspaceId,
          session_id: slot.session.id,
          input_id: inputId,
          instruction: trimmed,
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(mode.appendSystemPrompt
            ? { append_system_prompt: mode.appendSystemPrompt }
            : {}),
          ...(mode.permissionMode ? { permission_mode: mode.permissionMode } : {}),
          ...(mode.model ? { model: mode.model } : {}),
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

  const [settingsOpen, setSettingsOpen] = useState(false);
  const handleOpenSettings = useCallback(() => setSettingsOpen(true), []);

  // rec-3 (kobramaz-a17.3): fan-out state. Per-workspace map of in-flight
  // parallel runs so each workspace tab keeps its own batch independent.
  // Tiles poll the api-server for per-run status; no WebSocket multiplex.
  const [fanOutByWorkspace, setFanOutByWorkspace] = useState<
    Record<string, FanOutRun[] | undefined>
  >({});
  const [fanOutPromptOpen, setFanOutPromptOpen] = useState(false);
  const handleOpenFanOut = useCallback(() => setFanOutPromptOpen(true), []);
  const handleDispatchFanOut = useCallback(
    async (workspaceId: string, prompts: FanOutPromptInput[]) => {
      setFanOutPromptOpen(false);
      try {
        const res = await api.dispatchParallelRuns({
          workspace_id: workspaceId,
          prompts: prompts.map((p) => ({ name: p.name, instruction: p.instruction })),
        });
        const runs: FanOutRun[] = res.runs.map((r) => ({
          ...r,
          status: "running",
          latestText: "",
        }));
        setFanOutByWorkspace((prev) => ({ ...prev, [workspaceId]: runs }));
      } catch (e) {
        setGlobalError(`Fan-out failed: ${String(e)}`);
      }
    },
    [],
  );
  const handleClearFanOut = useCallback((workspaceId: string) => {
    setFanOutByWorkspace((prev) => {
      const next = { ...prev };
      delete next[workspaceId];
      return next;
    });
  }, []);

  // rec-6 (kobramaz-a17.6): fork a historical session into a new ClaudeOS
  // session in the active workspace. Tears down the active WS stream
  // before swapping so events from the old run don't bleed into the new
  // chat. Closes history mode as a side effect of SESSION_FORKED.
  const handleForkSession = useCallback(
    async (workspaceId: string, claudeSessionId: string) => {
      try {
        const close = streamCloses.current.get(workspaceId);
        if (close) {
          close();
          streamCloses.current.delete(workspaceId);
        }
        const session = await api.createSession({
          workspace_id: workspaceId,
          fork_from_claude_session_id: claudeSessionId,
        });
        dispatch({ type: "SESSION_FORKED", workspaceId, session });
      } catch (e) {
        dispatch({
          type: "ERROR_SET",
          workspaceId,
          error: `Fork failed: ${String(e)}`,
        });
      }
    },
    [],
  );

  // xh5.1 / kobramaz-c5y: theme is a top-level concern — on mount, restore
  // the saved choice; the SettingsDialog calls setTheme to update both
  // state and document.documentElement.dataset.theme so CSS vars resolve
  // against the right palette.
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.dataset.theme = theme;
    }
  }, [theme]);

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
      if (activePrompt || settingsOpen) return;
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
    settingsOpen,
    activeSlot,
    activateWorkspace,
    handleCancel,
    handleCreateWorkspace,
    state.openOrder,
  ]);
  const openWorkspaces = state.openOrder.map((id) => state.byId[id]);

  return (
    <div style={{ display: "flex", height: "100vh", color: "var(--text)", background: "var(--panel)" }}>
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
      {settingsOpen && (
        <SettingsDialog
          theme={theme}
          onThemeChange={(t) => {
            setTheme(t);
            writePref(PREF_THEME, t);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {fanOutPromptOpen && activeSlot && (
        <FanOutDialog
          workspaceName={activeSlot.workspace.name}
          onCancel={() => setFanOutPromptOpen(false)}
          onSubmit={(prompts) => void handleDispatchFanOut(activeSlot.workspace.id, prompts)}
        />
      )}
      {showShortcutsHelp && (
        <ShortcutsCheatsheet onClose={() => setShowShortcutsHelp(false)} />
      )}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {globalError && (
          <div style={{ background: "var(--errorBg)", color: "var(--errorMuted)", padding: "6px 12px", fontSize: 12 }}>
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
            onForkSession={(claudeSessionId) =>
              void handleForkSession(activeSlot.workspace.id, claudeSessionId)
            }
            onModeChange={(modeId) =>
              dispatch({
                type: "MODE_CHANGED",
                workspaceId: activeSlot.workspace.id,
                modeId,
              })
            }
            onOpenFanOut={handleOpenFanOut}
            fanOut={fanOutByWorkspace[activeSlot.workspace.id]}
            onUpdateFanOut={(runs) =>
              setFanOutByWorkspace((prev) => ({
                ...prev,
                [activeSlot.workspace.id]: runs,
              }))
            }
            onClearFanOut={() => handleClearFanOut(activeSlot.workspace.id)}
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
        borderRight: "1px solid var(--border)",
        background: "var(--bg)",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          padding: "10px 14px",
          borderBottom: "1px solid var(--border)",
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
        <div style={{ padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
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
    streaming: "var(--accent)",
    error: "var(--error)",
    idle: "var(--mute)",
    open: "var(--mute)",
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
        background: active ? "var(--raised)" : "transparent",
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
            style={{ ...miniBtn, opacity: 0.5, fontSize: 12, color: "var(--errorMuted)" }}
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
  onOpenFanOut: () => void;
  fanOut: FanOutRun[] | undefined;
  onUpdateFanOut: (runs: FanOutRun[]) => void;
  onClearFanOut: () => void;
  onForkSession: (claudeSessionId: string) => void;
  onModeChange: (modeId: string) => void;
}

function ChatView({
  slot,
  onSend,
  onUpload,
  onRemoveAttachment,
  onCancel,
  onPermissionDecision,
  onToggleHistory,
  onOpenFanOut,
  fanOut,
  onUpdateFanOut,
  onClearFanOut,
  onForkSession,
  onModeChange,
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
          borderBottom: "1px solid var(--border)",
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
            onClick={onOpenFanOut}
            title="Run several prompts in parallel git worktrees (Fan-out)"
            style={{
              background: "var(--raisedAlt)",
              color: "var(--text)",
              border: "1px solid var(--borderStrong)",
              borderRadius: 4,
              padding: "3px 9px",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            Fan-out
          </button>
          <button
            onClick={onToggleHistory}
            title={slot.historyMode ? "Back to chat" : "Browse past sessions"}
            style={{
              background: slot.historyMode ? "var(--infoBg)" : "var(--raisedAlt)",
              color: "var(--text)",
              border: `1px solid ${slot.historyMode ? "var(--infoBorder)" : "var(--borderStrong)"}`,
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

      {fanOut && fanOut.length > 0 && (
        <FanOutPanel runs={fanOut} onUpdate={onUpdateFanOut} onClear={onClearFanOut} />
      )}
      {slot.historyMode ? (
        <HistoryPanel workspaceId={slot.workspace.id} onFork={onForkSession} />
      ) : (
        <>
      <main
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 16,
          position: "relative",
          outline: dragActive ? "2px dashed var(--accent)" : "none",
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
          <div style={{ color: "var(--error)", fontSize: 12, marginTop: 8 }}>
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
              background: "var(--accentBg)",
              color: "var(--accent)",
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
          borderTop: "1px solid var(--border)",
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
        <select
          value={slot.modeId}
          onChange={(e) => onModeChange(e.target.value)}
          disabled={slot.streaming}
          title={findMode(slot.modeId).description}
          style={{
            background: "var(--raised)",
            color: "var(--text)",
            border: "1px solid var(--borderStrong)",
            borderRadius: 4,
            padding: "8px 6px",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          {MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
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
            background: "var(--raised)",
            color: "var(--text)",
            border: "1px solid var(--borderStrong)",
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
            style={{ ...btn, padding: "8px 16px", borderColor: "var(--errorBorder)", color: "var(--errorMuted)" }}
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
        <TurnStatsBar stats={slot.lastTurnStats} messages={slot.messages} />
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
  /** rec-6: forking opens a fresh session bound to this claude_session_id. */
  onFork: (claudeSessionId: string) => void;
}

function HistoryPanel({ workspaceId, onFork }: HistoryPanelProps) {
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
      <main style={{ flex: 1, padding: 16, fontSize: 12, color: "var(--errorMuted)" }}>
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
          onFork={
            s.claude_session_id ? () => onFork(s.claude_session_id!) : undefined
          }
        />
      ))}
    </main>
  );
}

interface SessionRowProps {
  session: Session;
  expanded: boolean;
  onToggle: () => void;
  /** rec-6: undefined when the session never bound a claude_session_id. */
  onFork?: () => void;
}

function SessionRow({ session, expanded, onToggle, onFork }: SessionRowProps) {
  return (
    <div
      style={{
        border: "1px solid var(--border)",
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
          background: expanded ? "var(--highlightStrong)" : "transparent",
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
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          {onFork && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onFork();
              }}
              title="Fork — open a new session that resumes this conversation"
              style={{
                background: "var(--raisedAlt)",
                color: "var(--text)",
                border: "1px solid var(--borderStrong)",
                borderRadius: 3,
                padding: "1px 7px",
                fontSize: 10,
                cursor: "pointer",
              }}
            >
              Fork
            </button>
          )}
          <span style={{ opacity: 0.4, fontSize: 10 }}>{expanded ? "▲" : "▼"}</span>
        </div>
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
    return <div style={{ padding: 12, fontSize: 11, color: "var(--errorMuted)" }}>{error}</div>;
  }
  if (runs === null) {
    return <div style={{ padding: 12, fontSize: 11, opacity: 0.5 }}>Loading runs…</div>;
  }
  if (runs.length === 0) {
    return <div style={{ padding: 12, fontSize: 11, opacity: 0.5 }}>No runs.</div>;
  }
  return (
    <div style={{ borderTop: "1px solid var(--border)" }}>
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
      ? "var(--accent)"
      : run.status === "failed"
        ? "var(--errorMuted)"
        : run.status === "cancelled"
          ? "var(--warn)"
          : "var(--info)";
  return (
    <div style={{ borderBottom: "1px solid var(--raised)" }}>
      <div
        onClick={onToggle}
        style={{
          padding: "6px 14px 6px 28px",
          cursor: "pointer",
          background: expanded ? "var(--highlight)" : "transparent",
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
    return <div style={{ padding: 12, fontSize: 11, color: "var(--errorMuted)" }}>{error}</div>;
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
    <div style={{ padding: "8px 28px 14px", background: "var(--highlight)" }}>
      {messages.map((m) => (
        <MessageView key={m.id} message={m} />
      ))}
    </div>
  );
}

// rec-3 (kobramaz-a17.3): fan-out dialog. Up to 4 prompts; each becomes a
// parallel run in its own git worktree. Names must be filename-safe so
// they end up in `~/.claudeos/worktrees/<workspace-id>/<name>-<ts>/`.
function FanOutDialog({
  workspaceName,
  onCancel,
  onSubmit,
}: {
  workspaceName: string;
  onCancel: () => void;
  onSubmit: (prompts: FanOutPromptInput[]) => void;
}) {
  const [prompts, setPrompts] = useState<FanOutPromptInput[]>([
    { name: "a", instruction: "" },
    { name: "b", instruction: "" },
  ]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);

  const update = (i: number, patch: Partial<FanOutPromptInput>) =>
    setPrompts((prev) => prev.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  const remove = (i: number) =>
    setPrompts((prev) => prev.filter((_, idx) => idx !== i));
  const add = () =>
    setPrompts((prev) =>
      prev.length >= 4
        ? prev
        : [...prev, { name: String.fromCharCode(97 + prev.length), instruction: "" }],
    );
  const submit = () => {
    const valid = prompts.filter(
      (p) => p.name.trim() && /^[a-zA-Z0-9_-]+$/.test(p.name) && p.instruction.trim(),
    );
    if (valid.length === 0) return;
    onSubmit(valid);
  };

  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--backdrop)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--modalBg)",
          border: "1px solid var(--borderStrong)",
          borderRadius: 6,
          padding: 18,
          width: 540,
          fontSize: 12,
          lineHeight: 1.5,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
          Fan-out — parallel runs in {workspaceName}
        </div>
        <div style={{ opacity: 0.6, fontSize: 11, marginBottom: 12 }}>
          Each prompt runs in its own git worktree off HEAD. Names become
          branch suffixes (a–z, 0–9, dash, underscore).
        </div>
        {prompts.map((p, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              gap: 6,
              marginBottom: 8,
              alignItems: "flex-start",
            }}
          >
            <input
              type="text"
              value={p.name}
              onChange={(e) => update(i, { name: e.target.value })}
              placeholder="name"
              style={{
                width: 70,
                padding: 6,
                background: "var(--raised)",
                color: "var(--text)",
                border: "1px solid var(--borderStrong)",
                borderRadius: 4,
                fontSize: 11,
                fontFamily: "monospace",
              }}
            />
            <textarea
              value={p.instruction}
              onChange={(e) => update(i, { instruction: e.target.value })}
              placeholder="Instruction for this run…"
              rows={2}
              style={{
                flex: 1,
                padding: 6,
                background: "var(--raised)",
                color: "var(--text)",
                border: "1px solid var(--borderStrong)",
                borderRadius: 4,
                fontSize: 12,
                fontFamily: "inherit",
                resize: "vertical",
              }}
            />
            {prompts.length > 1 && (
              <button
                onClick={() => remove(i)}
                title="Remove this prompt"
                style={{
                  ...settingsBtn,
                  padding: "4px 8px",
                  color: "var(--errorMuted)",
                }}
              >
                ×
              </button>
            )}
          </div>
        ))}
        {prompts.length < 4 && (
          <button onClick={add} style={{ ...settingsBtn, marginBottom: 12 }}>
            + Add prompt
          </button>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onCancel} style={settingsBtn}>
            Cancel
          </button>
          <button
            onClick={submit}
            style={{ ...settingsBtn, background: "var(--accentBg)", borderColor: "var(--accent)" }}
          >
            Dispatch
          </button>
        </div>
      </div>
    </div>
  );
}

// rec-3: in-flight fan-out tile panel. Polls each run's status every 3s
// until terminal, then fetches the run's events to extract the final
// assistant text snippet for display. No WebSocket multiplex.
function FanOutPanel({
  runs,
  onUpdate,
  onClear,
}: {
  runs: FanOutRun[];
  onUpdate: (runs: FanOutRun[]) => void;
  onClear: () => void;
}) {
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const next = await Promise.all(
        runs.map(async (r) => {
          if (r.status !== "running") return r;
          try {
            const status = await api.getRun(r.run_id);
            const updated: FanOutRun = { ...r, status: status.status };
            // When a run reaches terminal state, pull the final assistant
            // text once so the tile shows a useful preview.
            if (status.status !== "running" && r.latestText === "") {
              const events = await api.listRunEvents(r.run_id);
              const lastText = [...events]
                .reverse()
                .find((e) => e.type === "text_delta");
              if (lastText && lastText.type === "text_delta") {
                updated.latestText = lastText.payload.text;
              }
            }
            return updated;
          } catch {
            return r;
          }
        }),
      );
      if (cancelled) return;
      // Only push an update when something actually changed to avoid
      // re-render storms when nothing's progressing.
      const changed = next.some(
        (r, i) => r.status !== runs[i].status || r.latestText !== runs[i].latestText,
      );
      if (changed) onUpdate(next);
    };
    void tick();
    const id = setInterval(() => void tick(), 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [runs, onUpdate]);

  const allDone = runs.every((r) => r.status !== "running");

  return (
    <div
      style={{
        borderBottom: "1px solid var(--border)",
        background: "var(--panel)",
        padding: "10px 16px",
        fontSize: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <strong style={{ fontSize: 12 }}>Fan-out</strong>
        <span style={{ opacity: 0.5, fontSize: 11 }}>
          {runs.filter((r) => r.status === "running").length} running ·{" "}
          {runs.filter((r) => r.status === "completed").length} done ·{" "}
          {runs.filter((r) => r.status === "failed" || r.status === "cancelled").length} failed
        </span>
        {allDone && (
          <button
            onClick={onClear}
            style={{ ...settingsBtn, marginLeft: "auto", padding: "3px 9px" }}
          >
            Dismiss
          </button>
        )}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${Math.min(runs.length, 4)}, 1fr)`,
          gap: 8,
        }}
      >
        {runs.map((r) => (
          <div
            key={r.run_id}
            style={{
              border: "1px solid var(--border)",
              borderRadius: 4,
              padding: 8,
              background: "var(--raised)",
            }}
          >
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
              <span
                style={{
                  fontFamily: "monospace",
                  fontSize: 11,
                  fontWeight: 600,
                  color: fanOutStatusColor(r.status),
                }}
              >
                {r.name}
              </span>
              <span style={{ fontSize: 10, opacity: 0.6, marginLeft: "auto" }}>
                {r.status}
              </span>
            </div>
            <div
              style={{
                fontSize: 10,
                opacity: 0.7,
                lineHeight: 1.3,
                maxHeight: 60,
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
              title={r.latestText || "(no output yet)"}
            >
              {r.latestText
                ? r.latestText.slice(0, 200)
                : r.status === "running"
                  ? "(running…)"
                  : "(no output)"}
            </div>
            <div
              style={{
                fontSize: 10,
                opacity: 0.4,
                marginTop: 4,
                fontFamily: "monospace",
                wordBreak: "break-all",
              }}
              title={r.worktree_path}
            >
              {r.worktree_path}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function fanOutStatusColor(status: FanOutRun["status"]): string {
  switch (status) {
    case "completed":
      return "var(--accent)";
    case "failed":
      return "var(--errorMuted)";
    case "cancelled":
      return "var(--warn)";
    default:
      return "var(--info)";
  }
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
        background: "var(--backdrop)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--modalBg)",
          border: "1px solid var(--borderStrong)",
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
                color: "var(--info)",
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

// xh5.1 / kobramaz-46i: Settings dialog. One section per persistable
// preference. Token controls go through window.claudeos.token (preload),
// other prefs go through localStorage helpers above.
function SettingsDialog({
  theme,
  onThemeChange,
  onClose,
}: {
  theme: Theme;
  onThemeChange: (t: Theme) => void;
  onClose: () => void;
}) {
  const [defaultDir, setDefaultDir] = useState(
    () => readPref(PREF_DEFAULT_WORKSPACE_DIR) ?? "",
  );
  const [tokenStatus, setTokenStatus] = useState<{
    present: boolean;
    encrypted: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    if (!window.claudeos) return;
    try {
      const status = await window.claudeos.token.status();
      setTokenStatus(status);
    } catch (e) {
      setNotice(`Could not read token status: ${String(e)}`);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleSave = () => {
    writePref(PREF_DEFAULT_WORKSPACE_DIR, defaultDir.trim());
    onClose();
  };

  const handleForgetToken = async () => {
    if (!window.claudeos) return;
    if (!window.confirm("Forget the saved API token? You'll need to re-run setup before sending any new messages.")) return;
    setBusy(true);
    try {
      await window.claudeos.token.clear();
      setNotice("Token cleared. Restart ClaudeOS or click 'Re-run setup' to provide a new one.");
      await refreshStatus();
    } finally {
      setBusy(false);
    }
  };

  const handleRestartSetup = async () => {
    if (!window.claudeos) return;
    setBusy(true);
    try {
      await window.claudeos.token.restartSetup();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--backdrop)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--modalBg)",
          border: "1px solid var(--borderStrong)",
          borderRadius: 6,
          padding: 18,
          width: 480,
          fontSize: 12,
          lineHeight: 1.5,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 14 }}>
          Settings
        </div>

        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
            API token
          </div>
          {tokenStatus === null ? (
            <div style={{ opacity: 0.5 }}>
              {window.claudeos
                ? "Reading status…"
                : "Token controls are unavailable in this build (no main-window preload)."}
            </div>
          ) : (
            <div style={{ marginBottom: 8 }}>
              <span style={{ color: tokenStatus.present ? "var(--accent)" : "var(--errorMuted)" }}>
                {tokenStatus.present ? "Stored" : "Not set"}
              </span>
              <span style={{ marginLeft: 10, opacity: 0.5, fontSize: 11 }}>
                {tokenStatus.encrypted
                  ? "encrypted via OS keychain"
                  : "plaintext fallback (no OS keychain)"}
              </span>
            </div>
          )}
          {window.claudeos && (
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button
                onClick={() => void handleRestartSetup()}
                disabled={busy}
                style={{ ...settingsBtn, background: "var(--infoBg)", borderColor: "var(--infoBorder)" }}
              >
                Re-run setup
              </button>
              <button
                onClick={() => void handleForgetToken()}
                disabled={busy || !tokenStatus?.present}
                style={{ ...settingsBtn, color: "var(--errorMuted)", borderColor: "var(--errorBorder)" }}
              >
                Forget token
              </button>
            </div>
          )}
        </div>

        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
            Quality hooks
          </div>
          <div style={{ opacity: 0.6, fontSize: 11, lineHeight: 1.45 }}>
            Add <code style={{ fontFamily: "monospace" }}>PostToolUse</code> /{" "}
            <code style={{ fontFamily: "monospace" }}>Stop</code> hooks to{" "}
            <code style={{ fontFamily: "monospace" }}>~/.claude/settings.json</code>{" "}
            (or per-project <code style={{ fontFamily: "monospace" }}>.claude/settings.json</code>).
            Claude Code merges hooks across settings scopes, so they fire during ClaudeOS runs
            alongside the built-in permission hook. Hook stderr is not yet surfaced inline —
            check your terminal for now.
          </div>
        </div>

        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
            Theme
          </div>
          <div style={{ display: "flex", gap: 14 }}>
            {(["dark", "light"] as Theme[]).map((t) => (
              <label
                key={t}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  cursor: "pointer",
                }}
              >
                <input
                  type="radio"
                  name="theme"
                  value={t}
                  checked={theme === t}
                  onChange={() => onThemeChange(t)}
                />
                <span style={{ textTransform: "capitalize" }}>{t}</span>
              </label>
            ))}
          </div>
        </div>

        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
            Default workspace directory
          </div>
          <div style={{ opacity: 0.5, fontSize: 11, marginBottom: 6 }}>
            Pre-fills the directory field when creating a new workspace.
          </div>
          <input
            type="text"
            value={defaultDir}
            onChange={(e) => setDefaultDir(e.target.value)}
            placeholder="/home/me/projects"
            style={{
              width: "100%",
              padding: 6,
              background: "var(--raised)",
              color: "var(--text)",
              border: "1px solid var(--borderStrong)",
              borderRadius: 4,
              fontSize: 12,
            }}
          />
        </div>

        {notice && (
          <div style={{ opacity: 0.7, fontSize: 11, marginBottom: 12 }}>{notice}</div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={settingsBtn}>
            Cancel
          </button>
          <button onClick={handleSave} style={{ ...settingsBtn, background: "var(--raisedAlt)" }}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

const settingsBtn: React.CSSProperties = {
  background: "transparent",
  color: "var(--text)",
  border: "1px solid var(--borderStrong)",
  borderRadius: 4,
  padding: "6px 12px",
  fontSize: 12,
  cursor: "pointer",
};

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

// rec-2 (kobramaz-a17.2): summary bar + expandable tool-call timeline.
// Click the bar to expand. Cache-hit ratio surfaces here so the operator
// can see prompt-caching effectiveness at a glance.
function TurnStatsBar({
  stats,
  messages,
}: {
  stats: NonNullable<WorkspaceState["lastTurnStats"]>;
  messages: Message[];
}) {
  const { usage, duration_ms, num_turns, cost_usd } = stats;
  const [open, setOpen] = useState(false);

  const cacheTotal = usage.cache_read_input_tokens + usage.input_tokens;
  const cacheHitRatio =
    cacheTotal > 0 ? usage.cache_read_input_tokens / cacheTotal : 0;

  const parts = [
    `${formatNum(usage.input_tokens)} in`,
    `${formatNum(usage.output_tokens)} out`,
    usage.cache_read_input_tokens > 0
      ? `${formatNum(usage.cache_read_input_tokens)} cache (${Math.round(cacheHitRatio * 100)}%)`
      : null,
    `$${cost_usd.toFixed(4)}`,
    `${(duration_ms / 1000).toFixed(1)}s`,
    num_turns > 1 ? `${num_turns} turns` : null,
  ].filter(Boolean);

  // Build tool-call timeline rows by joining call/result pairs from the
  // current slot's messages. Calls without a matching result (still
  // running, or the agent skipped a result) get duration null.
  type Row = { name: string; durationMs: number | null; isError: boolean };
  const calls = messages.filter((m) => m.toolDir === "call" && m.toolUseId);
  const rows: Row[] = calls.map((call) => {
    const result = messages.find(
      (m) => m.toolDir === "result" && m.toolUseId === call.toolUseId,
    );
    const dur =
      call.timestamp && result?.timestamp
        ? new Date(result.timestamp).getTime() - new Date(call.timestamp).getTime()
        : null;
    return {
      name: call.toolName ?? "tool",
      durationMs: dur,
      isError: result?.toolIsError === true,
    };
  });

  return (
    <div
      style={{
        borderTop: "1px solid var(--border)",
        background: "var(--bg)",
        fontFamily: "JetBrains Mono, Menlo, Consolas, monospace",
        letterSpacing: 0.2,
      }}
    >
      <div
        onClick={() => setOpen((o) => !o)}
        style={{
          padding: "4px 16px",
          fontSize: 10,
          color: "var(--mute)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
        title={open ? "Click to hide tool timeline" : "Click for tool timeline"}
      >
        <span>{parts.join(" · ")}</span>
        <span style={{ marginLeft: "auto", opacity: 0.6 }}>{open ? "▲" : "▼"}</span>
      </div>
      {open && rows.length > 0 && (
        <div style={{ padding: "6px 16px 10px", fontSize: 10 }}>
          <div style={{ opacity: 0.5, marginBottom: 4 }}>
            Tool calls in last turn ({rows.length})
          </div>
          {rows.map((r, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                gap: 12,
                color: r.isError ? "var(--errorMuted)" : "var(--mute)",
              }}
            >
              <span style={{ flex: 1, color: "var(--text)" }}>{r.name}</span>
              <span>
                {r.durationMs !== null
                  ? `${(r.durationMs / 1000).toFixed(2)}s`
                  : "—"}
              </span>
              {r.isError && <span>error</span>}
            </div>
          ))}
        </div>
      )}
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
        borderTop: "1px solid var(--warnBorder)",
        background: "var(--warnBg)",
        padding: "12px 16px",
      }}
    >
      <div
        style={{
          fontSize: 11,
          letterSpacing: 0.4,
          textTransform: "uppercase",
          color: "var(--warn)",
          marginBottom: 6,
        }}
      >
        Claude wants to use a tool
      </div>
      <div style={{ fontSize: 13, marginBottom: 8 }}>
        <strong style={{ color: "var(--warn)" }}>{permission.toolName}</strong>
      </div>
      <pre
        style={{
          background: "var(--panel)",
          border: "1px solid var(--borderStrong)",
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
        <div style={{ marginTop: 6, fontSize: 11, color: "var(--mute)" }}>
          {permission.reason}
        </div>
      )}
      <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
        <button
          onClick={onAllow}
          style={{
            ...btn,
            padding: "6px 14px",
            background: "var(--accentBg)",
            borderColor: "var(--accentSolid)",
            color: "var(--accent)",
          }}
        >
          Allow
        </button>
        <button
          onClick={onDeny}
          style={{
            ...btn,
            padding: "6px 14px",
            background: "var(--errorBg)",
            borderColor: "var(--errorBorder)",
            color: "var(--errorMuted)",
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
        borderTop: "1px solid var(--border)",
        padding: "8px 12px",
        display: "flex",
        flexWrap: "wrap",
        gap: 8,
        background: "var(--bg)",
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
        background: "var(--raised)",
        border: "1px solid var(--borderStrong)",
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
    message.role === "user" ? "var(--info)" : message.role === "tool" ? "var(--warn)" : "var(--text)";
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

  const borderColor = isError ? "var(--errorBorderDark)" : isCall ? "var(--infoBg)" : "var(--accentBg)";
  const accentColor = isError ? "var(--errorMuted)" : isCall ? "var(--info)" : "var(--accent)";
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
          background: "var(--highlight)",
        }}
      >
        <span style={{ color: accentColor, fontFamily: "monospace" }}>{arrow}</span>
        <span style={{ color: accentColor, fontFamily: "monospace", fontWeight: 600 }}>
          {message.toolName ?? (isCall ? "tool_call" : "tool_result")}
        </span>
        {isError && (
          <span
            style={{
              background: "var(--errorBorderDark)",
              color: "var(--errorMuted)",
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
        background: "var(--backdrop)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--panel)",
          border: "1px solid var(--borderStrong)",
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
                background: "var(--raised)",
                color: "var(--text)",
                border: "1px solid var(--borderStrong)",
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
              background: "var(--accentBg)",
              borderColor: "var(--accentSolid)",
              color: "var(--accent)",
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
  background: "var(--raisedAlt)",
  color: "var(--text)",
  border: "1px solid var(--borderStrong)",
  borderRadius: 4,
  padding: "4px 10px",
  fontSize: 12,
  cursor: "pointer",
};

const miniBtn: React.CSSProperties = {
  background: "transparent",
  color: "var(--text)",
  border: "none",
  padding: "0 4px",
  fontSize: 14,
  lineHeight: 1,
  cursor: "pointer",
};
