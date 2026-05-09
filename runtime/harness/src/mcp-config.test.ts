import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";

import type { McpServerConfig } from "@claudeos/runtime-client/contracts";

import {
  materializeMcpConfig,
  toClaudeMcpConfig,
} from "./mcp-config.js";

test("toClaudeMcpConfig translates a stdio server with command, args, env", () => {
  const servers: McpServerConfig[] = [
    {
      name: "context7",
      type: "stdio",
      command: ["npx", "-y", "@upstash/context7-mcp"],
      env: { UPSTASH_TOKEN: "abc" },
    },
  ];

  assert.deepEqual(toClaudeMcpConfig(servers), {
    mcpServers: {
      context7: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
        env: { UPSTASH_TOKEN: "abc" },
      },
    },
  });
});

test("toClaudeMcpConfig omits empty args and empty env on stdio servers", () => {
  const servers: McpServerConfig[] = [
    { name: "single", type: "stdio", command: ["my-binary"] },
  ];

  const result = toClaudeMcpConfig(servers);
  assert.deepEqual(result.mcpServers.single, {
    type: "stdio",
    command: "my-binary",
  });
});

test("toClaudeMcpConfig translates sse and http servers with headers", () => {
  const servers: McpServerConfig[] = [
    { name: "remote-sse", type: "sse", url: "https://x.example/sse" },
    {
      name: "remote-http",
      type: "http",
      url: "https://x.example/mcp",
      headers: { Authorization: "Bearer xxx" },
    },
  ];

  const result = toClaudeMcpConfig(servers);
  assert.deepEqual(result.mcpServers["remote-sse"], {
    type: "sse",
    url: "https://x.example/sse",
  });
  assert.deepEqual(result.mcpServers["remote-http"], {
    type: "http",
    url: "https://x.example/mcp",
    headers: { Authorization: "Bearer xxx" },
  });
});

test("toClaudeMcpConfig throws when stdio config is missing command", () => {
  const servers: McpServerConfig[] = [
    { name: "bad", type: "stdio" },
  ];
  assert.throws(() => toClaudeMcpConfig(servers), /missing command/);
});

test("toClaudeMcpConfig throws when sse config is missing url", () => {
  const servers: McpServerConfig[] = [
    { name: "bad", type: "sse" },
  ];
  assert.throws(() => toClaudeMcpConfig(servers), /missing url/);
});

test("toClaudeMcpConfig throws on duplicate server names", () => {
  const servers: McpServerConfig[] = [
    { name: "x", type: "stdio", command: ["a"] },
    { name: "x", type: "stdio", command: ["b"] },
  ];
  assert.throws(() => toClaudeMcpConfig(servers), /duplicate mcp server name: x/);
});

test("materializeMcpConfig writes the JSON to a tempfile and cleanup removes it", () => {
  const servers: McpServerConfig[] = [
    { name: "context7", type: "stdio", command: ["npx", "-y", "@upstash/context7-mcp"] },
  ];

  const handle = materializeMcpConfig(servers);
  try {
    assert.equal(existsSync(handle.path), true);
    const contents = JSON.parse(readFileSync(handle.path, "utf8"));
    assert.deepEqual(contents, {
      mcpServers: {
        context7: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@upstash/context7-mcp"],
        },
      },
    });
    // Sanity: file lives in a directory we own (so cleanup can remove it
    // recursively without nuking unrelated tmpdir content).
    const dirStat = statSync(handle.path);
    assert.equal(dirStat.isFile(), true);
  } finally {
    handle.cleanup();
  }

  assert.equal(existsSync(handle.path), false);
});

test("materializeMcpConfig cleanup is idempotent", () => {
  const handle = materializeMcpConfig([
    { name: "x", type: "stdio", command: ["a"] },
  ]);
  handle.cleanup();
  handle.cleanup(); // second call must not throw
  assert.equal(existsSync(handle.path), false);
});
