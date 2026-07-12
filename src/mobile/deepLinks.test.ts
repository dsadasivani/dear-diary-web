import test from 'node:test';
import assert from 'node:assert/strict';

import { parseDearDiaryDeepLink } from './deepLinks';

test('parses Dear Diary custom-scheme navigation links', () => {
  assert.deepEqual(parseDearDiaryDeepLink('deardiary://home'), { kind: 'home' });
  assert.deepEqual(parseDearDiaryDeepLink('deardiary://diaries'), { kind: 'diaries' });
  assert.deepEqual(parseDearDiaryDeepLink('deardiary://diaries/diary-1'), { kind: 'diary', diaryId: 'diary-1' });
  assert.deepEqual(parseDearDiaryDeepLink('deardiary://diaries/diary-1/entries/entry-2'), {
    kind: 'diary',
    diaryId: 'diary-1',
    entryId: 'entry-2',
  });
  assert.deepEqual(parseDearDiaryDeepLink('deardiary://entry/entry-2?diaryId=diary-1'), {
    kind: 'entry',
    entryId: 'entry-2',
    diaryId: 'diary-1',
  });
  assert.deepEqual(parseDearDiaryDeepLink('deardiary://notes/note-1'), { kind: 'notes', noteId: 'note-1' });
  assert.deepEqual(parseDearDiaryDeepLink('deardiary://search?q=gratitude'), { kind: 'search', query: 'gratitude' });
  assert.deepEqual(parseDearDiaryDeepLink('deardiary://settings'), { kind: 'settings' });
});

test('parses package-scheme and https app links', () => {
  assert.deepEqual(parseDearDiaryDeepLink('com.deardiary.app://stats'), { kind: 'stats' });
  assert.deepEqual(parseDearDiaryDeepLink('https://deardiary.app/diary/diary-1?entryId=entry-2'), {
    kind: 'diary',
    diaryId: 'diary-1',
    entryId: 'entry-2',
  });
});

test('rejects unsupported or malformed deep links', () => {
  assert.equal(parseDearDiaryDeepLink('javascript:alert(1)'), null);
  assert.equal(parseDearDiaryDeepLink('https://evil.example/diary/diary-1'), null);
  assert.equal(parseDearDiaryDeepLink('deardiary://entry'), null);
  assert.equal(parseDearDiaryDeepLink('not a url'), null);
});
