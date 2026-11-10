import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/server/app.js';
import { openDatabaseFromEnv } from '../src/server/db.js';
import { loadWebhookConfig } from '../src/server/ssrf.js';

const onVercel = Boolean(process.env.VERCEL);
const prod = process.env.NODE_ENV === 'production';
const clientDir = join(process.cwd(), 'dist/client');
const allowPrivate = process.env.BOT_COCKPIT_WEBHOOK_ALLOW_PRIVATE === '1';
const webhooks = loadWebhookConfig(process.env.BOT_COCKPIT_WEBHOOKS, allowPrivate);
const db = await openDatabaseFromEnv();

const { app } = createApp({
  db,
  allowOpenSetup: process.env.BOT_COCKPIT_ALLOW_OPEN_SETUP === '1' || (!prod && !onVercel),
  allowSignup: process.env.BOT_COCKPIT_ALLOW_SIGNUP !== '0',
  setupToken: process.env.BOT_COCKPIT_SETUP_TOKEN || '',
  webhooks,
  webhookSecret: process.env.BOT_COCKPIT_WEBHOOK_SECRET || '',
  allowPrivateWebhooks: allowPrivate,
  // Static assets are served by Vercel from dist/client; keep a fallback for SPA.
  serveClient: existsSync(join(clientDir, 'index.html')),
  clientDir,
  cookieSecure: onVercel || process.env.BOT_COCKPIT_COOKIE_SECURE === '1',
  ephemeralStorage: process.env.BOT_COCKPIT_EPHEMERAL === '1',
});

export default app;
