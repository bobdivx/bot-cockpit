import { useState } from 'preact/hooks';
import type { AccessToken } from '../shared/types';
import { api } from './api';
import { Badge, Field } from './ui';

export function Links({ tokens, reload }: { tokens: AccessToken[]; reload: () => Promise<void> }) {
  const [label, setLabel] = useState('Signalement atelier');
  const [fresh, setFresh] = useState<string | null>(null);
  const [error, setError] = useState('');
  const origin = window.location.origin;
  const snippet = `# Signalement volontaire vers Bot Cockpit
# Texte à copier plus tard. Rien n’est installé dans un compte.

URL MCP : ${origin}/mcp
En-tête : Authorization: Bearer <jeton affiché une seule fois>
Ne placez pas le jeton dans l’URL.

Outils :
- report_status : bot_id, status, note, source, occurred_at
- report_event : bot_id, name, detail, source, occurred_at, tokens

Un signal reçu est un auto-signalement partiel.
Les jetons déclarés ne sont pas additionnés aux CSV et ne mesurent pas un quota.
Ce serveur n’est pas une console de compte.`;

  return (
    <section class="panel">
      <p class="kicker">Liens</p>
      <h2>Signalements volontaires</h2>
      <p class="meta">
        Bot Cockpit n’est pas connecté à un compte. Aucun mot de passe ni cookie de bot n’est
        demandé. Un bot peut, plus tard, appeler cette URL MCP si vous le configurez vous-même.
      </p>
      {error && <div class="error">{error}</div>}
      <form
        class="stack"
        onSubmit={(event) => {
          event.preventDefault();
          setError('');
          void api<{ token: string }>('/api/tokens', {
            method: 'POST',
            body: JSON.stringify({ label }),
          })
            .then((body) => {
              setFresh(body.token);
              return reload();
            })
            .catch((caught) =>
              setError(caught instanceof Error ? caught.message : 'Création impossible.'),
            );
        }}
      >
        <Field label="Libellé du jeton">
          <input value={label} onInput={(event) => setLabel(event.currentTarget.value)} required />
        </Field>
        <button class="btn primary" type="submit">
          Créer un jeton
        </button>
      </form>
      {fresh && (
        <div class="note">
          <strong>Copiez ce jeton maintenant. Il ne sera plus affiché.</strong>
          <p class="token-once">{fresh}</p>
          <div class="btn-row">
            <button
              class="btn small"
              type="button"
              onClick={() => void navigator.clipboard.writeText(fresh)}
            >
              Copier
            </button>
            <button class="btn small" type="button" onClick={() => setFresh(null)}>
              Masquer
            </button>
          </div>
        </div>
      )}
      {tokens.length === 0 && (
        <p class="meta">Aucun jeton. Sans jeton, l’endpoint MCP refuse les appels.</p>
      )}
      {tokens.map((token) => (
        <article key={token.id} class="insight">
          <strong>{token.label}</strong>{' '}
          <Badge tone={token.revokedAt ? 'danger' : 'pine'}>
            {token.revokedAt ? 'Révoqué' : token.hint + '…'}
          </Badge>
          <p class="meta">
            Créé le {token.createdAt.slice(0, 16).replace('T', ' ')}
            {token.lastUsedAt
              ? ` · dernier usage ${token.lastUsedAt.slice(0, 16).replace('T', ' ')}`
              : ' · jamais utilisé'}
          </p>
          {!token.revokedAt && (
            <button
              class="btn small danger"
              type="button"
              onClick={() =>
                void api(`/api/tokens/${token.id}/revoke`, { method: 'POST' }).then(() => reload())
              }
            >
              Révoquer
            </button>
          )}
        </article>
      ))}
      <h3>Mode d’emploi à copier</h3>
      <pre class="snippet">{snippet}</pre>
      <button class="btn" type="button" onClick={() => void navigator.clipboard.writeText(snippet)}>
        Copier le mode d’emploi
      </button>
    </section>
  );
}
