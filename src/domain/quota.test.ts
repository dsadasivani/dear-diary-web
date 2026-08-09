import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_ACCOUNT_QUOTA, entryMediaCounts } from './quota';

test('default account quota matches the seeded backend plan', () => {
  assert.deepEqual(DEFAULT_ACCOUNT_QUOTA.limits, {
    maximumCompanions: 3,
    maximumPhotosPerEntry: 3,
    maximumRecordingsPerEntry: 3,
    maximumStorageBytes: 524_288_000,
  });
});

test('entry media counts keep photos and saved recordings separate', () => {
  const counts = entryMediaCounts({
    photoUris: ['one', 'two', 'three'],
    audioUri: 'legacy-audio',
    blocks: [
      { id: 'one', time: '09:00', body: '', audioUri: 'block-audio' },
      { id: 'two', time: '10:00', body: '' },
    ],
  });
  assert.deepEqual(counts, { photoCount: 3, recordingCount: 2 });
});
