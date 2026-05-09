/**
 * Stdio entry for the ClaudeOS memory MCP server. Spawned by Claude Code
 * via `--mcp-config` (auto-injected by the api-server's overlay).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createBdRunner } from "./bd.js";
import { createMemoryMcpServer } from "./server.js";

async function main(): Promise<void> {
  const bdBinary = process.env.CLAUDEOS_BD_BIN ?? "bd";
  const writePrefix = process.env.CLAUDEOS_MEMORY_PREFIX ?? "claudeos.";

  const bd = createBdRunner({ binary: bdBinary });
  const server = createMemoryMcpServer({ bd, writePrefix });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stdout is the JSON-RPC channel — log to stderr only.
  console.error(
    `[memory-mcp] running on stdio (bd=${bdBinary}, prefix="${writePrefix}")`,
  );
}

main().catch((err) => {
  console.error("[memory-mcp] fatal:", err);
  process.exit(1);
});
