import assert from 'node:assert/strict';
import test from 'node:test';
import type { RepositorySnapshot } from '../repositories/DiaryRepository';
import {
  CORE_PARTITION_KEY,
  buildPartitionManifest,
  encodePartitionManifestPayload,
  encodePartitionSnapshotPayload,
  filterSnapshotForPartition,
  monthPartitionKey,
  parsePartitionManifestPayload,
  parsePartitionSnapshotPayload,
  partitionKeyForEntry,
  partitionKeyForNote,
  recentPartitionKeys,
} from './syncPartitioning';

const snapshot: RepositorySnapshot = {
  diaries: [{ id: 'diary-1', name: 'Diary', emoji: '📔', color: '#000', isLocked: false, entryCount: 0, lastUpdated: '' }],
  entries: [
    {
      id: 'entry-1', diaryId: 'diary-1', date: '2026-07-05', title: 'Now', body: 'Hello',
      moodName: 'Calm', moodEmoji: '', tags: [], photoUris: ['ddmedia://1/media-1'],
      photoCount: 1, wordCount: 1, createdAt: 1, updatedAt: 2,
    },
    {
      id: 'entry-2', diaryId: 'diary-1', date: '2021-03-02', title: 'Old', body: 'Archive',
      moodName: 'Calm', moodEmoji: '', tags: [], photoUris: [],
      photoCount: 0, wordCount: 1, createdAt: 3, updatedAt: 4,
    },
  ],
  notes: [{ id: 'note-1', title: 'Note', body: '', isPinned: false, tags: [], createdAt: Date.parse('2026-07-02T00:00:00.000Z'), updatedAt: 0 }],
  syncRecordVersions: { 'entry:entry-1': 2, 'note:note-1': 1 },
  syncMediaPointers: {
    '7': {
      mediaId: 'media-1',
      sequence: 7,
      driveFileId: 'drive-photo-1',
      sha256: 'sha',
      sizeBytes: 123,
      createdByDeviceId: 'mobile-1',
      createdAt: '2026-07-05T00:00:00.000Z',
      localUri: 'http://localhost/_capacitor_file_/photo.jpg',
      keyEpoch: 1,
    },
  },
};

test('derives core and monthly partition keys', () => {
  assert.equal(partitionKeyForEntry(snapshot.entries[0]), 'month:2026-07');
  assert.equal(partitionKeyForNote(snapshot.notes[0]), 'month:2026-07');
  assert.deepEqual(recentPartitionKeys(new Date('2026-07-06T00:00:00.000Z')), [
    CORE_PARTITION_KEY,
    'month:2026-07',
    'month:2026-06',
  ]);
});

test('filters repository snapshots by partition', () => {
  const july = filterSnapshotForPartition(snapshot, monthPartitionKey('2026-07'));
  assert.deepEqual(july.diaries, []);
  assert.deepEqual(july.entries.map(entry => entry.id), ['entry-1']);
  assert.deepEqual(july.notes.map(note => note.id), ['note-1']);

  const core = filterSnapshotForPartition(snapshot, CORE_PARTITION_KEY);
  assert.equal(core.diaries.length, 1);
  assert.equal(core.entries.length, 0);
});

test('round-trips partition snapshot payloads', () => {
  const bytes = encodePartitionSnapshotPayload(snapshot, 'account-1', 'month:2026-07', 42);
  const parsed = parsePartitionSnapshotPayload(bytes, 'account-1', 'month:2026-07');
  assert.equal(parsed.partitionKey, 'month:2026-07');
  assert.equal(parsed.baseSequence, 42);
  assert.deepEqual(parsed.snapshot.entries.map(entry => entry.id), ['entry-1']);
  assert.equal(parsed.snapshot.syncMediaPointers?.['7']?.localUri, undefined);
});

test('builds and round-trips encrypted-manifest payload input', () => {
  const manifest = buildPartitionManifest({
    accountId: 'account-1',
    keyEpoch: 3,
    snapshot,
    now: new Date('2026-07-06T00:00:00.000Z'),
  });
  const parsed = parsePartitionManifestPayload(encodePartitionManifestPayload(manifest), 'account-1');
  assert.equal(parsed.keyEpoch, 3);
  assert.equal(parsed.currentMonth, '2026-07');
  assert.deepEqual(parsed.partitions.map(partition => partition.partitionKey), [
    'core',
    'month:2026-07',
    'month:2021-03',
  ]);
  assert.equal(parsed.partitions.find(partition => partition.partitionKey === 'month:2026-07')?.mediaCount, 1);
});
