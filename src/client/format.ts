import type { Bot, BotStatus } from '../shared/types';

export const TZ = 'Europe/Paris';

export const STATUS_LABEL: Record<BotStatus, string> = {
  offline: 'Hors ligne',
  idle: 'Disponible',
  working: 'Au travail',
  away: 'Absent',
  blocked: 'Bloqué',
};

export const STATUS_ORDER: BotStatus[] = ['working', 'blocked', 'idle', 'away', 'offline'];

const timeFmt = new Intl.DateTimeFormat('fr-FR', {
  timeZone: TZ,
  hour: '2-digit',
  minute: '2-digit',
});
const dateTimeFmt = new Intl.DateTimeFormat('fr-FR', {
  timeZone: TZ,
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});
const dayKeyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });
const dayLabelFmt = new Intl.DateTimeFormat('fr-FR', {
  timeZone: TZ,
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** HH:mm in Europe/Paris. */
export function formatTime(iso: string | null | undefined): string {
  const date = parse(iso);
  return date ? timeFmt.format(date) : '—';
}

/** « 11 nov. à 07:09 » in Europe/Paris; today → « aujourd’hui à 07:09 ». */
export function formatDateTime(iso: string | null | undefined): string {
  const date = parse(iso);
  if (!date) return '—';
  const key = dayKeyFmt.format(date);
  const today = dayKeyFmt.format(new Date());
  const yesterday = dayKeyFmt.format(new Date(Date.now() - 86_400_000));
  if (key === today) return `aujourd’hui à ${timeFmt.format(date)}`;
  if (key === yesterday) return `hier à ${timeFmt.format(date)}`;
  return dateTimeFmt.format(date).replace(',', ' à');
}

/** YYYY-MM-DD of the Paris calendar day. */
export function dayKey(iso: string | null | undefined): string {
  const date = parse(iso);
  return date ? dayKeyFmt.format(date) : 'inconnu';
}

export function dayLabel(key: string): string {
  const today = dayKeyFmt.format(new Date());
  const yesterday = dayKeyFmt.format(new Date(Date.now() - 86_400_000));
  if (key === today) return 'Aujourd’hui';
  if (key === yesterday) return 'Hier';
  const date = new Date(`${key}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return 'Date inconnue';
  const label = dayLabelFmt.format(date);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function formatNumber(value: number | null): string {
  if (value == null) return '—';
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 4 }).format(value);
}

export function formatWhen(iso: string | null): string {
  if (!iso) return 'jamais';
  const diff = Date.now() - Date.parse(iso);
  if (Number.isNaN(diff)) return '—';
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'à l’instant';
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  return formatDateTime(iso);
}

export function signalLabel(bot: Bot): string {
  if (!bot.lastSeenAt) return 'Aucun signal reçu';
  const when = formatWhen(bot.lastSeenAt);
  if (bot.stale && !bot.quiet) return `Silencieux · ${when}`;
  return `Vu ${when}`;
}

export function sourceLabel(source: string): string {
  if (source === 'csv') return 'CSV';
  if (source === 'demo') return 'Démo';
  if (source === 'mcp') return 'MCP';
  if (source === 'manual') return 'Manuel';
  if (!source || source === 'bot') return 'Signal du bot';
  return `Signal · ${source}`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

/** Stable hue per bot so avatars stay recognisable. */
export function hueOf(text: string): number {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}
