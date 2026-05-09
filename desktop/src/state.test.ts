import test from "node:test";
import assert from "node:assert/strict";

import type {
  Attachment,
  RunEvent,
  Session,
  Workspace,
} from "@claudeos/runtime-client/contracts";

import {
  appReducer,
  applyEvent,
  initialAppState,
  type Action,
  type Message,
} from "./state.js";

const ws = (id: string, name = id): Workspace => ({
  id,
  name,
  dir: `/ws/${id}`,
  created_at: "2026-05-09T00:00:00Z",
  updated_at: "2026-05-09T00:00:00Z",
});

const session = (id: string, workspaceId: string): Session => ({
  id,
  workspace_id: workspaceId,
  claude_session_id: null,
  created_at: "2026-05-09T00:00:00Z",
  updated_at: "2026-05-09T00:00:00Z",
});

function reduce(actions: Action[]) {
  return actions.reduce(appReducer, initialAppState);
}

test("opening a workspace creates a slot, appends to openOrder, activates it", () => {
  const state = reduce([{ type: "WORKSPACE_OPENED", workspace: ws("a") }]);
  assert.equal(state.activeId, "a");
  assert.deepEqual(state.openOrder, ["a"]);
  assert.equal(state.byId.a.workspace.id, "a");
  assert.equal(state.byId.a.streaming, false);
  assert.deepEqual(state.byId.a.messages, []);
});

test("opening an already-open workspace just activates it (no slot reset)", () => {
  const state = reduce([
    { type: "WORKSPACE_OPENED", workspace: ws("a") },
    {
      type: "USER_SENT",
      workspaceId: "a",
      message: { id: "m1", role: "user", text: "hi" },
      runId: "r1",
    },
    { type: "WORKSPACE_OPENED", workspace: ws("b") },
    { type: "WORKSPACE_OPENED", workspace: ws("a") }, // re-open
  ]);
  assert.equal(state.activeId, "a");
  assert.deepEqual(state.openOrder, ["a", "b"]);
  assert.equal(state.byId.a.messages.length, 1, "user message must be preserved across re-open");
});

test("closing the active workspace falls back to the previous open one", () => {
  const state = reduce([
    { type: "WORKSPACE_OPENED", workspace: ws("a") },
    { type: "WORKSPACE_OPENED", workspace: ws("b") },
    { type: "WORKSPACE_OPENED", workspace: ws("c") },
    { type: "WORKSPACE_CLOSED", workspaceId: "c" },
  ]);
  assert.deepEqual(state.openOrder, ["a", "b"]);
  assert.equal(state.activeId, "b");
  assert.equal(state.byId.c, undefined);
});

test("closing a non-active workspace leaves activeId untouched", () => {
  const state = reduce([
    { type: "WORKSPACE_OPENED", workspace: ws("a") },
    { type: "WORKSPACE_OPENED", workspace: ws("b") },
    { type: "WORKSPACE_ACTIVATED", workspaceId: "a" },
    { type: "WORKSPACE_CLOSED", workspaceId: "b" },
  ]);
  assert.equal(state.activeId, "a");
  assert.deepEqual(state.openOrder, ["a"]);
});

test("closing the last open workspace clears activeId", () => {
  const state = reduce([
    { type: "WORKSPACE_OPENED", workspace: ws("a") },
    { type: "WORKSPACE_CLOSED", workspaceId: "a" },
  ]);
  assert.equal(state.activeId, null);
  assert.deepEqual(state.openOrder, []);
});

test("USER_SENT appends a message, sets streaming, clears prior error, records runId", () => {
  const state = reduce([
    { type: "WORKSPACE_OPENED", workspace: ws("a") },
    { type: "ERROR_SET", workspaceId: "a", error: "old" },
    {
      type: "USER_SENT",
      workspaceId: "a",
      message: { id: "u1", role: "user", text: "hi" },
      runId: "run-1",
    },
  ]);
  const slot = state.byId.a;
  assert.equal(slot.streaming, true);
  assert.equal(slot.error, null);
  assert.equal(slot.activeRunId, "run-1");
  assert.deepEqual(slot.messages.map((m: Message) => m.id), ["u1"]);
});

test("RUN_EVENT routes to the right workspace and doesn't bleed into others", () => {
  const e: RunEvent = {
    type: "text_delta",
    session_id: "s",
    input_id: "i",
    sequence: 0,
    timestamp: "x",
    payload: { message_id: "msg-a", text: "hello" },
  };
  const state = reduce([
    { type: "WORKSPACE_OPENED", workspace: ws("a") },
    { type: "WORKSPACE_OPENED", workspace: ws("b") },
    { type: "RUN_EVENT", workspaceId: "a", event: e },
  ]);
  assert.equal(state.byId.a.messages[0].text, "hello");
  assert.equal(state.byId.b.messages.length, 0, "B's chat must remain pristine");
});

test("RUN_EVENT with run_started binds the claude_session_id on the slot's session", () => {
  const startEvent: RunEvent = {
    type: "run_started",
    session_id: "s-a",
    input_id: "i",
    sequence: 0,
    timestamp: "x",
    payload: {
      claude_session_id: "claude-abc",
      model: "m",
      tools: [],
      mcp_servers: [],
      permission_mode: "default",
      cwd: "/",
    },
  };
  const state = reduce([
    { type: "WORKSPACE_OPENED", workspace: ws("a") },
    { type: "SESSION_BOUND", workspaceId: "a", session: session("s-a", "a") },
    { type: "RUN_EVENT", workspaceId: "a", event: startEvent },
  ]);
  assert.equal(state.byId.a.session?.claude_session_id, "claude-abc");
});

test("RUN_EVENT with run_completed captures lastTurnStats with usage + cost + duration", () => {
  const completed: RunEvent = {
    type: "run_completed",
    session_id: "s",
    input_id: "i",
    sequence: 5,
    timestamp: "x",
    payload: {
      duration_ms: 4321,
      num_turns: 2,
      usage: {
        input_tokens: 1500,
        output_tokens: 250,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 800,
      },
      cost_usd: 0.0123,
      result: "ok",
    },
  };
  const state = reduce([
    { type: "WORKSPACE_OPENED", workspace: ws("a") },
    { type: "RUN_EVENT", workspaceId: "a", event: completed },
  ]);
  const stats = state.byId.a.lastTurnStats;
  assert.ok(stats, "stats must be populated on run_completed");
  assert.equal(stats.duration_ms, 4321);
  assert.equal(stats.num_turns, 2);
  assert.equal(stats.usage.input_tokens, 1500);
  assert.equal(stats.usage.cache_read_input_tokens, 800);
  assert.equal(stats.cost_usd, 0.0123);
});

test("lastTurnStats survives the next USER_SENT (so the user can still see them while typing)", () => {
  const completed: RunEvent = {
    type: "run_completed",
    session_id: "s",
    input_id: "i",
    sequence: 1,
    timestamp: "x",
    payload: {
      duration_ms: 100,
      num_turns: 1,
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      cost_usd: 0.001,
      result: "ok",
    },
  };
  const state = reduce([
    { type: "WORKSPACE_OPENED", workspace: ws("a") },
    { type: "RUN_EVENT", workspaceId: "a", event: completed },
    {
      type: "USER_SENT",
      workspaceId: "a",
      message: { id: "u1", role: "user", text: "again" },
      runId: "r2",
    },
  ]);
  assert.ok(state.byId.a.lastTurnStats, "previous stats must NOT be wiped on next send");
  assert.equal(state.byId.a.lastTurnStats.cost_usd, 0.001);
});

test("RUN_FINISHED clears streaming and activeRunId, accepts an optional error", () => {
  const state = reduce([
    { type: "WORKSPACE_OPENED", workspace: ws("a") },
    {
      type: "USER_SENT",
      workspaceId: "a",
      message: { id: "u1", role: "user", text: "hi" },
      runId: "run-1",
    },
    { type: "RUN_FINISHED", workspaceId: "a", error: "boom" },
  ]);
  const slot = state.byId.a;
  assert.equal(slot.streaming, false);
  assert.equal(slot.activeRunId, null);
  assert.equal(slot.error, "boom");
});

test("actions targeting an unknown workspace are no-ops", () => {
  const before = reduce([{ type: "WORKSPACE_OPENED", workspace: ws("a") }]);
  const after = appReducer(before, {
    type: "USER_SENT",
    workspaceId: "ghost",
    message: { id: "m", role: "user", text: "x" },
    runId: "r",
  });
  assert.equal(after, before, "reducer must short-circuit unchanged state");
});

test("applyEvent: text_delta merges chunks under the same message_id", () => {
  const m1: Message[] = [];
  const e1: RunEvent = {
    type: "text_delta",
    session_id: "",
    input_id: "",
    sequence: 0,
    timestamp: "",
    payload: { message_id: "m1", text: "Hel" },
  };
  const e2: RunEvent = { ...e1, sequence: 1, payload: { message_id: "m1", text: "lo" } };
  const out = applyEvent(applyEvent(m1, e1), e2);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, "Hello");
});

const att = (path: string, kind: "image" | "file" = "image"): Attachment => ({
  kind,
  workspace_path: path,
  mime_type: kind === "image" ? "image/png" : "application/pdf",
});

test("ATTACHMENT_ADDED queues an attachment on the workspace's pending list", () => {
  const state = reduce([
    { type: "WORKSPACE_OPENED", workspace: ws("a") },
    { type: "ATTACHMENT_ADDED", workspaceId: "a", attachment: att("uploads/u1-x.png") },
    { type: "ATTACHMENT_ADDED", workspaceId: "a", attachment: att("uploads/u2-y.pdf", "file") },
  ]);
  assert.equal(state.byId.a.pendingAttachments.length, 2);
  assert.equal(state.byId.a.pendingAttachments[0].workspace_path, "uploads/u1-x.png");
  assert.equal(state.byId.a.pendingAttachments[1].kind, "file");
});

test("ATTACHMENT_ADDED de-dupes by workspace_path", () => {
  const state = reduce([
    { type: "WORKSPACE_OPENED", workspace: ws("a") },
    { type: "ATTACHMENT_ADDED", workspaceId: "a", attachment: att("uploads/u1-x.png") },
    { type: "ATTACHMENT_ADDED", workspaceId: "a", attachment: att("uploads/u1-x.png") },
  ]);
  assert.equal(state.byId.a.pendingAttachments.length, 1);
});

test("ATTACHMENT_REMOVED drops the matching path and leaves siblings alone", () => {
  const state = reduce([
    { type: "WORKSPACE_OPENED", workspace: ws("a") },
    { type: "ATTACHMENT_ADDED", workspaceId: "a", attachment: att("uploads/u1-x.png") },
    { type: "ATTACHMENT_ADDED", workspaceId: "a", attachment: att("uploads/u2-y.pdf", "file") },
    { type: "ATTACHMENT_REMOVED", workspaceId: "a", workspacePath: "uploads/u1-x.png" },
  ]);
  assert.equal(state.byId.a.pendingAttachments.length, 1);
  assert.equal(state.byId.a.pendingAttachments[0].workspace_path, "uploads/u2-y.pdf");
});

test("USER_SENT clears pendingAttachments so the next message starts clean", () => {
  const state = reduce([
    { type: "WORKSPACE_OPENED", workspace: ws("a") },
    { type: "ATTACHMENT_ADDED", workspaceId: "a", attachment: att("uploads/u1-x.png") },
    {
      type: "USER_SENT",
      workspaceId: "a",
      message: { id: "u1", role: "user", text: "look" },
      runId: "r1",
    },
  ]);
  assert.deepEqual(state.byId.a.pendingAttachments, []);
});

test("attachments are scoped to their workspace", () => {
  const state = reduce([
    { type: "WORKSPACE_OPENED", workspace: ws("a") },
    { type: "WORKSPACE_OPENED", workspace: ws("b") },
    { type: "ATTACHMENT_ADDED", workspaceId: "a", attachment: att("uploads/u1-x.png") },
  ]);
  assert.equal(state.byId.a.pendingAttachments.length, 1);
  assert.equal(state.byId.b.pendingAttachments.length, 0);
});

test("applyEvent: tool_call and tool_result append distinct tool messages", () => {
  const callEvent: RunEvent = {
    type: "tool_call",
    session_id: "",
    input_id: "",
    sequence: 0,
    timestamp: "",
    payload: { message_id: "m1", tool_use_id: "tu-1", name: "Bash", input: { cmd: "ls" } },
  };
  const resultEvent: RunEvent = {
    type: "tool_result",
    session_id: "",
    input_id: "",
    sequence: 1,
    timestamp: "",
    payload: { tool_use_id: "tu-1", content: "ok", is_error: false },
  };
  const out = applyEvent(applyEvent([], callEvent), resultEvent);
  assert.equal(out.length, 2);
  assert.equal(out[0].role, "tool");
  assert.match(out[0].text, /Bash/);
  assert.match(out[1].text, /^← ok/);
});
