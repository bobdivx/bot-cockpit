import type { OnboardingState, OnboardingStatus } from '../shared/types.js';
import { type DB, get, run } from './db.js';
import { HttpError } from './security.js';
import { addAudit, insertToken, revokeToken } from './store.js';

type Row = Record<string, unknown>;
const STATUSES: OnboardingStatus[] = ['pending', 'skipped', 'done'];
export const WIZARD_STEPS = 5;

const text = (row: Row | undefined, key: string): string | null =>
  row && row[key] != null ? String(row[key]) : null;

async function ensureRow(db: DB, userId: string, now: Date): Promise<Row> {
  const existing = await get<Row>(db, 'SELECT * FROM onboarding WHERE user_id = ?', userId);
  if (existing) return existing;
  const stamp = now.toISOString();
  await run(
    db,
    `INSERT OR IGNORE INTO onboarding (user_id, status, step, started_at, updated_at)
     VALUES (?, 'pending', 0, ?, ?)`,
    userId,
    stamp,
    stamp,
  );
  return (await get<Row>(db, 'SELECT * FROM onboarding WHERE user_id = ?', userId)) as Row;
}

/** A connection counts as configured once any active token has been used by a bot. */
export async function readOnboarding(db: DB, userId: string, now: Date): Promise<OnboardingState> {
  const row = await ensureRow(db, userId, now);
  const tokenId = text(row, 'token_id');
  const wizardToken = tokenId
    ? await get<Row>(
        db,
        'SELECT id, hint, created_at, last_used_at, revoked_at FROM mcp_tokens WHERE id = ? AND user_id = ?',
        tokenId,
        userId,
      )
    : undefined;
  const used = await get<Row>(
    db,
    `SELECT id, hint, last_used_at FROM mcp_tokens
     WHERE user_id = ? AND revoked_at IS NULL AND last_used_at IS NOT NULL
     ORDER BY last_used_at DESC LIMIT 1`,
    userId,
  );
  const lastSignal = await get<Row>(
    db,
    `SELECT id, reported_bot_key, kind, name, received_at, linked FROM events
     WHERE user_id = ? AND is_demo = 0 ORDER BY received_at DESC LIMIT 1`,
    userId,
  );
  const status = (text(row, 'status') ?? 'pending') as OnboardingStatus;
  return {
    status: STATUSES.includes(status) ? status : 'pending',
    step: Math.max(0, Math.min(WIZARD_STEPS - 1, Number(row.step ?? 0))),
    configured: Boolean(used),
    token:
      wizardToken && !wizardToken.revoked_at
        ? {
            id: String(wizardToken.id),
            hint: String(wizardToken.hint),
            createdAt: String(wizardToken.created_at),
            lastUsedAt: text(wizardToken, 'last_used_at'),
          }
        : null,
    lastCall: used ? { tokenHint: String(used.hint), at: String(used.last_used_at) } : null,
    lastSignal: lastSignal
      ? {
          id: String(lastSignal.id),
          linked: Boolean(Number(lastSignal.linked ?? 0)),
          botKey: String(lastSignal.reported_bot_key),
          kind: String(lastSignal.kind),
          name: String(lastSignal.name),
          receivedAt: String(lastSignal.received_at),
        }
      : null,
    completedAt: text(row, 'completed_at'),
    skippedAt: text(row, 'skipped_at'),
  };
}

export async function updateOnboarding(
  db: DB,
  userId: string,
  input: { step?: unknown; status?: unknown },
  now: Date,
): Promise<OnboardingState> {
  await ensureRow(db, userId, now);
  const stamp = now.toISOString();
  if (input.step !== undefined) {
    const step = Number(input.step);
    if (!Number.isInteger(step) || step < 0 || step >= WIZARD_STEPS)
      throw new HttpError(400, 'Étape inconnue.');
    await run(
      db,
      'UPDATE onboarding SET step = ?, updated_at = ? WHERE user_id = ?',
      step,
      stamp,
      userId,
    );
  }
  if (input.status !== undefined) {
    const status = String(input.status) as OnboardingStatus;
    if (!STATUSES.includes(status)) throw new HttpError(400, 'Statut inconnu.');
    await run(
      db,
      `UPDATE onboarding SET status = ?, updated_at = ?,
         completed_at = CASE WHEN ? = 'done' THEN ? ELSE completed_at END,
         skipped_at = CASE WHEN ? = 'skipped' THEN ? ELSE skipped_at END
       WHERE user_id = ?`,
      status,
      stamp,
      status,
      stamp,
      status,
      stamp,
      userId,
    );
  }
  return readOnboarding(db, userId, now);
}

export async function restartOnboarding(
  db: DB,
  userId: string,
  actor: string,
  now: Date,
): Promise<OnboardingState> {
  await ensureRow(db, userId, now);
  await run(
    db,
    `UPDATE onboarding SET status = 'pending', step = 0, updated_at = ?, completed_at = NULL, skipped_at = NULL
     WHERE user_id = ?`,
    now.toISOString(),
    userId,
  );
  await addAudit(
    db,
    userId,
    actor,
    'onboarding.restart',
    'Assistant de configuration relancé.',
    now,
  );
  return readOnboarding(db, userId, now);
}

/** Mints the wizard's Grok Bot token, revoking the previous wizard token if any. */
export async function rotateOnboardingToken(
  db: DB,
  userId: string,
  minted: { hash: string; hint: string },
  actor: string,
  now: Date,
): Promise<string> {
  const row = await ensureRow(db, userId, now);
  const previous = text(row, 'token_id');
  if (previous) {
    const active = await get<Row>(
      db,
      'SELECT id FROM mcp_tokens WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
      previous,
      userId,
    );
    if (active) await revokeToken(db, userId, previous, actor, now);
  }
  const id = await insertToken(db, userId, 'Grok Bot', minted.hash, minted.hint, actor, now);
  await run(
    db,
    'UPDATE onboarding SET token_id = ?, token_created_at = ?, updated_at = ? WHERE user_id = ?',
    id,
    now.toISOString(),
    now.toISOString(),
    userId,
  );
  return id;
}
