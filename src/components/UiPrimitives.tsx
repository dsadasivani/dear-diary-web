import React, { useEffect, useRef, type ReactNode } from 'react';
import { ChevronRight, X } from 'lucide-react';
import OverlayPortal from './OverlayPortal';

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
    primary: 'border-brand-sage bg-brand-sage text-white hover:bg-brand-sage-dark',
    secondary: 'border-brand-border bg-brand-card-bg text-brand-plum hover:border-brand-sage dark:text-brand-text',
    danger: 'border-red-600 bg-red-600 text-white hover:bg-red-700',
    quiet: 'border-transparent bg-transparent text-brand-sage hover:bg-brand-sage-light/60',
  }[tone];
  return (
    <button
      {...props}
      type={type}
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-bold transition-colors disabled:opacity-45 md:min-h-9 ${toneClass} ${className}`}
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
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
  role?: 'status' | 'alert';
  className?: string;
}

export function StatusNotice({ children, tone = 'neutral', role = 'status', className = '' }: StatusNoticeProps) {
  const toneClass = {
    neutral: 'border-brand-border bg-brand-card-bg text-brand-text-muted',
    success: 'border-brand-sage/30 bg-brand-sage-light text-brand-sage-dark',
    warning: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/25 dark:text-amber-200',
    danger: 'border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/25 dark:text-red-200',
  }[tone];
  return <div role={role} className={`rounded-xl border px-4 py-3 text-sm leading-relaxed ${toneClass} ${className}`}>{children}</div>;
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
      {icon && <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-sage-light text-brand-sage-dark">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-bold text-brand-plum dark:text-brand-text">{title}</span>
        {description && <span className="mt-1 block text-xs leading-relaxed text-brand-text-muted">{description}</span>}
      </span>
      {value && <span className="max-w-[40%] truncate text-xs font-bold text-brand-text-muted">{value}</span>}
      {children}
      {onClick && <ChevronRight aria-hidden="true" className="h-5 w-5 shrink-0 text-brand-text-muted" />}
    </>
  );
  if (onClick) {
    return <button type="button" onClick={onClick} className="flex min-h-14 w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-brand-sage-light/50">{content}</button>;
  }
  return <div className="flex min-h-14 w-full items-center gap-3 rounded-xl px-3 py-2">{content}</div>;
}

interface AppDialogProps {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  label?: string;
  className?: string;
}

export function AppDialog({ open, title, description, onClose, children, footer, label, className = '' }: AppDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const focusTimer = window.setTimeout(() => closeRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab') return;
      const focusable: HTMLElement[] = dialogRef.current
        ? Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'))
        : [];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => { window.clearTimeout(focusTimer); document.removeEventListener('keydown', onKeyDown); previous?.focus(); };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <OverlayPortal>
      <div className="fixed inset-0 z-[120] flex items-end justify-center bg-black/45 p-3 backdrop-blur-sm md:items-center" onMouseDown={event => event.target === event.currentTarget && onClose()}>
        <section ref={dialogRef} role="dialog" aria-modal="true" aria-label={label} aria-labelledby={label ? undefined : 'app-dialog-title'} className={`surface-modal mobile-overlay-safe max-h-[calc(100dvh-1.5rem)] w-full max-w-lg overflow-y-auto p-5 ${className}`}>
          <header className="flex items-start justify-between gap-4 border-b border-brand-border pb-4">
            <div>
              <h2 id={label ? undefined : 'app-dialog-title'} className="font-serif-diary text-2xl font-semibold text-brand-plum dark:text-brand-text">{title}</h2>
              {description && <p className="mt-1 text-sm leading-relaxed text-brand-text-muted">{description}</p>}
            </div>
            <IconButton ref={closeRef} label="Close dialog" onClick={onClose}><X className="h-5 w-5" /></IconButton>
          </header>
          <div className="py-5">{children}</div>
          {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-brand-border pt-4">{footer}</footer>}
        </section>
      </div>
    </OverlayPortal>
  );
}
