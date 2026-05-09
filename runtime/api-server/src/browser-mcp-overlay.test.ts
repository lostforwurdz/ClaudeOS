import { test } from "node:test";
import assert from "node:assert/strict";

import type { RunRequest } from "@claudeos/runtime-client/contracts";

import { applyBrowserMcpOverlay } from "./index.js";

const BASE: RunRequest = {
  workspace_id: "ws-1",
  session_id: "s-1",
  input_id: "in-1",
  instruction: "hi",
};

test("overlay is a no-op when browserMcpBin is null/undefined", () => {
  assert.equal(applyBrowserMcpOverlay(BASE, null), BASE);
  assert.equal(applyBrowserMcpOverlay(BASE, undefined), BASE);
  assert.equal(applyBrowserMcpOverlay(BASE, ""), BASE);
});

test("overlay injects claudeos-browser when none is set", () => {
  const out = applyBrowserMcpOverlay(BASE, "/abs/path/to/dist/index.mjs");
  assert.equal(out.mcp_servers?.length, 1);
  const s = out.mcp_servers?.[0];
  assert.deepEqual(s, {
    name: "claudeos-browser",
    type: "stdio",
    command: ["node", "/abs/path/to/dist/index.mjs"],
  });
});

test("overlay appends to existing user-supplied mcp_servers without dropping them", () => {
  const req: RunRequest = {
    ...BASE,
    mcp_servers: [
      { name: "context7", type: "stdio", command: ["npx", "-y", "@upstash/context7-mcp"] },
    ],
  };
  const out = applyBrowserMcpOverlay(req, "/abs/browser.mjs");
  assert.equal(out.mcp_servers?.length, 2);
  assert.equal(out.mcp_servers?.[0].name, "context7");
  assert.equal(out.mcp_servers?.[1].name, "claudeos-browser");
});

test("overlay does NOT duplicate when claudeos-browser already exists", () => {
  const req: RunRequest = {
    ...BASE,
    mcp_servers: [
      { name: "claudeos-browser", type: "stdio", command: ["custom", "/path"] },
    ],
  };
  const out = applyBrowserMcpOverlay(req, "/abs/browser.mjs");
  assert.equal(out.mcp_servers?.length, 1);
  // Caller-provided config wins (we don't override it).
  assert.deepEqual(out.mcp_servers?.[0].command, ["custom", "/path"]);
});

test("overlay is pure — does not mutate the input request", () => {
  const req: RunRequest = { ...BASE, mcp_servers: [] };
  const out = applyBrowserMcpOverlay(req, "/abs/browser.mjs");
  assert.notEqual(out, req);
  assert.equal(req.mcp_servers?.length, 0);
  assert.equal(out.mcp_servers?.length, 1);
});
