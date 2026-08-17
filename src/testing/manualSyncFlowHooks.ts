import type { Diary } from '../types';

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

export const installManualPerformanceHooks = async (): Promise<void> => {
  if (!hooksEnabled()) return;
  const [repositories, adapter, replay, storage] = await Promise.all([
    import('../repositories'),
    import('../sync/core/RepositorySnapshotAdapter'),
    import('../sync/core/replay/PersistentReplayStore'),
    import('../platform/storage'),
  ]);
  window.__loredaysManualPerformance = {
    createRestorePoint: async () => {
      const startedAt = performance.now();
      localStorage.setItem('deardiary.manualPerformance.status', 'creating-restore-point');
      try {
        await repositories.syncApplication.createCurrentRestorePoint();
        const result = { elapsedMs: Math.round(performance.now() - startedAt) };
        localStorage.setItem(
          'deardiary.manualPerformance.lastRestorePoint',
          JSON.stringify(result),
        );
        localStorage.setItem('deardiary.manualPerformance.status', 'restore-point-complete');
        return result;
      } catch (error) {
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        localStorage.setItem('deardiary.manualPerformance.lastError', message);
        localStorage.setItem('deardiary.manualPerformance.status', 'restore-point-failed');
        throw error;
      }
    },
    seedFiveYearHistory: async (options = {}) => {
      const startedAt = performance.now();
      localStorage.setItem('deardiary.manualPerformance.status', 'generating-fixture');
      const diaryCount = Math.max(1, Math.floor(options.diaries || 25));
      const entryCount = Math.max(1, Math.floor(options.entries || 10_000));
      const noteCount = Math.max(0, Math.floor(options.notes || 2_500));
      const current = options.fastNotesOnly
        ? null
        : await repositories.localDiaryRepository.exportSnapshot();
      const start = Date.UTC(2021, 7, 10);
      const dayMs = 86_400_000;
      const dayCount = 1_826;
      const diaries: Diary[] = Array.from({ length: diaryCount }, (_, index) => ({
        id: `p0-diary-${index + 1}`,
        name: `Five Year Diary ${index + 1}`,
        emoji: index % 2 === 0 ? '📔' : '📘',
        color: ['#8A3D55', '#5D7F71', '#9A6A3A', '#59456B'][index % 4],
        isLocked: index % 11 === 0,
        entryCount: 0,
        lastUpdated: 'No entries yet',
      }));
      const entries = Array.from({ length: entryCount }, (_, index) => {
        const diary = diaries[index % diaryCount];
        const createdAt =
          start + (index % dayCount) * dayMs + Math.floor(index / dayCount) * 60_000;
        diary.entryCount += 1;
        diary.lastUpdated = new Date(createdAt).toISOString();
        diary.lastEntryUpdatedAt = createdAt;
        return {
          id: `p0-entry-${index + 1}`,
          diaryId: diary.id,
          date: new Date(createdAt).toISOString().slice(0, 10),
          time: `${String(index % 24).padStart(2, '0')}:${String((index * 7) % 60).padStart(2, '0')}`,
          title: `Five-year memory ${index + 1}`,
          body: `<p>Long-lived account validation entry ${index + 1} with searchable history.</p>`,
          moodName: ['Calm', 'Joyful', 'Reflective'][index % 3],
          moodEmoji: ['😌', '😊', '💭'][index % 3],
          tags: ['five-years', `year-${Math.floor((index % dayCount) / 365) + 1}`],
          photoUris: [],
          photoCount: 0,
          wordCount: 8,
          createdAt,
          updatedAt: createdAt + 30_000,
        };
      });
      const notes = Array.from({ length: noteCount }, (_, index) => ({
        id: `p0-note-${index + 1}`,
        title: `Long-history note ${index + 1}`,
        body: `<p>Five-year reliability validation note ${index + 1}.</p>`,
        isPinned: index % 29 === 0,
        tags: ['five-years'],
        createdAt: start + (index % dayCount) * dayMs,
        updatedAt: start + (index % dayCount) * dayMs + 20_000,
      }));
      if (options.fastNotesOnly) {
        const dataStore = storage.localDataStore as typeof storage.localDataStore & {
          replaceNotesForPerformanceTest?: (fixtureNotes: typeof notes) => Promise<void>;
        };
        if (!dataStore.replaceNotesForPerformanceTest) {
          throw new Error('Fast Notes seeding is available only in the native SQLite test build.');
        }
        localStorage.setItem('deardiary.manualPerformance.status', 'importing-fixture');
        await dataStore.replaceNotesForPerformanceTest(notes);
        const result = {
          diaries: diaryCount,
          entries: entryCount,
          notes: noteCount,
          elapsedMs: Math.round(performance.now() - startedAt),
        };
        localStorage.setItem('deardiary.manualPerformance.lastSeed', JSON.stringify(result));
        localStorage.setItem('deardiary.manualPerformance.status', 'complete');
        return result;
      }
      const snapshot = {
        ...current!,
        diaries,
        entries,
        notes,
        syncRecordVersions: {},
        syncMediaPointers: {},
      };
      const state = adapter.repositorySnapshotToSyncState(snapshot);
      localStorage.setItem('deardiary.manualPerformance.status', 'importing-fixture');
      await repositories.localDiaryRepository.importSnapshotAtomically(snapshot, 'replace', {
        [replay.SYNC_RECORDS_KEY]: state.records,
        [replay.SYNC_VERSIONS_KEY]: state.recordVersions,
        [replay.SYNC_MEDIA_KEY]: state.mediaPointers,
      });
      if (options.publishSync !== false) {
        const settings = await repositories.localDiaryRepository.getSettings();
        localStorage.setItem('deardiary.manualPerformance.status', 'publishing-seed-event');
        await repositories.diaryRepository.saveSettings({
          ...settings,
          customTags: Array.from(new Set([...(settings.customTags || []), 'five-years-p0'])),
        });
        await repositories.eventSyncEngine.flushPendingOutbox();
        await repositories.eventSyncEngine.pullPending();
      }
      if (options.createRestorePoint !== false) {
        localStorage.setItem('deardiary.manualPerformance.status', 'creating-restore-point');
        await repositories.syncApplication.createCurrentRestorePoint();
      }
      const result = {
        diaries: diaryCount,
        entries: entryCount,
        notes: noteCount,
        elapsedMs: Math.round(performance.now() - startedAt),
      };
      localStorage.setItem('deardiary.manualPerformance.lastSeed', JSON.stringify(result));
      localStorage.setItem('deardiary.manualPerformance.status', 'complete');
      return result;
    },
  };
};

declare global {
  interface Window {
    __loredaysManualPerformance?: {
      createRestorePoint(): Promise<{ elapsedMs: number }>;
      seedFiveYearHistory(options?: {
        diaries?: number;
        entries?: number;
        notes?: number;
        publishSync?: boolean;
        createRestorePoint?: boolean;
        fastNotesOnly?: boolean;
      }): Promise<{ diaries: number; entries: number; notes: number; elapsedMs: number }>;
    };
  }
}
