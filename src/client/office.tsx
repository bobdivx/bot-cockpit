import { useEffect, useState } from 'preact/hooks';
import type { Bot, BotStatus, PackSummary, RoomKind, Workspace } from '../shared/types';
import { ACCENTS } from '../shared/types';
import { api } from './api';
import { KIND_LABEL, STATUS_LABEL, signalLabel } from './format';
import { OrgTree } from './org';
import { OfficeScene } from './scene';
import { Badge, Empty, Field } from './ui';

const STATUSES: BotStatus[] = ['offline', 'idle', 'working', 'away', 'blocked'];
const KINDS: RoomKind[] = ['revue', 'atelier', 'salon', 'labo', 'diffusion'];

export function Office({
  data,
  reload,
  initialId = null,
}: {
  data: Workspace;
  reload: () => Promise<void>;
  initialId?: string | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(initialId);
  const [archived, setArchived] = useState(false);
  const [packs, setPacks] = useState<PackSummary[]>([]);
  const [error, setError] = useState('');
  const [view, setView] = useState<'bureau' | 'arbre'>('bureau');
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
  const unlinked = data.signals.filter((signal) => !signal.linked);

  useEffect(() => {
    void api<PackSummary[]>('/api/packs')
      .then(setPacks)
      .catch(() => setPacks([]));
  }, []);

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
    <div class="workspace">
      <section class="scene-card">
        <div class="chips" style="margin-bottom:8px">
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
        </div>
        {view === 'bureau' ? (
          <OfficeScene
            rooms={rooms}
            teams={data.teams}
            bots={bots}
            signals={data.signals}
            demo={data.settings.demoMode}
            selected={selectedId}
            onSelect={setSelectedId}
          />
        ) : (
          <OrgTree teams={activeTeams} bots={bots} onSelect={setSelectedId} />
        )}
        <div class="chips" style="margin-top:8px">
          {STATUSES.map((status) => (
            <Badge
              key={status}
              tone={status === 'blocked' ? 'danger' : status === 'working' ? 'pine' : 'neutral'}
            >
              {STATUS_LABEL[status]}
            </Badge>
          ))}
          <Badge tone="warn">Figé : signal ancien</Badge>
        </div>
      </section>
      <aside class="panel">
        {error && <div class="error">{error}</div>}
        {selected ? (
          <BotCard
            bot={selected}
            data={data}
            onClose={() => setSelectedId(null)}
            onChange={(action) => run(action)}
          />
        ) : (
          <>
            <div>
              <p class="kicker">Fiches</p>
              <h2>{bots.length === 0 ? 'L’atelier est vide' : 'Qui est dans la salle'}</h2>
              <p class="meta">
                Le mode réel ne crée aucune fiche tout seul. Une consigne d’équipe est un texte :
                l’appliquer ajoute des fiches manuelles, sans installer de bot et sans exécuter de
                code.
              </p>
            </div>
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
          </>
        )}
      </aside>
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
