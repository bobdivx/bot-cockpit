import { useEffect, useState } from 'preact/hooks';
import type { Signal, Workspace } from '../shared/types';
import { api } from './api';
import { Feed, fromSignal } from './feed';
import { Card, EmptyState, PageHeader } from './ui';

type Kind = 'all' | 'status' | 'event' | 'orphan';

export function Activity({ data, tick }: { data: Workspace; tick: number }) {
  const [events, setEvents] = useState<Signal[] | null>(null);
  const [bot, setBot] = useState('');
  const [kind, setKind] = useState<Kind>('all');
  const [error, setError] = useState('');

  useEffect(() => {
    const params = new URLSearchParams({ limit: '200' });
    if (bot) params.set('bot', bot);
    void api<Signal[]>(`/api/events?${params}`)
      .then((list) => {
        setEvents(list);
        setError('');
      })
      .catch((caught) =>
        setError(caught instanceof Error ? caught.message : 'Lecture impossible.'),
      );
  }, [tick, bot]);

  const visible = (events ?? []).filter((signal) =>
    kind === 'all' ? true : kind === 'orphan' ? !signal.botId : signal.kind === kind,
  );
  const kinds: Array<{ id: Kind; label: string }> = [
    { id: 'all', label: 'Tout' },
    { id: 'status', label: 'Statuts' },
    { id: 'event', label: 'Événements' },
    { id: 'orphan', label: 'Sans fiche' },
  ];
  const bots = data.bots.filter((item) => !item.isDemo || data.settings.demoMode);

  return (
    <div class="page narrow">
      <PageHeader title="Activité" subtitle="Tout ce que vos bots ont signalé, heure de Paris." />
      <div class="list-tools">
        <div class="chips" role="group" aria-label="Type de signal">
          {kinds.map((item) => (
            <button
              key={item.id}
              type="button"
              class="chip"
              aria-pressed={kind === item.id}
              onClick={() => setKind(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        {bots.length > 0 && (
          <select
            class="select-compact"
            aria-label="Filtrer par bot"
            value={bot}
            onChange={(event) => setBot(event.currentTarget.value)}
          >
            <option value="">Tous les bots</option>
            {bots.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      {!events ? (
        <div class="page-loading" aria-busy="true" />
      ) : (
        <Card class="flush-feed">
          <Feed
            items={visible.map(fromSignal)}
            bots={data.bots}
            empty={
              <EmptyState
                icon="activity"
                title={
                  events.length === 0 ? 'Aucune activité pour l’instant' : 'Rien pour ce filtre'
                }
                action={
                  events.length === 0 ? (
                    <a class="btn" href="#/reglages">
                      Relier un bot
                    </a>
                  ) : undefined
                }
              >
                {events.length === 0
                  ? 'Les statuts et événements envoyés par vos bots s’afficheront ici, jour par jour.'
                  : 'Essayez un autre filtre.'}
              </EmptyState>
            }
          />
        </Card>
      )}
    </div>
  );
}
