import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/server/app.js';
import { openDatabase } from '../src/server/db.js';
import { loadWebhookConfig } from '../src/server/ssrf.js';

const onVercel = Boolean(process.env.VERCEL);
const prod = process.env.NODE_ENV === 'production';
const dataFile =
  process.env.BOT_COCKPIT_DATA ||
  (onVercel ? '/tmp/cockpit.sqlite' : join(process.cwd(), 'data', 'cockpit.sqlite'));
const clientDir = join(process.cwd(), 'dist/client');
const allowPrivate = process.env.BOT_COCKPIT_WEBHOOK_ALLOW_PRIVATE === '1';
const webhooks = loadWebhookConfig(process.env.BOT_COCKPIT_WEBHOOKS, allowPrivate);
const db = openDatabase(dataFile);

const { app } = createApp({
  db,
  allowOpenSetup: process.env.BOT_COCKPIT_ALLOW_OPEN_SETUP === '1' || (!prod && !onVercel),
  setupToken: process.env.BOT_COCKPIT_SETUP_TOKEN || '',
  webhooks,
  webhookSecret: process.env.BOT_COCKPIT_WEBHOOK_SECRET || '',
  allowPrivateWebhooks: allowPrivate,
  // Static assets are served by Vercel from dist/client; keep a fallback for SPA.
  serveClient: existsSync(join(clientDir, 'index.html')),
  clientDir,
  cookieSecure: onVercel || process.env.BOT_COCKPIT_COOKIE_SECURE === '1',
  ephemeralStorage: onVercel || process.env.BOT_COCKPIT_EPHEMERAL === '1',
});

export default app;
