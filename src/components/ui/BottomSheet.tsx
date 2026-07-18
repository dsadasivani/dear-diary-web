import { useEffect, useRef, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { X } from 'lucide-react';
import OverlayPortal from '../OverlayPortal';
import { motionTransitions, reducedMotionVariants, sheetVariants } from './motion';

interface BottomSheetProps {
  open: boolean;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  label?: string;
  className?: string;
}

export function BottomSheet({ open, title, description, children, footer, onClose, label, className = '' }: BottomSheetProps) {
  const sheetRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => closeRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab') return;
      const focusable: HTMLElement[] = sheetRef.current
        ? Array.from(sheetRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'))
        : [];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus();
    };
  }, [onClose, open]);

  return (
    <AnimatePresence>
      {open && (
        <OverlayPortal>
          <motion.div
            className="fixed inset-0 z-[120] flex items-end justify-center bg-[var(--scrim)] md:items-center md:p-4"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={reducedMotion ? { duration: 0.01 } : motionTransitions.state}
            onMouseDown={event => event.target === event.currentTarget && onClose()}
          >
            <motion.section
              ref={sheetRef}
              role="dialog"
              aria-modal="true"
              aria-label={label}
              aria-labelledby={label ? undefined : 'bottom-sheet-title'}
              variants={reducedMotion ? reducedMotionVariants : sheetVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
              transition={reducedMotion ? { duration: 0.01 } : motionTransitions.sheet}
              className={`surface-glass-strong mobile-overlay-safe max-h-[min(88dvh,48rem)] w-full overflow-y-auto rounded-[var(--radius-sheet)] px-5 pb-5 pt-3 md:max-w-lg md:rounded-[var(--radius-modal)] ${className}`}
            >
              <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-[var(--border-strong)] md:hidden" aria-hidden="true" />
              <header className="flex items-start justify-between gap-4 border-b border-[var(--border-subtle)] pb-4">
                <div>
                  <h2 id={label ? undefined : 'bottom-sheet-title'} className="type-section-title">{title}</h2>
                  {description && <p className="type-supporting mt-1">{description}</p>}
                </div>
                <button ref={closeRef} type="button" onClick={onClose} className="icon-button" aria-label="Close sheet"><X className="h-5 w-5" /></button>
              </header>
              <div className="py-5">{children}</div>
              {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-[var(--border-subtle)] pt-4">{footer}</footer>}
            </motion.section>
          </motion.div>
        </OverlayPortal>
      )}
    </AnimatePresence>
  );
}

export const ActionSheet = BottomSheet;

interface ConfirmationSheetProps extends Omit<BottomSheetProps, 'children' | 'footer'> {
  message: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
}

export function ConfirmationSheet({ message, confirmLabel, cancelLabel = 'Cancel', destructive = false, onConfirm, onClose, ...props }: ConfirmationSheetProps) {
  return (
    <BottomSheet
      {...props}
      onClose={onClose}
      footer={(
        <>
          <button type="button" onClick={onClose} className="inline-flex min-h-11 items-center justify-center rounded-[var(--radius-control)] px-4 text-sm font-bold text-ink-secondary hover:bg-surface-subtle">{cancelLabel}</button>
          <button type="button" onClick={onConfirm} className={`inline-flex min-h-11 items-center justify-center rounded-[var(--radius-control)] px-4 text-sm font-bold text-white ${destructive ? 'bg-[var(--danger)]' : 'bg-accent'}`}>{confirmLabel}</button>
        </>
      )}
    >
      <div className="text-sm leading-relaxed text-ink-secondary">{message}</div>
    </BottomSheet>
  );
}
