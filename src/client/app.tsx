import { useEffect, useState } from 'preact/hooks';
import { ApiError, api } from './api';
import { Shell } from './shell';
import { Field } from './ui';

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
        <p class="display">Ouverture de l’atelier…</p>
      </div>
    );
  }
  if (!boot) {
    return (
      <div class="auth-screen">
        <section class="auth-card">
          <p class="kicker">Bot Cockpit</p>
          <h1>Atelier indisponible</h1>
          <p class="error">{error || 'Réessayez dans un instant.'}</p>
          <button class="btn" type="button" onClick={() => void refresh()}>
            Réessayer
          </button>
        </section>
      </div>
    );
  }
  if (email)
    return (
      <Shell
        email={email}
        ephemeralStorage={Boolean(boot.ephemeralStorage)}
        onLogout={() => setEmail(null)}
      />
    );
  if (boot.needsSetup && !boot.allowSignup)
    return <Setup boot={boot} onDone={(next) => setEmail(next)} />;
  return <Login allowSignup={boot.allowSignup !== false} onDone={(next) => setEmail(next)} />;
}

function Setup({ boot, onDone }: { boot: Boot; onDone: (email: string) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [setupToken, setToken] = useState('');
  const [error, setError] = useState('');
  return (
    <div class="auth-screen">
      <form
        class="auth-card stack"
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
        <p class="kicker">Bot Cockpit</p>
        <h1>Premier espace</h1>
        <p class="lede">
          L’atelier démarre vide. Chaque compte a son propre espace, isolé des autres. Aucune fiche,
          aucun usage et aucune économie ne sont inventés.
        </p>
        {boot.ephemeralStorage && (
          <p class="note" role="status">
            Stockage temporaire : les données peuvent disparaître au prochain redémarrage à froid.
          </p>
        )}
        {boot.openSetup && (
          <p class="note">
            Configuration initiale ouverte parce que le serveur est en mode développement.
          </p>
        )}
        {error && <p class="error">{error}</p>}
        <Field label="Adresse électronique">
          <input
            type="email"
            value={email}
            onInput={(event) => setEmail(event.currentTarget.value)}
            required
          />
        </Field>
        <Field label="Mot de passe (12 caractères minimum)">
          <input
            type="password"
            value={password}
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
    </div>
  );
}

function Login({ allowSignup, onDone }: { allowSignup: boolean; onDone: (email: string) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [error, setError] = useState('');
  const signup = mode === 'signup';
  return (
    <div class="auth-screen">
      <form
        class="auth-card stack"
        onSubmit={(event) => {
          event.preventDefault();
          setError('');
          void api<{ email: string }>(signup ? '/api/signup' : '/api/login', {
            method: 'POST',
            body: JSON.stringify({ email, password }),
          })
            .then((body) => onDone(body.email))
            .catch((caught) =>
              setError(
                caught instanceof Error
                  ? caught.message
                  : signup
                    ? 'Inscription impossible.'
                    : 'Connexion impossible.',
              ),
            );
        }}
      >
        <p class="kicker">Bot Cockpit</p>
        <h1>{signup ? 'Créer votre espace' : 'Reprendre l’atelier'}</h1>
        <p class="lede">
          {signup
            ? 'Chaque adresse ouvre un espace isolé. Aucun compte externe n’est interrogé.'
            : 'Session de votre espace. Aucun compte externe n’est interrogé.'}
        </p>
        {error && <p class="error">{error}</p>}
        <Field label="Adresse électronique">
          <input
            type="email"
            value={email}
            onInput={(event) => setEmail(event.currentTarget.value)}
            required
          />
        </Field>
        <Field label={signup ? 'Mot de passe (12 caractères minimum)' : 'Mot de passe'}>
          <input
            type="password"
            value={password}
            onInput={(event) => setPassword(event.currentTarget.value)}
            required
            minLength={signup ? 12 : undefined}
          />
        </Field>
        <button class="btn primary" type="submit">
          {signup ? 'Créer l’espace' : 'Entrer'}
        </button>
        {allowSignup && (
          <button
            class="btn"
            type="button"
            onClick={() => {
              setError('');
              setMode(signup ? 'login' : 'signup');
            }}
          >
            {signup ? 'J’ai déjà un espace' : 'Créer un nouvel espace'}
          </button>
        )}
      </form>
    </div>
  );
}
