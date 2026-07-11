import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveEntryIndexForEntryId } from './diaryDetailNavigation';

test('resolves a search deep-linked entry instead of defaulting to the newest entry', () => {
  const diaryEntries = [
    { id: 'newest-entry' },
    { id: 'clicked-search-result' },
    { id: 'oldest-entry' },
  ];

  assert.equal(resolveEntryIndexForEntryId(diaryEntries, 'clicked-search-result'), 1);
});

test('falls back to the first diary entry when a deep link is unavailable', () => {
  assert.equal(resolveEntryIndexForEntryId([{ id: 'newest-entry' }], 'missing-entry'), 0);
});
