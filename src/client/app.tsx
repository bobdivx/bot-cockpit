import { useEffect, useState } from 'preact/hooks';
import { ApiError, api } from './api';
import { Shell } from './shell';
import { Field } from './ui';

type Boot = {
  needsSetup: boolean;
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
  if (boot.needsSetup) return <Setup boot={boot} onDone={(next) => setEmail(next)} />;
  return <Login onDone={(next) => setEmail(next)} />;
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
        <h1>Premier propriétaire</h1>
        <p class="lede">
          L’atelier démarre vide. Aucune fiche, aucun usage et aucune économie ne sont inventés. Un
          seul compte local ouvre ensuite le bureau.
        </p>
        {boot.ephemeralStorage && (
          <p class="note" role="status">
            Hébergement Vercel : la base SQLite est temporaire (/tmp) et se réinitialise aux
            redémarrages à froid. Pour des données persistantes, utilisez Docker Compose / DevForge.
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

function Login({ onDone }: { onDone: (email: string) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  return (
    <div class="auth-screen">
      <form
        class="auth-card stack"
        onSubmit={(event) => {
          event.preventDefault();
          setError('');
          void api<{ email: string }>('/api/login', {
            method: 'POST',
            body: JSON.stringify({ email, password }),
          })
            .then((body) => onDone(body.email))
            .catch((caught) =>
              setError(caught instanceof Error ? caught.message : 'Connexion impossible.'),
            );
        }}
      >
        <p class="kicker">Bot Cockpit</p>
        <h1>Reprendre l’atelier</h1>
        <p class="lede">Session du propriétaire. Aucun compte externe n’est interrogé.</p>
        {error && <p class="error">{error}</p>}
        <Field label="Adresse électronique">
          <input
            type="email"
            value={email}
            onInput={(event) => setEmail(event.currentTarget.value)}
            required
          />
        </Field>
        <Field label="Mot de passe">
          <input
            type="password"
            value={password}
            onInput={(event) => setPassword(event.currentTarget.value)}
            required
          />
        </Field>
        <button class="btn primary" type="submit">
          Entrer
        </button>
      </form>
    </div>
  );
}
