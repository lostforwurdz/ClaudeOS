import test from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { BdRunner } from "./bd.js";
import {
  MEMORY_MCP_NAME,
  MEMORY_MCP_VERSION,
  createMemoryMcpServer,
} from "./server.js";

interface CallLog {
  remember: Array<{ key: string; value: string }>;
  recall: Array<string>;
  memories: Array<string | undefined>;
  forget: Array<string>;
}

function fakeBd(): { bd: BdRunner; calls: CallLog; store: Map<string, string> } {
  const calls: CallLog = { remember: [], recall: [], memories: [], forget: [] };
  const store = new Map<string, string>();
  const bd: BdRunner = {
    async remember(key, value) {
      calls.remember.push({ key, value });
      store.set(key, value);
    },
    async recall(key) {
      calls.recall.push(key);
      const v = store.get(key);
      return v === undefined ? null : { key, value: v };
    },
    async memories(search) {
      calls.memories.push(search);
      const items = [...store.entries()]
        .map(([key, value]) => ({ key, value }))
        .filter((it) => !search || (it.key + it.value).includes(search))
        .sort((a, b) => a.key.localeCompare(b.key));
      return items;
    },
    async forget(key) {
      calls.forget.push(key);
      return store.delete(key);
    },
  };
  return { bd, calls, store };
}

async function connectClient(bd: BdRunner, writePrefix?: string) {
  const server = createMemoryMcpServer({ bd, writePrefix });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

test("server advertises name/version and lists the four memory tools", async () => {
  const { bd } = fakeBd();
  const { client, server } = await connectClient(bd);
  try {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "memory_forget",
      "memory_recall",
      "memory_remember",
      "memory_search",
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("memory_remember auto-prefixes the key (default 'claudeos.')", async () => {
  const { bd, calls, store } = fakeBd();
  const { client, server } = await connectClient(bd);
  try {
    const result = await client.callTool({
      name: "memory_remember",
      arguments: { key: "current-task", value: "rebuild memory layer" },
    });
    assert.equal(calls.remember.length, 1);
    assert.equal(calls.remember[0].key, "claudeos.current-task");
    assert.equal(calls.remember[0].value, "rebuild memory layer");
    assert.equal(store.get("claudeos.current-task"), "rebuild memory layer");

    const text = (result.content as Array<{ type: string; text: string }>)[0];
    const payload = JSON.parse(text.text);
    assert.equal(payload.stored_key, "claudeos.current-task");
    assert.equal(payload.ok, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("memory_remember honors a custom writePrefix", async () => {
  const { bd, calls } = fakeBd();
  const { client, server } = await connectClient(bd, "claudeos.ws-abc.");
  try {
    await client.callTool({
      name: "memory_remember",
      arguments: { key: "note", value: "hi" },
    });
    assert.equal(calls.remember[0].key, "claudeos.ws-abc.note");
  } finally {
    await client.close();
    await server.close();
  }
});

test("memory_recall returns the value as-stored or null when absent", async () => {
  const { bd, store } = fakeBd();
  store.set("claudeos.x", "value-x");
  const { client, server } = await connectClient(bd);
  try {
    const found = await client.callTool({
      name: "memory_recall",
      arguments: { key: "claudeos.x" },
    });
    const foundText = JSON.parse(
      (found.content as Array<{ type: string; text: string }>)[0].text,
    );
    assert.equal(foundText.value, "value-x");

    const missing = await client.callTool({
      name: "memory_recall",
      arguments: { key: "claudeos.missing" },
    });
    const missingText = JSON.parse(
      (missing.content as Array<{ type: string; text: string }>)[0].text,
    );
    assert.equal(missingText.value, null);
  } finally {
    await client.close();
    await server.close();
  }
});

test("memory_recall does NOT auto-prefix (reads use full keys)", async () => {
  const { bd, calls, store } = fakeBd();
  store.set("claudeos.x", "v");
  store.set("operator-key", "op-v");
  const { client, server } = await connectClient(bd);
  try {
    await client.callTool({
      name: "memory_recall",
      arguments: { key: "operator-key" },
    });
    // The recall call should pass "operator-key" through verbatim — the agent
    // must be able to read keys outside the ClaudeOS namespace.
    assert.equal(calls.recall.at(-1), "operator-key");
  } finally {
    await client.close();
    await server.close();
  }
});

test("memory_search lists all entries when no query is given, capped at max_results", async () => {
  const { bd, store } = fakeBd();
  for (let i = 0; i < 5; i++) store.set(`claudeos.k${i}`, `v${i}`);
  const { client, server } = await connectClient(bd);
  try {
    const result = await client.callTool({
      name: "memory_search",
      arguments: { max_results: 3 },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0];
    const payload = JSON.parse(text.text);
    assert.equal(payload.total, 5);
    assert.equal(payload.count, 3);
    assert.equal(payload.items.length, 3);
  } finally {
    await client.close();
    await server.close();
  }
});

test("memory_search forwards a substring filter to bd memories", async () => {
  const { bd, calls } = fakeBd();
  const { client, server } = await connectClient(bd);
  try {
    await client.callTool({
      name: "memory_search",
      arguments: { query: "auth" },
    });
    assert.equal(calls.memories.at(-1), "auth");
  } finally {
    await client.close();
    await server.close();
  }
});

test("memory_forget returns ok:true when the key existed, ok:false when not", async () => {
  const { bd, store } = fakeBd();
  store.set("claudeos.kept", "v");
  const { client, server } = await connectClient(bd);
  try {
    const ok = await client.callTool({
      name: "memory_forget",
      arguments: { key: "claudeos.kept" },
    });
    const okPayload = JSON.parse(
      (ok.content as Array<{ type: string; text: string }>)[0].text,
    );
    assert.equal(okPayload.ok, true);
    assert.equal(store.has("claudeos.kept"), false);

    const missing = await client.callTool({
      name: "memory_forget",
      arguments: { key: "claudeos.never-existed" },
    });
    const missingPayload = JSON.parse(
      (missing.content as Array<{ type: string; text: string }>)[0].text,
    );
    assert.equal(missingPayload.ok, false);
  } finally {
    await client.close();
    await server.close();
  }
});

test("server identity matches the exported constants for auto-registration", () => {
  assert.equal(MEMORY_MCP_NAME, "claudeos-memory");
  assert.match(MEMORY_MCP_VERSION, /^\d+\.\d+\.\d+$/);
});
