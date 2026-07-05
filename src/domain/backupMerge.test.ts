import assert from 'node:assert/strict';
import test from 'node:test';
import type { RepositorySnapshot } from '../repositories/DiaryRepository';
import { buildPortableMergePlan } from './backupMerge';

const base = (): RepositorySnapshot => ({
  diaries: [{ id: 'd1', name: 'Local', emoji: '📔', color: '#000', isLocked: false, entryCount: 1, lastUpdated: 'Today' }],
  entries: [{ id: 'e1', diaryId: 'd1', date: '2026-01-01', title: 'Local entry', body: 'local', moodName: 'Calm', moodEmoji: '😌', tags: [], photoUris: [], photoCount: 0, wordCount: 1, createdAt: 1, updatedAt: 1 }],
  notes: [{ id: 'n1', title: 'Local note', body: 'local', isPinned: false, tags: [], createdAt: 1, updatedAt: 1 }],
  settings: { remindersEnabled: true, reminderTime: '20:00', theme: 'dark', customTags: ['local'], customMoods: [{ name: 'Quiet', emoji: '🌙' }] },
});

test('safe merge skips identical records and imports cloud-only content', () => {
  const local = base();
  const incoming = structuredClone(local);
  incoming.notes.push({ id: 'n2', title: 'Cloud', body: 'new', isPinned: false, tags: [], createdAt: 2, updatedAt: 2 });
  const plan = buildPortableMergePlan(local, incoming, 3, (kind, id) => `${kind}-copy-${id}`);
  assert.equal(plan.preview.skip.diaries, 1);
  assert.equal(plan.preview.skip.entries, 1);
  assert.equal(plan.preview.add.notes, 1);
  assert.equal(plan.snapshot.notes.length, 2);
  assert.equal(plan.preview.incoming.media, 3);
});

test('safe merge preserves conflicting entries and notes as recovered copies', () => {
  const local = base();
  const incoming = structuredClone(local);
  incoming.entries[0].body = 'cloud';
  incoming.notes[0].body = 'cloud';
  const plan = buildPortableMergePlan(local, incoming, 0, (kind, id) => `${kind}-copy-${id}`);
  assert.equal(plan.preview.conflicts.entries, 1);
  assert.equal(plan.preview.conflicts.notes, 1);
  assert.equal(plan.snapshot.entries.length, 2);
  assert.match(plan.snapshot.entries[1].title, /Recovered conflict/);
  assert.equal(plan.snapshot.notes.length, 2);
});

test('safe merge clones a conflicting diary and all of its cloud entries', () => {
  const local = base();
  const incoming = structuredClone(local);
  incoming.diaries[0].name = 'Cloud edition';
  const plan = buildPortableMergePlan(local, incoming, 0, (kind, id) => `${kind}-copy-${id}`);
  assert.equal(plan.preview.conflicts.diaries, 1);
  assert.equal(plan.snapshot.diaries.length, 2);
  assert.equal(plan.snapshot.entries.length, 2);
  assert.equal(plan.snapshot.entries[1].diaryId, 'diary-copy-d1');
});

test('safe merge keeps local settings and unions catalog conflicts', () => {
  const local = base();
  const incoming = structuredClone(local);
  incoming.settings = { remindersEnabled: false, reminderTime: '09:00', theme: 'light', customTags: ['cloud'], customMoods: [{ name: 'Quiet', emoji: '☀️' }] };
  const plan = buildPortableMergePlan(local, incoming, 0, (kind, id) => `${kind}-copy-${id}`);
  assert.equal(plan.snapshot.settings?.remindersEnabled, true);
  assert.equal(plan.snapshot.settings?.theme, 'dark');
  assert.deepEqual(plan.snapshot.settings?.customTags, ['local', 'cloud']);
  assert.equal(plan.preview.conflicts.moods, 1);
  assert.equal(plan.snapshot.settings?.customMoods?.length, 2);
});
