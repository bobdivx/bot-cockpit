import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { ColumnMapping } from '../shared/types.js';
import { APP_VERSION } from '../shared/types.js';
import {
  CsvError,
  interpretRows,
  MAX_CSV_BYTES,
  parseCsv,
  sanitizeMapping,
  suggestMapping,
  toCsv,
} from './csv.js';
import type { DB } from './db.js';
import { packById, packMarkdown, packSummaries } from './packs.js';
import {
  cleanFilename,
  cleanText,
  HttpError,
  hashPassword,
  isLoopback,
  log,
  newSecret,
  safeEqual,
  verifyPassword,
} from './security.js';
import { assertWebhookUrl, type WebhookAction } from './ssrf.js';
import {
  addAudit,
  applyPack,
  applyRetention,
  assertDay,
  assignUsage,
  authenticateToken,
  botHistory,
  commitStaging,
  createBot,
  createOwner,
  createRoom,
  createTeam,
  createUser,
  deleteImport,
  deleteSession,
  deleteUser,
  exportRows,
  findOwnerByEmail,
  getBot,
  insertToken,
  insertWebhookCall,
  listAudit,
  listEvents,
  listTokens,
  listUsage,
  listWebhookCalls,
  materializeSignal,
  openSession,
  purgeExpired,
  readSettings,
  readStaging,
  recentWebhookCount,
  recordSignal,
  resetUsage,
  resetWorkshop,
  revokeToken,
  type SessionUser,
  saveStaging,
  setBotArchived,
  setBotStatus,
  setDemoMode,
  setTeamArchived,
  touchToken,
  type UsageQuery,
  updateBot,
  updateTeam,
  usageSummary,
  userCount,
  userFromToken,
  workspace,
  writeSettings,
} from './store.js';

type AppEnv = { Variables: { user: SessionUser | null } };

export type AppOptions = {
  db: DB;
  now?: () => Date;
  allowOpenSetup?: boolean;
  setupToken?: string;
  webhooks?: WebhookAction[];
  webhookSecret?: string;
  allowPrivateWebhooks?: boolean;
  rateLimit?: boolean;
  serveClient?: boolean;
  clientDir?: string;
  fixturesDir?: string;
  cookieSecure?: boolean;
  ephemeralStorage?: boolean;
  allowSignup?: boolean;
};

const here = dirname(fileURLToPath(import.meta.url));

export function createApp(options: AppOptions) {
  const now = () => options.now?.() ?? new Date();
  const webhooks = options.webhooks ?? [];
  const allowOpenSetup = options.allowOpenSetup === true;
  const setupToken = options.setupToken ?? '';
  const rateLimit = options.rateLimit !== false;
  const ephemeralStorage = options.ephemeralStorage === true;
  const allowSignup = options.allowSignup !== false;
  const hits = new Map<string, number[]>();
  const listeners = new Set<{ userId: string; fn: (event: string, data: unknown) => void }>();
  const mcpOwners = new Map<string, string>();
  const dummyHash = hashPassword('timing-padding-not-a-password');

  const publish = (userId: string, event: string, data: unknown = { ok: true }) => {
    for (const listener of [...listeners]) {
      if (listener.userId !== userId) continue;
      try {
        listener.fn(event, data);
      } catch {
        listeners.delete(listener);
      }
    }
  };

  const allow = (key: string, limit: number, windowMs: number) => {
    if (!rateLimit) return true;
    const stamp = Date.now();
    const recent = (hits.get(key) ?? []).filter((item) => stamp - item < windowMs);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(stamp);
    hits.set(key, recent);
    return true;
  };

  const mcp = createMcpHandler(
    (ctx) => {
      const server = new McpServer({ name: 'bot-cockpit', version: APP_VERSION });
      const tokenId = ctx.authInfo?.clientId ?? 'inconnu';
      server.registerTool(
        'report_status',
        {
          title: 'Signaler un statut',
          description:
            'Auto-signalement volontaire d’un statut de bot. Ce n’est pas un relevé de compte, ni une mesure exhaustive d’usage.',
          inputSchema: z.object({
            bot_id: z.string().min(1).max(120),
            status: z.enum(['offline', 'idle', 'working', 'away', 'blocked']),
            note: z.string().max(500).optional(),
            source: z.string().max(80).optional(),
            occurred_at: z.string().max(40).optional(),
          }),
        },
        async (args) => {
          const ownerId = mcpOwners.get(tokenId);
          if (!ownerId) throw new Error('Jeton sans espace utilisateur.');
          const result = await recordSignal(
            options.db,
            ownerId,
            {
              kind: 'status',
              botKey: args.bot_id,
              status: args.status,
              name: 'statut',
              detail: args.note ?? '',
              source: args.source ?? 'bot',
              occurredAt: resolveOccurred(args.occurred_at, now()),
              tokens: null,
            },
            now(),
          );
          await addAudit(
            options.db,
            ownerId,
            `mcp:${tokenId}`,
            'mcp.status',
            result.message,
            now(),
          );
          publish(ownerId, 'bot.updated');
          publish(ownerId, 'event.created');
          return { content: [{ type: 'text', text: result.message }] };
        },
      );
      server.registerTool(
        'report_event',
        {
          title: 'Signaler un événement',
          description:
            'Auto-signalement volontaire. Les jetons éventuels sont partiels : ils ne sont pas additionnés aux imports CSV et ne représentent pas un quota.',
          inputSchema: z.object({
            bot_id: z.string().min(1).max(120),
            name: z.string().min(1).max(120),
            detail: z.string().max(1000).optional(),
            source: z.string().max(80).optional(),
            occurred_at: z.string().max(40).optional(),
            tokens: z
              .object({
                input: z.number().int().nonnegative().max(1_000_000_000_000).optional(),
                cache: z.number().int().nonnegative().max(1_000_000_000_000).optional(),
                output: z.number().int().nonnegative().max(1_000_000_000_000).optional(),
                total: z.number().int().nonnegative().max(1_000_000_000_000).optional(),
              })
              .optional(),
          }),
        },
        async (args) => {
          const tokens = cleanTokens(args.tokens);
          const ownerId = mcpOwners.get(tokenId);
          if (!ownerId) throw new Error('Jeton sans espace utilisateur.');
          const result = await recordSignal(
            options.db,
            ownerId,
            {
              kind: 'event',
              botKey: args.bot_id,
              name: args.name,
              detail: args.detail ?? '',
              source: args.source ?? 'bot',
              occurredAt: resolveOccurred(args.occurred_at, now()),
              tokens,
            },
            now(),
          );
          await addAudit(options.db, ownerId, `mcp:${tokenId}`, 'mcp.event', result.message, now());
          publish(ownerId, 'event.created');
          if (result.linked) publish(ownerId, 'bot.updated');
          return { content: [{ type: 'text', text: result.message }] };
        },
      );
      return server;
    },
    {
      responseMode: 'json',
      keepAliveMs: 0,
      onerror: (error) => log('warn', 'mcp', { name: error.name }),
    },
  );

  const app = new Hono<AppEnv>();

  app.onError((error, c) => {
    if (error instanceof HttpError) return c.json({ error: error.message }, error.status as 400);
    if (error instanceof CsvError) return c.json({ error: error.message }, 400);
    log('error', 'erreur interne', { name: error instanceof Error ? error.name : 'unknown' });
    return c.json({ error: 'Erreur interne.' }, 500);
  });

  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    c.header(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (c.req.path.startsWith('/api/')) c.header('Cache-Control', 'no-store');
  });

  app.get('/api/health', async (c) =>
    c.json({
      ok: true,
      service: 'bot-cockpit',
      version: APP_VERSION,
      ephemeralStorage,
    }),
  );

  app.get('/api/bootstrap', async (c) => {
    await purgeExpired(options.db, now());
    const ip = clientIp(c);
    const empty = (await userCount(options.db)) === 0;
    return c.json({
      needsSetup: empty && !allowSignup,
      allowSignup,
      setupRequiresToken:
        empty && !allowSignup && (Boolean(setupToken) || (!allowOpenSetup && !isLoopback(ip))),
      openSetup: allowOpenSetup && !setupToken,
      ephemeralStorage,
    });
  });

  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/health' || c.req.path === '/api/bootstrap') return next();
    const method = c.req.method.toUpperCase();
    if (!['GET', 'HEAD'].includes(method) && c.req.header('x-bot-cockpit') !== '1') {
      return c.json({ error: 'En-tête de confirmation manquant.' }, 403);
    }
    const raw = getCookie(c, 'cockpit_session');
    const user = raw ? await userFromToken(options.db, raw, now()) : null;
    c.set('user', user);
    if (
      c.req.path !== '/api/setup' &&
      c.req.path !== '/api/login' &&
      c.req.path !== '/api/signup' &&
      !user
    ) {
      return c.json({ error: 'Authentification requise.' }, 401);
    }
    return next();
  });

  app.post('/api/setup', async (c) => {
    const ip = clientIp(c);
    if (!allow(`setup:${ip}`, 8, 15 * 60_000)) return c.json({ error: 'Trop de tentatives.' }, 429);
    const body = await readJson(c);
    const provided = typeof body.setupToken === 'string' ? body.setupToken : '';
    if (!setupPermitted(provided, ip)) {
      return c.json(
        {
          error: setupToken
            ? 'Jeton de configuration refusé.'
            : 'Définissez BOT_COCKPIT_SETUP_TOKEN avant la configuration depuis ce poste.',
        },
        403,
      );
    }
    const email = assertEmail(body.email);
    const password = assertPassword(body.password);
    const owner = await createOwner(options.db, email, hashPassword(password), now());
    setSession(c, owner.token);
    publish(owner.id, 'bot.updated');
    return c.json({ email: owner.email });
  });

  app.post('/api/signup', async (c) => {
    const ip = clientIp(c);
    if (!allowSignup) return c.json({ error: 'Les inscriptions sont fermées.' }, 403);
    if (!allow(`signup:${ip}`, 8, 15 * 60_000))
      return c.json({ error: 'Trop de tentatives.' }, 429);
    const body = await readJson(c);
    const email = assertEmail(body.email);
    const password = assertPassword(body.password);
    const user = await createUser(options.db, email, hashPassword(password), now());
    setSession(c, user.token);
    publish(user.id, 'bot.updated');
    return c.json({ email: user.email }, 201);
  });

  app.post('/api/login', async (c) => {
    const ip = clientIp(c);
    if (!allow(`login:${ip}`, 12, 15 * 60_000))
      return c.json({ error: 'Trop de tentatives.' }, 429);
    const body = await readJson(c);
    const email = assertEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';
    const owner = await findOwnerByEmail(options.db, email);
    const ok = verifyPassword(password, owner?.passwordHash ?? dummyHash);
    if (!owner || !ok) return c.json({ error: 'Identifiants refusés.' }, 401);
    const session = await openSession(options.db, owner.id, owner.email, now());
    await addAudit(options.db, owner.id, owner.email, 'login', 'Session ouverte.', now());
    setSession(c, session.token);
    return c.json({ email: owner.email });
  });

  app.post('/api/logout', async (c) => {
    const user = requireUser(c);
    await deleteSession(options.db, user.sessionId);
    deleteCookie(c, 'cockpit_session', { path: '/' });
    return c.json({ ok: true });
  });

  app.get('/api/me', async (c) => {
    const user = requireUser(c);
    return c.json({ email: user.email, id: user.id });
  });

  app.post('/api/account/delete', async (c) => {
    const user = requireUser(c);
    const body = await readJson(c);
    const password = typeof body.password === 'string' ? body.password : '';
    const account = await findOwnerByEmail(options.db, user.email);
    if (!account || !verifyPassword(password, account.passwordHash)) {
      return c.json({ error: 'Mot de passe refusé.' }, 401);
    }
    if (body.confirm !== 'SUPPRIMER') {
      return c.json({ error: 'Saisissez SUPPRIMER pour confirmer.' }, 400);
    }
    await deleteUser(options.db, user.id);
    deleteCookie(c, 'cockpit_session', { path: '/' });
    return c.json({ ok: true });
  });

  app.get('/api/workspace', async (c) => {
    const user = requireUser(c);
    await purgeExpired(options.db, now());
    await applyRetention(options.db, user.id, now());
    const data = await workspace(options.db, user.id, now());
    data.webhookActions = webhooks.map((item) => item.name);
    return c.json(data);
  });

  app.post('/api/teams', async (c) => {
    const user = requireUser(c);
    const body = await readJson(c);
    const team = await createTeam(
      options.db,
      user.id,
      {
        name: String(body.name ?? ''),
        mission: String(body.mission ?? ''),
        accent: String(body.accent ?? ''),
      },
      user.email,
      now(),
    );
    publish(user.id, 'bot.updated');
    return c.json(team, 201);
  });

  app.patch('/api/teams/:id', async (c) => {
    const user = requireUser(c);
    const body = await readJson(c);
    const team = await updateTeam(options.db, user.id, c.req.param('id'), {
      name: body.name == null ? undefined : String(body.name),
      mission: body.mission == null ? undefined : String(body.mission),
      accent: body.accent == null ? undefined : String(body.accent),
    });
    publish(user.id, 'bot.updated');
    return c.json(team);
  });

  app.post('/api/teams/:id/archive', async (c) => {
    const user = requireUser(c);
    const team = await setTeamArchived(
      options.db,
      user.id,
      c.req.param('id'),
      true,
      user.email,
      now(),
    );
    publish(user.id, 'bot.updated');
    return c.json(team);
  });

  app.post('/api/teams/:id/restore', async (c) => {
    const user = requireUser(c);
    const team = await setTeamArchived(
      options.db,
      user.id,
      c.req.param('id'),
      false,
      user.email,
      now(),
    );
    publish(user.id, 'bot.updated');
    return c.json(team);
  });

  app.post('/api/rooms', async (c) => {
    const user = requireUser(c);
    const body = await readJson(c);
    const room = await createRoom(options.db, user.id, {
      teamId: body.teamId ? String(body.teamId) : null,
      name: String(body.name ?? ''),
      kind: String(body.kind ?? ''),
    });
    publish(user.id, 'bot.updated');
    return c.json(room, 201);
  });

  app.post('/api/bots', async (c) => {
    const user = requireUser(c);
    const body = await readJson(c);
    const bot = await createBot(
      options.db,
      user.id,
      {
        name: String(body.name ?? ''),
        role: String(body.role ?? ''),
        brief: String(body.brief ?? ''),
        teamId: body.teamId ? String(body.teamId) : null,
        roomId: body.roomId ? String(body.roomId) : null,
        externalKey: String(body.externalKey ?? ''),
        status: String(body.status ?? 'offline'),
      },
      user.email,
      now(),
    );
    publish(user.id, 'bot.updated');
    return c.json(bot, 201);
  });

  app.get('/api/bots/:id', async (c) => {
    const user = requireUser(c);
    const bot = await getBot(options.db, user.id, c.req.param('id'), now());
    return c.json({ bot, history: await botHistory(options.db, user.id, bot.id) });
  });

  app.patch('/api/bots/:id', async (c) => {
    const user = requireUser(c);
    const body = await readJson(c);
    const bot = await updateBot(
      options.db,
      user.id,
      c.req.param('id'),
      {
        name: body.name == null ? undefined : String(body.name),
        role: body.role == null ? undefined : String(body.role),
        brief: body.brief == null ? undefined : String(body.brief),
        teamId: body.teamId === undefined ? undefined : body.teamId ? String(body.teamId) : null,
        roomId: body.roomId === undefined ? undefined : body.roomId ? String(body.roomId) : null,
        externalKey: body.externalKey == null ? undefined : String(body.externalKey),
      },
      now(),
    );
    publish(user.id, 'bot.updated');
    return c.json(bot);
  });

  app.post('/api/bots/:id/status', async (c) => {
    const user = requireUser(c);
    const body = await readJson(c);
    const bot = await setBotStatus(
      options.db,
      user.id,
      c.req.param('id'),
      String(body.status ?? ''),
      String(body.note ?? ''),
      user.email,
      now(),
    );
    publish(user.id, 'bot.updated');
    return c.json(bot);
  });

  app.post('/api/bots/:id/archive', async (c) => {
    const user = requireUser(c);
    const bot = await setBotArchived(
      options.db,
      user.id,
      c.req.param('id'),
      true,
      user.email,
      now(),
    );
    publish(user.id, 'bot.updated');
    return c.json(bot);
  });

  app.post('/api/bots/:id/restore', async (c) => {
    const user = requireUser(c);
    const bot = await setBotArchived(
      options.db,
      user.id,
      c.req.param('id'),
      false,
      user.email,
      now(),
    );
    publish(user.id, 'bot.updated');
    return c.json(bot);
  });

  app.get('/api/packs', async (c) => {
    requireUser(c);
    return c.json(packSummaries());
  });

  app.get('/api/packs/:id/consigne.md', async (c) => {
    requireUser(c);
    const pack = packById(c.req.param('id'));
    if (!pack) return c.json({ error: 'Consigne introuvable.' }, 404);
    return new Response(packMarkdown(pack), {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="consigne-${pack.id}.md"`,
      },
    });
  });

  app.post('/api/packs/:id/apply', async (c) => {
    const user = requireUser(c);
    const team = await applyPack(options.db, user.id, c.req.param('id'), user.email, now());
    publish(user.id, 'bot.updated');
    return c.json(team, 201);
  });

  app.post('/api/demo', async (c) => {
    const user = requireUser(c);
    const body = await readJson(c);
    const settings = await setDemoMode(
      options.db,
      user.id,
      body.enabled === true,
      user.email,
      now(),
    );
    publish(user.id, 'bot.updated');
    publish(user.id, 'usage.changed');
    return c.json(settings);
  });

  app.patch('/api/settings', async (c) => {
    const user = requireUser(c);
    const body = await readJson(c);
    const settings = await writeSettings(
      options.db,
      user.id,
      {
        retentionDays: body.retentionDays == null ? undefined : Number(body.retentionDays),
        staleMinutes: body.staleMinutes == null ? undefined : Number(body.staleMinutes),
      },
      now(),
    );
    await addAudit(options.db, user.id, user.email, 'settings', 'Réglages mis à jour.', now());
    publish(user.id, 'bot.updated');
    return c.json(settings);
  });

  app.post('/api/usage/preview', async (c) => {
    const user = requireUser(c);
    if (!allow(`upload:${user.id}`, 30, 3_600_000))
      return c.json({ error: 'Trop d’imports.' }, 429);
    const length = Number(c.req.header('content-length') || '0');
    if (length > MAX_CSV_BYTES + 50_000)
      return c.json({ error: 'Fichier trop volumineux (5 Mo maximum).' }, 413);
    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) return c.json({ error: 'Déposez un fichier CSV.' }, 400);
    if (file.size > MAX_CSV_BYTES)
      return c.json({ error: 'Fichier trop volumineux (5 Mo maximum).' }, 413);
    const text = await file.text();
    const parsed = parseCsv(text);
    const mapping = suggestMapping(parsed.headers);
    const id = await saveStaging(
      options.db,
      user.id,
      cleanFilename(file.name),
      parsed.headers,
      parsed.records,
      parsed.errors,
      now(),
    );
    return c.json(
      buildPreview(
        id,
        cleanFilename(file.name),
        parsed.headers,
        parsed.delimiter,
        parsed.errors,
        parsed.records,
        mapping,
      ),
    );
  });

  app.post('/api/usage/interpret', async (c) => {
    const user = requireUser(c);
    const body = await readJson(c);
    const staging = await readStaging(options.db, String(body.stagingId ?? ''), user.id, now());
    const mapping = sanitizeMapping(body.mapping);
    return c.json(
      buildPreview(
        String(body.stagingId),
        staging.filename,
        staging.headers,
        ',',
        staging.errors,
        staging.records,
        mapping,
      ),
    );
  });

  app.post('/api/usage/commit', async (c) => {
    const user = requireUser(c);
    const body = await readJson(c);
    const imported = await commitStaging(
      options.db,
      String(body.stagingId ?? ''),
      user.id,
      sanitizeMapping(body.mapping),
      user.email,
      now(),
    );
    publish(user.id, 'usage.changed');
    return c.json(imported, 201);
  });

  app.get('/api/usage/summary', async (c) => {
    const user = requireUser(c);
    return c.json(await usageSummary(options.db, user.id, readQuery(c)));
  });

  app.get('/api/usage/rows', async (c) => {
    const user = requireUser(c);
    const settings = await readSettings(options.db, user.id);
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') || 80)));
    return c.json(await listUsage(options.db, user.id, readQuery(c), settings.demoMode, limit, 0));
  });

  app.post('/api/usage/rows/:id/assign', async (c) => {
    const user = requireUser(c);
    const body = await readJson(c);
    const row = await assignUsage(
      options.db,
      user.id,
      c.req.param('id'),
      body.botId ? String(body.botId) : null,
      String(body.note ?? ''),
      user.email,
      now(),
    );
    publish(user.id, 'usage.changed');
    return c.json(row);
  });

  app.delete('/api/usage/imports/:id', async (c) => {
    const user = requireUser(c);
    await deleteImport(options.db, user.id, c.req.param('id'), user.email, now());
    publish(user.id, 'usage.changed');
    return c.json({ ok: true });
  });

  app.post('/api/usage/reset', async (c) => {
    const user = requireUser(c);
    const body = await readJson(c);
    if (body.confirm !== 'EFFACER')
      return c.json({ error: 'Saisissez EFFACER pour confirmer.' }, 400);
    await resetUsage(options.db, user.id, user.email, now());
    publish(user.id, 'usage.changed');
    return c.json({ ok: true });
  });

  app.get('/api/usage/export.csv', async (c) => {
    const user = requireUser(c);
    const rows = await exportRows(options.db, user.id, readQuery(c));
    const csv = toCsv(
      [
        'Jour',
        'Horodatage',
        'Entrée',
        'Cache',
        'Sortie',
        'Total',
        'Coût brut',
        'Coût numérique',
        'Nature du coût',
        'Modèle',
        'Type',
        'Automation',
        'Identifiant signalé',
        'Bot',
        'Provenance',
        'Source',
        'Démonstration',
      ],
      rows.map((row) => [
        row.day ?? '',
        row.occurredAt ?? '',
        cellNum(row.inputTokens),
        cellNum(row.cacheTokens),
        cellNum(row.outputTokens),
        cellNum(row.totalTokens),
        row.costRaw,
        row.costValue == null ? '' : String(row.costValue),
        row.costKind === 'numeric'
          ? 'numérique'
          : row.costKind === 'included'
            ? 'inclus'
            : 'inconnu',
        row.model,
        row.kind,
        row.automationId,
        row.reportedBotKey,
        row.botName ?? '',
        row.assignmentProvenance ?? '',
        row.source === 'demo' ? 'démo' : 'csv',
        row.isDemo ? 'oui' : 'non',
      ]),
    );
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="usage-bot-cockpit.csv"',
        'Cache-Control': 'no-store',
      },
    });
  });

  app.get('/api/fixtures/synthetique.csv', async (c) => {
    requireUser(c);
    const fixturesDir = options.fixturesDir ?? join(here, '../../fixtures');
    const file = await readFile(join(fixturesDir, 'usage-synthetique.csv'));
    return new Response(file, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="usage-synthetique.csv"',
        'Cache-Control': 'no-store',
      },
    });
  });

  app.get('/api/tokens', async (c) => {
    const user = requireUser(c);
    return c.json(await listTokens(options.db, user.id));
  });

  app.post('/api/tokens', async (c) => {
    const user = requireUser(c);
    const body = await readJson(c);
    const minted = newSecret('bc_');
    const id = await insertToken(
      options.db,
      user.id,
      String(body.label ?? ''),
      minted.hash,
      minted.hint,
      user.email,
      now(),
    );
    return c.json(
      {
        id,
        label: cleanText(String(body.label ?? ''), 80),
        hint: minted.hint,
        token: minted.secret,
        createdAt: now().toISOString(),
      },
      201,
    );
  });

  app.post('/api/tokens/:id/revoke', async (c) => {
    const user = requireUser(c);
    await revokeToken(options.db, user.id, c.req.param('id'), user.email, now());
    return c.json({ ok: true });
  });

  app.get('/api/events', async (c) => {
    const user = requireUser(c);
    return c.json(
      await listEvents(options.db, user.id, (await readSettings(options.db, user.id)).demoMode),
    );
  });

  app.post('/api/events/:id/materialize', async (c) => {
    const user = requireUser(c);
    const body = await readJson(c);
    const bot = await materializeSignal(
      options.db,
      user.id,
      c.req.param('id'),
      String(body.name ?? ''),
      user.email,
      now(),
    );
    publish(user.id, 'bot.updated');
    publish(user.id, 'event.created');
    return c.json(bot, 201);
  });

  app.get('/api/stream', async (c) => {
    const user = requireUser(c);
    const encoder = new TextEncoder();
    let unsubscribe = () => {};
    const stream = new ReadableStream({
      start(controller) {
        const send = (event: string, data: unknown) => {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };
        send('ready', { ok: true });
        unsubscribe = subscribe(user.id, send);
        c.req.raw.signal.addEventListener('abort', () => unsubscribe());
      },
      cancel() {
        unsubscribe();
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      },
    });
  });

  app.get('/api/webhooks', async (c) => {
    const user = requireUser(c);
    return c.json({
      actions: webhooks.map((item) => ({ name: item.name })),
      calls: await listWebhookCalls(options.db, user.id),
      note: webhooks.length
        ? 'Une réponse HTTP 200 signifie demandé / en attente, pas une tâche terminée.'
        : 'Aucune action n’est configurée. Le contrôle distant reste désactivé : pas d’arrêt ni de suppression forcée.',
    });
  });

  app.post('/api/webhooks/:name', async (c) => {
    const user = requireUser(c);
    const name = c.req.param('name');
    if (!/^[a-z0-9][a-z0-9_-]{1,40}$/.test(name)) return c.json({ error: 'Action inconnue.' }, 404);
    const action = webhooks.find((item) => item.name === name);
    if (!action) return c.json({ error: 'Action non configurée sur ce serveur.' }, 404);
    const body = await readJson(c);
    if (body.confirm !== 'DEMANDER')
      return c.json({ error: 'Saisissez DEMANDER pour confirmer.' }, 400);
    const botId = body.botId ? String(body.botId) : null;
    if (botId) await getBot(options.db, user.id, botId, now());
    if ((await recentWebhookCount(options.db, user.id, name, now())) >= 10) {
      const blocked = await insertWebhookCall(
        options.db,
        user.id,
        {
          action: name,
          botId,
          status: 'blocked',
          httpStatus: null,
          detail: 'Limite horaire atteinte. Aucun appel envoyé.',
        },
        now(),
      );
      return c.json(blocked, 429);
    }
    let detail =
      'Demandé / en attente. Une réponse positive signifie que l’appel a été accepté, pas qu’une tâche est terminée.';
    let status: 'requested' | 'failed' = 'requested';
    let httpStatus: number | null = null;
    try {
      await assertWebhookUrl(action.url, options.allowPrivateWebhooks === true);
      const response = await fetch(action.url, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(8_000),
        headers: {
          'content-type': 'application/json',
          'user-agent': 'BotCockpit/0.1',
          ...(options.webhookSecret ? { authorization: `Bearer ${options.webhookSecret}` } : {}),
        },
        body: JSON.stringify({
          action: name,
          botId,
          requestedAt: now().toISOString(),
          note: 'Demande émise par Bot Cockpit. Ceci ne confirme pas l’exécution.',
        }),
      });
      httpStatus = response.status;
      await response.body?.cancel().catch(() => undefined);
      if (response.status >= 300 && response.status < 400) {
        status = 'failed';
        detail = 'Redirection refusée. Aucune tâche n’est confirmée.';
      } else if (response.status < 200 || response.status >= 300) {
        status = 'failed';
        detail = `Réponse HTTP ${response.status}. État non confirmé.`;
      }
    } catch {
      status = 'failed';
      detail = 'Appel impossible (délai dépassé, réseau ou adresse refusée).';
    }
    const call = await insertWebhookCall(
      options.db,
      user.id,
      { action: name, botId, status, httpStatus, detail },
      now(),
    );
    await addAudit(
      options.db,
      user.id,
      user.email,
      'webhook',
      `${name} · ${status === 'requested' ? 'demandé / en attente' : 'échec'}`,
      now(),
    );
    return c.json(call, status === 'requested' ? 202 : 502);
  });

  app.get('/api/audit', async (c) => {
    const user = requireUser(c);
    return c.json(await listAudit(options.db, user.id));
  });

  app.post('/api/reset', async (c) => {
    const user = requireUser(c);
    const body = await readJson(c);
    if (body.confirm !== 'VIDER') return c.json({ error: 'Saisissez VIDER pour confirmer.' }, 400);
    await resetWorkshop(options.db, user.id, user.email, now());
    publish(user.id, 'bot.updated');
    publish(user.id, 'usage.changed');
    return c.json({ ok: true });
  });

  app.all('/mcp', async (c) => {
    const url = new URL(c.req.url);
    if (
      url.searchParams.has('token') ||
      url.searchParams.has('access_token') ||
      url.searchParams.has('key')
    ) {
      return c.json({ error: 'Le jeton ne doit pas transiter dans l’URL.' }, 400);
    }
    const ip = clientIp(c);
    if (!allow(`mcp-ip:${ip}`, 300, 60_000)) return c.json({ error: 'Trop de signalements.' }, 429);
    const header = c.req.header('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    const secret = match?.[1]?.trim() ?? '';
    if (!secret) return c.json({ error: 'Jeton Bearer requis.' }, 401);
    const token = await authenticateToken(options.db, secret);
    if (!token) return c.json({ error: 'Jeton refusé.' }, 401);
    if (!allow(`mcp:${token.id}`, 180, 60_000))
      return c.json({ error: 'Trop de signalements.' }, 429);
    mcpOwners.set(token.id, token.userId);
    await touchToken(options.db, token.id, now());
    return mcp.fetch(c.req.raw, {
      authInfo: { token: 'present', clientId: token.id, scopes: ['report'] },
    });
  });

  if (options.serveClient) {
    const root = resolve(options.clientDir ?? join(here, '../client'));
    app.get('*', async (c) => {
      if (c.req.path.startsWith('/api') || c.req.path.startsWith('/mcp'))
        return c.json({ error: 'Introuvable.' }, 404);
      const rel =
        c.req.path === '/' ? 'index.html' : decodeURIComponent(c.req.path).replace(/^\/+/, '');
      if (rel.includes('\0')) return c.text('Requête refusée', 400);
      const file = resolve(root, rel);
      if (file !== root && !file.startsWith(root + sep)) return c.text('Requête refusée', 400);
      if (existsSync(file) && !file.endsWith(sep)) {
        const body = await readFile(file);
        return new Response(body, {
          headers: {
            'Content-Type': contentType(file),
            'Cache-Control': file.includes(`${sep}assets${sep}`)
              ? 'public, max-age=31536000, immutable'
              : 'no-cache',
          },
        });
      }
      if (rel.includes('.')) return c.text('Introuvable', 404);
      const index = await readFile(join(root, 'index.html'));
      return new Response(index, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
      });
    });
  }

  function subscribe(userId: string, listener: (event: string, data: unknown) => void) {
    const entry = { userId, fn: listener };
    listeners.add(entry);
    return () => listeners.delete(entry);
  }

  function setSession(c: Parameters<typeof setCookie>[0], token: string) {
    setCookie(c, 'cockpit_session', token, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: options.cookieSecure === true,
      path: '/',
      maxAge: 14 * 24 * 60 * 60,
    });
  }

  function setupPermitted(provided: string, ip: string): boolean {
    if (setupToken) return safeEqual(provided, setupToken);
    if (allowOpenSetup) return true;
    return isLoopback(ip);
  }

  return { app, close: () => mcp.close() };
}

function requireUser(c: { get: (key: 'user') => SessionUser | null }): SessionUser {
  const user = c.get('user');
  if (!user) throw new HttpError(401, 'Authentification requise.');
  return user;
}

async function readJson(c: {
  req: { header: (name: string) => string | undefined; json: () => Promise<unknown> };
}): Promise<Record<string, unknown>> {
  const length = Number(c.req.header('content-length') || '0');
  if (length > 1_000_000) throw new HttpError(413, 'Corps trop volumineux.');
  try {
    const value = await c.req.json();
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new HttpError(400, 'JSON invalide.');
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'JSON invalide.');
  }
}

function assertEmail(value: unknown): string {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160) {
    throw new HttpError(400, 'Adresse électronique invalide.');
  }
  return email;
}

function assertPassword(value: unknown): string {
  const password = typeof value === 'string' ? value : '';
  if (password.length < 12 || password.length > 200)
    throw new HttpError(400, 'Le mot de passe doit contenir au moins 12 caractères.');
  return password;
}

function clientIp(c: {
  req: { raw: Request; header: (name: string) => string | undefined };
}): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  const realIp = c.req.header('x-real-ip');
  if (realIp) return realIp;
  try {
    const info = getConnInfo(c as never);
    return info.remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function readQuery(c: { req: { query: (name: string) => string | undefined } }): UsageQuery {
  const source = c.req.query('source') || null;
  return {
    from: assertDay(c.req.query('from') || null),
    to: assertDay(c.req.query('to') || null),
    model: cleanText(c.req.query('model') || '', 160) || null,
    source: source === 'csv' || source === 'demo' ? source : null,
    bot: cleanText(c.req.query('bot') || '', 80) || null,
  };
}

function buildPreview(
  stagingId: string,
  filename: string,
  headers: string[],
  delimiter: string,
  errors: Array<{ line: number; message: string }>,
  records: string[][],
  mapping: ColumnMapping,
) {
  const drafts = interpretRows(headers, records, mapping);
  const seen = new Set<string>();
  let included = 0;
  let skipped = 0;
  let inFileDuplicates = 0;
  for (const draft of drafts) {
    if (!draft.include) {
      skipped += 1;
      continue;
    }
    if (seen.has(draft.fingerprint)) inFileDuplicates += 1;
    else {
      seen.add(draft.fingerprint);
      included += 1;
    }
  }
  const warnings = [
    'Les colonnes absentes restent vides. Un coût Included ou « - » n’est pas un zéro.',
    'Les lignes sans identifiant reconnu restent non attribuées.',
  ];
  if (/synth|fixture|demo/i.test(filename))
    warnings.push('Ce fichier ressemble à une fixture de test, pas à un export de compte.');
  return {
    stagingId,
    filename,
    headers,
    delimiter: delimiter === '\t' ? 'tab' : delimiter,
    mapping,
    errors,
    warnings,
    counts: { rows: records.length, included, skipped, inFileDuplicates },
    sample: drafts
      .filter((draft) => draft.include)
      .slice(0, 12)
      .map((draft) => ({
        line: draft.line,
        day: draft.day,
        occurredAt: draft.occurredAt,
        inputTokens: draft.inputTokens,
        cacheTokens: draft.cacheTokens,
        outputTokens: draft.outputTokens,
        totalTokens: draft.totalTokens,
        costRaw: draft.costRaw,
        costValue: draft.costValue,
        costKind: draft.costKind,
        model: draft.model,
        kind: draft.kind,
        automationId: draft.automationId,
        botKey: draft.botKey,
        messages: draft.messages,
      })),
  };
}

function cellNum(value: number | null): string {
  return value == null ? '' : String(value);
}

function cleanTokens(
  value: { input?: number; cache?: number; output?: number; total?: number } | undefined,
) {
  if (!value) return null;
  const tokens: { input?: number; cache?: number; output?: number; total?: number } = {};
  for (const key of ['input', 'cache', 'output', 'total'] as const) {
    if (typeof value[key] === 'number') tokens[key] = value[key];
  }
  return Object.keys(tokens).length ? tokens : null;
}

function resolveOccurred(raw: string | undefined, current: Date): string {
  if (!raw) return current.toISOString();
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return current.toISOString();
  return new Date(Math.min(parsed, current.getTime() + 5 * 60_000)).toISOString();
}

function contentType(file: string): string {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  if (file.endsWith('.woff2')) return 'font/woff2';
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}
