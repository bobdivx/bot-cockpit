import { type AppOptions, createApp } from '../src/server/app.js';
import { type DB, openDatabase } from '../src/server/db.js';

export async function testApp(extra: Partial<AppOptions> = {}) {
  const db = await openDatabase(':memory:');
  const created = createApp({
    db,
    allowOpenSetup: true,
    allowSignup: true,
    rateLimit: false,
    serveClient: false,
    ...extra,
  });
  return { db, app: created.app, close: created.close };
}

export async function ownerCookie(
  app: Awaited<ReturnType<typeof testApp>>['app'],
  email = 'owner@atelier.test',
): Promise<string> {
  const response = await app.request('/api/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bot-cockpit': '1' },
    body: JSON.stringify({ email, password: 'phrase-locale-longue' }),
  });
  if (!response.ok) throw new Error(await response.text());
  const cookie = response.headers.get('set-cookie');
  if (!cookie) throw new Error('cookie manquant');
  return cookie.split(';')[0] ?? cookie;
}

export function authHeaders(cookie: string, json = true): Record<string, string> {
  return {
    cookie,
    'x-bot-cockpit': '1',
    ...(json ? { 'content-type': 'application/json' } : {}),
  };
}

export async function jsonBody<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export type { DB };
