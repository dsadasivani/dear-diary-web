import assert from 'node:assert/strict';
import test from 'node:test';
import { selectOrphanedMedia } from './mediaGarbageCollector';

test('media cleanup removes only old unreferenced app-owned files', () => {
  const now = 1_000_000;
  const files = [
    { name: 'photo-old.jpg', path: 'media/photo-old.jpg', modifiedAt: 1, size: 10 },
    { name: 'audio-kept.webm', path: 'media/audio-kept.webm', modifiedAt: 1, size: 20 },
    { name: 'cover-recent.jpg', path: 'media/cover-recent.jpg', modifiedAt: now - 100, size: 30 },
    { name: 'foreign.txt', path: 'media/foreign.txt', modifiedAt: 1, size: 40 },
    { name: 'sync-orphan.png', path: 'media/sync-orphan.png', modifiedAt: 1, size: 50 },
  ];
  const removable = selectOrphanedMedia(files, new Set(['audio-kept.webm']), 1_000, now);
  assert.deepEqual(removable.map(file => file.name), ['photo-old.jpg', 'sync-orphan.png']);
});
