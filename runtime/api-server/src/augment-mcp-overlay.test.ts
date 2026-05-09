import { test } from "node:test";
import assert from "node:assert/strict";

import type { RunRequest } from "@claudeos/runtime-client/contracts";

import { applyAugmentMcpOverlay } from "./index.js";

const BASE: RunRequest = {
  workspace_id: "ws-1",
  session_id: "s-1",
  input_id: "in-1",
  instruction: "hi",
};

test("augment overlay is a no-op when sessionAuth is null/undefined/empty", () => {
  assert.equal(applyAugmentMcpOverlay(BASE, null), BASE);
  assert.equal(applyAugmentMcpOverlay(BASE, undefined), BASE);
  assert.equal(applyAugmentMcpOverlay(BASE, ""), BASE);
});

test("augment overlay injects auggie with --mcp --mcp-auto-workspace + session env", () => {
  const out = applyAugmentMcpOverlay(BASE, "fake-session-json");
  assert.equal(out.mcp_servers?.length, 1);
  const s = out.mcp_servers?.[0];
  assert.deepEqual(s, {
    name: "auggie",
    type: "stdio",
    command: ["auggie", "--mcp", "--mcp-auto-workspace"],
    env: { AUGMENT_SESSION_AUTH: "fake-session-json" },
  });
});

test("augment overlay accepts a custom binary path (e.g. NVM-managed install)", () => {
  const out = applyAugmentMcpOverlay(BASE, "session", "/home/me/.nvm/bin/auggie");
  assert.deepEqual(out.mcp_servers?.[0].command, [
    "/home/me/.nvm/bin/auggie",
    "--mcp",
    "--mcp-auto-workspace",
  ]);
});

test("augment overlay does NOT duplicate when auggie is already in mcp_servers", () => {
  const req: RunRequest = {
    ...BASE,
    mcp_servers: [
      { name: "auggie", type: "stdio", command: ["custom-auggie"] },
    ],
  };
  const out = applyAugmentMcpOverlay(req, "session");
  assert.equal(out.mcp_servers?.length, 1);
  // Caller-supplied entry wins.
  assert.deepEqual(out.mcp_servers?.[0].command, ["custom-auggie"]);
});

test("augment overlay coexists with browser + memory overlays in mcp_servers", () => {
  const req: RunRequest = {
    ...BASE,
    mcp_servers: [
      { name: "claudeos-browser", type: "stdio", command: ["node", "/b.mjs"] },
      { name: "claudeos-memory", type: "stdio", command: ["node", "/m.mjs"] },
    ],
  };
  const out = applyAugmentMcpOverlay(req, "session");
  assert.equal(out.mcp_servers?.length, 3);
  assert.equal(out.mcp_servers?.[2].name, "auggie");
});

test("augment overlay is pure — does not mutate the input request", () => {
  const req: RunRequest = { ...BASE, mcp_servers: [] };
  const out = applyAugmentMcpOverlay(req, "session");
  assert.notEqual(out, req);
  assert.equal(req.mcp_servers?.length, 0);
  assert.equal(out.mcp_servers?.length, 1);
});
