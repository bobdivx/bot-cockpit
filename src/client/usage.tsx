import { useEffect, useState } from 'preact/hooks';
import type {
  ColumnMapping,
  UsageImport,
  UsageRow,
  UsageSummary,
  Workspace,
} from '../shared/types';
import { api } from './api';
import { formatNumber } from './format';
import { Badge, Field } from './ui';

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

  return (
    <div class="stack">
      {error && <div class="error">{error}</div>}
      <section class="panel">
        <p class="kicker">Usage observé</p>
        <h2>Imports CSV</h2>
        <p class="meta">
          Aucun chiffre n’est inventé. Les colonnes varient : associez-les avant l’enregistrement.
          Included et « - » restent inconnus, ils ne valent pas zéro.
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
          <p>{busy ? 'Lecture du fichier…' : 'Déposez un CSV UTF-8, 5 Mo maximum.'}</p>
          <label class="btn" style="margin-top:10px">
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
          <p>
            <a href="/api/fixtures/synthetique.csv">Télécharger la fixture synthétique</a>
          </p>
        </div>
        {preview && (
          <div class="stack">
            <h3>{preview.filename}</h3>
            <p class="meta">
              {preview.counts.included} ligne(s) retenues, {preview.counts.inFileDuplicates}{' '}
              doublon(s) dans le fichier, {preview.counts.skipped} ligne(s) vides.
            </p>
            {preview.warnings.map((warning) => (
              <p key={warning} class="note">
                {warning}
              </p>
            ))}
            {preview.errors.map((item) => (
              <p key={`${item.line}-${item.message}`} class="error">
                {item.message}
              </p>
            ))}
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
            <div class="filters">
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
            <div class="btn-row">
              <button class="btn" type="button" onClick={() => void reinterpret()} disabled={busy}>
                Relire l’aperçu
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
            <PreviewTable sample={preview.sample} />
          </div>
        )}
      </section>
      <section class="panel">
        <div class="filters">
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
              onChange={(event) => setFilters({ ...filters, source: event.currentTarget.value })}
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
        <a class="btn small" href={`/api/usage/export.csv${query.toString() ? `?${query}` : ''}`}>
          Exporter ce filtre
        </a>
        {!summary ? (
          <p class="meta">Calcul des lignes observées…</p>
        ) : (
          <>
            {summary.warnings.map((warning) => (
              <p key={warning} class="note">
                {warning}
              </p>
            ))}
            <div class="stat-grid">
              <article class="panel stat">
                <span>Lignes</span>
                <b>{formatNumber(summary.totals.rows)}</b>
              </article>
              <article class="panel stat">
                <span>Jetons totaux présents</span>
                <b>{formatNumber(summary.totals.totalTokens)}</b>
                <small>Pas un quota</small>
              </article>
              <article class="panel stat">
                <span>Coût numérique</span>
                <b>
                  {summary.totals.costNumericSum == null
                    ? 'Non chiffré'
                    : formatNumber(summary.totals.costNumericSum)}
                </b>
                <small>Hors Included et hors texte</small>
              </article>
              <article class="panel stat">
                <span>Non attribuées</span>
                <b>{formatNumber(summary.totals.unassignedRows)}</b>
              </article>
            </div>
            <DayChart days={summary.byDay} />
            <p class="meta">
              Hauteur en racine du total observé, pour que les petits jours restent visibles. Ce
              n’est pas un quota.
            </p>
            <div class="table-wrap">
              <table>
                <caption class="meta">
                  Mêmes jours que le graphique, en calendrier du fichier.
                </caption>
                <thead>
                  <tr>
                    <th>Jour</th>
                    <th>Lignes</th>
                    <th>Total de jetons</th>
                    <th>Coût numérique</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.byDay.map((day) => (
                    <tr key={day.day}>
                      <td>{day.day}</td>
                      <td>{day.rows}</td>
                      <td>{formatNumber(day.rowsWithTotal ? day.totalTokens : null)}</td>
                      <td>
                        {day.costNumericSum == null
                          ? 'Non chiffré'
                          : formatNumber(day.costNumericSum)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {summary.insights.map((insight) => (
              <article key={insight.id} class="insight">
                <h3>{insight.title}</h3>
                <p>{insight.detail}</p>
                <p class="rule">Règle : {insight.rule}</p>
              </article>
            ))}
          </>
        )}
      </section>
      <section class="panel">
        <h2>Lignes</h2>
        <div class="table-wrap table-desktop">
          <table>
            <thead>
              <tr>
                <th>Jour</th>
                <th>Total</th>
                <th>Coût</th>
                <th>Modèle</th>
                <th>Source</th>
                <th>Fiche</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.day ?? 'Sans date'}</td>
                  <td>{formatNumber(row.totalTokens)}</td>
                  <td>{costLabel(row)}</td>
                  <td>{row.model || '—'}</td>
                  <td>
                    <Badge tone={row.isDemo ? 'demo' : 'neutral'}>
                      {row.source === 'demo' ? 'Démo' : 'CSV'}
                    </Badge>
                  </td>
                  <td>
                    {row.isDemo ? (
                      (row.botName ?? 'Non attribuée')
                    ) : (
                      <select
                        value={row.botId ?? ''}
                        onChange={(event) => {
                          const botId = event.currentTarget.value || null;
                          void api(`/api/usage/rows/${row.id}/assign`, {
                            method: 'POST',
                            body: JSON.stringify({ botId, note: 'attribution depuis le tableau' }),
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
                    {row.assignmentProvenance && <div class="meta">{row.assignmentProvenance}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && <p class="meta">Aucune ligne pour ce filtre.</p>}
      </section>
      <section class="panel">
        <h2>Imports enregistrés</h2>
        {data.imports.length === 0 && <p class="meta">Aucun import conservé.</p>}
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
      </section>
    </div>
  );
}

function costLabel(row: Pick<UsageRow, 'costKind' | 'costRaw' | 'costValue'>): string {
  if (row.costKind === 'included') return `Inclus · ${row.costRaw || 'Included'}`;
  if (row.costKind === 'numeric') return formatNumber(row.costValue);
  return row.costRaw ? `Inconnu · ${row.costRaw}` : 'Inconnu';
}

function DayChart({ days }: { days: UsageSummary['byDay'] }) {
  if (days.length === 0) return <p class="meta">Pas de jour observé sur ce filtre.</p>;
  const width = 680;
  const height = 200;
  const max = Math.max(...days.map((day) => day.totalTokens), 1);
  const gap = 16;
  const bar = Math.min(72, Math.max(18, (width - gap * days.length) / days.length));
  const plot = height - 36;
  return (
    <svg
      class="chart"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Jetons totaux observés par jour, échelle racine"
    >
      {days.map((day, index) => {
        const share = day.totalTokens <= 0 ? 0 : Math.sqrt(day.totalTokens) / Math.sqrt(max);
        const h = day.totalTokens <= 0 ? 3 : Math.max(12, share * plot);
        const partial = day.rowsWithTotal < day.rows;
        const x = 8 + index * (bar + gap);
        return (
          <g key={day.day}>
            <rect
              class={partial ? 'bar partial' : 'bar'}
              x={x}
              y={height - 28 - h}
              width={bar}
              height={h}
              rx={Math.min(4, h / 2)}
            />
            <text x={x} y={height - 8} fontSize="11">
              {day.day.slice(5)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function PreviewTable({ sample }: { sample: Preview['sample'] }) {
  if (sample.length === 0) return <p class="meta">Aucune ligne lisible avec ce mapping.</p>;
  return (
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Ligne</th>
            <th>Jour</th>
            <th>Total</th>
            <th>Coût</th>
            <th>Modèle</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {sample.map((row) => (
            <tr key={row.line}>
              <td>{row.line}</td>
              <td>{row.day ?? '—'}</td>
              <td>{formatNumber(row.totalTokens)}</td>
              <td>{costLabel(row)}</td>
              <td>{row.model || '—'}</td>
              <td>{row.messages.join(' ') || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
    <article class="insight">
      <strong>{item.filename}</strong>
      <p class="meta">
        {item.rowCount} ligne(s), {item.duplicateCount} doublon(s), {item.skippedCount} ignorée(s).
      </p>
      {confirm ? (
        <div class="btn-row">
          <button
            class="btn danger small"
            type="button"
            onClick={() =>
              void api(`/api/usage/imports/${item.id}`, { method: 'DELETE' }).then(() => {
                onCancel();
                onDone();
              })
            }
          >
            Confirmer la suppression
          </button>
          <button class="btn small" type="button" onClick={onCancel}>
            Annuler
          </button>
        </div>
      ) : (
        <button class="btn small" type="button" onClick={onAsk}>
          Supprimer cet import
        </button>
      )}
    </article>
  );
}
