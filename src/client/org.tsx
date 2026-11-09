import type { Bot, Team } from '../shared/types';
import { STATUS_LABEL, signalLabel } from './format';

export function OrgTree({
  teams,
  bots,
  onSelect,
}: {
  teams: Team[];
  bots: Bot[];
  onSelect: (id: string) => void;
}) {
  const loose = bots.filter((bot) => !teams.some((team) => team.id === bot.teamId));
  if (teams.length === 0 && bots.length === 0) {
    return (
      <div class="org">
        <p class="org-root">
          <span class="kicker">Atelier</span>
          <strong>Fiches</strong>
        </p>
        <p class="meta">Aucune fiche. L’arbre reste vide tant qu’une équipe n’est pas créée.</p>
      </div>
    );
  }
  return (
    <div class="org">
      <p class="org-root">
        <span class="kicker">Atelier</span>
        <strong>Fiches</strong>
      </p>
      <svg class="org-links" viewBox="0 0 1000 70" aria-hidden="true">
        {teams.map((team, index) => {
          const x = teams.length === 1 ? 500 : 80 + (index * 840) / Math.max(teams.length - 1, 1);
          return <path key={team.id} d={`M500 0 C500 36 ${x} 28 ${x} 70`} />;
        })}
      </svg>
      <div class="org-row">
        {teams.map((team) => {
          const members = bots.filter((bot) => bot.teamId === team.id);
          return (
            <section key={team.id} class="org-team" style={`--team:${team.accent}`}>
              <header>
                <strong>{team.name}</strong>
                <span>
                  {members.length} fiche{members.length > 1 ? 's' : ''}
                </span>
              </header>
              <div class="org-members">
                {members.map((bot) => (
                  <button
                    key={bot.id}
                    type="button"
                    class="org-bot"
                    onClick={() => onSelect(bot.id)}
                  >
                    <b>{bot.name}</b>
                    <small>{bot.role || 'Rôle non précisé'}</small>
                    <small>
                      {STATUS_LABEL[bot.status]} · {signalLabel(bot)}
                    </small>
                  </button>
                ))}
                {members.length === 0 && <p class="meta">Aucune fiche dans cette équipe.</p>}
              </div>
            </section>
          );
        })}
      </div>
      {loose.length > 0 && (
        <div class="org-row">
          {loose.map((bot) => (
            <button key={bot.id} type="button" class="org-bot" onClick={() => onSelect(bot.id)}>
              <b>{bot.name}</b>
              <small>Sans équipe · {signalLabel(bot)}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
