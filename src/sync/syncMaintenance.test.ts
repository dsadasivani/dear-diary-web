import assert from 'node:assert/strict';
import test from 'node:test';
import type { SyncObjectMetadata } from '../types';
import {
  ORPHAN_GRACE_PERIOD_MS,
  performSyncMaintenance,
  planSyncMaintenance,
} from './syncMaintenance';
import { resetSyncRuntimeFlags } from './runtimeFlags';

const object = (
  sequence: number,
  objectKind: SyncObjectMetadata['objectKind'],
  retiredAt: string | null = null,
  partitionKey?: string,
  affectedPartitionKeys?: string[],
): SyncObjectMetadata => ({
  id: `object-${sequence}`,
  accountId: 'account-1',
  sequence,
  driveFileId: `file-${sequence}`,
  objectKind,
  sha256: 'a'.repeat(64),
  sizeBytes: 100,
  createdByDeviceId: 'device-1',
  createdAt: '2026-07-01T00:00:00.000Z',
  retiredAt,
  partitionKey,
  affectedPartitionKeys,
});

test('retains the newest snapshots and identifies only safe Drive cleanup candidates', () => {
  const now = Date.parse('2026-07-06T12:00:00.000Z');
  const metadata = [
    object(1, 'event'),
    object(2, 'snapshot'),
    object(3, 'snapshot'),
    object(4, 'snapshot'),
    object(5, 'snapshot'),
    object(6, 'key_package', '2026-07-05T00:00:00.000Z'),
  ];
  const plan = planSyncMaintenance({
    metadata,
    now,
    snapshotRetentionCount: 3,
    orphanGracePeriodMs: 24 * 60 * 60 * 1000,
    driveFiles: [
      { id: 'file-1', name: 'committed', createdTime: '2026-07-01T00:00:00.000Z' },
      { id: 'file-6', name: 'retired', createdTime: '2026-07-01T00:00:00.000Z' },
      { id: 'orphan-old', name: 'old orphan', createdTime: '2026-07-04T00:00:00.000Z' },
      { id: 'orphan-new', name: 'new orphan', createdTime: '2026-07-06T11:30:00.000Z' },
    ],
  });

  assert.deepEqual(
    plan.snapshotsToRetire.map((item) => item.sequence),
    [2],
  );
  assert.deepEqual(
    plan.objectsToRetire.map((item) => item.sequence),
    [2],
  );
  assert.deepEqual(
    plan.driveFilesToDelete.map((item) => item.id),
    ['file-6', 'orphan-old'],
  );
});

test('retains manifests and partition snapshots independently', () => {
  const metadata = [
    object(1, 'manifest'),
    object(2, 'manifest'),
    object(3, 'manifest'),
    object(4, 'partition_snapshot', null, 'core'),
    object(5, 'partition_snapshot', null, 'core'),
    object(6, 'partition_snapshot', null, 'core'),
    object(7, 'partition_snapshot', null, 'month:2026-07'),
    object(8, 'partition_snapshot', null, 'month:2026-07'),
    object(9, 'partition_snapshot', null, 'month:2026-07'),
  ];
  const plan = planSyncMaintenance({
    metadata,
    driveFiles: [],
    manifestRetentionCount: 2,
    partitionSnapshotRetentionCount: 2,
  });

  assert.deepEqual(
    plan.snapshotsToRetire.map((item) => item.sequence),
    [1, 4, 7],
  );
  assert.deepEqual(plan.eventsToRetire, []);
});

test('retires event tails covered by retained partition snapshots', () => {
  const metadata = [
    object(1, 'event', null, 'month:2026-07'),
    object(2, 'event', null, 'month:2026-07'),
    object(3, 'event', null, 'month:2026-07'),
    object(4, 'partition_snapshot', null, 'month:2026-07'),
    object(5, 'partition_snapshot', null, 'month:2026-07'),
  ];
  const plan = planSyncMaintenance({
    metadata,
    driveFiles: [],
    partitionSnapshotRetentionCount: 2,
  });

  assert.deepEqual(
    plan.eventsToRetire.map((item) => item.sequence),
    [1, 2, 3],
  );
  assert.deepEqual(
    plan.objectsToRetire.map((item) => item.sequence),
    [1, 2, 3],
  );
});

test('keeps cross-partition events until every affected partition is covered', () => {
  const metadata = [
    object(3, 'event', null, 'month:2026-07', ['month:2026-07', 'month:2026-08']),
    object(4, 'partition_snapshot', null, 'month:2026-07'),
    object(5, 'event', null, 'month:2026-07', ['month:2026-07', 'month:2026-08']),
    object(6, 'partition_snapshot', null, 'month:2026-08'),
  ];
  const plan = planSyncMaintenance({
    metadata,
    driveFiles: [],
    partitionSnapshotRetentionCount: 2,
  });

  assert.deepEqual(
    plan.eventsToRetire.map((item) => item.sequence),
    [3],
  );
});

test('retires old unreferenced media while keeping current media references', () => {
  const now = Date.parse('2026-07-06T12:00:00.000Z');
  const metadata = [
    object(1, 'media', null, 'month:2026-07'),
    object(2, 'thumbnail', null, 'month:2026-07'),
    object(3, 'media', null, 'month:2026-07'),
  ];
  metadata[0].driveFileId = 'deleted-media';
  metadata[0].createdAt = '2026-07-04T00:00:00.000Z';
  metadata[1].driveFileId = 'deleted-thumb';
  metadata[1].createdAt = '2026-07-04T00:00:00.000Z';
  metadata[2].driveFileId = 'live-media';
  metadata[2].createdAt = '2026-07-04T00:00:00.000Z';

  const plan = planSyncMaintenance({
    metadata,
    driveFiles: [],
    now,
    orphanGracePeriodMs: 24 * 60 * 60 * 1000,
    liveDriveFileIds: ['live-media'],
  });

  assert.deepEqual(
    plan.mediaToRetire.map((item) => item.driveFileId),
    ['deleted-media', 'deleted-thumb'],
  );
  assert.deepEqual(
    plan.objectsToRetire.map((item) => item.driveFileId),
    ['deleted-media', 'deleted-thumb'],
  );
});

test('uses a two-hour default grace period before retiring unreferenced remote media', () => {
  const now = Date.parse('2026-07-06T12:00:00.000Z');
  const metadata = [
    object(1, 'media', null, 'month:2026-07'),
    object(2, 'media', null, 'month:2026-07'),
  ];
  metadata[0].driveFileId = 'almost-old-media';
  metadata[0].createdAt = '2026-07-06T10:01:00.000Z';
  metadata[1].driveFileId = 'old-enough-media';
  metadata[1].createdAt = '2026-07-06T10:00:00.000Z';

  const plan = planSyncMaintenance({
    metadata,
    driveFiles: [],
    now,
    liveDriveFileIds: [],
  });

  assert.equal(ORPHAN_GRACE_PERIOD_MS, 2 * 60 * 60 * 1000);
  assert.deepEqual(
    plan.mediaToRetire.map((item) => item.driveFileId),
    ['old-enough-media'],
  );
});

test('remote deletion cannot run while automatic garbage collection is disabled', async () => {
  resetSyncRuntimeFlags();
  let cloudCallCount = 0;
  const plan = await performSyncMaintenance({
    controlPlane: {
      listSyncObjectsForMaintenance: async () => {
        cloudCallCount += 1;
        return [];
      },
      retireSyncObjects: async () => {
        cloudCallCount += 1;
        return [];
      },
    } as never,
    primaryDeviceId: 'redacted-device',
    googleSession: { accessToken: 'not-used' } as never,
  });

  assert.equal(cloudCallCount, 0);
  assert.deepEqual(plan.driveFilesToDelete, []);
  assert.deepEqual(plan.objectsToRetire, []);
});
