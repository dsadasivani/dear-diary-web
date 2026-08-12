import { diaryRepository } from '../repositories';
import { fileStorageService } from '../platform/filesystem';
import { isNativePlatform } from '../platform';
import type { StoredFileEntry } from '../platform/filesystem';
import { parseSyncMediaReference } from '../sync/syncMedia';
import type { SyncMediaPointer } from '../types';
import { getSyncRuntimeFlags } from '../sync/runtimeFlags';

const MEDIA_DIRECTORY = 'media';
const DEFAULT_GRACE_MS = 24 * 60 * 60 * 1000;
const OWNED_MEDIA_NAME = /^(audio|photo|cover|avatar|sync)-[a-zA-Z0-9._-]+$/;
let initialized = false;
let timer: ReturnType<typeof setTimeout> | null = null;

const basenameFromUri = (uri: string | undefined): string | null => {
  if (!uri || uri.startsWith('data:') || uri.startsWith('blob:')) return null;
  try {
    const path = new URL(uri).pathname;
    return decodeURIComponent(path.split('/').filter(Boolean).pop() || '') || null;
  } catch {
    const normalized = uri.replace(/\\/g, '/');
    return decodeURIComponent(normalized.split('/').filter(Boolean).pop() || '') || null;
  }
};

interface ReferencedMedia {
  names: Set<string>;
  pointerByName: Map<string, SyncMediaPointer>;
  pointers: SyncMediaPointer[];
  referencedMediaIds: Set<string>;
  referencedObjectIds: Set<string>;
}

const objectIdFromKey = (objectKey: string): string =>
  objectKey.slice(objectKey.lastIndexOf('/') + 1);

const collectReferencedNames = async (): Promise<ReferencedMedia> => {
  const snapshot = await diaryRepository.exportSnapshot();
  const names = new Set<string>();
  const referencedMediaIds = new Set<string>();
  const referencedObjectIds = new Set<string>();
  const pointerByName = new Map<string, SyncMediaPointer>();
  const add = (uri: string | undefined) => {
    const reference = parseSyncMediaReference(uri);
    if (reference) {
      referencedMediaIds.add(reference.mediaId);
      referencedObjectIds.add(reference.driveFileId);
      return;
    }
    const name = basenameFromUri(uri);
    if (name) names.add(name);
  };
  snapshot.diaries.forEach((diary) => add(diary.coverImage));
  snapshot.entries.forEach((entry) => {
    entry.photoUris?.forEach(add);
    add(entry.audioUri);
    entry.blocks?.forEach((block) => add(block.audioUri));
  });
  add(snapshot.userProfile?.avatarUri);
  Object.values(snapshot.syncMediaPointers || {}).forEach((pointer) => {
    const name = basenameFromUri(pointer.localUri);
    if (name) {
      pointerByName.set(name, pointer);
      if (
        referencedMediaIds.has(pointer.mediaId) ||
        referencedObjectIds.has(objectIdFromKey(pointer.driveFileId))
      ) {
        names.add(name);
      }
    }
  });
  return {
    names,
    pointerByName,
    pointers: Object.values(snapshot.syncMediaPointers || {}),
    referencedMediaIds,
    referencedObjectIds,
  };
};

export interface MediaCleanupResult {
  scanned: number;
  removed: number;
  retained: number;
  reclaimedBytes: number;
}

export const selectOrphanedMedia = (
  files: StoredFileEntry[],
  referenced: Set<string>,
  minimumAgeMs: number,
  now = Date.now(),
): StoredFileEntry[] => {
  const cutoff = now - minimumAgeMs;
  return files.filter(
    (file) =>
      OWNED_MEDIA_NAME.test(file.name) &&
      !referenced.has(file.name) &&
      (minimumAgeMs === 0 || (file.modifiedAt || now) <= cutoff),
  );
};

export const pruneOrphanedMedia = async (
  minimumAgeMs = DEFAULT_GRACE_MS,
): Promise<MediaCleanupResult> => {
  if (!getSyncRuntimeFlags().automaticGarbageCollectionEnabled) {
    return { scanned: 0, removed: 0, retained: 0, reclaimedBytes: 0 };
  }
  // Browser companions have no app-owned filesystem to collect. Avoid scanning
  // and decrypting the complete diary snapshot during startup, which becomes a
  // material cold-open penalty for long-lived accounts.
  if (!isNativePlatform()) return { scanned: 0, removed: 0, retained: 0, reclaimedBytes: 0 };
  const referenced = await collectReferencedNames();
  for (const pointer of referenced.pointers) {
    if (
      pointer.localUri &&
      !referenced.referencedMediaIds.has(pointer.mediaId) &&
      !referenced.referencedObjectIds.has(objectIdFromKey(pointer.driveFileId))
    ) {
      await diaryRepository.saveSyncMediaPointer({ ...pointer, localUri: undefined });
    }
  }
  const files = await fileStorageService.list(MEDIA_DIRECTORY).catch(() => []);
  const result: MediaCleanupResult = {
    scanned: files.length,
    removed: 0,
    retained: 0,
    reclaimedBytes: 0,
  };
  const removable = new Set(
    selectOrphanedMedia(files, referenced.names, minimumAgeMs).map((file) => file.path),
  );
  for (const file of files) {
    if (!removable.has(file.path)) {
      result.retained += 1;
      continue;
    }
    try {
      await fileStorageService.delete(file.path);
      const pointer = referenced.pointerByName.get(file.name);
      if (pointer) await diaryRepository.saveSyncMediaPointer({ ...pointer, localUri: undefined });
      result.removed += 1;
      result.reclaimedBytes += file.size || 0;
    } catch (error) {
      result.retained += 1;
      console.warn(`Orphan media cleanup will retry ${file.path}:`, error);
    }
  }
  return result;
};

export const initializeMediaGarbageCollection = (): void => {
  if (!isNativePlatform()) return;
  if (initialized) return;
  initialized = true;
  diaryRepository.subscribeChanges(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void pruneOrphanedMedia().catch((error) =>
        console.warn('Media cleanup will retry later:', error),
      );
    }, 5_000);
  });
  void pruneOrphanedMedia().catch((error) =>
    console.warn('Startup media cleanup will retry later:', error),
  );
};
