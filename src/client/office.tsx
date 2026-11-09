import { useEffect, useRef, useState } from 'preact/hooks';
import type {
  Bot,
  BotStatus,
  PackSummary,
  Room,
  RoomKind,
  Signal,
  Team,
  UsageSummary,
  Workspace,
} from '../shared/types';
import { ACCENTS } from '../shared/types';
import { api } from './api';
import { formatNumber, KIND_LABEL, STATUS_LABEL, signalLabel } from './format';
import { OrgTree } from './org';
import { OfficeScene, type SceneApi } from './scene';
import { Badge, Empty, Field } from './ui';

const STATUSES: BotStatus[] = ['offline', 'idle', 'working', 'away', 'blocked'];
const KINDS: RoomKind[] = ['revue', 'atelier', 'salon', 'labo', 'diffusion'];

export function Office({
  data,
  reload,
  email,
  initialId = null,
}: {
  data: Workspace;
  reload: () => Promise<void>;
  email: string;
  initialId?: string | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(initialId);
  const [archived, setArchived] = useState(false);
  const [packs, setPacks] = useState<PackSummary[]>([]);
  const [error, setError] = useState('');
  const [view, setView] = useState<'bureau' | 'arbre'>('bureau');
  const [adder, setAdder] = useState(false);
  const scene = useRef<SceneApi | null>(null);
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [team, setTeam] = useState<{ name: string; mission: string; accent: string }>({
    name: '',
    mission: '',
    accent: ACCENTS[0],
  });
  const [bot, setBot] = useState({
    name: '',
    role: '',
    brief: '',
    teamId: '',
    roomId: '',
    externalKey: '',
    status: 'offline',
  });
  const [room, setRoom] = useState({ name: '', kind: 'atelier' as RoomKind, teamId: '' });
  const bots = data.bots.filter((item) => archived || !item.archivedAt);
  const activeTeams = data.teams.filter((item) => archived || !item.archivedAt);
  const rooms = data.rooms.filter(
    (item) => activeTeams.some((teamItem) => teamItem.id === item.teamId) || !item.teamId,
  );
  const selected = data.bots.find((item) => item.id === selectedId) ?? null;
  const selectedRoom = rooms.find((item) => item.id === selected?.roomId) ?? null;
  const roster = selectedRoom ? bots.filter((item) => item.roomId === selectedRoom.id) : bots;
  const unlinked = data.signals.filter((signal) => !signal.linked);

  useEffect(() => {
    void api<UsageSummary>('/api/usage/summary')
      .then(setSummary)
      .catch(() => setSummary(null));
  }, [data.imports.length, data.settings.demoMode]);

  useEffect(() => {
    void api<PackSummary[]>('/api/packs')
      .then(setPacks)
      .catch(() => setPacks([]));
  }, []);

  useEffect(() => {
    if (!adder) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAdder(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [adder]);

  async function run(action: () => Promise<unknown>) {
    setError('');
    try {
      await action();
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Action impossible.');
    }
  }

  return (
    <div class={`office-screen${selected ? ' has-selection' : ''}`}>
      {view === 'bureau' ? (
        <OfficeScene
          rooms={rooms}
          teams={data.teams}
          bots={bots}
          signals={data.signals}
          demo={data.settings.demoMode}
          selected={selectedId}
          onSelect={setSelectedId}
          onReady={(api) => {
            scene.current = api;
          }}
        />
      ) : (
        <OrgTree teams={activeTeams} bots={bots} onSelect={setSelectedId} />
      )}
      <div class="office-tools">
        <button
          class={view === 'bureau' ? 'btn small primary' : 'btn small'}
          type="button"
          onClick={() => setView('bureau')}
        >
          Bureau
        </button>
        <button
          class={view === 'arbre' ? 'btn small primary' : 'btn small'}
          type="button"
          onClick={() => setView('arbre')}
        >
          Arborescence
        </button>
        <button class="btn small" type="button" onClick={() => setAdder(true)}>
          Ajouter
        </button>
        {view === 'bureau' && (
          <>
            <button
              class="btn small"
              type="button"
              onClick={() => {
                setSelectedId(null);
                scene.current?.resetCamera();
              }}
            >
              Recadrer
            </button>
            <button class="btn small" type="button" onClick={() => scene.current?.enterSelected()}>
              Approcher
            </button>
          </>
        )}
      </div>
      {view === 'bureau' && (
        <FloorDock
          rooms={rooms}
          teams={data.teams}
          bots={bots}
          activeRoom={selected?.roomId ?? null}
          onOverview={() => {
            setSelectedId(null);
            scene.current?.resetCamera();
          }}
          onRoom={(id) => scene.current?.focusRoom(id)}
          onStatus={(id, status) =>
            void run(() =>
              api(`/api/bots/${id}/status`, {
                method: 'POST',
                body: JSON.stringify({ status, note: '' }),
              }),
            )
          }
        />
      )}
      {view === 'bureau' && <ActivityDock email={email} signals={data.signals} summary={summary} />}
      {view === 'bureau' && (
        <aside class="float-card" aria-label="Fiches du plateau">
          {error && <div class="error">{error}</div>}
          <p class="kicker">{selectedRoom ? selectedRoom.name : 'Plateau'}</p>
          <div class="roster">
            {roster.length === 0 && <p class="meta">Aucune fiche dans cette vue.</p>}
            {roster.map((bot) => {
              const team = data.teams.find((item) => item.id === bot.teamId);
              return (
                <button
                  key={bot.id}
                  type="button"
                  class={`roster-row ${selectedId === bot.id ? 'on' : ''}`}
                  style={`--team:${team?.accent ?? '#8eb7ff'}`}
                  onClick={() => setSelectedId(bot.id)}
                >
                  <i />
                  <span>
                    <b>{bot.name}</b>
                    <small>
                      {STATUS_LABEL[bot.status]} · {signalLabel(bot)}
                    </small>
                  </span>
                </button>
              );
            })}
          </div>
          <p class="meta">Progression : non disponible</p>
          {selected && (
            <details>
              <summary>Modifier la fiche</summary>
              <BotCard
                bot={selected}
                data={data}
                onClose={() => setSelectedId(null)}
                onChange={(action) => run(action)}
              />
            </details>
          )}
        </aside>
      )}
      {adder && (
        <div
          class="modal-back"
          onClick={() => setAdder(false)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setAdder(false);
          }}
        >
          <div
            class="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ajouter-title"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <div class="modal-head">
              <div>
                <p class="kicker">Fiches</p>
                <h2 id="ajouter-title">Ajouter</h2>
              </div>
              <button class="btn small" type="button" onClick={() => setAdder(false)}>
                Fermer
              </button>
            </div>
            {error && <div class="error">{error}</div>}
            <p class="meta">
              Le mode réel ne crée aucune fiche tout seul. Une consigne ajoute des fiches manuelles,
              sans installer de bot et sans exécuter de code.
            </p>
            {bots.length === 0 && (
              <Empty title="Aucune fiche">
                Ajoutez une équipe, une salle ou une fiche. Rien ici n’est un bot déjà en service.
              </Empty>
            )}
            <form
              class="stack"
              onSubmit={(event) => {
                event.preventDefault();
                void run(() =>
                  api('/api/teams', { method: 'POST', body: JSON.stringify(team) }).then(() =>
                    setTeam({ name: '', mission: '', accent: team.accent }),
                  ),
                );
              }}
            >
              <Field label="Nouvelle équipe">
                <input
                  value={team.name}
                  onInput={(event) => setTeam({ ...team, name: event.currentTarget.value })}
                  required
                />
              </Field>
              <Field label="Mission">
                <input
                  value={team.mission}
                  onInput={(event) => setTeam({ ...team, mission: event.currentTarget.value })}
                />
              </Field>
              <Field label="Couleur">
                <select
                  value={team.accent}
                  onChange={(event) => setTeam({ ...team, accent: event.currentTarget.value })}
                >
                  {ACCENTS.map((accent) => (
                    <option key={accent} value={accent}>
                      {accent}
                    </option>
                  ))}
                </select>
              </Field>
              <button class="btn primary" type="submit">
                Créer l’équipe
              </button>
            </form>
            <form
              class="stack"
              onSubmit={(event) => {
                event.preventDefault();
                void run(() =>
                  api('/api/rooms', {
                    method: 'POST',
                    body: JSON.stringify({ ...room, teamId: room.teamId || null }),
                  }).then(() => setRoom({ name: '', kind: room.kind, teamId: room.teamId })),
                );
              }}
            >
              <Field label="Nouvelle salle">
                <input
                  value={room.name}
                  onInput={(event) => setRoom({ ...room, name: event.currentTarget.value })}
                  required
                />
              </Field>
              <Field label="Type">
                <select
                  value={room.kind}
                  onChange={(event) =>
                    setRoom({ ...room, kind: event.currentTarget.value as RoomKind })
                  }
                >
                  {KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {KIND_LABEL[kind]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Équipe">
                <select
                  value={room.teamId}
                  onChange={(event) => setRoom({ ...room, teamId: event.currentTarget.value })}
                >
                  <option value="">Sans équipe</option>
                  {activeTeams.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </Field>
              <button class="btn" type="submit">
                Ajouter la salle
              </button>
            </form>
            <form
              class="stack"
              onSubmit={(event) => {
                event.preventDefault();
                void run(() =>
                  api('/api/bots', {
                    method: 'POST',
                    body: JSON.stringify({
                      ...bot,
                      teamId: bot.teamId || null,
                      roomId: bot.roomId || null,
                    }),
                  }).then(() => setBot({ ...bot, name: '', role: '', brief: '', externalKey: '' })),
                );
              }}
            >
              <Field label="Nouvelle fiche">
                <input
                  value={bot.name}
                  onInput={(event) => setBot({ ...bot, name: event.currentTarget.value })}
                  required
                />
              </Field>
              <Field label="Rôle">
                <input
                  value={bot.role}
                  onInput={(event) => setBot({ ...bot, role: event.currentTarget.value })}
                />
              </Field>
              <Field label="Identifiant signalé">
                <input
                  value={bot.externalKey}
                  placeholder="La valeur bot_id attendue"
                  onInput={(event) => setBot({ ...bot, externalKey: event.currentTarget.value })}
                />
              </Field>
              <Field label="Équipe">
                <select
                  value={bot.teamId}
                  onChange={(event) => setBot({ ...bot, teamId: event.currentTarget.value })}
                >
                  <option value="">Sans équipe</option>
                  {activeTeams.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Salle">
                <select
                  value={bot.roomId}
                  onChange={(event) => setBot({ ...bot, roomId: event.currentTarget.value })}
                >
                  <option value="">Hors plan</option>
                  {rooms.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </Field>
              <button class="btn primary" type="submit">
                Créer la fiche
              </button>
            </form>
            <div class="btn-row">
              <button
                class="btn small"
                type="button"
                onClick={() => setArchived((value) => !value)}
              >
                {archived ? 'Masquer les archives' : 'Voir les archives'}
              </button>
            </div>
            <div>
              <h3>Consignes d’équipe</h3>
              <p class="meta">Texte à copier. Le bouton crée seulement des fiches locales.</p>
              {packs.map((pack) => (
                <article key={pack.id} class="insight">
                  <h3>{pack.name}</h3>
                  <p class="meta">{pack.mission}</p>
                  <div class="btn-row">
                    <button
                      class="btn small"
                      type="button"
                      onClick={() =>
                        void run(() => api(`/api/packs/${pack.id}/apply`, { method: 'POST' }))
                      }
                    >
                      Créer les fiches
                    </button>
                    <a class="btn small" href={`/api/packs/${pack.id}/consigne.md`}>
                      Télécharger la consigne
                    </a>
                  </div>
                </article>
              ))}
            </div>
            {unlinked.length > 0 && (
              <div>
                <h3>Signaux sans fiche</h3>
                {unlinked.slice(0, 5).map((signal) => (
                  <article key={signal.id} class="insight">
                    <p>
                      <Badge tone="warn">MCP</Badge> {signal.reportedBotKey}
                    </p>
                    <p class="meta">{signal.detail || signal.name}</p>
                    <button
                      class="btn small"
                      type="button"
                      onClick={() =>
                        void run(() =>
                          api(`/api/events/${signal.id}/materialize`, {
                            method: 'POST',
                            body: JSON.stringify({ name: signal.reportedBotKey }),
                          }),
                        )
                      }
                    >
                      Créer une fiche pour cet identifiant
                    </button>
                  </article>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function FloorDock({
  rooms,
  teams,
  bots,
  activeRoom,
  onOverview,
  onRoom,
  onStatus,
}: {
  rooms: Room[];
  teams: Team[];
  bots: Bot[];
  activeRoom: string | null;
  onOverview: () => void;
  onRoom: (id: string) => void;
  onStatus: (id: string, status: BotStatus) => void;
}) {
  const waiting = bots.filter((bot) => bot.status === 'blocked' || (bot.stale && !bot.quiet));
  return (
    <aside class="dock-left" aria-label="Salles et attentes">
      <p class="kicker dock-title">Salles</p>
      <button class={`room ${activeRoom ? '' : 'on'}`} type="button" onClick={onOverview}>
        <b>Tout le plateau</b>
        <small>
          {rooms.length} salle{rooms.length > 1 ? 's' : ''}
        </small>
      </button>
      {rooms.map((room) => {
        const team = teams.find((item) => item.id === room.teamId);
        return (
          <button
            key={room.id}
            class={`room ${activeRoom === room.id ? 'on' : ''}`}
            type="button"
            style={`--team:${team?.accent ?? '#8eb7ff'}`}
            onClick={() => onRoom(room.id)}
          >
            <b>{room.name}</b>
            <small>{team?.name ?? 'Sans équipe'}</small>
          </button>
        );
      })}
      <p class="kicker dock-title">En attente de moi</p>
      {waiting.length === 0 && <p class="meta">Aucune fiche bloquée ni signal ancien.</p>}
      {waiting.map((bot) => {
        const team = teams.find((item) => item.id === bot.teamId);
        return (
          <div key={bot.id} class="wait-row" style={`--team:${team?.accent ?? '#ff8f8f'}`}>
            <i />
            <div>
              <b>{bot.name}</b>
              <small>
                {STATUS_LABEL[bot.status]} · {signalLabel(bot)}
              </small>
            </div>
            <div class="btn-row">
              <button
                class="btn small"
                type="button"
                disabled={bot.isDemo}
                onClick={() => onStatus(bot.id, 'idle')}
              >
                Disponible
              </button>
              <button
                class="btn small"
                type="button"
                disabled={bot.isDemo}
                onClick={() => onStatus(bot.id, 'working')}
              >
                Au travail
              </button>
            </div>
          </div>
        );
      })}
    </aside>
  );
}

function ActivityDock({
  email,
  signals,
  summary,
}: {
  email: string;
  signals: Signal[];
  summary: UsageSummary | null;
}) {
  const handle = email.split('@')[0] || 'atelier';
  const lines = [...signals].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, 6);
  const tokens = summary?.totals.totalTokens ?? null;
  return (
    <div class="dock-bottom">
      <section class="log-card" aria-label="Activité">
        <p class="kicker">Activité</p>
        <pre>
          {`~ /${handle} $`}
          {lines.length === 0
            ? '\naucun événement enregistré'
            : lines
                .map((signal) => {
                  const when = signal.occurredAt.slice(11, 16);
                  const who = signal.reportedBotKey || 'signal';
                  const text = (signal.detail || signal.name).replace(/\s+/g, ' ');
                  return `\n${when}  ${who}  ${text}`;
                })
                .join('')}
        </pre>
      </section>
      <section class="metric-card" aria-label="Usage importé">
        <p class="kicker">Usage importé</p>
        <strong>{tokens == null ? 'Non disponible' : formatNumber(tokens)}</strong>
        <p class="meta">
          {tokens == null
            ? 'Aucun total de jetons dans les CSV.'
            : 'Jetons des lignes importées. Ce n’est pas un quota.'}
        </p>
      </section>
    </div>
  );
}

function BotCard({
  bot,
  data,
  onClose,
  onChange,
}: {
  bot: Bot;
  data: Workspace;
  onClose: () => void;
  onChange: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [note, setNote] = useState(bot.statusNote);
  const [externalKey, setExternalKey] = useState(bot.externalKey);
  const [history, setHistory] = useState<
    Array<{ id: string; status: BotStatus; source: string; note: string; occurredAt: string }>
  >([]);
  useEffect(() => {
    void api<{ history: typeof history }>(`/api/bots/${bot.id}`)
      .then((body) => setHistory(body.history))
      .catch(() => setHistory([]));
  }, [bot.id, bot.updatedAt]);
  const team = data.teams.find((item) => item.id === bot.teamId);
  return (
    <div class="stack">
      <div class="btn-row">
        <button class="btn small" type="button" onClick={onClose}>
          Retour
        </button>
        {bot.isDemo && <Badge tone="demo">Démo</Badge>}
        {bot.origin.startsWith('pack:') && <Badge tone="neutral">Consigne</Badge>}
        {!bot.isDemo && !bot.origin.startsWith('pack:') && <Badge tone="neutral">Manuel</Badge>}
      </div>
      <h2>{bot.name}</h2>
      <p class="meta">
        {bot.role || 'Rôle non précisé'}
        {team ? ` · ${team.name}` : ''}
      </p>
      <p>
        <Badge
          tone={bot.stale && !bot.quiet ? 'warn' : bot.status === 'working' ? 'pine' : 'neutral'}
        >
          {STATUS_LABEL[bot.status]}
        </Badge>{' '}
        <Badge tone={bot.stale ? 'warn' : 'pine'}>{signalLabel(bot)}</Badge>
      </p>
      {bot.brief && <p class="meta">{bot.brief}</p>}
      <Field label="Identifiant signalé par le bot">
        <input value={externalKey} onInput={(event) => setExternalKey(event.currentTarget.value)} />
      </Field>
      <button
        class="btn"
        type="button"
        onClick={() =>
          void onChange(() =>
            api(`/api/bots/${bot.id}`, { method: 'PATCH', body: JSON.stringify({ externalKey }) }),
          )
        }
      >
        Enregistrer l’identifiant
      </button>
      <Field label="Note de statut">
        <input value={note} onInput={(event) => setNote(event.currentTarget.value)} />
      </Field>
      <div class="btn-row">
        {STATUSES.map((status) => (
          <button
            key={status}
            class={`btn small ${bot.status === status ? 'primary' : ''}`}
            type="button"
            disabled={bot.isDemo}
            onClick={() =>
              void onChange(() =>
                api(`/api/bots/${bot.id}/status`, {
                  method: 'POST',
                  body: JSON.stringify({ status, note }),
                }),
              )
            }
          >
            {STATUS_LABEL[status]}
          </button>
        ))}
      </div>
      {!bot.isDemo && (
        <button
          class="btn danger"
          type="button"
          onClick={() =>
            void onChange(() =>
              api(`/api/bots/${bot.id}/${bot.archivedAt ? 'restore' : 'archive'}`, {
                method: 'POST',
              }),
            )
          }
        >
          {bot.archivedAt ? 'Restaurer' : 'Archiver'}
        </button>
      )}
      <div>
        <h3>Historique</h3>
        {history.length === 0 && <p class="meta">Pas encore de changement.</p>}
        {history.map((entry) => (
          <p key={entry.id} class="meta">
            {STATUS_LABEL[entry.status]} · {entry.source === 'mcp' ? 'MCP' : 'Manuel'} ·{' '}
            {entry.note}
          </p>
        ))}
      </div>
    </div>
  );
}
