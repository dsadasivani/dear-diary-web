import assert from 'node:assert/strict';
import test from 'node:test';
import type { SyncObjectMetadata } from '../types';
import { decryptSyncPayload } from './encryptedSyncObject';
import { migrateLocalAccountToPartitionedSync } from './partitionedMigration';
import { createRepository } from './testSupport';
import { parsePartitionManifestPayload, parsePartitionSnapshotPayload } from './syncPartitioning';

test('lazy migration uploads monthly partition snapshots and a manifest', async () => {
  const repository = await createRepository();
  const diary = await repository.createDiary({
    name: 'Travel',
    emoji: 'T',
    color: '#123456',
    isLocked: false,
  });
  await repository.createEntry({
    diaryId: diary.id,
    date: '2026-07-04',
    title: 'Recent',
    body: '',
    moodName: 'Calm',
    moodEmoji: '',
    tags: [],
    photoUris: [],
  });
  await repository.createEntry({
    diaryId: diary.id,
    date: '2021-03-02',
    title: 'Archive',
    body: '',
    moodName: 'Calm',
    moodEmoji: '',
    tags: [],
    photoUris: [],
  });
  const localState = {
    accountId: 'account-1',
    deviceId: 'device-1',
    deviceRole: 'primary_mobile' as const,
    googleUserId: 'google-1',
    googleEmail: 'writer@example.com',
    devicePublicKey: '{}',
    recoveryKeyDriveFileId: 'key-1',
    latestSnapshotDriveFileId: 'snapshot-1',
    currentSyncSequence: 2,
    linkedAt: 1,
  };
  await repository.saveLocalSyncAccountState(localState);
  const rootKey = crypto.getRandomValues(new Uint8Array(32));
  const uploads: Array<{ id: string; name: string; kind: string; bytes: Uint8Array }> = [];
  let sequence = 2;
  const controlPlane = {
    commitSyncObject: async (input: any): Promise<SyncObjectMetadata> => ({
      id: `object-${++sequence}`,
      accountId: 'account-1',
      sequence,
      driveFileId: input.driveFileId,
      objectKind: input.objectKind,
      sha256: input.sha256,
      sizeBytes: input.sizeBytes,
      createdByDeviceId: 'device-1',
      createdAt: '',
      partitionKey: input.partitionKey,
      affectedPartitionKeys: input.affectedPartitionKeys,
      operationId: input.operationId,
      keyEpoch: input.keyEpoch,
    }),
  };

  const result = await migrateLocalAccountToPartitionedSync({
    repository,
    controlPlane: controlPlane as any,
    localState,
    accountRootKey: rootKey,
    googleSession: {
      userId: 'google-1',
      email: 'writer@example.com',
      displayName: null,
      accessToken: 'drive',
    },
    now: new Date('2026-07-06T00:00:00.000Z'),
    upload: async (input) => {
      const id = `drive-${uploads.length + 1}`;
      uploads.push({ id, name: input.name, kind: input.objectKind, bytes: input.bytes });
      return { id };
    },
  });

  assert.equal(result.partitionObjects.length, 3);
  assert.equal(result.manifestObject.objectKind, 'manifest');
  assert.deepEqual(
    uploads.map((upload) => upload.kind),
    ['partition_snapshot', 'partition_snapshot', 'partition_snapshot', 'manifest'],
  );
  const recentUpload = uploads.find((upload) => upload.name.includes('2026/07'))!;
  const decryptedPartition = await decryptSyncPayload(rootKey, recentUpload.bytes);
  const parsedPartition = parsePartitionSnapshotPayload(
    decryptedPartition.payload,
    'account-1',
    'month:2026-07',
  );
  assert.deepEqual(
    parsedPartition.snapshot.entries.map((entry) => entry.title),
    ['Recent'],
  );

  const decryptedManifest = await decryptSyncPayload(rootKey, uploads.at(-1)!.bytes);
  const manifest = parsePartitionManifestPayload(decryptedManifest.payload, 'account-1');
  assert.deepEqual(
    manifest.partitions.map((partition) => partition.partitionKey),
    ['core', 'month:2026-07', 'month:2021-03'],
  );
  assert.equal((await repository.getLocalSyncAccountState())?.partitionedSyncEnabled, true);
});
