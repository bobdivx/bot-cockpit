import { useEffect, useState } from 'preact/hooks';
import type {
  AccessToken,
  AuditEntry,
  OnboardingState,
  WebhookCall,
  Workspace,
} from '../shared/types';
import { api } from './api';
import { formatDateTime, formatWhen } from './format';
import { Badge, Card, Field, Icon, PageHeader } from './ui';

type Theme = 'system' | 'light' | 'dark';

export function Settings({
  data,
  email,
  tokens,
  onboarding,
  reload,
  onOpenWizard,
  onLogout,
  onDeleted,
}: {
  data: Workspace;
  email: string;
  tokens: AccessToken[];
  onboarding: OnboardingState | null;
  reload: () => Promise<void>;
  onOpenWizard: () => void;
  onLogout: () => void;
  onDeleted: () => void;
}) {
  return (
    <div class="page narrow">
      <PageHeader title="Réglages" subtitle="Connexion, jetons, affichage et compte." />
      <ConnectionSection onboarding={onboarding} onOpenWizard={onOpenWizard} />
      <TokensSection tokens={tokens} reload={reload} />
      <AppearanceSection />
      <DataSection data={data} reload={reload} />
      {data.webhookActions.length > 0 && <ActionsSection data={data} />}
      <AccountSection email={email} onLogout={onLogout} onDeleted={onDeleted} />
      <AuditSection data={data} />
    </div>
  );
}

function ConnectionSection({
  onboarding,
  onOpenWizard,
}: {
  onboarding: OnboardingState | null;
  onOpenWizard: () => void;
}) {
  const ok = Boolean(onboarding?.configured);
  return (
    <Card
      title="Connexion Grok Bot"
      action={<Badge tone={ok ? 'ok' : 'warn'}>{ok ? 'Relié' : 'Non configuré'}</Badge>}
    >
      <p class="muted">
        {ok && onboarding?.lastCall
          ? `Dernier appel reçu ${formatWhen(onboarding.lastCall.at)} (jeton ${onboarding.lastCall.tokenHint}…).`
          : 'Aucun appel reçu pour l’instant. L’assistant vous guide : texte à coller dans Grok Bot, jeton, puis test.'}
      </p>
      <div class="row-actions">
        <button class={`btn ${ok ? '' : 'primary'}`} type="button" onClick={onOpenWizard}>
          Relancer l’assistant
        </button>
      </div>
    </Card>
  );
}

function TokensSection({ tokens, reload }: { tokens: AccessToken[]; reload: () => Promise<void> }) {
  const [label, setLabel] = useState('');
  const [fresh, setFresh] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const origin = window.location.origin;
  const active = tokens.filter((token) => !token.revokedAt);
  const revoked = tokens.filter((token) => token.revokedAt);

  function copy(text: string, what: string) {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
    setCopied(what);
    window.setTimeout(() => setCopied(''), 1500);
  }

  return (
    <Card title="Jetons d’accès">
      <p class="muted">
        Un jeton permet à un bot d’envoyer ses signaux. Il n’est affiché qu’une fois ; révoquez-le
        s’il a fuité.
      </p>
      <dl class="facts compact">
        <div>
          <dt>API REST</dt>
          <dd>
            <code>POST {origin}/api/v1/report</code>
          </dd>
        </div>
        <div>
          <dt>MCP</dt>
          <dd>
            <code>{origin}/mcp</code>
          </dd>
        </div>
        <div class="wide">
          <dt>En-tête</dt>
          <dd>
            <code>Authorization: Bearer &lt;jeton&gt;</code>
          </dd>
        </div>
      </dl>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      {fresh && (
        <div class="callout">
          <strong>Copiez ce jeton maintenant, il ne sera plus affiché.</strong>
          <code class="token-once">{fresh}</code>
          <div class="row-actions">
            <button class="btn sm primary" type="button" onClick={() => copy(fresh, 'token')}>
              {copied === 'token' ? 'Copié' : 'Copier'}
            </button>
            <button class="btn sm ghost" type="button" onClick={() => setFresh(null)}>
              Masquer
            </button>
          </div>
        </div>
      )}
      <form
        class="inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          setError('');
          void api<{ token: string }>('/api/tokens', {
            method: 'POST',
            body: JSON.stringify({ label: label.trim() || 'Nouveau jeton' }),
          })
            .then((body) => {
              setFresh(body.token);
              setLabel('');
              return reload();
            })
            .catch((caught) =>
              setError(caught instanceof Error ? caught.message : 'Création impossible.'),
            );
        }}
      >
        <Field label="Libellé du nouveau jeton">
          <input
            value={label}
            placeholder="Par exemple « Grok Bot »"
            maxLength={80}
            onInput={(event) => setLabel(event.currentTarget.value)}
          />
        </Field>
        <button class="btn" type="submit">
          <Icon name="plus" size={18} />
          <span>Créer</span>
        </button>
      </form>
      {active.length === 0 ? (
        <p class="muted small">Aucun jeton actif : les bots ne peuvent pas vous écrire.</p>
      ) : (
        <ul class="token-list">
          {active.map((token) => (
            <li key={token.id}>
              <div>
                <strong>{token.label}</strong>
                <small class="muted">
                  <code>{token.hint}…</code> · créé {formatDateTime(token.createdAt)} ·{' '}
                  {token.lastUsedAt ? `utilisé ${formatWhen(token.lastUsedAt)}` : 'jamais utilisé'}
                </small>
              </div>
              <button
                class="btn sm danger-ghost"
                type="button"
                onClick={() => {
                  if (
                    !window.confirm(
                      `Révoquer « ${token.label} » ? Les bots qui l’utilisent seront refusés.`,
                    )
                  )
                    return;
                  void api(`/api/tokens/${token.id}/revoke`, { method: 'POST' }).then(() =>
                    reload(),
                  );
                }}
              >
                Révoquer
              </button>
            </li>
          ))}
        </ul>
      )}
      {revoked.length > 0 && (
        <details class="disclosure">
          <summary>
            {revoked.length} jeton{revoked.length > 1 ? 's' : ''} révoqué
            {revoked.length > 1 ? 's' : ''}
          </summary>
          <ul class="token-list">
            {revoked.map((token) => (
              <li key={token.id}>
                <div>
                  <strong>{token.label}</strong>
                  <small class="muted">
                    <code>{token.hint}…</code> · révoqué {formatDateTime(token.revokedAt)}
                  </small>
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

function AppearanceSection() {
  const [theme, setThemeState] = useState<Theme>(
    (document.documentElement.dataset.theme as Theme | undefined) ?? 'system',
  );
  const [reduced, setReduced] = useState(document.documentElement.dataset.motion === 'reduce');
  function choose(next: Theme) {
    if (next === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = next;
    localStorage.setItem('cockpit-theme', next);
    setThemeState(next);
  }
  return (
    <Card title="Affichage">
      <div class="setting-row">
        <span>Thème</span>
        <div class="segmented" role="group" aria-label="Thème">
          {(
            [
              ['system', 'Auto'],
              ['light', 'Clair'],
              ['dark', 'Sombre'],
            ] as Array<[Theme, string]>
          ).map(([id, label]) => (
            <button key={id} type="button" aria-pressed={theme === id} onClick={() => choose(id)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <label class="setting-row switch-row">
        <span>Réduire les animations</span>
        <input
          type="checkbox"
          class="switch"
          checked={reduced}
          onChange={(event) => {
            const on = event.currentTarget.checked;
            if (on) document.documentElement.dataset.motion = 'reduce';
            else delete document.documentElement.dataset.motion;
            localStorage.setItem('cockpit-motion', on ? 'reduce' : 'full');
            setReduced(on);
          }}
        />
      </label>
    </Card>
  );
}

function DataSection({ data, reload }: { data: Workspace; reload: () => Promise<void> }) {
  const [retention, setRetention] = useState(String(data.settings.retentionDays));
  const [stale, setStale] = useState(String(data.settings.staleMinutes));
  const [confirm, setConfirm] = useState('');
  const [wipe, setWipe] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  async function save(action: () => Promise<unknown>, done: string) {
    setError('');
    setSaved('');
    try {
      await action();
      await reload();
      setSaved(done);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Réglage impossible.');
    }
  }

  return (
    <Card title="Données">
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      {saved && (
        <p class="success" role="status">
          {saved}
        </p>
      )}
      <form
        class="form two"
        onSubmit={(event) => {
          event.preventDefault();
          void save(
            () =>
              api('/api/settings', {
                method: 'PATCH',
                body: JSON.stringify({
                  retentionDays: Number(retention),
                  staleMinutes: Number(stale),
                }),
              }),
            'Réglages enregistrés.',
          );
        }}
      >
        <Field label="Bot silencieux après (minutes)">
          <input
            value={stale}
            inputMode="numeric"
            onInput={(event) => setStale(event.currentTarget.value)}
          />
        </Field>
        <Field label="Conserver l’usage (jours, 0 = tout)">
          <input
            value={retention}
            inputMode="numeric"
            onInput={(event) => setRetention(event.currentTarget.value)}
          />
        </Field>
        <div class="form-actions">
          <button class="btn" type="submit">
            Enregistrer
          </button>
        </div>
      </form>

      <div class="setting-row">
        <span>
          Données de démonstration
          <small class="muted">Fiches et lignes fictives, marquées comme telles.</small>
        </span>
        <button
          class="btn sm"
          type="button"
          onClick={() =>
            void save(
              () =>
                api('/api/demo', {
                  method: 'POST',
                  body: JSON.stringify({ enabled: !data.settings.demoMode }),
                }),
              data.settings.demoMode ? 'Démonstration retirée.' : 'Démonstration activée.',
            )
          }
        >
          {data.settings.demoMode ? 'Retirer' : 'Activer'}
        </button>
      </div>

      <details class="disclosure danger-zone">
        <summary>Zone sensible</summary>
        <form
          class="inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save(
              () => api('/api/usage/reset', { method: 'POST', body: JSON.stringify({ confirm }) }),
              'Imports CSV effacés.',
            ).then(() => setConfirm(''));
          }}
        >
          <Field label="Effacer les imports CSV : saisir EFFACER">
            <input
              value={confirm}
              autoComplete="off"
              onInput={(event) => setConfirm(event.currentTarget.value)}
            />
          </Field>
          <button class="btn danger" type="submit" disabled={confirm !== 'EFFACER'}>
            Effacer
          </button>
        </form>
        <form
          class="inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save(
              () => api('/api/reset', { method: 'POST', body: JSON.stringify({ confirm: wipe }) }),
              'Espace vidé.',
            ).then(() => setWipe(''));
          }}
        >
          <Field label="Tout vider sauf le compte et les jetons : saisir VIDER">
            <input
              value={wipe}
              autoComplete="off"
              onInput={(event) => setWipe(event.currentTarget.value)}
            />
          </Field>
          <button class="btn danger" type="submit" disabled={wipe !== 'VIDER'}>
            Vider
          </button>
        </form>
      </details>
    </Card>
  );
}

function ActionsSection({ data }: { data: Workspace }) {
  const [calls, setCalls] = useState<WebhookCall[]>([]);
  const [confirm, setConfirm] = useState('');
  const [botId, setBotId] = useState('');
  const [message, setMessage] = useState('');

  async function load() {
    const body = await api<{ calls: WebhookCall[] }>('/api/webhooks');
    setCalls(body.calls);
  }
  useEffect(() => {
    void load().catch(() => undefined);
  }, [data.webhookActions.join('|')]);

  const label = (status: WebhookCall['status']) =>
    status === 'requested' ? 'Demandé / en attente' : status === 'blocked' ? 'Bloqué' : 'Échec';

  return (
    <Card title="Actions distantes">
      <p class="muted">
        Seules les actions déclarées sur le serveur peuvent être demandées. Une réponse positive
        reste « en attente ».
      </p>
      <Field label="Fiche concernée (facultative)">
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
          autoComplete="off"
          onInput={(event) => setConfirm(event.currentTarget.value)}
        />
      </Field>
      <div class="row-actions">
        {data.webhookActions.map((name) => (
          <button
            key={name}
            class="btn"
            type="button"
            onClick={() =>
              void api<WebhookCall>(`/api/webhooks/${name}`, {
                method: 'POST',
                body: JSON.stringify({ confirm, botId: botId || null }),
              })
                .then((call) => {
                  setMessage(`${name} : ${label(call.status)}`);
                  setConfirm('');
                  return load();
                })
                .catch((caught) =>
                  setMessage(caught instanceof Error ? caught.message : 'Demande impossible.'),
                )
            }
          >
            {name}
          </button>
        ))}
      </div>
      {message && <p class="muted">{message}</p>}
      {calls.length > 0 && (
        <ul class="plain-list">
          {calls.slice(0, 10).map((call) => (
            <li key={call.id}>
              <strong>{call.actionName}</strong> · {label(call.status)} ·{' '}
              {formatDateTime(call.createdAt)}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function AccountSection({
  email,
  onLogout,
  onDeleted,
}: {
  email: string;
  onLogout: () => void;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Card title="Compte">
      <div class="setting-row">
        <span>
          Connecté en tant que
          <small class="muted break">{email}</small>
        </span>
        <button class="btn sm" type="button" onClick={onLogout}>
          <Icon name="logout" size={18} />
          <span>Se déconnecter</span>
        </button>
      </div>
      {!open ? (
        <button class="btn danger-ghost sm" type="button" onClick={() => setOpen(true)}>
          Supprimer mon compte…
        </button>
      ) : (
        <form
          class="form callout danger"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError('');
            try {
              await api('/api/account/delete', {
                method: 'POST',
                body: JSON.stringify({ password, confirm }),
              });
              onDeleted();
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : 'Suppression impossible.');
            } finally {
              setBusy(false);
            }
          }}
        >
          <strong>Suppression définitive</strong>
          <p class="muted small">
            Fiches, signaux, usage et jetons sont effacés. Cette action est irréversible.
          </p>
          <Field label="Mot de passe">
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onInput={(event) => setPassword(event.currentTarget.value)}
            />
          </Field>
          <Field label="Saisir SUPPRIMER">
            <input
              autoComplete="off"
              required
              value={confirm}
              onInput={(event) => setConfirm(event.currentTarget.value)}
            />
          </Field>
          {error && (
            <p class="error" role="alert">
              {error}
            </p>
          )}
          <div class="row-actions">
            <button class="btn ghost" type="button" onClick={() => setOpen(false)}>
              Annuler
            </button>
            <button class="btn danger" type="submit" disabled={busy || confirm !== 'SUPPRIMER'}>
              Supprimer définitivement
            </button>
          </div>
        </form>
      )}
    </Card>
  );
}

function AuditSection({ data }: { data: Workspace }) {
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  useEffect(() => {
    void api<AuditEntry[]>('/api/audit')
      .then(setAudit)
      .catch(() => setAudit([]));
  }, [data.settings.demoMode, data.bots.length, data.imports.length]);
  if (audit.length === 0) return null;
  return (
    <Card>
      <details class="disclosure">
        <summary>Journal du compte ({audit.length})</summary>
        <ul class="plain-list audit">
          {audit.slice(0, 50).map((entry) => (
            <li key={entry.id}>
              <time>{formatDateTime(entry.createdAt)}</time>
              <span>
                <strong>{entry.action}</strong> {entry.detail}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </Card>
  );
}
