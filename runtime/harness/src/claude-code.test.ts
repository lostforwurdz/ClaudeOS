import test from "node:test";
import assert from "node:assert/strict";

import { parseStream } from "./claude-code.js";
import type { RunRequest } from "@claudeos/runtime-client/contracts";

const REQ: RunRequest = {
  workspace_id: "ws-1",
  session_id: "sess-1",
  input_id: "in-1",
  instruction: "hello",
};

const j = (o: unknown) => JSON.stringify(o);

test("system init emits run_started with session id, model, tools, mcp servers", () => {
  const events = parseStream(REQ, [
    j({
      type: "system",
      subtype: "init",
      session_id: "claude-sess-abc",
      cwd: "/tmp/ws",
      tools: ["Bash", "Read", "Edit"],
      mcp_servers: [
        { name: "context7", status: "connected" },
        { name: "playwright", status: "connected" },
      ],
      model: "claude-opus-4-7",
      permissionMode: "default",
      apiKeySource: "oauth",
    }),
  ]);

  assert.equal(events.length, 1);
  const ev = events[0];
  assert.equal(ev.type, "run_started");
  assert.equal(ev.sequence, 0);
  assert.equal(ev.session_id, "sess-1");
  assert.equal(ev.input_id, "in-1");
  if (ev.type !== "run_started") throw new Error("type narrow");
  assert.deepEqual(ev.payload, {
    claude_session_id: "claude-sess-abc",
    model: "claude-opus-4-7",
    tools: ["Bash", "Read", "Edit"],
    mcp_servers: ["context7", "playwright"],
    permission_mode: "default",
    cwd: "/tmp/ws",
  });
});

test("text deltas attach to current message_id and preserve order", () => {
  const events = parseStream(REQ, [
    j({ type: "stream_event", event: { type: "message_start", message: { id: "msg-1" } } }),
    j({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
    }),
    j({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      },
    }),
    j({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: " world" },
      },
    }),
    j({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }),
    j({ type: "stream_event", event: { type: "message_stop" } }),
  ]);

  const text = events.filter((e) => e.type === "text_delta");
  assert.equal(text.length, 2);
  for (const e of text) {
    if (e.type !== "text_delta") throw new Error("type narrow");
    assert.equal(e.payload.message_id, "msg-1");
  }
  if (text[0].type !== "text_delta" || text[1].type !== "text_delta") throw new Error("type narrow");
  assert.equal(text[0].payload.text, "Hello");
  assert.equal(text[1].payload.text, " world");
  assert.equal(text[0].sequence, 0);
  assert.equal(text[1].sequence, 1);
});

test("thinking deltas route to thinking_delta event", () => {
  const events = parseStream(REQ, [
    j({ type: "stream_event", event: { type: "message_start", message: { id: "msg-2" } } }),
    j({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
    }),
    j({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Let me think..." },
      },
    }),
  ]);

  assert.equal(events.length, 1);
  const ev = events[0];
  assert.equal(ev.type, "thinking_delta");
  if (ev.type !== "thinking_delta") throw new Error("type narrow");
  assert.equal(ev.payload.text, "Let me think...");
  assert.equal(ev.payload.message_id, "msg-2");
});

test("tool_use blocks in assistant messages emit tool_call events", () => {
  const events = parseStream(REQ, [
    j({
      type: "assistant",
      message: {
        id: "msg-3",
        role: "assistant",
        content: [
          { type: "text", text: "Listing files now." },
          {
            type: "tool_use",
            id: "toolu_abc",
            name: "Bash",
            input: { command: "ls -la" },
          },
        ],
      },
    }),
  ]);

  // text in assistant is not re-emitted (deltas are the source of truth)
  assert.equal(events.length, 1);
  const ev = events[0];
  assert.equal(ev.type, "tool_call");
  if (ev.type !== "tool_call") throw new Error("type narrow");
  assert.equal(ev.payload.tool_use_id, "toolu_abc");
  assert.equal(ev.payload.name, "Bash");
  assert.deepEqual(ev.payload.input, { command: "ls -la" });
  assert.equal(ev.payload.message_id, "msg-3");
});

test("tool_result blocks in user messages emit tool_result events", () => {
  const events = parseStream(REQ, [
    j({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_abc",
            content: "file1.txt\nfile2.txt",
            is_error: false,
          },
        ],
      },
    }),
  ]);

  assert.equal(events.length, 1);
  const ev = events[0];
  assert.equal(ev.type, "tool_result");
  if (ev.type !== "tool_result") throw new Error("type narrow");
  assert.equal(ev.payload.tool_use_id, "toolu_abc");
  assert.equal(ev.payload.is_error, false);
  assert.equal(ev.payload.content, "file1.txt\nfile2.txt");
});

test("result with subtype=success emits run_completed with usage and cost", () => {
  const events = parseStream(REQ, [
    j({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Done.",
      session_id: "claude-sess-abc",
      duration_ms: 1234,
      duration_api_ms: 1000,
      num_turns: 2,
      total_cost_usd: 0.0123,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 300,
      },
    }),
  ]);

  assert.equal(events.length, 1);
  const ev = events[0];
  assert.equal(ev.type, "run_completed");
  if (ev.type !== "run_completed") throw new Error("type narrow");
  assert.equal(ev.payload.duration_ms, 1234);
  assert.equal(ev.payload.num_turns, 2);
  assert.equal(ev.payload.cost_usd, 0.0123);
  assert.equal(ev.payload.result, "Done.");
  assert.deepEqual(ev.payload.usage, {
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_input_tokens: 200,
    cache_read_input_tokens: 300,
  });
});

test("result with non-success subtype emits run_failed", () => {
  const events = parseStream(REQ, [
    j({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      result: "",
      session_id: "claude-sess-abc",
      duration_ms: 5000,
      num_turns: 10,
      total_cost_usd: 0.05,
      usage: {},
    }),
  ]);

  assert.equal(events.length, 1);
  const ev = events[0];
  assert.equal(ev.type, "run_failed");
  if (ev.type !== "run_failed") throw new Error("type narrow");
  assert.equal(ev.payload.subtype, "error_max_turns");
});

test("compact_boundary emits compaction_start then compaction_end", () => {
  const events = parseStream(REQ, [
    j({
      type: "system",
      subtype: "compact_boundary",
      session_id: "claude-sess-abc",
      compact_metadata: { trigger: "auto", pre_tokens: 90000 },
    }),
  ]);

  assert.equal(events.length, 2);
  assert.equal(events[0].type, "compaction_start");
  if (events[0].type !== "compaction_start") throw new Error("type narrow");
  assert.equal(events[0].payload.trigger, "auto");
  assert.equal(events[1].type, "compaction_end");
});

test("sequence numbers are monotonic across mixed event types", () => {
  const events = parseStream(REQ, [
    j({ type: "system", subtype: "init", session_id: "cs", model: "m", tools: [], mcp_servers: [], permissionMode: "default", cwd: "/tmp" }),
    j({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } }),
    j({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } }),
    j({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "a" } } }),
    j({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "b" } } }),
    j({ type: "result", subtype: "success", is_error: false, result: "ab", session_id: "cs", duration_ms: 1, num_turns: 1, total_cost_usd: 0, usage: {} }),
  ]);

  assert.equal(events.length, 4); // run_started + 2 text_delta + run_completed
  for (let i = 0; i < events.length; i++) {
    assert.equal(events[i].sequence, i, `sequence at index ${i}`);
  }
});

test("malformed lines and unknown types are ignored without throwing", () => {
  const events = parseStream(REQ, [
    "not json",
    "",
    "  ",
    j({ type: "unknown_future_event", payload: { foo: "bar" } }),
    j({ type: "system", subtype: "init", session_id: "cs", model: "m", tools: [], mcp_servers: [], permissionMode: "default", cwd: "/" }),
  ]);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "run_started");
});
