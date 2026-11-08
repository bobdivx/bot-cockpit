import { useEffect, useState } from 'preact/hooks';
import type { WebhookCall, Workspace } from '../shared/types';
import { api } from './api';
import { Badge, Field } from './ui';

export function Actions({ data }: { data: Workspace }) {
  const [calls, setCalls] = useState<WebhookCall[]>([]);
  const [note, setNote] = useState('');
  const [confirm, setConfirm] = useState('');
  const [botId, setBotId] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<WebhookCall | null>(null);

  async function load() {
    const body = await api<{ calls: WebhookCall[]; note: string }>('/api/webhooks');
    setCalls(body.calls);
    setNote(body.note);
  }

  useEffect(() => {
    void load().catch((caught) =>
      setError(caught instanceof Error ? caught.message : 'Lecture impossible.'),
    );
  }, [data.webhookActions.join('|')]);

  return (
    <section class="panel">
      <p class="kicker">Demandes</p>
      <h2>Actions configurées</h2>
      <p class="meta">
        Seules les actions nommées dans la configuration du serveur peuvent être appelées. Il n’y a
        pas de champ d’URL, pas d’arrêt forcé et pas de suppression distante. Une réponse positive
        reste « Demandé / en attente ».
      </p>
      {error && <div class="error">{error}</div>}
      {note && <div class="note">{note}</div>}
      {data.webhookActions.length === 0 && (
        <p class="meta">
          Aucune allowlist n’est définie (BOT_COCKPIT_WEBHOOKS). Le contrôle distant est donc
          désactivé.
        </p>
      )}
      {data.webhookActions.map((name) => (
        <form
          key={name}
          class="stack"
          onSubmit={(event) => {
            event.preventDefault();
            setError('');
            setResult(null);
            void api<WebhookCall>(`/api/webhooks/${name}`, {
              method: 'POST',
              body: JSON.stringify({ confirm, botId: botId || null }),
            })
              .then((body) => {
                setResult(body);
                setConfirm('');
                return load();
              })
              .catch(async (caught) => {
                setError(caught instanceof Error ? caught.message : 'Demande impossible.');
                await load().catch(() => undefined);
              });
          }}
        >
          <h3>{name}</h3>
          <Field label="Fiche concernée, facultative">
            <select value={botId} onChange={(event) => setBotId(event.currentTarget.value)}>
              <option value="">Aucune</option>
              {data.bots
                .filter((bot) => !bot.isDemo)
                .map((bot) => (
                  <option key={bot.id} value={bot.id}>
                    {bot.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Confirmation : saisir DEMANDER">
            <input
              value={confirm}
              onInput={(event) => setConfirm(event.currentTarget.value)}
              autoComplete="off"
            />
          </Field>
          <button class="btn primary" type="submit">
            Envoyer la demande
          </button>
        </form>
      ))}
      {result && (
        <p class="note">
          <Badge tone={result.status === 'requested' ? 'warn' : 'danger'}>
            {result.status === 'requested'
              ? 'Demandé / en attente'
              : result.status === 'blocked'
                ? 'Bloqué'
                : 'Échec'}
          </Badge>{' '}
          {result.detail}
        </p>
      )}
      <h3>Journal</h3>
      {calls.length === 0 && <p class="meta">Aucune demande envoyée.</p>}
      {calls.map((call) => (
        <article key={call.id} class="insight">
          <strong>{call.actionName}</strong>{' '}
          <Badge tone={call.status === 'requested' ? 'warn' : 'danger'}>
            {call.status === 'requested'
              ? 'Demandé / en attente'
              : call.status === 'blocked'
                ? 'Bloqué'
                : 'Échec'}
          </Badge>
          <p class="meta">{call.detail}</p>
        </article>
      ))}
    </section>
  );
}
