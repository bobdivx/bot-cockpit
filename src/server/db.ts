import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let warningPatched = false;

function quietSqliteWarning(): void {
  if (warningPatched) return;
  warningPatched = true;
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: unknown, ...args: unknown[]) => {
    const message =
      typeof warning === 'string' ? warning : warning instanceof Error ? warning.message : '';
    if (message.includes('SQLite is an experimental')) return;
    return Reflect.apply(original, process, [warning, ...args]) as undefined;
  }) as typeof process.emitWarning;
}

export type DB = DatabaseSync;

export function openDatabase(path: string): DB {
  quietSqliteWarning();
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 4000');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  migrate(db);
  return db;
}

export function migrate(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)`);
  const current = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as
    | { version: number | null }
    | undefined;
  if ((current?.version ?? 0) >= 1) return;
  db.exec('BEGIN');
  db.exec(SCHEMA);
  db.prepare('INSERT INTO schema_migrations (version) VALUES (1)').run();
  db.exec('COMMIT');
}

const SCHEMA = `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mission TEXT NOT NULL DEFAULT '',
  accent TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'manual',
  archived_at TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  grid_x REAL NOT NULL,
  grid_y REAL NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE bots (
  id TEXT PRIMARY KEY,
  external_key TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  brief TEXT NOT NULL DEFAULT '',
  team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  room_id TEXT REFERENCES rooms(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'offline',
  status_note TEXT NOT NULL DEFAULT '',
  last_seen_at TEXT,
  archived_at TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE bot_history (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
CREATE TABLE mcp_tokens (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  hint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
  reported_bot_key TEXT NOT NULL,
  reported_source TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  linked INTEGER NOT NULL DEFAULT 0,
  is_demo INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE imports (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  mapping_json TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  duplicate_count INTEGER NOT NULL,
  skipped_count INTEGER NOT NULL,
  error_count INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE usage_rows (
  id TEXT PRIMARY KEY,
  import_id TEXT REFERENCES imports(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL UNIQUE,
  occurred_at TEXT,
  day TEXT,
  input_tokens INTEGER,
  cache_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  cost_raw TEXT NOT NULL DEFAULT '',
  cost_value REAL,
  cost_kind TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  automation_id TEXT NOT NULL DEFAULT '',
  reported_bot_key TEXT NOT NULL DEFAULT '',
  bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
  assignment_provenance TEXT,
  source TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 0,
  raw_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE upload_staging (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  headers_json TEXT NOT NULL,
  records_json TEXT NOT NULL,
  errors_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE webhook_calls (
  id TEXT PRIMARY KEY,
  action_name TEXT NOT NULL,
  bot_id TEXT,
  status TEXT NOT NULL,
  http_status INTEGER,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE audit (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_bots_team ON bots(team_id);
CREATE INDEX idx_usage_day ON usage_rows(day);
CREATE INDEX idx_usage_bot ON usage_rows(bot_id);
CREATE INDEX idx_events_time ON events(occurred_at);
`;

export function all<T extends Record<string, unknown>>(
  db: DB,
  sql: string,
  ...params: Array<string | number | null>
): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function get<T extends Record<string, unknown>>(
  db: DB,
  sql: string,
  ...params: Array<string | number | null>
): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function run(db: DB, sql: string, ...params: Array<string | number | null>): number {
  const result = db.prepare(sql).run(...params);
  return Number(result.changes ?? 0);
}

export function transaction<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = fn();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already closed */
    }
    throw error;
  }
}
