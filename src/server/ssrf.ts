import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const BLOCKED_NAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.internal',
]);

function ipv4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value << 8) + n;
  }
  return value >>> 0;
}

export function isBlockedIp(address: string): boolean {
  const raw = address.toLowerCase();
  const mapped = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
  if (isIP(mapped) === 4) {
    const value = ipv4ToInt(mapped);
    if (value == null) return true;
    const first = value >>> 24;
    const second = (value >>> 16) & 255;
    if (first === 0 || first === 10 || first === 127) return true;
    if (first === 169 && second === 254) return true;
    if (first === 172 && second >= 16 && second <= 31) return true;
    if (first === 192 && second === 168) return true;
    if (first === 100 && second >= 64 && second <= 127) return true;
    if (first >= 224) return true;
    return false;
  }
  if (raw === '::1' || raw === '::') return true;
  if (raw.startsWith('fe80:') || raw.startsWith('fc') || raw.startsWith('fd')) return true;
  if (raw.startsWith('ff')) return true;
  return false;
}

export function isMetadataIp(address: string): boolean {
  const raw = address.toLowerCase().replace(/^::ffff:/, '');
  return raw.startsWith('169.254.');
}

export async function assertWebhookUrl(raw: string, allowPrivate: boolean): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('URL invalide.');
  }
  if (url.username || url.password) throw new Error('URL avec identifiant refusée.');
  const httpsOk = url.protocol === 'https:';
  const httpOk = allowPrivate && url.protocol === 'http:';
  if (!httpsOk && !httpOk) throw new Error('Seul le HTTPS est accepté.');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host.includes('%')) throw new Error('Hôte refusé.');
  const namedBlocked =
    BLOCKED_NAMES.has(host) ||
    host.endsWith('.local') ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal');
  if (namedBlocked && (!allowPrivate || host.includes('metadata'))) {
    throw new Error('Hôte interne refusé.');
  }
  if (isIP(host)) {
    if (isMetadataIp(host) || (!allowPrivate && isBlockedIp(host))) {
      throw new Error('Adresse interne refusée.');
    }
    return url;
  }
  let records: { address: string }[];
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error('Résolution DNS impossible.');
  }
  if (records.length === 0) throw new Error('Résolution DNS vide.');
  for (const record of records) {
    if (isMetadataIp(record.address) || (!allowPrivate && isBlockedIp(record.address))) {
      throw new Error('Résolution vers une adresse interne refusée.');
    }
  }
  return url;
}

const FORBIDDEN_ACTION = /^(stop|delete|kill|destroy|remove|supprimer|force[-_]?stop|shutdown)$/i;

export type WebhookAction = { name: string; url: string };

export function loadWebhookConfig(raw: string | undefined, allowPrivate: boolean): WebhookAction[] {
  if (!raw || raw.trim() === '' || raw.trim() === '{}') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('BOT_COCKPIT_WEBHOOKS n’est pas un JSON valide.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('BOT_COCKPIT_WEBHOOKS doit être un objet nom → URL.');
  }
  const actions: WebhookAction[] = [];
  for (const [name, value] of Object.entries(parsed)) {
    if (!/^[a-z0-9][a-z0-9_-]{1,40}$/.test(name)) {
      throw new Error(`Nom d’action refusé : ${name}`);
    }
    if (FORBIDDEN_ACTION.test(name)) {
      throw new Error(`Action non prise en charge (aucun arrêt ni suppression forcée) : ${name}`);
    }
    if (typeof value !== 'string') throw new Error(`URL manquante pour ${name}.`);
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`URL invalide pour ${name}.`);
    }
    if (url.username || url.password) throw new Error(`URL avec identifiant refusée pour ${name}.`);
    const httpsOk = url.protocol === 'https:';
    const httpOk = allowPrivate && url.protocol === 'http:';
    if (!httpsOk && !httpOk) throw new Error(`HTTPS requis pour ${name}.`);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && (isMetadataIp(host) || (!allowPrivate && isBlockedIp(host)))) {
      throw new Error(`Adresse interne refusée pour ${name}.`);
    }
    actions.push({ name, url: url.toString() });
  }
  return actions;
}
