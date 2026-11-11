import { serve } from '@hono/node-server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { authHeaders, jsonBody, ownerCookie, testApp } from './helpers.js';

describe('ingestion MCP', () => {
  it('refuse l’URL et un jeton absent, puis persiste un statut ancien', async () => {
    const { app, close } = await testApp();
    const cookie = await ownerCookie(app);
    const created = await jsonBody<{ id: string; token: string }>(
      await app.request('/api/tokens', {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ label: 'Atelier' }),
      }),
    );
    const leaked = await app.request(`/mcp?token=${created.token}`, { method: 'POST' });
    expect(leaked.status).toBe(400);
    const denied = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(denied.status).toBe(401);

    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('port');
    const occurred = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const client = new Client({ name: 'test-bot-cockpit', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/mcp`),
      {
        authProvider: { token: async () => created.token },
      },
    );
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: 'report_status',
        arguments: {
          bot_id: 'brume-test',
          status: 'working',
          note: 'au travail',
          source: 'essai',
          occurred_at: occurred,
        },
      });
      expect(JSON.stringify(result)).toContain('créée automatiquement');
      const ws = await jsonBody<{
        bots: Array<{ id: string; name: string; externalKey: string; origin: string }>;
      }>(await app.request('/api/workspace', { headers: { cookie } }));
      const bot = ws.bots.find((item) => item.externalKey === 'brume-test');
      expect(bot?.name).toBe('Brume Test');
      expect(bot?.origin).toBe('auto');
      if (!bot) throw new Error('fiche auto absente');
      await client.callTool({
        name: 'report_status',
        arguments: {
          bot_id: 'brume-test',
          status: 'working',
          note: 'signal ancien',
          source: 'essai',
          occurred_at: occurred,
        },
      });
      const eventAt = '2026-11-01T10:00:00.000Z';
      await client.callTool({
        name: 'report_event',
        arguments: {
          bot_id: 'brume-test',
          name: 'note',
          detail: 'partiel',
          source: 'essai',
          occurred_at: eventAt,
          tokens: { total: 42 },
        },
      });
      const viewed = await jsonBody<{
        bot: { status: string; stale: boolean; lastSeenAt: string };
        history: Array<{ source: string }>;
      }>(await app.request(`/api/bots/${bot.id}`, { headers: { cookie } }));
      expect(viewed.bot.status).toBe('working');
      expect(viewed.bot.stale).toBe(true);
      expect(viewed.history.some((entry) => entry.source === 'mcp')).toBe(true);
      const summary = await jsonBody<{
        totals: { rows: number };
        eventTokenSignals: number;
        warnings: string[];
      }>(await app.request('/api/usage/summary', { headers: { cookie } }));
      expect(summary.totals.rows).toBe(0);
      expect(summary.eventTokenSignals).toBe(1);
      expect(summary.warnings.some((warning) => warning.includes('MCP'))).toBe(true);
      const duplicate = await client.callTool({
        name: 'report_event',
        arguments: {
          bot_id: 'brume-test',
          name: 'note',
          detail: 'partiel',
          source: 'essai',
          occurred_at: eventAt,
          tokens: { total: 42 },
        },
      });
      expect(JSON.stringify(duplicate)).toContain('déjà');
    } finally {
      await client.close().catch(() => undefined);
      await close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
