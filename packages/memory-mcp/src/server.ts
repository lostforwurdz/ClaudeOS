/**
 * ClaudeOS memory MCP server.
 *
 * Wraps the AgenticOS memory layers so a Claude Code subprocess inside
 * ClaudeOS can read/write the same store the operator uses outside it:
 *
 *   - `bd remember` / `bd recall` / `bd memories` / `bd forget` are the
 *     explicit, operator-curated KV layer. Entries flow into the wiki
 *     compiler nightly (Karpathy LLM-KB pattern: bd + episodic → wiki).
 *
 * Why this isn't a new store: AgenticOS already has four memory layers
 * (bd memory, bd issues, episodic-memory, ~/wiki). Adding a fifth
 * islanded layer inside ClaudeOS would duplicate `bd remember`'s job and
 * miss the wiki-compiler pipeline. ajr.1.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { BdRunner } from "./bd.js";

export interface MemoryServerOptions {
  /** bd CLI wrapper. Injectable so tests stub the subprocess. */
  bd: BdRunner;
  /**
   * Optional namespace prefix prepended to every key the agent writes. The
   * agent passes a "logical" key like `current-task`; this server stores it
   * as `<prefix><logical>` in bd. Default: `claudeos.`. Override with the
   * env var `CLAUDEOS_MEMORY_PREFIX` at the entry point.
   *
   * Reads (recall, memories) accept the FULL key as bd stores it — they
   * don't auto-prefix, because the agent may also want to read operator
   * memories outside the ClaudeOS namespace.
   */
  writePrefix?: string;
}

export const MEMORY_MCP_NAME = "claudeos-memory";
export const MEMORY_MCP_VERSION = "0.0.0";

export function createMemoryMcpServer(opts: MemoryServerOptions): McpServer {
  const writePrefix = opts.writePrefix ?? "claudeos.";

  const server = new McpServer(
    { name: MEMORY_MCP_NAME, version: MEMORY_MCP_VERSION },
    {
      instructions:
        `Persistent memory backed by AgenticOS \`bd\`. ` +
        `Use \`memory_remember\` to save an insight (auto-prefixed with "${writePrefix}"), ` +
        `\`memory_recall\` to fetch by full key, \`memory_search\` to list/grep all keys, ` +
        `\`memory_forget\` to remove. Memories are operator-visible and feed the nightly wiki compile.`,
    },
  );

  server.registerTool(
    "memory_remember",
    {
      description:
        `Save a value under a key. The key is auto-prefixed with "${writePrefix}" ` +
        `to namespace ClaudeOS-written entries. If the key exists, the value is overwritten.`,
      inputSchema: z.object({
        key: z
          .string()
          .min(1)
          .max(200)
          .describe(`Logical key. Stored as "${writePrefix}<key>".`),
        value: z
          .string()
          .min(1)
          .describe("Insight to remember. Free-form text; will be re-read verbatim."),
      }),
    },
    async ({ key, value }) => {
      const fullKey = `${writePrefix}${key}`;
      await opts.bd.remember(fullKey, value);
      return {
        content: [
          { type: "text", text: JSON.stringify({ stored_key: fullKey, ok: true }) },
        ],
      };
    },
  );

  server.registerTool(
    "memory_recall",
    {
      description:
        `Fetch one memory by FULL key (no auto-prefix). Returns null when the key is unset. ` +
        `Use \`memory_search\` to discover keys.`,
      inputSchema: z.object({
        key: z.string().min(1).describe("Full bd key, including any prefix."),
      }),
    },
    async ({ key }) => {
      const entry = await opts.bd.recall(key);
      return {
        content: [
          {
            type: "text",
            text: entry === null ? JSON.stringify({ key, value: null }) : JSON.stringify(entry),
          },
        ],
      };
    },
  );

  server.registerTool(
    "memory_search",
    {
      description:
        "List all memories, or filter by a substring across keys+values. Returns full keys.",
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .optional()
          .describe("Optional substring filter. Omit to list everything."),
        max_results: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Truncate the result list. Default 100."),
      }),
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
              items: truncated,
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "memory_forget",
    {
      description: "Delete one memory by full key. Returns ok:false if the key was unknown.",
      inputSchema: z.object({
        key: z.string().min(1).describe("Full bd key, including any prefix."),
      }),
    },
    async ({ key }) => {
      const ok = await opts.bd.forget(key);
      return {
        content: [{ type: "text", text: JSON.stringify({ key, ok }) }],
      };
    },
  );

  return server;
}
