import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type Client, createClient, type InValue, type Transaction } from '@libsql/client';

const activeTx = new AsyncLocalStorage<DB>();

function current(db: DB): DB {
  return activeTx.getStore() ?? db;
}

export type SqlParam = string | number | bigint | boolean | null | Uint8Array;

export type DB = {
  all<T extends Record<string, unknown>>(sql: string, ...params: SqlParam[]): Promise<T[]>;
  get<T extends Record<string, unknown>>(
    sql: string,
    ...params: SqlParam[]
  ): Promise<T | undefined>;
  run(sql: string, ...params: SqlParam[]): Promise<number>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: DB) => Promise<T>): Promise<T>;
  close(): void;
};

type Executor = Pick<Client, 'execute'> | Pick<Transaction, 'execute'>;

function wrap(executor: Executor, closer?: () => void): DB {
  const execSql = async (sql: string, params: SqlParam[]) => {
    return executor.execute({ sql, args: params as InValue[] });
  };
  const db: DB = {
    async all(sql, ...params) {
      const rs = await execSql(sql, params);
      return rs.rows as unknown as Array<Record<string, unknown>> as never;
    },
    async get(sql, ...params) {
      const rs = await execSql(sql, params);
      return rs.rows[0] as unknown as Record<string, unknown> | undefined as never;
    },
    async run(sql, ...params) {
      const rs = await execSql(sql, params);
      return Number(rs.rowsAffected ?? 0);
    },
    async exec(sql) {
      await execSql(sql, []);
    },
    async transaction(fn) {
      if (!('transaction' in executor) || typeof (executor as Client).transaction !== 'function') {
        return fn(db);
      }
      const tx = await (executor as Client).transaction('write');
      const wrapped = wrap(tx);
      try {
        const value = await activeTx.run(wrapped, () => fn(wrapped));
        await tx.commit();
        return value;
      } catch (error) {
        try {
          await tx.rollback();
        } catch {
          /* already closed */
        }
        throw error;
      }
    },
    close() {
      closer?.();
    },
  };
  return db;
}

export async function openDatabase(pathOrUrl = ':memory:', authToken?: string): Promise<DB> {
  const { url, token, filePath } = resolveClientTarget(pathOrUrl, authToken);
  if (filePath && filePath !== ':memory:' && !filePath.includes(':memory:')) {
    mkdirSync(dirname(filePath), { recursive: true });
  }
  const client = createClient({ url, authToken: token });
  const db = wrap(client, () => client.close());
  await migrate(db);
  return db;
}

export async function openDatabaseFromEnv(): Promise<DB> {
  const url = process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL || '';
  const token = process.env.TURSO_AUTH_TOKEN || process.env.LIBSQL_AUTH_TOKEN || '';
  const onVercel = Boolean(process.env.VERCEL);
  if (url) {
    if (/^libsql:|^https?:|^wss?:/i.test(url) && !token) {
      throw new Error(
        'TURSO_AUTH_TOKEN is required when TURSO_DATABASE_URL points at a remote database.',
      );
    }
    return openDatabase(url, token || undefined);
  }
  if (onVercel) {
    throw new Error(
      'TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required on Vercel. Local /tmp SQLite is no longer used.',
    );
  }
  const file = process.env.BOT_COCKPIT_DATA || 'data/cockpit.sqlite';
  return openDatabase(file);
}

function resolveClientTarget(
  pathOrUrl: string,
  authToken?: string,
): { url: string; token?: string; filePath?: string } {
  if (pathOrUrl === ':memory:' || pathOrUrl === 'file::memory:') {
    // Unique file-backed temp DB: a shared file::memory: would leak schema across tests.
    return { url: `file:${join(tmpdir(), `bot-cockpit-${randomBytes(8).toString('hex')}.db`)}` };
  }
  if (/^libsql:|^https?:|^wss?:|^file:/i.test(pathOrUrl)) {
    const filePath = pathOrUrl.startsWith('file:')
      ? pathOrUrl.slice('file:'.length).replace(/^\/\//, '/')
      : undefined;
    return { url: pathOrUrl, token: authToken, filePath };
  }
  return { url: `file:${pathOrUrl}`, filePath: pathOrUrl, token: authToken };
}

async function executeScript(db: DB, script: string): Promise<void> {
  const parts = script
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith('--'));
  for (const part of parts) {
    await db.exec(part);
  }
}

export async function migrate(db: DB): Promise<void> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)`);
  const current = await db.get<{ version: number | null }>(
    'SELECT MAX(version) AS version FROM schema_migrations',
  );
  const version = Number(current?.version ?? 0);
  if (version < 1) {
    await executeScript(db, SCHEMA_V2);
    await db.run('INSERT INTO schema_migrations (version) VALUES (2)');
  } else if (version < 2) {
    await upgradeV1ToV2(db);
    await db.run('INSERT INTO schema_migrations (version) VALUES (2)');
  }
  if (version < 3) {
    await executeScript(db, SCHEMA_V3);
    await db.run('INSERT OR IGNORE INTO schema_migrations (version) VALUES (3)');
  }
}

// v3: per-user onboarding wizard state (Grok Bot connection assistant).
const SCHEMA_V3 = `
CREATE TABLE IF NOT EXISTS onboarding (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  step INTEGER NOT NULL DEFAULT 0,
  token_id TEXT,
  token_created_at TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  skipped_at TEXT
)
`;

const SCHEMA_V2 = `
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
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  grid_x REAL NOT NULL,
  grid_y REAL NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE bots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
CREATE TABLE mcp_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  hint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
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
  is_demo INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, fingerprint)
);
CREATE TABLE imports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  import_id TEXT REFERENCES imports(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
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
  created_at TEXT NOT NULL,
  UNIQUE (user_id, fingerprint)
);
CREATE TABLE upload_staging (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  headers_json TEXT NOT NULL,
  records_json TEXT NOT NULL,
  errors_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE webhook_calls (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action_name TEXT NOT NULL,
  bot_id TEXT,
  status TEXT NOT NULL,
  http_status INTEGER,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE audit (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_teams_user ON teams(user_id);
CREATE INDEX idx_rooms_user ON rooms(user_id);
CREATE INDEX idx_bots_user ON bots(user_id);
CREATE INDEX idx_bots_team ON bots(team_id);
CREATE INDEX idx_usage_user_day ON usage_rows(user_id, day);
CREATE INDEX idx_usage_bot ON usage_rows(bot_id);
CREATE INDEX idx_events_user_time ON events(user_id, occurred_at);
CREATE INDEX idx_sessions_user ON sessions(user_id);
`;

async function upgradeV1ToV2(db: DB): Promise<void> {
  const owner = await db.get<{ id: string }>(
    'SELECT id FROM users ORDER BY created_at ASC LIMIT 1',
  );
  const ownerId = owner?.id ?? null;
  await db.exec('PRAGMA foreign_keys = OFF');
  await executeScript(
    db,
    `ALTER TABLE settings RENAME TO settings_v1;
     ALTER TABLE teams RENAME TO teams_v1;
     ALTER TABLE rooms RENAME TO rooms_v1;
     ALTER TABLE bots RENAME TO bots_v1;
     ALTER TABLE bot_history RENAME TO bot_history_v1;
     ALTER TABLE mcp_tokens RENAME TO mcp_tokens_v1;
     ALTER TABLE events RENAME TO events_v1;
     ALTER TABLE imports RENAME TO imports_v1;
     ALTER TABLE usage_rows RENAME TO usage_rows_v1;
     ALTER TABLE upload_staging RENAME TO upload_staging_v1;
     ALTER TABLE webhook_calls RENAME TO webhook_calls_v1;
     ALTER TABLE audit RENAME TO audit_v1;`,
  );
  await executeScript(db, SCHEMA_V2);
  if (ownerId) {
    await adoptV1Tables(db, ownerId);
  }
  await db.exec('PRAGMA foreign_keys = ON');
}

/** Assign leftover v1 rows to a user (Mathieu's account, or the first created space). */
export async function adoptOrphanedWorkspace(db: DB, userId: string): Promise<void> {
  const hasLegacy = await db.get<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'teams_v1'`,
  );
  if (!hasLegacy) return;
  await adoptV1Tables(db, userId);
}

async function adoptV1Tables(db: DB, userId: string): Promise<void> {
  const present = async (name: string) => {
    const row = await db.get<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
      name,
    );
    return Boolean(row);
  };
  if (await present('settings_v1')) {
    await db.run(
      `INSERT OR IGNORE INTO settings (user_id, key, value) SELECT ?, key, value FROM settings_v1`,
      userId,
    );
    await db.exec('DROP TABLE settings_v1');
  }
  if (await present('teams_v1')) {
    await db.run(
      `INSERT OR IGNORE INTO teams (id, user_id, name, mission, accent, origin, archived_at, is_demo, created_at)
       SELECT id, ?, name, mission, accent, origin, archived_at, is_demo, created_at FROM teams_v1`,
      userId,
    );
    await db.exec('DROP TABLE teams_v1');
  }
  if (await present('rooms_v1')) {
    await db.run(
      `INSERT OR IGNORE INTO rooms (id, user_id, team_id, name, kind, grid_x, grid_y, is_demo)
       SELECT id, ?, team_id, name, kind, grid_x, grid_y, is_demo FROM rooms_v1`,
      userId,
    );
    await db.exec('DROP TABLE rooms_v1');
  }
  if (await present('bots_v1')) {
    await db.run(
      `INSERT OR IGNORE INTO bots (id, user_id, external_key, name, role, brief, team_id, room_id, status, status_note, last_seen_at, archived_at, is_demo, origin, created_at, updated_at)
       SELECT id, ?, external_key, name, role, brief, team_id, room_id, status, status_note, last_seen_at, archived_at, is_demo, origin, created_at, updated_at FROM bots_v1`,
      userId,
    );
    await db.exec('DROP TABLE bots_v1');
  }
  if (await present('bot_history_v1')) {
    await db.run(
      `INSERT OR IGNORE INTO bot_history (id, user_id, bot_id, status, note, source, occurred_at)
       SELECT id, ?, bot_id, status, note, source, occurred_at FROM bot_history_v1`,
      userId,
    );
    await db.exec('DROP TABLE bot_history_v1');
  }
  if (await present('mcp_tokens_v1')) {
    await db.run(
      `INSERT OR IGNORE INTO mcp_tokens (id, user_id, label, token_hash, hint, created_at, last_used_at, revoked_at)
       SELECT id, ?, label, token_hash, hint, created_at, last_used_at, revoked_at FROM mcp_tokens_v1`,
      userId,
    );
    await db.exec('DROP TABLE mcp_tokens_v1');
  }
  if (await present('imports_v1')) {
    await db.run(
      `INSERT OR IGNORE INTO imports (id, user_id, filename, mapping_json, row_count, duplicate_count, skipped_count, error_count, created_at)
       SELECT id, ?, filename, mapping_json, row_count, duplicate_count, skipped_count, error_count, created_at FROM imports_v1`,
      userId,
    );
    await db.exec('DROP TABLE imports_v1');
  }
  if (await present('usage_rows_v1')) {
    await db.run(
      `INSERT OR IGNORE INTO usage_rows (id, user_id, import_id, fingerprint, occurred_at, day, input_tokens, cache_tokens, output_tokens, total_tokens, cost_raw, cost_value, cost_kind, model, kind, automation_id, reported_bot_key, bot_id, assignment_provenance, source, is_demo, raw_json, created_at)
       SELECT id, ?, import_id, fingerprint, occurred_at, day, input_tokens, cache_tokens, output_tokens, total_tokens, cost_raw, cost_value, cost_kind, model, kind, automation_id, reported_bot_key, bot_id, assignment_provenance, source, is_demo, raw_json, created_at FROM usage_rows_v1`,
      userId,
    );
    await db.exec('DROP TABLE usage_rows_v1');
  }
  if (await present('events_v1')) {
    await db.run(
      `INSERT OR IGNORE INTO events (id, user_id, fingerprint, bot_id, reported_bot_key, reported_source, kind, name, detail, payload_json, occurred_at, received_at, linked, is_demo)
       SELECT id, ?, fingerprint, bot_id, reported_bot_key, reported_source, kind, name, detail, payload_json, occurred_at, received_at, linked, is_demo FROM events_v1`,
      userId,
    );
    await db.exec('DROP TABLE events_v1');
  }
  if (await present('upload_staging_v1')) {
    await db.run(
      `INSERT OR IGNORE INTO upload_staging (id, user_id, filename, headers_json, records_json, errors_json, created_at, expires_at)
       SELECT id, user_id, filename, headers_json, records_json, errors_json, created_at, expires_at FROM upload_staging_v1`,
    );
    await db.exec('DROP TABLE upload_staging_v1');
  }
  if (await present('webhook_calls_v1')) {
    await db.run(
      `INSERT OR IGNORE INTO webhook_calls (id, user_id, action_name, bot_id, status, http_status, detail, created_at)
       SELECT id, ?, action_name, bot_id, status, http_status, detail, created_at FROM webhook_calls_v1`,
      userId,
    );
    await db.exec('DROP TABLE webhook_calls_v1');
  }
  if (await present('audit_v1')) {
    await db.run(
      `INSERT OR IGNORE INTO audit (id, user_id, actor, action, detail, created_at)
       SELECT id, ?, actor, action, detail, created_at FROM audit_v1`,
      userId,
    );
    await db.exec('DROP TABLE audit_v1');
  }
}

export async function all<T extends Record<string, unknown>>(
  db: DB,
  sql: string,
  ...params: SqlParam[]
): Promise<T[]> {
  return current(db).all<T>(sql, ...params);
}

export async function get<T extends Record<string, unknown>>(
  db: DB,
  sql: string,
  ...params: SqlParam[]
): Promise<T | undefined> {
  return current(db).get<T>(sql, ...params);
}

export async function run(db: DB, sql: string, ...params: SqlParam[]): Promise<number> {
  return current(db).run(sql, ...params);
}

export async function transaction<T>(db: DB, fn: (tx?: DB) => Promise<T> | T): Promise<T> {
  return current(db).transaction(async (tx) => activeTx.run(tx, async () => await fn(tx)));
}
