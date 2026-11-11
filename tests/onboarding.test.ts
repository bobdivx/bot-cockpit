import { describe, expect, it } from 'vitest';
import { migrate } from '../src/server/db.js';
import type { OnboardingState } from '../src/shared/types.js';
import { authHeaders, jsonBody, ownerCookie, testApp } from './helpers.js';

type Minted = { id: string; hint: string; token: string; state: OnboardingState };

async function signupCookie(app: Awaited<ReturnType<typeof testApp>>['app'], email: string) {
  const response = await app.request('/api/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bot-cockpit': '1' },
    body: JSON.stringify({ email, password: 'phrase-locale-longue' }),
  });
  if (!response.ok) throw new Error(await response.text());
  return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

const bearer = (token: string) => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
});

describe('assistant de connexion Grok Bot', () => {
  it('démarre en attente, sans connexion configurée', async () => {
    const { app } = await testApp();
    const cookie = await ownerCookie(app);
    const state = await jsonBody<OnboardingState>(
      await app.request('/api/onboarding', { headers: authHeaders(cookie, false) }),
    );
    expect(state.status).toBe('pending');
    expect(state.step).toBe(0);
    expect(state.configured).toBe(false);
    expect(state.token).toBeNull();
  });

  it('génère un jeton affiché une fois, stocké haché, et confirme le premier appel', async () => {
    const { app, db } = await testApp();
    const cookie = await ownerCookie(app);
    const noHeader = await app.request('/api/onboarding/token', {
      method: 'POST',
      headers: { cookie },
    });
    expect(noHeader.status).toBe(403);
    const minted = await jsonBody<Minted>(
      await app.request('/api/onboarding/token', { method: 'POST', headers: authHeaders(cookie) }),
    );
    expect(minted.token).toMatch(/^bc_/);
    expect(minted.state.token?.id).toBe(minted.id);
    expect(minted.state.configured).toBe(false);
    const rows = await db.all<{ token_hash: string; hint: string }>(
      'SELECT token_hash, hint FROM mcp_tokens',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).not.toBe(minted.token);
    expect(JSON.stringify(rows)).not.toContain(minted.token);
    const listed = await app.request('/api/tokens', { headers: authHeaders(cookie, false) });
    expect(await listed.text()).not.toContain(minted.token);

    expect((await app.request('/api/v1/ping')).status).toBe(401);
    expect(
      (await app.request(`/api/v1/ping?token=${minted.token}`, { headers: bearer(minted.token) }))
        .status,
    ).toBe(400);
    expect((await app.request('/api/v1/ping', { headers: bearer('bc_faux') })).status).toBe(401);
    const ping = await app.request('/api/v1/ping', { headers: bearer(minted.token) });
    expect(ping.status).toBe(200);

    const state = await jsonBody<OnboardingState>(
      await app.request('/api/onboarding', { headers: authHeaders(cookie, false) }),
    );
    expect(state.configured).toBe(true);
    expect(state.token?.lastUsedAt).toBeTruthy();
    expect(state.lastCall?.tokenHint).toBe(minted.hint);
  });

  it('reçoit statuts et événements en REST, refuse les corps invalides', async () => {
    const { app } = await testApp();
    const cookie = await ownerCookie(app);
    const minted = await jsonBody<Minted>(
      await app.request('/api/onboarding/token', { method: 'POST', headers: authHeaders(cookie) }),
    );
    const body = {
      bot_id: 'grok-bot',
      status: 'working',
      note: 'Test de connexion',
      occurred_at: new Date(Date.now() - 60_000).toISOString(),
    };
    const first = await app.request('/api/v1/report', {
      method: 'POST',
      headers: bearer(minted.token),
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(201);
    const again = await app.request('/api/v1/report', {
      method: 'POST',
      headers: bearer(minted.token),
      body: JSON.stringify(body),
    });
    expect(again.status).toBe(200);
    expect((await jsonBody<{ duplicate: boolean }>(again)).duplicate).toBe(true);
    const event = await app.request('/api/v1/report', {
      method: 'POST',
      headers: bearer(minted.token),
      body: JSON.stringify({
        bot_id: 'grok-bot',
        name: 'tache',
        detail: 'résumé',
        tokens: { total: 42 },
      }),
    });
    expect(event.status).toBe(201);
    for (const bad of [{}, { bot_id: 'grok-bot' }, { bot_id: 'x', status: 'dort' }]) {
      const response = await app.request('/api/v1/report', {
        method: 'POST',
        headers: bearer(minted.token),
        body: JSON.stringify(bad),
      });
      expect(response.status).toBe(400);
    }
    const events = await jsonBody<Array<{ reportedBotKey: string }>>(
      await app.request('/api/events', { headers: authHeaders(cookie, false) }),
    );
    expect(events.filter((item) => item.reportedBotKey === 'grok-bot')).toHaveLength(2);
    const state = await jsonBody<OnboardingState>(
      await app.request('/api/onboarding', { headers: authHeaders(cookie, false) }),
    );
    expect(state.lastSignal?.botKey).toBe('grok-bot');
    expect(state.lastSignal?.linked).toBe(true);
  });

  it('crée automatiquement la fiche Grok Bot au premier signal inconnu', async () => {
    const { app } = await testApp();
    const cookie = await ownerCookie(app);
    const minted = await jsonBody<Minted>(
      await app.request('/api/onboarding/token', { method: 'POST', headers: authHeaders(cookie) }),
    );
    const report = await app.request('/api/v1/report', {
      method: 'POST',
      headers: bearer(minted.token),
      body: JSON.stringify({ bot_id: 'grok-bot', status: 'idle', note: 'Connexion Grok Bot' }),
    });
    const body = await jsonBody<{ created: boolean; linked: boolean; message: string }>(report);
    expect(body.created).toBe(true);
    expect(body.linked).toBe(true);
    expect(body.message).toContain('Grok Bot');
    const ws = await jsonBody<{
      bots: Array<{ name: string; externalKey: string; status: string; origin: string }>;
    }>(await app.request('/api/workspace', { headers: authHeaders(cookie, false) }));
    expect(ws.bots).toHaveLength(1);
    expect(ws.bots[0]).toMatchObject({
      name: 'Grok Bot',
      externalKey: 'grok-bot',
      status: 'idle',
      origin: 'auto',
    });
    const next = await jsonBody<{ created: boolean; message: string }>(
      await app.request('/api/v1/report', {
        method: 'POST',
        headers: bearer(minted.token),
        body: JSON.stringify({ bot_id: 'grok-bot', name: 'tache', tokens: { total: 120 } }),
      }),
    );
    expect(next.created).toBe(false);
    expect(next.message).toContain('relié');
    const declared = await jsonBody<{
      total: number;
      byBot: Array<{ botKey: string; total: number }>;
    }>(await app.request('/api/usage/declared', { headers: authHeaders(cookie, false) }));
    expect(declared.total).toBe(120);
    expect(declared.byBot[0]?.botKey).toBe('grok-bot');
    const ws2 = await jsonBody<{ bots: unknown[] }>(
      await app.request('/api/workspace', { headers: authHeaders(cookie, false) }),
    );
    expect(ws2.bots).toHaveLength(1);
  });

  it('régénère en révoquant l’ancien jeton, et respecte la révocation manuelle', async () => {
    const { app } = await testApp();
    const cookie = await ownerCookie(app);
    const first = await jsonBody<Minted>(
      await app.request('/api/onboarding/token', { method: 'POST', headers: authHeaders(cookie) }),
    );
    const second = await jsonBody<Minted>(
      await app.request('/api/onboarding/token', { method: 'POST', headers: authHeaders(cookie) }),
    );
    expect(second.id).not.toBe(first.id);
    expect((await app.request('/api/v1/ping', { headers: bearer(first.token) })).status).toBe(401);
    expect((await app.request('/api/v1/ping', { headers: bearer(second.token) })).status).toBe(200);
    await app.request(`/api/tokens/${second.id}/revoke`, {
      method: 'POST',
      headers: authHeaders(cookie),
    });
    expect((await app.request('/api/v1/ping', { headers: bearer(second.token) })).status).toBe(401);
    const state = await jsonBody<OnboardingState>(
      await app.request('/api/onboarding', { headers: authHeaders(cookie, false) }),
    );
    expect(state.token).toBeNull();
    expect(state.configured).toBe(false);
  });

  it('isole les espaces : le jeton d’un compte n’écrit que chez lui', async () => {
    const { app } = await testApp();
    const alice = await signupCookie(app, 'alice@atelier.test');
    const bob = await signupCookie(app, 'bob@atelier.test');
    const minted = await jsonBody<Minted>(
      await app.request('/api/onboarding/token', { method: 'POST', headers: authHeaders(alice) }),
    );
    await app.request('/api/v1/report', {
      method: 'POST',
      headers: bearer(minted.token),
      body: JSON.stringify({ bot_id: 'grok-bot', status: 'idle' }),
    });
    const bobState = await jsonBody<OnboardingState>(
      await app.request('/api/onboarding', { headers: authHeaders(bob, false) }),
    );
    expect(bobState.configured).toBe(false);
    expect(bobState.lastSignal).toBeNull();
    const bobEvents = await jsonBody<unknown[]>(
      await app.request('/api/events', { headers: authHeaders(bob, false) }),
    );
    expect(bobEvents).toHaveLength(0);
  });

  it('persiste étape et statut, puis relance', async () => {
    const { app } = await testApp();
    const cookie = await ownerCookie(app);
    const put = (body: unknown) =>
      app.request('/api/onboarding', {
        method: 'PUT',
        headers: authHeaders(cookie),
        body: JSON.stringify(body),
      });
    expect((await jsonBody<OnboardingState>(await put({ step: 2 }))).step).toBe(2);
    expect((await put({ step: 9 })).status).toBe(400);
    expect((await put({ status: 'perdu' })).status).toBe(400);
    const skipped = await jsonBody<OnboardingState>(await put({ status: 'skipped' }));
    expect(skipped.status).toBe('skipped');
    expect(skipped.skippedAt).toBeTruthy();
    const restarted = await jsonBody<OnboardingState>(
      await app.request('/api/onboarding/restart', {
        method: 'POST',
        headers: authHeaders(cookie),
      }),
    );
    expect(restarted.status).toBe('pending');
    expect(restarted.step).toBe(0);
    expect(restarted.skippedAt).toBeNull();
  });

  it('migre une base v2 existante vers v3 puis v4', async () => {
    const { db } = await testApp();
    await db.exec('DROP TABLE onboarding');
    await db.run('DELETE FROM schema_migrations WHERE version >= 3');
    await migrate(db);
    const table = await db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'onboarding'",
    );
    expect(table?.name).toBe('onboarding');
    const version = await db.get<{ v: number }>('SELECT MAX(version) AS v FROM schema_migrations');
    expect(Number(version?.v)).toBe(4);
  });

  it('v4 rattache les signaux orphelins existants à une fiche créée', async () => {
    const { app, db } = await testApp();
    await ownerCookie(app);
    const user = await db.get<{ id: string }>('SELECT id FROM users LIMIT 1');
    const insert = (id: string, at: string, status: string, note: string) =>
      db.run(
        `INSERT INTO events (id, user_id, fingerprint, bot_id, reported_bot_key, reported_source, kind, name, detail, payload_json, occurred_at, received_at, linked, is_demo)
         VALUES (?, ?, ?, NULL, 'grok-bot', 'bot', 'status', 'statut', ?, ?, ?, ?, 0, 0)`,
        id,
        String(user?.id),
        `fp-${id}`,
        note,
        JSON.stringify({ tokens: null, status }),
        at,
        at,
      );
    await insert('e1', '2026-11-11T06:09:43.969Z', 'idle', 'Connexion Grok Bot');
    await insert('e2', '2026-11-11T06:26:01.603Z', 'working', 'Diagnostic affichage');
    await db.run('DELETE FROM schema_migrations WHERE version = 4');
    await migrate(db);
    await migrate(db);
    const bots = await db.all<{ id: string; name: string; status: string; last_seen_at: string }>(
      'SELECT id, name, status, last_seen_at FROM bots',
    );
    expect(bots).toHaveLength(1);
    expect(bots[0]).toMatchObject({
      name: 'Grok Bot',
      status: 'working',
      last_seen_at: '2026-11-11T06:26:01.603Z',
    });
    const linked = await db.get<{ n: number }>(
      'SELECT count(*) AS n FROM events WHERE linked = 1 AND bot_id = ?',
      String(bots[0]?.id),
    );
    expect(Number(linked?.n)).toBe(2);
    const history = await db.get<{ n: number }>('SELECT count(*) AS n FROM bot_history');
    expect(Number(history?.n)).toBe(2);
  });
});
