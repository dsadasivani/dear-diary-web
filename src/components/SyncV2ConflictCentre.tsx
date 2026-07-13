import type { SyncConflict } from '../sync/v2';

export interface SyncV2ConflictCentreProps {
  conflicts: SyncConflict[];
  busyConflictId?: string;
  onKeepLocal(conflict: SyncConflict): void | Promise<void>;
  onKeepRemote(conflict: SyncConflict): void | Promise<void>;
  onKeepBoth(conflict: SyncConflict): void | Promise<void>;
  onManualMerge?(conflict: SyncConflict): void | Promise<void>;
  onMarkResolved(conflict: SyncConflict): void | Promise<void>;
}

export const SyncV2ConflictCentre = ({
  conflicts,
  busyConflictId,
  onKeepLocal,
  onKeepRemote,
  onKeepBoth,
  onManualMerge,
  onMarkResolved,
}: SyncV2ConflictCentreProps) => {
  if (conflicts.length === 0) return null;
  return (
    <section aria-labelledby="sync-v2-conflict-centre" className="mt-3 space-y-2">
      <h3 id="sync-v2-conflict-centre" className="text-[9px] font-bold uppercase tracking-wider text-amber-800 dark:text-amber-300">
        Conflict centre
      </h3>
      {conflicts.map(conflict => {
        const busy = busyConflictId === conflict.conflictId;
        return (
          <article key={conflict.conflictId} className="rounded-xl border border-amber-200 bg-amber-50/80 p-3 text-[10px] dark:border-amber-900/50 dark:bg-amber-950/20">
            <p className="font-bold uppercase tracking-wider text-amber-800 dark:text-amber-300">
              {conflict.recordType} conflict
            </p>
            <p className="mt-1 text-brand-text-muted">
              Local base version {conflict.localBaseVersion}; latest remote version {conflict.remoteVersion}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" disabled={busy} onClick={() => void onKeepLocal(conflict)}>Keep local</button>
              <button type="button" disabled={busy} onClick={() => void onKeepRemote(conflict)}>Keep remote</button>
              <button type="button" disabled={busy} onClick={() => void onKeepBoth(conflict)}>Keep both</button>
              {onManualMerge && (conflict.recordType === 'ENTRY' || conflict.recordType === 'NOTE') && (
                <button type="button" disabled={busy} onClick={() => void onManualMerge(conflict)}>Manual merge</button>
              )}
              <button type="button" disabled={busy} onClick={() => void onMarkResolved(conflict)}>Mark resolved</button>
            </div>
          </article>
        );
      })}
    </section>
  );
};
