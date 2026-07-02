import { Preferences } from '@capacitor/preferences';
import type { LocalDataStore } from './LocalDataStore';

export class CapacitorPreferencesDataStore implements LocalDataStore {
  async getItem(key: string): Promise<string | null> {
    const result = await Preferences.get({ key });
    return result.value;
  }

  async setItem(key: string, value: string): Promise<void> {
    await Preferences.set({ key, value });
  }

  async removeItem(key: string): Promise<void> {
    await Preferences.remove({ key });
  }

  async clear(): Promise<void> {
    await Preferences.clear();
  }
}
