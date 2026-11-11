import { useEffect, useState } from 'preact/hooks';
import type { AuditEntry, OnboardingState, Workspace } from '../shared/types';
import { api } from './api';
import { Badge, Field } from './ui';

export function Settings({
  data,
  reload,
  onboarding,
  onOpenWizard,
}: {
  data: Workspace;
  reload: () => Promise<void>;
  onboarding: OnboardingState | null;
  onOpenWizard: () => void;
}) {
  const [retention, setRetention] = useState(String(data.settings.retentionDays));
  const [stale, setStale] = useState(String(data.settings.staleMinutes));
  const [confirm, setConfirm] = useState('');
  const [wipe, setWipe] = useState('');
  const [error, setError] = useState('');
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const theme = document.documentElement.dataset.theme ?? 'system';

  useEffect(() => {
    void api<AuditEntry[]>('/api/audit')
      .then(setAudit)
      .catch(() => setAudit([]));
  }, [data.settings.demoMode, data.bots.length, data.imports.length]);

  async function save(action: () => Promise<unknown>) {
    setError('');
    try {
      await action();
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Réglage impossible.');
    }
  }

  return (
    <>
      <section class="panel setup-card">
        <div class="topbar">
          <div>
            <p class="kicker">Connexion</p>
            <h2>Grok Bot</h2>
          </div>
          <Badge tone={onboarding?.configured ? 'pine' : 'warn'}>
            {onboarding?.configured ? 'Relié' : 'Non configuré'}
          </Badge>
        </div>
        <p class="meta">
          {onboarding?.configured && onboarding.lastCall
            ? `Dernier appel reçu le ${new Date(onboarding.lastCall.at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })} (jeton ${onboarding.lastCall.tokenHint}…).`
            : 'Aucun appel reçu de Grok Bot pour l’instant. L’assistant génère un jeton, le texte à coller et teste la connexion.'}
        </p>
        <div class="btn-row">
          <button class="btn primary" type="button" onClick={onOpenWizard}>
            Relancer l’assistant de configuration
          </button>
        </div>
      </section>
      <section class="panel">
        <p class="kicker">Réglages</p>
        <h2>Atelier local</h2>
        <p class="meta">Un seul propriétaire. Les données restent dans la base de ce serveur.</p>
        {error && <div class="error">{error}</div>}
        <div class="btn-row">
          <button class="btn small" type="button" onClick={() => setTheme('system')}>
            Thème du système{theme === 'system' ? ' · actif' : ''}
          </button>
          <button class="btn small" type="button" onClick={() => setTheme('light')}>
            Clair
          </button>
          <button class="btn small" type="button" onClick={() => setTheme('dark')}>
            Sombre
          </button>
          <button
            class="btn small"
            type="button"
            onClick={() => {
              const next = document.documentElement.dataset.motion === 'reduce' ? '' : 'reduce';
              if (next) document.documentElement.dataset.motion = next;
              else delete document.documentElement.dataset.motion;
              localStorage.setItem('cockpit-motion', next || 'full');
            }}
          >
            {document.documentElement.dataset.motion === 'reduce'
              ? 'Animations réduites'
              : 'Réduire les animations'}
          </button>
        </div>
        <form
          class="stack"
          onSubmit={(event) => {
            event.preventDefault();
            void save(() =>
              api('/api/settings', {
                method: 'PATCH',
                body: JSON.stringify({
                  retentionDays: Number(retention),
                  staleMinutes: Number(stale),
                }),
              }),
            );
          }}
        >
          <Field label="Signal ancien après (minutes)">
            <input
              value={stale}
              onInput={(event) => setStale(event.currentTarget.value)}
              inputMode="numeric"
            />
          </Field>
          <Field label="Conserver les lignes (jours, 0 = tout garder)">
            <input
              value={retention}
              onInput={(event) => setRetention(event.currentTarget.value)}
              inputMode="numeric"
            />
          </Field>
          <button class="btn" type="submit">
            Enregistrer
          </button>
        </form>
        <div class="note">
          <strong>Données de démonstration</strong>
          <p class="meta">
            Elles sont fictives, marquées comme telles, et disparaissent quand on les retire. Elles
            ne remplacent pas un export de compte.
          </p>
          <button
            class="btn"
            type="button"
            onClick={() =>
              void save(() =>
                api('/api/demo', {
                  method: 'POST',
                  body: JSON.stringify({ enabled: !data.settings.demoMode }),
                }),
              )
            }
          >
            {data.settings.demoMode
              ? 'Retirer les données de démonstration'
              : 'Activer les données de démonstration'}
          </button>
        </div>
        <form
          class="stack"
          onSubmit={(event) => {
            event.preventDefault();
            void save(() =>
              api('/api/usage/reset', { method: 'POST', body: JSON.stringify({ confirm }) }),
            ).then(() => setConfirm(''));
          }}
        >
          <Field label="Effacer les imports CSV : saisir EFFACER">
            <input
              value={confirm}
              onInput={(event) => setConfirm(event.currentTarget.value)}
              autoComplete="off"
            />
          </Field>
          <button class="btn danger" type="submit">
            Effacer les imports
          </button>
        </form>
        <form
          class="stack"
          onSubmit={(event) => {
            event.preventDefault();
            void save(() =>
              api('/api/reset', { method: 'POST', body: JSON.stringify({ confirm: wipe }) }),
            ).then(() => setWipe(''));
          }}
        >
          <Field label="Vider l’atelier sauf le compte et les jetons : saisir VIDER">
            <input
              value={wipe}
              onInput={(event) => setWipe(event.currentTarget.value)}
              autoComplete="off"
            />
          </Field>
          <button class="btn danger" type="submit">
            Remettre l’atelier à vide
          </button>
        </form>
        <h3>Journal local</h3>
        {audit.map((entry) => (
          <p key={entry.id} class="meta">
            {entry.createdAt.slice(0, 16).replace('T', ' ')} · {entry.action} · {entry.detail}
          </p>
        ))}
      </section>
    </>
  );
}

function setTheme(theme: 'system' | 'light' | 'dark') {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  localStorage.setItem('cockpit-theme', theme);
}
