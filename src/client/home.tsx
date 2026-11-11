import { useState } from 'preact/hooks';
import type { Bot, OnboardingState, Signal, Workspace } from '../shared/types';
import { api } from './api';
import { Feed, fromSignal } from './feed';
import { formatWhen, STATUS_LABEL, STATUS_ORDER, signalLabel } from './format';
import { Avatar, Card, EmptyState, Icon, PageHeader, StatusPill } from './ui';

function greeting(): string {
  const hour = Number(
    new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: 'numeric' }).format(
      new Date(),
    ),
  );
  if (hour < 5 || hour >= 18) return 'Bonsoir';
  return 'Bonjour';
}

export function BotRow({ bot, href }: { bot: Bot; href: string }) {
  return (
    <a class="bot-row" href={href}>
      <Avatar name={bot.name} />
      <span class="bot-row-main">
        <strong>{bot.name}</strong>
        <small class={bot.stale && !bot.quiet ? 'warn-text' : 'muted'}>
          {bot.statusNote || bot.role || signalLabel(bot)}
        </small>
      </span>
      <span class="bot-row-side">
        <StatusPill status={bot.status} />
        <small class="muted">{bot.lastSeenAt ? formatWhen(bot.lastSeenAt) : 'jamais vu'}</small>
      </span>
    </a>
  );
}

export function Home({
  data,
  onboarding,
  reload,
  onOpenWizard,
}: {
  data: Workspace;
  onboarding: OnboardingState | null;
  reload: () => Promise<void>;
  onOpenWizard: () => void;
}) {
  const bots = data.bots.filter((bot) => !bot.archivedAt);
  const orphans = data.signals.filter((signal) => !signal.botId);
  const blocked = bots.filter((bot) => bot.status === 'blocked');
  const silent = bots.filter((bot) => bot.stale && !bot.quiet && bot.status !== 'blocked');
  const sorted = [...bots].sort(
    (a, b) =>
      STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
      (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? ''),
  );
  const counts = STATUS_ORDER.map((status) => ({
    status,
    count: bots.filter((bot) => bot.status === status).length,
  })).filter((entry) => entry.count > 0);
  const waiting = blocked.length + silent.length + orphans.length;
  const isEmpty = bots.length === 0 && data.signals.length === 0;

  return (
    <div class="page">
      <PageHeader
        title={greeting()}
        subtitle={
          isEmpty
            ? 'Bienvenue dans votre cockpit.'
            : waiting > 0
              ? `${waiting} point${waiting > 1 ? 's' : ''} vous attend${waiting > 1 ? 'ent' : ''}.`
              : 'Tout roule : rien ne vous attend.'
        }
      />

      {isEmpty ? (
        <Card class="hero-card">
          <EmptyState
            icon="link"
            title="Reliez votre premier bot"
            action={
              <>
                <button class="btn primary" type="button" onClick={onOpenWizard}>
                  Configurer Grok Bot
                </button>
                <a class="btn ghost" href="#/bots">
                  Créer une fiche à la main
                </a>
              </>
            }
          >
            Dès qu’un bot vous écrit, son statut et son activité apparaissent ici, à l’heure de
            Paris.
          </EmptyState>
        </Card>
      ) : (
        <div class="home-grid">
          <div class="home-main">
            <Card title="En attente de vous">
              {waiting === 0 ? (
                <p class="all-good">
                  <Icon name="check" size={18} /> Rien à traiter pour l’instant.
                </p>
              ) : (
                <ul class="todo-list">
                  {blocked.map((bot) => (
                    <li key={bot.id}>
                      <a class="todo" href={`#/bots/${bot.id}`}>
                        <span class="todo-icon danger">
                          <Icon name="alert" size={18} />
                        </span>
                        <span>
                          <strong>{bot.name} est bloqué</strong>
                          <small class="muted">
                            {bot.statusNote || 'Aucune précision donnée.'}
                          </small>
                        </span>
                        <Icon name="chevron" size={18} />
                      </a>
                    </li>
                  ))}
                  {silent.map((bot) => (
                    <li key={bot.id}>
                      <a class="todo" href={`#/bots/${bot.id}`}>
                        <span class="todo-icon warn">
                          <Icon name="clock" size={18} />
                        </span>
                        <span>
                          <strong>{bot.name} ne donne plus de nouvelles</strong>
                          <small class="muted">Dernier signal {formatWhen(bot.lastSeenAt)}</small>
                        </span>
                        <Icon name="chevron" size={18} />
                      </a>
                    </li>
                  ))}
                  {orphans.slice(0, 5).map((signal) => (
                    <OrphanTodo key={signal.id} signal={signal} reload={reload} />
                  ))}
                </ul>
              )}
            </Card>

            <Card
              title="Vos bots maintenant"
              action={
                <a class="link" href="#/bots">
                  Tout voir
                </a>
              }
            >
              {sorted.length === 0 ? (
                <EmptyState
                  icon="bots"
                  title="Aucune fiche"
                  action={
                    <a class="btn" href="#/bots">
                      Créer une fiche
                    </a>
                  }
                >
                  Les bots qui vous écrivent obtiennent une fiche automatiquement.
                </EmptyState>
              ) : (
                <div class="bot-list">
                  {sorted.slice(0, 6).map((bot) => (
                    <BotRow key={bot.id} bot={bot} href={`#/bots/${bot.id}`} />
                  ))}
                </div>
              )}
            </Card>

            <Card
              title="Activité récente"
              action={
                <a class="link" href="#/activite">
                  Historique
                </a>
              }
            >
              <Feed
                items={data.signals.slice(0, 8).map(fromSignal)}
                bots={data.bots}
                empty={
                  <EmptyState icon="activity" title="Pas encore d’activité">
                    Les signaux envoyés par vos bots s’afficheront ici.
                  </EmptyState>
                }
              />
            </Card>
          </div>

          <div class="home-side">
            {counts.length > 0 && (
              <Card title="Statuts">
                <ul class="count-list">
                  {counts.map((entry) => (
                    <li key={entry.status} class={`count s-${entry.status}`}>
                      <i aria-hidden="true" />
                      <span>{STATUS_LABEL[entry.status]}</span>
                      <strong>{entry.count}</strong>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
            <ConnectionCard onboarding={onboarding} onOpenWizard={onOpenWizard} />
          </div>
        </div>
      )}
    </div>
  );
}

function OrphanTodo({ signal, reload }: { signal: Signal; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <li>
      <div class="todo">
        <span class="todo-icon info">
          <Icon name="link" size={18} />
        </span>
        <span>
          <strong>Signal de « {signal.reportedBotKey} » sans fiche</strong>
          <small class="muted">
            {signal.name} · {formatWhen(signal.occurredAt)}
          </small>
          {error && <small class="error-text">{error}</small>}
        </span>
        <button
          class="btn sm"
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api(`/api/events/${signal.id}/materialize`, {
                method: 'POST',
                body: JSON.stringify({}),
              });
              await reload();
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : 'Création impossible.');
            } finally {
              setBusy(false);
            }
          }}
        >
          Créer la fiche
        </button>
      </div>
    </li>
  );
}

export function ConnectionCard({
  onboarding,
  onOpenWizard,
}: {
  onboarding: OnboardingState | null;
  onOpenWizard: () => void;
}) {
  if (!onboarding) return null;
  const ok = onboarding.configured;
  return (
    <Card title="Connexion Grok Bot">
      <div class={`health ${ok ? 'ok' : 'off'}`}>
        <span class="health-dot" aria-hidden="true" />
        <div>
          <strong>{ok ? 'Connecté' : 'Pas encore relié'}</strong>
          <small class="muted">
            {ok && onboarding.lastCall
              ? `Dernier appel ${formatWhen(onboarding.lastCall.at)}`
              : 'Aucun appel reçu avec vos jetons.'}
          </small>
        </div>
      </div>
      {onboarding.lastSignal && (
        <p class="muted small">
          Dernier signal : {onboarding.lastSignal.name} ({onboarding.lastSignal.botKey}),{' '}
          {formatWhen(onboarding.lastSignal.receivedAt)}
        </p>
      )}
      <div class="row-actions">
        {!ok && (
          <button class="btn primary sm" type="button" onClick={onOpenWizard}>
            Lancer l’assistant
          </button>
        )}
        <a class="btn ghost sm" href="#/reglages">
          Jetons et réglages
        </a>
      </div>
    </Card>
  );
}
