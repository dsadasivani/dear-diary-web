import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { X } from 'lucide-react';
import OverlayPortal from '../OverlayPortal';

export interface AppDialogProps {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  label?: string;
  className?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
}

export function AppDialog({ open, title, description, onClose, children, footer, label, className = '', initialFocusRef }: AppDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const focusTimer = window.setTimeout(() => (initialFocusRef?.current || closeRef.current)?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable: HTMLElement[] = dialogRef.current
        ? Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'))
        : [];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus();
    };
  }, [initialFocusRef, onClose, open]);

  if (!open) return null;
  return (
    <OverlayPortal>
      <div className="fixed inset-0 z-[120] flex items-end justify-center bg-[var(--scrim)] p-3 md:items-center" onMouseDown={event => event.target === event.currentTarget && onClose()}>
        <section
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={label}
          aria-labelledby={label ? undefined : titleId}
          aria-describedby={description ? descriptionId : undefined}
          className={`surface-modal mobile-overlay-safe max-h-[calc(100dvh-1.5rem)] w-full max-w-lg overflow-y-auto p-5 ${className}`}
        >
          <header className="flex items-start justify-between gap-4 border-b border-[var(--border-subtle)] pb-4">
            <div>
              <h2 id={label ? undefined : titleId} className="type-section-title">{title}</h2>
              {description && <p id={descriptionId} className="type-supporting mt-1">{description}</p>}
            </div>
            <button ref={closeRef} type="button" aria-label="Close dialog" title="Close dialog" onClick={onClose} className="icon-button shrink-0"><X className="h-5 w-5" /></button>
          </header>
          <div className="py-5">{children}</div>
          {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-[var(--border-subtle)] pt-4">{footer}</footer>}
        </section>
      </div>
    </OverlayPortal>
  );
}
