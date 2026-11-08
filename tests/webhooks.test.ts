import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { isBlockedIp, isMetadataIp, loadWebhookConfig } from '../src/server/ssrf.js';
import { authHeaders, jsonBody, ownerCookie, testApp } from './helpers.js';

describe('adresses internes', () => {
  it('bloque les plages privées, le lien local et laisse une adresse publique', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '192.168.0.8',
      '172.16.0.1',
      '100.64.1.1',
      '0.0.0.0',
      '::1',
      'fe80::1',
      'fc00::1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isBlockedIp(ip)).toBe(true);
    }
    expect(isBlockedIp('172.32.0.1')).toBe(false);
    expect(isBlockedIp('8.8.8.8')).toBe(false);
    expect(isMetadataIp('169.254.169.254')).toBe(true);
  });

  it('refuse une action d’arrêt et une URL libre hors configuration', () => {
    expect(() => loadWebhookConfig('{"stop":"https://example.com/hook"}', false)).toThrow(/arrêt/);
    expect(loadWebhookConfig('{}', false)).toEqual([]);
  });
});

describe('demandes allowlist', () => {
  it('n’accepte pas une URL fournie par la requête et marque un 200 comme demandé', async () => {
    const hit = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk as Buffer));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        expect(body).not.toContain('secret');
        expect(req.headers.authorization).toBe('Bearer secret-serveur');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true,"token":"ne-pas-afficher"}');
      });
    });
    await new Promise<void>((resolve) => hit.listen(0, '127.0.0.1', () => resolve()));
    const address = hit.address();
    if (!address || typeof address === 'string') throw new Error('port');
    const { app, close } = testApp({
      allowPrivateWebhooks: true,
      webhookSecret: 'secret-serveur',
      webhooks: [{ name: 'demander_point', url: `http://127.0.0.1:${address.port}/hook` }],
    });
    const cookie = await ownerCookie(app);
    const missing = await app.request('/api/webhooks/autre', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: JSON.stringify({ confirm: 'DEMANDER', url: 'http://127.0.0.1/libre' }),
    });
    expect(missing.status).toBe(404);
    const unconfirmed = await app.request('/api/webhooks/demander_point', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: JSON.stringify({ confirm: 'oui' }),
    });
    expect(unconfirmed.status).toBe(400);
    const call = await jsonBody<{ status: string; detail: string }>(
      await app.request('/api/webhooks/demander_point', {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ confirm: 'DEMANDER' }),
      }),
    );
    expect(call.status).toBe('requested');
    expect(call.detail.toLowerCase()).toContain('demandé / en attente');
    expect(call.detail).not.toContain('ne-pas-afficher');
    await close();
    await new Promise<void>((resolve, reject) =>
      hit.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('bloque encore le metadata même si le réseau privé est ouvert', async () => {
    const { app, close } = testApp({
      allowPrivateWebhooks: true,
      webhooks: [{ name: 'demander_point', url: 'http://169.254.169.254/latest' }],
    });
    const cookie = await ownerCookie(app);
    const call = await jsonBody<{ status: string }>(
      await app.request('/api/webhooks/demander_point', {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ confirm: 'DEMANDER' }),
      }),
    );
    expect(call.status).toBe('failed');
    await close();
  });
});
