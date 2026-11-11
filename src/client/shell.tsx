import { useEffect, useRef, useState } from 'preact/hooks';
import type { AccessToken, OnboardingState, Workspace } from '../shared/types';
import { Activity } from './activity';
import { ApiError, api } from './api';
import { Bots } from './bots';
import { Home } from './home';
import { Settings } from './settings';
import { Brand, Icon, type IconName } from './ui';
import { Usage } from './usage';
import { SetupWizard } from './wizard';

export const WIZARD_SEEN = 'bc-wizard-seen';

const NAV: Array<{ id: Section; label: string; icon: IconName }> = [
  { id: 'accueil', label: 'Accueil', icon: 'home' },
  { id: 'bots', label: 'Bots', icon: 'bots' },
  { id: 'activite', label: 'Activité', icon: 'activity' },
  { id: 'usage', label: 'Usage', icon: 'usage' },
  { id: 'reglages', label: 'Réglages', icon: 'settings' },
];

type Section = 'accueil' | 'bots' | 'activite' | 'usage' | 'reglages';
export type Route = { section: Section; id: string | null };

function readRoute(): Route {
  const [section = '', id = ''] = location.hash.replace(/^#\/?/, '').split('/');
  const known = NAV.some((item) => item.id === section);
  return { section: known ? (section as Section) : 'accueil', id: known && id ? id : null };
}

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
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [error, setError] = useState('');
  const [route, setRoute] = useState<Route>(readRoute());
  const [tick, setTick] = useState(0);
  const [wizardOpen, setWizardOpen] = useState(false);
  const autoChecked = useRef(false);

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
    const onHash = () => {
      setRoute(readRoute());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', onHash);
    const source = new EventSource('/api/stream');
    const bump = () => setTick((value) => value + 1);
    for (const name of ['bot.updated', 'usage.changed', 'event.created', 'connection.used'])
      source.addEventListener(name, bump);
    // Serverless instances do not share the event stream: poll while the tab is visible.
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') bump();
    }, 20_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') bump();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('hashchange', onHash);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
      source.close();
    };
  }, []);

  useEffect(() => {
    if (tick > 0) void reload();
  }, [tick]);

  // Auto-open: right after signup, and on login while no bot call has ever been received.
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

  async function logout() {
    await api('/api/logout', { method: 'POST' }).catch(() => undefined);
    onLogout();
  }

  // On an empty home, the hero card already points to the assistant.
  const emptyHome =
    route.section === 'accueil' &&
    data !== null &&
    data.bots.length === 0 &&
    data.signals.length === 0;
  const incomplete = onboarding !== null && !onboarding.configured && !wizardOpen && !emptyHome;
  const active = route.section;

  return (
    <div class="app">
      <a class="skip-link" href="#contenu">
        Aller au contenu
      </a>
      <aside class="sidenav" aria-label="Navigation principale">
        <div class="sidenav-brand">
          <Brand subtitle={data?.settings.demoMode ? 'Démonstration' : undefined} />
        </div>
        <nav class="sidenav-links">
          {NAV.map((item) => (
            <a
              key={item.id}
              href={`#/${item.id}`}
              class="nav-link"
              aria-current={active === item.id ? 'page' : undefined}
            >
              <Icon name={item.icon} size={22} />
              <span>{item.label}</span>
            </a>
          ))}
        </nav>
        <div class="sidenav-foot">
          <span class="sidenav-email" title={email}>
            {email}
          </span>
          <button class="nav-link as-button" type="button" onClick={() => void logout()}>
            <Icon name="logout" size={20} />
            <span>Sortir</span>
          </button>
        </div>
      </aside>

      <div class="main-col">
        <header class="topbar">
          <Brand />
          <a class="icon-btn" href="#/reglages">
            <span class="topbar-avatar">{email.charAt(0).toUpperCase()}</span>
            <span class="sr-only">Réglages et compte</span>
          </a>
        </header>

        <main class="content" id="contenu">
          {(incomplete || data?.settings.demoMode || ephemeralStorage) && (
            <div class="banners">
              {incomplete && (
                <div class="banner warn" role="status">
                  <Icon name="link" size={18} />
                  <p>
                    <strong>Configuration incomplète.</strong>{' '}
                    <span>Aucun bot ne vous a encore écrit.</span>
                  </p>
                  <button class="btn sm primary" type="button" onClick={() => void openWizard()}>
                    Reprendre
                  </button>
                </div>
              )}
              {data?.settings.demoMode && (
                <div class="banner info" role="status">
                  <Icon name="spark" size={18} />
                  <p>
                    <strong>Données de démonstration.</strong>{' '}
                    <span>Fiches et lignes fictives, retirables dans Réglages.</span>
                  </p>
                </div>
              )}
              {ephemeralStorage && (
                <div class="banner info" role="status">
                  <Icon name="alert" size={18} />
                  <p>
                    <strong>Stockage temporaire.</strong>{' '}
                    <span>Les données peuvent disparaître au prochain redémarrage.</span>
                  </p>
                </div>
              )}
            </div>
          )}
          {error && (
            <p class="error" role="alert">
              {error}
            </p>
          )}
          {!data && !error && <div class="page-loading" aria-busy="true" />}
          {data && active === 'accueil' && (
            <Home
              data={data}
              onboarding={onboarding}
              reload={reload}
              onOpenWizard={() => void openWizard()}
            />
          )}
          {data && active === 'bots' && (
            <Bots data={data} selectedId={route.id} reload={reload} tick={tick} />
          )}
          {data && active === 'activite' && <Activity data={data} tick={tick} />}
          {data && active === 'usage' && <Usage data={data} tick={tick} />}
          {data && active === 'reglages' && (
            <Settings
              data={data}
              email={email}
              tokens={tokens}
              onboarding={onboarding}
              reload={reload}
              onOpenWizard={() => void openWizard(true)}
              onLogout={() => void logout()}
              onDeleted={onLogout}
            />
          )}
        </main>
      </div>

      <nav class="tabbar" aria-label="Navigation principale">
        {NAV.map((item) => (
          <a
            key={item.id}
            href={`#/${item.id}`}
            class="tab"
            aria-current={active === item.id ? 'page' : undefined}
          >
            <Icon name={item.icon} size={22} />
            <span>{item.label}</span>
          </a>
        ))}
      </nav>

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
