import type { DiaryRepository, RepositorySnapshot } from '../../repositories/DiaryRepository';
import type { SyncRecordType } from '../../types';
import type {
  AtomicSnapshotReplacement,
  SyncCanonicalSnapshotState,
} from './snapshot/PersistentSyncSnapshotStore';
import {
  SYNC_APPLIED_KEY,
  SYNC_MEDIA_KEY,
  SYNC_RECORDS_KEY,
  SYNC_RUNTIME_KEY,
  SYNC_VERSIONS_KEY,
} from './replay/PersistentReplayStore';
import { toPortableRepositorySnapshot } from '../portableMedia';
import { createSyncMediaReference, parseSyncMediaReference } from '../syncMedia';

const recordTypeByCanonicalName: Readonly<Record<string, SyncRecordType>> = {
  DIARY: 'diary',
  ENTRY: 'entry',
  NOTE: 'note',
  SETTINGS: 'settings',
  PROFILE: 'profile',
};

export const repositorySnapshotToSyncState = (
  snapshot: RepositorySnapshot,
): SyncCanonicalSnapshotState => {
  const portable = toPortableRepositorySnapshot(snapshot);
  const stableReferenceByLocalUri = new Map(
    Object.values(snapshot.syncMediaPointers || {}).flatMap((pointer) => {
      if (!pointer.localUri || !pointer.driveFileId) return [];
      const objectId = pointer.driveFileId.slice(pointer.driveFileId.lastIndexOf('/') + 1);
      return [
        [pointer.localUri, createSyncMediaReference(pointer.mediaId, objectId)] as const,
      ];
    }),
  );
  const snapshotUri = (uri: string | undefined): string | undefined => {
    if (!uri || parseSyncMediaReference(uri)) return uri;
    return stableReferenceByLocalUri.get(uri);
  };
  portable.diaries = portable.diaries.map((diary, index) => ({
    ...diary,
    coverImage: snapshotUri(snapshot.diaries[index]?.coverImage),
  }));
  portable.entries = portable.entries.map((entry, index) => {
    const source = snapshot.entries[index];
    const photoUris = (source?.photoUris || [])
      .map(snapshotUri)
      .filter((uri): uri is string => Boolean(uri));
    return {
      ...entry,
      photoUris,
      photoCount: photoUris.length,
      audioUri: snapshotUri(source?.audioUri),
      blocks: source?.blocks?.map((block) => ({
        ...block,
        audioUri: snapshotUri(block.audioUri),
      })),
    };
  });
  if (portable.userProfile && snapshot.userProfile) {
    portable.userProfile = {
      ...portable.userProfile,
      avatarUri: snapshotUri(snapshot.userProfile.avatarUri),
    };
  }
  const records: Record<string, unknown> = {};
  portable.diaries.forEach((value) => {
    records[`DIARY:${value.id}`] = value;
  });
  portable.entries.forEach((value) => {
    records[`ENTRY:${value.id}`] = value;
  });
  portable.notes.forEach((value) => {
    records[`NOTE:${value.id}`] = value;
  });
  if (portable.settings) records['SETTINGS:settings'] = portable.settings;
  if (portable.userProfile) records['PROFILE:profile'] = portable.userProfile;
  return {
    records,
    recordVersions: Object.fromEntries(Object.keys(records).map((key) => [key, 0])),
    mediaPointers: Object.fromEntries(
      Object.values(portable.syncMediaPointers || {})
        .filter((pointer) => pointer.mediaId && pointer.driveFileId)
        .map((pointer) => [pointer.mediaId, pointer.driveFileId]),
    ),
  };
};

export const repositorySnapshotFromSyncState = (
  state: SyncCanonicalSnapshotState,
): RepositorySnapshot =>
  toPortableRepositorySnapshot({
    diaries: Object.entries(state.records)
      .filter(([key]) => key.startsWith('DIARY:'))
      .map(([, value]) => value as RepositorySnapshot['diaries'][number]),
    entries: Object.entries(state.records)
      .filter(([key]) => key.startsWith('ENTRY:'))
      .map(([, value]) => value as RepositorySnapshot['entries'][number]),
    notes: Object.entries(state.records)
      .filter(([key]) => key.startsWith('NOTE:'))
      .map(([, value]) => value as RepositorySnapshot['notes'][number]),
    settings: state.records['SETTINGS:settings'] as RepositorySnapshot['settings'],
    userProfile: state.records['PROFILE:profile'] as RepositorySnapshot['userProfile'],
    security: state.records['SECURITY:security'] as RepositorySnapshot['security'],
    syncRecordVersions: Object.fromEntries(
      Object.entries(state.recordVersions).flatMap(([key, version]) => {
        const separator = key.indexOf(':');
        if (separator <= 0) return [];
        const repositoryRecordType = recordTypeByCanonicalName[key.slice(0, separator)];
        if (!repositoryRecordType) return [];
        return [[`${repositoryRecordType}${key.slice(separator)}`, version] as const];
      }),
    ),
    syncMediaPointers: Object.fromEntries(
      Object.entries(state.mediaPointers).map(([mediaId, objectKey]) => [
        `media:${mediaId}`,
        {
          mediaId,
          sequence: 0,
          driveFileId: objectKey,
          sha256: '',
          sizeBytes: 0,
          createdByDeviceId: 'snapshot',
          createdAt: new Date(0).toISOString(),
        },
      ]),
    ),
  });

export const createAtomicRepositorySnapshotReplacement =
  (repository: DiaryRepository) =>
  async (input: AtomicSnapshotReplacement): Promise<void> => {
    await repository.importSnapshotAtomically(
      repositorySnapshotFromSyncState(input.state),
      'replace-portable',
      {
        [SYNC_RECORDS_KEY]: input.state.records,
        [SYNC_VERSIONS_KEY]: input.state.recordVersions,
        [SYNC_MEDIA_KEY]: input.state.mediaPointers,
        [SYNC_APPLIED_KEY]: [],
        [SYNC_RUNTIME_KEY]: input.runtime,
      },
    );
  };
