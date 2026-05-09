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

// ----------------------------------------------------------------------------
// Validation schemas
// ----------------------------------------------------------------------------

const CreateWorkspaceSchema = z.object({
  name: z.string().min(1),
  dir: z.string().min(1),
  template: z.string().min(1).optional(),
});

const UpdateWorkspaceSchema = z.object({
  name: z.string().min(1),
});

const CreateSessionSchema = z.object({
  workspace_id: z.string().min(1),
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
  deleteWorkspace(id: string): boolean;
  createSession(body: CreateSessionBody): Session;
  getSession(id: string): Session | null;
  listSessions(workspaceId: string, opts: { limit: number; before?: string }): Session[];
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
      };
      db.prepare(
        `INSERT INTO workspaces (id, name, dir, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      ).run(ws.id, ws.name, ws.dir, ws.created_at, ws.updated_at);
      return ws;
    },
    listWorkspaces() {
      return db
        .prepare(`SELECT id, name, dir, created_at, updated_at FROM workspaces ORDER BY created_at DESC`)
        .all() as Workspace[];
    },
    getWorkspace(id) {
      const row = db
        .prepare(`SELECT id, name, dir, created_at, updated_at FROM workspaces WHERE id = ?`)
        .get(id) as Workspace | undefined;
      return row ?? null;
    },
    renameWorkspace(id, name) {
      const now = new Date().toISOString();
      const result = db
        .prepare(`UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?`)
        .run(name, now, id);
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
      const session: Session = {
        id: randomUUID(),
        workspace_id: body.workspace_id,
        claude_session_id: null,
        created_at: now,
        updated_at: now,
      };
      db.prepare(
        `INSERT INTO sessions (id, workspace_id, claude_session_id, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)`,
      ).run(session.id, session.workspace_id, session.created_at, session.updated_at);
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
      const updated = repo.renameWorkspace(request.params.id, parsed.data.name);
      if (!updated) return reply.code(404).send({ error: "workspace not found" });
      return updated;
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
    const runRequest = applyMemoryMcpOverlay(
      applyBrowserMcpOverlay(parsed.data as RunRequest, opts.browserMcpBin),
      opts.memoryMcpBin,
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

    const runId = runs.submit(workspace.dir, session.claude_session_id, runRequest);
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
  const app = await createServer({
    port,
    host,
    corsOrigins,
    browserMcpBin,
    memoryMcpBin,
    permissionHookBin,
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
