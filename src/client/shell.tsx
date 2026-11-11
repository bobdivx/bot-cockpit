import { useEffect, useRef, useState } from 'preact/hooks';
import type { AccessToken, OnboardingState, Workspace } from '../shared/types';
import { Actions } from './actions';
import { ApiError, api } from './api';
import { Links } from './links';
import { ListView } from './list';
import { Office } from './office';
import { Settings } from './settings';
import { Brand } from './ui';
import { Usage } from './usage';
import { SetupWizard } from './wizard';

export const WIZARD_SEEN = 'bc-wizard-seen';

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
  justSignedUp = false,
  ephemeralStorage = false,
  onLogout,
}: {
  email: string;
  justSignedUp?: boolean;
  ephemeralStorage?: boolean;
  onLogout: () => void;
}) {
  const [data, setData] = useState<Workspace | null>(null);
  const [tokens, setTokens] = useState<AccessToken[]>([]);
  const [error, setError] = useState('');
  const [route, setRoute] = useState<Route>(readRoute());
  const [openId, setOpenId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);

  async function reload() {
    try {
      const [workspace, tokenList, setup] = await Promise.all([
        api<Workspace>('/api/workspace'),
        api<AccessToken[]>('/api/tokens'),
        api<OnboardingState>('/api/onboarding').catch(() => null),
      ]);
      setData(workspace);
      setTokens(tokenList);
      if (setup) setOnboarding(setup);
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
    source.addEventListener('connection.used', bump);
    return () => {
      window.removeEventListener('hashchange', onHash);
      source.close();
    };
  }, []);

  useEffect(() => {
    if (tick > 0) void reload();
  }, [tick]);

  // Auto-open: right after signup, and on login while no bot call has ever been received.
  const autoChecked = useRef(false);
  useEffect(() => {
    if (!onboarding || autoChecked.current) return;
    autoChecked.current = true;
    const seen = sessionStorage.getItem(WIZARD_SEEN) === '1';
    if (justSignedUp || (!onboarding.configured && !seen)) setWizardOpen(true);
  }, [onboarding, justSignedUp]);

  async function openWizard(restart = false) {
    if (restart) {
      try {
        setOnboarding(await api<OnboardingState>('/api/onboarding/restart', { method: 'POST' }));
      } catch {
        /* ouvre quand même avec l’état connu */
      }
    }
    setWizardOpen(true);
  }

  const incomplete = onboarding !== null && !onboarding.configured && !wizardOpen;

  const activeTeams = data?.teams.filter((team) => !team.archivedAt).length ?? 0;
  const activeBots = data?.bots.filter((bot) => !bot.archivedAt).length ?? 0;

  const pills = (ephemeralStorage || data?.settings.demoMode || incomplete) && (
    <div class="pill-stack">
      {incomplete && (
        <div class="demo-pill setup-pill" role="status">
          <i aria-hidden="true" />
          <strong>Configuration incomplète</strong>
          <span>Grok Bot n’a encore rien envoyé.</span>
          <button class="btn small primary" type="button" onClick={() => void openWizard()}>
            Reprendre
          </button>
        </div>
      )}
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
        {data && route === 'reglages' && (
          <Settings
            data={data}
            reload={reload}
            onboarding={onboarding}
            onOpenWizard={() => void openWizard(true)}
          />
        )}
      </main>
      {wizardOpen && onboarding && (
        <SetupWizard
          initial={onboarding}
          onChange={setOnboarding}
          onClose={(next) => {
            sessionStorage.setItem(WIZARD_SEEN, '1');
            setOnboarding(next);
            setWizardOpen(false);
            void reload();
          }}
        />
      )}
    </div>
  );
}

function readRoute(): Route {
  const hash = location.hash.replace('#/', '');
  if (NAV.some(([id]) => id === hash)) return hash as Route;
  return 'bureau';
}
