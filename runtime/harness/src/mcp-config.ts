/**
 * MCP config materialization.
 *
 * Translates ClaudeOS `McpServerConfig[]` into the JSON shape that Claude Code
 * expects via `--mcp-config <file>`, writes it to a per-run tempfile, and
 * returns a path + cleanup handle.
 *
 * Rationale: the api-server accepts mcp_servers in RunRequest but the harness
 * previously dropped them, so claude only ever inherited the user's
 * `~/.claude.json`. ClaudeOS overlays (e.g. the per-session browser MCP from
 * dcp.1) need explicit materialization to actually reach the subprocess.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { McpServerConfig } from "@claudeos/runtime-client/contracts";

/** Shape Claude Code reads from `--mcp-config <file>`; mirrors `~/.claude.json`. */
export interface ClaudeMcpConfigFile {
  mcpServers: Record<string, ClaudeMcpServerEntry>;
}

export type ClaudeMcpServerEntry =
  | StdioEntry
  | SseEntry
  | HttpEntry;

interface StdioEntry {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface SseEntry {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
}

interface HttpEntry {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

/**
 * Translate the contract-level `McpServerConfig[]` into Claude Code's
 * `mcpServers` map. Throws if a config is missing required fields for its
 * transport (stdio needs a command; sse/http need a url).
 */
export function toClaudeMcpConfig(servers: McpServerConfig[]): ClaudeMcpConfigFile {
  const mcpServers: Record<string, ClaudeMcpServerEntry> = {};
  for (const s of servers) {
    if (!s.name) throw new Error("mcp server config missing name");
    if (mcpServers[s.name]) {
      throw new Error(`duplicate mcp server name: ${s.name}`);
    }
    mcpServers[s.name] = toEntry(s);
  }
  return { mcpServers };
}

function toEntry(s: McpServerConfig): ClaudeMcpServerEntry {
  if (s.type === "stdio") {
    if (!s.command || s.command.length === 0) {
      throw new Error(`stdio mcp server "${s.name}" missing command`);
    }
    const [cmd, ...args] = s.command;
    const entry: StdioEntry = { type: "stdio", command: cmd };
    if (args.length > 0) entry.args = args;
    if (s.env && Object.keys(s.env).length > 0) entry.env = s.env;
    return entry;
  }
  if (s.type === "sse" || s.type === "http") {
    if (!s.url) throw new Error(`${s.type} mcp server "${s.name}" missing url`);
    const entry: SseEntry | HttpEntry = { type: s.type, url: s.url };
    if (s.headers && Object.keys(s.headers).length > 0) entry.headers = s.headers;
    return entry;
  }
  throw new Error(`unsupported mcp server type: ${(s as { type: string }).type}`);
}

export interface MaterializedMcpConfig {
  /** Absolute path to pass via `--mcp-config`. */
  path: string;
  /** Synchronous cleanup; safe to call multiple times. */
  cleanup: () => void;
}

/**
 * Write the translated config to a per-run tempdir and return its path.
 * Caller is responsible for invoking `cleanup()` after the subprocess exits.
 *
 * Tempdir naming: `${os.tmpdir()}/claudeos-mcp-XXXXXX/mcp.json`. The whole
 * directory is removed on cleanup so the JSON file cannot leak.
 */
export function materializeMcpConfig(
  servers: McpServerConfig[],
): MaterializedMcpConfig {
  const config = toClaudeMcpConfig(servers);
  const dir = mkdtempSync(join(tmpdir(), "claudeos-mcp-"));
  const path = join(dir, "mcp.json");
  writeFileSync(path, JSON.stringify(config, null, 2), { encoding: "utf8" });

  let cleaned = false;
  return {
    path,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; the OS will clear tmpdir eventually.
      }
    },
  };
}
