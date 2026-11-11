import { useEffect, useState } from 'preact/hooks';
import type {
  ColumnMapping,
  UsageImport,
  UsageRow,
  UsageSummary,
  Workspace,
} from '../shared/types';
import { api } from './api';
import { dayLabel, formatNumber } from './format';
import { Badge, Card, EmptyState, Field, Icon, PageHeader } from './ui';

type Declared = {
  signals: number;
  total: number;
  byBot: Array<{ botId: string | null; botKey: string; signals: number; total: number }>;
  byDay: Array<{ day: string; total: number }>;
};

type Tab = 'declared' | 'csv';
const TAB_KEY = 'bc-usage-tab';

const FIELDS: Array<{ key: keyof Omit<ColumnMapping, 'dateOrder'>; label: string }> = [
  { key: 'date', label: 'Date' },
  { key: 'inputTokens', label: 'Jetons d’entrée' },
  { key: 'cacheTokens', label: 'Jetons de cache' },
  { key: 'outputTokens', label: 'Jetons de sortie' },
  { key: 'totalTokens', label: 'Total' },
  { key: 'cost', label: 'Coût' },
  { key: 'model', label: 'Modèle' },
  { key: 'kind', label: 'Type' },
  { key: 'automationId', label: 'Automation / agent' },
  { key: 'botKey', label: 'Identifiant de bot' },
];

type Preview = {
  stagingId: string;
  filename: string;
  headers: string[];
  mapping: ColumnMapping;
  errors: Array<{ line: number; message: string }>;
  warnings: string[];
  counts: { rows: number; included: number; skipped: number; inFileDuplicates: number };
  sample: Sample[];
};

type Sample = {
  line: number;
  day: string | null;
  totalTokens: number | null;
  costRaw: string;
  costValue: number | null;
  costKind: UsageRow['costKind'];
  model: string;
  messages: string[];
};

export function Usage({ data, tick }: { data: Workspace; tick: number }) {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [hot, setHot] = useState(false);
  const [filters, setFilters] = useState({ from: '', to: '', model: '', source: '', bot: '' });
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [declared, setDeclared] = useState<Declared | null>(null);
  const [tab, setTabState] = useState<Tab>(
    sessionStorage.getItem(TAB_KEY) === 'csv' ? 'csv' : 'declared',
  );
  function setTab(next: Tab) {
    sessionStorage.setItem(TAB_KEY, next);
    setTabState(next);
  }

  useEffect(() => {
    void api<Declared>('/api/usage/declared')
      .then(setDeclared)
      .catch(() => setDeclared({ signals: 0, total: 0, byBot: [], byDay: [] }));
  }, [tick]);

  async function load() {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
    const query = params.toString();
    const [nextSummary, nextRows] = await Promise.all([
      api<UsageSummary>(`/api/usage/summary${query ? `?${query}` : ''}`),
      api<UsageRow[]>(`/api/usage/rows${query ? `?${query}` : ''}`),
    ]);
    setSummary(nextSummary);
    setRows(nextRows);
  }

  useEffect(() => {
    void load().catch((caught) =>
      setError(caught instanceof Error ? caught.message : 'Lecture impossible.'),
    );
  }, [tick, filters.from, filters.to, filters.model, filters.source, filters.bot]);

  async function upload(file: File) {
    setBusy(true);
    setError('');
    try {
      const form = new FormData();
      form.set('file', file);
      const body = await api<Preview>('/api/usage/preview', { method: 'POST', body: form });
      setPreview(body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Import impossible.');
    } finally {
      setBusy(false);
    }
  }

  async function reinterpret() {
    if (!preview) return;
    setBusy(true);
    try {
      const body = await api<Preview>('/api/usage/interpret', {
        method: 'POST',
        body: JSON.stringify({ stagingId: preview.stagingId, mapping: preview.mapping }),
      });
      setPreview(body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Relecture impossible.');
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!preview) return;
    setBusy(true);
    try {
      await api('/api/usage/commit', {
        method: 'POST',
        body: JSON.stringify({ stagingId: preview.stagingId, mapping: preview.mapping }),
      });
      setPreview(null);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Enregistrement impossible.');
    } finally {
      setBusy(false);
    }
  }

  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
  const filtered = Object.values(filters).some(Boolean);
  const botName = (id: string | null, key: string) =>
    (id && data.bots.find((bot) => bot.id === id)?.name) || key;

  return (
    <div class="page">
      <PageHeader title="Usage" subtitle="Jetons déclarés par vos bots et relevés importés." />
      <div class="segmented wide" role="group" aria-label="Source de l’usage">
        <button type="button" aria-pressed={tab === 'declared'} onClick={() => setTab('declared')}>
          Déclaré par les bots
        </button>
        <button type="button" aria-pressed={tab === 'csv'} onClick={() => setTab('csv')}>
          Relevés CSV
        </button>
      </div>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}

      {tab === 'declared' &&
        (!declared ? (
          <div class="page-loading" aria-busy="true" />
        ) : declared.signals === 0 ? (
          <Card>
            <EmptyState icon="usage" title="Aucun jeton déclaré">
              Quand un bot ajoute un champ <code>tokens</code> à ses signaux (par exemple{' '}
              <code>{'{"total": 1200}'}</code>), le total apparaît ici. Ces chiffres sont
              auto-déclarés et ne sont jamais additionnés aux relevés CSV.
            </EmptyState>
          </Card>
        ) : (
          <>
            <div class="stat-grid">
              <article class="stat">
                <span>Jetons déclarés</span>
                <b>{formatNumber(declared.total)}</b>
                <small>Auto-déclaré, partiel</small>
              </article>
              <article class="stat">
                <span>Signaux avec jetons</span>
                <b>{formatNumber(declared.signals)}</b>
              </article>
            </div>
            <Card title="Par bot">
              <ul class="bar-list">
                {[...declared.byBot]
                  .sort((a, b) => b.total - a.total)
                  .map((entry) => (
                    <li key={entry.botKey}>
                      <div class="bar-list-head">
                        {entry.botId ? (
                          <a href={`#/bots/${entry.botId}`}>{botName(entry.botId, entry.botKey)}</a>
                        ) : (
                          <span>{entry.botKey}</span>
                        )}
                        <strong>{formatNumber(entry.total)}</strong>
                      </div>
                      <div class="bar-track" aria-hidden="true">
                        <span
                          style={`width:${declared.total ? Math.max(2, (entry.total / declared.total) * 100) : 0}%`}
                        />
                      </div>
                      <small class="muted">
                        {entry.signals} signal{entry.signals > 1 ? 'x' : ''}
                      </small>
                    </li>
                  ))}
              </ul>
            </Card>
            <Card title="Par jour (heure de Paris)">
              <DayChart days={declared.byDay.map((day) => ({ day: day.day, value: day.total }))} />
            </Card>
          </>
        ))}

      {tab === 'csv' && (
        <>
          <Card title="Importer un relevé">
            <p class="muted">
              Déposez l’export CSV de votre fournisseur. Aucun chiffre n’est inventé : « Included »
              ou « - » restent inconnus.
            </p>
            <div
              role="region"
              aria-label="Dépôt de fichier"
              class={`drop ${hot ? 'hot' : ''}`}
              onDragOver={(event) => {
                event.preventDefault();
                setHot(true);
              }}
              onDragLeave={() => setHot(false)}
              onDrop={(event) => {
                event.preventDefault();
                setHot(false);
                const file = event.dataTransfer?.files[0];
                if (file) void upload(file);
              }}
            >
              <p>{busy ? 'Lecture du fichier…' : 'CSV UTF-8, 5 Mo maximum.'}</p>
              <label class="btn primary">
                Choisir un fichier
                <input
                  type="file"
                  accept=".csv,text/csv,text/plain"
                  hidden
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    if (file) void upload(file);
                  }}
                />
              </label>
              <a class="link small" href="/api/fixtures/synthetique.csv">
                Fichier d’exemple
              </a>
            </div>
            {preview && (
              <div class="preview">
                <h3>{preview.filename}</h3>
                <p class="muted">
                  {preview.counts.included} ligne(s) retenue(s), {preview.counts.inFileDuplicates}{' '}
                  doublon(s), {preview.counts.skipped} ligne(s) vide(s).
                </p>
                {preview.warnings.map((warning) => (
                  <p key={warning} class="callout">
                    {warning}
                  </p>
                ))}
                {preview.errors.map((item) => (
                  <p key={`${item.line}-${item.message}`} class="error">
                    {item.message}
                  </p>
                ))}
                <details class="disclosure">
                  <summary>Associer les colonnes</summary>
                  <div class="form-grid">
                    <Field label="Ordre des dates">
                      <select
                        value={preview.mapping.dateOrder}
                        onChange={(event) =>
                          setPreview({
                            ...preview,
                            mapping: {
                              ...preview.mapping,
                              dateOrder: event.currentTarget.value === 'mdy' ? 'mdy' : 'dmy',
                            },
                          })
                        }
                      >
                        <option value="dmy">Jour/mois/année</option>
                        <option value="mdy">Mois/jour/année</option>
                      </select>
                    </Field>
                    {FIELDS.map((field) => (
                      <Field key={field.key} label={field.label}>
                        <select
                          value={preview.mapping[field.key] ?? ''}
                          onChange={(event) =>
                            setPreview({
                              ...preview,
                              mapping: {
                                ...preview.mapping,
                                [field.key]: event.currentTarget.value || null,
                              },
                            })
                          }
                        >
                          <option value="">— ignorer —</option>
                          {preview.headers.map((header) => (
                            <option key={header} value={header}>
                              {header}
                            </option>
                          ))}
                        </select>
                      </Field>
                    ))}
                  </div>
                  <button
                    class="btn sm"
                    type="button"
                    onClick={() => void reinterpret()}
                    disabled={busy}
                  >
                    Relire l’aperçu
                  </button>
                </details>
                <PreviewList sample={preview.sample} />
                <div class="row-actions">
                  <button class="btn ghost" type="button" onClick={() => setPreview(null)}>
                    Annuler
                  </button>
                  <button
                    class="btn primary"
                    type="button"
                    onClick={() => void commit()}
                    disabled={busy}
                  >
                    Importer les lignes
                  </button>
                </div>
              </div>
            )}
          </Card>

          <details class="disclosure filters-box" open={filtered}>
            <summary>
              <Icon name="search" size={16} /> Filtres{filtered ? ' (actifs)' : ''}
            </summary>
            <div class="form-grid">
              <Field label="Du">
                <input
                  type="date"
                  value={filters.from}
                  onInput={(event) => setFilters({ ...filters, from: event.currentTarget.value })}
                />
              </Field>
              <Field label="Au">
                <input
                  type="date"
                  value={filters.to}
                  onInput={(event) => setFilters({ ...filters, to: event.currentTarget.value })}
                />
              </Field>
              <Field label="Modèle">
                <select
                  value={filters.model}
                  onChange={(event) => setFilters({ ...filters, model: event.currentTarget.value })}
                >
                  <option value="">Tous</option>
                  {(summary?.models ?? []).map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Source">
                <select
                  value={filters.source}
                  onChange={(event) =>
                    setFilters({ ...filters, source: event.currentTarget.value })
                  }
                >
                  <option value="">Toutes</option>
                  <option value="csv">CSV</option>
                  {data.settings.demoMode && <option value="demo">Démo</option>}
                </select>
              </Field>
              <Field label="Fiche">
                <select
                  value={filters.bot}
                  onChange={(event) => setFilters({ ...filters, bot: event.currentTarget.value })}
                >
                  <option value="">Toutes</option>
                  <option value="unassigned">Non attribuées</option>
                  {data.bots
                    .filter((bot) => !bot.isDemo)
                    .map((bot) => (
                      <option key={bot.id} value={bot.id}>
                        {bot.name}
                      </option>
                    ))}
                </select>
              </Field>
            </div>
            <div class="row-actions">
              {filtered && (
                <button
                  class="btn ghost sm"
                  type="button"
                  onClick={() => setFilters({ from: '', to: '', model: '', source: '', bot: '' })}
                >
                  Réinitialiser
                </button>
              )}
              <a
                class="btn sm"
                href={`/api/usage/export.csv${query.toString() ? `?${query}` : ''}`}
              >
                Exporter en CSV
              </a>
            </div>
          </details>

          {!summary ? (
            <div class="page-loading" aria-busy="true" />
          ) : summary.totals.rows === 0 && !filtered ? (
            <Card>
              <EmptyState icon="usage" title="Aucun relevé importé">
                Importez un CSV ci-dessus pour voir vos jetons et coûts par jour.
              </EmptyState>
            </Card>
          ) : (
            <>
              {summary.warnings.map((warning) => (
                <p key={warning} class="callout">
                  {warning}
                </p>
              ))}
              <div class="stat-grid">
                <article class="stat">
                  <span>Lignes</span>
                  <b>{formatNumber(summary.totals.rows)}</b>
                </article>
                <article class="stat">
                  <span>Jetons</span>
                  <b>{formatNumber(summary.totals.totalTokens)}</b>
                  <small>Pas un quota</small>
                </article>
                <article class="stat">
                  <span>Coût chiffré</span>
                  <b>
                    {summary.totals.costNumericSum == null
                      ? '—'
                      : formatNumber(summary.totals.costNumericSum)}
                  </b>
                  <small>Hors « Included »</small>
                </article>
                <article class="stat">
                  <span>Non attribuées</span>
                  <b>{formatNumber(summary.totals.unassignedRows)}</b>
                </article>
              </div>
              <Card title="Jetons par jour">
                <DayChart
                  days={summary.byDay.map((day) => ({
                    day: day.day,
                    value: day.totalTokens,
                    partial: day.rowsWithTotal < day.rows,
                  }))}
                />
                <p class="muted small">Échelle racine pour garder les petits jours visibles.</p>
              </Card>
              {summary.insights.length > 0 && (
                <Card title="À noter">
                  <ul class="plain-list">
                    {summary.insights.map((insight) => (
                      <li key={insight.id}>
                        <strong>{insight.title}</strong>
                        <p class="muted small">{insight.detail}</p>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
              <Card title={`Lignes (${rows.length})`}>
                {rows.length === 0 ? (
                  <p class="muted">Aucune ligne pour ce filtre.</p>
                ) : (
                  <ul class="usage-rows">
                    {rows.map((row) => (
                      <li key={row.id} class="usage-row">
                        <div class="usage-row-top">
                          <strong>{row.day ? dayLabel(row.day) : 'Sans date'}</strong>
                          <span class="num">{formatNumber(row.totalTokens)}</span>
                        </div>
                        <div class="usage-row-meta">
                          <span>{row.model || 'Modèle inconnu'}</span>
                          <span>{costLabel(row)}</span>
                          {row.isDemo && <Badge tone="warn">Démo</Badge>}
                        </div>
                        {row.isDemo ? (
                          <small class="muted">{row.botName ?? 'Non attribuée'}</small>
                        ) : (
                          <select
                            aria-label="Attribuer à une fiche"
                            value={row.botId ?? ''}
                            onChange={(event) => {
                              const botId = event.currentTarget.value || null;
                              void api(`/api/usage/rows/${row.id}/assign`, {
                                method: 'POST',
                                body: JSON.stringify({
                                  botId,
                                  note: 'attribution depuis la liste',
                                }),
                              }).then(() => load());
                            }}
                          >
                            <option value="">
                              Non attribuée{row.reportedBotKey ? ` (${row.reportedBotKey})` : ''}
                            </option>
                            {data.bots
                              .filter((bot) => !bot.isDemo && !bot.archivedAt)
                              .map((bot) => (
                                <option key={bot.id} value={bot.id}>
                                  {bot.name}
                                </option>
                              ))}
                          </select>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </>
          )}
          {data.imports.length > 0 && (
            <Card title="Imports enregistrés">
              <ul class="plain-list">
                {data.imports.map((item) => (
                  <ImportRow
                    key={item.id}
                    item={item}
                    confirm={confirmId === item.id}
                    onAsk={() => setConfirmId(item.id)}
                    onCancel={() => setConfirmId(null)}
                    onDone={() => void load()}
                  />
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function costLabel(row: Pick<UsageRow, 'costKind' | 'costRaw' | 'costValue'>): string {
  if (row.costKind === 'included') return `Inclus · ${row.costRaw || 'Included'}`;
  if (row.costKind === 'numeric') return formatNumber(row.costValue);
  return row.costRaw ? `Inconnu · ${row.costRaw}` : 'Inconnu';
}

function DayChart({ days }: { days: Array<{ day: string; value: number; partial?: boolean }> }) {
  if (days.length === 0) return <p class="muted">Pas de jour observé.</p>;
  const shown = days.slice(-14);
  const max = Math.max(...shown.map((day) => day.value), 1);
  return (
    <div class="day-chart" role="img" aria-label="Jetons par jour, échelle racine">
      {shown.map((day) => {
        const share = day.value <= 0 ? 0 : Math.sqrt(day.value) / Math.sqrt(max);
        return (
          <div key={day.day} class="day-col" title={`${day.day} : ${formatNumber(day.value)}`}>
            <span class="day-val">{compact(day.value)}</span>
            <span class="day-bar-wrap">
              <span
                class={`day-bar ${day.partial ? 'partial' : ''}`}
                style={`height:${day.value <= 0 ? 2 : Math.max(6, share * 100)}%`}
              />
            </span>
            <span class="day-label">
              {day.day.slice(8)}/{day.day.slice(5, 7)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function compact(value: number): string {
  return new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 }).format(
    value,
  );
}

function PreviewList({ sample }: { sample: Preview['sample'] }) {
  if (sample.length === 0) return <p class="muted">Aucune ligne lisible avec ces colonnes.</p>;
  return (
    <ul class="usage-rows compact">
      {sample.slice(0, 8).map((row) => (
        <li key={row.line} class="usage-row">
          <div class="usage-row-top">
            <strong>
              Ligne {row.line} · {row.day ?? 'sans date'}
            </strong>
            <span class="num">{formatNumber(row.totalTokens)}</span>
          </div>
          <div class="usage-row-meta">
            <span>{row.model || 'Modèle inconnu'}</span>
            <span>{costLabel(row)}</span>
          </div>
          {row.messages.length > 0 && <small class="muted">{row.messages.join(' ')}</small>}
        </li>
      ))}
    </ul>
  );
}

function ImportRow({
  item,
  confirm,
  onAsk,
  onCancel,
  onDone,
}: {
  item: UsageImport;
  confirm: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onDone: () => void;
}) {
  return (
    <li class="import-row">
      <div>
        <strong class="break">{item.filename}</strong>
        <small class="muted">
          {item.rowCount} ligne(s), {item.duplicateCount} doublon(s), {item.skippedCount} ignorée(s)
        </small>
      </div>
      {confirm ? (
        <div class="row-actions">
          <button class="btn sm ghost" type="button" onClick={onCancel}>
            Annuler
          </button>
          <button
            class="btn danger sm"
            type="button"
            onClick={() =>
              void api(`/api/usage/imports/${item.id}`, { method: 'DELETE' }).then(() => {
                onCancel();
                onDone();
              })
            }
          >
            Supprimer
          </button>
        </div>
      ) : (
        <button class="btn sm danger-ghost" type="button" onClick={onAsk}>
          Supprimer
        </button>
      )}
    </li>
  );
}
