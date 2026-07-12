import { localDataStore } from '../platform/storage';
import { LocalDiaryRepository } from './localDiaryRepository';
import { EventSyncEngine } from '../sync/eventSyncEngine';
import { createSyncingDiaryRepository } from './syncingDiaryRepository';
import { PersistentOutboxRepository } from '../sync/outbox';

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

export const localDiaryRepository = new LocalDiaryRepository(localDataStore);
export const outboxV2Repository = new PersistentOutboxRepository(localDataStore);
export const eventSyncEngine = new EventSyncEngine(localDiaryRepository, { outboxRepository: outboxV2Repository });
export const diaryRepository = createSyncingDiaryRepository(localDiaryRepository, eventSyncEngine);
