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
