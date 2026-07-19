import { localDataStore } from '../platform/storage';
import { LocalDiaryRepository } from './localDiaryRepository';
import { EventSyncEngine } from '../sync/eventSyncEngine';
import { createSyncingDiaryRepository } from './syncingDiaryRepository';
import { PersistentOutboxRepository } from '../sync/outbox';
import { SyncV2ApplicationLifecycle } from '../sync/v2/SyncV2ApplicationLifecycle';
import { createRepositoryCapabilities } from './capabilities';

export type {
  AcknowledgeLocalMutationInput,
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
export const outboxV2Repository = new PersistentOutboxRepository(localDataStore);
export const eventSyncEngine = new EventSyncEngine(localDiaryRepository, {
  outboxRepository: outboxV2Repository,
});
export const diaryRepository = createSyncingDiaryRepository(localDiaryRepository, eventSyncEngine);
export const repositoryCapabilities = createRepositoryCapabilities(diaryRepository);
export const syncV2Application = new SyncV2ApplicationLifecycle(
  localDataStore,
  localDiaryRepository,
  outboxV2Repository,
  eventSyncEngine,
);
