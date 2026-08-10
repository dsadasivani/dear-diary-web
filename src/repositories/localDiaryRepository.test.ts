import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  LocalDataStore,
  LocalEntryProjection,
  LocalEntryQueryOptions,
  LocalNoteProjection,
  LocalNoteQueryOptions,
  LocalQueryPageResult,
  LocalStructuredRecordMutation,
} from '../platform/storage';
import type {
  AppSettings,
  Entry,
  Note,
  SecurityConfig,
  UserProfile,
} from '../types';
import { LocalDiaryRepository } from './localDiaryRepository';
import { createSyncDomainEvent } from '../sync/domainEvents';
import { pageEntries, pageNotes } from '../platform/storage/queryPagination';
import { richTextHtmlToPlainText } from '../domain/richTextSanitizer';
import { PersistentOutboxRepository, type SyncOperation } from '../sync/outbox';
import { toLocalDateKey } from '../utils/localDate';

class MemoryDataStore implements LocalDataStore {
  private values = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async setItems(items: Record<string, string>): Promise<void> {
    Object.entries(items).forEach(([key, value]) => this.values.set(key, value));
  }

  async removeItem(key: string): Promise<void> {
    this.values.delete(key);
  }

  async clear(): Promise<void> {
    this.values.clear();
  }
}

class PausingMemoryDataStore extends MemoryDataStore {
  private pause:
    | {
        key: string;
        entered: () => void;
        release: Promise<void>;
      }
    | undefined;

  pauseNextWriteContaining(key: string): { entered: Promise<void>; release: () => void } {
    let markEntered!: () => void;
    let releaseWrite!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    this.pause = { key, entered: markEntered, release };
    return { entered, release: releaseWrite };
  }

  override async setItems(items: Record<string, string>): Promise<void> {
    const pause = this.pause;
    if (pause && Object.hasOwn(items, pause.key)) {
      this.pause = undefined;
      pause.entered();
      await pause.release;
    }
    await super.setItems(items);
  }
}

class RecordingMemoryDataStore extends MemoryDataStore {
  batches: string[][] = [];

  override async setItems(items: Record<string, string>): Promise<void> {
    this.batches.push(Object.keys(items));
    await super.setItems(items);
  }
}

test('persists sync health across repository restarts without exposing it only through React state', async () => {
  const store = new MemoryDataStore();
  const first = new LocalDiaryRepository(store);
  await first.updateSyncHealth({
    authState: 'EXPIRED',
    integrityState: 'WARNING',
    lastErrorCode: 'AUTH_EXPIRED',
  });

  const restarted = new LocalDiaryRepository(store);
  const health = await restarted.getSyncHealth();
  assert.equal(health.authState, 'EXPIRED');
  assert.equal(health.integrityState, 'WARNING');
  assert.equal(health.lastErrorCode, 'AUTH_EXPIRED');
});

test('exposes current catch-up progress and recoverable failure state in sync status', async () => {
  const repository = new LocalDiaryRepository(new MemoryDataStore());
  await repository.initialize();
  await repository.updateSyncCatchUpStatus({
    catchUpPhase: 'failed',
    appliedSequence: 40,
    targetSequence: 75,
    catchUpError: 'Network unavailable',
    catchUpRecoverable: true,
  });

  const status = await repository.getSyncStatusSummary();
  assert.equal(status.catchUpPhase, 'failed');
  assert.equal(status.appliedSequence, 40);
  assert.equal(status.targetSequence, 75);
  assert.equal(status.catchUpError, 'Network unavailable');
  assert.equal(status.catchUpRecoverable, true);
});

type StructuredTestRecord = { id: string };

const cloneTestValue = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

class StructuredMemoryDataStore extends MemoryDataStore {
  private readonly collections: Map<string, StructuredTestRecord[]>;
  private readonly collectionReadCounts = new Map<string, number>();
  private readonly recordReadCounts = new Map<string, number>();
  entryQueryCount = 0;
  noteQueryCount = 0;
  entryProjectionQueryCount = 0;
  noteProjectionQueryCount = 0;
  structuredCommitCount = 0;
  localMutationCommitCount = 0;
  lastStructuredCommitRecords: LocalStructuredRecordMutation[] = [];

  constructor(collections: Record<string, StructuredTestRecord[]>) {
    super();
    this.collections = new Map(
      Object.entries(collections).map(([key, records]) => [key, cloneTestValue(records)]),
    );
  }

  async getStructuredCollection<T>(key: string): Promise<T[] | undefined> {
    const records = this.collections.get(key);
    if (!records) return undefined;
    this.collectionReadCounts.set(key, this.collectionReadCount(key) + 1);
    return cloneTestValue(records) as T[];
  }

  async getStructuredRecord<T>(key: string, id: string): Promise<T | null | undefined> {
    const records = this.collections.get(key);
    if (!records) return undefined;
    this.recordReadCounts.set(key, this.recordReadCount(key) + 1);
    const record = records.find((item) => item.id === id);
    return record ? (cloneTestValue(record) as T) : null;
  }

  async queryEntries(
    options: LocalEntryQueryOptions,
  ): Promise<LocalQueryPageResult<Entry> | undefined> {
    const records = this.collections.get('deardiary_entries') as Entry[] | undefined;
    if (!records) return undefined;
    this.entryQueryCount += 1;
    const allowed = options.allowedDiaryIds ? new Set(options.allowedDiaryIds) : null;
    const excluded = options.excludeDiaryIds ? new Set(options.excludeDiaryIds) : null;
    const query = options.query?.trim().toLowerCase();
    const tags = options.tags?.map((tag) => tag.toLowerCase()) || [];
    const filtered = records
      .filter((entry) => !options.diaryId || entry.diaryId === options.diaryId)
      .filter((entry) => !options.yearMonth || entry.date.startsWith(options.yearMonth))
      .filter((entry) => !options.fromDate || entry.date >= options.fromDate)
      .filter((entry) => !options.toDate || entry.date <= options.toDate)
      .filter((entry) => !options.mood || entry.moodName === options.mood)
      .filter(
        (entry) => options.hasPhotos === undefined || entry.photoCount > 0 === options.hasPhotos,
      )
      .filter(
        (entry) =>
          tags.length === 0 ||
          tags.every((tag) => entry.tags.some((entryTag) => entryTag.toLowerCase() === tag)),
      )
      .filter(
        (entry) =>
          !query ||
          entry.title.toLowerCase().includes(query) ||
          richTextHtmlToPlainText(entry.body).toLowerCase().includes(query) ||
          entry.tags.some((tag) => tag.toLowerCase().includes(query)) ||
          entry.moodName.toLowerCase().includes(query),
      )
      .filter(
        (entry) =>
          (!allowed || allowed.has(entry.diaryId)) && (!excluded || !excluded.has(entry.diaryId)),
      );
    return cloneTestValue(
      pageEntries(filtered, options, options.sort || 'date-desc'),
    ) as LocalQueryPageResult<Entry>;
  }

  async queryNotes(
    options: LocalNoteQueryOptions,
  ): Promise<LocalQueryPageResult<Note> | undefined> {
    const records = this.collections.get('deardiary_notes') as Note[] | undefined;
    if (!records) return undefined;
    this.noteQueryCount += 1;
    const query = options.query?.trim().toLowerCase();
    const tags = options.tags?.map((tag) => tag.toLowerCase()) || [];
    const filtered = records
      .filter((note) => {
        if (options.filter === 'pinned') return note.isPinned;
        if (options.filter === 'tagged') return note.tags.length > 0;
        if (options.filter === 'untagged') return note.tags.length === 0;
        return true;
      })
      .filter((note) => {
        const date = toLocalDateKey(note.updatedAt);
        return (
          (!options.fromDate || date >= options.fromDate) &&
          (!options.toDate || date <= options.toDate)
        );
      })
      .filter(
        (note) =>
          tags.length === 0 ||
          tags.every((tag) => note.tags.some((noteTag) => noteTag.toLowerCase() === tag)),
      )
      .filter(
        (note) =>
          !query ||
          note.title.toLowerCase().includes(query) ||
          richTextHtmlToPlainText(note.body).toLowerCase().includes(query) ||
          note.tags.some((tag) => tag.toLowerCase().includes(query)),
      );
    return cloneTestValue(
      pageNotes(filtered, options, options.sort || 'pinned-updated-desc'),
    ) as LocalQueryPageResult<Note>;
  }

  async queryEntryProjections(
    options: LocalEntryQueryOptions,
  ): Promise<LocalQueryPageResult<LocalEntryProjection> | undefined> {
    const records = this.collections.get('deardiary_entries') as Entry[] | undefined;
    if (!records) return undefined;
    this.entryProjectionQueryCount += 1;
    const allowed = options.allowedDiaryIds ? new Set(options.allowedDiaryIds) : null;
    const excluded = options.excludeDiaryIds ? new Set(options.excludeDiaryIds) : null;
    const filtered = records
      .filter((entry) => !options.diaryId || entry.diaryId === options.diaryId)
      .filter((entry) => !options.fromDate || entry.date >= options.fromDate)
      .filter((entry) => !options.toDate || entry.date <= options.toDate)
      .filter(
        (entry) =>
          (!allowed || allowed.has(entry.diaryId)) && (!excluded || !excluded.has(entry.diaryId)),
      )
      .map((entry) => ({
        id: entry.id,
        diaryId: entry.diaryId,
        date: entry.date,
        time: entry.time,
        title: entry.title,
        moodName: entry.moodName,
        moodEmoji: entry.moodEmoji,
        tags: entry.tags,
        photoUris: entry.photoUris,
        photoCount: entry.photoCount,
        wordCount: entry.wordCount,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      }));
    return cloneTestValue(pageEntries(filtered, options, options.sort || 'date-desc', 10_000));
  }

  async queryNoteProjections(
    options: LocalNoteQueryOptions,
  ): Promise<LocalQueryPageResult<LocalNoteProjection> | undefined> {
    const records = this.collections.get('deardiary_notes') as Note[] | undefined;
    if (!records) return undefined;
    this.noteProjectionQueryCount += 1;
    const tags = (options.tags || []).map((tag) => tag.toLowerCase());
    const filtered = records
      .filter((note) => {
        if (options.filter === 'pinned') return note.isPinned;
        if (options.filter === 'tagged') return note.tags.length > 0;
        if (options.filter === 'untagged') return note.tags.length === 0;
        return true;
      })
      .filter(
        (note) =>
          tags.length === 0 ||
          tags.every((tag) => note.tags.some((noteTag) => noteTag.toLowerCase() === tag)),
      )
      .map((note) => ({
        id: note.id,
        title: note.title,
        isPinned: note.isPinned,
        tags: note.tags,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
      }));
    return cloneTestValue(
      pageNotes(filtered, options, options.sort || 'pinned-updated-desc', 10_000),
    );
  }

  async commitStructuredRecords(input: {
    records: LocalStructuredRecordMutation[];
    items?: Record<string, string>;
  }): Promise<void> {
    this.structuredCommitCount += 1;
    this.lastStructuredCommitRecords = cloneTestValue(input.records);
    this.applyStructuredRecordMutations(input.records);
    if (input.items) await this.setItems(input.items);
  }

  async commitLocalMutationAndOutbox(input: {
    records: LocalStructuredRecordMutation[];
    items?: Record<string, string>;
    outboxOperation: SyncOperation;
  }): Promise<void> {
    this.localMutationCommitCount += 1;
    this.applyStructuredRecordMutations(input.records);
    const currentOperations = JSON.parse(
      (await this.getItem('deardiary_sync_operations')) || '{}',
    ) as Record<string, SyncOperation>;
    currentOperations[input.outboxOperation.operationId] = cloneTestValue(input.outboxOperation);
    await this.setItems({
      ...(input.items || {}),
      deardiary_sync_operations: JSON.stringify(currentOperations),
    });
  }

  private applyStructuredRecordMutations(records: LocalStructuredRecordMutation[]): void {
    records.forEach((record) => {
      const collection = cloneTestValue(
        this.collections.get(record.key) || [],
      ) as StructuredTestRecord[];
      if (record.value === null) {
        this.collections.set(
          record.key,
          collection.filter((item) => item.id !== record.id),
        );
        return;
      }
      const nextRecord = cloneTestValue(record.value as StructuredTestRecord);
      const next = collection.map((item) => (item.id === record.id ? nextRecord : item));
      if (!collection.some((item) => item.id === record.id)) next.push(nextRecord);
      this.collections.set(record.key, next);
    });
  }

  collectionReadCount(key: string): number {
    return this.collectionReadCounts.get(key) || 0;
  }

  recordReadCount(key: string): number {
    return this.recordReadCounts.get(key) || 0;
  }
}

const createRepository = async (store = new MemoryDataStore()): Promise<LocalDiaryRepository> => {
  const repository = new LocalDiaryRepository(store);
  await repository.initialize();
  return repository;
};

test('creates entries, updates diary statistics, and cascades diary deletion', async () => {
  const repository = await createRepository();
  const diary = await repository.createDiary({
    name: 'Travel',
    emoji: 'T',
    color: '#123456',
    isLocked: false,
  });

  const entry = await repository.createEntry({
    diaryId: diary.id,
    date: '2026-07-04',
    title: 'Arrival',
    body: '<p>Hello from the train</p>',
    moodName: 'Calm',
    moodEmoji: ':)',
    tags: ['travel'],
    photoUris: [],
  });

  assert.equal(entry.wordCount, 4);
  assert.equal((await repository.getDiary(diary.id))?.entryCount, 1);

  assert.equal(await repository.deleteDiary(diary.id), true);
  assert.equal(await repository.getDiary(diary.id), null);
  assert.equal(await repository.getEntry(entry.id), null);
});

test('uses structured storage reads for direct entries and notes', async () => {
  const entry: Entry = {
    id: 'entry-structured-read',
    diaryId: 'diary-default',
    date: '2026-07-10',
    title: 'Structured entry',
    body: '<p>Fast path</p>',
    moodName: 'Calm',
    moodEmoji: '',
    tags: ['local-first'],
    photoUris: [],
    photoCount: 0,
    wordCount: 2,
    createdAt: 1,
    updatedAt: 2,
  };
  const note: Note = {
    id: 'note-structured-read',
    title: 'Structured note',
    body: '<p>Fast path</p>',
    isPinned: true,
    tags: ['local-first'],
    createdAt: 1,
    updatedAt: 2,
  };
  const store = new StructuredMemoryDataStore({
    deardiary_entries: [entry],
    deardiary_notes: [note],
  });
  const repository = await createRepository(store);

  assert.equal((await repository.getEntry(entry.id))?.title, 'Structured entry');
  assert.equal((await repository.getNote(note.id))?.title, 'Structured note');
  assert.equal(store.recordReadCount('deardiary_entries'), 1);
  assert.equal(store.recordReadCount('deardiary_notes'), 1);
  assert.equal(store.collectionReadCount('deardiary_entries'), 0);
  assert.equal(store.collectionReadCount('deardiary_notes'), 0);

  assert.deepEqual(
    (await repository.listEntries()).map((item) => item.id),
    [entry.id],
  );
  assert.deepEqual(
    (await repository.listNotes()).map((item) => item.id),
    [note.id],
  );
  assert.equal(store.collectionReadCount('deardiary_entries'), 1);
  assert.equal(store.collectionReadCount('deardiary_notes'), 1);
});

test('uses storage-backed page queries for entry and note screens', async () => {
  const entries: Entry[] = [
    {
      id: 'entry-query-old',
      diaryId: 'diary-default',
      date: '2026-07-09',
      title: 'Older',
      body: '<p>Older body</p>',
      moodName: 'Calm',
      moodEmoji: '',
      tags: [],
      photoUris: [],
      photoCount: 0,
      wordCount: 2,
      createdAt: 1,
      updatedAt: 2,
    },
    {
      id: 'entry-query-new',
      diaryId: 'diary-default',
      date: '2026-07-10',
      title: 'Newer',
      body: '<p>Newer body</p>',
      moodName: 'Calm',
      moodEmoji: '',
      tags: ['keep'],
      photoUris: [],
      photoCount: 0,
      wordCount: 2,
      createdAt: 3,
      updatedAt: 4,
    },
    {
      id: 'entry-query-hidden',
      diaryId: 'diary-hidden',
      date: '2026-07-11',
      title: 'Hidden',
      body: '<p>Hidden body</p>',
      moodName: 'Calm',
      moodEmoji: '',
      tags: [],
      photoUris: [],
      photoCount: 0,
      wordCount: 2,
      createdAt: 5,
      updatedAt: 6,
    },
  ];
  const notes: Note[] = [
    {
      id: 'note-query-pinned',
      title: 'Pinned',
      body: '<p>Pinned body</p>',
      isPinned: true,
      tags: ['keep'],
      createdAt: 1,
      updatedAt: Date.UTC(2026, 6, 10),
    },
    {
      id: 'note-query-loose',
      title: 'Loose',
      body: '<p>Loose body</p>',
      isPinned: false,
      tags: [],
      createdAt: 2,
      updatedAt: Date.UTC(2026, 6, 11),
    },
  ];
  const store = new StructuredMemoryDataStore({
    deardiary_entries: entries,
    deardiary_notes: notes,
  });
  const repository = await createRepository(store);

  const entryPage = await repository.listEntriesByDiary('diary-default', { limit: 1 });
  assert.deepEqual(
    entryPage.items.map((item) => item.id),
    ['entry-query-new'],
  );
  assert.match(entryPage.nextCursor || '', /^ks:/);
  assert.equal(entryPage.total, 2);
  const nextEntryPage = await repository.listEntriesByDiary('diary-default', {
    limit: 1,
    cursor: entryPage.nextCursor,
  });
  assert.deepEqual(
    nextEntryPage.items.map((item) => item.id),
    ['entry-query-old'],
  );
  assert.equal(nextEntryPage.nextCursor, undefined);

  const searchPage = await repository.searchEntries({
    diaryId: 'diary-default',
    hasPhotos: false,
    limit: 5,
  });
  assert.deepEqual(
    searchPage.items.map((item) => item.id),
    ['entry-query-new', 'entry-query-old'],
  );
  const summarySearchPage = await repository.searchEntries({
    diaryId: 'diary-default',
    includeBody: false,
    limit: 5,
  });
  assert.equal('body' in summarySearchPage.items[0], false);
  const querySearchPage = await repository.searchEntries({
    diaryId: 'diary-default',
    query: 'newer',
    tags: ['keep'],
    limit: 5,
  });
  assert.deepEqual(
    querySearchPage.items.map((item) => item.id),
    ['entry-query-new'],
  );

  const notePage = await repository.listNotes({ filter: 'pinned', limit: 5 });
  assert.deepEqual(
    notePage.items.map((item) => item.id),
    ['note-query-pinned'],
  );
  assert.equal('body' in notePage.items[0], false);
  const noteSearchPage = await repository.searchNotes({
    query: 'pinned',
    tags: ['keep'],
    limit: 5,
  });
  assert.deepEqual(
    noteSearchPage.items.map((item) => item.id),
    ['note-query-pinned'],
  );
  assert.equal(store.entryQueryCount, 2);
  assert.equal(store.entryProjectionQueryCount, 3);
  assert.equal(store.noteQueryCount, 1);
  assert.equal(store.noteProjectionQueryCount, 1);
  assert.equal(store.collectionReadCount('deardiary_entries'), 0);
  assert.equal(store.collectionReadCount('deardiary_notes'), 0);
});

test('uses body-free projections for Home and Stats without reading full collections', async () => {
  const entries: Entry[] = [
    {
      id: 'entry-projection-home',
      diaryId: 'diary-default',
      date: '2026-07-12',
      title: 'Projected entry',
      body: '<p>private body must not be loaded</p>',
      moodName: 'Calm',
      moodEmoji: ':)',
      tags: ['projection'],
      photoUris: ['data:image/png;base64,cHJvamVjdGlvbg=='],
      photoCount: 1,
      wordCount: 6,
      createdAt: 1,
      updatedAt: 2,
    },
  ];
  const notes: Note[] = [
    {
      id: 'note-projection-home',
      title: 'Projected note',
      body: '<p>private note body must not be loaded</p>',
      isPinned: true,
      tags: ['projection'],
      createdAt: 1,
      updatedAt: 2,
    },
  ];
  const store = new StructuredMemoryDataStore({
    deardiary_entries: entries,
    deardiary_notes: notes,
  });
  const repository = await createRepository(store);

  const [home, global, moods, tags, heatmap, entryPage, notePage] = await Promise.all([
    repository.getHomeSummary(),
    repository.getGlobalStatistics(),
    repository.getMoodDistribution(),
    repository.getTagDistribution(),
    repository.getWritingHeatmap(),
    repository.searchEntries({ includeBody: false, limit: 10_000 }),
    repository.listNotes({ includeBody: false, limit: 10_000 }),
  ]);

  assert.equal(home.entryCount, 1);
  assert.equal(global.wordCount, 6);
  assert.equal(moods[0]?.label, 'Calm');
  assert.equal(tags[0]?.label, 'projection');
  assert.equal(heatmap[0]?.wordCount, 6);
  assert.equal('body' in entryPage.items[0], false);
  assert.equal('body' in notePage.items[0], false);
  assert.equal(store.collectionReadCount('deardiary_entries'), 0);
  assert.equal(store.collectionReadCount('deardiary_notes'), 0);
  assert.ok(store.entryProjectionQueryCount >= 1);
  assert.ok(store.noteProjectionQueryCount >= 1);
});

test('rebuilds structured projections without changing authoritative records', async () => {
  const store = new StructuredMemoryDataStore({
    deardiary_diaries: [],
    deardiary_entries: [],
    deardiary_notes: [],
  });
  const repository = await createRepository(store);
  const note = await repository.createNote({
    title: 'Projection source',
    body: '<p>Body</p>',
    isPinned: true,
    tags: ['safe'],
  });
  await repository.rebuildDerivedProjections();
  assert.equal((await repository.getNote(note.id))?.title, 'Projection source');
});

test('search excludes locked diary entries when locked diary IDs are provided', async () => {
  const repository = await createRepository();
  const openDiary = await repository.createDiary({
    name: 'Open diary',
    emoji: 'O',
    color: '#123456',
    isLocked: false,
  });
  const lockedDiary = await repository.createDiary({
    name: 'Locked diary',
    emoji: 'L',
    color: '#654321',
    isLocked: true,
  });
  await repository.createEntry({
    diaryId: openDiary.id,
    date: '2026-07-10',
    title: 'Public picnic',
    body: '<p>ordinary visible memory</p>',
    moodName: 'Calm',
    moodEmoji: '',
    tags: ['shared'],
    photoUris: [],
  });
  await repository.createEntry({
    diaryId: lockedDiary.id,
    date: '2026-07-11',
    title: 'Private keyword',
    body: '<p>secret locked diary body</p>',
    moodName: 'Calm',
    moodEmoji: '',
    tags: ['private'],
    photoUris: [],
  });

  const exactLockedQuery = await repository.searchEntries({
    query: 'secret locked diary body',
    excludeDiaryIds: [lockedDiary.id],
  });
  const tagQuery = await repository.searchEntries({
    tags: ['private'],
    excludeDiaryIds: [lockedDiary.id],
  });
  const allVisible = await repository.searchEntries({
    excludeDiaryIds: [lockedDiary.id],
    limit: 10,
  });

  assert.deepEqual(exactLockedQuery.items, []);
  assert.deepEqual(tagQuery.items, []);
  assert.deepEqual(
    allVisible.items.map((entry) => entry.diaryId),
    [openDiary.id],
  );
});

test('uses structured record commits for note CRUD without reading the full note collection', async () => {
  const store = new StructuredMemoryDataStore({ deardiary_notes: [] });
  const repository = await createRepository(store);

  const note = await repository.createNote({
    title: 'Record note',
    body: 'One',
    isPinned: false,
    tags: [],
  });
  assert.equal(store.structuredCommitCount, 1);
  assert.equal(store.collectionReadCount('deardiary_notes'), 0);
  assert.equal((await repository.getNote(note.id))?.title, 'Record note');

  await repository.updateNote({ ...note, title: 'Updated record note' });
  await repository.deleteNote(note.id);

  assert.equal(store.structuredCommitCount, 3);
  assert.equal(store.collectionReadCount('deardiary_notes'), 0);
  assert.equal(await repository.getNote(note.id), null);
  assert.equal((await repository.getLocalRepositoryMetadata()).contentRevision, 3);
});

test('uses atomic structured record and outbox commit for local-first note mutations', async () => {
  const store = new StructuredMemoryDataStore({ deardiary_notes: [] });
  const repository = await createRepository(store);
  const account = {
    accountId: 'account-structured',
    deviceId: 'device-structured',
    deviceRole: 'primary_mobile' as const,
    googleUserId: 'google-structured',
    googleEmail: 'writer@example.com',
    devicePublicKey: '{}',
    appliedSequence: 0,
    linkedAt: 1,
  };
  const note: Note = {
    id: 'note-structured-local',
    title: 'Structured local',
    body: 'Queued locally',
    isPinned: false,
    tags: [],
    createdAt: 1,
    updatedAt: 2,
  };

  await repository.applyLocalMutationWithOutbox({
    operationId: 'op-structured-local',
    recordType: 'note',
    recordId: note.id,
    operation: 'upsert',
    account,
    localPayload: note,
  });

  assert.equal(store.localMutationCommitCount, 1);
  assert.equal(store.collectionReadCount('deardiary_notes'), 0);
  assert.equal((await repository.getNote(note.id))?.title, 'Structured local');
  const outbox = await repository.listSyncOutboxOperations();
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].operationId, 'op-structured-local');
  assert.equal(outbox[0].state, 'PENDING');
  const operations = JSON.parse((await store.getItem('deardiary_sync_operations')) || '{}') as Record<
    string,
    SyncOperation
  >;
  assert.equal(operations['op-structured-local'].recordType, 'NOTE');
  assert.equal(operations['op-structured-local'].operationType, 'UPSERT');
  assert.equal(operations['op-structured-local'].baseRecordVersion, 0);
  assert.equal(operations['op-structured-local'].state, 'PENDING');
  assert.deepEqual(operations['op-structured-local'].sourceCanonicalPayload, note);
  assert.equal((await repository.getLocalRepositoryMetadata()).contentRevision, 1);
});

test('sanitizes malicious rich text when creating and updating entries and notes', async () => {
  const repository = await createRepository();
  const entry = await repository.createEntry({
    diaryId: 'diary-default',
    date: '2026-07-08',
    title: 'Unsafe',
    body: '<p onclick="alert(1)">Hello<img src=x onerror=alert(1)><strong style="color:red">world</strong></p>',
    moodName: 'Calm',
    moodEmoji: '',
    tags: [],
    photoUris: [],
    blocks: [
      { id: 'block-1', time: '10:00', body: '<script>alert(1)</script><em data-x="1">kept</em>' },
    ],
  });
  const note = await repository.createNote({
    title: 'Unsafe note',
    body: '<div class="x">Note<iframe src="https://evil.example"></iframe></div>',
    isPinned: false,
    tags: [],
  });

  assert.equal(entry.body, '<p>Hello<strong>world</strong></p>');
  assert.equal(entry.blocks?.[0].body, '<em>kept</em>');
  assert.equal(note.body, '<div>Note</div>');

  const updatedEntry = await repository.updateEntry({
    ...entry,
    body: '<h2 style="font-size:99px">Edited</h2><svg><script>alert(1)</script></svg>',
  });
  const updatedNote = await repository.updateNote({
    ...note,
    body: '<blockquote onclick="alert(1)">Edited<script>alert(1)</script></blockquote>',
  });

  assert.equal(updatedEntry?.body, '<h2>Edited</h2>');
  assert.equal(updatedNote?.body, '<blockquote>Edited</blockquote>');
});

test('serializes concurrent writes without losing notes', async () => {
  const repository = await createRepository();
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      repository.createNote({
        title: `Note ${index}`,
        body: `Body ${index}`,
        isPinned: false,
        tags: [],
      }),
    ),
  );

  assert.equal((await repository.listNotes()).length, 20);
});

test('exports and replaces application content while retaining target device lineage', async () => {
  const source = await createRepository();
  const settings: AppSettings = { remindersEnabled: true, reminderTime: '08:00 PM', theme: 'dark' };
  const profile: UserProfile = {
    name: 'Dilip',
    email: 'dilip@example.com',
    bio: 'Writing locally.',
    avatarEmoji: 'D',
    avatarColor: '#8A3D55',
    writingGoal: 250,
    joinedDate: 'July 2026',
  };
  const security: SecurityConfig = {
    isPinCreated: true,
    pinHash: 'hash',
    pinSalt: 'salt',
    isBiometricsEnabled: false,
    isLocked: true,
  };

  await source.createNote({ title: 'Remember', body: 'This', isPinned: true, tags: ['ideas'] });
  await source.saveSettings(settings);
  await source.saveUserProfile(profile);
  await source.saveSecurityConfig(security);

  const snapshot = await source.exportSnapshot();
  const target = await createRepository();
  await target.importSnapshot(snapshot, 'replace');

  const restored = await target.exportSnapshot();
  assert.deepEqual(restored.diaries, snapshot.diaries);
  assert.deepEqual(restored.entries, snapshot.entries);
  assert.deepEqual(restored.notes, snapshot.notes);
  assert.deepEqual(restored.settings, snapshot.settings);
  assert.deepEqual(restored.userProfile, snapshot.userProfile);
  assert.deepEqual(restored.security, snapshot.security);
});

test('imports snapshot parent diaries before child entries', async () => {
  const source = await createRepository();
  await source.createEntry({
    diaryId: 'diary-default',
    date: '2026-08-09',
    title: 'Restored entry',
    body: '',
    moodName: 'Calm',
    moodEmoji: '',
    tags: [],
    photoUris: [],
  });
  const store = new RecordingMemoryDataStore();
  const target = new LocalDiaryRepository(store);
  await target.initialize();
  store.batches = [];

  await target.importSnapshot(await source.exportSnapshot(), 'replace-portable');

  const restoreBatch = store.batches.find(
    (keys) => keys.includes('deardiary_diaries') && keys.includes('deardiary_entries'),
  );
  assert.ok(restoreBatch);
  assert.ok(restoreBatch.indexOf('deardiary_diaries') < restoreBatch.indexOf('deardiary_entries'));
});

test('sanitizes malicious rich text during snapshot import', async () => {
  const source = await createRepository();
  const entry = await source.createEntry({
    diaryId: 'diary-default',
    date: '2026-07-08',
    title: 'Imported',
    body: '<p>safe</p>',
    moodName: 'Calm',
    moodEmoji: '',
    tags: [],
    photoUris: [],
  });
  const note = await source.createNote({
    title: 'Imported note',
    body: '<p>safe</p>',
    isPinned: false,
    tags: [],
  });
  const snapshot = await source.exportSnapshot();
  snapshot.entries[0] = {
    ...entry,
    body: '<p onmouseover="alert(1)">Entry<script>alert(1)</script></p>',
  };
  snapshot.notes[0] = {
    ...note,
    body: '<div style="x:1">Note<img src=x onerror=alert(1)></div>',
  };

  const target = await createRepository();
  await target.importSnapshot(snapshot, 'replace-portable');

  assert.equal((await target.getEntry(entry.id))?.body, '<p>Entry</p>');
  assert.equal((await target.getNote(note.id))?.body, '<div>Note</div>');
});

test('initializes settings, profile, security, and local revision metadata', async () => {
  const repository = await createRepository();

  assert.equal((await repository.getSettings()).theme, 'light');
  assert.equal((await repository.getUserProfile()).name, 'Writer');
  const security = await repository.getSecurityConfig();
  assert.equal(security.isPinCreated, false);
  assert.equal(security.pinLockoutStage, 0);
  assert.equal(security.failedPinAttempts, 0);
  const backup = await repository.getLocalRepositoryMetadata();
  assert.ok(backup.deviceId);
  assert.equal(backup.contentRevision, 0);
});

test('persists device-local PIN lockout state', async () => {
  const repository = await createRepository();
  const lockedUntil = Date.now() + 15 * 60 * 1000;
  await repository.saveSecurityConfig({
    ...(await repository.getSecurityConfig()),
    isPinCreated: true,
    pinHash: 'hash',
    pinSalt: 'salt',
    pinLockoutStage: 1,
    failedPinAttempts: 0,
    pinLockedUntil: lockedUntil,
  });

  const restored = await repository.getSecurityConfig();
  assert.equal(restored.pinLockoutStage, 1);
  assert.equal(restored.failedPinAttempts, 0);
  assert.equal(restored.pinLockedUntil, lockedUntil);
});

test('portable restore preserves local security, reminders, theme, and backup identity', async () => {
  const source = await createRepository();
  await source.createNote({ title: 'Cloud note', body: 'Restored', isPinned: false, tags: [] });
  await source.saveSettings({
    remindersEnabled: false,
    reminderTime: '18:00',
    theme: 'dark',
    customTags: ['cloud'],
  });

  const target = await createRepository();
  const targetSecurity: SecurityConfig = {
    isPinCreated: true,
    pinHash: 'new-device-pin',
    pinSalt: 'new-device-salt',
    isBiometricsEnabled: true,
    isLocked: false,
    pinLockoutStage: 0,
    failedPinAttempts: 0,
  };
  await target.saveSecurityConfig(targetSecurity);
  await target.saveSettings({ remindersEnabled: true, reminderTime: '07:15', theme: 'light' });
  const before = await target.getLocalRepositoryMetadata();

  await target.importSnapshot(await source.exportSnapshot(), 'replace-portable');

  assert.equal((await target.listNotes())[0]?.title, 'Cloud note');
  assert.deepEqual(await target.getSecurityConfig(), targetSecurity);
  const settings = await target.getSettings();
  assert.equal(settings.remindersEnabled, true);
  assert.equal(settings.reminderTime, '07:15');
  assert.equal(settings.theme, 'light');
  assert.deepEqual(settings.customTags, ['cloud']);
  const after = await target.getLocalRepositoryMetadata();
  assert.equal(after.deviceId, before.deviceId);
  assert.equal(after.contentRevision, (before.contentRevision || 0) + 1);
});

test('increments and publishes a content revision after portable writes only', async () => {
  const repository = await createRepository();
  const revisions: number[] = [];
  const unsubscribe = repository.subscribeChanges((revision) => revisions.push(revision));

  await repository.createNote({ title: 'One', body: '', isPinned: false, tags: [] });
  await repository.saveSecurityConfig({
    ...(await repository.getSecurityConfig()),
    isLocked: false,
  });
  await repository.saveUserProfile({ ...(await repository.getUserProfile()), name: 'Updated' });
  unsubscribe();

  assert.deepEqual(revisions, [1, 2]);
  assert.equal((await repository.getLocalRepositoryMetadata()).contentRevision, 2);
});

test('applies canonical sync events idempotently and tracks record versions', async () => {
  const repository = await createRepository();
  await repository.saveLocalSyncAccountState({
    accountId: 'account-1',
    deviceId: 'device-1',
    deviceRole: 'primary_mobile',
    googleUserId: 'google-1',
    googleEmail: 'writer@example.com',
    devicePublicKey: '{}',
    appliedSequence: 2,
    linkedAt: 1,
  });
  const note = {
    id: 'note-cloud',
    title: 'Cloud note',
    body: 'Applied once.',
    isPinned: false,
    tags: [],
    createdAt: 10,
    updatedAt: 10,
  };
  const event = createSyncDomainEvent({
    accountId: 'account-1',
    deviceId: 'device-2',
    recordType: 'note',
    operation: 'upsert',
    recordId: note.id,
    baseRecordVersion: 0,
    payload: note,
  });

  await repository.applySyncEvent(event, 3);
  await repository.applySyncEvent(event, 3);

  assert.deepEqual(await repository.getNote(note.id), note);
  assert.equal(await repository.getSyncRecordVersion('note', note.id), 1);
  assert.equal((await repository.getLocalSyncAccountState())?.appliedSequence, 3);
});

test('atomically applies a remote event batch and rejects an invalid version chain', async () => {
  const store = new MemoryDataStore();
  const repository = await createRepository(store);
  const account = {
    accountId: 'account-1',
    deviceId: 'device-1',
    deviceRole: 'primary_mobile' as const,
    googleUserId: 'google-1',
    googleEmail: 'writer@example.com',
    devicePublicKey: '{}',
    appliedSequence: 0,
    linkedAt: 1,
  };
  await repository.saveLocalSyncAccountState(account);
  await store.setItem(
    'deardiary_sync_runtime',
    JSON.stringify({
      accountId: account.accountId,
      deviceId: account.deviceId,
      deviceStatus: 'ACTIVE',
      protocolVersion: 4,
      eventSchemaVersion: 2,
      keyEpoch: 1,
      lastAppliedSequence: 0,
      updatedAt: 1,
    }),
  );
  const note = (id: string, title: string) => ({
    id,
    title,
    body: '',
    isPinned: false,
    tags: [],
    createdAt: 10,
    updatedAt: 10,
  });
  const first = createSyncDomainEvent({
    accountId: account.accountId,
    deviceId: 'device-2',
    recordType: 'note',
    operation: 'upsert',
    recordId: 'note-batch-1',
    baseRecordVersion: 0,
    payload: note('note-batch-1', 'First'),
  });
  const second = createSyncDomainEvent({
    accountId: account.accountId,
    deviceId: 'device-2',
    recordType: 'note',
    operation: 'upsert',
    recordId: 'note-batch-2',
    baseRecordVersion: 0,
    payload: note('note-batch-2', 'Second'),
  });

  assert.equal(
    await repository.applyRemoteEventBatch(
      [
        { event: first, sequence: 1, operationId: 'operation-1' },
        { event: second, sequence: 2, operationId: 'operation-2' },
      ],
      0,
    ),
    2,
  );
  assert.equal((await repository.getLocalSyncAccountState())?.appliedSequence, 2);
  assert.equal(
    JSON.parse((await store.getItem('deardiary_sync_account'))!).appliedSequence,
    2,
  );
  assert.equal((await repository.getNote('note-batch-1'))?.title, 'First');
  assert.equal((await repository.getNote('note-batch-2'))?.title, 'Second');

  const invalid = createSyncDomainEvent({
    accountId: account.accountId,
    deviceId: 'device-2',
    recordType: 'note',
    operation: 'upsert',
    recordId: 'note-invalid',
    baseRecordVersion: 1,
    payload: note('note-invalid', 'Invalid'),
  });
  await assert.rejects(
    repository.applyRemoteEventBatch(
      [{ event: invalid, sequence: 3, operationId: 'operation-3' }],
      2,
    ),
  );
  assert.equal(await repository.getNote('note-invalid'), null);
  assert.equal((await repository.getLocalSyncAccountState())?.appliedSequence, 2);
});

test('orders parent diary mutations before child entries in an atomic replay batch', async () => {
  const store = new StructuredMemoryDataStore({
    deardiary_diaries: [],
    deardiary_entries: [],
    deardiary_notes: [],
  });
  const repository = await createRepository(store);
  const account = {
    accountId: 'account-1',
    deviceId: 'device-1',
    deviceRole: 'primary_mobile' as const,
    googleUserId: 'google-1',
    googleEmail: 'writer@example.com',
    devicePublicKey: '{}',
    appliedSequence: 0,
    linkedAt: 1,
  };
  await repository.saveLocalSyncAccountState(account);
  await store.setItem(
    'deardiary_sync_runtime',
    JSON.stringify({
      accountId: account.accountId,
      deviceId: account.deviceId,
      deviceStatus: 'ACTIVE',
      protocolVersion: 4,
      eventSchemaVersion: 2,
      keyEpoch: 1,
      lastAppliedSequence: 0,
      updatedAt: 1,
    }),
  );
  const diary = {
    id: 'diary-remote',
    name: 'Remote diary',
    emoji: '📔',
    color: '#8A3D55',
    isLocked: false,
    entryCount: 0,
    lastUpdated: 'No entries yet',
  };
  const entry = {
    id: 'entry-remote',
    diaryId: diary.id,
    date: '2026-08-09',
    time: '10:52',
    title: 'Remote entry',
    body: '',
    moodName: 'Joyful',
    moodEmoji: '😊',
    tags: [],
    photoUris: [],
    photoCount: 0,
    wordCount: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  const diaryEvent = createSyncDomainEvent({
    accountId: account.accountId,
    deviceId: 'device-2',
    recordType: 'diary',
    operation: 'upsert',
    recordId: diary.id,
    baseRecordVersion: 0,
    payload: diary,
  });
  const entryEvent = createSyncDomainEvent({
    accountId: account.accountId,
    deviceId: 'device-2',
    recordType: 'entry',
    operation: 'upsert',
    recordId: entry.id,
    baseRecordVersion: 0,
    payload: entry,
  });

  await repository.applyRemoteEventBatch(
    [
      { event: diaryEvent, sequence: 1, operationId: 'operation-diary' },
      { event: entryEvent, sequence: 2, operationId: 'operation-entry' },
    ],
    0,
  );

  const diaryMutationIndex = store.lastStructuredCommitRecords.findIndex(
    (mutation) => mutation.key === 'deardiary_diaries' && mutation.id === diary.id,
  );
  const entryMutationIndex = store.lastStructuredCommitRecords.findIndex(
    (mutation) => mutation.key === 'deardiary_entries' && mutation.id === entry.id,
  );
  assert.ok(diaryMutationIndex >= 0);
  assert.ok(entryMutationIndex >= 0);
  assert.ok(diaryMutationIndex < entryMutationIndex);
});

test('rebases concurrent photo-only entry conflicts with both device attachments', async () => {
  const store = new MemoryDataStore();
  const repository = await createRepository(store);
  const account = {
    accountId: 'account-1',
    deviceId: 'device-mobile',
    deviceRole: 'primary_mobile' as const,
    googleUserId: 'google-1',
    googleEmail: 'writer@example.com',
    devicePublicKey: '{}',
    appliedSequence: 0,
    linkedAt: 1,
  };
  await repository.saveLocalSyncAccountState(account);
  const diary = (await repository.listDiaries())[0];
  const baseEntry: Entry = {
    id: 'entry-concurrent-photos',
    diaryId: diary.id,
    date: '2026-08-10',
    time: '13:00',
    title: 'Shared entry',
    body: '<p>Same text on both devices.</p>',
    moodName: 'Calm',
    moodEmoji: '',
    tags: [],
    photoUris: [],
    photoCount: 0,
    wordCount: 5,
    createdAt: 1,
    updatedAt: 1,
  };
  const baseEvent = createSyncDomainEvent({
    accountId: account.accountId,
    deviceId: 'device-web',
    recordType: 'entry',
    recordId: baseEntry.id,
    operation: 'upsert',
    baseRecordVersion: 0,
    payload: baseEntry,
  });
  await repository.applyRemoteEventBatch(
    [{ event: baseEvent, sequence: 1, operationId: 'operation-base-entry' }],
    0,
  );

  const localPhoto =
    'http://localhost/_capacitor_file_/data/user/0/com.deardiary.app/files/media/mobile.webp';
  const localCanonicalPhoto = 'ddmedia:media-mobile:object-mobile';
  const remotePhoto = 'ddmedia:media-web:object-web';
  const localEntry = {
    ...baseEntry,
    photoUris: [localPhoto],
    photoCount: 1,
    updatedAt: 2,
  };
  await repository.applyLocalMutationWithOutbox({
    operationId: 'operation-mobile-photo',
    recordType: 'entry',
    recordId: baseEntry.id,
    operation: 'upsert',
    account,
    localPayload: localEntry,
  });
  const localOperation = (
    await repository.listSyncOutboxOperations(['PENDING'])
  ).find((operation) => operation.operationId === 'operation-mobile-photo')!;
  await repository.saveSyncOutboxOperation({
    ...localOperation,
    state: 'CONFLICT',
    preparedCanonicalPayload: {
      ...localEntry,
      photoUris: [localCanonicalPhoto],
    },
    lastErrorCode: 'RECORD_VERSION_CONFLICT',
  });
  await store.setItem(
    'deardiary_sync_conflicts',
    JSON.stringify({
      'sync-conflict:operation-mobile-photo': {
        conflictId: 'sync-conflict:operation-mobile-photo',
        operationId: 'operation-mobile-photo',
        recordType: 'ENTRY',
        recordId: baseEntry.id,
        localBaseVersion: 1,
        remoteVersion: 2,
        state: 'UNRESOLVED',
        createdAt: 2,
      },
    }),
  );
  const remoteEntry = {
    ...baseEntry,
    photoUris: [remotePhoto],
    photoCount: 1,
    updatedAt: 3,
  };
  const remoteEvent = createSyncDomainEvent({
    accountId: account.accountId,
    deviceId: 'device-web',
    recordType: 'entry',
    recordId: baseEntry.id,
    operation: 'upsert',
    baseRecordVersion: 1,
    payload: remoteEntry,
  });

  await repository.applyRemoteEventBatch(
    [{ event: remoteEvent, sequence: 2, operationId: 'operation-web-photo' }],
    1,
  );

  assert.deepEqual((await repository.getEntry(baseEntry.id))?.photoUris, [remotePhoto, localPhoto]);
  const operations = await repository.listSyncOutboxOperations();
  const superseded = operations.find(
    (operation) => operation.operationId === 'operation-mobile-photo',
  );
  const rebased = operations.find(
    (operation) => operation.operationId === superseded?.supersededByOperationId,
  );
  assert.equal(superseded?.state, 'SUPERSEDED');
  assert.equal(rebased?.state, 'PENDING');
  assert.equal(rebased?.baseRecordVersion, 2);
  assert.deepEqual((rebased?.sourceCanonicalPayload as Entry).photoUris, [remotePhoto, localPhoto]);
  const conflicts = JSON.parse((await store.getItem('deardiary_sync_conflicts')) || '{}');
  assert.equal(conflicts['sync-conflict:operation-mobile-photo'].state, 'RESOLVED');

  // Recovery also works after the winning remote event was already pulled by
  // an older client build and no new replay batch remains.
  await repository.saveSyncOutboxOperation({
    ...rebased!,
    state: 'CONFLICT',
    baseRecordVersion: 1,
    preparedCanonicalPayload: {
      ...(rebased!.sourceCanonicalPayload as Entry),
      photoUris: [remotePhoto, localCanonicalPhoto],
    },
    lastErrorCode: 'RECORD_VERSION_CONFLICT',
  });
  assert.equal(await repository.recoverConcurrentEntryPhotoConflicts(), 1);
  const recoveredOperations = await repository.listSyncOutboxOperations();
  const recoveredConflict = recoveredOperations.find(
    (operation) => operation.operationId === rebased!.operationId,
  );
  const recoveredRebase = recoveredOperations.find(
    (operation) => operation.operationId === recoveredConflict?.supersededByOperationId,
  );
  assert.equal(recoveredConflict?.state, 'SUPERSEDED');
  assert.equal(recoveredRebase?.state, 'PENDING');
  assert.equal(recoveredRebase?.baseRecordVersion, 2);
  assert.deepEqual((await repository.getEntry(baseEntry.id))?.photoUris, [remotePhoto, localPhoto]);

  for (const operation of await repository.listSyncOutboxOperations()) {
    await repository.removeSyncOutboxOperation(operation.operationId);
  }
  const storedConflicts = JSON.parse(
    (await store.getItem('deardiary_sync_conflicts')) || '{}',
  );
  storedConflicts['sync-conflict:operation-missing-outbox'] = {
    conflictId: 'sync-conflict:operation-missing-outbox',
    operationId: 'operation-missing-outbox',
    recordType: 'ENTRY',
    recordId: baseEntry.id,
    localBaseVersion: 1,
    remoteVersion: 2,
    state: 'UNRESOLVED',
    createdAt: 4,
  };
  await store.setItem('deardiary_sync_conflicts', JSON.stringify(storedConflicts));
  assert.equal(await repository.recoverConcurrentEntryPhotoConflicts(), 1);
  const reconstructed = (await repository.listSyncOutboxOperations()).find(
    (operation) => operation.state === 'PENDING',
  );
  assert.equal(reconstructed?.baseRecordVersion, 2);
  assert.deepEqual((reconstructed?.sourceCanonicalPayload as Entry).photoUris, [
    remotePhoto,
    localPhoto,
  ]);
});

test('sanitizes malicious rich text during sync event replay', async () => {
  const repository = await createRepository();
  await repository.saveLocalSyncAccountState({
    accountId: 'account-1',
    deviceId: 'device-1',
    deviceRole: 'primary_mobile',
    googleUserId: 'google-1',
    googleEmail: 'writer@example.com',
    devicePublicKey: '{}',
    appliedSequence: 2,
    linkedAt: 1,
  });
  const entry = {
    id: 'entry-cloud',
    diaryId: 'diary-default',
    date: '2026-07-08',
    title: 'Cloud entry',
    body: '<p onclick="alert(1)">Entry<script>alert(1)</script></p>',
    moodName: 'Calm',
    moodEmoji: '',
    tags: [],
    photoUris: [],
    photoCount: 0,
    wordCount: 1,
    createdAt: 10,
    updatedAt: 10,
    blocks: [
      {
        id: 'block-1',
        time: '10:00',
        body: '<u style="x:1">under</u><img src=x onerror=alert(1)>',
      },
    ],
  };

  await repository.applySyncEvent(
    createSyncDomainEvent({
      accountId: 'account-1',
      deviceId: 'device-2',
      recordType: 'entry',
      operation: 'upsert',
      recordId: entry.id,
      baseRecordVersion: 0,
      payload: entry,
    }),
    3,
  );

  const stored = await repository.getEntry(entry.id);
  assert.equal(stored?.body, '<p>Entry</p>');
  assert.equal(stored?.blocks?.[0].body, '<u>under</u>');
});

test('applies portable settings and profile events without replacing local reminder or theme settings', async () => {
  const repository = await createRepository();
  await repository.saveSettings({ remindersEnabled: true, reminderTime: '07:30', theme: 'light' });
  await repository.saveLocalSyncAccountState({
    accountId: 'account-1',
    deviceId: 'device-1',
    deviceRole: 'primary_mobile',
    googleUserId: 'google-1',
    googleEmail: 'writer@example.com',
    devicePublicKey: '{}',
    appliedSequence: 2,
    linkedAt: 1,
  });
  const settingsEvent = createSyncDomainEvent({
    accountId: 'account-1',
    deviceId: 'device-2',
    recordType: 'settings',
    operation: 'upsert',
    recordId: 'settings',
    baseRecordVersion: 0,
    payload: {
      remindersEnabled: false,
      reminderTime: '22:00',
      theme: 'dark',
      customTags: ['cloud'],
    },
  });
  await repository.applySyncEvent(settingsEvent, 3);
  const profile = {
    name: 'Cloud Writer',
    email: 'writer@example.com',
    bio: '',
    avatarEmoji: 'W',
    avatarColor: '#000000',
    writingGoal: 500,
    joinedDate: '07/2026',
  };
  await repository.applySyncEvent(
    createSyncDomainEvent({
      accountId: 'account-1',
      deviceId: 'device-2',
      recordType: 'profile',
      operation: 'upsert',
      recordId: 'profile',
      baseRecordVersion: 0,
      payload: profile,
    }),
    4,
  );

  const settings = await repository.getSettings();
  assert.equal(settings.remindersEnabled, true);
  assert.equal(settings.reminderTime, '07:30');
  assert.equal(settings.theme, 'light');
  assert.deepEqual(settings.customTags, ['cloud']);
  assert.deepEqual(await repository.getUserProfile(), profile);
});

test('skips already-covered historical events during partition replay', async () => {
  const repository = await createRepository();
  await repository.saveLocalSyncAccountState({
    accountId: 'account-1',
    deviceId: 'device-1',
    deviceRole: 'primary_mobile',
    googleUserId: 'google-1',
    googleEmail: 'writer@example.com',
    devicePublicKey: '{}',
    appliedSequence: 50,
    linkedAt: 1,
  });
  const note = {
    id: 'note-historical',
    title: 'Already covered',
    body: '',
    isPinned: false,
    tags: [],
    createdAt: 10,
    updatedAt: 10,
  };
  const event = createSyncDomainEvent({
    accountId: 'account-1',
    deviceId: 'device-2',
    recordType: 'note',
    operation: 'upsert',
    recordId: note.id,
    baseRecordVersion: 0,
    payload: note,
  });

  await repository.applySyncEvent(event, 12, { allowHistorical: true });
  await repository.applySyncEvent(event, 12, { allowHistorical: true });

  assert.deepEqual(await repository.getNote(note.id), note);
  assert.equal(await repository.getSyncRecordVersion('note', note.id), 1);
  assert.equal((await repository.getLocalSyncAccountState())?.appliedSequence, 50);
});

test('exports, imports, and tracks monthly partition hydration state', async () => {
  const source = await createRepository();
  const diary = await source.createDiary({
    name: 'Travel',
    emoji: 'T',
    color: '#123456',
    isLocked: false,
  });
  await source.createEntry({
    diaryId: diary.id,
    date: '2026-07-04',
    title: 'July',
    body: 'Recent',
    moodName: 'Calm',
    moodEmoji: '',
    tags: [],
    photoUris: [],
  });
  await source.createEntry({
    diaryId: diary.id,
    date: '2021-03-02',
    title: 'March',
    body: 'Archive',
    moodName: 'Calm',
    moodEmoji: '',
    tags: [],
    photoUris: [],
  });

  const july = await source.exportPartitionSnapshot('month:2026-07');
  assert.deepEqual(
    july.entries.map((entry) => entry.title),
    ['July'],
  );

  const target = await createRepository();
  await target.importPartitionSnapshot('month:2026-07', july);
  assert.deepEqual(
    (await target.listEntries()).map((entry) => entry.title),
    ['July'],
  );

  await target.markPartitionHydrated('month:2026-07', 12);
  assert.equal((await target.getPartitionHydrationState('month:2026-07')).status, 'hydrated');
  assert.deepEqual(
    (await target.listAvailableArchiveMonths()).map((state) => state.partitionKey),
    ['month:2026-07'],
  );

  await target.markPartitionAvailable('month:2021-03', 4);
  await target.markPartitionHydrating('month:2021-03');
  assert.equal((await target.getPartitionHydrationState('month:2021-03')).status, 'hydrating');
  await target.markPartitionHydrationFailed('month:2021-03', 'temporary failure');
  const failedMarch = await target.getPartitionHydrationState('month:2021-03');
  assert.equal(failedMarch.status, 'failed');
  assert.equal(failedMarch.error, 'temporary failure');
  assert.equal(failedMarch.failureCount, 1);
  assert.ok((failedMarch.failedAt || 0) > 0);
  assert.ok((failedMarch.nextRetryAt || 0) > (failedMarch.failedAt || 0));
  assert.deepEqual(
    (await target.listAvailableArchiveMonths()).map((state) => state.partitionKey),
    ['month:2026-07', 'month:2021-03'],
  );
});

test('persists durable sync outbox operations', async () => {
  const repository = await createRepository();
  await repository.saveSyncOutboxOperation({
    operationId: 'operation-1',
    accountId: 'account-1',
    deviceId: 'device-1',
    partitionKey: 'month:2026-07',
    affectedPartitionKeys: ['month:2026-07'],
    recordType: 'ENTRY',
    recordId: 'entry-1',
    operationType: 'UPSERT',
    baseRecordVersion: 0,
    state: 'PENDING',
    retryCount: 0,
    nextAttemptAt: 0,
    createdAt: 1,
    updatedAt: 1,
  });

  assert.equal((await repository.listSyncOutboxOperations(['PENDING'])).length, 1);
  await repository.removeSyncOutboxOperation('operation-1');
  assert.equal((await repository.listSyncOutboxOperations()).length, 0);
});

test('emits sync status changes when durable outbox rows change', async () => {
  const repository = await createRepository();
  const pendingCounts: number[] = [];
  const unsubscribe = repository.subscribeRepositoryChanges((change) => {
    if (change.type === 'sync-status-updated') {
      pendingCounts.push(change.status.pendingOutboxCount);
    }
  });

  await repository.saveSyncOutboxOperation({
    operationId: 'operation-status',
    accountId: 'account-1',
    deviceId: 'device-1',
    partitionKey: 'month:2026-07',
    affectedPartitionKeys: ['month:2026-07'],
    recordType: 'ENTRY',
    recordId: 'entry-1',
    operationType: 'UPSERT',
    baseRecordVersion: 0,
    state: 'PENDING',
    retryCount: 0,
    nextAttemptAt: 0,
    createdAt: 1,
    updatedAt: 1,
  });
  await repository.removeSyncOutboxOperation('operation-status');
  unsubscribe();

  assert.deepEqual(pendingCounts, [1, 0]);
});

test('atomically applies a local note mutation with its durable outbox operation', async () => {
  const store = new MemoryDataStore();
  const repository = await createRepository(store);
  await repository.saveLocalSyncAccountState({
    accountId: 'account-1',
    deviceId: 'device-1',
    deviceRole: 'primary_mobile',
    googleUserId: 'google-1',
    googleEmail: 'writer@example.com',
    devicePublicKey: '{}',
    appliedSequence: 2,
    linkedAt: 1,
  });
  const changes: string[] = [];
  const unsubscribe = repository.subscribeChanges((_revision, change) => {
    if (change) changes.push(change.type);
  });
  const note = {
    id: 'note-local-first',
    title: 'Local first',
    body: '<p>Saved locally.</p>',
    isPinned: false,
    tags: ['offline'],
    createdAt: 10,
    updatedAt: 10,
  };

  await repository.applyLocalMutationWithOutbox({
    operationId: 'operation-local-first',
    recordType: 'note',
    recordId: note.id,
    operation: 'upsert',
    account: (await repository.getLocalSyncAccountState())!,
    localPayload: note,
  });
  unsubscribe();

  assert.deepEqual(await repository.getNote(note.id), note);
  const [operation] = await repository.listSyncOutboxOperations(['PENDING']);
  assert.equal(operation.operationId, 'operation-local-first');
  assert.equal(operation.localApplied, true);
  assert.equal(operation.recordId, note.id);
  assert.deepEqual(operation.sourceCanonicalPayload, note);
  const operations = JSON.parse((await store.getItem('deardiary_sync_operations')) || '{}') as Record<
    string,
    SyncOperation
  >;
  assert.equal(operations['operation-local-first'].recordType, 'NOTE');
  assert.equal(operations['operation-local-first'].state, 'PENDING');
  assert.equal(operations['operation-local-first'].baseRecordVersion, 0);
  assert.equal(JSON.stringify(operations).includes('Saved locally.'), true);
  assert.deepEqual(changes, ['note-created', 'sync-status-updated']);
});

test('coalesces untouched same-record operations and cancels an unpublished create-delete', async () => {
  const store = new MemoryDataStore();
  const repository = await createRepository(store);
  await repository.saveLocalSyncAccountState({
    accountId: 'account-1',
    deviceId: 'device-1',
    deviceRole: 'primary_mobile',
    googleUserId: 'google-1',
    googleEmail: 'writer@example.com',
    devicePublicKey: '{}',
    appliedSequence: 0,
    linkedAt: 1,
  });
  const account = (await repository.getLocalSyncAccountState())!;
  const note: Note = {
    id: 'note-coalesced',
    title: 'First',
    body: '',
    isPinned: false,
    tags: [],
    createdAt: 10,
    updatedAt: 10,
  };
  await repository.applyLocalMutationWithOutbox({
    operationId: 'operation-coalesced-1',
    recordType: 'note',
    recordId: note.id,
    operation: 'upsert',
    account,
    localPayload: note,
  });
  await repository.applyLocalMutationWithOutbox({
    operationId: 'operation-coalesced-2',
    recordType: 'note',
    recordId: note.id,
    operation: 'upsert',
    account,
    localPayload: { ...note, title: 'Latest', updatedAt: 20 },
  });

  const [coalesced] = await repository.listSyncOutboxOperations(['PENDING']);
  assert.equal(coalesced.operationId, 'operation-coalesced-1');
  assert.equal((coalesced.sourceCanonicalPayload as Note).title, 'Latest');
  assert.equal((await repository.getNote(note.id))?.title, 'Latest');
  assert.equal(
    Object.keys(JSON.parse((await store.getItem('deardiary_sync_operations')) || '{}')).length,
    1,
  );

  await repository.applyLocalMutationWithOutbox({
    operationId: 'operation-coalesced-delete',
    recordType: 'note',
    recordId: note.id,
    operation: 'delete',
    account,
    localPayload: null,
  });
  assert.equal(await repository.getNote(note.id), null);
  assert.equal((await repository.listSyncOutboxOperations()).length, 0);
  assert.equal(
    Object.keys(JSON.parse((await store.getItem('deardiary_sync_operations')) || '{}')).length,
    0,
  );
});

test('chains same-record local mutations once an earlier outbox operation is in flight', async () => {
  const store = new MemoryDataStore();
  const repository = await createRepository(store);
  await repository.saveLocalSyncAccountState({
    accountId: 'account-1',
    deviceId: 'device-1',
    deviceRole: 'primary_mobile',
    googleUserId: 'google-1',
    googleEmail: 'writer@example.com',
    devicePublicKey: '{}',
    appliedSequence: 2,
    linkedAt: 1,
  });
  const account = (await repository.getLocalSyncAccountState())!;
  const note: Note = {
    id: 'note-chain',
    title: 'First edit',
    body: '<p>First.</p>',
    isPinned: false,
    tags: [],
    createdAt: 10,
    updatedAt: 10,
  };

  await repository.applyLocalMutationWithOutbox({
    operationId: 'operation-chain-1',
    recordType: 'note',
    recordId: note.id,
    operation: 'upsert',
    account,
    localPayload: note,
  });
  const [firstOperation] = await repository.listSyncOutboxOperations(['PENDING']);
  await repository.saveSyncOutboxOperation({
    ...firstOperation,
    state: 'UPLOADING',
    encryptedEventObjectKey: 'drive-event-1',
    encryptedEventSha256: 'sha',
    encryptedEventSizeBytes: 10,
  });

  await repository.applyLocalMutationWithOutbox({
    operationId: 'operation-chain-2',
    recordType: 'note',
    recordId: note.id,
    operation: 'upsert',
    account,
    localPayload: { ...note, title: 'Second edit', updatedAt: 20 },
  });

  const listedOperations = await repository.listSyncOutboxOperations();
  const secondOperation = listedOperations.find(
    (operation) => operation.operationId === 'operation-chain-2',
  );
  assert.equal(listedOperations.length, 2);
  assert.equal(secondOperation?.dependencyOperationId, 'operation-chain-1');
  assert.equal(secondOperation?.baseRecordVersion, 1);
  assert.equal((secondOperation?.sourceCanonicalPayload as Note | undefined)?.title, 'Second edit');
  assert.equal((await repository.getNote(note.id))?.title, 'Second edit');
  const operations = JSON.parse((await store.getItem('deardiary_sync_operations')) || '{}') as Record<
    string,
    SyncOperation
  >;
  assert.equal(operations['operation-chain-2'].dependencyOperationId, 'operation-chain-1');
  assert.equal(operations['operation-chain-2'].baseRecordVersion, 1);
});

test('rapid same-record saves never reset an in-flight operation', async () => {
  const store = new MemoryDataStore();
  const repository = await createRepository(store);
  await repository.saveLocalSyncAccountState({
    accountId: 'account-1',
    deviceId: 'device-1',
    deviceRole: 'primary_mobile',
    googleUserId: 'google-1',
    googleEmail: 'writer@example.com',
    devicePublicKey: '{}',
    appliedSequence: 0,
    linkedAt: 1,
  });
  const account = (await repository.getLocalSyncAccountState())!;
  const note: Note = {
    id: 'note-rapid',
    title: 'First',
    body: '<p>First.</p>',
    isPinned: false,
    tags: [],
    createdAt: 10,
    updatedAt: 10,
  };
  await repository.applyLocalMutationWithOutbox({
    operationId: 'operation-rapid-1',
    recordType: 'note',
    recordId: note.id,
    operation: 'upsert',
    account,
    localPayload: note,
  });
  const firstOperations = JSON.parse((await store.getItem('deardiary_sync_operations')) || '{}') as Record<
    string,
    SyncOperation
  >;
  await store.setItem(
    'deardiary_sync_operations',
    JSON.stringify({
      ...firstOperations,
      'operation-rapid-1': {
        ...firstOperations['operation-rapid-1'],
        state: 'UPLOADING',
        leaseOwner: 'worker-1',
        leaseExpiresAt: 100,
      },
    }),
  );

  await repository.applyLocalMutationWithOutbox({
    operationId: 'operation-rapid-2',
    recordType: 'note',
    recordId: note.id,
    operation: 'upsert',
    account,
    localPayload: { ...note, title: 'Second', updatedAt: 20 },
  });

  const operations = JSON.parse((await store.getItem('deardiary_sync_operations')) || '{}') as Record<
    string,
    SyncOperation
  >;
  assert.equal(operations['operation-rapid-1'].state, 'UPLOADING');
  assert.equal(operations['operation-rapid-1'].leaseOwner, 'worker-1');
  assert.equal(operations['operation-rapid-2'].state, 'PENDING');
  assert.equal(operations['operation-rapid-2'].dependencyOperationId, 'operation-rapid-1');
  assert.equal(operations['operation-rapid-2'].baseRecordVersion, 1);
});

test('local autosaves and worker transitions cannot overwrite each other', async () => {
  const store = new PausingMemoryDataStore();
  const repository = await createRepository(store);
  await repository.saveLocalSyncAccountState({
    accountId: 'account-1',
    deviceId: 'device-1',
    deviceRole: 'primary_mobile',
    googleUserId: 'google-1',
    googleEmail: 'writer@example.com',
    devicePublicKey: '{}',
    appliedSequence: 0,
    linkedAt: 1,
  });
  const account = (await repository.getLocalSyncAccountState())!;
  const note: Note = {
    id: 'note-concurrent',
    title: 'First',
    body: '<p>First.</p>',
    isPinned: false,
    tags: [],
    createdAt: 10,
    updatedAt: 10,
  };
  await repository.applyLocalMutationWithOutbox({
    operationId: 'operation-concurrent-1',
    recordType: 'note',
    recordId: note.id,
    operation: 'upsert',
    account,
    localPayload: note,
  });

  const worker = new PersistentOutboxRepository(store);
  await worker.transition('operation-concurrent-1', 'PENDING', 'PREPARING');
  const gate = store.pauseNextWriteContaining('deardiary_sync_operations');
  const autosave = repository.applyLocalMutationWithOutbox({
    operationId: 'operation-concurrent-2',
    recordType: 'note',
    recordId: note.id,
    operation: 'upsert',
    account,
    localPayload: { ...note, title: 'Second', updatedAt: 20 },
  });
  await gate.entered;

  let workerFinished = false;
  const transition = worker
    .transition('operation-concurrent-1', 'PREPARING', 'UPLOADING')
    .then(() => {
      workerFinished = true;
    });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(workerFinished, false);

  gate.release();
  await Promise.all([autosave, transition]);
  const outbox = JSON.parse((await store.getItem('deardiary_sync_operations')) || '{}') as Record<
    string,
    SyncOperation
  >;
  assert.equal(outbox['operation-concurrent-1'].state, 'UPLOADING');
  assert.equal(outbox['operation-concurrent-2'].state, 'PENDING');
  assert.equal(outbox['operation-concurrent-2'].dependencyOperationId, 'operation-concurrent-1');
});

test('manages preserved conflicts separately from retryable outbox failures', async () => {
  const repository = await createRepository();
  const original: Note = {
    id: 'note-conflict-original',
    title: 'Original conflict',
    body: '<p>Original.</p>',
    isPinned: false,
    tags: [],
    createdAt: 1,
    updatedAt: 2,
  };
  const recovered = await repository.createNote({
    title: 'Original conflict (Recovered copy)',
    body: '<p>Recovered.</p>',
    isPinned: false,
    tags: [],
  });
  const operation: SyncOperation = {
    operationId: 'operation-conflict-preserved',
    accountId: 'account-1',
    deviceId: 'device-1',
    partitionKey: 'core',
    affectedPartitionKeys: ['core'],
    recordType: 'NOTE',
    recordId: original.id,
    operationType: 'UPSERT',
    baseRecordVersion: 0,
    sourceCanonicalPayload: original,
    recoveredRecordId: recovered.id,
    localApplied: true,
    state: 'CONFLICT',
    retryCount: 1,
    nextAttemptAt: 0,
    createdAt: 1,
    updatedAt: 2,
    lastErrorCode: 'RECORD_VERSION_CONFLICT',
  };
  await repository.saveSyncOutboxOperation(operation);

  const status = await repository.getSyncStatusSummary();
  assert.equal(status.pendingOutboxCount, 1);
  assert.equal(status.failedOperationCount, 0);
  assert.equal(status.conflictCount, 1);
  const [conflict] = await repository.listPreservedSyncConflicts();
  assert.equal(conflict.operation.operationId, operation.operationId);
  assert.equal(conflict.currentRecord, null);
  assert.equal(conflict.recoveredRecord?.id, recovered.id);

  assert.equal(await repository.deleteSyncConflictRecoveredCopy(operation.operationId), true);
  assert.equal(await repository.getNote(recovered.id), null);
  await repository.retryPreservedSyncConflict(operation.operationId);
  const [retryable] = await repository.listSyncOutboxOperations(['PENDING']);
  assert.equal(retryable.operationId, operation.operationId);
  assert.equal(retryable.baseRecordVersion, 0);
  assert.equal(retryable.lastErrorCode, undefined);
  await repository.markSyncConflictResolved(operation.operationId);
  assert.equal((await repository.listSyncOutboxOperations()).length, 0);
});

test('keeps local-first mutations and pending outbox rows after repository restart', async () => {
  const store = new MemoryDataStore();
  const repository = await createRepository(store);
  await repository.saveLocalSyncAccountState({
    accountId: 'account-1',
    deviceId: 'device-1',
    deviceRole: 'primary_mobile',
    googleUserId: 'google-1',
    googleEmail: 'writer@example.com',
    devicePublicKey: '{}',
    appliedSequence: 2,
    linkedAt: 1,
  });
  const note = {
    id: 'note-restart',
    title: 'Still here',
    body: '<p>Saved before restart.</p>',
    isPinned: false,
    tags: [],
    createdAt: 10,
    updatedAt: 10,
  };

  await repository.applyLocalMutationWithOutbox({
    operationId: 'operation-restart',
    recordType: 'note',
    recordId: note.id,
    operation: 'upsert',
    account: (await repository.getLocalSyncAccountState())!,
    localPayload: note,
  });

  const restarted = await createRepository(store);

  assert.deepEqual(await restarted.getNote(note.id), note);
  const [operation] = await restarted.listSyncOutboxOperations(['PENDING']);
  assert.equal(operation.operationId, 'operation-restart');
  assert.equal(operation.localApplied, true);
  assert.deepEqual(operation.sourceCanonicalPayload, note);
  const operations = JSON.parse((await store.getItem('deardiary_sync_operations')) || '{}') as Record<
    string,
    SyncOperation
  >;
  assert.equal(operations['operation-restart'].state, 'PENDING');
});

test('replays an acknowledged mutation without overwriting a newer pending edit', async () => {
  const repository = await createRepository();
  await repository.saveLocalSyncAccountState({
    accountId: 'account-1',
    deviceId: 'device-1',
    deviceRole: 'primary_mobile',
    googleUserId: 'google-1',
    googleEmail: 'writer@example.com',
    devicePublicKey: '{}',
    appliedSequence: 2,
    linkedAt: 1,
  });
  const note = {
    id: 'note-ack',
    title: 'Local title',
    body: '<p>Keep the local body.</p>',
    isPinned: false,
    tags: [],
    createdAt: 10,
    updatedAt: 10,
  };
  await repository.applyLocalMutationWithOutbox({
    operationId: 'operation-ack',
    recordType: 'note',
    recordId: note.id,
    operation: 'upsert',
    account: (await repository.getLocalSyncAccountState())!,
    localPayload: note,
  });
  const [firstOperation] = await repository.listSyncOutboxOperations(['PENDING']);
  await repository.saveSyncOutboxOperation({
    ...firstOperation,
    state: 'ACKNOWLEDGED',
    remoteSequence: 3,
    remoteRecordVersion: 1,
  });
  await repository.applyLocalMutationWithOutbox({
    operationId: 'operation-after-ack',
    recordType: 'note',
    recordId: note.id,
    operation: 'upsert',
    account: (await repository.getLocalSyncAccountState())!,
    localPayload: { ...note, title: 'Newer local title', updatedAt: 20 },
  });
  const event = createSyncDomainEvent({
    accountId: 'account-1',
    deviceId: 'device-1',
    recordType: 'note',
    operation: 'upsert',
    recordId: note.id,
    baseRecordVersion: 0,
    payload: note,
    eventId: 'operation-ack',
  });

  await repository.applyRemoteEventBatch(
    [{ event, sequence: 3, operationId: 'operation-ack' }],
    2,
  );

  assert.equal((await repository.getNote(note.id))?.title, 'Newer local title');
  assert.equal(await repository.getSyncRecordVersion('note', note.id), 1);
  assert.equal((await repository.getLocalSyncAccountState())?.appliedSequence, 3);
  const remaining = await repository.listSyncOutboxOperations();
  assert.equal(remaining.some((operation) => operation.operationId === 'operation-ack'), false);
  assert.equal(
    remaining.find((operation) => operation.operationId === 'operation-after-ack')
      ?.baseRecordVersion,
    1,
  );
});
