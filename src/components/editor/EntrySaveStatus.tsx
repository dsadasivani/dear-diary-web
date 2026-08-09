import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  WarningCircle as AlertCircle,
  Check,
  Cloud,
  CloudUpload,
  RefreshDouble as LoaderCircle,
} from 'iconoir-react';
import { motionTransitions } from '../ui/motion';

export type EntrySaveState =
  'dirty' | 'preparing-media' | 'saving' | 'saved' | 'error' | 'offline-pending' | 'sync-pending';

const statePresentation = {
  dirty: { label: 'Unsaved changes', Icon: CloudUpload, tone: 'text-[var(--color-warning)]' },
  'preparing-media': {
    label: 'Preparing photo on this device…',
    Icon: LoaderCircle,
    tone: 'text-[var(--color-syncing)]',
  },
  saving: { label: 'Saving locally…', Icon: LoaderCircle, tone: 'text-ink-secondary' },
  saved: { label: 'Saved privately', Icon: Check, tone: 'text-[var(--color-success)]' },
  error: { label: 'Could not save', Icon: AlertCircle, tone: 'text-[var(--color-danger)]' },
  'offline-pending': {
    label: 'Saved locally · companion sync waits for connection',
    Icon: Cloud,
    tone: 'text-[var(--color-offline)]',
  },
  'sync-pending': {
    label: 'Saved locally · syncing to companion',
    Icon: CloudUpload,
    tone: 'text-[var(--color-syncing)]',
  },
} as const;

export default function EntrySaveStatus({
  state,
  message,
  lastSavedAt,
}: {
  state: EntrySaveState;
  message?: string;
  lastSavedAt?: Date | null;
}) {
  const reducedMotion = useReducedMotion();
  const presentation = statePresentation[state];
  const Icon = presentation.Icon;
  const label =
    message ||
    (state === 'saved' && lastSavedAt
      ? `Saved privately at ${lastSavedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
      : presentation.label);

  return (
    <span
      role={state === 'error' ? 'alert' : 'status'}
      aria-live="polite"
      aria-label={label}
      title={label}
      className={`inline-flex min-h-7 min-w-0 max-w-full items-center gap-1.5 text-xs font-semibold ${presentation.tone}`}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={state}
          className="inline-flex min-w-0 items-center gap-1.5"
          initial={reducedMotion ? false : { opacity: 0, y: 3 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reducedMotion ? undefined : { opacity: 0, y: -3 }}
          transition={reducedMotion ? { duration: 0.01 } : motionTransitions.state}
        >
          <Icon
            aria-hidden="true"
            className={`h-3.5 w-3.5 ${state === 'saving' || state === 'preparing-media' ? 'animate-spin' : ''}`}
          />
          <span className="truncate">{label}</span>
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
