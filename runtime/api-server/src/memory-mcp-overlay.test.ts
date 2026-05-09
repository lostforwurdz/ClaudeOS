import { test } from "node:test";
import assert from "node:assert/strict";

import type { RunRequest } from "@claudeos/runtime-client/contracts";

import { applyMemoryMcpOverlay } from "./index.js";

const BASE: RunRequest = {
  workspace_id: "ws-1",
  session_id: "s-1",
  input_id: "in-1",
  instruction: "hi",
};

test("memory overlay is a no-op when memoryMcpBin is null/undefined", () => {
  assert.equal(applyMemoryMcpOverlay(BASE, null), BASE);
  assert.equal(applyMemoryMcpOverlay(BASE, undefined), BASE);
  assert.equal(applyMemoryMcpOverlay(BASE, ""), BASE);
});

test("memory overlay injects claudeos-memory when none is set", () => {
  const out = applyMemoryMcpOverlay(BASE, "/abs/memory.mjs");
  assert.equal(out.mcp_servers?.length, 1);
  assert.deepEqual(out.mcp_servers?.[0], {
    name: "claudeos-memory",
    type: "stdio",
    command: ["node", "/abs/memory.mjs"],
  });
});

test("memory overlay forwards bdBinary + writePrefix env vars when supplied", () => {
  const out = applyMemoryMcpOverlay(BASE, "/abs/memory.mjs", {
    bdBinary: "/usr/local/bin/bd",
    writePrefix: "claudeos.ws-abc.",
  });
  assert.deepEqual(out.mcp_servers?.[0].env, {
    CLAUDEOS_BD_BIN: "/usr/local/bin/bd",
    CLAUDEOS_MEMORY_PREFIX: "claudeos.ws-abc.",
  });
});

test("memory overlay omits env when neither bdBinary nor writePrefix is set", () => {
  const out = applyMemoryMcpOverlay(BASE, "/abs/memory.mjs", {});
  assert.equal(out.mcp_servers?.[0].env, undefined);
});

test("memory overlay coexists with the browser overlay (does not clobber)", () => {
  const req: RunRequest = {
    ...BASE,
    mcp_servers: [
      { name: "claudeos-browser", type: "stdio", command: ["node", "/b/x.mjs"] },
    ],
  };
  const out = applyMemoryMcpOverlay(req, "/abs/memory.mjs");
  assert.equal(out.mcp_servers?.length, 2);
  assert.equal(out.mcp_servers?.[0].name, "claudeos-browser");
  assert.equal(out.mcp_servers?.[1].name, "claudeos-memory");
});

test("memory overlay does NOT duplicate when claudeos-memory already exists", () => {
  const req: RunRequest = {
    ...BASE,
    mcp_servers: [
      { name: "claudeos-memory", type: "stdio", command: ["custom", "/path"] },
    ],
  };
  const out = applyMemoryMcpOverlay(req, "/abs/memory.mjs");
  assert.equal(out.mcp_servers?.length, 1);
  assert.deepEqual(out.mcp_servers?.[0].command, ["custom", "/path"]);
});

test("memory overlay is pure — does not mutate the input request", () => {
  const req: RunRequest = { ...BASE, mcp_servers: [] };
  const out = applyMemoryMcpOverlay(req, "/abs/memory.mjs");
  assert.notEqual(out, req);
  assert.equal(req.mcp_servers?.length, 0);
  assert.equal(out.mcp_servers?.length, 1);
});
