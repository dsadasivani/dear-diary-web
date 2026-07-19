import assert from 'node:assert/strict';
import test from 'node:test';
import type { RepositorySnapshot } from '../repositories/DiaryRepository';
import { calculateLocalStorageUsage } from './localStorageUsage';

const snapshot: RepositorySnapshot = {
  diaries: [
    {
      id: 'journal-1',
      name: 'Travel',
      emoji: '✈️',
      color: '#fff',
      isLocked: false,
      entryCount: 1,
      lastUpdated: 'Today',
      coverImage: 'data:image/png;base64,AQID',
    },
  ],
  entries: [
    {
      id: 'entry-1',
      diaryId: 'journal-1',
      date: '2026-07-19',
      title: 'A short trip',
      body: '<p>Hello</p>',
      moodName: 'Happy',
      moodEmoji: '😊',
      tags: [],
      photoUris: ['data:image/png;base64,AQID'],
      photoCount: 1,
      wordCount: 1,
      audioUri: 'data:audio/webm;base64,AQIDBA==',
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  notes: [],
};

test('calculates local writing and deduplicated media usage', async () => {
  const usage = await calculateLocalStorageUsage(snapshot);

  assert.equal(usage.imageCount, 1);
  assert.equal(usage.imageBytes, 3);
  assert.equal(usage.audioCount, 1);
  assert.equal(usage.audioBytes, 4);
  assert.ok(usage.writingBytes > 0);
  assert.equal(usage.totalBytes, usage.writingBytes + 7);
});

test('does not download cloud-only sync media references', async () => {
  let reads = 0;
  const usage = await calculateLocalStorageUsage(
    {
      ...snapshot,
      diaries: [{ ...snapshot.diaries[0], coverImage: 'ddmedia:v2:media-1:file-1' }],
      entries: [{ ...snapshot.entries[0], photoUris: [], audioUri: undefined }],
    },
    async () => {
      reads += 1;
      return { bytes: new Uint8Array() };
    },
  );

  assert.equal(reads, 0);
  assert.equal(usage.imageCount, 0);
  assert.equal(usage.audioCount, 0);
});
