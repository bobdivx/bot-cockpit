import type { Bot, BotStatus } from '../shared/types';

export const STATUS_LABEL: Record<BotStatus, string> = {
  offline: 'Hors ligne',
  idle: 'Disponible',
  working: 'Au travail',
  away: 'Absent',
  blocked: 'Bloqué',
};

export const KIND_LABEL: Record<string, string> = {
  revue: 'Revue',
  atelier: 'Atelier',
  salon: 'Salon',
  labo: 'Labo',
  diffusion: 'Diffusion',
};

export function formatNumber(value: number | null): string {
  if (value == null) return '—';
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 4 }).format(value);
}

export function formatWhen(iso: string | null): string {
  if (!iso) return 'Aucun signal';
  const diff = Date.now() - Date.parse(iso);
  if (Number.isNaN(diff)) return 'Horodatage illisible';
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'à l’instant';
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `il y a ${hours} h`;
  const days = Math.round(hours / 24);
  return `il y a ${days} j`;
}

export function signalLabel(bot: Bot): string {
  if (!bot.lastSeenAt) return 'Aucun signal';
  const when = formatWhen(bot.lastSeenAt);
  if (bot.stale && !bot.quiet) return `Signal ancien · ${when}`;
  if (bot.stale) return `Dernier contact ${when}`;
  return `Vu ${when}`;
}

export function sourceLabel(source: string): string {
  if (source === 'csv') return 'CSV';
  if (source === 'demo') return 'Démo';
  if (source === 'mcp') return 'MCP';
  if (source === 'manual') return 'Manuel';
  return source;
}
