import { localDataStore } from '../platform/storage';
import { LocalDiaryRepository } from './localDiaryRepository';
import { EventSyncEngine } from '../sync/eventSyncEngine';
import { createSyncingDiaryRepository } from './syncingDiaryRepository';

export type {
  DiaryRepository,
  NewDiary,
  NewEntry,
  NewNote,
  RepositoryChangeListener,
  RepositoryImportMode,
  RepositorySnapshot,
} from './DiaryRepository';

export const localDiaryRepository = new LocalDiaryRepository(localDataStore);
export const eventSyncEngine = new EventSyncEngine(localDiaryRepository);
export const diaryRepository = createSyncingDiaryRepository(localDiaryRepository, eventSyncEngine);
