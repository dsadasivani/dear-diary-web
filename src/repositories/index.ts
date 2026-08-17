import { localDataStore } from '../platform/storage';
import { LocalDiaryRepository } from './localDiaryRepository';
import { EventSyncEngine } from '../sync/eventSyncEngine';
import { createSyncingDiaryRepository } from './syncingDiaryRepository';
import { PersistentOutboxRepository } from '../sync/outbox';
import { SyncApplicationLifecycle } from '../sync/core/SyncApplicationLifecycle';
import { createRepositoryCapabilities } from './capabilities';
import { createConfiguredTelemetry } from '../sync/config';

export type {
  ApplyLocalMutationWithOutboxInput,
  DiaryRepository,
  DiaryStatistics,
  DiarySummary,
  DistributionRow,
  EntryListOptions,
  EntrySummary,
  GlobalStatistics,
  HomeSummary,
  HomeRecentPhoto,
  NewDiary,
  NewEntry,
  NewNote,
  NoteListOptions,
  NoteSummary,
  PageOptions,
  PageResult,
  PreservedSyncConflict,
  RepositoryChange,
  RepositoryChangeListener,
  RepositoryImportMode,
  RepositorySnapshot,
  SearchFilters,
  StatisticsFilters,
  SyncStatusSummary,
  TypedRepositoryChangeListener,
  WritingHeatmapRow,
} from './DiaryRepository';
export type {
  BackupRepository,
  DiaryReader,
  DiaryWriter,
  EntryReader,
  EntryWriter,
  NotesRepository,
  RepositoryCapabilities,
  SearchRepository,
  SecurityRepository,
  SettingsRepository,
  StatisticsRepository,
  SyncRepository,
} from './capabilities';

export const localDiaryRepository = new LocalDiaryRepository(localDataStore);
export const operationsRepository = new PersistentOutboxRepository(localDataStore);
export const eventSyncEngine = new EventSyncEngine(localDiaryRepository, {
  outboxRepository: operationsRepository,
});
export const diaryRepository = createSyncingDiaryRepository(localDiaryRepository, eventSyncEngine);
export const repositoryCapabilities = createRepositoryCapabilities(diaryRepository);
export const syncApplication = new SyncApplicationLifecycle(
  localDataStore,
  localDiaryRepository,
  operationsRepository,
  eventSyncEngine,
  createConfiguredTelemetry(),
);
