import assert from 'node:assert/strict';
import test from 'node:test';
import type { SyncObjectMetadata } from '../types';
import { encryptSyncPayload } from './encryptedSyncObject';
import {
  encodeRepositorySnapshotPayload,
  findLatestValidSnapshot,
  parseRepositorySnapshotPayload,
} from './syncSnapshot';

const metadata = (
  sequence: number,
  driveFileId: string,
  sha256: string,
  sizeBytes: number,
): SyncObjectMetadata => ({
  id: `object-${sequence}`,
  accountId: 'account-1',
  sequence,
  driveFileId,
  objectKind: 'snapshot',
  sha256,
  sizeBytes,
  createdByDeviceId: 'device-1',
  createdAt: '',
});

test('round-trips record versions in snapshot format v2', () => {
  const bytes = encodeRepositorySnapshotPayload(
    {
      diaries: [],
      entries: [],
      notes: [],
      syncRecordVersions: { 'note:note-1': 4 },
    },
    'account-1',
    12,
  );
  const parsed = parseRepositorySnapshotPayload(bytes, 'account-1');
  assert.equal(parsed.formatVersion, 2);
  assert.equal(parsed.baseSequence, 12);
  assert.deepEqual(parsed.snapshot.syncRecordVersions, { 'note:note-1': 4 });
});

test('falls back to the newest older snapshot that passes integrity and decryption', async () => {
  const rootKey = crypto.getRandomValues(new Uint8Array(32));
  const valid = await encryptSyncPayload(
    rootKey,
    'snapshot',
    encodeRepositorySnapshotPayload(
      {
        diaries: [],
        entries: [],
        notes: [],
        syncRecordVersions: {},
      },
      'account-1',
      4,
    ),
  );
  const corrupt = new Uint8Array(valid.bytes);
  corrupt[corrupt.length - 1] ^= 1;
  const objects = [
    metadata(8, 'corrupt-latest', valid.sha256, corrupt.byteLength),
    metadata(5, 'valid-older', valid.sha256, valid.bytes.byteLength),
  ];

  const restored = await findLatestValidSnapshot({
    objects,
    accountId: 'account-1',
    accountRootKey: rootKey,
    googleSession: { userId: 'google-1', email: null, displayName: null, accessToken: 'token' },
    download: async (_session, fileId) => (fileId === 'corrupt-latest' ? corrupt : valid.bytes),
  });

  assert.equal(restored.object.sequence, 5);
  assert.equal(restored.baseSequence, 4);
});

test('restores snapshots using encrypted header epoch when metadata is missing key epoch', async () => {
  const epochOneRootKey = crypto.getRandomValues(new Uint8Array(32));
  const epochTwoRootKey = crypto.getRandomValues(new Uint8Array(32));
  const snapshot = await encryptSyncPayload(
    epochTwoRootKey,
    'snapshot',
    encodeRepositorySnapshotPayload(
      {
        diaries: [
          {
            id: 'diary-epoch',
            name: 'Epoch Diary',
            emoji: 'D',
            color: '#000',
            isLocked: false,
            entryCount: 0,
            lastUpdated: '',
          },
        ],
        entries: [],
        notes: [],
        syncRecordVersions: {},
      },
      'account-1',
      4,
    ),
    { keyEpoch: 2 },
  );

  const restored = await findLatestValidSnapshot({
    objects: [metadata(5, 'snapshot-epoch-2', snapshot.sha256, snapshot.bytes.byteLength)],
    accountId: 'account-1',
    accountRootKey: epochOneRootKey,
    accountRootKeys: { 1: epochOneRootKey, 2: epochTwoRootKey },
    googleSession: { userId: 'google-1', email: null, displayName: null, accessToken: 'token' },
    download: async () => snapshot.bytes,
  });

  assert.equal(restored.object.sequence, 5);
  assert.equal(restored.snapshot.diaries[0]?.name, 'Epoch Diary');
});
