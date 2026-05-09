#!/usr/bin/env node

// src/index.ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// src/bd.ts
import { execFile } from "child_process";
import { promisify } from "util";
var execFileP = promisify(execFile);
async function runBd(binary, args) {
  try {
    const { stdout } = await execFileP(binary, args, { maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const e = err;
    const tail = (e.stderr ?? "").trim().split(/\r?\n/).slice(-3).join("\n");
    throw new Error(`bd ${args.join(" ")} failed: ${tail || e.message || "(no detail)"}`);
  }
}
function createBdRunner(opts = {}) {
  const binary = opts.binary ?? "bd";
  return {
    async remember(key, value) {
      await runBd(binary, ["remember", value, "--key", key]);
    },
    async recall(key) {
      try {
        const stdout = await runBd(binary, ["recall", key, "--json"]);
        const parsed = JSON.parse(stdout);
        const value = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
        return { key, value };
      } catch {
        return null;
      }
    },
    async memories(search) {
      const args = ["memories", "--json"];
      if (search && search.trim().length > 0) args.splice(1, 0, search);
      const stdout = await runBd(binary, args);
      const obj = JSON.parse(stdout);
      return Object.entries(obj).map(([key, raw]) => ({
        key,
        value: typeof raw === "string" ? raw : JSON.stringify(raw)
      })).sort((a, b) => a.key.localeCompare(b.key));
    },
    async forget(key) {
      try {
        await runBd(binary, ["forget", key]);
        return true;
      } catch {
        return false;
      }
    }
  };
}

// src/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
var MEMORY_MCP_NAME = "claudeos-memory";
var MEMORY_MCP_VERSION = "0.0.0";
function createMemoryMcpServer(opts) {
  const writePrefix = opts.writePrefix ?? "claudeos.";
  const server = new McpServer(
    { name: MEMORY_MCP_NAME, version: MEMORY_MCP_VERSION },
    {
      instructions: `Persistent memory backed by AgenticOS \`bd\`. Use \`memory_remember\` to save an insight (auto-prefixed with "${writePrefix}"), \`memory_recall\` to fetch by full key, \`memory_search\` to list/grep all keys, \`memory_forget\` to remove. Memories are operator-visible and feed the nightly wiki compile.`
    }
  );
  server.registerTool(
    "memory_remember",
    {
      description: `Save a value under a key. The key is auto-prefixed with "${writePrefix}" to namespace ClaudeOS-written entries. If the key exists, the value is overwritten.`,
      inputSchema: z.object({
        key: z.string().min(1).max(200).describe(`Logical key. Stored as "${writePrefix}<key>".`),
        value: z.string().min(1).describe("Insight to remember. Free-form text; will be re-read verbatim.")
      })
    },
    async ({ key, value }) => {
      const fullKey = `${writePrefix}${key}`;
      await opts.bd.remember(fullKey, value);
      return {
        content: [
          { type: "text", text: JSON.stringify({ stored_key: fullKey, ok: true }) }
        ]
      };
    }
  );
  server.registerTool(
    "memory_recall",
    {
      description: `Fetch one memory by FULL key (no auto-prefix). Returns null when the key is unset. Use \`memory_search\` to discover keys.`,
      inputSchema: z.object({
        key: z.string().min(1).describe("Full bd key, including any prefix.")
      })
    },
    async ({ key }) => {
      const entry = await opts.bd.recall(key);
      return {
        content: [
          {
            type: "text",
            text: entry === null ? JSON.stringify({ key, value: null }) : JSON.stringify(entry)
          }
        ]
      };
    }
  );
  server.registerTool(
    "memory_search",
    {
      description: "List all memories, or filter by a substring across keys+values. Returns full keys.",
      inputSchema: z.object({
        query: z.string().min(1).optional().describe("Optional substring filter. Omit to list everything."),
        max_results: z.number().int().positive().max(500).optional().describe("Truncate the result list. Default 100.")
      })
    },
    async ({ query, max_results }) => {
      const limit = max_results ?? 100;
      const all = await opts.bd.memories(query);
      const truncated = all.slice(0, limit);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              count: truncated.length,
              total: all.length,
              items: truncated
            })
          }
        ]
      };
    }
  );
  server.registerTool(
    "memory_forget",
    {
      description: "Delete one memory by full key. Returns ok:false if the key was unknown.",
      inputSchema: z.object({
        key: z.string().min(1).describe("Full bd key, including any prefix.")
      })
    },
    async ({ key }) => {
      const ok = await opts.bd.forget(key);
      return {
        content: [{ type: "text", text: JSON.stringify({ key, ok }) }]
      };
    }
  );
  return server;
}

// src/index.ts
async function main() {
  const bdBinary = process.env.CLAUDEOS_BD_BIN ?? "bd";
  const writePrefix = process.env.CLAUDEOS_MEMORY_PREFIX ?? "claudeos.";
  const bd = createBdRunner({ binary: bdBinary });
  const server = createMemoryMcpServer({ bd, writePrefix });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[memory-mcp] running on stdio (bd=${bdBinary}, prefix="${writePrefix}")`
  );
}
main().catch((err) => {
  console.error("[memory-mcp] fatal:", err);
  process.exit(1);
});
//# sourceMappingURL=index.mjs.map