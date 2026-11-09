export const APP_NAME = 'Bot Cockpit';
export const APP_VERSION = '0.1.0';

export const BOT_STATUSES = ['offline', 'idle', 'working', 'away', 'blocked'] as const;
export type BotStatus = (typeof BOT_STATUSES)[number];

export const ACCENTS = ['#7ec8e3', '#c4b2ff', '#ff8f8f', '#ffb067', '#8eb7ff', '#8fd4c8'] as const;

export const ROOM_KINDS = ['revue', 'atelier', 'salon', 'labo', 'diffusion'] as const;
export type RoomKind = (typeof ROOM_KINDS)[number];

export type CostKind = 'numeric' | 'included' | 'unknown';
export type UsageSource = 'csv' | 'demo';
export type SignalKind = 'status' | 'event';

export type Team = {
  id: string;
  name: string;
  mission: string;
  accent: string;
  origin: string;
  archivedAt: string | null;
  isDemo: boolean;
  createdAt: string;
};

export type Room = {
  id: string;
  teamId: string | null;
  name: string;
  kind: RoomKind;
  gridX: number;
  gridY: number;
  isDemo: boolean;
};

export type Bot = {
  id: string;
  externalKey: string;
  name: string;
  role: string;
  brief: string;
  teamId: string | null;
  roomId: string | null;
  status: BotStatus;
  statusNote: string;
  lastSeenAt: string | null;
  archivedAt: string | null;
  isDemo: boolean;
  origin: string;
  stale: boolean;
  quiet: boolean;
  createdAt: string;
  updatedAt: string;
};

export type HistoryEntry = {
  id: string;
  botId: string;
  status: BotStatus;
  note: string;
  source: string;
  occurredAt: string;
};

export type Signal = {
  id: string;
  botId: string | null;
  reportedBotKey: string;
  reportedSource: string;
  kind: SignalKind;
  name: string;
  detail: string;
  occurredAt: string;
  receivedAt: string;
  linked: boolean;
  isDemo: boolean;
  partialTokens: boolean;
};

export type UsageImport = {
  id: string;
  filename: string;
  rowCount: number;
  duplicateCount: number;
  skippedCount: number;
  errorCount: number;
  createdAt: string;
};

export type UsageRow = {
  id: string;
  importId: string | null;
  occurredAt: string | null;
  day: string | null;
  inputTokens: number | null;
  cacheTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costRaw: string;
  costValue: number | null;
  costKind: CostKind;
  model: string;
  kind: string;
  automationId: string;
  reportedBotKey: string;
  botId: string | null;
  botName: string | null;
  assignmentProvenance: string | null;
  source: UsageSource;
  isDemo: boolean;
};

export type Insight = {
  id: string;
  title: string;
  detail: string;
  rule: string;
};

export type UsageSummary = {
  filters: {
    from: string | null;
    to: string | null;
    model: string | null;
    source: string | null;
    bot: string | null;
  };
  totals: {
    rows: number;
    unassignedRows: number;
    undatedRows: number;
    tokenRows: number;
    missingTotalRows: number;
    inputTokens: number | null;
    cacheTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    costNumericSum: number | null;
    costNumericRows: number;
    costIncludedRows: number;
    costUnknownRows: number;
  };
  byDay: Array<{
    day: string;
    rows: number;
    rowsWithTotal: number;
    totalTokens: number;
    costNumericSum: number | null;
  }>;
  byModel: Array<{ model: string; rows: number; totalTokens: number }>;
  models: string[];
  insights: Insight[];
  warnings: string[];
  eventTokenSignals: number;
};

export type ColumnMapping = {
  date: string | null;
  dateOrder: 'dmy' | 'mdy';
  inputTokens: string | null;
  cacheTokens: string | null;
  outputTokens: string | null;
  totalTokens: string | null;
  cost: string | null;
  model: string | null;
  kind: string | null;
  automationId: string | null;
  botKey: string | null;
};

export type AccessToken = {
  id: string;
  label: string;
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export type WebhookCall = {
  id: string;
  actionName: string;
  botId: string | null;
  status: 'requested' | 'failed' | 'blocked';
  httpStatus: number | null;
  detail: string;
  createdAt: string;
};

export type AuditEntry = {
  id: string;
  actor: string;
  action: string;
  detail: string;
  createdAt: string;
};

export type PackSummary = {
  id: string;
  name: string;
  mission: string;
  accent: string;
  rooms: number;
  bots: number;
};

export type Settings = {
  demoMode: boolean;
  retentionDays: number;
  staleMinutes: number;
};

export type Workspace = {
  settings: Settings;
  teams: Team[];
  rooms: Room[];
  bots: Bot[];
  signals: Signal[];
  imports: UsageImport[];
  webhookActions: string[];
};
