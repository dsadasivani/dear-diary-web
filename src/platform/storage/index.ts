import { isNativePlatform } from '../platform';
import type { LocalDataStore } from './LocalDataStore';
import { NativeSQLiteDataStore } from './nativeSQLiteDataStore';
import { WebLocalDataStore } from './webLocalDataStore';

export type {
  LocalDataStore,
  LocalCanonicalSnapshotPage,
  LocalCanonicalSnapshotRecord,
  LocalCanonicalSnapshotRecordKind,
  LocalEntryProjection,
  LocalEntryQueryOptions,
  LocalNoteProjection,
  LocalNoteQueryOptions,
  LocalQueryPageOptions,
  LocalQueryPageResult,
  LocalStructuredRecordMutation,
} from './LocalDataStore';

export const localDataStore: LocalDataStore = isNativePlatform()
  ? new NativeSQLiteDataStore()
  : new WebLocalDataStore();
