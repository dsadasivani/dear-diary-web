import { WarningCircle as AlertCircle, RefreshDouble as LoaderCircle } from 'iconoir-react';
import type { SyncCatchUpProgress } from '../sync/eventSyncEngine';
import OverlayPortal from './OverlayPortal';

export type InitialSyncGate = SyncCatchUpProgress & { allowOffline: boolean };

export default function SyncCatchUpOverlay({
  gate,
  onRetry,
  onContinueOffline,
}: {
  gate: InitialSyncGate | null;
  onRetry: () => void;
  onContinueOffline: () => void;
}) {
  if (!gate) return null;
  const target = gate.targetSequence || 0;
  const percent = target > 0 ? Math.min(100, Math.round((gate.appliedSequence / target) * 100)) : 0;
  const failed = gate.phase === 'failed';
  return (
    <OverlayPortal>
      <div
        className="fixed inset-0 z-[125] flex items-center justify-center bg-brand-bg/92 px-5 backdrop-blur-md"
        role={failed ? 'alert' : 'status'}
        aria-live="polite"
        aria-busy={!failed}
      >
        <div className="w-full max-w-sm rounded-3xl border border-brand-border bg-white/95 p-6 text-center shadow-2xl dark:bg-brand-card-bg/95">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-pink/10 text-brand-pink">
            {failed ? (
              <AlertCircle className="h-6 w-6" />
            ) : (
              <LoaderCircle className="h-6 w-6 animate-spin" />
            )}
          </span>
          <h2 className="mt-4 font-serif-diary text-xl font-bold text-brand-plum dark:text-brand-text">
            {failed ? 'Sync paused' : 'Syncing your diary'}
          </h2>
          <p className="mt-2 text-sm text-brand-text-muted">
            {failed
              ? gate.error || 'Your latest encrypted data could not be loaded.'
              : target > 0
                ? `Applied ${gate.appliedSequence} of ${target} encrypted updates.`
                : 'Checking for your latest encrypted updates…'}
          </p>
          {!failed && target > 0 && (
            <div
              className="mt-5 h-2 overflow-hidden rounded-full bg-brand-border/60"
              aria-label="Initial sync progress"
            >
              <div
                className="h-full rounded-full bg-brand-sage transition-[width]"
                style={{ width: `${percent}%` }}
              />
            </div>
          )}
          {failed && (
            <div className="mt-5 grid gap-2">
              <button
                type="button"
                onClick={onRetry}
                className="min-h-11 rounded-xl bg-brand-sage px-4 text-sm font-bold text-white"
              >
                Retry sync
              </button>
              {gate.allowOffline && (
                <button
                  type="button"
                  onClick={onContinueOffline}
                  className="min-h-11 rounded-xl border border-brand-border px-4 text-sm font-bold text-brand-plum dark:text-brand-text"
                >
                  Use offline copy
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </OverlayPortal>
  );
}
