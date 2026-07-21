import { diaryRepository } from '../repositories';
import { localDataStore } from '../platform/storage';
import { isNativePlatform } from '../platform';
import { persistMediaDataUri } from './mediaStorage';
import type { MediaKind } from './mediaStorage';

const MIGRATION_STATUS_KEY = 'deardiary_media_file_migration_v1';

export interface LegacyMediaMigrationResult {
  status: 'skipped' | 'complete' | 'incomplete';
  scanned: number;
  migrated: number;
  remaining: number;
  completedAt?: number;
}

const isDataUri = (value: string | undefined): value is string =>
  Boolean(value?.startsWith('data:'));

const getMimeType = (dataUri: string, fallback: string): string => {
  const match = /^data:([^;,]+)/.exec(dataUri);
  return match?.[1] || fallback;
};

export const migrateLegacyDataUriMedia = async (): Promise<LegacyMediaMigrationResult> => {
  if (!isNativePlatform()) {
    return { status: 'skipped', scanned: 0, migrated: 0, remaining: 0 };
  }

  const existingStatus = await localDataStore.getItem(MIGRATION_STATUS_KEY);
  if (existingStatus) {
    try {
      const parsed = JSON.parse(existingStatus) as LegacyMediaMigrationResult;
      if (parsed.status === 'complete') return parsed;
    } catch {
      // Invalid status is safe to replace after another verification pass.
    }
  }

  const snapshot = await diaryRepository.exportSnapshot();
  let scanned = 0;
  let migrated = 0;
  let remaining = 0;

  const migrateUri = async (
    uri: string | undefined,
    kind: MediaKind,
    fallbackMime: string,
  ): Promise<string | undefined> => {
    if (!isDataUri(uri)) return uri;
    scanned += 1;
    const storedUri = await persistMediaDataUri(uri, kind, getMimeType(uri, fallbackMime));
    if (storedUri === uri) {
      remaining += 1;
    } else {
      migrated += 1;
    }
    return storedUri;
  };

  for (const diary of snapshot.diaries) {
    diary.coverImage = await migrateUri(diary.coverImage, 'cover', 'image/jpeg');
  }

  for (const entry of snapshot.entries) {
    const migratedPhotos: string[] = [];
    for (const photoUri of entry.photoUris || []) {
      migratedPhotos.push((await migrateUri(photoUri, 'photo', 'image/jpeg')) || photoUri);
    }
    entry.photoUris = migratedPhotos;
    entry.photoCount = migratedPhotos.length;
    entry.audioUri = await migrateUri(entry.audioUri, 'audio', 'audio/webm');

    for (const block of entry.blocks || []) {
      block.audioUri = await migrateUri(block.audioUri, 'audio', 'audio/webm');
    }
  }

  if (snapshot.userProfile) {
    snapshot.userProfile.avatarUri = await migrateUri(
      snapshot.userProfile.avatarUri,
      'avatar',
      'image/jpeg',
    );
  }

  if (migrated > 0) {
    await diaryRepository.importSnapshot(snapshot, 'replace');
  }

  const result: LegacyMediaMigrationResult = {
    status: remaining === 0 ? 'complete' : 'incomplete',
    scanned,
    migrated,
    remaining,
    ...(remaining === 0 && { completedAt: Date.now() }),
  };
  await localDataStore.setItem(MIGRATION_STATUS_KEY, JSON.stringify(result));
  return result;
};
