import { Xmark as X } from 'iconoir-react';

export type ToastTone = 'success' | 'error' | 'info' | 'warning';

export interface ToastMessage {
  id: string;
  message: string;
  tone: ToastTone;
}

interface ToastProps extends ToastMessage {
  key?: string;
  onDismiss: (id: string) => void;
}

export function Toast({ id, message, tone, onDismiss }: ToastProps) {
  const toneClass = {
    success: 'border-[var(--success)] bg-[var(--success-soft)] text-[var(--success)]',
    error: 'border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)]',
    info: 'border-[var(--info)] bg-surface-overlay text-ink',
    warning: 'border-[var(--warning)] bg-[var(--warning-soft)] text-[var(--warning)]',
  }[tone];
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`pointer-events-auto flex min-h-12 w-full items-center gap-3 rounded-[var(--radius-control)] border px-4 py-3 shadow-[var(--elevation-floating)] ${toneClass}`}
    >
      <p className="min-w-0 flex-1 text-sm font-semibold">{message}</p>
      <button
        type="button"
        aria-label="Dismiss notification"
        className="icon-button"
        onClick={() => onDismiss(id)}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export function ToastViewport({
  messages,
  onDismiss,
}: {
  messages: ToastMessage[];
  onDismiss: (id: string) => void;
}) {
  return (
    <div
      aria-label="Notifications"
      className="pointer-events-none fixed bottom-[calc(6.25rem+var(--safe-area-inset-bottom))] left-4 right-4 z-[150] flex flex-col gap-2 md:bottom-6 md:left-auto md:right-6 md:w-[min(24rem,calc(100vw-3rem))]"
    >
      {messages.map((message) => (
        <Toast key={message.id} {...message} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
