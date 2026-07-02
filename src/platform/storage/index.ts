import { isNativePlatform } from '../platform';
import type { LocalDataStore } from './LocalDataStore';
import { CapacitorPreferencesDataStore } from './capacitorPreferencesDataStore';
import { WebLocalDataStore } from './webLocalDataStore';

export type { LocalDataStore } from './LocalDataStore';

export const localDataStore: LocalDataStore = isNativePlatform()
  ? new CapacitorPreferencesDataStore()
  : new WebLocalDataStore();
