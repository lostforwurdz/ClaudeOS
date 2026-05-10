import Database, { type Database as DatabaseType } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  dir TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- a17.8: per-workspace hooks override (PostToolUse / Stop / etc.).
  -- JSON-encoded WorkspaceHooks; NULL when the workspace defers entirely
  -- to user/project settings.
  hooks_json TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  claude_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  input_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  request_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);

CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  UNIQUE (run_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, sequence);
`;

export function defaultDbPath(): string {
  return process.env.CLAUDEOS_DB_PATH ?? join(homedir(), ".claudeos", "state.db");
}

export function openDb(path: string = defaultDbPath()): DatabaseType {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  // a17.8: tiny migration. SCHEMA's CREATE TABLE adds hooks_json on fresh
  // DBs but not on existing ones — ALTER TABLE if the column is absent.
  // Idempotent; second runs see the column and skip.
  const cols = db
    .prepare(`PRAGMA table_info(workspaces)`)
    .all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "hooks_json")) {
    db.exec(`ALTER TABLE workspaces ADD COLUMN hooks_json TEXT`);
  }
  return db;
}
