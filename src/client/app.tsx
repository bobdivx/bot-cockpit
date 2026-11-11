import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { ApiError, api } from './api';
import { Shell, WIZARD_SEEN } from './shell';
import { Brand, Field } from './ui';

type Boot = {
  needsSetup: boolean;
  allowSignup?: boolean;
  setupRequiresToken: boolean;
  openSetup: boolean;
  ephemeralStorage?: boolean;
};

export function App() {
  const [boot, setBoot] = useState<Boot | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [justSignedUp, setJustSignedUp] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setLoading(true);
    setError('');
    try {
      const status = await api<Boot>('/api/bootstrap');
      setBoot(status);
      try {
        const me = await api<{ email: string }>('/api/me');
        setEmail(me.email);
      } catch (caught) {
        if (caught instanceof ApiError && caught.status === 401) setEmail(null);
        else throw caught;
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Le serveur ne répond pas.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  if (loading) {
    return (
      <div class="loading-screen">
        <Brand subtitle="Ouverture de l’atelier…" />
      </div>
    );
  }
  if (!boot) {
    return (
      <AuthLayout>
        <section class="card auth-card">
          <div class="auth-head">
            <p class="kicker">Connexion</p>
            <h2>Atelier indisponible</h2>
          </div>
          <p class="error">{error || 'Réessayez dans un instant.'}</p>
          <button class="btn primary" type="button" onClick={() => void refresh()}>
            Réessayer
          </button>
        </section>
      </AuthLayout>
    );
  }
  if (email)
    return (
      <Shell
        email={email}
        justSignedUp={justSignedUp}
        ephemeralStorage={Boolean(boot.ephemeralStorage)}
        onLogout={() => {
          sessionStorage.removeItem(WIZARD_SEEN);
          setJustSignedUp(false);
          setEmail(null);
        }}
      />
    );
  if (boot.needsSetup && !boot.allowSignup)
    return (
      <Setup
        boot={boot}
        onDone={(next) => {
          setJustSignedUp(true);
          setEmail(next);
        }}
      />
    );
  return (
    <Login
      allowSignup={boot.allowSignup !== false}
      onDone={(next, created) => {
        sessionStorage.removeItem(WIZARD_SEEN);
        setJustSignedUp(created);
        setEmail(next);
      }}
    />
  );
}

function Setup({ boot, onDone }: { boot: Boot; onDone: (email: string) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [setupToken, setToken] = useState('');
  const [error, setError] = useState('');
  return (
    <AuthLayout>
      <form
        class="card auth-card"
        onSubmit={(event) => {
          event.preventDefault();
          setError('');
          void api<{ email: string }>('/api/setup', {
            method: 'POST',
            body: JSON.stringify({ email, password, setupToken }),
          })
            .then((body) => onDone(body.email))
            .catch((caught) =>
              setError(caught instanceof Error ? caught.message : 'Configuration impossible.'),
            );
        }}
      >
        <div class="auth-head">
          <p class="kicker">Configuration</p>
          <h2>Premier espace</h2>
          <p class="muted">
            L’atelier démarre vide. Chaque compte a son propre espace, isolé des autres. Aucune
            fiche, aucun usage et aucune économie ne sont inventés.
          </p>
        </div>
        {boot.ephemeralStorage && (
          <p class="callout" role="status">
            Stockage temporaire : les données peuvent disparaître au prochain redémarrage à froid.
          </p>
        )}
        {boot.openSetup && (
          <p class="callout">
            Configuration initiale ouverte parce que le serveur est en mode développement.
          </p>
        )}
        {error && <p class="error">{error}</p>}
        <Field label="Adresse électronique">
          <input
            type="email"
            value={email}
            autoComplete="email"
            onInput={(event) => setEmail(event.currentTarget.value)}
            required
          />
        </Field>
        <Field label="Mot de passe (12 caractères minimum)">
          <input
            type="password"
            value={password}
            autoComplete="new-password"
            onInput={(event) => setPassword(event.currentTarget.value)}
            required
          />
        </Field>
        {boot.setupRequiresToken && (
          <Field label="Jeton de configuration">
            <input
              value={setupToken}
              onInput={(event) => setToken(event.currentTarget.value)}
              autoComplete="off"
              required
            />
          </Field>
        )}
        <button class="btn primary" type="submit">
          Créer le propriétaire
        </button>
      </form>
    </AuthLayout>
  );
}

function Login({
  allowSignup,
  onDone,
}: {
  allowSignup: boolean;
  onDone: (email: string, created: boolean) => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const signup = mode === 'signup';
  const switchTo = (next: 'login' | 'signup') => {
    setError('');
    setMode(next);
  };
  return (
    <AuthLayout>
      <form
        class="card auth-card"
        onSubmit={(event) => {
          event.preventDefault();
          setError('');
          setBusy(true);
          void api<{ email: string }>(signup ? '/api/signup' : '/api/login', {
            method: 'POST',
            body: JSON.stringify({ email, password }),
          })
            .then((body) => onDone(body.email, signup))
            .catch((caught) =>
              setError(
                caught instanceof Error
                  ? caught.message
                  : signup
                    ? 'Inscription impossible.'
                    : 'Connexion impossible.',
              ),
            )
            .finally(() => setBusy(false));
        }}
      >
        {allowSignup && (
          <div class="segmented auth-tabs" role="tablist" aria-label="Accès">
            <button
              type="button"
              role="tab"
              aria-selected={!signup}
              aria-current={!signup ? 'page' : undefined}
              onClick={() => switchTo('login')}
            >
              Connexion
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={signup}
              aria-current={signup ? 'page' : undefined}
              onClick={() => switchTo('signup')}
            >
              Créer un compte
            </button>
          </div>
        )}
        <div class="auth-head">
          <h2>{signup ? 'Créer votre espace' : 'Bon retour'}</h2>
          <p class="muted">
            {signup
              ? 'Un espace privé, isolé des autres comptes. Un assistant vous aide ensuite à relier Grok Bot.'
              : 'Connectez-vous pour retrouver vos bots.'}
          </p>
        </div>
        {error && (
          <p class="error" role="alert">
            {error}
          </p>
        )}
        <Field label="Adresse électronique">
          <input
            type="email"
            value={email}
            autoComplete="email"
            inputMode="email"
            placeholder="vous@exemple.fr"
            onInput={(event) => setEmail(event.currentTarget.value)}
            required
          />
        </Field>
        <Field label={signup ? 'Mot de passe (12 caractères minimum)' : 'Mot de passe'}>
          <input
            type="password"
            value={password}
            autoComplete={signup ? 'new-password' : 'current-password'}
            onInput={(event) => setPassword(event.currentTarget.value)}
            required
            minLength={signup ? 12 : undefined}
          />
        </Field>
        <button class="btn primary" type="submit" disabled={busy}>
          {busy ? 'Un instant…' : signup ? 'Créer l’espace' : 'Entrer'}
        </button>
      </form>
    </AuthLayout>
  );
}

function AuthLayout({ children }: { children: ComponentChildren }) {
  return (
    <div class="auth-screen">
      <header class="auth-top">
        <Brand />
      </header>
      <main class="auth-main">
        <section class="auth-intro" aria-hidden="true">
          <h1>Ce que font vos bots, en un coup d’œil.</h1>
          <ul class="auth-points">
            <li>Leur statut en direct et ce qui attend votre réponse</li>
            <li>L’historique de leurs signaux, à l’heure de Paris</li>
            <li>Leur usage de jetons, déclaré ou importé</li>
          </ul>
        </section>
        {children}
      </main>
    </div>
  );
}
