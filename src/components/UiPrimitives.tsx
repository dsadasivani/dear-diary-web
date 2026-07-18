import React, { type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

type ButtonTone = 'primary' | 'secondary' | 'danger' | 'quiet';

interface CommonButtonProps {
  children?: ReactNode;
  className?: string;
  type?: 'button' | 'submit' | 'reset';
  disabled?: boolean;
  title?: string;
  onClick?: (event: any) => void;
  'aria-pressed'?: boolean;
  'data-testid'?: string;
}

interface AppButtonProps extends CommonButtonProps {
  tone?: ButtonTone;
}

export function AppButton({ tone = 'secondary', className = '', type = 'button', ...props }: AppButtonProps) {
  const toneClass = {
    primary: 'border-accent bg-accent text-white hover:bg-accent-strong',
    secondary: 'border-[var(--border-subtle)] bg-surface text-ink hover:border-accent',
    danger: 'border-[var(--danger)] bg-[var(--danger)] text-white hover:brightness-95',
    quiet: 'border-transparent bg-transparent text-accent hover:bg-accent-soft',
  }[tone];
  return (
    <button
      {...props}
      type={type}
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-control)] border px-4 py-2.5 text-sm font-bold transition-[background-color,border-color,color,transform] duration-200 active:scale-[0.985] disabled:scale-100 disabled:opacity-45 md:min-h-9 ${toneClass} ${className}`}
    />
  );
}

interface IconButtonProps extends CommonButtonProps {
  label: string;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ label, className = '', type = 'button', children, ...props }, ref) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      aria-label={label}
      title={props.title || label}
      className={`icon-button shrink-0 ${className}`}
    >
      {children}
    </button>
  );
});

interface StatusNoticeProps {
  children: ReactNode;
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
  role?: 'status' | 'alert';
  className?: string;
}

export function StatusNotice({ children, tone = 'neutral', role = 'status', className = '' }: StatusNoticeProps) {
  const toneClass = {
    neutral: 'border-[var(--border-subtle)] bg-surface-subtle text-ink-secondary',
    success: 'border-[color-mix(in_srgb,var(--success)_28%,transparent)] bg-[var(--success-soft)] text-[var(--success)]',
    warning: 'border-[color-mix(in_srgb,var(--warning)_28%,transparent)] bg-[var(--warning-soft)] text-[var(--warning)]',
    danger: 'border-[color-mix(in_srgb,var(--danger)_28%,transparent)] bg-[var(--danger-soft)] text-[var(--danger)]',
    info: 'border-[color-mix(in_srgb,var(--info)_28%,transparent)] bg-[var(--info-soft)] text-[var(--info)]',
  }[tone];
  return <div role={role} className={`rounded-[var(--radius-control)] border px-4 py-3 text-sm leading-relaxed ${toneClass} ${className}`}>{children}</div>;
}

interface SettingsRowProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  value?: string;
  onClick?: () => void;
  children?: ReactNode;
}

export function SettingsRow({ icon, title, description, value, onClick, children }: SettingsRowProps) {
  const content = (
    <>
      {icon && <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-accent-soft text-accent-strong">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-bold text-ink">{title}</span>
        {description && <span className="mt-1 block text-xs leading-relaxed text-ink-secondary">{description}</span>}
      </span>
      {value && <span className="max-w-[40%] truncate text-xs font-bold text-ink-secondary">{value}</span>}
      {children}
      {onClick && <ChevronRight aria-hidden="true" className="h-5 w-5 shrink-0 text-ink-tertiary" />}
    </>
  );
  if (onClick) {
    return <button type="button" onClick={onClick} className="flex min-h-14 w-full items-center gap-3 rounded-[var(--radius-control)] px-3 py-2 text-left transition-colors hover:bg-surface-subtle">{content}</button>;
  }
  return <div className="flex min-h-14 w-full items-center gap-3 rounded-[var(--radius-control)] px-3 py-2">{content}</div>;
}

export { AppDialog } from './ui/Dialog';
export { ActionSheet, BottomSheet, ConfirmationSheet } from './ui/BottomSheet';
export { AutosaveIndicator, EmptyState, LoadingSkeleton, ProgressIndicator, SectionHeader, StatusChip } from './ui/Feedback';
export { FilterChip, SearchField, TagChip } from './ui/Fields';
export { FocusedFlow, PageLayout } from './ui/Layout';
export { GlassSurface, PaperSurface, Surface } from './ui/Surface';
export { Checkbox, SegmentedControl, Switch } from './ui/Controls';
export { ContextMenu, OverflowMenu, menuItemClassName } from './ui/Menu';
export { Toast, ToastViewport } from './ui/Toast';
