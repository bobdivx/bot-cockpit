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
import { adoptOrphanedWorkspace, all, type DB, get, run, transaction } from './db.js';
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

export async function purgeExpired(db: DB, now: Date): Promise<void> {
  const iso = now.toISOString();
  await run(db, 'DELETE FROM sessions WHERE expires_at < ?', iso);
  await run(db, 'DELETE FROM upload_staging WHERE expires_at < ?', iso);
}

export async function readSettings(db: DB, userId: string): Promise<Settings> {
  const rows = await all<Row>(db, 'SELECT key, value FROM settings WHERE user_id = ?', userId);
  const map = new Map(rows.map((row) => [str(row, 'key'), str(row, 'value')]));
  return {
    demoMode: map.get('demo_mode') === '1',
    retentionDays: clamp(map.get('retention_days'), 0, 3650, 0),
    staleMinutes: clamp(map.get('stale_minutes'), 1, 10_080, 30),
  };
}

export async function writeSettings(
  db: DB,
  userId: string,
  patch: { retentionDays?: number; staleMinutes?: number },
  now: Date,
): Promise<Settings> {
  if (patch.retentionDays != null) {
    const days = clamp(String(patch.retentionDays), 0, 3650, 0);
    await run(
      db,
      `INSERT INTO settings (user_id, key, value) VALUES (?, 'retention_days', ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
      userId,
      String(days),
    );
  }
  if (patch.staleMinutes != null) {
    const minutes = clamp(String(patch.staleMinutes), 1, 10_080, 30);
    await run(
      db,
      `INSERT INTO settings (user_id, key, value) VALUES (?, 'stale_minutes', ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
      userId,
      String(minutes),
    );
  }
  await applyRetention(db, userId, now);
  return await readSettings(db, userId);
}

export async function applyRetention(db: DB, userId: string, now: Date): Promise<void> {
  const days = (await readSettings(db, userId)).retentionDays;
  if (days <= 0) return;
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  await run(
    db,
    'DELETE FROM usage_rows WHERE user_id = ? AND is_demo = 0 AND occurred_at IS NOT NULL AND occurred_at < ?',
    userId,
    cutoff,
  );
  await run(
    db,
    'DELETE FROM events WHERE user_id = ? AND is_demo = 0 AND occurred_at < ?',
    userId,
    cutoff,
  );
}

export async function addAudit(
  db: DB,
  userId: string,
  actor: string,
  action: string,
  detail: string,
  now: Date,
): Promise<void> {
  await run(
    db,
    'INSERT INTO audit (id, user_id, actor, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    newId(),
    userId,
    actor,
    action,
    cleanText(detail, 400),
    now.toISOString(),
  );
}

export async function listAudit(db: DB, userId: string): Promise<AuditEntry[]> {
  return (
    await all<Row>(
      db,
      'SELECT * FROM audit WHERE user_id = ? ORDER BY created_at DESC LIMIT 80',
      userId,
    )
  ).map((row) => ({
    id: str(row, 'id'),
    actor: str(row, 'actor'),
    action: str(row, 'action'),
    detail: str(row, 'detail'),
    createdAt: str(row, 'created_at'),
  }));
}

export async function userCount(db: DB): Promise<number> {
  const row = await get<Row>(db, 'SELECT COUNT(*) AS n FROM users');
  return Number(row?.n ?? 0);
}

export async function createOwner(
  db: DB,
  email: string,
  passwordHash: string,
  now: Date,
): Promise<SessionUser & { token: string }> {
  if ((await userCount(db)) > 0) throw new HttpError(409, 'Le propriétaire est déjà configuré.');
  const id = newId();
  await run(
    db,
    'INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)',
    id,
    email,
    passwordHash,
    now.toISOString(),
  );
  await adoptOrphanedWorkspace(db, id);
  await addAudit(db, id, email, 'setup', 'Propriétaire créé.', now);
  return await openSession(db, id, email, now);
}

export async function createUser(
  db: DB,
  email: string,
  passwordHash: string,
  now: Date,
): Promise<SessionUser & { token: string }> {
  const existing = await get<Row>(db, 'SELECT id FROM users WHERE email = ?', email);
  if (existing) throw new HttpError(409, 'Un espace existe déjà pour cette adresse.');
  const id = newId();
  try {
    await run(
      db,
      'INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)',
      id,
      email,
      passwordHash,
      now.toISOString(),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/unique|constraint/i.test(message)) {
      throw new HttpError(409, 'Un espace existe déjà pour cette adresse.');
    }
    throw error;
  }
  if ((await userCount(db)) === 1) {
    await adoptOrphanedWorkspace(db, id);
  }
  await addAudit(db, id, email, 'signup', 'Espace utilisateur créé.', now);
  return await openSession(db, id, email, now);
}

export async function deleteUser(db: DB, userId: string): Promise<void> {
  const changed = await run(db, 'DELETE FROM users WHERE id = ?', userId);
  if (!changed) throw new HttpError(404, 'Compte introuvable.');
}

export async function findOwnerByEmail(
  db: DB,
  email: string,
): Promise<{ id: string; email: string; passwordHash: string } | null> {
  const row = await get<Row>(db, 'SELECT * FROM users WHERE email = ?', email);
  if (!row) return null;
  return { id: str(row, 'id'), email: str(row, 'email'), passwordHash: str(row, 'password_hash') };
}

export async function openSession(
  db: DB,
  userId: string,
  email: string,
  now: Date,
): Promise<SessionUser & { token: string }> {
  const token = newId() + newId();
  const id = newId();
  const expires = new Date(now.getTime() + 14 * 86_400_000).toISOString();
  await run(
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

export async function userFromToken(db: DB, token: string, now: Date): Promise<SessionUser | null> {
  const row = await get<Row>(
    db,
    `SELECT sessions.id AS session_id, sessions.expires_at, users.id, users.email
     FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ?`,
    sha256(token),
  );
  if (!row) return null;
  if (str(row, 'expires_at') < now.toISOString()) {
    await run(db, 'DELETE FROM sessions WHERE id = ?', str(row, 'session_id'));
    return null;
  }
  return { id: str(row, 'id'), email: str(row, 'email'), sessionId: str(row, 'session_id') };
}

export async function deleteSession(db: DB, sessionId: string): Promise<void> {
  await run(db, 'DELETE FROM sessions WHERE id = ?', sessionId);
}

export async function workspace(db: DB, userId: string, now: Date): Promise<Workspace> {
  const settings = await readSettings(db, userId);
  const demo = settings.demoMode ? 1 : 0;
  const teams = (
    await all<Row>(
      db,
      'SELECT * FROM teams WHERE user_id = ? AND (? = 1 OR is_demo = 0) ORDER BY created_at',
      userId,
      demo,
    )
  ).map(mapTeam);
  const rooms = (
    await all<Row>(
      db,
      'SELECT * FROM rooms WHERE user_id = ? AND (? = 1 OR is_demo = 0)',
      userId,
      demo,
    )
  ).map(mapRoom);
  const bots = (
    await all<Row>(
      db,
      'SELECT * FROM bots WHERE user_id = ? AND (? = 1 OR is_demo = 0) ORDER BY name',
      userId,
      demo,
    )
  ).map((row) => mapBot(row, now, settings.staleMinutes));
  const signals = (
    await all<Row>(
      db,
      'SELECT * FROM events WHERE user_id = ? AND (? = 1 OR is_demo = 0) ORDER BY occurred_at DESC LIMIT 40',
      userId,
      demo,
    )
  ).map(mapSignal);
  const imports = (
    await all<Row>(
      db,
      'SELECT * FROM imports WHERE user_id = ? ORDER BY created_at DESC LIMIT 30',
      userId,
    )
  ).map(mapImport);
  return { settings, teams, rooms, bots, signals, imports, webhookActions: [] };
}

export async function createTeam(
  db: DB,
  userId: string,
  input: { name: string; mission: string; accent: string },
  actor: string,
  now: Date,
): Promise<Team> {
  const name = required(input.name, 80, 'Nom d’équipe requis.');
  const accent = assertAccent(input.accent || ACCENTS[0]);
  const id = newId();
  await run(
    db,
    'INSERT INTO teams (id, user_id, name, mission, accent, origin, is_demo, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
    id,
    userId,
    name,
    cleanText(input.mission, 400),
    accent,
    'manual',
    now.toISOString(),
  );
  await addAudit(db, userId, actor, 'team.create', name, now);
  return mapTeam(
    (await get<Row>(db, 'SELECT * FROM teams WHERE id = ? AND user_id = ?', id, userId))!,
  );
}

export async function updateTeam(
  db: DB,
  userId: string,
  id: string,
  input: { name?: string; mission?: string; accent?: string },
): Promise<Team> {
  const current = await mustTeam(db, userId, id);
  if (current.isDemo)
    throw new HttpError(
      400,
      'Les fiches de démonstration se retirent en quittant la démonstration.',
    );
  const name = input.name != null ? required(input.name, 80, 'Nom d’équipe requis.') : current.name;
  const mission = input.mission != null ? cleanText(input.mission, 400) : current.mission;
  const accent = input.accent != null ? assertAccent(input.accent) : current.accent;
  await run(
    db,
    'UPDATE teams SET name = ?, mission = ?, accent = ? WHERE id = ? AND user_id = ?',
    name,
    mission,
    accent,
    id,
    userId,
  );
  return mapTeam(
    (await get<Row>(db, 'SELECT * FROM teams WHERE id = ? AND user_id = ?', id, userId))!,
  );
}

export async function setTeamArchived(
  db: DB,
  userId: string,
  id: string,
  archived: boolean,
  actor: string,
  now: Date,
): Promise<Team> {
  const current = await mustTeam(db, userId, id);
  if (current.isDemo)
    throw new HttpError(
      400,
      'Les fiches de démonstration se retirent en quittant la démonstration.',
    );
  await run(
    db,
    'UPDATE teams SET archived_at = ? WHERE id = ? AND user_id = ?',
    archived ? now.toISOString() : null,
    id,
    userId,
  );
  await addAudit(db, userId, actor, archived ? 'team.archive' : 'team.restore', current.name, now);
  return mapTeam(
    (await get<Row>(db, 'SELECT * FROM teams WHERE id = ? AND user_id = ?', id, userId))!,
  );
}

export async function createRoom(
  db: DB,
  userId: string,
  input: { teamId: string | null; name: string; kind: string },
): Promise<ReturnType<typeof mapRoom>> {
  const name = required(input.name, 80, 'Nom de salle requis.');
  const kind = assertKind(input.kind);
  if (input.teamId) await mustTeam(db, userId, input.teamId);
  const [gridX, gridY] = await nextSlot(db, userId);
  const id = newId();
  await run(
    db,
    'INSERT INTO rooms (id, user_id, team_id, name, kind, grid_x, grid_y, is_demo) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
    id,
    userId,
    input.teamId,
    name,
    kind,
    gridX,
    gridY,
  );
  return mapRoom(
    (await get<Row>(db, 'SELECT * FROM rooms WHERE id = ? AND user_id = ?', id, userId))!,
  );
}

export async function createBot(
  db: DB,
  userId: string,
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
): Promise<Bot> {
  const name = required(input.name, 80, 'Nom de fiche requis.');
  const status = assertStatus(input.status || 'offline');
  await assertLinks(db, userId, input.teamId, input.roomId, false);
  const externalKey = cleanText(input.externalKey, 120);
  await assertExternalKey(db, userId, externalKey, null);
  const id = newId();
  const iso = now.toISOString();
  const seen = status === 'offline' ? null : iso;
  await run(
    db,
    `INSERT INTO bots (id, user_id, external_key, name, role, brief, team_id, room_id, status, status_note, last_seen_at, is_demo, origin, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, 0, 'manual', ?, ?)`,
    id,
    userId,
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
  await run(
    db,
    'INSERT INTO bot_history (id, user_id, bot_id, status, note, source, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    newId(),
    userId,
    id,
    status,
    'Création manuelle',
    'manual',
    iso,
  );
  await addAudit(db, userId, actor, 'bot.create', name, now);
  return await getBot(db, userId, id, now);
}

export async function updateBot(
  db: DB,
  userId: string,
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
): Promise<Bot> {
  const current = await getBot(db, userId, id, now);
  if (current.isDemo)
    throw new HttpError(
      400,
      'Les fiches de démonstration se retirent en quittant la démonstration.',
    );
  const teamId = input.teamId === undefined ? current.teamId : input.teamId;
  const roomId = input.roomId === undefined ? current.roomId : input.roomId;
  await assertLinks(db, userId, teamId, roomId, false);
  const externalKey =
    input.externalKey === undefined ? current.externalKey : cleanText(input.externalKey, 120);
  await assertExternalKey(db, userId, externalKey, id);
  await run(
    db,
    `UPDATE bots SET name = ?, role = ?, brief = ?, team_id = ?, room_id = ?, external_key = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
    input.name != null ? required(input.name, 80, 'Nom de fiche requis.') : current.name,
    input.role != null ? cleanText(input.role, 80) : current.role,
    input.brief != null ? cleanBlock(input.brief, 2000) : current.brief,
    teamId,
    roomId,
    externalKey,
    now.toISOString(),
    id,
    userId,
  );
  return await getBot(db, userId, id, now);
}

export async function setBotStatus(
  db: DB,
  userId: string,
  id: string,
  status: string,
  note: string,
  actor: string,
  now: Date,
): Promise<Bot> {
  const current = await getBot(db, userId, id, now);
  if (current.isDemo)
    throw new HttpError(400, 'Les fiches de démonstration ne reçoivent pas de statut réel.');
  const next = assertStatus(status);
  const iso = now.toISOString();
  const cleanNote = cleanText(note, 500);
  await run(
    db,
    'UPDATE bots SET status = ?, status_note = ?, last_seen_at = ?, updated_at = ? WHERE id = ? AND user_id = ?',
    next,
    cleanNote,
    iso,
    iso,
    id,
    userId,
  );
  await run(
    db,
    'INSERT INTO bot_history (id, user_id, bot_id, status, note, source, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    newId(),
    userId,
    id,
    next,
    cleanNote || 'Mise à jour manuelle',
    'manual',
    iso,
  );
  await addAudit(db, userId, actor, 'bot.status', `${current.name} → ${next}`, now);
  return await getBot(db, userId, id, now);
}

export async function setBotArchived(
  db: DB,
  userId: string,
  id: string,
  archived: boolean,
  actor: string,
  now: Date,
): Promise<Bot> {
  const current = await getBot(db, userId, id, now);
  if (current.isDemo)
    throw new HttpError(
      400,
      'Les fiches de démonstration se retirent en quittant la démonstration.',
    );
  await run(
    db,
    'UPDATE bots SET archived_at = ?, updated_at = ? WHERE id = ? AND user_id = ?',
    archived ? now.toISOString() : null,
    now.toISOString(),
    id,
    userId,
  );
  await addAudit(db, userId, actor, archived ? 'bot.archive' : 'bot.restore', current.name, now);
  return await getBot(db, userId, id, now);
}

export async function getBot(db: DB, userId: string, id: string, now: Date): Promise<Bot> {
  const row = await get<Row>(db, 'SELECT * FROM bots WHERE id = ? AND user_id = ?', id, userId);
  if (!row) throw new HttpError(404, 'Fiche introuvable.');
  return mapBot(row, now, (await readSettings(db, userId)).staleMinutes);
}

export async function botHistory(db: DB, userId: string, id: string): Promise<HistoryEntry[]> {
  return (
    await all<Row>(
      db,
      'SELECT * FROM bot_history WHERE bot_id = ? AND user_id = ? ORDER BY occurred_at DESC LIMIT 40',
      id,
      userId,
    )
  ).map(mapHistory);
}

export async function applyPack(
  db: DB,
  userId: string,
  packId: string,
  actor: string,
  now: Date,
): Promise<Team> {
  const pack = packById(packId);
  if (!pack) throw new HttpError(404, 'Consigne introuvable.');
  const existing = Number(
    (
      await get<Row>(
        db,
        'SELECT COUNT(*) AS n FROM teams WHERE user_id = ? AND origin = ?',
        userId,
        `pack:${pack.id}`,
      )
    )?.n ?? 0,
  );
  const suffix = existing === 0 ? '' : ` ${existing + 1}`;
  return await transaction(db, async () => {
    const teamId = newId();
    const iso = now.toISOString();
    await run(
      db,
      'INSERT INTO teams (id, user_id, name, mission, accent, origin, is_demo, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
      teamId,
      userId,
      `${pack.name}${suffix}`,
      pack.mission,
      pack.accent,
      `pack:${pack.id}`,
      iso,
    );
    const roomIds: string[] = [];
    for (const room of pack.rooms) {
      const [gridX, gridY] = await nextSlot(db, userId);
      const id = newId();
      await run(
        db,
        'INSERT INTO rooms (id, user_id, team_id, name, kind, grid_x, grid_y, is_demo) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
        id,
        userId,
        teamId,
        room.name,
        room.kind,
        gridX,
        gridY,
      );
      roomIds.push(id);
    }
    for (const [index, bot] of pack.bots.entries()) {
      const id = newId();
      const roomId = roomIds[index % roomIds.length] ?? null;
      await run(
        db,
        `INSERT INTO bots (id, user_id, external_key, name, role, brief, team_id, room_id, status, status_note, last_seen_at, is_demo, origin, created_at, updated_at)
         VALUES (?, ?, '', ?, ?, ?, ?, ?, 'offline', '', NULL, 0, ?, ?, ?)`,
        id,
        userId,
        bot.name,
        bot.role,
        bot.brief,
        teamId,
        roomId,
        `pack:${pack.id}`,
        iso,
        iso,
      );
    }
    await addAudit(
      db,
      userId,
      actor,
      'pack.apply',
      `${pack.name} — fiches manuelles, aucun code exécuté.`,
      now,
    );
    return mapTeam(
      (await get<Row>(db, 'SELECT * FROM teams WHERE id = ? AND user_id = ?', teamId, userId))!,
    );
  });
}

export async function setDemoMode(
  db: DB,
  userId: string,
  enabled: boolean,
  actor: string,
  now: Date,
): Promise<Settings> {
  await transaction(db, async () => {
    await clearDemo(db, userId);
    if (enabled) await seedDemo(db, userId, now);
    await run(
      db,
      `INSERT INTO settings (user_id, key, value) VALUES (?, 'demo_mode', ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
      userId,
      enabled ? '1' : '0',
    );
    await addAudit(
      db,
      userId,
      actor,
      enabled ? 'demo.on' : 'demo.off',
      enabled ? 'Données de démonstration activées.' : 'Données de démonstration retirées.',
      now,
    );
  });
  return await readSettings(db, userId);
}

export async function saveStaging(
  db: DB,
  userId: string,
  filename: string,
  headers: string[],
  records: string[][],
  errors: Array<{ line: number; message: string }>,
  now: Date,
): Promise<string> {
  const iso = now.toISOString();
  await run(db, 'DELETE FROM upload_staging WHERE expires_at < ?', iso);
  const id = newId();
  const expires = new Date(now.getTime() + 30 * 60_000).toISOString();
  await run(
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

export async function readStaging(
  db: DB,
  id: string,
  userId: string,
  now: Date,
): Promise<{
  filename: string;
  headers: string[];
  records: string[][];
  errors: Array<{ line: number; message: string }>;
}> {
  const row = await get<Row>(
    db,
    'SELECT * FROM upload_staging WHERE id = ? AND user_id = ?',
    id,
    userId,
  );
  if (!row || str(row, 'expires_at') < now.toISOString())
    throw new HttpError(404, 'Aperçu expiré. Déposez le fichier à nouveau.');
  return {
    filename: str(row, 'filename'),
    headers: JSON.parse(str(row, 'headers_json')) as string[],
    records: JSON.parse(str(row, 'records_json')) as string[][],
    errors: JSON.parse(str(row, 'errors_json')) as Array<{ line: number; message: string }>,
  };
}

export async function commitStaging(
  db: DB,
  id: string,
  userId: string,
  mapping: ColumnMapping,
  actor: string,
  now: Date,
): Promise<UsageImport> {
  const staging = await readStaging(db, id, userId, now);
  assertMapping(staging.headers, mapping);
  const drafts = interpretRows(staging.headers, staging.records, mapping);
  const included = drafts.filter((draft) => draft.include);
  if (included.length === 0) throw new HttpError(400, 'Aucune ligne exploitable.');
  return await transaction(db, async () => {
    const importId = newId();
    const iso = now.toISOString();
    let rowCount = 0;
    let duplicates = 0;
    const skipped = drafts.length - included.length;
    const seen = new Set<string>();
    await run(
      db,
      `INSERT INTO imports (id, user_id, filename, mapping_json, row_count, duplicate_count, skipped_count, error_count, created_at)
       VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?)`,
      importId,
      userId,
      staging.filename,
      JSON.stringify(mapping),
      staging.errors.length,
      iso,
    );
    for (const draft of included) {
      if (
        seen.has(draft.fingerprint) ||
        (await get<Row>(
          db,
          'SELECT id FROM usage_rows WHERE user_id = ? AND fingerprint = ?',
          userId,
          draft.fingerprint,
        ))
      ) {
        duplicates += 1;
        continue;
      }
      seen.add(draft.fingerprint);
      const botId = await matchBotId(db, userId, draft.botKey);
      await run(
        db,
        `INSERT INTO usage_rows (
          id, user_id, import_id, fingerprint, occurred_at, day, input_tokens, cache_tokens, output_tokens, total_tokens,
          cost_raw, cost_value, cost_kind, model, kind, automation_id, reported_bot_key, bot_id, assignment_provenance,
          source, is_demo, raw_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'csv', 0, ?, ?)`,
        newId(),
        userId,
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
    await run(
      db,
      'UPDATE imports SET row_count = ?, duplicate_count = ?, skipped_count = ? WHERE id = ?',
      rowCount,
      duplicates,
      skipped,
      importId,
    );
    await run(db, 'DELETE FROM upload_staging WHERE id = ?', id);
    await addAudit(
      db,
      userId,
      actor,
      'usage.import',
      `${staging.filename} · ${rowCount} ligne(s), ${duplicates} doublon(s).`,
      now,
    );
    return mapImport(
      (await get<Row>(db, 'SELECT * FROM imports WHERE id = ? AND user_id = ?', importId, userId))!,
    );
  });
}

export type UsageQuery = {
  from: string | null;
  to: string | null;
  model: string | null;
  source: string | null;
  bot: string | null;
};

export async function usageSummary(
  db: DB,
  userId: string,
  query: UsageQuery,
): Promise<UsageSummary> {
  const settings = await readSettings(db, userId);
  const rows = await listUsage(db, userId, query, settings.demoMode, 20_000, 0);
  const signals = await eventTokenCount(db, userId, settings.demoMode);
  return summarizeUsage(rows, query, signals);
}

export async function listUsage(
  db: DB,
  userId: string,
  query: UsageQuery,
  demo: boolean,
  limit: number,
  offset: number,
): Promise<UsageRow[]> {
  const filter = usageWhere(query, demo, userId);
  return (
    await all<Row>(
      db,
      `SELECT usage_rows.*, bots.name AS bot_name
     FROM usage_rows LEFT JOIN bots ON bots.id = usage_rows.bot_id
     WHERE ${filter.sql}
     ORDER BY COALESCE(usage_rows.occurred_at, usage_rows.created_at) DESC
     LIMIT ? OFFSET ?`,
      ...filter.params,
      limit,
      offset,
    )
  ).map(mapUsage);
}

export async function assignUsage(
  db: DB,
  userId: string,
  rowId: string,
  botId: string | null,
  note: string,
  actor: string,
  now: Date,
): Promise<UsageRow> {
  const row = await get<Row>(
    db,
    'SELECT * FROM usage_rows WHERE id = ? AND user_id = ?',
    rowId,
    userId,
  );
  if (!row) throw new HttpError(404, 'Ligne introuvable.');
  if (flag(row, 'is_demo'))
    throw new HttpError(400, 'Les lignes de démonstration ne s’attribuent pas.');
  let provenance = 'manuel: retrait';
  if (botId) {
    const bot = await getBot(db, userId, botId, now);
    if (bot.isDemo)
      throw new HttpError(400, 'Une fiche de démonstration ne reçoit pas de données réelles.');
    if (bot.archivedAt) throw new HttpError(400, 'Cette fiche est archivée.');
    provenance = `manuel: ${cleanText(note, 180) || 'attribution manuelle'}`;
  }
  await run(
    db,
    'UPDATE usage_rows SET bot_id = ?, assignment_provenance = ? WHERE id = ? AND user_id = ?',
    botId,
    provenance,
    rowId,
    userId,
  );
  await addAudit(db, userId, actor, 'usage.assign', provenance, now);
  return mapUsage(
    (await get<Row>(
      db,
      `SELECT usage_rows.*, bots.name AS bot_name FROM usage_rows LEFT JOIN bots ON bots.id = usage_rows.bot_id WHERE usage_rows.id = ? AND usage_rows.user_id = ?`,
      rowId,
      userId,
    ))!,
  );
}

export async function deleteImport(
  db: DB,
  userId: string,
  id: string,
  actor: string,
  now: Date,
): Promise<void> {
  const row = await get<Row>(db, 'SELECT * FROM imports WHERE id = ? AND user_id = ?', id, userId);
  if (!row) throw new HttpError(404, 'Import introuvable.');
  await run(db, 'DELETE FROM imports WHERE id = ? AND user_id = ?', id, userId);
  await addAudit(db, userId, actor, 'usage.delete', str(row, 'filename'), now);
}

export async function resetUsage(db: DB, userId: string, actor: string, now: Date): Promise<void> {
  await transaction(db, async () => {
    await run(db, `DELETE FROM usage_rows WHERE user_id = ? AND source = 'csv'`, userId);
    await run(db, 'DELETE FROM imports WHERE user_id = ?', userId);
    await run(db, 'DELETE FROM upload_staging WHERE user_id = ?', userId);
    await addAudit(db, userId, actor, 'usage.reset', 'Imports CSV effacés.', now);
  });
}

export async function resetWorkshop(
  db: DB,
  userId: string,
  actor: string,
  now: Date,
): Promise<void> {
  await transaction(db, async () => {
    await run(db, 'DELETE FROM bot_history WHERE user_id = ?', userId);
    await run(db, 'DELETE FROM events WHERE user_id = ?', userId);
    await run(db, 'DELETE FROM usage_rows WHERE user_id = ?', userId);
    await run(db, 'DELETE FROM imports WHERE user_id = ?', userId);
    await run(db, 'DELETE FROM upload_staging WHERE user_id = ?', userId);
    await run(db, 'DELETE FROM bots WHERE user_id = ?', userId);
    await run(db, 'DELETE FROM rooms WHERE user_id = ?', userId);
    await run(db, 'DELETE FROM teams WHERE user_id = ?', userId);
    await run(db, 'DELETE FROM webhook_calls WHERE user_id = ?', userId);
    await run(
      db,
      `INSERT INTO settings (user_id, key, value) VALUES (?, 'demo_mode', '0') ON CONFLICT(user_id, key) DO UPDATE SET value = '0'`,
      userId,
    );
    await addAudit(
      db,
      userId,
      actor,
      'workshop.reset',
      'Atelier vidé. Le compte et les jetons MCP sont conservés.',
      now,
    );
  });
}

export async function listTokens(
  db: DB,
  userId: string,
): Promise<
  Array<{
    id: string;
    label: string;
    hint: string;
    createdAt: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
  }>
> {
  return (
    await all<Row>(
      db,
      'SELECT * FROM mcp_tokens WHERE user_id = ? ORDER BY created_at DESC',
      userId,
    )
  ).map((row) => ({
    id: str(row, 'id'),
    label: str(row, 'label'),
    hint: str(row, 'hint'),
    createdAt: str(row, 'created_at'),
    lastUsedAt: row.last_used_at == null ? null : str(row, 'last_used_at'),
    revokedAt: row.revoked_at == null ? null : str(row, 'revoked_at'),
  }));
}

export async function insertToken(
  db: DB,
  userId: string,
  label: string,
  hash: string,
  hint: string,
  actor: string,
  now: Date,
): Promise<string> {
  const id = newId();
  await run(
    db,
    'INSERT INTO mcp_tokens (id, user_id, label, token_hash, hint, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    id,
    userId,
    required(label, 80, 'Libellé requis.'),
    hash,
    hint,
    now.toISOString(),
  );
  await addAudit(db, userId, actor, 'token.create', `Jeton ${hint}… créé.`, now);
  return id;
}

export async function revokeToken(
  db: DB,
  userId: string,
  id: string,
  actor: string,
  now: Date,
): Promise<void> {
  const row = await get<Row>(
    db,
    'SELECT * FROM mcp_tokens WHERE id = ? AND user_id = ?',
    id,
    userId,
  );
  if (!row) throw new HttpError(404, 'Jeton introuvable.');
  await run(
    db,
    'UPDATE mcp_tokens SET revoked_at = ? WHERE id = ? AND user_id = ?',
    now.toISOString(),
    id,
    userId,
  );
  await addAudit(db, userId, actor, 'token.revoke', `Jeton ${str(row, 'hint')}… révoqué.`, now);
}

export async function authenticateToken(
  db: DB,
  secret: string,
): Promise<{ id: string; label: string; userId: string } | null> {
  const row = await get<Row>(
    db,
    'SELECT id, label, user_id, revoked_at FROM mcp_tokens WHERE token_hash = ?',
    sha256(secret),
  );
  if (!row || row.revoked_at) return null;
  return { id: str(row, 'id'), label: str(row, 'label'), userId: str(row, 'user_id') };
}

export async function touchToken(db: DB, id: string, now: Date): Promise<void> {
  await run(db, 'UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?', now.toISOString(), id);
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

export async function recordSignal(
  db: DB,
  userId: string,
  input: SignalInput,
  now: Date,
): Promise<{ duplicate: boolean; linked: boolean; botId: string | null; message: string }> {
  const botKey = required(input.botKey, 120, 'Identifiant de bot requis.');
  const source = cleanText(input.source, 80) || 'bot';
  const name = cleanText(input.name, 120) || (input.kind === 'status' ? 'statut' : 'evenement');
  const detail = cleanText(input.detail, 1000);
  const fingerprint = sha256(JSON.stringify({ ...input, botKey, source, name, detail }));
  const existing = await get<Row>(
    db,
    'SELECT id, bot_id FROM events WHERE user_id = ? AND fingerprint = ?',
    userId,
    fingerprint,
  );
  if (existing) {
    return {
      duplicate: true,
      linked: Boolean(existing.bot_id),
      botId: existing.bot_id == null ? null : str(existing, 'bot_id'),
      message: 'Signal déjà enregistré.',
    };
  }
  const botRow = await get<Row>(
    db,
    `SELECT * FROM bots WHERE user_id = ? AND archived_at IS NULL AND is_demo = 0 AND (id = ? OR (external_key <> '' AND external_key = ?))
     ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END LIMIT 1`,
    userId,
    botKey,
    botKey,
    botKey,
  );
  const botId = botRow ? str(botRow, 'id') : null;
  const received = now.toISOString();
  await run(
    db,
    `INSERT INTO events (id, user_id, fingerprint, bot_id, reported_bot_key, reported_source, kind, name, detail, payload_json, occurred_at, received_at, linked, is_demo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    newId(),
    userId,
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
      await run(
        db,
        'INSERT INTO bot_history (id, user_id, bot_id, status, note, source, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        newId(),
        userId,
        botId,
        input.status,
        detail || name,
        'mcp',
        input.occurredAt,
      );
      if (newer) {
        await run(
          db,
          'UPDATE bots SET status = ?, status_note = ?, last_seen_at = ?, updated_at = ? WHERE id = ? AND user_id = ?',
          input.status,
          detail,
          input.occurredAt,
          received,
          botId,
          userId,
        );
      }
    } else if (newer) {
      await run(
        db,
        'UPDATE bots SET last_seen_at = ?, updated_at = ? WHERE id = ? AND user_id = ?',
        input.occurredAt,
        received,
        botId,
        userId,
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

export async function listEvents(db: DB, userId: string, demo: boolean): Promise<Signal[]> {
  return (
    await all<Row>(
      db,
      'SELECT * FROM events WHERE user_id = ? AND (? = 1 OR is_demo = 0) ORDER BY occurred_at DESC LIMIT 100',
      userId,
      demo ? 1 : 0,
    )
  ).map(mapSignal);
}

export async function materializeSignal(
  db: DB,
  userId: string,
  eventId: string,
  name: string,
  actor: string,
  now: Date,
): Promise<Bot> {
  const event = await get<Row>(
    db,
    'SELECT * FROM events WHERE id = ? AND user_id = ? AND is_demo = 0',
    eventId,
    userId,
  );
  if (!event) throw new HttpError(404, 'Signal introuvable.');
  const key = str(event, 'reported_bot_key');
  const existing = await get<Row>(
    db,
    `SELECT id FROM bots WHERE user_id = ? AND archived_at IS NULL AND is_demo = 0 AND (id = ? OR (external_key <> '' AND external_key = ?)) LIMIT 1`,
    userId,
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
    await run(
      db,
      `INSERT INTO bots (id, user_id, external_key, name, role, brief, team_id, room_id, status, status_note, last_seen_at, is_demo, origin, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'À préciser', '', NULL, NULL, ?, '', NULL, 0, 'manual', ?, ?)`,
      botId,
      userId,
      key,
      required(name, 80, 'Nom de fiche requis.'),
      status,
      iso,
      iso,
    );
  }
  await run(
    db,
    'UPDATE events SET bot_id = ?, linked = 1 WHERE user_id = ? AND reported_bot_key = ? AND bot_id IS NULL AND is_demo = 0',
    botId,
    userId,
    key,
  );
  const newest = await get<Row>(
    db,
    `SELECT * FROM events WHERE user_id = ? AND bot_id = ? AND kind = 'status' ORDER BY occurred_at DESC LIMIT 1`,
    userId,
    botId,
  );
  if (newest) {
    const payload = JSON.parse(str(newest, 'payload_json') || '{}') as { status?: string };
    if (payload.status && BOT_STATUSES.includes(payload.status as BotStatus)) {
      await run(
        db,
        'UPDATE bots SET status = ?, status_note = ?, last_seen_at = ?, updated_at = ? WHERE id = ? AND user_id = ?',
        payload.status,
        str(newest, 'detail'),
        str(newest, 'occurred_at'),
        iso,
        botId,
        userId,
      );
    }
  }
  await addAudit(db, userId, actor, 'event.materialize', `Fiche reliée à ${key}.`, now);
  return await getBot(db, userId, botId, now);
}

export async function recentWebhookCount(
  db: DB,
  userId: string,
  action: string,
  now: Date,
): Promise<number> {
  const since = new Date(now.getTime() - 3_600_000).toISOString();
  const row = await get<Row>(
    db,
    'SELECT COUNT(*) AS n FROM webhook_calls WHERE user_id = ? AND action_name = ? AND created_at >= ?',
    userId,
    action,
    since,
  );
  return Number(row?.n ?? 0);
}

export async function insertWebhookCall(
  db: DB,
  userId: string,
  input: {
    action: string;
    botId: string | null;
    status: 'requested' | 'failed' | 'blocked';
    httpStatus: number | null;
    detail: string;
  },
  now: Date,
): Promise<WebhookCall> {
  const id = newId();
  await run(
    db,
    'INSERT INTO webhook_calls (id, user_id, action_name, bot_id, status, http_status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    userId,
    input.action,
    input.botId,
    input.status,
    input.httpStatus,
    cleanText(input.detail, 400),
    now.toISOString(),
  );
  return mapWebhook(
    (await get<Row>(db, 'SELECT * FROM webhook_calls WHERE id = ? AND user_id = ?', id, userId))!,
  );
}

export async function listWebhookCalls(db: DB, userId: string): Promise<WebhookCall[]> {
  return (
    await all<Row>(
      db,
      'SELECT * FROM webhook_calls WHERE user_id = ? ORDER BY created_at DESC LIMIT 40',
      userId,
    )
  ).map(mapWebhook);
}

export async function eventTokenCount(db: DB, userId: string, demo: boolean): Promise<number> {
  const rows = await all<Row>(
    db,
    'SELECT payload_json FROM events WHERE user_id = ? AND (? = 1 OR is_demo = 0)',
    userId,
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

async function clearDemo(db: DB, userId: string): Promise<void> {
  const ids = (
    await all<Row>(db, 'SELECT id FROM bots WHERE user_id = ? AND is_demo = 1', userId)
  ).map((row) => str(row, 'id'));
  for (const id of ids)
    await run(db, 'DELETE FROM bot_history WHERE bot_id = ? AND user_id = ?', id, userId);
  await run(db, 'DELETE FROM events WHERE user_id = ? AND is_demo = 1', userId);
  await run(db, 'DELETE FROM usage_rows WHERE user_id = ? AND is_demo = 1', userId);
  await run(db, 'DELETE FROM bots WHERE user_id = ? AND is_demo = 1', userId);
  await run(db, 'DELETE FROM rooms WHERE user_id = ? AND is_demo = 1', userId);
  await run(db, 'DELETE FROM teams WHERE user_id = ? AND is_demo = 1', userId);
}

async function seedDemo(db: DB, userId: string, now: Date): Promise<void> {
  const pack = PACKS[0]!;
  const dev = PACKS[1]!;
  const demoId = (name: string) => `demo:${userId}:${name}`;
  const teamId = demoId('team-qualite');
  const otherId = demoId('team-dev');
  const roomRelecture = demoId('room-relecture');
  const roomCas = demoId('room-cas');
  const roomEtabli = demoId('room-etabli');
  const botBrume = demoId('bot-brume');
  const botCale = demoId('bot-cale');
  const botRive = demoId('bot-rive');
  const botTrame = demoId('bot-trame');
  await run(
    db,
    'INSERT INTO teams (id, user_id, name, mission, accent, origin, is_demo, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
    teamId,
    userId,
    pack.name,
    pack.mission,
    pack.accent,
    'demo',
    now.toISOString(),
  );
  await run(
    db,
    'INSERT INTO teams (id, user_id, name, mission, accent, origin, is_demo, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
    otherId,
    userId,
    dev.name,
    dev.mission,
    dev.accent,
    'demo',
    now.toISOString(),
  );
  const rooms: Array<[string, string, string, string, number, number]> = [
    [roomRelecture, teamId, 'Table de relecture', 'revue', 0.15, 0.2],
    [roomCas, teamId, 'Paillasse des cas', 'labo', 2.35, 0.15],
    [roomEtabli, otherId, 'Établi', 'atelier', 0.2, 2.25],
  ];
  for (const room of rooms) {
    await run(
      db,
      'INSERT INTO rooms (id, user_id, team_id, name, kind, grid_x, grid_y, is_demo) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
      room[0],
      userId,
      room[1],
      room[2],
      room[3],
      room[4],
      room[5],
    );
  }
  const stale = new Date(now.getTime() - 3 * 3_600_000).toISOString();
  const fresh = new Date(now.getTime() - 4 * 60_000).toISOString();
  const bots = [
    [
      botBrume,
      'demo-brume',
      'Brume',
      'Relecture',
      pack.bots[0]!.brief,
      teamId,
      roomRelecture,
      'working',
      stale,
    ],
    [
      botCale,
      'demo-cale',
      'Cale',
      'Cas limites',
      pack.bots[1]!.brief,
      teamId,
      roomCas,
      'idle',
      fresh,
    ],
    [
      botRive,
      'demo-rive',
      'Rive',
      'Compte-rendu',
      pack.bots[2]!.brief,
      teamId,
      roomRelecture,
      'away',
      fresh,
    ],
    [
      botTrame,
      'demo-trame',
      'Trame',
      'Découpage',
      dev.bots[0]!.brief,
      otherId,
      roomEtabli,
      'idle',
      fresh,
    ],
  ] as const;
  for (const bot of bots) {
    await run(
      db,
      `INSERT INTO bots (id, user_id, external_key, name, role, brief, team_id, room_id, status, status_note, last_seen_at, is_demo, origin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Fiche fictive', ?, 1, 'demo', ?, ?)`,
      bot[0],
      userId,
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
    demoDraft(now, 1, 9, 'demo-a', 1200, 1.25, 'numeric', botBrume, 'demo-brume'),
    demoDraft(now, 2, 9, 'demo-a', 800, null, 'included', botCale, 'demo-cale'),
    demoDraft(now, 3, 11, 'demo-b', 400, null, 'unknown', null, ''),
    demoDraft(now, 4, 15, 'demo-b', 50, 0, 'numeric', botTrame, 'demo-trame'),
  ];
  samples[1]!.costRaw = 'Included';
  samples[2]!.costRaw = '-';
  samples.push({
    ...demoDraft(now, 1, 18, 'demo-a', 0, 2.5, 'numeric', botRive, 'demo-rive'),
    totalTokens: null,
    inputTokens: 10,
    messages: ['Total absent, volontairement.'],
  });
  for (const draft of samples) {
    await run(
      db,
      `INSERT INTO usage_rows (
        id, user_id, import_id, fingerprint, occurred_at, day, input_tokens, cache_tokens, output_tokens, total_tokens,
        cost_raw, cost_value, cost_kind, model, kind, automation_id, reported_bot_key, bot_id, assignment_provenance,
        source, is_demo, raw_json, created_at
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'demonstration', '', ?, ?, ?, 'demo', 1, '{}', ?)`,
      newId(),
      userId,
      `demo:${userId}:${draft.fingerprint}`,
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
      draft.botKey === 'demo-brume'
        ? botBrume
        : draft.botKey === 'demo-cale'
          ? botCale
          : draft.botKey === 'demo-rive'
            ? botRive
            : draft.botKey === 'demo-trame'
              ? botTrame
              : null,
      draft.botKey ? 'demo:fiche fictive' : null,
      now.toISOString(),
    );
  }
  await run(
    db,
    `INSERT INTO events (id, user_id, fingerprint, bot_id, reported_bot_key, reported_source, kind, name, detail, payload_json, occurred_at, received_at, linked, is_demo)
     VALUES (?, ?, ?, ?, 'demo-brume', 'demonstration', 'status', 'statut', 'Fiche fictive au travail.', ?, ?, ?, 1, 1)`,
    newId(),
    userId,
    `demo:${userId}:event:brume:${stale}`,
    botBrume,
    JSON.stringify({ status: 'working', tokens: null }),
    stale,
    now.toISOString(),
  );
  await run(
    db,
    `INSERT INTO events (id, user_id, fingerprint, bot_id, reported_bot_key, reported_source, kind, name, detail, payload_json, occurred_at, received_at, linked, is_demo)
     VALUES (?, ?, ?, ?, 'demo-cale', 'demonstration', 'event', 'note', 'Jetons déclarés pour l’exemple, non exhaustifs.', ?, ?, ?, 1, 1)`,
    newId(),
    userId,
    `demo:${userId}:event:cale:${fresh}`,
    botCale,
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
  userId: string,
): { sql: string; params: Array<string | number | null> } {
  const clauses = ['usage_rows.user_id = ?', '(? = 1 OR usage_rows.is_demo = 0)'];
  const params: Array<string | number | null> = [userId, demo ? 1 : 0];
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

async function matchBotId(db: DB, userId: string, key: string): Promise<string | null> {
  if (!key) return null;
  const row = await get<Row>(
    db,
    `SELECT id FROM bots WHERE user_id = ? AND archived_at IS NULL AND is_demo = 0 AND (id = ? OR (external_key <> '' AND external_key = ?)) LIMIT 1`,
    userId,
    key,
    key,
  );
  return row ? str(row, 'id') : null;
}

async function nextSlot(db: DB, userId: string): Promise<[number, number]> {
  const count = Number(
    (await get<Row>(db, 'SELECT COUNT(*) AS n FROM rooms WHERE user_id = ?', userId))?.n ?? 0,
  );
  const base = ROOM_SLOTS[count % ROOM_SLOTS.length] ?? [0, 0];
  const turn = Math.floor(count / ROOM_SLOTS.length);
  return [base[0] + turn * 0.12, base[1] + turn * 0.12];
}

async function mustTeam(db: DB, userId: string, id: string): Promise<Team> {
  const row = await get<Row>(db, 'SELECT * FROM teams WHERE id = ? AND user_id = ?', id, userId);
  if (!row) throw new HttpError(404, 'Équipe introuvable.');
  return mapTeam(row);
}

async function assertLinks(
  db: DB,
  userId: string,
  teamId: string | null,
  roomId: string | null,
  demo: boolean,
): Promise<void> {
  if (teamId) {
    const team = await mustTeam(db, userId, teamId);
    if (team.isDemo !== demo) throw new HttpError(400, 'Équipe incompatible.');
  }
  if (roomId) {
    const row = await get<Row>(
      db,
      'SELECT * FROM rooms WHERE id = ? AND user_id = ?',
      roomId,
      userId,
    );
    if (!row) throw new HttpError(404, 'Salle introuvable.');
    if (flag(row, 'is_demo') !== demo) throw new HttpError(400, 'Salle incompatible.');
    const roomTeam = row.team_id == null ? null : str(row, 'team_id');
    if (teamId && roomTeam && roomTeam !== teamId)
      throw new HttpError(400, 'La salle appartient à une autre équipe.');
  }
}

async function assertExternalKey(
  db: DB,
  userId: string,
  key: string,
  exceptId: string | null,
): Promise<void> {
  if (!key) return;
  const row = await get<Row>(
    db,
    `SELECT id FROM bots WHERE user_id = ? AND external_key = ? AND archived_at IS NULL AND is_demo = 0 AND (? IS NULL OR id <> ?)`,
    userId,
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

export async function exportRows(db: DB, userId: string, query: UsageQuery): Promise<UsageRow[]> {
  return await listUsage(db, userId, query, (await readSettings(db, userId)).demoMode, 20_000, 0);
}
