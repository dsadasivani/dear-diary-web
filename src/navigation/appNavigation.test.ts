import assert from 'node:assert/strict';
import test from 'node:test';
import { legacyNavigationTarget, resolveNavigationTarget } from './appNavigation';

test('resolves diary navigation as one valid state transition', () => {
  assert.deepEqual(
    resolveNavigationTarget({ kind: 'diary', diaryId: 'journal-1', entryId: 'entry-2' }),
    {
      activeTab: 'diaries',
      currentScreen: 'diaryDetail',
      selectedDiaryId: 'journal-1',
      selectedEntryId: 'entry-2',
      selectedDate: '',
      selectedNoteId: '',
      selectedPrompt: '',
    },
  );
});

test('legacy invalid editor requests safely return to the journals root', () => {
  const target = legacyNavigationTarget('diaries', 'entryEditor');
  assert.deepEqual(target, { kind: 'root', destination: 'diaries' });
  assert.equal(resolveNavigationTarget(target).currentScreen, 'list');
});

test('settings and note targets cannot retain unrelated selections', () => {
  const settings = resolveNavigationTarget({ kind: 'settings' });
  const note = resolveNavigationTarget({ kind: 'note', noteId: 'note-1' });
  assert.equal(settings.activeTab, 'stats');
  assert.equal(settings.currentScreen, 'appSettings');
  assert.equal(settings.selectedDiaryId, '');
  assert.equal(note.selectedNoteId, 'note-1');
  assert.equal(note.selectedEntryId, '');
});
