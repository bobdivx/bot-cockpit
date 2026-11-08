import { useEffect, useState } from 'preact/hooks';
import type { AccessToken, Workspace } from '../shared/types';
import { Actions } from './actions';
import { ApiError, api } from './api';
import { Links } from './links';
import { ListView } from './list';
import { Office } from './office';
import { Settings } from './settings';
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

export function Shell({ email, onLogout }: { email: string; onLogout: () => void }) {
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

  const titles: Record<Route, string> = {
    bureau: 'Bureau',
    liste: 'Liste',
    usage: 'Usage observé',
    liens: 'Liens MCP',
    demandes: 'Demandes',
    reglages: 'Réglages',
  };

  return (
    <div class="shell">
      <aside class="rail">
        <div class="brand">
          <svg width="34" height="34" viewBox="0 0 32 32" aria-hidden="true">
            <rect width="32" height="32" rx="8" fill="#241d16" />
            <path d="M6 14.5 16 8.5 26 14.5 16 20.5Z" fill="#f3e6d4" />
            <path d="M6 14.5 16 20.5 16 25.5 6 19.5Z" fill="#c4622d" />
            <path d="M26 14.5 16 20.5 16 25.5 26 19.5Z" fill="#1f6f64" />
          </svg>
          <div>
            <strong>Bot Cockpit</strong>
            <small>Atelier local</small>
          </div>
        </div>
        <nav class="nav">
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
        <div class="rail-foot">
          <span>{email}</span>
          <button
            class="btn small"
            type="button"
            onClick={() => void api('/api/logout', { method: 'POST' }).finally(onLogout)}
          >
            Fermer la session
          </button>
        </div>
      </aside>
      <main class="main">
        {data?.settings.demoMode && (
          <div class="banner" role="status">
            <strong>Données de démonstration</strong>
            <div>Ces fiches et ces lignes sont fictives. Elles ne décrivent pas un compte.</div>
          </div>
        )}
        <header class="topbar">
          <div>
            <p class="kicker">{data?.settings.demoMode ? 'Démonstration' : 'Mode réel'}</p>
            <h1>{titles[route]}</h1>
          </div>
          <button
            class="btn small only-mobile"
            type="button"
            onClick={() => void api('/api/logout', { method: 'POST' }).finally(onLogout)}
          >
            Sortir
          </button>
        </header>
        {error && <div class="error">{error}</div>}
        {!data && !error && <p class="meta">Ouverture de l’atelier…</p>}
        {data && route === 'bureau' && (
          <Office key={openId ?? 'bureau'} data={data} reload={reload} initialId={openId} />
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
