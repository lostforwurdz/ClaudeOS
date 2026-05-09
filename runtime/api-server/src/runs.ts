import { randomUUID } from "node:crypto";

import { runHarness } from "@claudeos/harness";
import type {
  PermissionDecision,
  PermissionRequestPayload,
} from "@claudeos/harness";
import type {
  RunEvent,
  RunRequest,
} from "@claudeos/runtime-client/contracts";
import type { Database as DatabaseType } from "better-sqlite3";

import type { EventBus } from "./event-bus.js";

export interface RunRecord {
  id: string;
  session_id: string;
  input_id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  started_at: string;
  completed_at: string | null;
}

export interface RunController {
  cancel: () => void;
}

interface PendingPermission {
  payload: PermissionRequestPayload;
  resolve: (decision: PermissionDecision) => void;
  reject: (err: Error) => void;
}

export class RunManager {
  private active = new Map<string, AbortController>();
  /**
   * Pending permission requests, one per active run. The harness `awaitPermissionDecision`
   * callback resolves through this map when a decision arrives via
   * `respondToPermission()` (typically POST /runs/:id/permission).
   */
  private pendingPermissions = new Map<string, PendingPermission>();

  constructor(
    private readonly db: DatabaseType,
    private readonly bus: EventBus,
    private readonly options: { permissionHookBin?: string | null } = {},
  ) {}

  /**
   * Persist a new run, kick off the harness in the background, and return
   * synchronously with the run id. Events stream to the bus and the DB
   * concurrently.
   */
  submit(workspaceDir: string, claudeSessionId: string | null, request: RunRequest): string {
    const runId = randomUUID();
    const startedAt = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO runs (id, session_id, input_id, status, started_at, request_json)
         VALUES (?, ?, ?, 'running', ?, ?)`,
      )
      .run(runId, request.session_id, request.input_id, startedAt, JSON.stringify(request));

    const abort = new AbortController();
    this.active.set(runId, abort);

    void this.execute(runId, workspaceDir, claudeSessionId, request, abort.signal);
    return runId;
  }

  cancel(runId: string): boolean {
    const abort = this.active.get(runId);
    if (!abort) return false;
    // Reject any pending permission so the harness loop unwinds cleanly
    // rather than hanging on the awaited decision after SIGTERM.
    const pending = this.pendingPermissions.get(runId);
    if (pending) {
      pending.reject(new Error("run cancelled"));
      this.pendingPermissions.delete(runId);
    }
    abort.abort();
    return true;
  }

  /**
   * xh4.2: feed a user's allow/deny decision back to the in-flight run. Returns
   * false when there's no pending permission for the run (already decided,
   * cancelled, or invalid runId).
   */
  respondToPermission(runId: string, decision: PermissionDecision): boolean {
    const pending = this.pendingPermissions.get(runId);
    if (!pending) return false;
    this.pendingPermissions.delete(runId);
    pending.resolve(decision);
    return true;
  }

  /** Snapshot of the permission request awaiting a decision, or null. */
  getPendingPermission(runId: string): PermissionRequestPayload | null {
    return this.pendingPermissions.get(runId)?.payload ?? null;
  }

  private async execute(
    runId: string,
    workspaceDir: string,
    claudeSessionId: string | null,
    request: RunRequest,
    signal: AbortSignal,
  ): Promise<void> {
    const insertEvent = this.db.prepare(
      `INSERT INTO run_events (run_id, sequence, event_json) VALUES (?, ?, ?)`,
    );
    const updateSession = this.db.prepare(
      `UPDATE sessions SET claude_session_id = ?, updated_at = ? WHERE id = ?`,
    );
    const updateRun = this.db.prepare(
      `UPDATE runs SET status = ?, completed_at = ? WHERE id = ?`,
    );

    let lastEventType: RunEvent["type"] | null = null;

    try {
      await runHarness(request, {
        workspaceDir,
        resumeClaudeSessionId: claudeSessionId,
        signal,
        runId,
        permissionHookBin: this.options.permissionHookBin ?? undefined,
        awaitPermissionDecision: (payload) =>
          new Promise<PermissionDecision>((resolve, reject) => {
            // The matching cancel/respond paths drain this slot.
            this.pendingPermissions.set(runId, { payload, resolve, reject });
          }),
        onEvent: (event) => {
          lastEventType = event.type;
          // Persist claude_session_id synchronously on run_started so a client
          // that queries /sessions/:id immediately after the WS closes always
          // sees the bound id (the WS closes on run_completed, before the
          // outer await resolves).
          if (event.type === "run_started" && event.payload.claude_session_id) {
            updateSession.run(
              event.payload.claude_session_id,
              new Date().toISOString(),
              request.session_id,
            );
          }
          try {
            insertEvent.run(runId, event.sequence, JSON.stringify(event));
          } catch {
            // Duplicate sequence (shouldn't happen) — drop silently.
          }
          this.bus.publish(runId, event);
        },
      });

      const status =
        signal.aborted
          ? "cancelled"
          : lastEventType === "run_completed"
          ? "completed"
          : "failed";
      updateRun.run(status, new Date().toISOString(), runId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed: RunEvent = {
        type: "run_failed",
        session_id: request.session_id,
        input_id: request.input_id,
        sequence: Number.MAX_SAFE_INTEGER,
        timestamp: new Date().toISOString(),
        payload: { error: message, subtype: "harness_threw" },
      };
      try {
        insertEvent.run(runId, failed.sequence, JSON.stringify(failed));
      } catch {
        // ignore
      }
      this.bus.publish(runId, failed);
      updateRun.run("failed", new Date().toISOString(), runId);
    } finally {
      this.active.delete(runId);
    }
  }

  listEvents(runId: string): RunEvent[] {
    const rows = this.db
      .prepare(`SELECT event_json FROM run_events WHERE run_id = ? ORDER BY sequence ASC`)
      .all(runId) as Array<{ event_json: string }>;
    return rows.map((r) => JSON.parse(r.event_json) as RunEvent);
  }

  getRun(runId: string): RunRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, session_id, input_id, status, started_at, completed_at FROM runs WHERE id = ?`,
      )
      .get(runId) as RunRecord | undefined;
    return row ?? null;
  }

  /**
   * bsky-1: every run currently in the 'running' state across all sessions,
   * joined with workspace + session metadata so Mission Control can render
   * a single cross-workspace dashboard. Newest first by started_at.
   */
  listActiveRuns(): Array<{
    run: RunRecord;
    workspace_id: string;
    workspace_name: string;
    claude_session_id: string | null;
  }> {
    const rows = this.db
      .prepare(
        `SELECT r.id, r.session_id, r.input_id, r.status, r.started_at, r.completed_at,
                s.workspace_id, s.claude_session_id, w.name AS workspace_name
           FROM runs r
           JOIN sessions s ON s.id = r.session_id
           JOIN workspaces w ON w.id = s.workspace_id
          WHERE r.status = 'running'
          ORDER BY r.started_at DESC`,
      )
      .all() as Array<{
      id: string;
      session_id: string;
      input_id: string;
      status: RunRecord["status"];
      started_at: string;
      completed_at: string | null;
      workspace_id: string;
      claude_session_id: string | null;
      workspace_name: string;
    }>;
    return rows.map((r) => ({
      run: {
        id: r.id,
        session_id: r.session_id,
        input_id: r.input_id,
        status: r.status,
        started_at: r.started_at,
        completed_at: r.completed_at,
      },
      workspace_id: r.workspace_id,
      workspace_name: r.workspace_name,
      claude_session_id: r.claude_session_id,
    }));
  }

  /**
   * Newest-first paginated history of runs for a session. Cursor `before` is
   * a `started_at` ISO timestamp; pass the previous page's last `started_at`
   * to walk backwards through history.
   */
  listRunsForSession(
    sessionId: string,
    opts: { limit: number; before?: string },
  ): RunRecord[] {
    const { limit, before } = opts;
    if (before) {
      return this.db
        .prepare(
          `SELECT id, session_id, input_id, status, started_at, completed_at
             FROM runs
            WHERE session_id = ? AND started_at < ?
            ORDER BY started_at DESC, id DESC
            LIMIT ?`,
        )
        .all(sessionId, before, limit) as RunRecord[];
    }
    return this.db
      .prepare(
        `SELECT id, session_id, input_id, status, started_at, completed_at
           FROM runs
          WHERE session_id = ?
          ORDER BY started_at DESC, id DESC
          LIMIT ?`,
      )
      .all(sessionId, limit) as RunRecord[];
  }
}
