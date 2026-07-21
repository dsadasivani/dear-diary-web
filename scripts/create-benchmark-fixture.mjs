#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (!arg.startsWith('--')) continue;
  const [key, inlineValue] = arg.slice(2).split('=');
  const value = inlineValue ?? process.argv[index + 1];
  args.set(key, value);
  if (inlineValue === undefined) index += 1;
}

const numberArg = (name, fallback) => {
  const value = Number(args.get(name) ?? fallback);
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid --${name} value.`);
  return Math.floor(value);
};

const output = resolve(args.get('output') || 'benchmarks/dear-diary-seed.json');
const diaryCount = numberArg('diaries', 100);
const entryCount = numberArg('entries', 10_000);
const noteCount = numberArg('notes', 10_000);
const outboxCount = numberArg('outbox', 250);
const mediaCount = numberArg('media', 10_000);
const syncEventCount = numberArg('sync-events', 10_000);

const moods = [
  ['Joyful', '😊'],
  ['Calm', '😌'],
  ['Reflective', '💭'],
  ['Creative', '🎨'],
  ['Tired', '😴'],
];
const tags = ['family', 'work', 'health', 'dreams', 'travel', 'gratitude', 'ideas', 'photos'];
const dayMs = 86_400_000;
const start = Date.UTC(2024, 0, 1);

const diaries = Array.from({ length: diaryCount }, (_, index) => ({
  id: `bench-diary-${index + 1}`,
  name: `Benchmark Diary ${index + 1}`,
  emoji: index % 3 === 0 ? '📘' : index % 3 === 1 ? '📗' : '📙',
  color: ['#8A3D55', '#5D7F71', '#9A6A3A', '#59456B'][index % 4],
  isLocked: index % 17 === 0,
  entryCount: 0,
  lastUpdated: 'No entries yet',
  lastEntryUpdatedAt: undefined,
}));

const entries = Array.from({ length: entryCount }, (_, index) => {
  const diary = diaries[index % diaries.length];
  const date = new Date(start + (index % 900) * dayMs).toISOString().slice(0, 10);
  const [moodName, moodEmoji] = moods[index % moods.length];
  const hasMedia = index % 9 === 0;
  const blockCount = 1 + (index % 4);
  return {
    id: `bench-entry-${index + 1}`,
    diaryId: diary.id,
    date,
    time: `${String(index % 24).padStart(2, '0')}:${String((index * 7) % 60).padStart(2, '0')}`,
    title: `Benchmark entry ${index + 1}`,
    body: `<p>Benchmark body ${index + 1} with enough words for search and timing.</p>`,
    moodName,
    moodEmoji,
    tags: [tags[index % tags.length], tags[(index + 3) % tags.length]],
    photoUris: hasMedia ? [`benchmark-media://${index + 1}/photo-1`] : [],
    photoCount: hasMedia ? 1 : 0,
    wordCount: 11,
    createdAt: start + index * 60_000,
    updatedAt: start + index * 60_000 + 30_000,
    isTimelineBifurcated: blockCount > 1,
    blocks: Array.from({ length: blockCount }, (_, blockIndex) => ({
      id: `bench-entry-${index + 1}-block-${blockIndex + 1}`,
      time: `${String((index + blockIndex) % 24).padStart(2, '0')}:00`,
      body: `<p>Timeline block ${blockIndex + 1} for benchmark entry ${index + 1}.</p>`,
      audioUri:
        blockIndex === 0 && index % 31 === 0 ? `benchmark-media://${index + 1}/audio-1` : undefined,
    })),
  };
});

const notes = Array.from({ length: noteCount }, (_, index) => ({
  id: `bench-note-${index + 1}`,
  title: `Benchmark note ${index + 1}`,
  body: `<p>Quick note body ${index + 1} with searchable benchmark text.</p>`,
  isPinned: index % 13 === 0,
  tags: [tags[(index + 2) % tags.length]],
  createdAt: start + index * 45_000,
  updatedAt: start + index * 45_000 + 20_000,
}));

const entryCounts = new Map();
const lastUpdated = new Map();
entries.forEach((entry) => {
  entryCounts.set(entry.diaryId, (entryCounts.get(entry.diaryId) || 0) + 1);
  lastUpdated.set(entry.diaryId, Math.max(lastUpdated.get(entry.diaryId) || 0, entry.updatedAt));
});
diaries.forEach((diary) => {
  diary.entryCount = entryCounts.get(diary.id) || 0;
  const updatedAt = lastUpdated.get(diary.id);
  diary.lastUpdated = updatedAt ? new Date(updatedAt).toISOString() : 'No entries yet';
  diary.lastEntryUpdatedAt = updatedAt;
});

const syncOutbox = Object.fromEntries(
  Array.from({ length: outboxCount }, (_, index) => [
    `bench-operation-${index + 1}`,
    {
      operationId: `bench-operation-${index + 1}`,
      accountId: 'benchmark-account',
      deviceId: 'benchmark-device',
      partitionKey: 'month:2026-07',
      affectedPartitionKeys: ['month:2026-07'],
      recordType: index % 2 === 0 ? 'entry' : 'note',
      recordId: index % 2 === 0 ? `bench-entry-${index + 1}` : `bench-note-${index + 1}`,
      operation: 'upsert',
      payload: index % 2 === 0 ? entries[index % entries.length] : notes[index % notes.length],
      state: 'prepared',
      createdAt: start + index,
      updatedAt: start + index,
      localApplied: true,
    },
  ]),
);

const mediaReferences = Array.from({ length: mediaCount }, (_, index) => ({
  mediaId: `bench-media-${index + 1}`,
  objectKey: `bench-object-${index + 1}`,
  sizeBytes: 64 * 1024 + (index % 128) * 1024,
}));

const syncEvents = Array.from({ length: syncEventCount }, (_, index) => ({
  sequence: index + 1,
  eventId: `bench-event-${index + 1}`,
  operationId: `bench-remote-operation-${index + 1}`,
  recordId: `bench-note-${(index % Math.max(1, noteCount)) + 1}`,
  recordVersion: Math.floor(index / Math.max(1, noteCount)) + 1,
}));

const fixture = {
  version: 1,
  generatedAt: new Date().toISOString(),
  diaries,
  entries,
  notes,
  settings: {
    remindersEnabled: false,
    reminderTime: '20:00',
    customTags: tags,
    customMoods: moods.map(([name, emoji]) => ({ name, emoji })),
    theme: 'light',
  },
  userProfile: {
    name: 'Benchmark Writer',
    email: 'benchmark@example.com',
    bio: '',
    avatarEmoji: 'B',
    avatarColor: '#5D7F71',
    writingGoal: 500,
    joinedDate: '07/2026',
  },
  syncOutbox,
  mediaReferences,
  syncEvents,
};

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
console.log(`Wrote ${output}`);
console.log(
  `Seed contains ${diaries.length} diaries, ${entries.length} entries, ${notes.length} notes, ${outboxCount} outbox operations, ${mediaCount} media references, and ${syncEventCount} sync events.`,
);
