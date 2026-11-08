import type { ColumnMapping, CostKind } from '../shared/types.js';
import { sha256 } from './security.js';

export const MAX_CSV_BYTES = 5 * 1024 * 1024;
export const MAX_CSV_ROWS = 20_000;
export const MAX_CELL = 2_000;

export class CsvError extends Error {}

export type ParsedCsv = {
  delimiter: ',' | ';' | '\t';
  headers: string[];
  records: string[][];
  errors: Array<{ line: number; message: string }>;
};

export type CostParse = { raw: string; value: number | null; kind: CostKind };

export type UsageDraft = {
  line: number;
  fingerprint: string;
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
  botKey: string;
  messages: string[];
  include: boolean;
};

const FIELD_ALIASES: Record<Exclude<keyof ColumnMapping, 'dateOrder'>, string[]> = {
  date: ['date', 'jour', 'timestamp', 'time', 'datetime', 'createdat', 'dateheure', 'horodatage'],
  inputTokens: [
    'inputtokens',
    'prompttokens',
    'jetonsdentree',
    'jetonsentree',
    'tokensin',
    'input',
    'prompt',
    'entree',
  ],
  cacheTokens: ['cachetokens', 'cachedtokens', 'jetonscache', 'cachelecture', 'cached', 'cache'],
  outputTokens: [
    'outputtokens',
    'completiontokens',
    'jetonssortie',
    'tokensout',
    'completion',
    'output',
    'sortie',
  ],
  totalTokens: ['totaltokens', 'usagetotal', 'total', 'tokens', 'jetons'],
  cost: ['cost', 'cout', 'price', 'amount', 'spend', 'montant'],
  model: ['model', 'modele'],
  kind: ['category', 'categorie', 'kind', 'type'],
  automationId: [
    'cloudagentid',
    'automationid',
    'routineid',
    'cloudagent',
    'automation',
    'agentid',
    'routine',
  ],
  botKey: ['identifiantbot', 'botid', 'botkey', 'bot'],
};

export function normHeader(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

export function emptyMapping(): ColumnMapping {
  return {
    date: null,
    dateOrder: 'dmy',
    inputTokens: null,
    cacheTokens: null,
    outputTokens: null,
    totalTokens: null,
    cost: null,
    model: null,
    kind: null,
    automationId: null,
    botKey: null,
  };
}

export function suggestMapping(headers: string[]): ColumnMapping {
  const mapping = emptyMapping();
  const used = new Set<string>();
  const ranked: Array<{
    field: Exclude<keyof ColumnMapping, 'dateOrder'>;
    header: string;
    weight: number;
  }> = [];
  for (const header of headers) {
    const key = normHeader(header);
    for (const field of Object.keys(FIELD_ALIASES) as Array<
      Exclude<keyof ColumnMapping, 'dateOrder'>
    >) {
      const alias = FIELD_ALIASES[field].find((item) => item === key);
      if (alias) ranked.push({ field, header, weight: alias.length });
    }
  }
  ranked.sort((a, b) => b.weight - a.weight);
  const usedFields = new Set<string>();
  for (const item of ranked) {
    if (used.has(item.header) || usedFields.has(item.field)) continue;
    mapping[item.field] = item.header;
    used.add(item.header);
    usedFields.add(item.field);
  }
  return mapping;
}

export function parseCsv(input: string): ParsedCsv {
  let text = input;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.includes('\u0000'))
    throw new CsvError('Encodage non pris en charge. Envoyez de l’UTF-8.');
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (text.trim() === '') throw new CsvError('Le fichier est vide.');

  const delimiter = detectDelimiter(text);
  const records: string[][] = [];
  const errors: Array<{ line: number; message: string }> = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let line = 1;
  let quoteLine = 1;
  let truncated = false;

  const pushRow = () => {
    row.push(field);
    field = '';
    const meaningful = row.some((cell) => cell.trim() !== '');
    const comment = row.length === 1 && row[0]?.trim().startsWith('#');
    if (meaningful && !comment) {
      if (records.length >= MAX_CSV_ROWS + 1) {
        throw new CsvError(`Trop de lignes (maximum ${MAX_CSV_ROWS}).`);
      }
      records.push(
        row.map((cell) => {
          if (cell.length > MAX_CELL) {
            truncated = true;
            return cell.slice(0, MAX_CELL);
          }
          return cell;
        }),
      );
    }
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line += 1;
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (field.length === 0) {
        inQuotes = true;
        quoteLine = line;
      } else {
        field += ch;
      }
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      pushRow();
      line += 1;
    } else {
      field += ch;
    }
  }
  if (inQuotes) {
    errors.push({
      line: quoteLine,
      message: 'Guillemet non fermé. La fin du fichier a été ignorée.',
    });
  } else if (field.length > 0 || row.length > 0) {
    pushRow();
  }
  if (truncated)
    errors.push({ line: 0, message: 'Certaines cellules ont été tronquées à 2 000 caractères.' });
  if (records.length === 0) throw new CsvError('Aucune ligne exploitable.');

  const headerRow = records[0] ?? [];
  const seen = new Map<string, number>();
  const headers = headerRow.map((header, index) => {
    const base = header.trim() || `colonne_${index + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base} #${count}`;
  });
  const body = records.slice(1).map((record) => {
    if (record.length !== headers.length) {
      errors.push({
        line: 0,
        message: `Une ligne a ${record.length} colonne(s) pour ${headers.length} en-têtes.`,
      });
    }
    const padded = headers.map((_, index) => record[index] ?? '');
    return padded;
  });
  if (errors.length > 40) errors.length = 40;
  return { delimiter, headers, records: body, errors };
}

function detectDelimiter(text: string): ',' | ';' | '\t' {
  let line = '';
  let inQuotes = false;
  const lines: string[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        line += ch;
        i += 1;
        line += '"';
      } else {
        inQuotes = !inQuotes;
        line += ch;
      }
      continue;
    }
    if (ch === '\n' && !inQuotes) {
      lines.push(line);
      line = '';
      continue;
    }
    line += ch;
  }
  if (line) lines.push(line);
  const sample = lines.find((item) => item.trim() !== '' && !item.trim().startsWith('#')) ?? '';
  const counts = [
    [',', countSep(sample, ',')],
    [';', countSep(sample, ';')],
    ['\t', countSep(sample, '\t')],
  ] as const;
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  if (!ranked[0] || ranked[0][1] === 0) return ',';
  return ranked[0][0];
}

function countSep(line: string, sep: string): number {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') i += 1;
      else inQuotes = !inQuotes;
    } else if (!inQuotes && ch === sep) count += 1;
  }
  return count;
}

export function normalizeDecimal(body: string, mode: 'token' | 'money'): string | null {
  const neg = body.startsWith('-');
  const source = neg ? body.slice(1) : body;
  if (!source || source.includes('-')) return null;
  const hasComma = source.includes(',');
  const hasDot = source.includes('.');
  let out = source;
  if (hasComma && hasDot) {
    out =
      source.lastIndexOf(',') > source.lastIndexOf('.')
        ? source.replace(/\./g, '').replace(',', '.')
        : source.replace(/,/g, '');
  } else if (hasComma || hasDot) {
    const sep = hasComma ? ',' : '.';
    const parts = source.split(sep);
    if (parts.some((part) => !/^\d+$/.test(part))) return null;
    if (parts.length > 2) {
      if (parts.slice(1).every((part) => part.length === 3)) out = parts.join('');
      else return null;
    } else {
      const whole = parts[0] ?? '';
      const frac = parts[1] ?? '';
      if (frac.length === 3) out = whole + frac;
      else if (mode === 'money' && frac.length > 0 && frac.length <= 2) out = `${whole}.${frac}`;
      else if (mode === 'token' && /^0+$/.test(frac)) out = whole;
      else return null;
    }
  }
  if (!/^\d+(\.\d+)?$/.test(out)) return null;
  return neg ? `-${out}` : out;
}

export function parseToken(raw: string | undefined): number | null {
  if (raw == null) return null;
  const original = raw.trim();
  if (!original || /^(-|—|–|n\/a|na|null|none)$/i.test(original)) return null;
  const compact = original.replace(/[\s\u00A0\u202F]/g, '');
  const normalized = normalizeDecimal(compact, 'token');
  if (normalized == null || normalized.includes('.')) return null;
  if (!/^\d+$/.test(normalized)) return null;
  const value = Number(normalized);
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000_000) return null;
  return value;
}

export function parseCost(raw: string | undefined): CostParse {
  const original = (raw ?? '').trim();
  if (!original || /^(-|—|–|n\/a|na|null|none|inconnu|unknown)$/i.test(original)) {
    return { raw: original, value: null, kind: 'unknown' };
  }
  if (/^(included|inclus|incluse|incluses|incl\.?)$/i.test(original)) {
    return { raw: original, value: null, kind: 'included' };
  }
  const stripped = original
    .replace(/[€$£]/g, '')
    .replace(/\b(eur|usd|gbp|dollars?|euros?)\b/gi, '')
    .trim()
    .replace(/[\s\u00A0\u202F]/g, '');
  const normalized = normalizeDecimal(stripped, 'money');
  if (normalized == null || !/^-?\d+(\.\d+)?$/.test(normalized)) {
    return { raw: original, value: null, kind: 'unknown' };
  }
  const value = Number(normalized);
  if (!Number.isFinite(value) || Math.abs(value) > 1_000_000_000) {
    return { raw: original, value: null, kind: 'unknown' };
  }
  return { raw: original, value, kind: 'numeric' };
}

export function parseDate(raw: string, order: 'dmy' | 'mdy'): { iso: string; day: string } | null {
  const text = raw.trim();
  if (!text) return null;
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    const hour = Number(iso[4] ?? 0);
    const minute = Number(iso[5] ?? 0);
    const second = Number(iso[6] ?? 0);
    return buildDate(year, month, day, hour, minute, second);
  }
  const local = text.match(
    /^(\d{1,2})[./](\d{1,2})[./](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (!local) return null;
  let day = Number(local[1]);
  let month = Number(local[2]);
  if (order === 'mdy') [day, month] = [month, day];
  return buildDate(
    Number(local[3]),
    month,
    day,
    Number(local[4] ?? 0),
    Number(local[5] ?? 0),
    Number(local[6] ?? 0),
  );
}

function buildDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): { iso: string; day: string } | null {
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59)
    return null;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  const dayText = `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
  return { iso: date.toISOString(), day: dayText };
}

export function interpretRows(
  headers: string[],
  records: string[][],
  mapping: ColumnMapping,
): UsageDraft[] {
  const index = new Map(headers.map((header, position) => [header, position]));
  const cell = (record: string[], header: string | null): string => {
    if (!header) return '';
    const position = index.get(header);
    if (position == null) return '';
    return record[position] ?? '';
  };
  return records.map((record, position) => interpretRecord(record, position + 2, mapping, cell));
}

function interpretRecord(
  record: string[],
  line: number,
  mapping: ColumnMapping,
  cell: (record: string[], header: string | null) => string,
): UsageDraft {
  const messages: string[] = [];
  const dateRaw = cell(record, mapping.date).trim();
  const inputRaw = cell(record, mapping.inputTokens);
  const cacheRaw = cell(record, mapping.cacheTokens);
  const outputRaw = cell(record, mapping.outputTokens);
  const totalRaw = cell(record, mapping.totalTokens);
  const costRawText = cell(record, mapping.cost);
  const model = cell(record, mapping.model).trim().slice(0, 160);
  const kind = cell(record, mapping.kind).trim().slice(0, 80);
  const automationId = cell(record, mapping.automationId).trim().slice(0, 160);
  const botKey = cell(record, mapping.botKey).trim().slice(0, 160);
  const blanks = [
    dateRaw,
    inputRaw,
    cacheRaw,
    outputRaw,
    totalRaw,
    costRawText,
    model,
    kind,
    automationId,
    botKey,
  ].every((value) => value.trim() === '');
  if (blanks) {
    return draftShell(line, messages, false);
  }
  let occurredAt: string | null = null;
  let day: string | null = null;
  if (mapping.date) {
    if (!dateRaw) messages.push('Date vide.');
    else {
      const parsed = parseDate(dateRaw, mapping.dateOrder);
      if (!parsed) messages.push('Date illisible.');
      else {
        occurredAt = parsed.iso;
        day = parsed.day;
      }
    }
  }
  const inputTokens = readToken(inputRaw, mapping.inputTokens, 'entrée', messages);
  const cacheTokens = readToken(cacheRaw, mapping.cacheTokens, 'cache', messages);
  const outputTokens = readToken(outputRaw, mapping.outputTokens, 'sortie', messages);
  const totalTokens = readToken(totalRaw, mapping.totalTokens, 'total', messages);
  const cost = mapping.cost
    ? parseCost(costRawText)
    : { raw: '', value: null, kind: 'unknown' as const };
  if (mapping.cost && costRawText.trim() && cost.kind === 'unknown')
    messages.push('Coût non numérique, laissé inconnu.');
  const fingerprint = sha256(
    JSON.stringify({
      occurredAt,
      day,
      inputTokens,
      cacheTokens,
      outputTokens,
      totalTokens,
      cost: cost.raw.trim().toLowerCase(),
      model: model.toLowerCase(),
      kind: kind.toLowerCase(),
      automationId: automationId.toLowerCase(),
      botKey: botKey.toLowerCase(),
    }),
  );
  return {
    line,
    fingerprint,
    occurredAt,
    day,
    inputTokens,
    cacheTokens,
    outputTokens,
    totalTokens,
    costRaw: cost.raw,
    costValue: cost.value,
    costKind: mapping.cost ? cost.kind : 'unknown',
    model,
    kind,
    automationId,
    botKey,
    messages,
    include: true,
  };
}

function readToken(
  raw: string,
  mapped: string | null,
  label: string,
  messages: string[],
): number | null {
  if (!mapped || raw.trim() === '') return null;
  const value = parseToken(raw);
  if (value == null) messages.push(`Jetons ${label} illisibles.`);
  return value;
}

function draftShell(line: number, messages: string[], include: boolean): UsageDraft {
  return {
    line,
    fingerprint: '',
    occurredAt: null,
    day: null,
    inputTokens: null,
    cacheTokens: null,
    outputTokens: null,
    totalTokens: null,
    costRaw: '',
    costValue: null,
    costKind: 'unknown',
    model: '',
    kind: '',
    automationId: '',
    botKey: '',
    messages,
    include,
  };
}

export function mappingHasField(mapping: ColumnMapping): boolean {
  return Boolean(
    mapping.date ||
      mapping.inputTokens ||
      mapping.cacheTokens ||
      mapping.outputTokens ||
      mapping.totalTokens ||
      mapping.cost ||
      mapping.model ||
      mapping.kind ||
      mapping.automationId ||
      mapping.botKey,
  );
}

export function assertMapping(headers: string[], mapping: ColumnMapping): void {
  if (mapping.dateOrder !== 'dmy' && mapping.dateOrder !== 'mdy') {
    throw new CsvError('Ordre de date inconnu.');
  }
  if (!mappingHasField(mapping)) throw new CsvError('Associez au moins une colonne.');
  const chosen = [
    mapping.date,
    mapping.inputTokens,
    mapping.cacheTokens,
    mapping.outputTokens,
    mapping.totalTokens,
    mapping.cost,
    mapping.model,
    mapping.kind,
    mapping.automationId,
    mapping.botKey,
  ].filter((value): value is string => Boolean(value));
  if (new Set(chosen).size !== chosen.length)
    throw new CsvError('Deux champs utilisent la même colonne.');
  for (const header of chosen) {
    if (!headers.includes(header)) throw new CsvError(`Colonne inconnue : ${header}`);
  }
}

export function guardCsvCell(value: string): string {
  let safe = value ?? '';
  if (/^[=+\-@\t\r]/.test(safe)) safe = `'${safe}`;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function toCsv(headers: string[], rows: string[][]): string {
  const lines = [headers, ...rows].map((row) => row.map((cell) => guardCsvCell(cell)).join(','));
  return `\uFEFF${lines.join('\r\n')}`;
}

export function sanitizeMapping(input: unknown): ColumnMapping {
  const source = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const pick = (key: Exclude<keyof ColumnMapping, 'dateOrder'>): string | null => {
    const value = source[key];
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, 120) : null;
  };
  return {
    date: pick('date'),
    dateOrder: source.dateOrder === 'mdy' ? 'mdy' : 'dmy',
    inputTokens: pick('inputTokens'),
    cacheTokens: pick('cacheTokens'),
    outputTokens: pick('outputTokens'),
    totalTokens: pick('totalTokens'),
    cost: pick('cost'),
    model: pick('model'),
    kind: pick('kind'),
    automationId: pick('automationId'),
    botKey: pick('botKey'),
  };
}
