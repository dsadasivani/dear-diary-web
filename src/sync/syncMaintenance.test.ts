import assert from 'node:assert/strict';
import test from 'node:test';
import type { SyncObjectMetadata } from '../types';
import { planSyncMaintenance } from './syncMaintenance';

const object = (
  sequence: number,
  objectKind: SyncObjectMetadata['objectKind'],
  retiredAt: string | null = null,
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

  assert.deepEqual(plan.snapshotsToRetire.map(item => item.sequence), [2]);
  assert.deepEqual(plan.driveFilesToDelete.map(item => item.id), ['file-6', 'orphan-old']);
});
