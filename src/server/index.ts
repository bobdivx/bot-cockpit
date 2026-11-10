import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { openDatabaseFromEnv } from './db.js';
import { log } from './security.js';
import { loadWebhookConfig } from './ssrf.js';

const here = dirname(fileURLToPath(import.meta.url));
const prod = process.env.NODE_ENV === 'production';
const onVercel = Boolean(process.env.VERCEL);
const port = Number(process.env.PORT || 8741);
const clientDir = join(here, '../client');
const allowPrivate = process.env.BOT_COCKPIT_WEBHOOK_ALLOW_PRIVATE === '1';

const webhooks = loadWebhookConfig(process.env.BOT_COCKPIT_WEBHOOKS, allowPrivate);
const db = await openDatabaseFromEnv();
const { app, close } = createApp({
  db,
  allowOpenSetup: process.env.BOT_COCKPIT_ALLOW_OPEN_SETUP === '1' || (!prod && !onVercel),
  allowSignup: process.env.BOT_COCKPIT_ALLOW_SIGNUP !== '0',
  setupToken: process.env.BOT_COCKPIT_SETUP_TOKEN || '',
  webhooks,
  webhookSecret: process.env.BOT_COCKPIT_WEBHOOK_SECRET || '',
  allowPrivateWebhooks: allowPrivate,
  serveClient: existsSync(join(clientDir, 'index.html')),
  clientDir,
  cookieSecure: onVercel || process.env.BOT_COCKPIT_COOKIE_SECURE === '1',
  ephemeralStorage: process.env.BOT_COCKPIT_EPHEMERAL === '1',
});

export default app;

if (!onVercel) {
  const server = serve({ fetch: app.fetch, hostname: '0.0.0.0', port }, (info) => {
    log('info', 'Bot Cockpit en écoute', {
      port: info.port,
      production: prod,
      actions: webhooks.length,
    });
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void close().finally(() => {
        server.close();
        db.close();
        process.exit(0);
      });
    });
  }
}
