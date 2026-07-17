import { useEffect, useRef, useState } from 'react';
import { AlertCircle, LoaderCircle, ShieldCheck, X } from 'lucide-react';
import OverlayPortal from './OverlayPortal';

interface PassphraseConfirmationDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  loading: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: (passphrase: string) => void;
}

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export default function PassphraseConfirmationDialog({
  open,
  title,
  description,
  confirmLabel,
  loading,
  error,
  onCancel,
  onConfirm,
}: PassphraseConfirmationDialogProps) {
  const [passphrase, setPassphrase] = useState('');
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) {
      setPassphrase('');
      return;
    }
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      setPassphrase('');
      previousFocusRef.current?.focus?.();
      previousFocusRef.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (!loading) onCancel();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) || [],
      ) as HTMLElement[];
      const enabledFocusable = focusable
        .filter(element => !element.hasAttribute('disabled'));
      if (enabledFocusable.length === 0) return;
      const first = enabledFocusable[0];
      const last = enabledFocusable[enabledFocusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [loading, onCancel, open]);

  if (!open) return null;

  const trimmedPassphrase = passphrase.trim();

  return (
    <OverlayPortal>
      <div className="fixed inset-0 z-[140] flex items-center justify-center bg-brand-plum/40 px-5 backdrop-blur-sm">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="passphrase-confirm-title"
          aria-describedby="passphrase-confirm-description"
          className="w-full max-w-md rounded-2xl border border-brand-border bg-white p-5 shadow-2xl dark:bg-brand-card-bg"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 gap-3">
              <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-300">
                <ShieldCheck className="h-5 w-5" />
              </span>
              <div>
                <h2 id="passphrase-confirm-title" className="text-sm font-extrabold text-brand-plum dark:text-brand-text">
                  {title}
                </h2>
                <p id="passphrase-confirm-description" className="mt-1 text-xs leading-relaxed text-brand-text-muted">
                  {description}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onCancel}
              disabled={loading}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-brand-border text-brand-text-muted disabled:opacity-40"
              aria-label="Cancel"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <form
            className="mt-5 space-y-4"
            onSubmit={event => {
              event.preventDefault();
              if (trimmedPassphrase && !loading) onConfirm(trimmedPassphrase);
            }}
          >
            <div>
              <label htmlFor="recovery-passphrase-confirmation" className="text-xs font-bold uppercase text-brand-sage">
                Recovery passphrase
              </label>
              <input
                ref={inputRef}
                id="recovery-passphrase-confirmation"
                type="password"
                autoComplete="current-password"
                value={passphrase}
                onChange={event => setPassphrase(event.target.value)}
                disabled={loading}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? 'passphrase-confirm-error' : undefined}
                className="mt-1 w-full rounded-lg border border-brand-border bg-brand-bg px-3 py-2 text-sm text-brand-plum outline-none focus:border-brand-pink disabled:opacity-60 dark:text-brand-text"
              />
            </div>

            {error && (
              <p id="passphrase-confirm-error" role="alert" className="flex items-start gap-2 text-xs font-semibold text-red-600 dark:text-red-300">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </p>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onCancel}
                disabled={loading}
                className="rounded-lg border border-brand-border px-4 py-2 text-xs font-bold text-brand-text-muted disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading || trimmedPassphrase.length === 0}
                className="flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-xs font-bold text-white disabled:opacity-40"
              >
                {loading && <LoaderCircle className="h-4 w-4 animate-spin" />}
                <span>{loading ? 'Confirming...' : confirmLabel}</span>
              </button>
            </div>
          </form>
        </div>
      </div>
    </OverlayPortal>
  );
}
