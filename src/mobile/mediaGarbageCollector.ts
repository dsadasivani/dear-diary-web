import { diaryRepository } from '../repositories';
import { fileStorageService } from '../platform/filesystem';
import { isNativePlatform } from '../platform';
import type { StoredFileEntry } from '../platform/filesystem';

const MEDIA_DIRECTORY = 'media';
const DEFAULT_GRACE_MS = 24 * 60 * 60 * 1000;
const OWNED_MEDIA_NAME = /^(audio|photo|cover|avatar)-[a-zA-Z0-9._-]+$/;
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

const collectReferencedNames = async (): Promise<Set<string>> => {
  const snapshot = await diaryRepository.exportSnapshot();
  const names = new Set<string>();
  const add = (uri: string | undefined) => {
    const name = basenameFromUri(uri);
    if (name) names.add(name);
  };
  snapshot.diaries.forEach(diary => add(diary.coverImage));
  snapshot.entries.forEach(entry => {
    entry.photoUris?.forEach(add);
    add(entry.audioUri);
    entry.blocks?.forEach(block => add(block.audioUri));
  });
  add(snapshot.userProfile?.avatarUri);
  return names;
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
  return files.filter(file => (
    OWNED_MEDIA_NAME.test(file.name) &&
    !referenced.has(file.name) &&
    (minimumAgeMs === 0 || (file.modifiedAt || now) <= cutoff)
  ));
};

export const pruneOrphanedMedia = async (minimumAgeMs = DEFAULT_GRACE_MS): Promise<MediaCleanupResult> => {
  if (!isNativePlatform()) return { scanned: 0, removed: 0, retained: 0, reclaimedBytes: 0 };
  const [files, referenced] = await Promise.all([
    fileStorageService.list(MEDIA_DIRECTORY).catch(() => []),
    collectReferencedNames(),
  ]);
  const result: MediaCleanupResult = { scanned: files.length, removed: 0, retained: 0, reclaimedBytes: 0 };
  const removable = new Set(selectOrphanedMedia(files, referenced, minimumAgeMs).map(file => file.path));
  for (const file of files) {
    if (!removable.has(file.path)) {
      result.retained += 1;
      continue;
    }
    try {
      await fileStorageService.delete(file.path);
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
  if (initialized || !isNativePlatform()) return;
  initialized = true;
  diaryRepository.subscribeChanges(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void pruneOrphanedMedia().catch(error => console.warn('Media cleanup will retry later:', error));
    }, 5_000);
  });
  void pruneOrphanedMedia().catch(error => console.warn('Startup media cleanup will retry later:', error));
};
