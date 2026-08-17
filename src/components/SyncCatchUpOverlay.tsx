import { WarningCircle as AlertCircle, RefreshDouble as LoaderCircle } from 'iconoir-react';
import { useEffect, useState } from 'react';
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
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!gate || gate.phase === 'failed') return;
    const timer = setTimeout(() => setSlow(true), 8_000);
    return () => clearTimeout(timer);
  }, [gate?.phase, gate?.startingSequence, gate?.targetSequence]);
  if (!gate) return null;
  const target = gate.targetSequence || gate.startingSequence;
  const total = gate.totalEvents ?? Math.max(0, target - gate.startingSequence);
  const completed = gate.appliedEvents ?? Math.max(0, gate.appliedSequence - gate.startingSequence);
  const percent = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  const failed = gate.phase === 'failed';
  const progressMessage = (() => {
    if (gate.phase === 'restoring-snapshot') return 'Downloading your encrypted backup…';
    if (gate.phase === 'opening' || gate.phase === 'complete') return 'Opening your diary…';
    if (total > 0) return `Applying recent changes — ${completed} of ${total}`;
    return 'Checking for recent encrypted changes…';
  })();
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
              : progressMessage}
          </p>
          {!failed && slow && (
            <div className="mt-4 rounded-2xl bg-brand-blush-light/70 px-4 py-3 text-left text-xs leading-relaxed text-brand-text-muted dark:bg-brand-bg/45">
              <p className="font-bold text-brand-plum dark:text-brand-text">
                Still reconnecting securely
              </p>
              <p className="mt-1">
                A transfer is taking longer than usual. Loredays is retrying automatically; your
                local changes remain safe.
              </p>
            </div>
          )}
          {!failed && total > 0 && (
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
          {!failed && slow && gate.allowOffline && (
            <button
              type="button"
              onClick={onContinueOffline}
              className="mt-4 min-h-11 w-full rounded-xl border border-brand-border px-4 text-sm font-bold text-brand-plum dark:text-brand-text"
            >
              Use offline copy while retrying
            </button>
          )}
        </div>
      </div>
    </OverlayPortal>
  );
}
