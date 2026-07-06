import assert from 'node:assert/strict';
import test from 'node:test';
import type { RepositorySnapshot } from '../repositories/DiaryRepository';
import type { SyncObjectMetadata } from '../types';
import { encryptSyncPayload } from './encryptedSyncObject';
import { restoreLatestPartitions } from './partitionedRestore';
import { createRepository } from './testSupport';
import {
  buildPartitionManifest,
  encodePartitionManifestPayload,
  encodePartitionSnapshotPayload,
} from './syncPartitioning';

const metadata = (
  sequence: number,
  driveFileId: string,
  objectKind: SyncObjectMetadata['objectKind'],
  sha256: string,
  sizeBytes: number,
  partitionKey?: string,
): SyncObjectMetadata => ({
  id: `object-${sequence}`,
  accountId: 'account-1',
  sequence,
  driveFileId,
  objectKind,
  sha256,
  sizeBytes,
  createdByDeviceId: 'device-1',
  createdAt: '',
  partitionKey,
});

test('recent-first restore imports core and recent monthly partitions from manifest', async () => {
  const repository = await createRepository();
  const localState = {
    accountId: 'account-1',
    deviceId: 'device-1',
    deviceRole: 'primary_mobile' as const,
    googleUserId: 'google-1',
    googleEmail: 'writer@example.com',
    devicePublicKey: '{}',
    recoveryKeyDriveFileId: 'key-1',
    latestSnapshotDriveFileId: 'snapshot-1',
    currentSyncSequence: 0,
    linkedAt: 1,
  };
  await repository.saveLocalSyncAccountState(localState);
  const rootKey = crypto.getRandomValues(new Uint8Array(32));
  const fullSnapshot: RepositorySnapshot = {
    diaries: [{ id: 'diary-1', name: 'Diary', emoji: 'D', color: '#000', isLocked: false, entryCount: 0, lastUpdated: '' }],
    entries: [
      {
        id: 'entry-recent', diaryId: 'diary-1', date: '2026-07-05', title: 'Recent', body: '',
        moodName: 'Calm', moodEmoji: '', tags: [], photoUris: [], photoCount: 0, wordCount: 0,
        createdAt: 1, updatedAt: 1,
      },
      {
        id: 'entry-old', diaryId: 'diary-1', date: '2021-03-02', title: 'Old', body: '',
        moodName: 'Calm', moodEmoji: '', tags: [], photoUris: [], photoCount: 0, wordCount: 0,
        createdAt: 2, updatedAt: 2,
      },
    ],
    notes: [],
    syncRecordVersions: {},
  };
  const files = new Map<string, Uint8Array>();
  const core = await encryptSyncPayload(rootKey, 'partition_snapshot', encodePartitionSnapshotPayload(fullSnapshot, 'account-1', 'core', 4));
  const recent = await encryptSyncPayload(rootKey, 'partition_snapshot', encodePartitionSnapshotPayload(fullSnapshot, 'account-1', 'month:2026-07', 5));
  const old = await encryptSyncPayload(rootKey, 'partition_snapshot', encodePartitionSnapshotPayload(fullSnapshot, 'account-1', 'month:2021-03', 6));
  const manifestPayload = buildPartitionManifest({
    accountId: 'account-1',
    snapshot: fullSnapshot,
    now: new Date('2026-07-06T00:00:00.000Z'),
    snapshotMetadata: {
      core: { latestSnapshotSequence: 4, latestSnapshotDriveFileId: 'drive-core', latestSnapshotSha256: core.sha256, latestSnapshotSizeBytes: core.bytes.byteLength, headSequence: 4 },
      'month:2026-07': { latestSnapshotSequence: 5, latestSnapshotDriveFileId: 'drive-recent', latestSnapshotSha256: recent.sha256, latestSnapshotSizeBytes: recent.bytes.byteLength, headSequence: 5 },
      'month:2021-03': { latestSnapshotSequence: 6, latestSnapshotDriveFileId: 'drive-old', latestSnapshotSha256: old.sha256, latestSnapshotSizeBytes: old.bytes.byteLength, headSequence: 6 },
    },
  });
  const manifest = await encryptSyncPayload(rootKey, 'manifest', encodePartitionManifestPayload(manifestPayload));
  files.set('drive-manifest', manifest.bytes);
  files.set('drive-core', core.bytes);
  files.set('drive-recent', recent.bytes);
  files.set('drive-old', old.bytes);
  const controlPlane = {
    getLatestRestoreManifest: async () => ({
      manifestObject: metadata(7, 'drive-manifest', 'manifest', manifest.sha256, manifest.bytes.byteLength, 'core'),
      coreSnapshotObject: metadata(4, 'drive-core', 'partition_snapshot', core.sha256, core.bytes.byteLength, 'core'),
      currentSyncSequence: 7,
      keyEpoch: 1,
    }),
    getPartitionRestoreBundle: async (_deviceId: string, partitionKeys: string[]) => partitionKeys.map(partitionKey => {
      if (partitionKey === 'core') {
        return {
          partitionKey,
          snapshotObject: metadata(4, 'drive-core', 'partition_snapshot', core.sha256, core.bytes.byteLength, 'core'),
          tailObjects: [],
        };
      }
      if (partitionKey === 'month:2026-07') {
        return {
          partitionKey,
          snapshotObject: metadata(5, 'drive-recent', 'partition_snapshot', recent.sha256, recent.bytes.byteLength, 'month:2026-07'),
          tailObjects: [],
        };
      }
      return { partitionKey, snapshotObject: null, tailObjects: [] };
    }),
  };

  const result = await restoreLatestPartitions({
    repository,
    controlPlane: controlPlane as any,
    localState,
    accountRootKey: rootKey,
    googleSession: { userId: 'google-1', email: 'writer@example.com', displayName: null, accessToken: 'drive' },
    now: new Date('2026-07-06T00:00:00.000Z'),
    download: async (_session, fileId) => files.get(fileId)!,
  });

  assert.equal(result.mode, 'partitioned');
  assert.deepEqual(result.hydratedPartitionKeys, ['core', 'month:2026-07']);
  assert.deepEqual((await repository.listEntries()).map(entry => entry.title), ['Recent']);
  assert.equal((await repository.getPartitionHydrationState('month:2021-03')).status, 'available');
  assert.equal((await repository.getLocalSyncAccountState())?.partitionedSyncEnabled, true);
});

test('restore reports legacy fallback when no manifest exists', async () => {
  const repository = await createRepository();
  const localState = {
    accountId: 'account-1', deviceId: 'device-1', deviceRole: 'primary_mobile' as const,
    googleUserId: 'google-1', googleEmail: 'writer@example.com', devicePublicKey: '{}',
    recoveryKeyDriveFileId: 'key-1', latestSnapshotDriveFileId: 'snapshot-1',
    currentSyncSequence: 2, linkedAt: 1,
  };
  const result = await restoreLatestPartitions({
    repository,
    controlPlane: { getLatestRestoreManifest: async () => ({ manifestObject: null, coreSnapshotObject: null, currentSyncSequence: 2, keyEpoch: 1 }) } as any,
    localState,
    accountRootKey: new Uint8Array(32),
    googleSession: { userId: 'google-1', email: null, displayName: null, accessToken: 'drive' },
  });
  assert.equal(result.mode, 'legacy_missing_manifest');
});
