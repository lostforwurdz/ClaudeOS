/**
 * Stdio entry for the ClaudeOS browser MCP server. Spawned as a subprocess
 * from a Claude Code session via `--mcp-config`.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createBrowserHandle } from "./browser.js";
import { createBrowserMcpServer } from "./server.js";

async function main(): Promise<void> {
  const headless = process.env.CLAUDEOS_BROWSER_HEADLESS !== "false";
  const browser = createBrowserHandle({ headless });
  const server = createBrowserMcpServer({ browser });

  // Ensure the browser dies when the parent (claude) closes our stdio.
  const shutdown = async (): Promise<void> => {
    try {
      await browser.shutdown();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Important: log to stderr only. stdout is the JSON-RPC channel.
  console.error(`[browser-mcp] running on stdio (headless=${headless})`);
}

main().catch((err) => {
  console.error("[browser-mcp] fatal:", err);
  process.exit(1);
});
