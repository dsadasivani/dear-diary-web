import { isNativePlatform } from '../platform';
import { localDataStore } from '../platform/storage';

export const PERSISTED_UI_PREFERENCE_KEYS = ['deardiary_diary_viewmode'] as const;

export const hydrateNativeUiPreferences = async (): Promise<void> => {
  if (!isNativePlatform()) {
    return;
  }

  await Promise.all(
    PERSISTED_UI_PREFERENCE_KEYS.map(async (key) => {
      const value = await localDataStore.getItem(key);
      if (value !== null) {
        localStorage.setItem(key, value);
      }
    }),
  );
};

export const persistNativeLocalStorageItem = (key: string, value: string): void => {
  if (!isNativePlatform()) {
    return;
  }

  localDataStore.setItem(key, value).catch((error) => {
    console.warn(`Failed to persist ${key} to native storage:`, error);
  });
};

export const removeNativeLocalStorageItem = (key: string): void => {
  if (!isNativePlatform()) {
    return;
  }

  localDataStore.removeItem(key).catch((error) => {
    console.warn(`Failed to remove ${key} from native storage:`, error);
  });
};
