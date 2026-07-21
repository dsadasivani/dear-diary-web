import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (!arg.startsWith('--')) continue;
  const [key, inlineValue] = arg.slice(2).split('=');
  const value = inlineValue ?? process.argv[index + 1];
  args.set(key, value);
  if (inlineValue === undefined) index += 1;
}

const input = resolve(args.get('input') || 'benchmarks/dear-diary-seed.json');
const runs = Math.max(1, Math.floor(Number(args.get('runs') || 15)));

const percentile = (values, rank) => {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1),
  );
  return sorted[index] || 0;
};

const plainText = (value) =>
  String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const measure = (name, operation) => {
  const values = [];
  for (let index = 0; index < runs; index += 1) {
    const startedAt = performance.now();
    operation();
    values.push(performance.now() - startedAt);
  }
  return {
    name,
    count: runs,
    minMs: Math.min(...values),
    maxMs: Math.max(...values),
    averageMs: values.reduce((sum, value) => sum + value, 0) / values.length,
    p50Ms: percentile(values, 50),
    p95Ms: percentile(values, 95),
  };
};

const fixture = JSON.parse(await readFile(input, 'utf8'));
const diaries = fixture.diaries || [];
const entries = fixture.entries || [];
const notes = fixture.notes || [];
const outbox = Object.values(fixture.syncOutbox || {});
const syncEvents = fixture.syncEvents || [];
const mediaReferences = fixture.mediaReferences || [];
const firstDiaryId = diaries[0]?.id || '';
const currentDate = '2026-07-11';

const results = [
  measure('unlock.shell', () => {
    JSON.stringify({
      settings: fixture.settings,
      userProfile: fixture.userProfile,
      diaryCount: diaries.length,
      outboxCount: outbox.length,
    });
  }),
  measure('home.summary', () => {
    const todayWordCount = entries
      .filter((entry) => entry.date === currentDate)
      .reduce((sum, entry) => sum + (entry.wordCount || 0), 0);
    const recentEntries = [...entries]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 8);
    const pinnedNotes = notes
      .filter((note) => note.isPinned)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 5);
    const tagCounts = new Map();
    entries.forEach((entry) =>
      entry.tags.forEach((tag) => tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1)),
    );
    notes.forEach((note) =>
      note.tags.forEach((tag) => tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1)),
    );
    return { todayWordCount, recentEntries, pinnedNotes, tagCounts };
  }),
  measure('diary.detail.page', () => {
    return entries
      .filter((entry) => entry.diaryId === firstDiaryId)
      .sort(
        (left, right) => right.date.localeCompare(left.date) || right.updatedAt - left.updatedAt,
      )
      .slice(0, 50);
  }),
  measure('notes.page', () => {
    return notes
      .filter((note) => note.isPinned)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 50);
  }),
  measure('search.query', () => {
    const query = 'benchmark';
    const entryResults = entries.filter(
      (entry) =>
        entry.title.toLowerCase().includes(query) ||
        plainText(entry.body).toLowerCase().includes(query),
    );
    const noteResults = notes.filter(
      (note) =>
        note.title.toLowerCase().includes(query) ||
        plainText(note.body).toLowerCase().includes(query),
    );
    return entryResults.length + noteResults.length;
  }),
  measure('stats.dashboard', () => {
    const moodCounts = new Map();
    const heatmap = new Map();
    let photoCount = 0;
    entries.forEach((entry) => {
      moodCounts.set(entry.moodName, (moodCounts.get(entry.moodName) || 0) + 1);
      photoCount += entry.photoCount || 0;
      const row = heatmap.get(entry.date) || { count: 0, wordCount: 0 };
      row.count += 1;
      row.wordCount += entry.wordCount || 0;
      heatmap.set(entry.date, row);
    });
    return { moodCounts, heatmap, photoCount };
  }),
  measure('outbox.scan', () => {
    return outbox
      .filter(
        (operation) => operation.state !== 'applied' && operation.state !== 'conflict_preserved',
      )
      .sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0));
  }),
  measure('event.replay.metadata', () => {
    let expected = 1;
    const versions = new Map();
    syncEvents.forEach((event) => {
      if (event.sequence !== expected) throw new Error('Benchmark event sequence gap.');
      versions.set(
        event.recordId,
        Math.max(versions.get(event.recordId) || 0, event.recordVersion),
      );
      expected += 1;
    });
    return versions;
  }),
  measure('projection.rebuild', () =>
    entries.map((entry) => ({
      id: entry.id,
      diaryId: entry.diaryId,
      date: entry.date,
      title: entry.title,
      wordCount: entry.wordCount,
      photoCount: entry.photoCount,
      updatedAt: entry.updatedAt,
    })),
  ),
  measure('snapshot.export_import', () =>
    JSON.parse(JSON.stringify({ diaries, entries, notes, mediaReferences })),
  ),
  measure('media.reference.page', () => mediaReferences.slice(0, 100)),
];

console.table(
  results.map((result) => ({
    name: result.name,
    count: result.count,
    minMs: result.minMs.toFixed(2),
    p50Ms: result.p50Ms.toFixed(2),
    p95Ms: result.p95Ms.toFixed(2),
    maxMs: result.maxMs.toFixed(2),
    averageMs: result.averageMs.toFixed(2),
  })),
);
