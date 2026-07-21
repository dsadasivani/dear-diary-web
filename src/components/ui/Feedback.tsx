import type { ReactNode } from 'react';
import { Check, LoaderCircle } from 'lucide-react';

type FeedbackTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

const toneClasses: Record<FeedbackTone, string> = {
  neutral: 'border-[var(--border-subtle)] bg-surface-subtle text-ink-secondary',
  success:
    'border-[color-mix(in_srgb,var(--success)_28%,transparent)] bg-[var(--success-soft)] text-[var(--success)]',
  warning:
    'border-[color-mix(in_srgb,var(--warning)_28%,transparent)] bg-[var(--warning-soft)] text-[var(--warning)]',
  danger:
    'border-[color-mix(in_srgb,var(--danger)_28%,transparent)] bg-[var(--danger-soft)] text-[var(--danger)]',
  info: 'border-[color-mix(in_srgb,var(--info)_28%,transparent)] bg-[var(--info-soft)] text-[var(--info)]',
};

export function StatusChip({
  children,
  tone = 'neutral',
  className = '',
}: {
  children: ReactNode;
  tone?: FeedbackTone;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex min-h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-bold ${toneClasses[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className = '',
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`mx-auto flex max-w-md flex-col items-center px-5 py-12 text-center ${className}`}
      aria-label={title}
    >
      {icon && (
        <span className="mb-5 flex h-12 w-12 items-center justify-center rounded-full bg-accent-soft text-accent">
          {icon}
        </span>
      )}
      <h2 className="type-section-title">{title}</h2>
      {description && <p className="type-supporting mt-2">{description}</p>}
      {action && <div className="mt-6">{action}</div>}
    </section>
  );
}

export function LoadingSkeleton({
  lines = 3,
  label = 'Loading content',
  className = '',
}: {
  lines?: number;
  label?: string;
  className?: string;
}) {
  return (
    <div role="status" aria-label={label} className={`grid gap-3 ${className}`}>
      {Array.from({ length: lines }, (_, index) => (
        <span
          key={index}
          aria-hidden="true"
          className="synced-image-skeleton block h-3 rounded-full"
          style={{ width: `${Math.max(42, 100 - index * 13)}%` }}
        />
      ))}
    </div>
  );
}

export function AutosaveIndicator({
  status,
  message,
}: {
  status: 'idle' | 'saving' | 'saved' | 'error';
  message?: string;
}) {
  const content =
    message ||
    (
      {
        idle: 'Changes are local',
        saving: 'Saving…',
        saved: 'Saved',
        error: 'Could not save',
      } as const
    )[status];
  return (
    <span
      role={status === 'error' ? 'alert' : 'status'}
      aria-live="polite"
      className="inline-flex min-h-7 items-center gap-1.5 text-xs font-semibold text-ink-secondary"
    >
      {status === 'saving' && (
        <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
      )}
      {status === 'saved' && (
        <Check aria-hidden="true" className="h-3.5 w-3.5 text-[var(--success)]" />
      )}
      {content}
    </span>
  );
}

export function ProgressIndicator({
  value,
  max = 100,
  label,
  className = '',
}: {
  value: number;
  max?: number;
  label: string;
  className?: string;
}) {
  const normalized = Math.min(100, Math.max(0, max > 0 ? (value / max) * 100 : 0));
  return (
    <div className={className}>
      <div className="mb-2 flex items-center justify-between gap-3 text-xs font-semibold text-ink-secondary">
        <span>{label}</span>
        <span>{Math.round(normalized)}%</span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-accent-soft"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={Math.min(max, Math.max(0, value))}
      >
        <span
          className="block h-full rounded-full bg-accent transition-[width] duration-200"
          style={{ width: `${normalized}%` }}
        />
      </div>
    </div>
  );
}

export function SectionHeader({
  eyebrow,
  title,
  description,
  action,
  className = '',
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <header className={`flex items-end justify-between gap-5 ${className}`}>
      <div className="min-w-0">
        {eyebrow && <p className="app-eyebrow">{eyebrow}</p>}
        <h2 className="type-section-title">{title}</h2>
        {description && <p className="type-supporting mt-1 max-w-2xl">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </header>
  );
}
