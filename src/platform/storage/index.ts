import { isNativePlatform } from '../platform';
import type { LocalDataStore } from './LocalDataStore';
import { CapacitorPreferencesDataStore } from './capacitorPreferencesDataStore';
import { NativeSQLiteDataStore } from './nativeSQLiteDataStore';
import { WebLocalDataStore } from './webLocalDataStore';

export type { LocalDataStore } from './LocalDataStore';

const preferencesFallback = new CapacitorPreferencesDataStore();

export const localDataStore: LocalDataStore = isNativePlatform()
  ? new NativeSQLiteDataStore(preferencesFallback)
  : new WebLocalDataStore();
