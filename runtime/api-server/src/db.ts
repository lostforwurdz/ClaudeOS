import Database, { type Database as DatabaseType } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

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
  hooks_json TEXT,
  -- vk3.1: which LLM runner backs runs in this workspace.
  runner_kind TEXT NOT NULL DEFAULT 'claude-code'
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

CREATE TABLE IF NOT EXISTS domains (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  domain_id TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  prompt_template TEXT NOT NULL,
  mode_id TEXT NOT NULL DEFAULT 'default',
  target_workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  is_automation INTEGER NOT NULL DEFAULT 0,
  schedule_cron TEXT,
  hotkey TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skills_domain ON skills(domain_id);
`;

export function defaultDbPath(): string {
  return process.env.CLAUDEOS_DB_PATH ?? join(homedir(), ".claudeos", "state.db");
}

// vk3.2: seed 3 starter domains + 5 starter skills on first launch.
// Idempotent: skips entirely when the domains table is non-empty.
export function seedStarterContent(db: DatabaseType): void {
  const count = (db.prepare("SELECT COUNT(*) as n FROM domains").get() as { n: number }).n;
  if (count > 0) return;

  const now = new Date().toISOString();

  const insertDomain = db.prepare(
    `INSERT INTO domains (id, name, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertSkill = db.prepare(
    `INSERT INTO skills
       (id, name, description, domain_id, prompt_template, mode_id,
        target_workspace_id, is_automation, schedule_cron, hotkey,
        sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 0, NULL, NULL, ?, ?, ?)`,
  );

  const seedTx = db.transaction(() => {
    const memoryId = randomUUID();
    const researchId = randomUUID();
    const codeId = randomUUID();

    insertDomain.run(memoryId, "Memory", 0, now, now);
    insertDomain.run(researchId, "Research", 1, now, now);
    insertDomain.run(codeId, "Code", 2, now, now);

    insertSkill.run(
      randomUUID(),
      "Save Conversation",
      "Save the current conversation to memory.",
      memoryId,
      "/save {{title}}",
      "default",
      0,
      now,
      now,
    );
    insertSkill.run(
      randomUUID(),
      "Ingest Source",
      "Ingest a file or directory into memory.",
      memoryId,
      "ingest {{path}}",
      "default",
      1,
      now,
      now,
    );
    insertSkill.run(
      randomUUID(),
      "Deep Research",
      "Run a thorough multi-step research pass on a topic.",
      researchId,
      `Research the following topic thoroughly: {{topic}}

1. Gather key facts and context.
2. Identify primary sources and references.
3. Synthesize findings into a structured summary.`,
      "architect",
      0,
      now,
      now,
    );
    insertSkill.run(
      randomUUID(),
      "YouTube Search",
      "Search YouTube and synthesize top results.",
      researchId,
      "Search YouTube for {{query}} and synthesize the top results.",
      "default",
      1,
      now,
      now,
    );
    insertSkill.run(
      randomUUID(),
      "Debug Issue",
      "Reproduce, hypothesize, and fix a bug.",
      codeId,
      `Help me debug this issue: {{description}}

Reproduce first, hypothesize, then propose a fix.`,
      "debug",
      0,
      now,
      now,
    );
  });

  seedTx();
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
  // vk3.1: add runner_kind on existing DBs. SQLite fills existing rows with
  // the DEFAULT so no data migration is needed. Idempotent.
  if (!cols.some((c) => c.name === "runner_kind")) {
    db.exec(
      `ALTER TABLE workspaces ADD COLUMN runner_kind TEXT NOT NULL DEFAULT 'claude-code'`,
    );
  }
  // vk3.2: seed starter domains + skills on first open.
  seedStarterContent(db);
  return db;
}
