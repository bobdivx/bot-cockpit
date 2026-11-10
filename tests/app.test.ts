import { describe, expect, it } from 'vitest';
import { authHeaders, jsonBody, ownerCookie, testApp } from './helpers.js';

async function setup() {
  const ctx = await testApp();
  const cookie = await ownerCookie(ctx.app);
  return { ...ctx, cookie };
}

describe('authentification', () => {
  it('refuse l’atelier tant que le propriétaire n’existe pas, puis une seconde configuration', async () => {
    const { app, close } = await testApp();
    const health = await app.request('/api/health');
    expect(health.status).toBe(200);
    const blocked = await app.request('/api/workspace');
    expect(blocked.status).toBe(401);
    const cookie = await ownerCookie(app);
    const again = await app.request('/api/setup', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: JSON.stringify({ email: 'autre@atelier.test', password: 'phrase-locale-longue' }),
    });
    expect(again.status).toBe(409);
    const missing = await app.request('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bot-cockpit': '1' },
      body: JSON.stringify({ email: 'owner@atelier.test', password: 'mauvais-mot-de-passe' }),
    });
    expect(missing.status).toBe(401);
    const noHeader = await app.request('/api/logout', { method: 'POST', headers: { cookie } });
    expect(noHeader.status).toBe(403);
    await close();
  });

  it('démarre vide en mode réel', async () => {
    const { app, cookie, close } = await setup();
    const workspace = await jsonBody<{
      bots: unknown[];
      teams: unknown[];
      settings: { demoMode: boolean };
    }>(await app.request('/api/workspace', { headers: { cookie } }));
    expect(workspace.bots).toEqual([]);
    expect(workspace.teams).toEqual([]);
    expect(workspace.settings.demoMode).toBe(false);
    await close();
  });
});

describe('fiches et démonstration', () => {
  it('crée une équipe, une fiche, puis signale un contact ancien', async () => {
    const { app, cookie, close } = await setup();
    const team = await jsonBody<{ id: string }>(
      await app.request('/api/teams', {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ name: 'Atelier', mission: 'Relire', accent: '#1f6f64' }),
      }),
    );
    const bot = await jsonBody<{ id: string; stale: boolean; lastSeenAt: string | null }>(
      await app.request('/api/bots', {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({
          name: 'Brume',
          role: 'Relecture',
          teamId: team.id,
          externalKey: 'brume-1',
          status: 'offline',
        }),
      }),
    );
    expect(bot.lastSeenAt).toBeNull();
    expect(bot.stale).toBe(true);
    const archived = await jsonBody<{ archivedAt: string | null }>(
      await app.request(`/api/bots/${bot.id}/archive`, {
        method: 'POST',
        headers: authHeaders(cookie),
      }),
    );
    expect(archived.archivedAt).not.toBeNull();
    await close();
  });

  it('active des données de démonstration puis les retire sans toucher une fiche réelle', async () => {
    const { app, cookie, close } = await setup();
    await app.request('/api/bots', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: JSON.stringify({ name: 'Réel', role: 'Notes', status: 'offline' }),
    });
    const on = await app.request('/api/demo', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: JSON.stringify({ enabled: true }),
    });
    expect(on.status).toBe(200);
    const during = await jsonBody<{
      bots: Array<{ name: string; isDemo: boolean; stale: boolean; status: string }>;
    }>(await app.request('/api/workspace', { headers: { cookie } }));
    expect(during.bots.some((bot) => bot.name === 'Réel' && !bot.isDemo)).toBe(true);
    expect(
      during.bots.some(
        (bot) => bot.isDemo && bot.name === 'Brume' && bot.status === 'working' && bot.stale,
      ),
    ).toBe(true);
    await app.request('/api/demo', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: JSON.stringify({ enabled: false }),
    });
    const after = await jsonBody<{ bots: Array<{ name: string }> }>(
      await app.request('/api/workspace', { headers: { cookie } }),
    );
    expect(after.bots.map((bot) => bot.name)).toEqual(['Réel']);
    await close();
  });
});

describe('imports CSV', () => {
  it('prévisualise, déduplique, n’additionne pas Included, puis supprime', async () => {
    const { app, cookie, close } = await setup();
    const bot = await jsonBody<{ id: string }>(
      await app.request('/api/bots', {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({
          name: 'Cale',
          role: 'Cas',
          externalKey: 'bot-cale',
          status: 'offline',
        }),
      }),
    );
    const csv = [
      'Date,Total,Cost,Model,Bot',
      '2026-11-01,100,1.5,fixture-a,bot-cale',
      '2026-11-01,100,1.5,fixture-a,bot-cale',
      '2026-11-02,50,Included,fixture-a,',
      '2026-11-03,20,-,fixture-b,inconnu',
      '2026-11-04,0,0,fixture-b,bot-cale',
    ].join('\n');
    const file = new File([csv], 'fixture-synthetique.csv', { type: 'text/csv' });
    const form = new FormData();
    form.set('file', file);
    const previewResponse = await app.request('/api/usage/preview', {
      method: 'POST',
      headers: { cookie, 'x-bot-cockpit': '1' },
      body: form,
    });
    expect(previewResponse.status).toBe(200);
    const preview = await jsonBody<{
      stagingId: string;
      mapping: { botKey: string | null; cost: string | null };
      counts: { inFileDuplicates: number; included: number };
      warnings: string[];
    }>(previewResponse);
    expect(preview.mapping.botKey).toBe('Bot');
    expect(preview.mapping.cost).toBe('Cost');
    expect(preview.counts.inFileDuplicates).toBe(1);
    expect(preview.warnings.some((warning) => warning.includes('fixture'))).toBe(true);
    const committed = await app.request('/api/usage/commit', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: JSON.stringify({ stagingId: preview.stagingId, mapping: preview.mapping }),
    });
    expect(committed.status).toBe(201);
    const again = await app.request('/api/usage/commit', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: JSON.stringify({ stagingId: preview.stagingId, mapping: preview.mapping }),
    });
    expect(again.status).toBe(404);
    const summary = await jsonBody<{
      totals: {
        rows: number;
        costNumericSum: number | null;
        costIncludedRows: number;
        costUnknownRows: number;
        unassignedRows: number;
      };
      insights: Array<{ id: string }>;
    }>(await app.request('/api/usage/summary', { headers: { cookie } }));
    expect(summary.totals.rows).toBe(4);
    expect(summary.totals.costIncludedRows).toBe(1);
    expect(summary.totals.costUnknownRows).toBe(1);
    expect(summary.totals.costNumericSum).toBe(1.5);
    expect(summary.totals.unassignedRows).toBe(2);
    expect(summary.insights.some((insight) => insight.id === 'no-savings')).toBe(true);
    expect(summary.insights.some((insight) => insight.id === 'cost-not-zero')).toBe(true);
    const rows = await jsonBody<
      Array<{ botId: string | null; assignmentProvenance: string | null }>
    >(await app.request('/api/usage/rows', { headers: { cookie } }));
    const linked = rows.find((row) => row.botId === bot.id);
    expect(linked?.assignmentProvenance).toContain('csv');
    const unassigned = rows.find((row) => row.botId == null && row.assignmentProvenance == null);
    expect(unassigned).toBeTruthy();
    const assigned = await app.request(
      `/api/usage/rows/${rows.find((row) => row.botId == null)!.botId ? 'x' : (rows.find((row) => !row.botId)!.botId ?? '')}/assign`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: '{}',
      },
    );
    void assigned;
    const target = rows.find((row) => row.botId == null)!;
    const id = (
      await jsonBody<Array<{ id: string; botId: string | null }>>(
        await app.request('/api/usage/rows', { headers: { cookie } }),
      )
    ).find((row) => row.botId == null)!.id;
    const manual = await jsonBody<{ botId: string; assignmentProvenance: string }>(
      await app.request(`/api/usage/rows/${id}/assign`, {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ botId: bot.id, note: 'rapprochement manuel' }),
      }),
    );
    expect(manual.botId).toBe(bot.id);
    expect(manual.assignmentProvenance).toContain('manuel');
    void target;
    const exported = await app.request(
      '/api/usage/export.csv?model=' + encodeURIComponent('=1+1'),
      { headers: { cookie } },
    );
    expect(exported.status).toBe(200);
    const nasty = await app.request('/api/usage/preview', {
      method: 'POST',
      headers: { cookie, 'x-bot-cockpit': '1' },
      body: (() => {
        const data = new FormData();
        data.set('file', new File(['Model,Total\n=1+1,5\n'], 'export.csv', { type: 'text/csv' }));
        return data;
      })(),
    });
    const nastyPreview = await jsonBody<{ stagingId: string; mapping: unknown }>(nasty);
    await app.request('/api/usage/commit', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: JSON.stringify({ stagingId: nastyPreview.stagingId, mapping: nastyPreview.mapping }),
    });
    const download = await (
      await app.request('/api/usage/export.csv', { headers: { cookie } })
    ).text();
    expect(download).toContain(`"'=1+1"`);
    const imports = await jsonBody<{ imports: Array<{ id: string }> }>(
      await app.request('/api/workspace', { headers: { cookie } }),
    );
    const deleted = await app.request(`/api/usage/imports/${imports.imports[0]!.id}`, {
      method: 'DELETE',
      headers: authHeaders(cookie),
    });
    expect(deleted.status).toBe(200);
    const wiped = await app.request('/api/usage/reset', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: JSON.stringify({ confirm: 'EFFACER' }),
    });
    expect(wiped.status).toBe(200);
    const empty = await jsonBody<{ totals: { rows: number } }>(
      await app.request('/api/usage/summary', { headers: { cookie } }),
    );
    expect(empty.totals.rows).toBe(0);
    await close();
  });
});

describe('espaces isolés', () => {
  it('empêche un utilisateur de voir ou modifier les fiches d’un autre', async () => {
    const { app, close } = await testApp();
    const createdA = await app.request('/api/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bot-cockpit': '1' },
      body: JSON.stringify({ email: 'alpha@atelier.test', password: 'phrase-locale-longue' }),
    });
    expect(createdA.status).toBe(201);
    const cookieA = createdA.headers.get('set-cookie')?.split(';')[0];
    if (!cookieA) throw new Error('cookie A manquant');

    const createdB = await app.request('/api/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bot-cockpit': '1' },
      body: JSON.stringify({ email: 'beta@atelier.test', password: 'autre-phrase-longue' }),
    });
    expect(createdB.status).toBe(201);
    const cookieB = createdB.headers.get('set-cookie')?.split(';')[0];
    if (!cookieB) throw new Error('cookie B manquant');

    const teamA = await jsonBody<{ id: string }>(
      await app.request('/api/teams', {
        method: 'POST',
        headers: authHeaders(cookieA),
        body: JSON.stringify({ name: 'Atelier Alpha', mission: 'Privé', accent: '#1f6f64' }),
      }),
    );
    const workspaceB = await jsonBody<{ teams: Array<{ id: string; name: string }> }>(
      await app.request('/api/workspace', { headers: { cookie: cookieB } }),
    );
    expect(workspaceB.teams.map((team) => team.id)).not.toContain(teamA.id);
    expect(workspaceB.teams).toEqual([]);

    const peek = await app.request(`/api/bots/${teamA.id}`, { headers: { cookie: cookieB } });
    expect(peek.status).toBe(404);

    const update = await app.request(`/api/teams/${teamA.id}`, {
      method: 'PATCH',
      headers: authHeaders(cookieB),
      body: JSON.stringify({ name: 'Intrusion' }),
    });
    expect(update.status).toBe(404);

    const removed = await app.request('/api/account/delete', {
      method: 'POST',
      headers: authHeaders(cookieA),
      body: JSON.stringify({ password: 'phrase-locale-longue', confirm: 'SUPPRIMER' }),
    });
    expect(removed.status).toBe(200);
    const after = await app.request('/api/workspace', { headers: { cookie: cookieA } });
    expect(after.status).toBe(401);
    await close();
  });
});
