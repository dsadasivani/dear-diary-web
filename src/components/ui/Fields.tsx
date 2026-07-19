import type { InputHTMLAttributes, ReactNode } from 'react';
import { Search, X } from 'lucide-react';

interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: string;
  onClear?: () => void;
  trailing?: ReactNode;
}

export function SearchField({
  label = 'Search',
  onClear,
  trailing,
  className = '',
  value,
  ...props
}: SearchFieldProps) {
  const hasValue = typeof value === 'string' && value.length > 0;
  return (
    <label className={`relative block ${className}`}>
      <span className="sr-only">{label}</span>
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-tertiary"
      />
      <input
        {...props}
        value={value}
        type="search"
        className="min-h-11 w-full rounded-[var(--radius-control)] border border-[var(--border-subtle)] bg-surface py-2 pl-10 pr-20 text-base text-ink outline-none transition-[border-color,box-shadow] duration-200 placeholder:text-ink-tertiary focus:border-[var(--focus-ring)] focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--focus-ring)_18%,transparent)]"
      />
      <span className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
        {hasValue && onClear && (
          <button
            type="button"
            onClick={onClear}
            className="flex h-11 w-11 items-center justify-center rounded-full text-ink-tertiary hover:bg-surface-subtle"
            aria-label="Clear search"
          >
            <X className="h-4 w-4" />
          </button>
        )}
        {trailing}
      </span>
    </label>
  );
}

export function FilterChip({
  children,
  selected = false,
  onClick,
  onRemove,
}: {
  children: ReactNode;
  selected?: boolean;
  onClick?: () => void;
  onRemove?: () => void;
  key?: string;
}) {
  return (
    <span
      className={`inline-flex min-h-11 items-center overflow-hidden rounded-full border text-xs font-bold ${selected ? 'border-accent bg-accent-soft text-accent-strong' : 'border-[var(--border-subtle)] bg-surface text-ink-secondary'}`}
    >
      <button type="button" aria-pressed={selected} onClick={onClick} className="min-h-11 px-3">
        {children}
      </button>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="flex min-h-11 min-w-11 items-center justify-center border-l border-current/15"
          aria-label={`Remove ${String(children)}`}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </span>
  );
}

export const TagChip = FilterChip;
