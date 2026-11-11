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

  it('migre une base v2 existante vers v3', async () => {
    const { db } = await testApp();
    await db.exec('DROP TABLE onboarding');
    await db.run('DELETE FROM schema_migrations WHERE version = 3');
    await migrate(db);
    const table = await db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'onboarding'",
    );
    expect(table?.name).toBe('onboarding');
    const version = await db.get<{ v: number }>('SELECT MAX(version) AS v FROM schema_migrations');
    expect(Number(version?.v)).toBe(3);
  });
});
