import { useEffect, useState } from 'preact/hooks';
import type { AccessToken, Workspace } from '../shared/types';
import { Actions } from './actions';
import { ApiError, api } from './api';
import { Links } from './links';
import { ListView } from './list';
import { Office } from './office';
import { Settings } from './settings';
import { Brand } from './ui';
import { Usage } from './usage';

const NAV = [
  ['bureau', 'Bureau'],
  ['liste', 'Liste'],
  ['usage', 'Usage'],
  ['liens', 'Liens'],
  ['demandes', 'Demandes'],
  ['reglages', 'Réglages'],
] as const;

type Route = (typeof NAV)[number][0];

export function Shell({
  email,
  ephemeralStorage = false,
  onLogout,
}: {
  email: string;
  ephemeralStorage?: boolean;
  onLogout: () => void;
}) {
  const [data, setData] = useState<Workspace | null>(null);
  const [tokens, setTokens] = useState<AccessToken[]>([]);
  const [error, setError] = useState('');
  const [route, setRoute] = useState<Route>(readRoute());
  const [openId, setOpenId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  async function reload() {
    try {
      const [workspace, tokenList] = await Promise.all([
        api<Workspace>('/api/workspace'),
        api<AccessToken[]>('/api/tokens'),
      ]);
      setData(workspace);
      setTokens(tokenList);
      setError('');
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) onLogout();
      else setError(caught instanceof Error ? caught.message : 'Ouverture impossible.');
    }
  }

  useEffect(() => {
    void reload();
    const onHash = () => setRoute(readRoute());
    window.addEventListener('hashchange', onHash);
    const source = new EventSource('/api/stream');
    const bump = () => setTick((value) => value + 1);
    source.addEventListener('bot.updated', bump);
    source.addEventListener('usage.changed', bump);
    source.addEventListener('event.created', bump);
    return () => {
      window.removeEventListener('hashchange', onHash);
      source.close();
    };
  }, []);

  useEffect(() => {
    if (tick > 0) void reload();
  }, [tick]);

  const activeTeams = data?.teams.filter((team) => !team.archivedAt).length ?? 0;
  const activeBots = data?.bots.filter((bot) => !bot.archivedAt).length ?? 0;

  const pills = (ephemeralStorage || data?.settings.demoMode) && (
    <div class="pill-stack">
      {ephemeralStorage && (
        <div class="demo-pill ephemeral-pill" role="status">
          <strong>Stockage temporaire (Vercel)</strong>
          <span>
            SQLite dans /tmp : les données peuvent disparaître à chaque redémarrage à froid. Docker
            / DevForge reste l’installation persistante.
          </span>
        </div>
      )}
      {data?.settings.demoMode && (
        <div class="demo-pill" role="status">
          <strong>Données de démonstration</strong>
          <span>Fiches et lignes fictives. Elles ne décrivent pas un compte.</span>
        </div>
      )}
    </div>
  );

  return (
    <div class={`app route-${route}`}>
      <header class="top-hud">
        <Brand subtitle={data?.settings.demoMode ? 'Démonstration' : 'Mode réel'} />
        <nav class="nav-pills" aria-label="Sections">
          {NAV.map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-current={route === id ? 'page' : undefined}
              onClick={() => {
                location.hash = `#/${id}`;
                setRoute(id);
              }}
            >
              {label}
            </button>
          ))}
        </nav>
        <div class="count-pills">
          <span>{activeTeams} équipes</span>
          <span>{activeBots} bots</span>
          <span>{data?.signals.length ?? 0} événements</span>
        </div>
        <div class="user-pill">
          <span class="user-email" title={email}>
            {email}
          </span>
          <button
            class="btn small"
            type="button"
            onClick={() => void api('/api/logout', { method: 'POST' }).finally(onLogout)}
          >
            Sortir
          </button>
        </div>
      </header>
      {route === 'bureau' && pills}
      <main class={route === 'bureau' ? 'stage' : 'page'}>
        {route !== 'bureau' && pills}
        {error && <div class="error">{error}</div>}
        {!data && !error && <p class="meta">Ouverture de l’atelier…</p>}
        {data && route === 'bureau' && (
          <Office
            key={openId ?? 'bureau'}
            data={data}
            reload={reload}
            email={email}
            initialId={openId}
          />
        )}
        {data && route === 'liste' && (
          <ListView
            data={data}
            onOpen={(id) => {
              setOpenId(id);
              location.hash = '#/bureau';
              setRoute('bureau');
            }}
          />
        )}
        {data && route === 'usage' && <Usage data={data} tick={tick} />}
        {data && route === 'liens' && <Links tokens={tokens} reload={reload} />}
        {data && route === 'demandes' && <Actions data={data} />}
        {data && route === 'reglages' && <Settings data={data} reload={reload} />}
      </main>
    </div>
  );
}

function readRoute(): Route {
  const hash = location.hash.replace('#/', '');
  if (NAV.some(([id]) => id === hash)) return hash as Route;
  return 'bureau';
}
