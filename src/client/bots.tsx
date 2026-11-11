import { useEffect, useState } from 'preact/hooks';
import type { Bot, BotStatus, HistoryEntry, Signal, Workspace } from '../shared/types';
import { api } from './api';
import { Feed, fromHistory, fromSignal } from './feed';
import { formatDateTime, STATUS_LABEL, STATUS_ORDER, signalLabel } from './format';
import { BotRow } from './home';
import { Avatar, Card, EmptyState, Field, Icon, PageHeader, Sheet, StatusPill } from './ui';

type Filter = 'all' | BotStatus | 'archived';

export function Bots({
  data,
  selectedId,
  reload,
  tick,
}: {
  data: Workspace;
  selectedId: string | null;
  reload: () => Promise<void>;
  tick: number;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [creating, setCreating] = useState(false);
  const selected = selectedId ? (data.bots.find((bot) => bot.id === selectedId) ?? null) : null;

  const active = data.bots.filter((bot) => !bot.archivedAt);
  const archived = data.bots.filter((bot) => bot.archivedAt);
  const needle = query.trim().toLowerCase();
  const visible = (filter === 'archived' ? archived : active)
    .filter((bot) => filter === 'all' || filter === 'archived' || bot.status === filter)
    .filter(
      (bot) =>
        !needle ||
        bot.name.toLowerCase().includes(needle) ||
        bot.externalKey.toLowerCase().includes(needle) ||
        bot.role.toLowerCase().includes(needle),
    )
    .sort(
      (a, b) =>
        STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
        a.name.localeCompare(b.name, 'fr'),
    );
  const chips: Array<{ id: Filter; label: string; count: number }> = [
    { id: 'all', label: 'Tous', count: active.length },
    ...STATUS_ORDER.map((status) => ({
      id: status as Filter,
      label: STATUS_LABEL[status],
      count: active.filter((bot) => bot.status === status).length,
    })).filter((chip) => chip.count > 0),
    ...(archived.length
      ? [{ id: 'archived' as Filter, label: 'Archivés', count: archived.length }]
      : []),
  ];

  return (
    <div class={`page split ${selectedId ? 'has-detail' : ''}`}>
      <div class="split-list">
        <PageHeader
          title="Bots"
          subtitle={`${active.length} fiche${active.length > 1 ? 's' : ''} active${active.length > 1 ? 's' : ''}`}
          actions={
            <button
              class="btn primary"
              type="button"
              aria-label="Nouvelle fiche"
              onClick={() => setCreating(true)}
            >
              <Icon name="plus" size={18} />
              <span>Nouvelle fiche</span>
            </button>
          }
        />
        {data.bots.length > 0 && (
          <div class="list-tools">
            <label class="search">
              <Icon name="search" size={18} />
              <input
                type="search"
                placeholder="Rechercher un bot"
                aria-label="Rechercher un bot"
                value={query}
                onInput={(event) => setQuery(event.currentTarget.value)}
              />
            </label>
            <div class="chips" role="group" aria-label="Filtrer par statut">
              {chips.map((chip) => (
                <button
                  key={chip.id}
                  type="button"
                  class="chip"
                  aria-pressed={filter === chip.id}
                  onClick={() => setFilter(chip.id)}
                >
                  {chip.label} <span class="chip-count">{chip.count}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {data.bots.length === 0 ? (
          <Card>
            <EmptyState
              icon="bots"
              title="Aucune fiche pour l’instant"
              action={
                <button class="btn primary" type="button" onClick={() => setCreating(true)}>
                  Créer une fiche
                </button>
              }
            >
              Un bot qui vous envoie un signal reçoit sa fiche automatiquement. Vous pouvez aussi en
              créer une à la main.
            </EmptyState>
          </Card>
        ) : visible.length === 0 ? (
          <p class="muted pad">Aucun bot ne correspond à ce filtre.</p>
        ) : (
          <div class="bot-list card flush">
            {visible.map((bot) => (
              <div key={bot.id} class={bot.id === selectedId ? 'is-selected' : ''}>
                <BotRow bot={bot} href={`#/bots/${bot.id}`} />
              </div>
            ))}
          </div>
        )}
      </div>

      <div class="split-detail">
        {selectedId && !selected && (
          <Card>
            <EmptyState
              icon="alert"
              title="Fiche introuvable"
              action={
                <a class="btn" href="#/bots">
                  Retour aux bots
                </a>
              }
            >
              Elle a peut-être été supprimée.
            </EmptyState>
          </Card>
        )}
        {selected && (
          <BotDetail key={selected.id} bot={selected} data={data} reload={reload} tick={tick} />
        )}
        {!selectedId && data.bots.length > 0 && (
          <div class="detail-placeholder">
            <EmptyState icon="bots" title="Choisissez un bot">
              Sa fiche et sa chronologie s’affichent ici.
            </EmptyState>
          </div>
        )}
      </div>

      {creating && (
        <CreateBotSheet
          onClose={() => setCreating(false)}
          onCreated={async (bot) => {
            setCreating(false);
            await reload();
            location.hash = `#/bots/${bot.id}`;
          }}
        />
      )}
    </div>
  );
}

function CreateBotSheet({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (bot: Bot) => Promise<void>;
}) {
  const [form, setForm] = useState({ name: '', role: '', externalKey: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: Event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const bot = await api<Bot>('/api/bots', { method: 'POST', body: JSON.stringify(form) });
      await onCreated(bot);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Création impossible.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet
      title="Nouvelle fiche"
      onClose={onClose}
      footer={
        <>
          <button class="btn ghost" type="button" onClick={onClose}>
            Annuler
          </button>
          <button class="btn primary" type="submit" form="create-bot" disabled={busy}>
            Créer
          </button>
        </>
      }
    >
      <form id="create-bot" class="form" onSubmit={submit}>
        <Field label="Nom">
          <input
            required
            maxLength={80}
            value={form.name}
            onInput={(event) => setForm({ ...form, name: event.currentTarget.value })}
          />
        </Field>
        <Field label="Rôle" hint="Facultatif, par exemple « Veille » ou « Support ».">
          <input
            maxLength={80}
            value={form.role}
            onInput={(event) => setForm({ ...form, role: event.currentTarget.value })}
          />
        </Field>
        <Field
          label="Identifiant bot_id"
          hint="Celui que le bot envoie dans ses signaux (ex. grok-bot). Facultatif."
        >
          <input
            maxLength={64}
            autoCapitalize="off"
            spellcheck={false}
            value={form.externalKey}
            onInput={(event) => setForm({ ...form, externalKey: event.currentTarget.value })}
          />
        </Field>
        {error && (
          <p class="error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Sheet>
  );
}

function BotDetail({
  bot,
  data,
  reload,
  tick,
}: {
  bot: Bot;
  data: Workspace;
  reload: () => Promise<void>;
  tick: number;
}) {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [events, setEvents] = useState<Signal[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  async function load() {
    try {
      const [detail, list] = await Promise.all([
        api<{ bot: Bot; history: HistoryEntry[] }>(`/api/bots/${bot.id}`),
        api<Signal[]>(`/api/events?bot=${encodeURIComponent(bot.id)}&limit=100`),
      ]);
      setHistory(detail.history);
      setEvents(list);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Chargement impossible.');
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    void load();
  }, [bot.id, tick, bot.updatedAt]);

  async function run(task: () => Promise<unknown>) {
    setError('');
    try {
      await task();
      await reload();
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Action impossible.');
    }
  }

  // Status signals already produce history rows (source mcp); keep only manual ones from history.
  const items = [
    ...events.map(fromSignal),
    ...history.filter((entry) => entry.source !== 'mcp').map(fromHistory),
  ];

  return (
    <div class="detail">
      <PageHeader title={bot.name} back={{ href: '#/bots', label: 'Bots' }} />
      <div class="detail-hero card">
        <Avatar name={bot.name} size={56} />
        <div class="detail-hero-main">
          <StatusPill status={bot.status} />
          <p class={bot.stale && !bot.quiet ? 'warn-text' : 'muted'}>{signalLabel(bot)}</p>
          {bot.statusNote && <p class="detail-note">« {bot.statusNote} »</p>}
        </div>
        <button class="btn ghost sm" type="button" onClick={() => setEditing(true)}>
          Modifier
        </button>
      </div>

      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}

      <Card title="Chronologie">
        {!loaded ? (
          <div class="page-loading small" aria-busy="true" />
        ) : (
          <Feed
            items={items}
            bots={data.bots}
            showBot={false}
            empty={
              <EmptyState icon="clock" title="Aucun événement">
                Les signaux de ce bot et vos changements de statut apparaîtront ici.
              </EmptyState>
            }
          />
        )}
      </Card>

      {!bot.archivedAt && (
        <Card title="Changer le statut">
          <div class="status-picker" role="group" aria-label="Statut">
            {STATUS_ORDER.map((status) => (
              <button
                key={status}
                type="button"
                class={`status-choice s-${status}`}
                aria-pressed={bot.status === status}
                onClick={() =>
                  void run(async () => {
                    await api(`/api/bots/${bot.id}/status`, {
                      method: 'POST',
                      body: JSON.stringify({ status, note }),
                    });
                    setNote('');
                  })
                }
              >
                <i aria-hidden="true" />
                {STATUS_LABEL[status]}
              </button>
            ))}
          </div>
          <Field label="Note (facultative)">
            <input
              maxLength={160}
              placeholder="Ajoutée au prochain changement"
              value={note}
              onInput={(event) => setNote(event.currentTarget.value)}
            />
          </Field>
        </Card>
      )}

      <Card title="Fiche">
        <dl class="facts">
          <div>
            <dt>bot_id</dt>
            <dd>
              <code>{bot.externalKey || 'non défini'}</code>
              <button
                class="icon-btn sm"
                type="button"
                aria-label="Copier le bot_id"
                onClick={async () => {
                  await navigator.clipboard?.writeText(bot.externalKey).catch(() => undefined);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                }}
              >
                <Icon name={copied ? 'check' : 'copy'} size={16} />
              </button>
            </dd>
          </div>
          {bot.role && (
            <div>
              <dt>Rôle</dt>
              <dd>{bot.role}</dd>
            </div>
          )}
          <div>
            <dt>Origine</dt>
            <dd>
              {bot.origin === 'auto'
                ? 'Créée au premier signal'
                : bot.origin === 'manual'
                  ? 'Créée à la main'
                  : bot.origin}
            </dd>
          </div>
          <div>
            <dt>Créée</dt>
            <dd>{formatDateTime(bot.createdAt)}</dd>
          </div>
          {bot.brief && (
            <div class="wide">
              <dt>Consigne</dt>
              <dd class="pre">{bot.brief}</dd>
            </div>
          )}
        </dl>
        <div class="row-actions">
          <button
            class="btn ghost sm"
            type="button"
            onClick={() =>
              void run(() =>
                api(`/api/bots/${bot.id}/${bot.archivedAt ? 'restore' : 'archive'}`, {
                  method: 'POST',
                }),
              )
            }
          >
            {bot.archivedAt ? 'Restaurer la fiche' : 'Archiver la fiche'}
          </button>
        </div>
      </Card>

      {editing && (
        <EditBotSheet
          bot={bot}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            await reload();
          }}
        />
      )}
    </div>
  );
}

function EditBotSheet({
  bot,
  onClose,
  onSaved,
}: {
  bot: Bot;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState({
    name: bot.name,
    role: bot.role,
    brief: bot.brief,
    externalKey: bot.externalKey,
  });
  const [error, setError] = useState('');
  async function submit(event: Event) {
    event.preventDefault();
    try {
      await api(`/api/bots/${bot.id}`, { method: 'PATCH', body: JSON.stringify(form) });
      await onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Enregistrement impossible.');
    }
  }
  return (
    <Sheet
      title="Modifier la fiche"
      onClose={onClose}
      footer={
        <>
          <button class="btn ghost" type="button" onClick={onClose}>
            Annuler
          </button>
          <button class="btn primary" type="submit" form="edit-bot">
            Enregistrer
          </button>
        </>
      }
    >
      <form id="edit-bot" class="form" onSubmit={submit}>
        <Field label="Nom">
          <input
            required
            maxLength={80}
            value={form.name}
            onInput={(event) => setForm({ ...form, name: event.currentTarget.value })}
          />
        </Field>
        <Field label="Rôle">
          <input
            maxLength={80}
            value={form.role}
            onInput={(event) => setForm({ ...form, role: event.currentTarget.value })}
          />
        </Field>
        <Field label="Identifiant bot_id" hint="Doit correspondre à ce que le bot envoie.">
          <input
            maxLength={64}
            autoCapitalize="off"
            spellcheck={false}
            value={form.externalKey}
            onInput={(event) => setForm({ ...form, externalKey: event.currentTarget.value })}
          />
        </Field>
        <Field label="Consigne">
          <textarea
            rows={4}
            maxLength={2000}
            value={form.brief}
            onInput={(event) => setForm({ ...form, brief: event.currentTarget.value })}
          />
        </Field>
        {error && (
          <p class="error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Sheet>
  );
}
