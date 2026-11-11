import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import type { BotStatus } from '../shared/types';
import { hueOf, initials, STATUS_LABEL } from './format';

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ComponentChildren;
}) {
  return (
    <label class="field">
      <span class="field-label">{label}</span>
      {children}
      {hint && <small class="field-hint">{hint}</small>}
    </label>
  );
}

export function Badge({ tone, children }: { tone: string; children: ComponentChildren }) {
  return <span class={`badge tone-${tone}`}>{children}</span>;
}

export function StatusPill({ status }: { status: BotStatus }) {
  return (
    <span class={`status-pill s-${status}`}>
      <i aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  return (
    <span
      class="avatar"
      aria-hidden="true"
      style={`--hue:${hueOf(name)};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.38)}px`}
    >
      {initials(name)}
    </span>
  );
}

export function EmptyState({
  icon = 'spark',
  title,
  children,
  action,
}: {
  icon?: IconName;
  title: string;
  children?: ComponentChildren;
  action?: ComponentChildren;
}) {
  return (
    <div class="empty-state">
      <span class="empty-icon">
        <Icon name={icon} size={22} />
      </span>
      <h3>{title}</h3>
      {children && <p class="muted">{children}</p>}
      {action && <div class="empty-action">{action}</div>}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
  back,
}: {
  title: string;
  subtitle?: string;
  actions?: ComponentChildren;
  back?: { href: string; label: string };
}) {
  return (
    <header class="page-header">
      {back && (
        <a class="back-link" href={back.href}>
          <Icon name="back" size={18} />
          {back.label}
        </a>
      )}
      <div class="page-header-row">
        <div class="page-titles">
          <h1>{title}</h1>
          {subtitle && <p class="muted">{subtitle}</p>}
        </div>
        {actions && <div class="page-actions">{actions}</div>}
      </div>
    </header>
  );
}

export function Card({
  title,
  action,
  children,
  class: extra = '',
}: {
  title?: string;
  action?: ComponentChildren;
  children: ComponentChildren;
  class?: string;
}) {
  return (
    <section class={`card ${extra}`}>
      {(title || action) && (
        <div class="card-head">
          {title && <h2>{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Sheet({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ComponentChildren;
  footer?: ComponentChildren;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled on window; backdrop click is a pointer shortcut.
    <div
      class="sheet-back"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div class="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div class="sheet-head">
          <h2>{title}</h2>
          <button class="icon-btn" type="button" aria-label="Fermer" onClick={onClose}>
            <Icon name="close" size={20} />
          </button>
        </div>
        <div class="sheet-body">{children}</div>
        {footer && <div class="sheet-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="var(--logo-bg)" />
      <circle cx="12" cy="14" r="4" fill="#8eb7ff" />
      <circle cx="21" cy="13" r="3" fill="#ffb067" />
      <circle cx="18" cy="20" r="3.5" fill="#c4b2ff" />
    </svg>
  );
}

export function Brand({ subtitle }: { subtitle?: string }) {
  return (
    <div class="brand">
      <Logo />
      <div>
        <strong>Bot Cockpit</strong>
        {subtitle && <small>{subtitle}</small>}
      </div>
    </div>
  );
}

export type IconName =
  | 'home'
  | 'bots'
  | 'activity'
  | 'usage'
  | 'settings'
  | 'plus'
  | 'back'
  | 'close'
  | 'search'
  | 'link'
  | 'alert'
  | 'check'
  | 'spark'
  | 'chevron'
  | 'logout'
  | 'copy'
  | 'clock';

const PATHS: Record<IconName, string> = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  bots: 'M8 4h8M12 4v3M5 9a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2zM9 13h.01M15 13h.01M9.5 16.5h5',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  usage: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  plus: 'M12 5v14M5 12h14',
  back: 'M15 18l-6-6 6-6',
  close: 'M18 6 6 18M6 6l12 12',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.3-4.3',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  alert:
    'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  check: 'M20 6 9 17l-5-5',
  spark:
    'M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8',
  chevron: 'M9 18l6-6-6-6',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  copy: 'M9 9h10v12H9zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
};

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      class="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
