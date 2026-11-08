import { useMemo, useState } from 'preact/hooks';
import type { BotStatus, Workspace } from '../shared/types';
import { STATUS_LABEL, signalLabel } from './format';
import { Badge } from './ui';

export function ListView({ data, onOpen }: { data: Workspace; onOpen: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<BotStatus | 'all'>('all');
  const [archived, setArchived] = useState(false);
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return data.bots.filter((bot) => {
      if (!archived && bot.archivedAt) return false;
      if (status !== 'all' && bot.status !== status) return false;
      if (!needle) return true;
      const team = data.teams.find((item) => item.id === bot.teamId)?.name ?? '';
      return `${bot.name} ${bot.role} ${team} ${bot.externalKey}`.toLowerCase().includes(needle);
    });
  }, [data, query, status, archived]);

  return (
    <section class="panel">
      <div class="topbar">
        <div>
          <p class="kicker">Liste</p>
          <h2>Fiches compactes</h2>
        </div>
      </div>
      <div class="filters">
        <input
          placeholder="Nom, rôle, équipe, identifiant"
          value={query}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
        <select
          value={status}
          onChange={(event) => setStatus(event.currentTarget.value as BotStatus | 'all')}
        >
          <option value="all">Tous les statuts</option>
          {(Object.keys(STATUS_LABEL) as BotStatus[]).map((item) => (
            <option key={item} value={item}>
              {STATUS_LABEL[item]}
            </option>
          ))}
        </select>
        <button class="btn" type="button" onClick={() => setArchived((value) => !value)}>
          {archived ? 'Masquer les archives' : 'Inclure les archives'}
        </button>
      </div>
      {rows.length === 0 && (
        <p class="meta">Aucune fiche pour ce filtre. Le bureau permet d’en créer.</p>
      )}
      <div class="table-wrap table-desktop">
        <table>
          <thead>
            <tr>
              <th>Nom</th>
              <th>Rôle</th>
              <th>Équipe</th>
              <th>Statut</th>
              <th>Signal</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((bot) => {
              const team = data.teams.find((item) => item.id === bot.teamId);
              return (
                <tr key={bot.id}>
                  <td>
                    <button class="btn small" type="button" onClick={() => onOpen(bot.id)}>
                      {bot.name}
                    </button>
                  </td>
                  <td>{bot.role || '—'}</td>
                  <td>{team?.name ?? '—'}</td>
                  <td>{STATUS_LABEL[bot.status]}</td>
                  <td>
                    <Badge tone={bot.stale && !bot.quiet ? 'warn' : 'neutral'}>
                      {signalLabel(bot)}
                    </Badge>
                  </td>
                  <td>
                    {bot.isDemo ? 'Démo' : bot.origin.startsWith('pack:') ? 'Consigne' : 'Manuel'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div class="cards">
        {rows.map((bot) => (
          <article key={bot.id} class="panel bot-card">
            <strong>{bot.name}</strong>
            <span class="meta">{bot.role || 'Rôle non précisé'}</span>
            <Badge tone={bot.stale && !bot.quiet ? 'warn' : 'neutral'}>{signalLabel(bot)}</Badge>
            <button class="btn small" type="button" onClick={() => onOpen(bot.id)}>
              Ouvrir
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}
