import { localDataStore } from '../platform/storage';
import { LocalDiaryRepository } from './localDiaryRepository';

export type {
  DiaryRepository,
  NewDiary,
  NewEntry,
  NewNote,
  RepositoryChangeListener,
  RepositoryImportMode,
  RepositorySnapshot,
} from './DiaryRepository';

export const diaryRepository = new LocalDiaryRepository(localDataStore);
