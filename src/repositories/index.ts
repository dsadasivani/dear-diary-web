import { localDataStore } from '../platform/storage';
import { LocalDiaryRepository } from './localDiaryRepository';
import { EventSyncEngine } from '../sync/eventSyncEngine';
import { createSyncingDiaryRepository } from './syncingDiaryRepository';

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
export const eventSyncEngine = new EventSyncEngine(localDiaryRepository);
export const diaryRepository = createSyncingDiaryRepository(localDiaryRepository, eventSyncEngine);
