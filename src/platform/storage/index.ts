import { isNativePlatform } from '../platform';
import type { LocalDataStore } from './LocalDataStore';
import { NativeSQLiteDataStore } from './nativeSQLiteDataStore';
import { WebLocalDataStore } from './webLocalDataStore';

export type { LocalDataStore } from './LocalDataStore';

export const localDataStore: LocalDataStore = isNativePlatform()
  ? new NativeSQLiteDataStore()
  : new WebLocalDataStore();
