import type {
  Bot,
  BotStatus,
  HistoryEntry,
  Room,
  RoomKind,
  Signal,
  Team,
  UsageImport,
  UsageRow,
  WebhookCall,
} from '../shared/types.js';

export type Row = Record<string, unknown>;

export function str(row: Row, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

export function strOrNull(row: Row, key: string): string | null {
  const value = row[key];
  if (value == null) return null;
  return typeof value === 'string' ? value : String(value);
}

export function numOrNull(row: Row, key: string): number | null {
  const value = row[key];
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  return null;
}

export function flag(row: Row, key: string): boolean {
  return Number(row[key] ?? 0) === 1;
}

export function mapTeam(row: Row): Team {
  return {
    id: str(row, 'id'),
    name: str(row, 'name'),
    mission: str(row, 'mission'),
    accent: str(row, 'accent'),
    origin: str(row, 'origin'),
    archivedAt: strOrNull(row, 'archived_at'),
    isDemo: flag(row, 'is_demo'),
    createdAt: str(row, 'created_at'),
  };
}

export function mapRoom(row: Row): Room {
  return {
    id: str(row, 'id'),
    teamId: strOrNull(row, 'team_id'),
    name: str(row, 'name'),
    kind: str(row, 'kind') as RoomKind,
    gridX: numOrNull(row, 'grid_x') ?? 0,
    gridY: numOrNull(row, 'grid_y') ?? 0,
    isDemo: flag(row, 'is_demo'),
  };
}

export function mapBot(row: Row, now: Date, staleMinutes: number): Bot {
  const lastSeenAt = strOrNull(row, 'last_seen_at');
  const archivedAt = strOrNull(row, 'archived_at');
  const status = str(row, 'status') as BotStatus;
  const age = lastSeenAt ? now.getTime() - Date.parse(lastSeenAt) : Number.POSITIVE_INFINITY;
  const stale = !archivedAt && age > staleMinutes * 60_000;
  const quiet = stale && (status === 'offline' || !lastSeenAt);
  return {
    id: str(row, 'id'),
    externalKey: str(row, 'external_key'),
    name: str(row, 'name'),
    role: str(row, 'role'),
    brief: str(row, 'brief'),
    teamId: strOrNull(row, 'team_id'),
    roomId: strOrNull(row, 'room_id'),
    status,
    statusNote: str(row, 'status_note'),
    lastSeenAt,
    archivedAt,
    isDemo: flag(row, 'is_demo'),
    origin: str(row, 'origin'),
    stale,
    quiet,
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}

export function mapHistory(row: Row): HistoryEntry {
  return {
    id: str(row, 'id'),
    botId: str(row, 'bot_id'),
    status: str(row, 'status') as BotStatus,
    note: str(row, 'note'),
    source: str(row, 'source'),
    occurredAt: str(row, 'occurred_at'),
  };
}

export function mapSignal(row: Row): Signal {
  let partialTokens = false;
  try {
    const payload = JSON.parse(str(row, 'payload_json') || '{}') as { tokens?: unknown };
    partialTokens = Boolean(payload.tokens && typeof payload.tokens === 'object');
  } catch {
    partialTokens = false;
  }
  return {
    id: str(row, 'id'),
    botId: strOrNull(row, 'bot_id'),
    reportedBotKey: str(row, 'reported_bot_key'),
    reportedSource: str(row, 'reported_source'),
    kind: str(row, 'kind') === 'status' ? 'status' : 'event',
    name: str(row, 'name'),
    detail: str(row, 'detail'),
    occurredAt: str(row, 'occurred_at'),
    receivedAt: str(row, 'received_at'),
    linked: flag(row, 'linked'),
    isDemo: flag(row, 'is_demo'),
    partialTokens,
  };
}

export function mapImport(row: Row): UsageImport {
  return {
    id: str(row, 'id'),
    filename: str(row, 'filename'),
    rowCount: numOrNull(row, 'row_count') ?? 0,
    duplicateCount: numOrNull(row, 'duplicate_count') ?? 0,
    skippedCount: numOrNull(row, 'skipped_count') ?? 0,
    errorCount: numOrNull(row, 'error_count') ?? 0,
    createdAt: str(row, 'created_at'),
  };
}

export function mapUsage(row: Row): UsageRow {
  const kind = str(row, 'cost_kind');
  return {
    id: str(row, 'id'),
    importId: strOrNull(row, 'import_id'),
    occurredAt: strOrNull(row, 'occurred_at'),
    day: strOrNull(row, 'day'),
    inputTokens: numOrNull(row, 'input_tokens'),
    cacheTokens: numOrNull(row, 'cache_tokens'),
    outputTokens: numOrNull(row, 'output_tokens'),
    totalTokens: numOrNull(row, 'total_tokens'),
    costRaw: str(row, 'cost_raw'),
    costValue: numOrNull(row, 'cost_value'),
    costKind: kind === 'numeric' || kind === 'included' ? kind : 'unknown',
    model: str(row, 'model'),
    kind: str(row, 'kind'),
    automationId: str(row, 'automation_id'),
    reportedBotKey: str(row, 'reported_bot_key'),
    botId: strOrNull(row, 'bot_id'),
    botName: strOrNull(row, 'bot_name'),
    assignmentProvenance: strOrNull(row, 'assignment_provenance'),
    source: str(row, 'source') === 'demo' ? 'demo' : 'csv',
    isDemo: flag(row, 'is_demo'),
  };
}

export function mapWebhook(row: Row): WebhookCall {
  const status = str(row, 'status');
  return {
    id: str(row, 'id'),
    actionName: str(row, 'action_name'),
    botId: strOrNull(row, 'bot_id'),
    status: status === 'failed' || status === 'blocked' ? status : 'requested',
    httpStatus: numOrNull(row, 'http_status'),
    detail: str(row, 'detail'),
    createdAt: str(row, 'created_at'),
  };
}
