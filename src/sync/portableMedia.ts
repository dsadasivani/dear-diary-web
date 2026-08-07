import type { RepositorySnapshot } from '../repositories/DiaryRepository';
import type { Diary, Entry, SyncRecordType, UserProfile } from '../types';

const LOCAL_MEDIA_SCHEMES = /^(?:blob|capacitor|content|file|ionic):/i;

export const isDeviceLocalMediaUri = (uri: string): boolean => {
  const normalized = uri.trim();
  if (!normalized) return false;
  return (
    LOCAL_MEDIA_SCHEMES.test(normalized) ||
    normalized.includes('/_capacitor_file_/') ||
    normalized.includes('_capacitor_file_')
  );
};

const portableUri = (uri: string | undefined): string | undefined =>
  uri && !isDeviceLocalMediaUri(uri) ? uri : undefined;

export const toPortableDiary = (diary: Diary): Diary => ({
  ...diary,
  coverImage: portableUri(diary.coverImage),
});

export const toPortableEntry = (entry: Entry): Entry => {
  const photoUris = (entry.photoUris || []).filter((uri) => !isDeviceLocalMediaUri(uri));
  return {
    ...entry,
    photoUris,
    photoCount: photoUris.length,
    audioUri: portableUri(entry.audioUri),
    blocks: entry.blocks?.map((block) => ({
      ...block,
      audioUri: portableUri(block.audioUri),
    })),
  };
};

export const toPortableUserProfile = (profile: UserProfile): UserProfile => ({
  ...profile,
  avatarUri: portableUri(profile.avatarUri),
});

export const toPortableSyncPayload = (
  recordType: SyncRecordType,
  payload: unknown | null,
): unknown | null => {
  if (!payload || typeof payload !== 'object') return payload;
  if (recordType === 'diary') return toPortableDiary(payload as Diary);
  if (recordType === 'entry') return toPortableEntry(payload as Entry);
  if (recordType === 'profile') return toPortableUserProfile(payload as UserProfile);
  return payload;
};

export const toPortableRepositorySnapshot = (snapshot: RepositorySnapshot): RepositorySnapshot => ({
  ...snapshot,
  diaries: snapshot.diaries.map(toPortableDiary),
  entries: snapshot.entries.map(toPortableEntry),
  userProfile: snapshot.userProfile
    ? toPortableUserProfile(snapshot.userProfile)
    : snapshot.userProfile,
  syncMediaPointers: snapshot.syncMediaPointers
    ? Object.fromEntries(
        Object.entries(snapshot.syncMediaPointers).map(([key, pointer]) => [
          key,
          { ...pointer, localUri: undefined },
        ]),
      )
    : snapshot.syncMediaPointers,
});
