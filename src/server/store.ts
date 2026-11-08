import {
  ACCENTS,
  type AuditEntry,
  BOT_STATUSES,
  type Bot,
  type BotStatus,
  type ColumnMapping,
  type HistoryEntry,
  type RoomKind,
  type Settings,
  type Signal,
  type Team,
  type UsageImport,
  type UsageRow,
  type UsageSummary,
  type WebhookCall,
  type Workspace,
} from '../shared/types.js';
import { assertMapping, interpretRows, type UsageDraft } from './csv.js';
import { all, type DB, get, run, transaction } from './db.js';
import { summarizeUsage } from './insights.js';
import {
  flag,
  mapBot,
  mapHistory,
  mapImport,
  mapRoom,
  mapSignal,
  mapTeam,
  mapUsage,
  mapWebhook,
  type Row,
  str,
} from './mappers.js';
import { PACKS, packById } from './packs.js';
import { cleanBlock, cleanText, HttpError, newId, sha256 } from './security.js';

const ROOM_SLOTS: Array<[number, number]> = [
  [0.15, 0.2],
  [2.35, 0.15],
  [0.2, 2.25],
  [2.45, 2.2],
  [4.55, 0.7],
  [4.45, 2.55],
];

export type SessionUser = { id: string; email: string; sessionId: string };

export function purgeExpired(db: DB, now: Date): void {
  const iso = now.toISOString();
  run(db, 'DELETE FROM sessions WHERE expires_at < ?', iso);
  run(db, 'DELETE FROM upload_staging WHERE expires_at < ?', iso);
}

export function readSettings(db: DB): Settings {
  const rows = all<Row>(db, 'SELECT key, value FROM settings');
  const map = new Map(rows.map((row) => [str(row, 'key'), str(row, 'value')]));
  return {
    demoMode: map.get('demo_mode') === '1',
    retentionDays: clamp(map.get('retention_days'), 0, 3650, 0),
    staleMinutes: clamp(map.get('stale_minutes'), 1, 10_080, 30),
  };
}

export function writeSettings(
  db: DB,
  patch: { retentionDays?: number; staleMinutes?: number },
  now: Date,
): Settings {
  if (patch.retentionDays != null) {
    const days = clamp(String(patch.retentionDays), 0, 3650, 0);
    run(
      db,
      `INSERT INTO settings (key, value) VALUES ('retention_days', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      String(days),
    );
  }
  if (patch.staleMinutes != null) {
    const minutes = clamp(String(patch.staleMinutes), 1, 10_080, 30);
    run(
      db,
      `INSERT INTO settings (key, value) VALUES ('stale_minutes', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      String(minutes),
    );
  }
  applyRetention(db, now);
  return readSettings(db);
}

export function applyRetention(db: DB, now: Date): void {
  const days = readSettings(db).retentionDays;
  if (days <= 0) return;
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  run(
    db,
    'DELETE FROM usage_rows WHERE is_demo = 0 AND occurred_at IS NOT NULL AND occurred_at < ?',
    cutoff,
  );
  run(db, 'DELETE FROM events WHERE is_demo = 0 AND occurred_at < ?', cutoff);
}

export function addAudit(db: DB, actor: string, action: string, detail: string, now: Date): void {
  run(
    db,
    'INSERT INTO audit (id, actor, action, detail, created_at) VALUES (?, ?, ?, ?, ?)',
    newId(),
    actor,
    action,
    cleanText(detail, 400),
    now.toISOString(),
  );
}

export function listAudit(db: DB): AuditEntry[] {
  return all<Row>(db, 'SELECT * FROM audit ORDER BY created_at DESC LIMIT 80').map((row) => ({
    id: str(row, 'id'),
    actor: str(row, 'actor'),
    action: str(row, 'action'),
    detail: str(row, 'detail'),
    createdAt: str(row, 'created_at'),
  }));
}

export function userCount(db: DB): number {
  const row = get<Row>(db, 'SELECT COUNT(*) AS n FROM users');
  return Number(row?.n ?? 0);
}

export function createOwner(
  db: DB,
  email: string,
  passwordHash: string,
  now: Date,
): SessionUser & { token: string } {
  if (userCount(db) > 0) throw new HttpError(409, 'Le propriétaire est déjà configuré.');
  const id = newId();
  run(
    db,
    'INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)',
    id,
    email,
    passwordHash,
    now.toISOString(),
  );
  addAudit(db, email, 'setup', 'Propriétaire créé.', now);
  return openSession(db, id, email, now);
}

export function findOwnerByEmail(
  db: DB,
  email: string,
): { id: string; email: string; passwordHash: string } | null {
  const row = get<Row>(db, 'SELECT * FROM users WHERE email = ?', email);
  if (!row) return null;
  return { id: str(row, 'id'), email: str(row, 'email'), passwordHash: str(row, 'password_hash') };
}

export function openSession(
  db: DB,
  userId: string,
  email: string,
  now: Date,
): SessionUser & { token: string } {
  const token = newId() + newId();
  const id = newId();
  const expires = new Date(now.getTime() + 14 * 86_400_000).toISOString();
  run(
    db,
    'INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    id,
    userId,
    sha256(token),
    now.toISOString(),
    expires,
  );
  return { id: userId, email, sessionId: id, token };
}

export function userFromToken(db: DB, token: string, now: Date): SessionUser | null {
  const row = get<Row>(
    db,
    `SELECT sessions.id AS session_id, sessions.expires_at, users.id, users.email
     FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ?`,
    sha256(token),
  );
  if (!row) return null;
  if (str(row, 'expires_at') < now.toISOString()) {
    run(db, 'DELETE FROM sessions WHERE id = ?', str(row, 'session_id'));
    return null;
  }
  return { id: str(row, 'id'), email: str(row, 'email'), sessionId: str(row, 'session_id') };
}

export function deleteSession(db: DB, sessionId: string): void {
  run(db, 'DELETE FROM sessions WHERE id = ?', sessionId);
}

export function workspace(db: DB, now: Date): Workspace {
  const settings = readSettings(db);
  const demo = settings.demoMode ? 1 : 0;
  const teams = all<Row>(
    db,
    'SELECT * FROM teams WHERE (? = 1 OR is_demo = 0) ORDER BY created_at',
    demo,
  ).map(mapTeam);
  const rooms = all<Row>(db, 'SELECT * FROM rooms WHERE (? = 1 OR is_demo = 0)', demo).map(mapRoom);
  const bots = all<Row>(
    db,
    'SELECT * FROM bots WHERE (? = 1 OR is_demo = 0) ORDER BY name',
    demo,
  ).map((row) => mapBot(row, now, settings.staleMinutes));
  const signals = all<Row>(
    db,
    'SELECT * FROM events WHERE (? = 1 OR is_demo = 0) ORDER BY occurred_at DESC LIMIT 40',
    demo,
  ).map(mapSignal);
  const imports = all<Row>(db, 'SELECT * FROM imports ORDER BY created_at DESC LIMIT 30').map(
    mapImport,
  );
  return { settings, teams, rooms, bots, signals, imports, webhookActions: [] };
}

export function createTeam(
  db: DB,
  input: { name: string; mission: string; accent: string },
  actor: string,
  now: Date,
): Team {
  const name = required(input.name, 80, 'Nom d’équipe requis.');
  const accent = assertAccent(input.accent || ACCENTS[0]);
  const id = newId();
  run(
    db,
    'INSERT INTO teams (id, name, mission, accent, origin, is_demo, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
    id,
    name,
    cleanText(input.mission, 400),
    accent,
    'manual',
    now.toISOString(),
  );
  addAudit(db, actor, 'team.create', name, now);
  return mapTeam(get<Row>(db, 'SELECT * FROM teams WHERE id = ?', id)!);
}

export function updateTeam(
  db: DB,
  id: string,
  input: { name?: string; mission?: string; accent?: string },
): Team {
  const current = mustTeam(db, id);
  if (current.isDemo)
    throw new HttpError(
      400,
      'Les fiches de démonstration se retirent en quittant la démonstration.',
    );
  const name = input.name != null ? required(input.name, 80, 'Nom d’équipe requis.') : current.name;
  const mission = input.mission != null ? cleanText(input.mission, 400) : current.mission;
  const accent = input.accent != null ? assertAccent(input.accent) : current.accent;
  run(
    db,
    'UPDATE teams SET name = ?, mission = ?, accent = ? WHERE id = ?',
    name,
    mission,
    accent,
    id,
  );
  return mapTeam(get<Row>(db, 'SELECT * FROM teams WHERE id = ?', id)!);
}

export function setTeamArchived(
  db: DB,
  id: string,
  archived: boolean,
  actor: string,
  now: Date,
): Team {
  const current = mustTeam(db, id);
  if (current.isDemo)
    throw new HttpError(
      400,
      'Les fiches de démonstration se retirent en quittant la démonstration.',
    );
  run(db, 'UPDATE teams SET archived_at = ? WHERE id = ?', archived ? now.toISOString() : null, id);
  addAudit(db, actor, archived ? 'team.archive' : 'team.restore', current.name, now);
  return mapTeam(get<Row>(db, 'SELECT * FROM teams WHERE id = ?', id)!);
}

export function createRoom(
  db: DB,
  input: { teamId: string | null; name: string; kind: string },
): ReturnType<typeof mapRoom> {
  const name = required(input.name, 80, 'Nom de salle requis.');
  const kind = assertKind(input.kind);
  if (input.teamId) mustTeam(db, input.teamId);
  const [gridX, gridY] = nextSlot(db);
  const id = newId();
  run(
    db,
    'INSERT INTO rooms (id, team_id, name, kind, grid_x, grid_y, is_demo) VALUES (?, ?, ?, ?, ?, ?, 0)',
    id,
    input.teamId,
    name,
    kind,
    gridX,
    gridY,
  );
  return mapRoom(get<Row>(db, 'SELECT * FROM rooms WHERE id = ?', id)!);
}

export function createBot(
  db: DB,
  input: {
    name: string;
    role: string;
    brief: string;
    teamId: string | null;
    roomId: string | null;
    externalKey: string;
    status: string;
  },
  actor: string,
  now: Date,
): Bot {
  const name = required(input.name, 80, 'Nom de fiche requis.');
  const status = assertStatus(input.status || 'offline');
  assertLinks(db, input.teamId, input.roomId, false);
  const externalKey = cleanText(input.externalKey, 120);
  assertExternalKey(db, externalKey, null);
  const id = newId();
  const iso = now.toISOString();
  const seen = status === 'offline' ? null : iso;
  run(
    db,
    `INSERT INTO bots (id, external_key, name, role, brief, team_id, room_id, status, status_note, last_seen_at, is_demo, origin, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, 0, 'manual', ?, ?)`,
    id,
    externalKey,
    name,
    cleanText(input.role, 80),
    cleanBlock(input.brief, 2000),
    input.teamId,
    input.roomId,
    status,
    seen,
    iso,
    iso,
  );
  run(
    db,
    'INSERT INTO bot_history (id, bot_id, status, note, source, occurred_at) VALUES (?, ?, ?, ?, ?, ?)',
    newId(),
    id,
    status,
    'Création manuelle',
    'manual',
    iso,
  );
  addAudit(db, actor, 'bot.create', name, now);
  return getBot(db, id, now);
}

export function updateBot(
  db: DB,
  id: string,
  input: {
    name?: string;
    role?: string;
    brief?: string;
    teamId?: string | null;
    roomId?: string | null;
    externalKey?: string;
  },
  now: Date,
): Bot {
  const current = getBot(db, id, now);
  if (current.isDemo)
    throw new HttpError(
      400,
      'Les fiches de démonstration se retirent en quittant la démonstration.',
    );
  const teamId = input.teamId === undefined ? current.teamId : input.teamId;
  const roomId = input.roomId === undefined ? current.roomId : input.roomId;
  assertLinks(db, teamId, roomId, false);
  const externalKey =
    input.externalKey === undefined ? current.externalKey : cleanText(input.externalKey, 120);
  assertExternalKey(db, externalKey, id);
  run(
    db,
    `UPDATE bots SET name = ?, role = ?, brief = ?, team_id = ?, room_id = ?, external_key = ?, updated_at = ? WHERE id = ?`,
    input.name != null ? required(input.name, 80, 'Nom de fiche requis.') : current.name,
    input.role != null ? cleanText(input.role, 80) : current.role,
    input.brief != null ? cleanBlock(input.brief, 2000) : current.brief,
    teamId,
    roomId,
    externalKey,
    now.toISOString(),
    id,
  );
  return getBot(db, id, now);
}

export function setBotStatus(
  db: DB,
  id: string,
  status: string,
  note: string,
  actor: string,
  now: Date,
): Bot {
  const current = getBot(db, id, now);
  if (current.isDemo)
    throw new HttpError(400, 'Les fiches de démonstration ne reçoivent pas de statut réel.');
  const next = assertStatus(status);
  const iso = now.toISOString();
  const cleanNote = cleanText(note, 500);
  run(
    db,
    'UPDATE bots SET status = ?, status_note = ?, last_seen_at = ?, updated_at = ? WHERE id = ?',
    next,
    cleanNote,
    iso,
    iso,
    id,
  );
  run(
    db,
    'INSERT INTO bot_history (id, bot_id, status, note, source, occurred_at) VALUES (?, ?, ?, ?, ?, ?)',
    newId(),
    id,
    next,
    cleanNote || 'Mise à jour manuelle',
    'manual',
    iso,
  );
  addAudit(db, actor, 'bot.status', `${current.name} → ${next}`, now);
  return getBot(db, id, now);
}

export function setBotArchived(
  db: DB,
  id: string,
  archived: boolean,
  actor: string,
  now: Date,
): Bot {
  const current = getBot(db, id, now);
  if (current.isDemo)
    throw new HttpError(
      400,
      'Les fiches de démonstration se retirent en quittant la démonstration.',
    );
  run(
    db,
    'UPDATE bots SET archived_at = ?, updated_at = ? WHERE id = ?',
    archived ? now.toISOString() : null,
    now.toISOString(),
    id,
  );
  addAudit(db, actor, archived ? 'bot.archive' : 'bot.restore', current.name, now);
  return getBot(db, id, now);
}

export function getBot(db: DB, id: string, now: Date): Bot {
  const row = get<Row>(db, 'SELECT * FROM bots WHERE id = ?', id);
  if (!row) throw new HttpError(404, 'Fiche introuvable.');
  return mapBot(row, now, readSettings(db).staleMinutes);
}

export function botHistory(db: DB, id: string): HistoryEntry[] {
  return all<Row>(
    db,
    'SELECT * FROM bot_history WHERE bot_id = ? ORDER BY occurred_at DESC LIMIT 40',
    id,
  ).map(mapHistory);
}

export function applyPack(db: DB, packId: string, actor: string, now: Date): Team {
  const pack = packById(packId);
  if (!pack) throw new HttpError(404, 'Consigne introuvable.');
  const existing = Number(
    get<Row>(db, 'SELECT COUNT(*) AS n FROM teams WHERE origin = ?', `pack:${pack.id}`)?.n ?? 0,
  );
  const suffix = existing === 0 ? '' : ` ${existing + 1}`;
  return transaction(db, () => {
    const teamId = newId();
    const iso = now.toISOString();
    run(
      db,
      'INSERT INTO teams (id, name, mission, accent, origin, is_demo, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
      teamId,
      `${pack.name}${suffix}`,
      pack.mission,
      pack.accent,
      `pack:${pack.id}`,
      iso,
    );
    const roomIds = pack.rooms.map((room) => {
      const [gridX, gridY] = nextSlot(db);
      const id = newId();
      run(
        db,
        'INSERT INTO rooms (id, team_id, name, kind, grid_x, grid_y, is_demo) VALUES (?, ?, ?, ?, ?, ?, 0)',
        id,
        teamId,
        room.name,
        room.kind,
        gridX,
        gridY,
      );
      return id;
    });
    pack.bots.forEach((bot, index) => {
      const id = newId();
      const roomId = roomIds[index % roomIds.length] ?? null;
      run(
        db,
        `INSERT INTO bots (id, external_key, name, role, brief, team_id, room_id, status, status_note, last_seen_at, is_demo, origin, created_at, updated_at)
         VALUES (?, '', ?, ?, ?, ?, ?, 'offline', '', NULL, 0, ?, ?, ?)`,
        id,
        bot.name,
        bot.role,
        bot.brief,
        teamId,
        roomId,
        `pack:${pack.id}`,
        iso,
        iso,
      );
    });
    addAudit(db, actor, 'pack.apply', `${pack.name} — fiches manuelles, aucun code exécuté.`, now);
    return mapTeam(get<Row>(db, 'SELECT * FROM teams WHERE id = ?', teamId)!);
  });
}

export function setDemoMode(db: DB, enabled: boolean, actor: string, now: Date): Settings {
  transaction(db, () => {
    clearDemo(db);
    if (enabled) seedDemo(db, now);
    run(
      db,
      `INSERT INTO settings (key, value) VALUES ('demo_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      enabled ? '1' : '0',
    );
    addAudit(
      db,
      actor,
      enabled ? 'demo.on' : 'demo.off',
      enabled ? 'Données de démonstration activées.' : 'Données de démonstration retirées.',
      now,
    );
  });
  return readSettings(db);
}

export function saveStaging(
  db: DB,
  userId: string,
  filename: string,
  headers: string[],
  records: string[][],
  errors: Array<{ line: number; message: string }>,
  now: Date,
): string {
  const iso = now.toISOString();
  run(db, 'DELETE FROM upload_staging WHERE expires_at < ?', iso);
  const id = newId();
  const expires = new Date(now.getTime() + 30 * 60_000).toISOString();
  run(
    db,
    `INSERT INTO upload_staging (id, user_id, filename, headers_json, records_json, errors_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    userId,
    filename,
    JSON.stringify(headers),
    JSON.stringify(records),
    JSON.stringify(errors),
    iso,
    expires,
  );
  return id;
}

export function readStaging(
  db: DB,
  id: string,
  userId: string,
  now: Date,
): {
  filename: string;
  headers: string[];
  records: string[][];
  errors: Array<{ line: number; message: string }>;
} {
  const row = get<Row>(db, 'SELECT * FROM upload_staging WHERE id = ? AND user_id = ?', id, userId);
  if (!row || str(row, 'expires_at') < now.toISOString())
    throw new HttpError(404, 'Aperçu expiré. Déposez le fichier à nouveau.');
  return {
    filename: str(row, 'filename'),
    headers: JSON.parse(str(row, 'headers_json')) as string[],
    records: JSON.parse(str(row, 'records_json')) as string[][],
    errors: JSON.parse(str(row, 'errors_json')) as Array<{ line: number; message: string }>,
  };
}

export function commitStaging(
  db: DB,
  id: string,
  userId: string,
  mapping: ColumnMapping,
  actor: string,
  now: Date,
): UsageImport {
  const staging = readStaging(db, id, userId, now);
  assertMapping(staging.headers, mapping);
  const drafts = interpretRows(staging.headers, staging.records, mapping);
  const included = drafts.filter((draft) => draft.include);
  if (included.length === 0) throw new HttpError(400, 'Aucune ligne exploitable.');
  return transaction(db, () => {
    const importId = newId();
    const iso = now.toISOString();
    let rowCount = 0;
    let duplicates = 0;
    const skipped = drafts.length - included.length;
    const seen = new Set<string>();
    run(
      db,
      `INSERT INTO imports (id, filename, mapping_json, row_count, duplicate_count, skipped_count, error_count, created_at)
       VALUES (?, ?, ?, 0, 0, 0, ?, ?)`,
      importId,
      staging.filename,
      JSON.stringify(mapping),
      staging.errors.length,
      iso,
    );
    for (const draft of included) {
      if (
        seen.has(draft.fingerprint) ||
        get<Row>(db, 'SELECT id FROM usage_rows WHERE fingerprint = ?', draft.fingerprint)
      ) {
        duplicates += 1;
        continue;
      }
      seen.add(draft.fingerprint);
      const botId = matchBotId(db, draft.botKey);
      run(
        db,
        `INSERT INTO usage_rows (
          id, import_id, fingerprint, occurred_at, day, input_tokens, cache_tokens, output_tokens, total_tokens,
          cost_raw, cost_value, cost_kind, model, kind, automation_id, reported_bot_key, bot_id, assignment_provenance,
          source, is_demo, raw_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'csv', 0, ?, ?)`,
        newId(),
        importId,
        draft.fingerprint,
        draft.occurredAt,
        draft.day,
        draft.inputTokens,
        draft.cacheTokens,
        draft.outputTokens,
        draft.totalTokens,
        draft.costRaw,
        draft.costValue,
        draft.costKind,
        draft.model,
        draft.kind,
        draft.automationId,
        draft.botKey,
        botId,
        botId ? 'csv:identifiant reconnu' : null,
        JSON.stringify({ line: draft.line, messages: draft.messages }),
        iso,
      );
      rowCount += 1;
    }
    if (rowCount === 0)
      throw new HttpError(409, 'Toutes les lignes exploitables sont déjà présentes.');
    run(
      db,
      'UPDATE imports SET row_count = ?, duplicate_count = ?, skipped_count = ? WHERE id = ?',
      rowCount,
      duplicates,
      skipped,
      importId,
    );
    run(db, 'DELETE FROM upload_staging WHERE id = ?', id);
    addAudit(
      db,
      actor,
      'usage.import',
      `${staging.filename} · ${rowCount} ligne(s), ${duplicates} doublon(s).`,
      now,
    );
    return mapImport(get<Row>(db, 'SELECT * FROM imports WHERE id = ?', importId)!);
  });
}

export type UsageQuery = {
  from: string | null;
  to: string | null;
  model: string | null;
  source: string | null;
  bot: string | null;
};

export function usageSummary(db: DB, query: UsageQuery): UsageSummary {
  const settings = readSettings(db);
  const rows = listUsage(db, query, settings.demoMode, 20_000, 0);
  const signals = eventTokenCount(db, settings.demoMode);
  return summarizeUsage(rows, query, signals);
}

export function listUsage(
  db: DB,
  query: UsageQuery,
  demo: boolean,
  limit: number,
  offset: number,
): UsageRow[] {
  const filter = usageWhere(query, demo);
  return all<Row>(
    db,
    `SELECT usage_rows.*, bots.name AS bot_name
     FROM usage_rows LEFT JOIN bots ON bots.id = usage_rows.bot_id
     WHERE ${filter.sql}
     ORDER BY COALESCE(usage_rows.occurred_at, usage_rows.created_at) DESC
     LIMIT ? OFFSET ?`,
    ...filter.params,
    limit,
    offset,
  ).map(mapUsage);
}

export function assignUsage(
  db: DB,
  rowId: string,
  botId: string | null,
  note: string,
  actor: string,
  now: Date,
): UsageRow {
  const row = get<Row>(db, 'SELECT * FROM usage_rows WHERE id = ?', rowId);
  if (!row) throw new HttpError(404, 'Ligne introuvable.');
  if (flag(row, 'is_demo'))
    throw new HttpError(400, 'Les lignes de démonstration ne s’attribuent pas.');
  let provenance = 'manuel: retrait';
  if (botId) {
    const bot = getBot(db, botId, now);
    if (bot.isDemo)
      throw new HttpError(400, 'Une fiche de démonstration ne reçoit pas de données réelles.');
    if (bot.archivedAt) throw new HttpError(400, 'Cette fiche est archivée.');
    provenance = `manuel: ${cleanText(note, 180) || 'attribution manuelle'}`;
  }
  run(
    db,
    'UPDATE usage_rows SET bot_id = ?, assignment_provenance = ? WHERE id = ?',
    botId,
    provenance,
    rowId,
  );
  addAudit(db, actor, 'usage.assign', provenance, now);
  return mapUsage(
    get<Row>(
      db,
      `SELECT usage_rows.*, bots.name AS bot_name FROM usage_rows LEFT JOIN bots ON bots.id = usage_rows.bot_id WHERE usage_rows.id = ?`,
      rowId,
    )!,
  );
}

export function deleteImport(db: DB, id: string, actor: string, now: Date): void {
  const row = get<Row>(db, 'SELECT * FROM imports WHERE id = ?', id);
  if (!row) throw new HttpError(404, 'Import introuvable.');
  run(db, 'DELETE FROM imports WHERE id = ?', id);
  addAudit(db, actor, 'usage.delete', str(row, 'filename'), now);
}

export function resetUsage(db: DB, actor: string, now: Date): void {
  transaction(db, () => {
    run(db, `DELETE FROM usage_rows WHERE source = 'csv'`);
    run(db, 'DELETE FROM imports');
    run(db, 'DELETE FROM upload_staging');
    addAudit(db, actor, 'usage.reset', 'Imports CSV effacés.', now);
  });
}

export function resetWorkshop(db: DB, actor: string, now: Date): void {
  transaction(db, () => {
    run(db, 'DELETE FROM bot_history');
    run(db, 'DELETE FROM events');
    run(db, 'DELETE FROM usage_rows');
    run(db, 'DELETE FROM imports');
    run(db, 'DELETE FROM upload_staging');
    run(db, 'DELETE FROM bots');
    run(db, 'DELETE FROM rooms');
    run(db, 'DELETE FROM teams');
    run(db, 'DELETE FROM webhook_calls');
    run(
      db,
      `INSERT INTO settings (key, value) VALUES ('demo_mode', '0') ON CONFLICT(key) DO UPDATE SET value = '0'`,
    );
    addAudit(
      db,
      actor,
      'workshop.reset',
      'Atelier vidé. Le compte et les jetons MCP sont conservés.',
      now,
    );
  });
}

export function listTokens(db: DB): Array<{
  id: string;
  label: string;
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}> {
  return all<Row>(db, 'SELECT * FROM mcp_tokens ORDER BY created_at DESC').map((row) => ({
    id: str(row, 'id'),
    label: str(row, 'label'),
    hint: str(row, 'hint'),
    createdAt: str(row, 'created_at'),
    lastUsedAt: row.last_used_at == null ? null : str(row, 'last_used_at'),
    revokedAt: row.revoked_at == null ? null : str(row, 'revoked_at'),
  }));
}

export function insertToken(
  db: DB,
  label: string,
  hash: string,
  hint: string,
  actor: string,
  now: Date,
): string {
  const id = newId();
  run(
    db,
    'INSERT INTO mcp_tokens (id, label, token_hash, hint, created_at) VALUES (?, ?, ?, ?, ?)',
    id,
    required(label, 80, 'Libellé requis.'),
    hash,
    hint,
    now.toISOString(),
  );
  addAudit(db, actor, 'token.create', `Jeton ${hint}… créé.`, now);
  return id;
}

export function revokeToken(db: DB, id: string, actor: string, now: Date): void {
  const row = get<Row>(db, 'SELECT * FROM mcp_tokens WHERE id = ?', id);
  if (!row) throw new HttpError(404, 'Jeton introuvable.');
  run(db, 'UPDATE mcp_tokens SET revoked_at = ? WHERE id = ?', now.toISOString(), id);
  addAudit(db, actor, 'token.revoke', `Jeton ${str(row, 'hint')}… révoqué.`, now);
}

export function authenticateToken(db: DB, secret: string): { id: string; label: string } | null {
  const row = get<Row>(
    db,
    'SELECT id, label, revoked_at FROM mcp_tokens WHERE token_hash = ?',
    sha256(secret),
  );
  if (!row || row.revoked_at) return null;
  return { id: str(row, 'id'), label: str(row, 'label') };
}

export function touchToken(db: DB, id: string, now: Date): void {
  run(db, 'UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?', now.toISOString(), id);
}

export type SignalInput = {
  kind: 'status' | 'event';
  botKey: string;
  status?: BotStatus;
  name: string;
  detail: string;
  source: string;
  occurredAt: string;
  tokens: { input?: number; cache?: number; output?: number; total?: number } | null;
};

export function recordSignal(
  db: DB,
  input: SignalInput,
  now: Date,
): { duplicate: boolean; linked: boolean; botId: string | null; message: string } {
  const botKey = required(input.botKey, 120, 'Identifiant de bot requis.');
  const source = cleanText(input.source, 80) || 'bot';
  const name = cleanText(input.name, 120) || (input.kind === 'status' ? 'statut' : 'evenement');
  const detail = cleanText(input.detail, 1000);
  const fingerprint = sha256(JSON.stringify({ ...input, botKey, source, name, detail }));
  const existing = get<Row>(db, 'SELECT id, bot_id FROM events WHERE fingerprint = ?', fingerprint);
  if (existing) {
    return {
      duplicate: true,
      linked: Boolean(existing.bot_id),
      botId: existing.bot_id == null ? null : str(existing, 'bot_id'),
      message: 'Signal déjà enregistré.',
    };
  }
  const botRow = get<Row>(
    db,
    `SELECT * FROM bots WHERE archived_at IS NULL AND is_demo = 0 AND (id = ? OR (external_key <> '' AND external_key = ?))
     ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END LIMIT 1`,
    botKey,
    botKey,
    botKey,
  );
  const botId = botRow ? str(botRow, 'id') : null;
  const received = now.toISOString();
  run(
    db,
    `INSERT INTO events (id, fingerprint, bot_id, reported_bot_key, reported_source, kind, name, detail, payload_json, occurred_at, received_at, linked, is_demo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    newId(),
    fingerprint,
    botId,
    botKey,
    source,
    input.kind,
    name,
    detail,
    JSON.stringify({ tokens: input.tokens, status: input.status ?? null }),
    input.occurredAt,
    received,
    botId ? 1 : 0,
  );
  if (botRow) {
    const last = botRow.last_seen_at == null ? null : str(botRow, 'last_seen_at');
    const newer = !last || input.occurredAt >= last;
    if (input.kind === 'status' && input.status) {
      run(
        db,
        'INSERT INTO bot_history (id, bot_id, status, note, source, occurred_at) VALUES (?, ?, ?, ?, ?, ?)',
        newId(),
        botId,
        input.status,
        detail || name,
        'mcp',
        input.occurredAt,
      );
      if (newer) {
        run(
          db,
          'UPDATE bots SET status = ?, status_note = ?, last_seen_at = ?, updated_at = ? WHERE id = ?',
          input.status,
          detail,
          input.occurredAt,
          received,
          botId,
        );
      }
    } else if (newer) {
      run(
        db,
        'UPDATE bots SET last_seen_at = ?, updated_at = ? WHERE id = ?',
        input.occurredAt,
        received,
        botId,
      );
    }
  }
  return {
    duplicate: false,
    linked: Boolean(botId),
    botId,
    message: botId
      ? 'Signal enregistré et relié à une fiche.'
      : 'Signal enregistré, sans fiche correspondante.',
  };
}

export function listEvents(db: DB, demo: boolean): Signal[] {
  return all<Row>(
    db,
    'SELECT * FROM events WHERE (? = 1 OR is_demo = 0) ORDER BY occurred_at DESC LIMIT 100',
    demo ? 1 : 0,
  ).map(mapSignal);
}

export function materializeSignal(
  db: DB,
  eventId: string,
  name: string,
  actor: string,
  now: Date,
): Bot {
  const event = get<Row>(db, 'SELECT * FROM events WHERE id = ? AND is_demo = 0', eventId);
  if (!event) throw new HttpError(404, 'Signal introuvable.');
  const key = str(event, 'reported_bot_key');
  const existing = get<Row>(
    db,
    `SELECT id FROM bots WHERE archived_at IS NULL AND is_demo = 0 AND (id = ? OR (external_key <> '' AND external_key = ?)) LIMIT 1`,
    key,
    key,
  );
  const iso = now.toISOString();
  const botId = existing ? str(existing, 'id') : newId();
  if (!existing) {
    const payload = JSON.parse(str(event, 'payload_json') || '{}') as { status?: string };
    const status =
      payload.status && BOT_STATUSES.includes(payload.status as BotStatus)
        ? payload.status
        : 'offline';
    run(
      db,
      `INSERT INTO bots (id, external_key, name, role, brief, team_id, room_id, status, status_note, last_seen_at, is_demo, origin, created_at, updated_at)
       VALUES (?, ?, ?, 'À préciser', '', NULL, NULL, ?, '', NULL, 0, 'manual', ?, ?)`,
      botId,
      key,
      required(name, 80, 'Nom de fiche requis.'),
      status,
      iso,
      iso,
    );
  }
  run(
    db,
    'UPDATE events SET bot_id = ?, linked = 1 WHERE reported_bot_key = ? AND bot_id IS NULL AND is_demo = 0',
    botId,
    key,
  );
  const newest = get<Row>(
    db,
    `SELECT * FROM events WHERE bot_id = ? AND kind = 'status' ORDER BY occurred_at DESC LIMIT 1`,
    botId,
  );
  if (newest) {
    const payload = JSON.parse(str(newest, 'payload_json') || '{}') as { status?: string };
    if (payload.status && BOT_STATUSES.includes(payload.status as BotStatus)) {
      run(
        db,
        'UPDATE bots SET status = ?, status_note = ?, last_seen_at = ?, updated_at = ? WHERE id = ?',
        payload.status,
        str(newest, 'detail'),
        str(newest, 'occurred_at'),
        iso,
        botId,
      );
    }
  }
  addAudit(db, actor, 'event.materialize', `Fiche reliée à ${key}.`, now);
  return getBot(db, botId, now);
}

export function recentWebhookCount(db: DB, action: string, now: Date): number {
  const since = new Date(now.getTime() - 3_600_000).toISOString();
  const row = get<Row>(
    db,
    'SELECT COUNT(*) AS n FROM webhook_calls WHERE action_name = ? AND created_at >= ?',
    action,
    since,
  );
  return Number(row?.n ?? 0);
}

export function insertWebhookCall(
  db: DB,
  input: {
    action: string;
    botId: string | null;
    status: 'requested' | 'failed' | 'blocked';
    httpStatus: number | null;
    detail: string;
  },
  now: Date,
): WebhookCall {
  const id = newId();
  run(
    db,
    'INSERT INTO webhook_calls (id, action_name, bot_id, status, http_status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id,
    input.action,
    input.botId,
    input.status,
    input.httpStatus,
    cleanText(input.detail, 400),
    now.toISOString(),
  );
  return mapWebhook(get<Row>(db, 'SELECT * FROM webhook_calls WHERE id = ?', id)!);
}

export function listWebhookCalls(db: DB): WebhookCall[] {
  return all<Row>(db, 'SELECT * FROM webhook_calls ORDER BY created_at DESC LIMIT 40').map(
    mapWebhook,
  );
}

export function eventTokenCount(db: DB, demo: boolean): number {
  const rows = all<Row>(
    db,
    'SELECT payload_json FROM events WHERE (? = 1 OR is_demo = 0)',
    demo ? 1 : 0,
  );
  return rows.filter((row) => {
    try {
      const payload = JSON.parse(str(row, 'payload_json') || '{}') as { tokens?: unknown };
      return Boolean(payload.tokens && typeof payload.tokens === 'object');
    } catch {
      return false;
    }
  }).length;
}

function clearDemo(db: DB): void {
  const ids = all<Row>(db, 'SELECT id FROM bots WHERE is_demo = 1').map((row) => str(row, 'id'));
  for (const id of ids) run(db, 'DELETE FROM bot_history WHERE bot_id = ?', id);
  run(db, 'DELETE FROM events WHERE is_demo = 1');
  run(db, 'DELETE FROM usage_rows WHERE is_demo = 1');
  run(db, 'DELETE FROM bots WHERE is_demo = 1');
  run(db, 'DELETE FROM rooms WHERE is_demo = 1');
  run(db, 'DELETE FROM teams WHERE is_demo = 1');
}

function seedDemo(db: DB, now: Date): void {
  const pack = PACKS[0]!;
  const dev = PACKS[1]!;
  const teamId = 'demo-team-qualite';
  const otherId = 'demo-team-dev';
  run(
    db,
    'INSERT INTO teams (id, name, mission, accent, origin, is_demo, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
    teamId,
    pack.name,
    pack.mission,
    pack.accent,
    'demo',
    now.toISOString(),
  );
  run(
    db,
    'INSERT INTO teams (id, name, mission, accent, origin, is_demo, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
    otherId,
    dev.name,
    dev.mission,
    dev.accent,
    'demo',
    now.toISOString(),
  );
  const rooms = [
    ['demo-room-relecture', teamId, 'Table de relecture', 'revue', 0.15, 0.2],
    ['demo-room-cas', teamId, 'Paillasse des cas', 'labo', 2.35, 0.15],
    ['demo-room-etabli', otherId, 'Établi', 'atelier', 0.2, 2.25],
  ] as const;
  for (const room of rooms) {
    run(
      db,
      'INSERT INTO rooms (id, team_id, name, kind, grid_x, grid_y, is_demo) VALUES (?, ?, ?, ?, ?, ?, 1)',
      ...room,
    );
  }
  const stale = new Date(now.getTime() - 3 * 3_600_000).toISOString();
  const fresh = new Date(now.getTime() - 4 * 60_000).toISOString();
  const bots = [
    [
      'demo-bot-brume',
      'demo-brume',
      'Brume',
      'Relecture',
      pack.bots[0]!.brief,
      teamId,
      'demo-room-relecture',
      'working',
      stale,
    ],
    [
      'demo-bot-cale',
      'demo-cale',
      'Cale',
      'Cas limites',
      pack.bots[1]!.brief,
      teamId,
      'demo-room-cas',
      'idle',
      fresh,
    ],
    [
      'demo-bot-rive',
      'demo-rive',
      'Rive',
      'Compte-rendu',
      pack.bots[2]!.brief,
      teamId,
      'demo-room-relecture',
      'away',
      fresh,
    ],
    [
      'demo-bot-trame',
      'demo-trame',
      'Trame',
      'Découpage',
      dev.bots[0]!.brief,
      otherId,
      'demo-room-etabli',
      'idle',
      fresh,
    ],
  ] as const;
  for (const bot of bots) {
    run(
      db,
      `INSERT INTO bots (id, external_key, name, role, brief, team_id, room_id, status, status_note, last_seen_at, is_demo, origin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Fiche fictive', ?, 1, 'demo', ?, ?)`,
      bot[0],
      bot[1],
      bot[2],
      bot[3],
      bot[4],
      bot[5],
      bot[6],
      bot[7],
      bot[8],
      now.toISOString(),
      now.toISOString(),
    );
  }
  const samples: UsageDraft[] = [
    demoDraft(now, 1, 9, 'demo-a', 1200, 1.25, 'numeric', 'demo-bot-brume', 'demo-brume'),
    demoDraft(now, 2, 9, 'demo-a', 800, null, 'included', 'demo-bot-cale', 'demo-cale'),
    demoDraft(now, 3, 11, 'demo-b', 400, null, 'unknown', null, ''),
    demoDraft(now, 4, 15, 'demo-b', 50, 0, 'numeric', 'demo-bot-trame', 'demo-trame'),
  ];
  samples[1]!.costRaw = 'Included';
  samples[2]!.costRaw = '-';
  samples.push({
    ...demoDraft(now, 1, 18, 'demo-a', 0, 2.5, 'numeric', 'demo-bot-rive', 'demo-rive'),
    totalTokens: null,
    inputTokens: 10,
    messages: ['Total absent, volontairement.'],
  });
  for (const draft of samples) {
    run(
      db,
      `INSERT INTO usage_rows (
        id, import_id, fingerprint, occurred_at, day, input_tokens, cache_tokens, output_tokens, total_tokens,
        cost_raw, cost_value, cost_kind, model, kind, automation_id, reported_bot_key, bot_id, assignment_provenance,
        source, is_demo, raw_json, created_at
      ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'demonstration', '', ?, ?, ?, 'demo', 1, '{}', ?)`,
      newId(),
      `demo:${draft.fingerprint}`,
      draft.occurredAt,
      draft.day,
      draft.inputTokens,
      draft.cacheTokens,
      draft.outputTokens,
      draft.totalTokens,
      draft.costRaw,
      draft.costValue,
      draft.costKind,
      draft.model,
      draft.botKey,
      draft.botKey
        ? draft.botKey.replace('demo-', 'demo-bot-').replace('demo-bot-bot-', 'demo-bot-')
        : null,
      draft.botKey ? 'demo:fiche fictive' : null,
      now.toISOString(),
    );
  }
  run(
    db,
    `INSERT INTO events (id, fingerprint, bot_id, reported_bot_key, reported_source, kind, name, detail, payload_json, occurred_at, received_at, linked, is_demo)
     VALUES (?, ?, 'demo-bot-brume', 'demo-brume', 'demonstration', 'status', 'statut', 'Fiche fictive au travail.', ?, ?, ?, 1, 1)`,
    newId(),
    `demo:event:brume:${stale}`,
    JSON.stringify({ status: 'working', tokens: null }),
    stale,
    now.toISOString(),
  );
  run(
    db,
    `INSERT INTO events (id, fingerprint, bot_id, reported_bot_key, reported_source, kind, name, detail, payload_json, occurred_at, received_at, linked, is_demo)
     VALUES (?, ?, 'demo-bot-cale', 'demo-cale', 'demonstration', 'event', 'note', 'Jetons déclarés pour l’exemple, non exhaustifs.', ?, ?, ?, 1, 1)`,
    newId(),
    `demo:event:cale:${fresh}`,
    JSON.stringify({ tokens: { total: 12 } }),
    fresh,
    now.toISOString(),
  );
}

function demoDraft(
  now: Date,
  daysAgo: number,
  hour: number,
  model: string,
  total: number,
  cost: number | null,
  costKind: 'numeric' | 'included' | 'unknown',
  botId: string | null,
  botKey: string,
): UsageDraft {
  const date = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo, hour, 0, 0),
  );
  return {
    line: 0,
    fingerprint: sha256(
      `demo|${daysAgo}|${hour}|${model}|${total}|${costKind}|${botKey}|${botId ?? ''}`,
    ),
    occurredAt: date.toISOString(),
    day: date.toISOString().slice(0, 10),
    inputTokens: Math.round(total * 0.6),
    cacheTokens: Math.round(total * 0.1),
    outputTokens: Math.round(total * 0.3),
    totalTokens: total,
    costRaw: costKind === 'numeric' && cost != null ? String(cost) : '',
    costValue: costKind === 'numeric' ? cost : null,
    costKind,
    model: `modele-${model}`,
    kind: 'demonstration',
    automationId: '',
    botKey,
    messages: [],
    include: true,
  };
}

function usageWhere(
  query: UsageQuery,
  demo: boolean,
): { sql: string; params: Array<string | number | null> } {
  const clauses = ['(? = 1 OR usage_rows.is_demo = 0)'];
  const params: Array<string | number | null> = [demo ? 1 : 0];
  if (query.from) {
    clauses.push('usage_rows.day IS NOT NULL AND usage_rows.day >= ?');
    params.push(query.from);
  }
  if (query.to) {
    clauses.push('usage_rows.day IS NOT NULL AND usage_rows.day <= ?');
    params.push(query.to);
  }
  if (query.model) {
    clauses.push('usage_rows.model = ?');
    params.push(query.model);
  }
  if (query.source === 'csv' || query.source === 'demo') {
    clauses.push('usage_rows.source = ?');
    params.push(query.source);
  }
  if (query.bot === 'unassigned') clauses.push('usage_rows.bot_id IS NULL');
  else if (query.bot) {
    clauses.push('usage_rows.bot_id = ?');
    params.push(query.bot);
  }
  return { sql: clauses.join(' AND '), params };
}

function matchBotId(db: DB, key: string): string | null {
  if (!key) return null;
  const row = get<Row>(
    db,
    `SELECT id FROM bots WHERE archived_at IS NULL AND is_demo = 0 AND (id = ? OR (external_key <> '' AND external_key = ?)) LIMIT 1`,
    key,
    key,
  );
  return row ? str(row, 'id') : null;
}

function nextSlot(db: DB): [number, number] {
  const count = Number(get<Row>(db, 'SELECT COUNT(*) AS n FROM rooms')?.n ?? 0);
  const base = ROOM_SLOTS[count % ROOM_SLOTS.length] ?? [0, 0];
  const turn = Math.floor(count / ROOM_SLOTS.length);
  return [base[0] + turn * 0.12, base[1] + turn * 0.12];
}

function mustTeam(db: DB, id: string): Team {
  const row = get<Row>(db, 'SELECT * FROM teams WHERE id = ?', id);
  if (!row) throw new HttpError(404, 'Équipe introuvable.');
  return mapTeam(row);
}

function assertLinks(db: DB, teamId: string | null, roomId: string | null, demo: boolean): void {
  if (teamId) {
    const team = mustTeam(db, teamId);
    if (team.isDemo !== demo) throw new HttpError(400, 'Équipe incompatible.');
  }
  if (roomId) {
    const row = get<Row>(db, 'SELECT * FROM rooms WHERE id = ?', roomId);
    if (!row) throw new HttpError(404, 'Salle introuvable.');
    if (flag(row, 'is_demo') !== demo) throw new HttpError(400, 'Salle incompatible.');
    const roomTeam = row.team_id == null ? null : str(row, 'team_id');
    if (teamId && roomTeam && roomTeam !== teamId)
      throw new HttpError(400, 'La salle appartient à une autre équipe.');
  }
}

function assertExternalKey(db: DB, key: string, exceptId: string | null): void {
  if (!key) return;
  const row = get<Row>(
    db,
    `SELECT id FROM bots WHERE external_key = ? AND archived_at IS NULL AND is_demo = 0 AND (? IS NULL OR id <> ?)`,
    key,
    exceptId,
    exceptId,
  );
  if (row) throw new HttpError(409, 'Cet identifiant est déjà utilisé par une fiche.');
}

function assertAccent(value: string): string {
  const found = ACCENTS.find((item) => item.toLowerCase() === value.toLowerCase());
  if (!found) throw new HttpError(400, 'Couleur hors palette.');
  return found;
}

function assertStatus(value: string): BotStatus {
  if (!BOT_STATUSES.includes(value as BotStatus)) throw new HttpError(400, 'Statut inconnu.');
  return value as BotStatus;
}

function assertKind(value: string): RoomKind {
  const kinds: RoomKind[] = ['revue', 'atelier', 'salon', 'labo', 'diffusion'];
  if (!kinds.includes(value as RoomKind)) throw new HttpError(400, 'Type de salle inconnu.');
  return value as RoomKind;
}

function required(value: string, max: number, message: string): string {
  const clean = cleanText(value, max);
  if (!clean) throw new HttpError(400, message);
  return clean;
}

function clamp(value: string | undefined, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export function assertDay(value: string | null): string | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, 'Date de filtre invalide.');
  return value;
}

export function exportRows(db: DB, query: UsageQuery): UsageRow[] {
  return listUsage(db, query, readSettings(db).demoMode, 20_000, 0);
}
