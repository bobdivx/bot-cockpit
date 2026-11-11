import { useEffect, useRef, useState } from 'preact/hooks';
import type { OnboardingState } from '../shared/types';
import { api } from './api';
import { Logo } from './ui';

const STEPS = ['Bienvenue', 'Grok Bot', 'Jeton', 'Test', 'Terminé'] as const;
const PLACEHOLDER = '<VOTRE_JETON>';

type Alt = 'none' | 'curl' | 'mcp';

export function grokPrompt(origin: string): string {
  return `Tu es relié à mon Bot Cockpit, le tableau de bord de mes bots.

1. Demande-moi le jeton Bot Cockpit via ton champ de saisie sécurisé de secret, et enregistre-le comme secret BOT_COCKPIT_TOKEN. Ne me demande pas de le coller dans la conversation et ne le répète jamais dans une réponse.

2. Endpoint : ${origin}/api/v1/report
Authentification : en-tête « Authorization: Bearer $BOT_COCKPIT_TOKEN ». Jamais de jeton dans l’URL.

Envoie un POST JSON au début et à la fin de chaque tâche importante, ou quand je te le demande :
- statut : {"bot_id":"grok-bot","status":"working","note":"courte note"}
  (status ∈ working, idle, away, blocked, offline)
- événement : {"bot_id":"grok-bot","name":"tache-terminee","detail":"résumé court","tokens":{"total":1234}}

Exemple :
curl -sS -X POST ${origin}/api/v1/report \\
  -H "Authorization: Bearer $BOT_COCKPIT_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"bot_id":"grok-bot","status":"idle","note":"Connexion Grok Bot"}'

3. Dès que le secret est enregistré, envoie ce statut "idle" avec la note "Connexion Grok Bot", puis dis-moi le code HTTP reçu (201 attendu).`;
}

export function curlSnippet(origin: string, token: string | null): string {
  const value = token ?? PLACEHOLDER;
  return `# Vérifier le jeton
curl -sS ${origin}/api/v1/ping \\
  -H "Authorization: Bearer ${value}"

# Envoyer un statut
curl -sS -X POST ${origin}/api/v1/report \\
  -H "Authorization: Bearer ${value}" \\
  -H "Content-Type: application/json" \\
  -d '{"bot_id":"grok-bot","status":"working","note":"Test de connexion"}'`;
}

function mcpSnippet(origin: string): string {
  return `Serveur MCP (Streamable HTTP)
URL : ${origin}/mcp
En-tête : Authorization: Bearer ${PLACEHOLDER}

Outils :
- report_status : bot_id, status, note, source, occurred_at
- report_event : bot_id, name, detail, source, occurred_at, tokens

À utiliser seulement si votre client accepte un serveur MCP personnalisé avec en-tête Authorization.`;
}

function hhmm(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

export function SetupWizard({
  initial,
  onClose,
  onChange,
}: {
  initial: OnboardingState;
  onClose: (state: OnboardingState) => void;
  onChange: (state: OnboardingState) => void;
}) {
  const [state, setState] = useState(initial);
  const [step, setStep] = useState(Math.min(initial.step, STEPS.length - 1));
  const [fresh, setFresh] = useState<string | null>(null);
  const [alt, setAlt] = useState<Alt>('none');
  const [linking, setLinking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState('');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const origin = window.location.origin;
  const token = state.token;
  const connected = Boolean(token?.lastUsedAt) || state.configured;

  const apply = (next: OnboardingState) => {
    setState(next);
    onChange(next);
  };

  async function goTo(next: number) {
    setError('');
    setStep(next);
    dialog.current?.scrollTo({ top: 0 });
    try {
      apply(
        await api<OnboardingState>('/api/onboarding', {
          method: 'PUT',
          body: JSON.stringify({ step: next }),
        }),
      );
    } catch {
      /* la progression locale suffit */
    }
  }

  async function refresh() {
    setChecking(true);
    try {
      apply(await api<OnboardingState>('/api/onboarding'));
    } catch {
      /* nouvel essai au prochain cycle */
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    // Keep polling until the first call AND its signal are visible: the token is marked
    // used just before the signal is stored, so a poll can land in between.
    const waiting = !connected || !state.lastSignal;
    if (step < 3 || !waiting) return;
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [step, connected, Boolean(state.lastSignal)]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void skip();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function mint() {
    if (
      token &&
      !window.confirm(
        'Régénérer révoque le jeton actuel. Grok Bot devra recevoir le nouveau. Continuer ?',
      )
    )
      return;
    setBusy(true);
    setError('');
    try {
      const body = await api<{ token: string; state: OnboardingState }>('/api/onboarding/token', {
        method: 'POST',
      });
      setFresh(body.token);
      apply(body.state);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Création du jeton impossible.');
    } finally {
      setBusy(false);
    }
  }

  async function copy(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      window.setTimeout(() => setCopied(''), 1800);
    } catch {
      setError('Copie impossible : sélectionnez le texte à la main.');
    }
  }

  async function skip() {
    try {
      const next = await api<OnboardingState>('/api/onboarding', {
        method: 'PUT',
        body: JSON.stringify({ status: 'skipped' }),
      });
      onClose(next);
    } catch {
      onClose(state);
    }
  }

  async function finish() {
    try {
      onClose(
        await api<OnboardingState>('/api/onboarding', {
          method: 'PUT',
          body: JSON.stringify({ status: 'done', step: 0 }),
        }),
      );
    } catch {
      onClose(state);
    }
  }

  const prompt = grokPrompt(origin);
  const altSnippet = alt === 'curl' ? curlSnippet(origin, fresh) : mcpSnippet(origin);
  const unlinked = state.lastSignal && !state.lastSignal.linked ? state.lastSignal : null;

  async function createFiche() {
    if (!unlinked) return;
    setLinking(true);
    setError('');
    try {
      await api(`/api/events/${unlinked.id}/materialize`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Grok Bot' }),
      });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Création de la fiche impossible.');
    } finally {
      setLinking(false);
    }
  }

  const linkHint = unlinked ? (
    <div class="note stack-tight link-hint">
      <strong>Signal reçu sans fiche correspondante</strong>
      <p class="meta">
        Grok Bot envoie bot_id « {unlinked.botKey} », mais aucune fiche ne porte cet identifiant.
        Créez la fiche pour voir ses statuts dans le bureau.
      </p>
      <div class="btn-row">
        <button
          class="btn small primary"
          type="button"
          disabled={linking}
          onClick={() => void createFiche()}
        >
          {linking ? 'Création…' : 'Créer la fiche Grok Bot'}
        </button>
      </div>
    </div>
  ) : state.lastSignal?.linked ? (
    <p class="note">
      Fiche reliée : les statuts de « {state.lastSignal.botKey} » s’affichent dans le bureau.
    </p>
  ) : null;

  return (
    <div class="modal-back wizard-back">
      <div
        ref={dialog}
        class="modal wizard"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wizard-title"
      >
        <header class="wizard-head">
          <div class="wizard-brand">
            <Logo size={28} />
            <p class="kicker">
              Étape {step + 1}/{STEPS.length}
            </p>
          </div>
          <button class="btn small ghost" type="button" onClick={() => void skip()}>
            Passer pour l’instant
          </button>
        </header>
        <ol class="wizard-steps" aria-label="Étapes">
          {STEPS.map((label, index) => (
            <li
              key={label}
              class={index === step ? 'on' : index < step ? 'done' : ''}
              aria-current={index === step ? 'step' : undefined}
            >
              <span>{index < step ? '✓' : index + 1}</span>
              <small>{label}</small>
            </li>
          ))}
        </ol>

        {error && (
          <p class="error" role="alert">
            {error}
          </p>
        )}

        {step === 0 && (
          <section class="wizard-body">
            <h2 id="wizard-title">Relier Grok Bot à votre espace</h2>
            <p class="meta">
              Bot Cockpit ne va rien chercher chez Grok Bot : c’est Grok Bot qui envoie ses statuts
              et ses événements à votre espace, avec un jeton personnel que vous pouvez révoquer à
              tout moment.
            </p>
            <ul class="wizard-list">
              <li>
                <b>1. Un texte à coller</b> dans Grok Bot : adresse, en-tête et exemple d’appel.
                Aucun jeton dedans.
              </li>
              <li>
                <b>2. Un jeton</b> propre à votre compte, à coller dans la case sécurisée de Grok
                Bot. Affiché une seule fois, stocké haché.
              </li>
              <li>
                <b>3. Un test</b> : l’étape passe au vert dès que le premier appel arrive.
              </li>
            </ul>
            <p class="note">
              Aucun mot de passe Grok Bot n’est demandé. Les données reçues restent dans votre
              espace.
            </p>
          </section>
        )}

        {step === 1 && (
          <section class="wizard-body">
            <h2 id="wizard-title">Coller dans Grok Bot</h2>
            <p class="meta">
              Ouvrez une conversation avec Grok Bot et collez ce texte. Il ne contient pas de jeton
              : Grok Bot va vous le demander dans sa case sécurisée, à l’étape suivante.
            </p>
            <pre class="snippet wizard-snippet">{prompt}</pre>
            <button class="btn primary" type="button" onClick={() => void copy('prompt', prompt)}>
              {copied === 'prompt' ? 'Copié ✓' : 'Copier le texte Grok Bot'}
            </button>
          </section>
        )}

        {step === 2 && (
          <section class="wizard-body">
            <h2 id="wizard-title">Votre jeton Grok Bot</h2>
            <p class="meta">
              Grok Bot affiche maintenant une case sécurisée « BOT_COCKPIT_TOKEN ». Générez le
              jeton, copiez-le et collez-le dans cette case, pas dans la conversation.
            </p>
            {fresh ? (
              <div class="note stack-tight">
                <strong>
                  Collez ce jeton dans la case sécurisée que Grok Bot vient d’afficher.
                </strong>
                <p class="token-once">{fresh}</p>
                <p class="meta">Il ne sera plus affiché ici.</p>
                <div class="btn-row">
                  <button
                    class="btn small primary"
                    type="button"
                    onClick={() => void copy('token', fresh)}
                  >
                    {copied === 'token' ? 'Copié ✓' : 'Copier le jeton'}
                  </button>
                  <button
                    class="btn small"
                    type="button"
                    disabled={busy}
                    onClick={() => void mint()}
                  >
                    Régénérer
                  </button>
                </div>
              </div>
            ) : token ? (
              <div class="note stack-tight">
                <strong>Un jeton Grok Bot existe déjà ({token.hint}…).</strong>
                <p class="meta">
                  Sa valeur n’est plus lisible. Gardez-le s’il est déjà enregistré dans Grok Bot, ou
                  régénérez-en un (l’ancien sera révoqué).
                </p>
                <div class="btn-row">
                  <button
                    class="btn small"
                    type="button"
                    disabled={busy}
                    onClick={() => void mint()}
                  >
                    Régénérer le jeton
                  </button>
                </div>
              </div>
            ) : (
              <button class="btn primary" type="button" disabled={busy} onClick={() => void mint()}>
                {busy ? 'Un instant…' : 'Générer mon jeton'}
              </button>
            )}
            <details class="wizard-alt" open={alt !== 'none'}>
              <summary>Autre client que Grok Bot (curl, MCP)</summary>
              <div class="nav-pills wizard-tabs" role="tablist" aria-label="Méthode">
                {(
                  [
                    ['curl', 'curl'],
                    ['mcp', 'MCP'],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={alt === id}
                    aria-current={alt === id ? 'page' : undefined}
                    onClick={() => setAlt(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {alt !== 'none' && (
                <>
                  <pre class="snippet wizard-snippet">{altSnippet}</pre>
                  <button
                    class="btn small"
                    type="button"
                    onClick={() => void copy(alt, altSnippet)}
                  >
                    {copied === alt ? 'Copié ✓' : 'Copier'}
                  </button>
                </>
              )}
            </details>
            <p class="meta">Tous vos jetons restent visibles et révocables dans l’onglet Liens.</p>
          </section>
        )}

        {step === 3 && (
          <section class="wizard-body">
            <h2 id="wizard-title">Tester la connexion</h2>
            <p class="meta">
              Une fois le jeton enregistré, Grok Bot envoie son statut de test. Cette étape se met à
              jour toute seule ; la commande ci-dessous permet aussi de tester à la main.
            </p>
            <div
              class={`wizard-test ${connected ? 'ok' : 'wait'}`}
              role="status"
              aria-live="polite"
            >
              <i aria-hidden="true" />
              <div>
                <b>{connected ? 'Premier appel reçu' : 'En attente du premier appel…'}</b>
                <small>
                  {connected
                    ? `${hhmm(token?.lastUsedAt ?? state.lastCall?.at)} · jeton ${
                        token?.hint ?? state.lastCall?.tokenHint ?? ''
                      }…${state.lastSignal ? ` · ${state.lastSignal.botKey} (${state.lastSignal.name})` : ''}`
                    : token
                      ? `Jeton ${token.hint}… prêt, aucun appel pour l’instant.`
                      : 'Aucun jeton actif : revenez à l’étape Jeton.'}
                </small>
              </div>
            </div>
            {connected && linkHint}
            <pre class="snippet wizard-snippet">{curlSnippet(origin, fresh)}</pre>
            <div class="btn-row">
              <button
                class="btn small"
                type="button"
                onClick={() => void copy('curl-test', curlSnippet(origin, fresh))}
              >
                {copied === 'curl-test' ? 'Copié ✓' : 'Copier la commande'}
              </button>
              <button
                class="btn small"
                type="button"
                disabled={checking}
                onClick={() => void refresh()}
              >
                {checking ? 'Vérification…' : 'Vérifier maintenant'}
              </button>
            </div>
          </section>
        )}

        {step === 4 && (
          <section class="wizard-body">
            <h2 id="wizard-title">{connected ? 'Grok Bot est relié' : 'Presque fini'}</h2>
            <p class="meta">
              {connected
                ? 'Les statuts et événements envoyés par Grok Bot apparaissent dans le bureau et le journal d’activité. Pour qu’un statut s’affiche sur une fiche, donnez à la fiche l’identifiant « grok-bot ».'
                : 'Aucun appel reçu pour l’instant. Vous pourrez reprendre à tout moment depuis le bandeau ou Réglages.'}
            </p>
            {connected && linkHint}
            <ul class="wizard-list">
              <li>
                <b>Révoquer ou régénérer :</b> onglet Liens ou Réglages → Relancer l’assistant.
              </li>
              <li>
                <b>Rien n’est compté comme quota :</b> les jetons déclarés par Grok Bot restent
                partiels.
              </li>
            </ul>
          </section>
        )}

        <footer class="wizard-foot">
          <button
            class="btn"
            type="button"
            disabled={step === 0}
            onClick={() => void goTo(step - 1)}
          >
            Précédent
          </button>
          {step < STEPS.length - 1 ? (
            <button
              class="btn primary"
              type="button"
              disabled={(step === 2 && !token) || (step === 3 && !connected)}
              onClick={() => void goTo(step + 1)}
            >
              {step === 0 ? 'Commencer' : 'Suivant'}
            </button>
          ) : (
            <button class="btn primary" type="button" onClick={() => void finish()}>
              Terminer
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
