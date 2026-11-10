import type { ComponentChildren } from 'preact';

export function Field({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <label class="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Badge({ tone, children }: { tone: string; children: ComponentChildren }) {
  return <span class={`badge tone-${tone}`}>{children}</span>;
}

export function Empty({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <div class="empty">
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  );
}

export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="10" fill="#1c2430" />
      <circle cx="12" cy="14" r="4" fill="#8eb7ff" />
      <circle cx="21" cy="13" r="3" fill="#ffb067" />
      <circle cx="18" cy="20" r="3.5" fill="#c4b2ff" />
    </svg>
  );
}

export function Brand({ subtitle }: { subtitle: string }) {
  return (
    <div class="brand">
      <Logo />
      <div>
        <strong>Bot Cockpit</strong>
        <small>{subtitle}</small>
      </div>
    </div>
  );
}
