import type { DiaryRepository } from './DiaryRepository';

export type DiaryReader = Pick<
  DiaryRepository,
  'listDiaries' | 'listDiarySummaries' | 'getDiary' | 'getDiaryStatistics'
>;
export type DiaryWriter = Pick<DiaryRepository, 'createDiary' | 'updateDiary' | 'deleteDiary'>;
export type EntryReader = Pick<
  DiaryRepository,
  'listRecentEntries' | 'listEntriesByDiary' | 'listEntriesByMonth' | 'getEntry'
>;
export type EntryWriter = Pick<DiaryRepository, 'createEntry' | 'updateEntry' | 'deleteEntry'>;
export type NotesRepository = Pick<
  DiaryRepository,
  'listNotes' | 'getNote' | 'createNote' | 'updateNote' | 'deleteNote'
>;
export type SearchRepository = Pick<DiaryRepository, 'searchEntries' | 'searchNotes'>;
export type StatisticsRepository = Pick<
  DiaryRepository,
  | 'getHomeSummary'
  | 'getGlobalStatistics'
  | 'getDiaryStatistics'
  | 'getMoodDistribution'
  | 'getTagDistribution'
  | 'getWritingHeatmap'
>;
export type SettingsRepository = Pick<
  DiaryRepository,
  | 'getSettings'
  | 'saveSettings'
  | 'getUserProfile'
  | 'saveUserProfile'
  | 'getDriveBackupSettings'
  | 'saveDriveBackupSettings'
>;
export type SecurityRepository = Pick<DiaryRepository, 'getSecurityConfig' | 'saveSecurityConfig'>;
export type SyncRepository = Pick<
  DiaryRepository,
  | 'getSyncStatusSummary'
  | 'getSyncHealth'
  | 'updateSyncHealth'
  | 'listPreservedSyncConflicts'
  | 'resolvePreservedSyncConflict'
  | 'retryPreservedSyncConflict'
>;
export type BackupRepository = Pick<
  DiaryRepository,
  'exportSnapshot' | 'importSnapshot' | 'previewPortableMerge' | 'mergePortableSnapshot'
>;

export interface RepositoryCapabilities {
  diaries: DiaryReader & DiaryWriter;
  entries: EntryReader & EntryWriter;
  notes: NotesRepository;
  search: SearchRepository;
  statistics: StatisticsRepository;
  settings: SettingsRepository;
  security: SecurityRepository;
  sync: SyncRepository;
  backup: BackupRepository;
}

/**
 * The current repository already implements every capability. Returning the same instance under
 * narrower contracts keeps `this` binding intact and lets screens migrate independently without
 * changing persistence or synchronization behavior.
 */
export const createRepositoryCapabilities = (
  repository: DiaryRepository,
): RepositoryCapabilities => ({
  diaries: repository,
  entries: repository,
  notes: repository,
  search: repository,
  statistics: repository,
  settings: repository,
  security: repository,
  sync: repository,
  backup: repository,
});
