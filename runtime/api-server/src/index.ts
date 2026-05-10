import { randomUUID } from "node:crypto";

import corsPlugin from "@fastify/cors";
import multipartPlugin from "@fastify/multipart";
import websocketPlugin from "@fastify/websocket";
import type { Database as DatabaseType } from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";

import type {
  CreateSessionBody,
  CreateWorkspaceBody,
  McpServerConfig,
  RunRequest,
  Session,
  SubmitRunResponse,
  Workspace,
  WorkspaceHooks,
} from "@claudeos/runtime-client/contracts";

import { defaultDbPath, openDb } from "./db.js";
import { EventBus } from "./event-bus.js";
import { RunManager } from "./runs.js";
import {
  TemplateError,
  applyTemplate,
  defaultTemplatesDir,
  listTemplates,
} from "./templates.js";
import { MAX_UPLOAD_BYTES, saveUpload } from "./uploads.js";
import {
  bm25Search,
  defaultWikiDir,
  formatExcerpts,
  loadWikiIndex,
  type WikiDoc,
} from "./wiki.js";
import { WorktreeError, provisionWorktree } from "./worktrees.js";

// ----------------------------------------------------------------------------
// Validation schemas
// ----------------------------------------------------------------------------

const CreateWorkspaceSchema = z.object({
  name: z.string().min(1),
  dir: z.string().min(1),
  template: z.string().min(1).optional(),
});

// a17.8: PATCH accepts either a rename, a hooks update, or both. When the
// caller wants to clear hooks they pass `hooks: null` (the schema allows
// it explicitly so undefined means "leave unchanged").
const HooksSchema = z.object({
  post_tool_use: z.array(z.string().min(1)).optional(),
  stop: z.array(z.string().min(1)).optional(),
});
const UpdateWorkspaceSchema = z
  .object({
    name: z.string().min(1).optional(),
    hooks: z.union([HooksSchema, z.null()]).optional(),
  })
  .refine(
    (v) => v.name !== undefined || v.hooks !== undefined,
    "PATCH body must include at least one of: name, hooks",
  );

const CreateSessionSchema = z.object({
  workspace_id: z.string().min(1),
  /**
   * rec-6: when set, the new session is "forked" from this Claude session
   * id — the first run resumes that conversation via --resume rather than
   * starting fresh. The historical session itself is unchanged; this is
   * just a pointer.
   */
  fork_from_claude_session_id: z.string().min(1).optional(),
});

const SubmitRunSchema = z.object({
  workspace_id: z.string().min(1),
  session_id: z.string().min(1),
  input_id: z.string().min(1),
  instruction: z.string().min(1),
  attachments: z.array(z.unknown()).optional(),
  model: z.string().optional(),
  append_system_prompt: z.string().optional(),
  permission_mode: z
    .enum(["default", "acceptEdits", "plan", "bypassPermissions"])
    .optional(),
  add_dirs: z.array(z.string()).optional(),
  mcp_servers: z.array(z.unknown()).optional(),
  timeout_seconds: z.number().optional(),
  debug: z.boolean().optional(),
});

// ----------------------------------------------------------------------------
// Repository helpers
// ----------------------------------------------------------------------------

interface Repo {
  createWorkspace(body: CreateWorkspaceBody): Workspace;
  listWorkspaces(): Workspace[];
  getWorkspace(id: string): Workspace | null;
  renameWorkspace(id: string, name: string): Workspace | null;
  /** a17.8: persist (or clear with `null`) per-workspace hook commands. */
  setHooks(id: string, hooks: WorkspaceHooks | null): Workspace | null;
  deleteWorkspace(id: string): boolean;
  createSession(body: CreateSessionBody): Session;
  getSession(id: string): Session | null;
  listSessions(workspaceId: string, opts: { limit: number; before?: string }): Session[];
}

// a17.8: translate the public Workspace.hooks shape into the harness's
// ExtraHookCommands shape. The two contracts diverge on capitalization
// (snake_case in the SDK contract, PascalCase from Claude Code's settings
// schema). Returns undefined when there's nothing to forward — the
// harness uses `undefined` as the "no extras" signal so the per-run
// settings file stays minimal.
export function toExtraHooks(
  hooks: WorkspaceHooks | null | undefined,
): { PostToolUse?: string[]; Stop?: string[] } | undefined {
  if (!hooks) return undefined;
  const out: { PostToolUse?: string[]; Stop?: string[] } = {};
  if (hooks.post_tool_use && hooks.post_tool_use.length > 0) {
    out.PostToolUse = hooks.post_tool_use;
  }
  if (hooks.stop && hooks.stop.length > 0) {
    out.Stop = hooks.stop;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// a17.8: parse the hooks_json column into the public Workspace shape.
// Defensive — if the row was migrated mid-write or someone hand-edited
// the DB, fall back to null rather than throwing.
function parseWorkspaceHooks(raw: unknown): WorkspaceHooks | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<WorkspaceHooks>;
    return {
      ...(Array.isArray(parsed.post_tool_use)
        ? {
            post_tool_use: parsed.post_tool_use.filter(
              (s): s is string => typeof s === "string",
            ),
          }
        : {}),
      ...(Array.isArray(parsed.stop)
        ? {
            stop: parsed.stop.filter((s): s is string => typeof s === "string"),
          }
        : {}),
    };
  } catch {
    return null;
  }
}

function createRepo(db: DatabaseType): Repo {
  return {
    createWorkspace(body) {
      const now = new Date().toISOString();
      const ws: Workspace = {
        id: randomUUID(),
        name: body.name,
        dir: body.dir,
        created_at: now,
        updated_at: now,
        hooks: null,
      };
      db.prepare(
        `INSERT INTO workspaces (id, name, dir, created_at, updated_at, hooks_json)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      ).run(ws.id, ws.name, ws.dir, ws.created_at, ws.updated_at);
      return ws;
    },
    listWorkspaces() {
      const rows = db
        .prepare(
          `SELECT id, name, dir, created_at, updated_at, hooks_json
             FROM workspaces ORDER BY created_at DESC`,
        )
        .all() as Array<Workspace & { hooks_json: string | null }>;
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        dir: r.dir,
        created_at: r.created_at,
        updated_at: r.updated_at,
        hooks: parseWorkspaceHooks(r.hooks_json),
      }));
    },
    getWorkspace(id) {
      const row = db
        .prepare(
          `SELECT id, name, dir, created_at, updated_at, hooks_json
             FROM workspaces WHERE id = ?`,
        )
        .get(id) as
        | (Workspace & { hooks_json: string | null })
        | undefined;
      if (!row) return null;
      return {
        id: row.id,
        name: row.name,
        dir: row.dir,
        created_at: row.created_at,
        updated_at: row.updated_at,
        hooks: parseWorkspaceHooks(row.hooks_json),
      };
    },
    renameWorkspace(id, name) {
      const now = new Date().toISOString();
      const result = db
        .prepare(`UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?`)
        .run(name, now, id);
      if (result.changes === 0) return null;
      return this.getWorkspace(id);
    },
    setHooks(id, hooks) {
      const now = new Date().toISOString();
      // Strip empty arrays so the persisted JSON stays minimal and the UI
      // can treat absence as "use defaults" without parsing edge cases.
      const cleaned: WorkspaceHooks | null = hooks
        ? {
            ...(hooks.post_tool_use && hooks.post_tool_use.length > 0
              ? { post_tool_use: hooks.post_tool_use }
              : {}),
            ...(hooks.stop && hooks.stop.length > 0 ? { stop: hooks.stop } : {}),
          }
        : null;
      const json =
        cleaned && Object.keys(cleaned).length > 0 ? JSON.stringify(cleaned) : null;
      const result = db
        .prepare(`UPDATE workspaces SET hooks_json = ?, updated_at = ? WHERE id = ?`)
        .run(json, now, id);
      if (result.changes === 0) return null;
      return this.getWorkspace(id);
    },
    deleteWorkspace(id) {
      // ON DELETE CASCADE drops sessions → runs → run_events automatically.
      const result = db.prepare(`DELETE FROM workspaces WHERE id = ?`).run(id);
      return result.changes > 0;
    },
    createSession(body) {
      const now = new Date().toISOString();
      // rec-6: optional fork from an existing claude_session_id. When set,
      // the first run resumes that conversation instead of starting cold.
      const claudeSessionId = body.fork_from_claude_session_id ?? null;
      const session: Session = {
        id: randomUUID(),
        workspace_id: body.workspace_id,
        claude_session_id: claudeSessionId,
        created_at: now,
        updated_at: now,
      };
      db.prepare(
        `INSERT INTO sessions (id, workspace_id, claude_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        session.id,
        session.workspace_id,
        claudeSessionId,
        session.created_at,
        session.updated_at,
      );
      return session;
    },
    getSession(id) {
      const row = db
        .prepare(
          `SELECT id, workspace_id, claude_session_id, created_at, updated_at FROM sessions WHERE id = ?`,
        )
        .get(id) as Session | undefined;
      return row ?? null;
    },
    listSessions(workspaceId, { limit, before }) {
      // Newest-first cursor pagination on created_at. We over-fetch by 1 and
      // tie-break on id so callers using `before=<created_at>` can't loop on
      // sessions sharing a millisecond.
      const stmt = before
        ? db.prepare(
            `SELECT id, workspace_id, claude_session_id, created_at, updated_at
               FROM sessions
              WHERE workspace_id = ? AND created_at < ?
              ORDER BY created_at DESC, id DESC
              LIMIT ?`,
          )
        : db.prepare(
            `SELECT id, workspace_id, claude_session_id, created_at, updated_at
               FROM sessions
              WHERE workspace_id = ?
              ORDER BY created_at DESC, id DESC
              LIMIT ?`,
          );
      return (
        before
          ? (stmt.all(workspaceId, before, limit) as Session[])
          : (stmt.all(workspaceId, limit) as Session[])
      );
    },
  };
}

// ----------------------------------------------------------------------------
// App factory
// ----------------------------------------------------------------------------

export interface ServerOptions {
  port?: number;
  host?: string;
  dbPath?: string;
  /**
   * Allowed CORS origins for the Vite dev renderer.
   * Production Electron loads `file://` (no Origin header) so CORS is a no-op there.
   * Defaults to `["http://localhost:5173"]`. Pass `false` to disable entirely.
   */
  corsOrigins?: string[] | false;
  /**
   * Absolute path to the ClaudeOS browser MCP server entry (e.g. the built
   * `packages/browser-mcp/dist/index.mjs`). When set, every submitted run
   * gets `claudeos-browser` injected into `mcp_servers` if not already
   * present, so Claude Code can drive a real browser.
   */
  browserMcpBin?: string | null;
  /**
   * Absolute path to the ClaudeOS memory MCP server entry (e.g. the built
   * `packages/memory-mcp/dist/index.mjs`). When set, every submitted run
   * gets `claudeos-memory` injected into `mcp_servers`, exposing the
   * AgenticOS `bd` memory layer so the agent can `memory_remember`,
   * `memory_recall`, etc. inside the run. ajr.1.
   */
  memoryMcpBin?: string | null;
  /**
   * Absolute path to the ClaudeOS permission-hook launcher
   * (`packages/claude-cli/permission-hook.js`). When set, runs are configured
   * with a per-run --settings file that defers tool calls so the desktop can
   * collect approve/deny decisions before they execute (xh4.2).
   */
  permissionHookBin?: string | null;
  /**
   * Directory containing workspace templates. Each subdirectory is one
   * template, with a `template.json` manifest and seed files. Defaults to
   * the templates dir shipped alongside the api-server build.
   */
  templatesDir?: string;
  /**
   * Augment Context Engine session JSON (output of `auggie token print`).
   * When set, every run gets the `auggie` MCP server injected with this
   * value forwarded as the `AUGMENT_SESSION_AUTH` env var. Read from
   * `CLAUDEOS_AUGMENT_SESSION_AUTH` in the CLI entry. kobramaz-a17.1.
   */
  augmentSessionAuth?: string | null;
  /**
   * Wiki dir for retrieval-at-dispatch (kobramaz-a17.5). When set, every
   * run runs a BM25 search of the user's instruction against the wiki
   * markdown corpus and prepends top-K excerpts to `append_system_prompt`.
   * Pass `false` to disable; default reads CLAUDEOS_WIKI_DIR or `~/wiki`.
   */
  wikiDir?: string | false;
  /** Number of top matches to inject. Default 3. */
  wikiTopK?: number;
}

// Both forms — the dev launcher loads the renderer from http://127.0.0.1:5173
// so the BrowserWindow's origin matches, but allow `localhost` too in case the
// user overrides VITE_DEV_SERVER_URL or runs the renderer outside the launcher.
const DEFAULT_DEV_ORIGINS = ["http://127.0.0.1:5173", "http://localhost:5173"];

/**
 * Canonical MCP server name for the ClaudeOS browser MCP. Mirrors the
 * `BROWSER_MCP_NAME` constant exported by `@claudeos/browser-mcp` — duplicated
 * here as a string literal to avoid a runtime dep on that package.
 */
const BROWSER_MCP_NAME = "claudeos-browser";

/**
 * Same pattern, for the memory MCP. Duplicated to keep the api-server
 * dependency-free of `@claudeos/memory-mcp` itself.
 */
const MEMORY_MCP_NAME = "claudeos-memory";

/**
 * Augment Code's Context Engine MCP (kobramaz-a17.1). Hosted by Augment
 * via their `auggie` CLI in stdio mode — repo-scale semantic RAG that
 * indexes the user's codebase and exposes a `codebase-retrieval` tool.
 * Opt-in via the `AUGMENT_SESSION_AUTH` env var (set
 * `CLAUDEOS_AUGMENT_SESSION_AUTH` on the api-server; we forward it to the
 * MCP child as `AUGMENT_SESSION_AUTH`).
 */
const AUGGIE_MCP_NAME = "auggie";

/**
 * Inject the browser MCP into a run request's `mcp_servers` list when the
 * api-server is configured with one. Existing user-supplied entries (and any
 * pre-existing `claudeos-browser` entry) are preserved.
 */
export function applyBrowserMcpOverlay(
  request: RunRequest,
  browserMcpBin: string | null | undefined,
): RunRequest {
  if (!browserMcpBin) return request;
  const existing = request.mcp_servers ?? [];
  if (existing.some((s) => s.name === BROWSER_MCP_NAME)) return request;
  const overlay: McpServerConfig = {
    name: BROWSER_MCP_NAME,
    type: "stdio",
    command: ["node", browserMcpBin],
  };
  return { ...request, mcp_servers: [...existing, overlay] };
}

/**
 * Inject the Augment Context Engine MCP when the operator has signed in
 * via `auggie login` and surfaced the session JSON to ClaudeOS. The
 * spawned child runs `auggie --mcp --mcp-auto-workspace`, which Augment
 * documents as the supported integration for stdio MCP hosts. Existing
 * caller-supplied entries are preserved; if the user already configured
 * `auggie` via mcp_servers we don't override them.
 */
export function applyAugmentMcpOverlay(
  request: RunRequest,
  sessionAuth: string | null | undefined,
  binary: string = "auggie",
): RunRequest {
  if (!sessionAuth) return request;
  const existing = request.mcp_servers ?? [];
  if (existing.some((s) => s.name === AUGGIE_MCP_NAME)) return request;
  const overlay: McpServerConfig = {
    name: AUGGIE_MCP_NAME,
    type: "stdio",
    command: [binary, "--mcp", "--mcp-auto-workspace"],
    env: { AUGMENT_SESSION_AUTH: sessionAuth },
  };
  return { ...request, mcp_servers: [...existing, overlay] };
}

/**
 * Inject the memory MCP. Same overlay shape as the browser MCP but also
 * passes through env vars so the spawned child can find `bd` and namespace
 * its writes correctly.
 */
export function applyMemoryMcpOverlay(
  request: RunRequest,
  memoryMcpBin: string | null | undefined,
  env?: { bdBinary?: string | null; writePrefix?: string | null },
): RunRequest {
  if (!memoryMcpBin) return request;
  const existing = request.mcp_servers ?? [];
  if (existing.some((s) => s.name === MEMORY_MCP_NAME)) return request;
  const childEnv: Record<string, string> = {};
  if (env?.bdBinary) childEnv.CLAUDEOS_BD_BIN = env.bdBinary;
  if (env?.writePrefix) childEnv.CLAUDEOS_MEMORY_PREFIX = env.writePrefix;
  const overlay: McpServerConfig = {
    name: MEMORY_MCP_NAME,
    type: "stdio",
    command: ["node", memoryMcpBin],
    ...(Object.keys(childEnv).length > 0 ? { env: childEnv } : {}),
  };
  return { ...request, mcp_servers: [...existing, overlay] };
}

export async function createServer(opts: ServerOptions = {}): Promise<FastifyInstance> {
  const db = openDb(opts.dbPath ?? defaultDbPath());
  const repo = createRepo(db);
  const bus = new EventBus();
  const runs = new RunManager(db, bus, { permissionHookBin: opts.permissionHookBin });

  // rec-5: wiki retrieval. Load lazily on first use so a missing/empty
  // wiki dir is a silent no-op rather than a startup cost.
  const wikiResolvedDir =
    opts.wikiDir === false ? null : (opts.wikiDir ?? defaultWikiDir());
  const wikiTopK = opts.wikiTopK ?? 3;
  let wikiCache: WikiDoc[] | null = null;
  let wikiLoaded = false;
  const getWikiDocs = (): WikiDoc[] => {
    if (wikiResolvedDir === null) return [];
    if (!wikiLoaded) {
      try {
        wikiCache = loadWikiIndex(wikiResolvedDir);
      } catch {
        wikiCache = [];
      }
      wikiLoaded = true;
    }
    return wikiCache ?? [];
  };

  const app = Fastify({ logger: { level: "info" } });

  if (opts.corsOrigins !== false) {
    const origins = opts.corsOrigins ?? DEFAULT_DEV_ORIGINS;
    await app.register(corsPlugin, {
      origin: origins,
      methods: ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"],
    });
  }

  await app.register(websocketPlugin);
  await app.register(multipartPlugin, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  });

  app.get("/health", async () => ({ ok: true }));

  const templatesDir = opts.templatesDir ?? defaultTemplatesDir();

  // -- Templates ------------------------------------------------------------

  app.get("/templates", async () => listTemplates(templatesDir));

  // -- Workspaces -----------------------------------------------------------

  app.post("/workspaces", async (request, reply) => {
    const parsed = CreateWorkspaceSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.format() });
    if (parsed.data.template) {
      try {
        applyTemplate(parsed.data.template, parsed.data.dir, templatesDir);
      } catch (err) {
        if (err instanceof TemplateError) {
          const status = err.code === "not_found" ? 404 : 400;
          return reply.code(status).send({ error: err.message, code: err.code });
        }
        throw err;
      }
    }
    return repo.createWorkspace(parsed.data);
  });

  app.get("/workspaces", async () => repo.listWorkspaces());

  app.get<{ Params: { id: string } }>("/workspaces/:id", async (request, reply) => {
    const ws = repo.getWorkspace(request.params.id);
    if (!ws) return reply.code(404).send({ error: "workspace not found" });
    return ws;
  });

  app.patch<{ Params: { id: string } }>(
    "/workspaces/:id",
    async (request, reply) => {
      const parsed = UpdateWorkspaceSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.format() });
      let result = repo.getWorkspace(request.params.id);
      if (!result) return reply.code(404).send({ error: "workspace not found" });
      if (parsed.data.name !== undefined) {
        result = repo.renameWorkspace(request.params.id, parsed.data.name);
        if (!result) return reply.code(404).send({ error: "workspace not found" });
      }
      if (parsed.data.hooks !== undefined) {
        result = repo.setHooks(request.params.id, parsed.data.hooks);
        if (!result) return reply.code(404).send({ error: "workspace not found" });
      }
      return result;
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/workspaces/:id",
    async (request, reply) => {
      const ok = repo.deleteWorkspace(request.params.id);
      if (!ok) return reply.code(404).send({ error: "workspace not found" });
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/workspaces/:id/uploads",
    async (request, reply) => {
      const ws = repo.getWorkspace(request.params.id);
      if (!ws) return reply.code(404).send({ error: "workspace not found" });

      if (!request.isMultipart()) {
        return reply.code(415).send({ error: "expected multipart/form-data" });
      }

      let file;
      try {
        file = await request.file();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: message });
      }
      if (!file) return reply.code(400).send({ error: "no file provided" });

      let bytes: Buffer;
      try {
        bytes = await file.toBuffer();
      } catch (err) {
        // @fastify/multipart throws RequestFileTooLargeError when the limit is hit.
        const message = err instanceof Error ? err.message : String(err);
        const tooLarge = /file.*too large|fileSize/i.test(message);
        return reply.code(tooLarge ? 413 : 400).send({ error: message });
      }

      const attachment = await saveUpload({
        workspaceDir: ws.dir,
        filename: file.filename,
        mimeType: file.mimetype,
        bytes,
      });
      return attachment;
    },
  );

  // -- Sessions -------------------------------------------------------------

  app.post("/sessions", async (request, reply) => {
    const parsed = CreateSessionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.format() });
    if (!repo.getWorkspace(parsed.data.workspace_id)) {
      return reply.code(404).send({ error: "workspace not found" });
    }
    return repo.createSession(parsed.data);
  });

  app.get<{ Params: { id: string } }>("/sessions/:id", async (request, reply) => {
    const session = repo.getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    return session;
  });

  // History listings — cursor pagination on created_at/started_at DESC.
  // `next_before` is the ISO cursor for the next (older) page, or null at the end.
  const HISTORY_DEFAULT_LIMIT = 50;
  const HISTORY_MAX_LIMIT = 200;
  const HistoryQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(HISTORY_MAX_LIMIT).optional(),
    before: z.string().datetime().optional(),
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string; before?: string } }>(
    "/workspaces/:id/sessions",
    async (request, reply) => {
      if (!repo.getWorkspace(request.params.id)) {
        return reply.code(404).send({ error: "workspace not found" });
      }
      const parsed = HistoryQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.format() });
      const limit = parsed.data.limit ?? HISTORY_DEFAULT_LIMIT;
      const items = repo.listSessions(request.params.id, { limit, before: parsed.data.before });
      const next_before = items.length === limit ? items[items.length - 1].created_at : null;
      return { items, next_before };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string; before?: string } }>(
    "/sessions/:id/runs",
    async (request, reply) => {
      if (!repo.getSession(request.params.id)) {
        return reply.code(404).send({ error: "session not found" });
      }
      const parsed = HistoryQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.format() });
      const limit = parsed.data.limit ?? HISTORY_DEFAULT_LIMIT;
      const items = runs.listRunsForSession(request.params.id, {
        limit,
        before: parsed.data.before,
      });
      const next_before = items.length === limit ? items[items.length - 1].started_at : null;
      return { items, next_before };
    },
  );

  // -- Runs -----------------------------------------------------------------

  app.post("/runs", async (request, reply): Promise<SubmitRunResponse | { error: unknown }> => {
    const parsed = SubmitRunSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: parsed.error.format() };
    }
    const baseRequest = parsed.data as RunRequest;
    // rec-5: prepend top-K wiki excerpts to append_system_prompt before
    // the harness sees the request. Empty wiki / no matches = no-op.
    const wikiDocs = getWikiDocs();
    let withWiki: RunRequest = baseRequest;
    if (wikiDocs.length > 0) {
      const matches = bm25Search(wikiDocs, baseRequest.instruction, wikiTopK);
      const block = formatExcerpts(matches);
      if (block.length > 0) {
        withWiki = {
          ...baseRequest,
          append_system_prompt: baseRequest.append_system_prompt
            ? `${block}\n\n${baseRequest.append_system_prompt}`
            : block,
        };
      }
    }
    const runRequest = applyAugmentMcpOverlay(
      applyMemoryMcpOverlay(
        applyBrowserMcpOverlay(withWiki, opts.browserMcpBin),
        opts.memoryMcpBin,
      ),
      opts.augmentSessionAuth,
    );
    const workspace = repo.getWorkspace(runRequest.workspace_id);
    if (!workspace) {
      reply.code(404);
      return { error: "workspace not found" };
    }
    const session = repo.getSession(runRequest.session_id);
    if (!session) {
      reply.code(404);
      return { error: "session not found" };
    }
    if (session.workspace_id !== workspace.id) {
      reply.code(400);
      return { error: "session does not belong to workspace" };
    }

    const runId = runs.submit(
      workspace.dir,
      session.claude_session_id,
      runRequest,
      toExtraHooks(workspace.hooks),
    );
    return {
      run_id: runId,
      session_id: runRequest.session_id,
      input_id: runRequest.input_id,
    };
  });

  app.get<{ Params: { id: string } }>("/runs/:id", async (request, reply) => {
    const run = runs.getRun(request.params.id);
    if (!run) return reply.code(404).send({ error: "run not found" });
    return run;
  });

  // bsky-1: cross-workspace active-run dashboard. The renderer polls this
  // every few seconds to keep Mission Control fresh. Backed by a single
  // SQL join (no per-row lookups) so the cost is constant in the number
  // of running runs rather than the count of historical runs.
  app.get("/active-runs", async () => {
    const rows = runs.listActiveRuns();
    return rows.map((r) => ({
      run: r.run,
      workspace_id: r.workspace_id,
      workspace_name: r.workspace_name,
      claude_session_id: r.claude_session_id,
      session_id: r.run.session_id,
    }));
  });

  app.get<{ Params: { id: string } }>("/runs/:id/events", async (request, reply) => {
    const run = runs.getRun(request.params.id);
    if (!run) return reply.code(404).send({ error: "run not found" });
    return runs.listEvents(request.params.id);
  });

  app.post<{ Params: { id: string } }>("/runs/:id/cancel", async (request, reply) => {
    const ok = runs.cancel(request.params.id);
    if (!ok) return reply.code(404).send({ error: "run not active" });
    return { ok: true };
  });

  // -- Parallel runs (rec-3 / kobramaz-a17.3) -------------------------------
  // Provisions a fresh git worktree per prompt and dispatches all runs
  // concurrently. Each worktree gets a throwaway branch so the operator
  // can inspect/merge later via `git diff main..claudeos/<ws>/<name>`.
  const ParallelRunsSchema = z.object({
    workspace_id: z.string().min(1),
    prompts: z
      .array(
        z.object({
          name: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
          instruction: z.string().min(1),
          model: z.string().optional(),
          permission_mode: z
            .enum(["default", "acceptEdits", "plan", "bypassPermissions"])
            .optional(),
        }),
      )
      .min(1)
      .max(8),
  });
  app.post("/parallel-runs", async (request, reply) => {
    const parsed = ParallelRunsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.format() });
    const workspace = repo.getWorkspace(parsed.data.workspace_id);
    if (!workspace) return reply.code(404).send({ error: "workspace not found" });

    const dispatched: Array<{
      run_id: string;
      session_id: string;
      worktree_path: string;
      name: string;
    }> = [];

    for (const prompt of parsed.data.prompts) {
      let worktreePath: string;
      try {
        worktreePath = await provisionWorktree({
          workspaceDir: workspace.dir,
          workspaceId: workspace.id,
          runName: `${prompt.name}-${Date.now()}`,
        });
      } catch (err) {
        if (err instanceof WorktreeError) {
          return reply.code(400).send({
            error: err.message,
            code: err.code,
            partial: dispatched,
          });
        }
        throw err;
      }
      // Each parallel run is its own session — they're independent
      // conversations even though they share a workspace + base commit.
      const session = repo.createSession({ workspace_id: workspace.id });
      const runRequest = applyAugmentMcpOverlay(
        applyMemoryMcpOverlay(
          applyBrowserMcpOverlay(
            {
              workspace_id: workspace.id,
              session_id: session.id,
              input_id: `parallel-${session.id}`,
              instruction: prompt.instruction,
              ...(prompt.model ? { model: prompt.model } : {}),
              ...(prompt.permission_mode ? { permission_mode: prompt.permission_mode } : {}),
            },
            opts.browserMcpBin,
          ),
          opts.memoryMcpBin,
        ),
        opts.augmentSessionAuth,
      );
      // a17.8: parallel runs in a worktree still belong to the parent
      // workspace, so they inherit its hooks.
      const runId = runs.submit(
        worktreePath,
        null,
        runRequest,
        toExtraHooks(workspace.hooks),
      );
      dispatched.push({
        run_id: runId,
        session_id: session.id,
        worktree_path: worktreePath,
        name: prompt.name,
      });
    }

    return { runs: dispatched };
  });

  // xh4.2: relay a user permission decision into the harness's awaited callback.
  const PermissionResponseSchema = z.object({
    decision: z.enum(["allow", "deny"]),
    reason: z.string().optional(),
  });
  app.post<{ Params: { id: string } }>(
    "/runs/:id/permission",
    async (request, reply) => {
      const parsed = PermissionResponseSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.format() });
      const ok = runs.respondToPermission(request.params.id, {
        behavior: parsed.data.decision,
        reason: parsed.data.reason,
      });
      if (!ok) return reply.code(404).send({ error: "no pending permission for this run" });
      return { ok: true };
    },
  );

  // -- WebSocket: live event stream per run ---------------------------------

  app.get<{ Params: { id: string } }>(
    "/runs/:id/stream",
    { websocket: true },
    (socket, req) => {
      const runId = (req.params as { id: string }).id;
      const run = runs.getRun(runId);
      if (!run) {
        socket.send(JSON.stringify({ error: "run not found" }));
        socket.close();
        return;
      }

      // Replay any persisted events first so the client never misses one.
      for (const event of runs.listEvents(runId)) {
        socket.send(JSON.stringify(event));
      }

      // If the run already finished, close after replay.
      if (run.status !== "running") {
        socket.close();
        return;
      }

      const unsubscribe = bus.subscribe(runId, (event) => {
        socket.send(JSON.stringify(event));
        if (event.type === "run_completed" || event.type === "run_failed") {
          unsubscribe();
          socket.close();
        }
      });

      socket.on("close", () => unsubscribe());
    },
  );

  app.addHook("onClose", async () => {
    db.close();
  });

  if (opts.port !== undefined) {
    await app.listen({ port: opts.port, host: opts.host ?? "127.0.0.1" });
  }
  return app;
}

// ----------------------------------------------------------------------------
// CLI entry
// ----------------------------------------------------------------------------

async function main(): Promise<void> {
  const port = Number(process.env.CLAUDEOS_PORT ?? 7878);
  const host = process.env.CLAUDEOS_HOST ?? "127.0.0.1";
  const corsOrigins = parseCorsOriginsEnv(process.env.CLAUDEOS_CORS_ORIGINS);
  const browserMcpBin = process.env.CLAUDEOS_BROWSER_MCP_BIN ?? null;
  const memoryMcpBin = process.env.CLAUDEOS_MEMORY_MCP_BIN ?? null;
  const permissionHookBin = process.env.CLAUDEOS_PERMISSION_HOOK_BIN ?? null;
  const augmentSessionAuth = process.env.CLAUDEOS_AUGMENT_SESSION_AUTH ?? null;
  // rec-5: explicit opt-out via CLAUDEOS_WIKI_DIR=off; otherwise resolved
  // by defaultWikiDir() to ~/wiki or whatever the env points to.
  const wikiDirEnv = process.env.CLAUDEOS_WIKI_DIR;
  const wikiDir: string | false | undefined =
    wikiDirEnv === "off" || wikiDirEnv === "false" ? false : undefined;
  const app = await createServer({
    port,
    host,
    corsOrigins,
    browserMcpBin,
    memoryMcpBin,
    permissionHookBin,
    augmentSessionAuth,
    wikiDir,
  });
  app.log.info(`ClaudeOS api-server listening on ${host}:${port}`);
}

function parseCorsOriginsEnv(value: string | undefined): string[] | false | undefined {
  if (value === undefined) return undefined;
  if (value === "false" || value === "off") return false;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
