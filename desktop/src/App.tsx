import { useCallback, useEffect, useRef, useState } from "react";

import type {
  RunEvent,
  Session,
  Workspace,
} from "@claudeos/runtime-client/contracts";

import { api } from "./api.js";

interface Message {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
}

export function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<Workspace | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Bootstrap: load workspaces.
  useEffect(() => {
    api.listWorkspaces().then(setWorkspaces).catch((e) => setError(String(e)));
  }, []);

  // Auto-scroll on new messages.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSelectWorkspace = useCallback(async (ws: Workspace) => {
    setActiveWorkspace(ws);
    setMessages([]);
    setSession(null);
    try {
      const newSession = await api.createSession({ workspace_id: ws.id });
      setSession(newSession);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const handleCreateWorkspace = useCallback(async () => {
    const name = window.prompt("Workspace name?");
    if (!name) return;
    const dir = window.prompt("Workspace directory (absolute path)?");
    if (!dir) return;
    try {
      const ws = await api.createWorkspace({ name, dir });
      setWorkspaces((prev) => [ws, ...prev]);
      void handleSelectWorkspace(ws);
    } catch (e) {
      setError(String(e));
    }
  }, [handleSelectWorkspace]);

  const handleSend = useCallback(async () => {
    if (!activeWorkspace || !session || !input.trim() || streaming) return;
    const text = input.trim();
    setInput("");
    setError(null);

    const userMsgId = `user-${Date.now()}`;
    setMessages((prev) => [...prev, { id: userMsgId, role: "user", text }]);
    setStreaming(true);

    try {
      const inputId = `in-${Date.now()}`;
      const submitted = await api.submitRun({
        workspace_id: activeWorkspace.id,
        session_id: session.id,
        input_id: inputId,
        instruction: text,
      });

      const close = api.streamRun(submitted.run_id, (event) => {
        applyEvent(event, setMessages);
        if (event.type === "run_completed" || event.type === "run_failed") {
          setStreaming(false);
          close();
          if (event.type === "run_failed") {
            setError(event.payload.error);
          }
        }
      });
    } catch (e) {
      setError(String(e));
      setStreaming(false);
    }
  }, [activeWorkspace, session, input, streaming]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <header
        style={{
          padding: "10px 16px",
          borderBottom: "1px solid #1e1e1e",
          display: "flex",
          gap: 12,
          alignItems: "center",
        }}
      >
        <strong style={{ fontSize: 13, letterSpacing: -0.2 }}>ClaudeOS</strong>
        <select
          value={activeWorkspace?.id ?? ""}
          onChange={(e) => {
            const ws = workspaces.find((w) => w.id === e.target.value);
            if (ws) void handleSelectWorkspace(ws);
          }}
          style={{
            background: "#161616",
            color: "#e5e5e5",
            border: "1px solid #2a2a2a",
            borderRadius: 4,
            padding: "4px 8px",
            fontSize: 12,
          }}
        >
          <option value="" disabled>
            Select workspace…
          </option>
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name} ({w.dir})
            </option>
          ))}
        </select>
        <button onClick={handleCreateWorkspace} style={btn}>
          New workspace
        </button>
        {session && (
          <span style={{ fontSize: 11, opacity: 0.5 }}>
            session: {session.id.slice(0, 8)}…
            {session.claude_session_id && ` ↔ ${session.claude_session_id.slice(0, 8)}…`}
          </span>
        )}
      </header>

      <main style={{ flex: 1, overflowY: "auto", padding: 16 }}>
        {messages.length === 0 && (
          <div style={{ opacity: 0.4, fontSize: 12 }}>
            {activeWorkspace ? "Type a message below." : "Select or create a workspace to begin."}
          </div>
        )}
        {messages.map((m) => (
          <MessageView key={m.id} message={m} />
        ))}
        {error && (
          <div style={{ color: "#ff6464", fontSize: 12, marginTop: 8 }}>
            error: {error}
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
              void handleSend();
            }
          }}
          placeholder={session ? "Message Claude…" : "Select a workspace first"}
          disabled={!session || streaming}
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
          onClick={() => void handleSend()}
          disabled={!session || !input.trim() || streaming}
          style={{ ...btn, padding: "8px 16px" }}
        >
          {streaming ? "…" : "Send"}
        </button>
      </footer>
    </div>
  );
}

function MessageView({ message }: { message: Message }) {
  const color =
    message.role === "user" ? "#9bc1ff" : message.role === "tool" ? "#c9a657" : "#e5e5e5";
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 10, opacity: 0.5, color, textTransform: "uppercase", letterSpacing: 0.4 }}>
        {message.role}
      </div>
      <div style={{ whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.5 }}>
        {message.text || "…"}
      </div>
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

/**
 * Mutates the messages list in response to each RunEvent.
 *
 * - text_delta: append to the current assistant message keyed by message_id.
 * - tool_call: append a "tool" message describing the call.
 * - tool_result: append a "tool" message with the result.
 * - run_started / completed / failed / compaction events: ignored visually
 *   for Phase 1 — caller drives the streaming flag.
 */
function applyEvent(
  event: RunEvent,
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
): void {
  if (event.type === "text_delta") {
    const messageId = event.payload.message_id || `assistant-${event.sequence}`;
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === messageId);
      if (idx === -1) {
        return [...prev, { id: messageId, role: "assistant", text: event.payload.text }];
      }
      const next = [...prev];
      next[idx] = { ...next[idx], text: next[idx].text + event.payload.text };
      return next;
    });
  } else if (event.type === "tool_call") {
    setMessages((prev) => [
      ...prev,
      {
        id: `tool-call-${event.payload.tool_use_id}`,
        role: "tool",
        text: `→ ${event.payload.name}(${JSON.stringify(event.payload.input)})`,
      },
    ]);
  } else if (event.type === "tool_result") {
    const text =
      typeof event.payload.content === "string"
        ? event.payload.content
        : JSON.stringify(event.payload.content);
    setMessages((prev) => [
      ...prev,
      {
        id: `tool-result-${event.payload.tool_use_id}`,
        role: "tool",
        text: `← ${event.payload.is_error ? "[error] " : ""}${text}`,
      },
    ]);
  }
}
