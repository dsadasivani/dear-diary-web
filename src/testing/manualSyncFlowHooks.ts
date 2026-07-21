export type ManualSyncFlowCheckpoint =
  | 'md021:after-recovery-registered'
  | 'md021:after-local-empty-state'
  | 'md021:after-sync-secrets-saved'
  | 'md021:after-restore-completed'
  | 'md021:after-cursor-updated'
  | 'md021:after-server-finalized'
  | 'md022:after-rotation-begun'
  | 'md022:after-recovery-package-committed'
  | 'md022:after-companion-packages-committed'
  | 'md022:after-future-key-staged'
  | 'md022:after-server-finalized';

const PAUSE_AT_KEY = 'deardiary.manualTest.pauseAt';
const LAST_CHECKPOINT_KEY = 'deardiary.manualTest.lastCheckpoint';

const hooksEnabled = (): boolean =>
  typeof window !== 'undefined' && import.meta.env?.VITE_ENABLE_MD_FLOW_HOOKS === 'true';

const getPauseTarget = (): string | null => {
  try {
    return window.localStorage.getItem(PAUSE_AT_KEY)?.trim() || null;
  } catch {
    return null;
  }
};

const markCheckpointHit = (checkpoint: ManualSyncFlowCheckpoint): void => {
  try {
    window.localStorage.removeItem(PAUSE_AT_KEY);
    window.localStorage.setItem(
      LAST_CHECKPOINT_KEY,
      JSON.stringify({
        checkpoint,
        hitAt: new Date().toISOString(),
      }),
    );
  } catch {
    // Manual force-stop hooks are diagnostic only.
  }
};

export const manualSyncFlowCheckpoint = async (
  checkpoint: ManualSyncFlowCheckpoint,
): Promise<void> => {
  if (!hooksEnabled() || getPauseTarget() !== checkpoint) return;

  markCheckpointHit(checkpoint);
  window.dispatchEvent(
    new CustomEvent('deardiary-manual-test-checkpoint', { detail: { checkpoint } }),
  );
  console.warn(`Manual sync checkpoint reached: ${checkpoint}. Force-stop com.deardiary.app now.`);
  await new Promise<void>(() => undefined);
};
