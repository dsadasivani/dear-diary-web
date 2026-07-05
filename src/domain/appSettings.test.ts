import assert from 'node:assert/strict';
import test from 'node:test';
import { getTagsForSettings } from './appSettings';

test('search/editor tag catalog includes normalized custom tags without duplicates', () => {
  const tags = getTagsForSettings({
    remindersEnabled: false,
    reminderTime: '20:00',
    customTags: ['garden', 'thoughts', 'garden'],
  });
  assert.equal(tags.filter(tag => tag === 'garden').length, 1);
  assert.equal(tags.filter(tag => tag === 'thoughts').length, 1);
});
