import type {
  AppSettings,
  BackupMergePreview,
  BackupMergeResult,
  Diary,
  DriveBackupSettings,
  Entry,
  LocalSyncAccountState,
  Note,
  PartitionHydrationState,
  SecurityConfig,
  SyncDomainEvent,
  SyncMediaPointer,
  SyncOutboxOperation,
  SyncPartitionKey,
  SyncRecordType,
  UserProfile,
} from '../types';
import type {
  LocalDataStore,
  LocalEntryProjection,
  LocalNoteProjection,
  LocalStructuredRecordMutation,
} from '../platform/storage';
import type {
  AcknowledgeLocalMutationInput,
  ApplyLocalMutationWithOutboxInput,
  DiaryStatistics,
  DiaryRepository,
  DistributionRow,
  EntryListOptions,
  EntrySummary,
  GlobalStatistics,
  HomeSummary,
  NewDiary,
  NewEntry,
  NewNote,
  NoteListOptions,
  NoteSummary,
  PageResult,
  PreservedSyncConflict,
  RepositoryChange,
  RepositoryChangeListener,
  RepositoryImportMode,
  RepositorySnapshot,
  SearchFilters,
  StatisticsFilters,
  SyncStatusSummary,
  TypedRepositoryChangeListener,
  WritingHeatmapRow,
} from './DiaryRepository';
import { syncReminderNotification } from '../mobile/reminders';
import {
  createDefaultDriveBackupSettings,
  createDefaultUserProfile,
  DEFAULT_APP_SETTINGS,
  DEFAULT_SECURITY_CONFIG,
} from './defaults';
import { normalizeSecurityConfig } from '../domain/security';
import { buildPortableMergePlan } from '../domain/backupMerge';
import { richTextHtmlToPlainText, sanitizeEntry, sanitizeNote, sanitizeRepositorySnapshot } from '../domain/richTextSanitizer';
import { calculateStreak, getTodayWordCount } from '../domain/journalCatalog';
import { CORE_PARTITION_KEY, filterSnapshotForPartition, isMonthPartitionKey, monthFromTimestamp, partitionKeyForRecordPayload } from '../sync/syncPartitioning';
import { measureAsync } from '../utils/performance';
import { pageEntries, pageNotes } from '../platform/storage/queryPagination';
import { createDefaultSyncHealth, type SyncHealth, type SyncHealthPatch } from '../sync/health/SyncHealth';
import { pendingOutboxV2FromLegacy, type SyncOutboxOperationV2 } from '../sync/outbox';

const STORAGE_KEYS = {
  diaries: 'deardiary_diaries',
  entries: 'deardiary_entries',
  notes: 'deardiary_notes',
  settings: 'deardiary_settings',
  userProfile: 'deardiary_userprofile',
  security: 'deardiary_security',
  driveBackup: 'deardiary_drive_backup',
  syncAccount: 'deardiary_sync_account',
  syncRecordVersions: 'deardiary_sync_record_versions',
  syncMediaPointers: 'deardiary_sync_media_pointers',
  syncPartitionHydration: 'deardiary_sync_partition_hydration',
  syncOutbox: 'deardiary_sync_outbox',
  syncOutboxV2: 'deardiary_sync_outbox_v2',
  syncHealth: 'deardiary_sync_health_v1',
} as const;

const ARCHIVE_HYDRATION_RETRY_BASE_MS = 5 * 60 * 1000;
const ARCHIVE_HYDRATION_RETRY_MAX_MS = 24 * 60 * 60 * 1000;

const INITIAL_DIARIES: Diary[] = [{
  id: 'diary-default',
  name: 'My Diary',
  emoji: '\uD83D\uDCD4',
  color: '#8A3D55',
  isLocked: false,
  entryCount: 0,
  lastUpdated: 'No entries yet',
  lastEntryUpdatedAt: undefined,
}];

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const parseJson = <T>(value: string | null, fallback: T): T => {
  if (value === null) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    console.warn('Ignoring invalid local repository data:', error);
    return fallback;
  }
};

const createId = (prefix: string): string => {
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${id}`;
};

const countWords = (body: string): number => {
  const plainText = richTextHtmlToPlainText(body);
  return plainText ? plainText.split(/\s+/).filter(Boolean).length : 0;
};

const getLastUpdatedLabel = (entries: Entry[]): string => {
  if (entries.length === 0) return 'No entries yet';
  const latest = entries.reduce((current, entry) => entry.updatedAt > current.updatedAt ? entry : current);
  const diffDays = Math.max(0, Math.floor((Date.now() - latest.updatedAt) / 86_400_000));
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return `${diffDays} days ago`;
};

const getLastEntryUpdatedAt = (entries: Entry[]): number | undefined => {
  const latest = entries.reduce((current, entry) => Math.max(current, entry.updatedAt || 0), 0);
  return latest || undefined;
};

const isRetryableFailedOutboxOperation = (operation: SyncOutboxOperation): boolean => (
  operation.state === 'failed' && operation.nextRetryAt !== Number.MAX_SAFE_INTEGER
);

const entrySummary = (entry: LocalEntryProjection): EntrySummary => ({
  id: entry.id,
  diaryId: entry.diaryId,
  date: entry.date,
  time: entry.time,
  title: entry.title,
  moodName: entry.moodName,
  moodEmoji: entry.moodEmoji,
  tags: [...entry.tags],
  photoCount: entry.photoCount,
  wordCount: entry.wordCount,
  createdAt: entry.createdAt,
  updatedAt: entry.updatedAt,
});

const noteSummary = (note: LocalNoteProjection): NoteSummary => ({
  id: note.id,
  title: note.title,
  isPinned: note.isPinned,
  tags: [...note.tags],
  createdAt: note.createdAt,
  updatedAt: note.updatedAt,
});

const filterEntriesByDiaryAccess = <T extends Pick<Entry, 'diaryId'>>(
  entries: T[],
  options: Pick<EntryListOptions | SearchFilters | StatisticsFilters, 'allowedDiaryIds' | 'excludeDiaryIds'> = {},
): T[] => {
  const allowed = options.allowedDiaryIds ? new Set(options.allowedDiaryIds) : null;
  const excluded = options.excludeDiaryIds ? new Set(options.excludeDiaryIds) : null;
  return entries.filter(entry => (
    (!allowed || allowed.has(entry.diaryId)) &&
    (!excluded || !excluded.has(entry.diaryId))
  ));
};

const sortEntries = <T extends Pick<Entry, 'id' | 'date' | 'createdAt' | 'updatedAt'>>(
  entries: T[],
  sort: EntryListOptions['sort'] = 'date-desc',
): T[] => {
  const sorted = [...entries];
  if (sort === 'date-asc') return sorted.sort((left, right) => left.date.localeCompare(right.date) || left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  if (sort === 'updated-desc') return sorted.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
  if (sort === 'created-desc') return sorted.sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
  return sorted.sort((left, right) => right.date.localeCompare(left.date) || right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
};

const matchesDateRange = (entry: Pick<Entry, 'date'>, filters: Pick<SearchFilters | StatisticsFilters, 'fromDate' | 'toDate'>): boolean => (
  (!filters.fromDate || entry.date >= filters.fromDate) &&
  (!filters.toDate || entry.date <= filters.toDate)
);

const tagDistributionFromEntries = (entries: Array<Pick<Entry, 'tags'>>): DistributionRow[] => {
  const counts = new Map<string, DistributionRow>();
  entries.forEach(entry => {
    entry.tags.forEach(tag => {
      const key = tag.toLowerCase();
      const row = counts.get(key) || { key, label: tag, count: 0 };
      row.count += 1;
      counts.set(key, row);
    });
  });
  return [...counts.values()].sort((left, right) => right.count - left.count);
};

export class LocalDiaryRepository implements DiaryRepository {
  private writeTail: Promise<void> = Promise.resolve();
  private changeListeners = new Set<RepositoryChangeListener>();
  private typedChangeListeners = new Set<TypedRepositoryChangeListener>();

  constructor(private readonly store: LocalDataStore) {}

  subscribeChanges(listener: RepositoryChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  subscribeRepositoryChanges(listener: TypedRepositoryChangeListener): () => void {
    this.typedChangeListeners.add(listener);
    return () => this.typedChangeListeners.delete(listener);
  }

  async initialize(): Promise<void> {
    await measureAsync('repository.initialize', () => this.enqueueWrite(async () => {
      const [diaries, entries, notes, settings, profile, security, driveBackup] = await Promise.all([
        this.store.getItem(STORAGE_KEYS.diaries),
        this.store.getItem(STORAGE_KEYS.entries),
        this.store.getItem(STORAGE_KEYS.notes),
        this.store.getItem(STORAGE_KEYS.settings),
        this.store.getItem(STORAGE_KEYS.userProfile),
        this.store.getItem(STORAGE_KEYS.security),
        this.store.getItem(STORAGE_KEYS.driveBackup),
      ]);

      const missingItems: Record<string, unknown> = {};
      if (diaries === null) missingItems[STORAGE_KEYS.diaries] = clone(INITIAL_DIARIES);
      if (entries === null) missingItems[STORAGE_KEYS.entries] = [];
      if (notes === null) missingItems[STORAGE_KEYS.notes] = [];
      if (settings === null) missingItems[STORAGE_KEYS.settings] = DEFAULT_APP_SETTINGS;
      if (security === null) missingItems[STORAGE_KEYS.security] = DEFAULT_SECURITY_CONFIG;
      const backupDefaults = createDefaultDriveBackupSettings();
      const storedBackup = parseJson<DriveBackupSettings>(driveBackup, {});
      const normalizedBackup: DriveBackupSettings = {
        ...backupDefaults,
        ...storedBackup,
        schedule: { ...backupDefaults.schedule!, ...storedBackup.schedule },
        deviceId: storedBackup.deviceId || backupDefaults.deviceId,
      };
      if (driveBackup === null || JSON.stringify(storedBackup) !== JSON.stringify(normalizedBackup)) {
        missingItems[STORAGE_KEYS.driveBackup] = normalizedBackup;
      }
      if (profile === null) {
        const backupSettings = parseJson<DriveBackupSettings>(driveBackup, {});
        missingItems[STORAGE_KEYS.userProfile] = createDefaultUserProfile(backupSettings.linkedGoogleEmail);
      }
      if (Object.keys(missingItems).length > 0) await this.writeManyJson(missingItems);
    }));
  }

  async listDiaries(): Promise<Diary[]> {
    await this.waitForWrites();
    return measureAsync('repository.query.diaries.list', () => this.readCollection(STORAGE_KEYS.diaries, clone(INITIAL_DIARIES)));
  }

  async listDiarySummaries(): Promise<Diary[]> {
    return this.listDiaries();
  }

  async getDiary(id: string): Promise<Diary | null> {
    await this.waitForWrites();
    return measureAsync('repository.query.diaries.get', () => this.readRecord(STORAGE_KEYS.diaries, id, clone(INITIAL_DIARIES)));
  }

  createDiary(input: NewDiary): Promise<Diary> {
    return measureAsync('repository.local.diary.create', () => this.enqueueWrite(async () => {
      const diary: Diary = {
        ...clone(input),
        id: createId('diary'),
        entryCount: 0,
        lastUpdated: 'No entries yet',
        lastEntryUpdatedAt: undefined,
      };
      if (this.store.commitStructuredRecords) {
        await this.writeStructuredRecordsWithRevision(
          [{ key: STORAGE_KEYS.diaries, id: diary.id, value: diary }],
          {},
          contentRevision => ({ type: 'diary-created', diary: clone(diary), contentRevision }),
        );
        return clone(diary);
      }
      const diaries = await this.readCollection(STORAGE_KEYS.diaries, clone(INITIAL_DIARIES));
      diaries.push(diary);
      await this.writePortableItems(
        { [STORAGE_KEYS.diaries]: diaries },
        contentRevision => ({ type: 'diary-created', diary: clone(diary), contentRevision }),
      );
      return clone(diary);
    }));
  }

  updateDiary(updatedDiary: Diary): Promise<Diary | null> {
    return measureAsync('repository.local.diary.update', () => this.enqueueWrite(async () => {
      const diaries = await this.readCollection(STORAGE_KEYS.diaries, clone(INITIAL_DIARIES));
      const index = diaries.findIndex(diary => diary.id === updatedDiary.id);
      if (index < 0) return null;
      diaries[index] = clone(updatedDiary);
      if (this.store.commitStructuredRecords) {
        await this.writeStructuredRecordsWithRevision(
          [{ key: STORAGE_KEYS.diaries, id: diaries[index].id, value: diaries[index] }],
          {},
          contentRevision => ({ type: 'diary-updated', diary: clone(diaries[index]), contentRevision }),
        );
        return clone(diaries[index]);
      }
      await this.writePortableItems(
        { [STORAGE_KEYS.diaries]: diaries },
        contentRevision => ({ type: 'diary-updated', diary: clone(diaries[index]), contentRevision }),
      );
      return clone(diaries[index]);
    }));
  }

  deleteDiary(id: string): Promise<boolean> {
    return measureAsync('repository.local.diary.delete', () => this.enqueueWrite(async () => {
      const diaries = await this.readCollection(STORAGE_KEYS.diaries, clone(INITIAL_DIARIES));
      const entries = await this.readCollection<Entry>(STORAGE_KEYS.entries, []);
      const nextDiaries = diaries.filter(diary => diary.id !== id);
      if (nextDiaries.length === diaries.length) return false;

      if (this.store.commitStructuredRecords) {
        await this.writeStructuredRecordsWithRevision(
          [
            { key: STORAGE_KEYS.diaries, id, value: null },
            ...entries
              .filter(entry => entry.diaryId === id)
              .map(entry => ({ key: STORAGE_KEYS.entries, id: entry.id, value: null })),
          ],
          {},
          contentRevision => ({ type: 'diary-deleted', diaryId: id, contentRevision }),
        );
        return true;
      }
      await this.writePortableItems({
        [STORAGE_KEYS.entries]: entries.filter(entry => entry.diaryId !== id),
        [STORAGE_KEYS.diaries]: nextDiaries,
      }, contentRevision => ({ type: 'diary-deleted', diaryId: id, contentRevision }));
      return true;
    }));
  }

  async listEntries(): Promise<Entry[]> {
    await this.waitForWrites();
    return measureAsync('repository.query.entries.list', () => this.readCollection<Entry>(STORAGE_KEYS.entries, []));
  }

  async listRecentEntries(
    limit = 10,
    options: Pick<EntryListOptions, 'allowedDiaryIds' | 'excludeDiaryIds'> = {},
  ): Promise<EntrySummary[]> {
    await this.waitForWrites();
    const projectedPage = await this.store.queryEntryProjections?.({
      ...options,
      sort: 'updated-desc',
      limit,
    });
    if (projectedPage) return projectedPage.items.map(entrySummary);
    const storedPage = await this.store.queryEntries?.({
      ...options,
      sort: 'updated-desc',
      limit,
    });
    if (storedPage) return storedPage.items.map(entrySummary);

    const entries = filterEntriesByDiaryAccess(await this.listEntries(), options);
    return sortEntries(entries, 'updated-desc').slice(0, limit).map(entrySummary);
  }

  async listEntriesByDiary(diaryId: string, options: EntryListOptions = {}): Promise<PageResult<Entry | EntrySummary>> {
    await this.waitForWrites();
    if (!options.includeBody) {
      const projectedPage = await this.store.queryEntryProjections?.({ ...options, diaryId });
      if (projectedPage) return { ...projectedPage, items: projectedPage.items.map(entrySummary) };
    }
    const storedPage = await this.store.queryEntries?.({
      ...options,
      diaryId,
    });
    if (storedPage) return this.entryPageForOptions(storedPage, options);

    const entries = sortEntries(
      filterEntriesByDiaryAccess(await this.listEntries(), options)
        .filter(entry => entry.diaryId === diaryId),
      options.sort,
    );
    const page = pageEntries(entries, options, options.sort || 'date-desc');
    return {
      items: options.includeBody ? clone(page.items) : page.items.map(entrySummary),
      nextCursor: page.nextCursor,
      total: page.total,
    };
  }

  async listEntriesByMonth(diaryId: string, yearMonth: string, options: EntryListOptions = {}): Promise<PageResult<Entry | EntrySummary>> {
    await this.waitForWrites();
    if (!options.includeBody) {
      const projectedPage = await this.store.queryEntryProjections?.({ ...options, diaryId, yearMonth });
      if (projectedPage) return { ...projectedPage, items: projectedPage.items.map(entrySummary) };
    }
    const storedPage = await this.store.queryEntries?.({
      ...options,
      diaryId,
      yearMonth,
    });
    if (storedPage) return this.entryPageForOptions(storedPage, options);

    const entries = sortEntries(
      filterEntriesByDiaryAccess(await this.listEntries(), options)
        .filter(entry => entry.diaryId === diaryId && entry.date.startsWith(yearMonth)),
      options.sort,
    );
    const page = pageEntries(entries, options, options.sort || 'date-desc');
    return {
      items: options.includeBody ? clone(page.items) : page.items.map(entrySummary),
      nextCursor: page.nextCursor,
      total: page.total,
    };
  }

  async getEntry(id: string): Promise<Entry | null> {
    await this.waitForWrites();
    return measureAsync('repository.query.entries.get', () => this.readRecord<Entry>(STORAGE_KEYS.entries, id, []));
  }

  createEntry(input: NewEntry): Promise<Entry> {
    return measureAsync('repository.local.entry.create', () => this.enqueueWrite(async () => {
      const entries = await this.readCollection<Entry>(STORAGE_KEYS.entries, []);
      const timestamp = Date.now();
      const entry: Entry = sanitizeEntry({
        ...clone(input),
        id: createId('entry'),
        wordCount: countWords(input.body || ''),
        photoCount: input.photoUris?.length || 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      entry.wordCount = countWords(entry.body || '');
      entries.push(entry);
      await this.writeEntriesAndDiaryStats(
        entries,
        contentRevision => ({ type: 'entry-created', entry: clone(entry), contentRevision }),
        [{ key: STORAGE_KEYS.entries, id: entry.id, value: entry }],
      );
      return clone(entry);
    }));
  }

  updateEntry(updatedEntry: Entry): Promise<Entry | null> {
    return measureAsync('repository.local.entry.update', () => this.enqueueWrite(async () => {
      const entries = await this.readCollection<Entry>(STORAGE_KEYS.entries, []);
      const index = entries.findIndex(entry => entry.id === updatedEntry.id);
      if (index < 0) return null;

      const entry: Entry = sanitizeEntry({
        ...clone(updatedEntry),
        wordCount: countWords(updatedEntry.body || ''),
        photoCount: updatedEntry.photoUris?.length || 0,
        updatedAt: Date.now(),
      });
      entry.wordCount = countWords(entry.body || '');
      entries[index] = entry;
      await this.writeEntriesAndDiaryStats(
        entries,
        contentRevision => ({ type: 'entry-updated', entry: clone(entry), contentRevision }),
        [{ key: STORAGE_KEYS.entries, id: entry.id, value: entry }],
      );
      return clone(entry);
    }));
  }

  deleteEntry(id: string): Promise<boolean> {
    return measureAsync('repository.local.entry.delete', () => this.enqueueWrite(async () => {
      const entries = await this.readCollection<Entry>(STORAGE_KEYS.entries, []);
      const deleted = entries.find(entry => entry.id === id);
      const nextEntries = entries.filter(entry => entry.id !== id);
      if (nextEntries.length === entries.length) return false;
      await this.writeEntriesAndDiaryStats(
        nextEntries,
        contentRevision => ({ type: 'entry-deleted', entryId: id, diaryId: deleted?.diaryId || '', contentRevision }),
        [{ key: STORAGE_KEYS.entries, id, value: null }],
      );
      return true;
    }));
  }

  async listNotes(): Promise<Note[]>;
  async listNotes(options: NoteListOptions): Promise<PageResult<Note | NoteSummary>>;
  async listNotes(options?: NoteListOptions): Promise<Note[] | PageResult<Note | NoteSummary>> {
    await this.waitForWrites();
    if (options && !options.includeBody) {
      const projectedPage = await this.store.queryNoteProjections?.({ ...options, sort: 'pinned-updated-desc' });
      if (projectedPage) return { ...projectedPage, items: projectedPage.items.map(noteSummary) };
    }
    if (options && !options.query) {
      const storedPage = await this.store.queryNotes?.({
        ...options,
        sort: 'pinned-updated-desc',
      });
      if (storedPage) return this.notePageForOptions(storedPage, options);
    }

    const notes = await measureAsync('repository.query.notes.list', () => this.readCollection<Note>(STORAGE_KEYS.notes, []));
    if (!options) return notes;
    const query = options.query?.trim().toLowerCase();
    const filtered = notes
      .filter(note => {
        if (options.filter === 'pinned') return note.isPinned;
        if (options.filter === 'tagged') return note.tags.length > 0;
        if (options.filter === 'untagged') return note.tags.length === 0;
        return true;
      })
      .filter(note => !query || (
        note.title.toLowerCase().includes(query) ||
        richTextHtmlToPlainText(note.body).toLowerCase().includes(query) ||
        note.tags.some(tag => tag.toLowerCase().includes(query))
      ))
      .sort((left, right) => {
        if (left.isPinned && !right.isPinned) return -1;
        if (!left.isPinned && right.isPinned) return 1;
        return right.updatedAt - left.updatedAt;
      });
    const page = pageNotes(filtered, options, 'pinned-updated-desc');
    return {
      items: options.includeBody ? clone(page.items) : page.items.map(noteSummary),
      nextCursor: page.nextCursor,
      total: page.total,
    };
  }

  async getNote(id: string): Promise<Note | null> {
    await this.waitForWrites();
    return measureAsync('repository.query.notes.get', () => this.readRecord<Note>(STORAGE_KEYS.notes, id, []));
  }

  createNote(input: NewNote): Promise<Note> {
    return measureAsync('repository.local.note.create', () => this.enqueueWrite(async () => {
      const timestamp = Date.now();
      const note: Note = sanitizeNote({ ...clone(input), id: createId('note'), createdAt: timestamp, updatedAt: timestamp });
      if (this.store.commitStructuredRecords) {
        await this.writeStructuredRecordsWithRevision(
          [{ key: STORAGE_KEYS.notes, id: note.id, value: note }],
          {},
          contentRevision => ({ type: 'note-created', note: clone(note), contentRevision }),
        );
        return clone(note);
      }
      const notes = await this.readCollection<Note>(STORAGE_KEYS.notes, []);
      notes.push(note);
      await this.writePortableItems(
        { [STORAGE_KEYS.notes]: notes },
        contentRevision => ({ type: 'note-created', note: clone(note), contentRevision }),
      );
      return clone(note);
    }));
  }

  updateNote(updatedNote: Note): Promise<Note | null> {
    return measureAsync('repository.local.note.update', () => this.enqueueWrite(async () => {
      const existing = await this.readRecord<Note>(STORAGE_KEYS.notes, updatedNote.id, []);
      if (!existing) return null;
      const note = sanitizeNote({ ...clone(updatedNote), updatedAt: Date.now() });
      if (this.store.commitStructuredRecords) {
        await this.writeStructuredRecordsWithRevision(
          [{ key: STORAGE_KEYS.notes, id: note.id, value: note }],
          {},
          contentRevision => ({ type: 'note-updated', note: clone(note), contentRevision }),
        );
        return clone(note);
      }
      const notes = await this.readCollection<Note>(STORAGE_KEYS.notes, []);
      const index = notes.findIndex(candidate => candidate.id === updatedNote.id);
      if (index < 0) return null;
      notes[index] = note;
      await this.writePortableItems(
        { [STORAGE_KEYS.notes]: notes },
        contentRevision => ({ type: 'note-updated', note: clone(notes[index]), contentRevision }),
      );
      return clone(notes[index]);
    }));
  }

  deleteNote(id: string): Promise<boolean> {
    return measureAsync('repository.local.note.delete', () => this.enqueueWrite(async () => {
      if (this.store.commitStructuredRecords) {
        const existing = await this.readRecord<Note>(STORAGE_KEYS.notes, id, []);
        if (!existing) return false;
        await this.writeStructuredRecordsWithRevision(
          [{ key: STORAGE_KEYS.notes, id, value: null }],
          {},
          contentRevision => ({ type: 'note-deleted', noteId: id, contentRevision }),
        );
        return true;
      }
      const notes = await this.readCollection<Note>(STORAGE_KEYS.notes, []);
      const nextNotes = notes.filter(note => note.id !== id);
      if (nextNotes.length === notes.length) return false;
      await this.writePortableItems(
        { [STORAGE_KEYS.notes]: nextNotes },
        contentRevision => ({ type: 'note-deleted', noteId: id, contentRevision }),
      );
      return true;
    }));
  }

  async searchEntries(filters: SearchFilters & { includeBody: false }): Promise<PageResult<EntrySummary>>;
  async searchEntries(filters: SearchFilters): Promise<PageResult<Entry>>;
  async searchEntries(filters: SearchFilters): Promise<PageResult<Entry | EntrySummary>> {
    await this.waitForWrites();
    return measureAsync('repository.query.entries.search', async () => {
      if (filters.includeBody === false) {
        const projectedPage = await this.store.queryEntryProjections?.({
          ...filters,
          sort: 'updated-desc',
        });
        if (projectedPage) return { ...projectedPage, items: projectedPage.items.map(entrySummary) };
      }
      const query = filters.query?.trim().toLowerCase();
      const tags = filters.tags?.map(tag => tag.toLowerCase()) || [];
      const storedPage = await this.store.queryEntries?.({
        diaryId: filters.diaryId,
        fromDate: filters.fromDate,
        toDate: filters.toDate,
        mood: filters.mood,
        hasPhotos: filters.hasPhotos,
        allowedDiaryIds: filters.allowedDiaryIds,
        excludeDiaryIds: filters.excludeDiaryIds,
        query,
        tags,
        limit: filters.limit,
        cursor: filters.cursor,
        offset: filters.offset,
        sort: 'updated-desc',
      });
      if (storedPage) return filters.includeBody === false
        ? { ...clone(storedPage), items: storedPage.items.map(entrySummary) }
        : clone(storedPage);

      const entries = filterEntriesByDiaryAccess(await this.listEntries(), filters)
        .filter(entry => !filters.diaryId || entry.diaryId === filters.diaryId)
        .filter(entry => matchesDateRange(entry, filters))
        .filter(entry => !filters.mood || entry.moodName === filters.mood)
        .filter(entry => filters.hasPhotos === undefined || (entry.photoCount > 0) === filters.hasPhotos)
        .filter(entry => tags.length === 0 || tags.every(tag => entry.tags.some(entryTag => entryTag.toLowerCase() === tag)))
        .filter(entry => !query || (
          entry.title.toLowerCase().includes(query) ||
          richTextHtmlToPlainText(entry.body).toLowerCase().includes(query) ||
          entry.tags.some(tag => tag.toLowerCase().includes(query)) ||
          entry.moodName.toLowerCase().includes(query)
        ));
      const page = pageEntries(entries, filters, 'updated-desc');
      return filters.includeBody === false
        ? { ...page, items: page.items.map(entrySummary) }
        : clone(page);
    });
  }

  async searchNotes(filters: SearchFilters): Promise<PageResult<Note>> {
    await this.waitForWrites();
    return measureAsync('repository.query.notes.search', async () => {
      const query = filters.query?.trim().toLowerCase();
      const tags = filters.tags?.map(tag => tag.toLowerCase()) || [];
      const storedPage = await this.store.queryNotes?.({
        fromDate: filters.fromDate,
        toDate: filters.toDate,
        query,
        tags,
        limit: filters.limit,
        cursor: filters.cursor,
        offset: filters.offset,
        sort: 'updated-desc',
      });
      if (storedPage) return clone(storedPage);

      const notes = await this.readCollection<Note>(STORAGE_KEYS.notes, []);
      const filtered = notes
        .filter(note => {
          const date = new Date(note.updatedAt).toISOString().slice(0, 10);
          return (!filters.fromDate || date >= filters.fromDate) && (!filters.toDate || date <= filters.toDate);
        })
        .filter(note => tags.length === 0 || tags.every(tag => note.tags.some(noteTag => noteTag.toLowerCase() === tag)))
        .filter(note => !query || (
          note.title.toLowerCase().includes(query) ||
          richTextHtmlToPlainText(note.body).toLowerCase().includes(query) ||
          note.tags.some(tag => tag.toLowerCase().includes(query))
        ))
        .sort((left, right) => right.updatedAt - left.updatedAt);
      return clone(pageNotes(filtered, filters, 'updated-desc'));
    });
  }

  async getHomeSummary(
    options: Pick<EntryListOptions, 'allowedDiaryIds' | 'excludeDiaryIds'> = {},
  ): Promise<HomeSummary> {
    return measureAsync('repository.query.homeSummary', async () => {
      const [diaries, projectedEntries, projectedNotes, profile] = await Promise.all([
        this.listDiaries(),
        this.readAllEntryProjections(options),
        this.readAllNoteProjections(),
        this.getUserProfile(),
      ]);
      const entries = projectedEntries || await this.listEntries();
      const notes = projectedNotes || await this.readCollection<Note>(STORAGE_KEYS.notes, []);
      const visibleEntries = filterEntriesByDiaryAccess(entries, options);
      const commonTags = tagDistributionFromEntries(visibleEntries);
      return {
        profile,
        recentDiaries: clone(diaries)
          .sort((left, right) => (right.lastEntryUpdatedAt || 0) - (left.lastEntryUpdatedAt || 0))
          .slice(0, 8),
        recentEntries: sortEntries(visibleEntries, 'updated-desc').slice(0, 8).map(entrySummary),
        recentPhotos: sortEntries(visibleEntries, 'date-desc')
          .flatMap(entry => (entry.photoUris || []).map(src => ({
            src,
            entryId: entry.id,
            diaryId: entry.diaryId,
            date: entry.date,
          })))
          .slice(0, 8),
        pinnedNotes: notes.filter(note => note.isPinned).sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 5).map(noteSummary),
        entryCount: visibleEntries.length,
        noteCount: notes.length,
        diaryCount: diaries.length,
        todayWordCount: getTodayWordCount(visibleEntries),
        currentStreak: calculateStreak(visibleEntries),
        commonTags: commonTags.slice(0, 12),
      };
    });
  }

  async getDiaryStatistics(diaryId: string): Promise<DiaryStatistics> {
    const entries = await this.readAllEntryProjections({ diaryId })
      || (await this.listEntries()).filter(entry => entry.diaryId === diaryId);
    return {
      diaryId,
      entryCount: entries.length,
      wordCount: entries.reduce((sum, entry) => sum + (entry.wordCount || 0), 0),
      photoCount: entries.reduce((sum, entry) => sum + (entry.photoCount || 0), 0),
      lastEntryDate: (() => {
        const dates = entries.map(entry => entry.date).sort();
        return dates.length > 0 ? dates[dates.length - 1] : undefined;
      })(),
      lastUpdated: entries.reduce((latest, entry) => Math.max(latest, entry.updatedAt), 0) || undefined,
    };
  }

  async getGlobalStatistics(filters: StatisticsFilters = {}): Promise<GlobalStatistics> {
    const [diaries, projectedEntries, projectedNotes] = await Promise.all([
      this.listDiaries(),
      this.readAllEntryProjections(filters),
      this.readAllNoteProjections(),
    ]);
    const entries = projectedEntries || await this.listEntries();
    const notes = projectedNotes || await this.readCollection<Note>(STORAGE_KEYS.notes, []);
    const filteredEntries = filterEntriesByDiaryAccess(entries, filters).filter(entry => matchesDateRange(entry, filters));
    return {
      entryCount: filteredEntries.length,
      noteCount: notes.length,
      diaryCount: diaries.length,
      wordCount: filteredEntries.reduce((sum, entry) => sum + (entry.wordCount || 0), 0),
      photoCount: filteredEntries.reduce((sum, entry) => sum + (entry.photoCount || 0), 0),
    };
  }

  async getMoodDistribution(filters: StatisticsFilters = {}): Promise<DistributionRow[]> {
    const counts = new Map<string, DistributionRow>();
    const entries = await this.readAllEntryProjections(filters) || await this.listEntries();
    filterEntriesByDiaryAccess(entries, filters)
      .filter(entry => matchesDateRange(entry, filters))
      .forEach(entry => {
        const key = entry.moodName || 'Reflective';
        const row = counts.get(key) || { key, label: key, count: 0, emoji: entry.moodEmoji };
        row.count += 1;
        if (!row.emoji && entry.moodEmoji) row.emoji = entry.moodEmoji;
        counts.set(key, row);
      });
    return [...counts.values()].sort((left, right) => right.count - left.count);
  }

  async getTagDistribution(filters: StatisticsFilters = {}): Promise<DistributionRow[]> {
    const entries = await this.readAllEntryProjections(filters) || await this.listEntries();
    return tagDistributionFromEntries(
      filterEntriesByDiaryAccess(entries, filters).filter(entry => matchesDateRange(entry, filters)),
    );
  }

  async getWritingHeatmap(filters: StatisticsFilters = {}): Promise<WritingHeatmapRow[]> {
    const rows = new Map<string, WritingHeatmapRow>();
    const entries = await this.readAllEntryProjections(filters) || await this.listEntries();
    filterEntriesByDiaryAccess(entries, filters)
      .filter(entry => matchesDateRange(entry, filters))
      .forEach(entry => {
        const row = rows.get(entry.date) || { date: entry.date, count: 0, wordCount: 0 };
        row.count += 1;
        row.wordCount += entry.wordCount || 0;
        rows.set(entry.date, row);
      });
    return [...rows.values()].sort((left, right) => left.date.localeCompare(right.date));
  }

  async getSettings(): Promise<AppSettings> {
    await this.waitForWrites();
    return this.readJson(STORAGE_KEYS.settings, clone(DEFAULT_APP_SETTINGS));
  }

  saveSettings(settings: AppSettings): Promise<void> {
    return this.enqueueWrite(async () => {
      await this.writePortableItems(
        { [STORAGE_KEYS.settings]: settings },
        contentRevision => ({ type: 'settings-updated', settings: clone(settings), contentRevision }),
      );
      await syncReminderNotification(settings);
    });
  }

  async getUserProfile(): Promise<UserProfile> {
    await this.waitForWrites();
    const driveBackup = await this.readJson<DriveBackupSettings>(STORAGE_KEYS.driveBackup, {});
    return this.readJson(STORAGE_KEYS.userProfile, createDefaultUserProfile(driveBackup.linkedGoogleEmail));
  }

  saveUserProfile(profile: UserProfile): Promise<void> {
    return this.enqueueWrite(async () => {
      await this.writePortableItems(
        { [STORAGE_KEYS.userProfile]: profile },
        contentRevision => ({ type: 'profile-updated', profile: clone(profile), contentRevision }),
      );
    });
  }

  async getSecurityConfig(): Promise<SecurityConfig> {
    await this.waitForWrites();
    return normalizeSecurityConfig(await this.readJson(STORAGE_KEYS.security, clone(DEFAULT_SECURITY_CONFIG)));
  }

  saveSecurityConfig(config: SecurityConfig): Promise<void> {
    return this.enqueueWrite(() => this.writeJson(STORAGE_KEYS.security, config));
  }

  async getDriveBackupSettings(): Promise<DriveBackupSettings> {
    await this.waitForWrites();
    const defaults = createDefaultDriveBackupSettings();
    const stored = await this.readJson<DriveBackupSettings>(STORAGE_KEYS.driveBackup, defaults);
    return {
      ...defaults,
      ...stored,
      schedule: { ...defaults.schedule!, ...stored.schedule },
      deviceId: stored.deviceId || defaults.deviceId,
    };
  }

  saveDriveBackupSettings(settings: DriveBackupSettings): Promise<void> {
    return this.enqueueWrite(async () => {
      const current = await this.readJson<DriveBackupSettings>(STORAGE_KEYS.driveBackup, createDefaultDriveBackupSettings());
      await this.writeJson(STORAGE_KEYS.driveBackup, {
        ...current,
        ...settings,
        schedule: settings.schedule ? { ...current.schedule!, ...settings.schedule } : current.schedule,
        deviceId: current.deviceId || settings.deviceId,
        contentRevision: Math.max(current.contentRevision || 0, settings.contentRevision || 0),
      });
    });
  }

  async getLocalSyncAccountState(): Promise<LocalSyncAccountState | null> {
    await this.waitForWrites();
    return this.readNullableJson<LocalSyncAccountState>(STORAGE_KEYS.syncAccount);
  }

  saveLocalSyncAccountState(state: LocalSyncAccountState): Promise<void> {
    return this.enqueueWrite(() => this.writeJson(STORAGE_KEYS.syncAccount, state));
  }

  clearLocalSyncAccountState(): Promise<void> {
    return this.enqueueWrite(async () => {
      await this.writePortableItems({
        [STORAGE_KEYS.diaries]: clone(INITIAL_DIARIES),
        [STORAGE_KEYS.entries]: [],
        [STORAGE_KEYS.notes]: [],
        [STORAGE_KEYS.syncRecordVersions]: {},
        [STORAGE_KEYS.syncMediaPointers]: {},
        [STORAGE_KEYS.syncPartitionHydration]: {},
        [STORAGE_KEYS.syncOutbox]: {},
        [STORAGE_KEYS.syncOutboxV2]: {},
      });
      await this.store.removeItem(STORAGE_KEYS.syncAccount);
    });
  }

  async getSyncRecordVersion(recordType: SyncRecordType, recordId: string): Promise<number> {
    await this.waitForWrites();
    const versions = await this.readJson<Record<string, number>>(STORAGE_KEYS.syncRecordVersions, {});
    return versions[`${recordType}:${recordId}`] || 0;
  }

  applySyncEvent(event: SyncDomainEvent, sequence: number, options: { allowHistorical?: boolean } = {}): Promise<void> {
    return this.enqueueWrite(async () => {
      const syncState = await this.readNullableJson<LocalSyncAccountState>(STORAGE_KEYS.syncAccount);
      if (!syncState || syncState.accountId !== event.accountId) {
        throw new Error('The sync event does not belong to the local account.');
      }
      if (!options.allowHistorical && sequence <= syncState.currentSyncSequence) return;

      const versions = await this.readJson<Record<string, number>>(STORAGE_KEYS.syncRecordVersions, {});
      const recordKey = `${event.recordType}:${event.recordId}`;
      const currentVersion = versions[recordKey] || 0;
      const affectedVersions = (event.affectedRecords || []).map(affected => ({
        record: affected,
        key: `${affected.recordType}:${affected.recordId}`,
        currentVersion: versions[`${affected.recordType}:${affected.recordId}`] || 0,
      }));
      const eventAlreadyCovered = (
        currentVersion >= event.recordVersion &&
        affectedVersions.every(affected => affected.currentVersion >= affected.record.recordVersion)
      );
      const hasVersionMismatch = (
        currentVersion !== event.baseRecordVersion ||
        event.recordVersion !== currentVersion + 1 ||
        affectedVersions.some(affected => affected.currentVersion !== affected.record.baseRecordVersion)
      );
      if (hasVersionMismatch) {
        if (options.allowHistorical && eventAlreadyCovered) {
          await this.writeManyJson({
            [STORAGE_KEYS.syncAccount]: {
              ...syncState,
              currentSyncSequence: Math.max(syncState.currentSyncSequence, sequence),
            },
          });
          return;
        }
        throw new Error(`Sync record version mismatch for ${recordKey}.`);
      }

      const items: Record<string, unknown> = {};
      const metadataItems: Record<string, unknown> = {};
      const recordMutations: LocalStructuredRecordMutation[] = [];
      if (event.recordType === 'diary') {
        const diaries = await this.readCollection(STORAGE_KEYS.diaries, clone(INITIAL_DIARIES));
        const entries = await this.readCollection<Entry>(STORAGE_KEYS.entries, []);
        const nextDiaries = event.operation === 'delete'
          ? diaries.filter(diary => diary.id !== event.recordId)
          : this.upsertRecord(diaries, event.payload as Diary);
        const nextEntries = event.operation === 'delete'
          ? entries.filter(entry => entry.diaryId !== event.recordId)
          : entries;
        items[STORAGE_KEYS.entries] = nextEntries;
        const diariesWithStats = this.withDiaryStats(nextDiaries, nextEntries);
        items[STORAGE_KEYS.diaries] = diariesWithStats;
        if (event.operation === 'delete') {
          recordMutations.push(
            { key: STORAGE_KEYS.diaries, id: event.recordId, value: null },
            ...entries
              .filter(entry => entry.diaryId === event.recordId)
              .map(entry => ({ key: STORAGE_KEYS.entries, id: entry.id, value: null })),
          );
        } else {
          const diary = diariesWithStats.find(candidate => candidate.id === event.recordId) || event.payload as Diary;
          recordMutations.push({ key: STORAGE_KEYS.diaries, id: event.recordId, value: diary });
        }
      } else if (event.recordType === 'entry') {
        const entries = await this.readCollection<Entry>(STORAGE_KEYS.entries, []);
        const nextEntries = event.operation === 'delete'
          ? entries.filter(entry => entry.id !== event.recordId)
          : this.upsertRecord(entries, sanitizeEntry(event.payload as Entry));
        const diaries = await this.readCollection(STORAGE_KEYS.diaries, clone(INITIAL_DIARIES));
        const diariesWithStats = this.withDiaryStats(diaries, nextEntries);
        items[STORAGE_KEYS.entries] = nextEntries;
        items[STORAGE_KEYS.diaries] = diariesWithStats;
        recordMutations.push(
          {
            key: STORAGE_KEYS.entries,
            id: event.recordId,
            value: event.operation === 'delete' ? null : sanitizeEntry(event.payload as Entry),
          },
          ...diariesWithStats.map(diary => ({ key: STORAGE_KEYS.diaries, id: diary.id, value: diary })),
        );
      } else if (event.recordType === 'note') {
        const notes = await this.readCollection<Note>(STORAGE_KEYS.notes, []);
        items[STORAGE_KEYS.notes] = event.operation === 'delete'
          ? notes.filter(note => note.id !== event.recordId)
          : this.upsertRecord(notes, sanitizeNote(event.payload as Note));
        recordMutations.push({
          key: STORAGE_KEYS.notes,
          id: event.recordId,
          value: event.operation === 'delete' ? null : sanitizeNote(event.payload as Note),
        });
      } else if (event.recordType === 'settings') {
        if (event.operation === 'delete' || !event.payload) throw new Error('Settings cannot be deleted.');
        const currentSettings = await this.readJson(STORAGE_KEYS.settings, clone(DEFAULT_APP_SETTINGS));
        items[STORAGE_KEYS.settings] = {
          ...currentSettings,
          customTags: event.payload.customTags,
          customMoods: event.payload.customMoods,
          theme: currentSettings.theme,
        };
        metadataItems[STORAGE_KEYS.settings] = items[STORAGE_KEYS.settings];
      } else {
        if (event.operation === 'delete' || !event.payload) throw new Error('Profile cannot be deleted.');
        items[STORAGE_KEYS.userProfile] = event.payload;
        metadataItems[STORAGE_KEYS.userProfile] = event.payload;
      }

      versions[recordKey] = event.recordVersion;
      for (const affected of event.affectedRecords || []) {
        versions[`${affected.recordType}:${affected.recordId}`] = affected.recordVersion;
      }
      items[STORAGE_KEYS.syncRecordVersions] = versions;
      metadataItems[STORAGE_KEYS.syncRecordVersions] = versions;
      items[STORAGE_KEYS.syncAccount] = {
        ...syncState,
        currentSyncSequence: Math.max(syncState.currentSyncSequence, sequence),
      };
      metadataItems[STORAGE_KEYS.syncAccount] = items[STORAGE_KEYS.syncAccount];
      const changeFactory = (contentRevision: number): RepositoryChange => ({
          type: 'remote-batch-applied',
          affectedRecords: [
            { recordType: event.recordType, recordId: event.recordId },
            ...(event.affectedRecords || []).map(affected => ({
              recordType: affected.recordType,
              recordId: affected.recordId,
            })),
          ],
          contentRevision,
        });
      if (this.store.commitStructuredRecords) {
        await this.writeStructuredRecordsWithRevision(recordMutations, metadataItems, changeFactory);
      } else {
        await this.writePortableItems(items, changeFactory);
      }
      if (event.recordType === 'settings') {
        await syncReminderNotification(await this.readJson(STORAGE_KEYS.settings, clone(DEFAULT_APP_SETTINGS)));
      }
    });
  }

  async getSyncMediaPointer(sequence: number): Promise<SyncMediaPointer | null> {
    await this.waitForWrites();
    const pointers = await this.readJson<Record<string, SyncMediaPointer>>(STORAGE_KEYS.syncMediaPointers, {});
    return pointers[String(sequence)]
      || Object.values(pointers).find(pointer => pointer.sequence === sequence)
      || null;
  }

  async getSyncMediaPointerByMediaId(mediaId: string): Promise<SyncMediaPointer | null> {
    await this.waitForWrites();
    const pointers = await this.readJson<Record<string, SyncMediaPointer>>(STORAGE_KEYS.syncMediaPointers, {});
    return Object.values(pointers).find(pointer => pointer.mediaId === mediaId) || null;
  }

  async getSyncMediaPointerByDriveFileId(driveFileId: string): Promise<SyncMediaPointer | null> {
    await this.waitForWrites();
    const pointers = await this.readJson<Record<string, SyncMediaPointer>>(STORAGE_KEYS.syncMediaPointers, {});
    return Object.values(pointers).find(pointer => pointer.driveFileId === driveFileId) || null;
  }

  saveSyncMediaPointer(pointer: SyncMediaPointer): Promise<void> {
    return this.enqueueWrite(async () => {
      const pointers = await this.readJson<Record<string, SyncMediaPointer>>(STORAGE_KEYS.syncMediaPointers, {});
      const key = pointer.sequence > 0 ? String(pointer.sequence) : `media:${pointer.mediaId}`;
      Object.entries(pointers).forEach(([existingKey, existing]) => {
        if (
          existingKey !== key
          && (
            (pointer.sequence > 0 && existing.sequence === pointer.sequence)
            || (!!pointer.mediaId && existing.mediaId === pointer.mediaId)
            || existing.driveFileId === pointer.driveFileId
          )
        ) {
          delete pointers[existingKey];
        }
      });
      pointers[key] = clone(pointer);
      await this.writeJson(STORAGE_KEYS.syncMediaPointers, pointers);
    });
  }

  replaceSyncMediaPointers(pointers: SyncMediaPointer[]): Promise<void> {
    return this.enqueueWrite(() => this.writeJson(
      STORAGE_KEYS.syncMediaPointers,
      Object.fromEntries(pointers.map(pointer => [String(pointer.sequence), clone(pointer)])),
    ));
  }

  async exportPartitionSnapshot(partitionKey: SyncPartitionKey | string): Promise<RepositorySnapshot> {
    return filterSnapshotForPartition(await this.exportSnapshot(), partitionKey);
  }

  async importPartitionSnapshot(partitionKey: SyncPartitionKey | string, snapshot: RepositorySnapshot): Promise<void> {
    if (!Array.isArray(snapshot.diaries) || !Array.isArray(snapshot.entries) || !Array.isArray(snapshot.notes)) {
      throw new Error('The partition snapshot is incomplete.');
    }
    const current = await this.exportSnapshot();
    if (partitionKey === CORE_PARTITION_KEY) {
      await this.importSnapshot({
        ...current,
        diaries: snapshot.diaries.length > 0 ? snapshot.diaries : current.diaries,
        settings: snapshot.settings || current.settings,
        userProfile: snapshot.userProfile || current.userProfile,
        syncRecordVersions: { ...(current.syncRecordVersions || {}), ...(snapshot.syncRecordVersions || {}) },
        syncMediaPointers: { ...(current.syncMediaPointers || {}), ...(snapshot.syncMediaPointers || {}) },
      }, 'replace-portable');
      return;
    }
    if (!isMonthPartitionKey(partitionKey)) throw new Error('Unsupported partition key.');
    const month = partitionKey.slice('month:'.length);
    const nextEntries = [
      ...current.entries.filter(entry => !entry.date.startsWith(month)),
      ...snapshot.entries,
    ];
    const nextNotes = [
      ...current.notes.filter(note => {
        try {
          return monthFromTimestamp(note.createdAt) !== month;
        } catch {
          return true;
        }
      }),
      ...snapshot.notes,
    ];
    await this.importSnapshot({
      ...current,
      entries: nextEntries,
      notes: nextNotes,
      syncRecordVersions: { ...(current.syncRecordVersions || {}), ...(snapshot.syncRecordVersions || {}) },
      syncMediaPointers: { ...(current.syncMediaPointers || {}), ...(snapshot.syncMediaPointers || {}) },
    }, 'replace-portable');
  }

  async getPartitionHydrationState(partitionKey: SyncPartitionKey | string): Promise<PartitionHydrationState> {
    await this.waitForWrites();
    const states = await this.readJson<Record<string, PartitionHydrationState>>(STORAGE_KEYS.syncPartitionHydration, {});
    return states[partitionKey] || {
      partitionKey,
      status: 'not_available',
      lastAppliedSequence: 0,
    };
  }

  async listAvailableArchiveMonths(): Promise<PartitionHydrationState[]> {
    await this.waitForWrites();
    const states = await this.readJson<Record<string, PartitionHydrationState>>(STORAGE_KEYS.syncPartitionHydration, {});
    return Object.values(states)
      .filter(state => isMonthPartitionKey(state.partitionKey) && state.status !== 'not_available')
      .sort((left, right) => String(right.partitionKey).localeCompare(String(left.partitionKey)));
  }

  markPartitionAvailable(partitionKey: SyncPartitionKey | string, sequence: number): Promise<void> {
    return this.enqueueWrite(async () => {
      const states = await this.readJson<Record<string, PartitionHydrationState>>(STORAGE_KEYS.syncPartitionHydration, {});
      const existing = states[partitionKey];
      if (existing?.status === 'hydrated') return;
      states[partitionKey] = {
        partitionKey,
        status: 'available',
        lastAppliedSequence: Math.max(existing?.lastAppliedSequence || 0, sequence),
        failureCount: existing?.failureCount,
        failedAt: existing?.failedAt,
        nextRetryAt: existing?.nextRetryAt,
        error: existing?.error,
      };
      await this.writeJson(STORAGE_KEYS.syncPartitionHydration, states);
    });
  }

  markPartitionHydrating(partitionKey: SyncPartitionKey | string): Promise<void> {
    return this.enqueueWrite(async () => {
      const states = await this.readJson<Record<string, PartitionHydrationState>>(STORAGE_KEYS.syncPartitionHydration, {});
      const existing = states[partitionKey];
      states[partitionKey] = {
        partitionKey,
        status: 'hydrating',
        lastAppliedSequence: existing?.lastAppliedSequence || 0,
        failureCount: existing?.failureCount,
        failedAt: existing?.failedAt,
        nextRetryAt: existing?.nextRetryAt,
        error: existing?.error,
      };
      await this.writeJson(STORAGE_KEYS.syncPartitionHydration, states);
    });
  }

  markPartitionHydrated(partitionKey: SyncPartitionKey | string, sequence: number): Promise<void> {
    return this.enqueueWrite(async () => {
      const states = await this.readJson<Record<string, PartitionHydrationState>>(STORAGE_KEYS.syncPartitionHydration, {});
      states[partitionKey] = {
        partitionKey,
        status: 'hydrated',
        lastAppliedSequence: sequence,
        hydratedAt: Date.now(),
      };
      await this.writeJson(STORAGE_KEYS.syncPartitionHydration, states);
    });
  }

  markPartitionHydrationFailed(partitionKey: SyncPartitionKey | string, error: string): Promise<void> {
    return this.enqueueWrite(async () => {
      const states = await this.readJson<Record<string, PartitionHydrationState>>(STORAGE_KEYS.syncPartitionHydration, {});
      const existing = states[partitionKey];
      const failureCount = (existing?.failureCount || 0) + 1;
      const retryDelay = Math.min(
        ARCHIVE_HYDRATION_RETRY_MAX_MS,
        ARCHIVE_HYDRATION_RETRY_BASE_MS * (2 ** Math.min(failureCount - 1, 12)),
      );
      const failedAt = Date.now();
      states[partitionKey] = {
        partitionKey,
        status: 'failed',
        lastAppliedSequence: existing?.lastAppliedSequence || 0,
        failedAt,
        failureCount,
        nextRetryAt: failedAt + retryDelay,
        error,
      };
      await this.writeJson(STORAGE_KEYS.syncPartitionHydration, states);
    });
  }

  saveSyncOutboxOperation(operation: SyncOutboxOperation): Promise<void> {
    return this.enqueueWrite(async () => {
      const outbox = await this.readJson<Record<string, SyncOutboxOperation>>(STORAGE_KEYS.syncOutbox, {});
      outbox[operation.operationId] = clone({ ...operation, updatedAt: Date.now() });
      await this.writeJson(STORAGE_KEYS.syncOutbox, outbox);
      await this.emitSyncStatusChange(outbox, operation.operationId);
    });
  }

  async listSyncOutboxOperations(states?: SyncOutboxOperation['state'][]): Promise<SyncOutboxOperation[]> {
    await this.waitForWrites();
    const outbox = await this.readJson<Record<string, SyncOutboxOperation>>(STORAGE_KEYS.syncOutbox, {});
    return Object.values(outbox)
      .filter(operation => !states || states.includes(operation.state))
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  removeSyncOutboxOperation(operationId: string): Promise<void> {
    return this.enqueueWrite(async () => {
      const outbox = await this.readJson<Record<string, SyncOutboxOperation>>(STORAGE_KEYS.syncOutbox, {});
      delete outbox[operationId];
      await this.writeJson(STORAGE_KEYS.syncOutbox, outbox);
      await this.emitSyncStatusChange(outbox, operationId);
    });
  }

  async getSyncStatusSummary(): Promise<SyncStatusSummary> {
    const outbox = await this.listSyncOutboxOperations();
    return this.createSyncStatusSummary(outbox);
  }

  async rebuildDerivedProjections(): Promise<void> {
    await this.waitForWrites();
    const [diaries, entries, notes] = await Promise.all([
      this.listDiaries(),
      this.listEntries(),
      this.listNotes(),
    ]);
    await this.store.setItems(this.serializeItems({
      [STORAGE_KEYS.diaries]: diaries,
      [STORAGE_KEYS.entries]: entries,
      [STORAGE_KEYS.notes]: notes,
    }));
  }

  async getSyncHealth(): Promise<SyncHealth> {
    await this.waitForWrites();
    return this.readJson<SyncHealth>(STORAGE_KEYS.syncHealth, createDefaultSyncHealth());
  }

  updateSyncHealth(patch: SyncHealthPatch): Promise<SyncHealth> {
    return this.enqueueWrite(async () => {
      const current = await this.readJson<SyncHealth>(STORAGE_KEYS.syncHealth, createDefaultSyncHealth());
      const health: SyncHealth = { ...current, ...patch, updatedAt: Date.now() };
      await this.writeJson(STORAGE_KEYS.syncHealth, health);
      return clone(health);
    });
  }

  async listPreservedSyncConflicts(): Promise<PreservedSyncConflict[]> {
    const operations = await this.listSyncOutboxOperations(['conflict_preserved']);
    const conflicts = await Promise.all(operations.map(async operation => {
      const recoveredRecord = operation.recoveredRecordId
        ? operation.recordType === 'entry'
          ? await this.getEntry(operation.recoveredRecordId)
          : operation.recordType === 'note'
            ? await this.getNote(operation.recoveredRecordId)
            : null
        : null;
      const currentRecord = operation.recordType === 'entry'
        ? await this.getEntry(operation.recordId)
        : operation.recordType === 'note'
          ? await this.getNote(operation.recordId)
          : null;
      return { operation, currentRecord, recoveredRecord };
    }));
    return conflicts;
  }

  markSyncConflictResolved(operationId: string): Promise<void> {
    return this.removeSyncOutboxOperation(operationId);
  }

  async deleteSyncConflictRecoveredCopy(operationId: string): Promise<boolean> {
    const operation = (await this.listSyncOutboxOperations(['conflict_preserved']))
      .find(candidate => candidate.operationId === operationId);
    if (!operation?.recoveredRecordId) return false;
    if (operation.recordType === 'entry') return this.deleteEntry(operation.recoveredRecordId);
    if (operation.recordType === 'note') return this.deleteNote(operation.recoveredRecordId);
    return false;
  }

  retryPreservedSyncConflict(operationId: string): Promise<void> {
    return measureAsync('repository.sync.retryPreservedConflict', () => this.enqueueWrite(async () => {
      const outbox = await this.readJson<Record<string, SyncOutboxOperation>>(STORAGE_KEYS.syncOutbox, {});
      const operation = outbox[operationId];
      if (!operation || operation.state !== 'conflict_preserved') return;
      outbox[operationId] = {
        ...operation,
        state: 'prepared',
        baseRecordVersion: undefined,
        dependsOnOperationId: undefined,
        retryCount: undefined,
        lastErrorAt: undefined,
        nextRetryAt: undefined,
        error: undefined,
        updatedAt: Date.now(),
      };
      await this.writeJson(STORAGE_KEYS.syncOutbox, outbox);
      await this.emitSyncStatusChange(outbox, operationId);
    }));
  }

  applyLocalMutationWithOutbox(input: ApplyLocalMutationWithOutboxInput): Promise<Diary | Entry | Note | AppSettings | UserProfile | null> {
    return measureAsync('repository.local.mutationWithOutbox', () => this.enqueueWrite(async () => {
      const versions = await this.readJson<Record<string, number>>(STORAGE_KEYS.syncRecordVersions, {});
      const outbox = await this.readJson<Record<string, SyncOutboxOperation>>(STORAGE_KEYS.syncOutbox, {});
      const outboxV2 = await this.readJson<Record<string, SyncOutboxOperationV2>>(STORAGE_KEYS.syncOutboxV2, {});
      const recordKey = `${input.recordType}:${input.recordId}`;
      const existingSameRecordOperations = Object.values(outbox)
        .filter(operation => (
          operation.localApplied &&
          operation.recordType === input.recordType &&
          operation.recordId === input.recordId &&
          operation.state !== 'applied'
        ))
        .sort((left, right) => (right.updatedAt || right.createdAt || 0) - (left.updatedAt || left.createdAt || 0));
      const latestSameRecordOperation = existingSameRecordOperations[0];
      const operationId = input.operationId;
      const dependsOnOperationId = latestSameRecordOperation?.operationId;
      const dependencyV2 = dependsOnOperationId ? outboxV2[dependsOnOperationId] : undefined;
      const baseRecordVersion = dependsOnOperationId
        ? (dependencyV2?.baseRecordVersion ?? latestSameRecordOperation?.baseRecordVersion ?? versions[recordKey] ?? 0) + 1
        : versions[recordKey] ?? 0;
      const nowMs = input.createdAt || Date.now();
      const syncPayload = input.syncPayload === undefined ? input.localPayload : input.syncPayload;
      const affectedRecords: SyncOutboxOperation['affectedRecords'] = [];
      const items: Record<string, unknown> = {};
      const metadataItems: Record<string, unknown> = {};
      const recordMutations: LocalStructuredRecordMutation[] = [];
      let result: Diary | Entry | Note | AppSettings | UserProfile | null = input.operation === 'delete' ? null : clone(input.localPayload);
      let changeFactory: ((contentRevision: number) => RepositoryChange) | undefined;

      if (input.recordType === 'diary') {
        const diaries = await this.readCollection(STORAGE_KEYS.diaries, clone(INITIAL_DIARIES));
        const entries = await this.readCollection<Entry>(STORAGE_KEYS.entries, []);
        if (input.operation === 'delete') {
          entries
            .filter(entry => entry.diaryId === input.recordId)
            .forEach(entry => affectedRecords.push({
              recordType: 'entry',
              recordId: entry.id,
              baseRecordVersion: versions[`entry:${entry.id}`] || 0,
            }));
          items[STORAGE_KEYS.entries] = entries.filter(entry => entry.diaryId !== input.recordId);
          items[STORAGE_KEYS.diaries] = diaries.filter(diary => diary.id !== input.recordId);
          recordMutations.push(
            { key: STORAGE_KEYS.diaries, id: input.recordId, value: null },
            ...entries
              .filter(entry => entry.diaryId === input.recordId)
              .map(entry => ({ key: STORAGE_KEYS.entries, id: entry.id, value: null })),
          );
          changeFactory = contentRevision => ({ type: 'diary-deleted', diaryId: input.recordId, contentRevision });
        } else {
          const diary = clone(input.localPayload as Diary);
          const nextDiaries = this.upsertRecord(diaries, diary);
          const diariesWithStats = this.withDiaryStats(nextDiaries, entries);
          items[STORAGE_KEYS.diaries] = diariesWithStats;
          recordMutations.push({
            key: STORAGE_KEYS.diaries,
            id: diary.id,
            value: diariesWithStats.find(candidate => candidate.id === diary.id) || diary,
          });
          result = diary;
          changeFactory = contentRevision => ({
            type: diaries.some(existing => existing.id === diary.id) ? 'diary-updated' : 'diary-created',
            diary: clone(diary),
            contentRevision,
          } as RepositoryChange);
        }
      } else if (input.recordType === 'entry') {
        const entries = await this.readCollection<Entry>(STORAGE_KEYS.entries, []);
        const existing = entries.find(entry => entry.id === input.recordId);
        const diaries = await this.readCollection(STORAGE_KEYS.diaries, clone(INITIAL_DIARIES));
        if (input.operation === 'delete') {
          const nextEntries = entries.filter(entry => entry.id !== input.recordId);
          const diariesWithStats = this.withDiaryStats(diaries, nextEntries);
          items[STORAGE_KEYS.entries] = nextEntries;
          items[STORAGE_KEYS.diaries] = diariesWithStats;
          recordMutations.push(
            { key: STORAGE_KEYS.entries, id: input.recordId, value: null },
            ...diariesWithStats.map(diary => ({ key: STORAGE_KEYS.diaries, id: diary.id, value: diary })),
          );
          changeFactory = contentRevision => ({
            type: 'entry-deleted',
            entryId: input.recordId,
            diaryId: existing?.diaryId || '',
            contentRevision,
          });
        } else {
          const entry = sanitizeEntry(clone(input.localPayload as Entry));
          const nextEntries = this.upsertRecord(entries, entry);
          const diariesWithStats = this.withDiaryStats(diaries, nextEntries);
          items[STORAGE_KEYS.entries] = nextEntries;
          items[STORAGE_KEYS.diaries] = diariesWithStats;
          recordMutations.push(
            { key: STORAGE_KEYS.entries, id: entry.id, value: entry },
            ...diariesWithStats.map(diary => ({ key: STORAGE_KEYS.diaries, id: diary.id, value: diary })),
          );
          result = clone(entry);
          changeFactory = contentRevision => ({
            type: existing ? 'entry-updated' : 'entry-created',
            entry: clone(entry),
            contentRevision,
          } as RepositoryChange);
        }
      } else if (input.recordType === 'note') {
        if (this.store.commitLocalMutationAndOutbox) {
          const existing = await this.readRecord<Note>(STORAGE_KEYS.notes, input.recordId, []);
          if (input.operation === 'delete') {
            recordMutations.push({ key: STORAGE_KEYS.notes, id: input.recordId, value: null });
            changeFactory = contentRevision => ({ type: 'note-deleted', noteId: input.recordId, contentRevision });
          } else {
            const note = sanitizeNote(clone(input.localPayload as Note));
            recordMutations.push({ key: STORAGE_KEYS.notes, id: note.id, value: note });
            result = clone(note);
            changeFactory = contentRevision => ({
              type: existing ? 'note-updated' : 'note-created',
              note: clone(note),
              contentRevision,
            } as RepositoryChange);
          }
        } else {
          const notes = await this.readCollection<Note>(STORAGE_KEYS.notes, []);
          const existing = notes.find(note => note.id === input.recordId);
          if (input.operation === 'delete') {
            items[STORAGE_KEYS.notes] = notes.filter(note => note.id !== input.recordId);
            changeFactory = contentRevision => ({ type: 'note-deleted', noteId: input.recordId, contentRevision });
          } else {
            const note = sanitizeNote(clone(input.localPayload as Note));
            items[STORAGE_KEYS.notes] = this.upsertRecord(notes, note);
            result = clone(note);
            changeFactory = contentRevision => ({
              type: existing ? 'note-updated' : 'note-created',
              note: clone(note),
              contentRevision,
            } as RepositoryChange);
          }
        }
      } else if (input.recordType === 'settings') {
        const settings = clone(input.localPayload as AppSettings);
        items[STORAGE_KEYS.settings] = settings;
        metadataItems[STORAGE_KEYS.settings] = settings;
        result = settings;
        changeFactory = contentRevision => ({ type: 'settings-updated', settings: clone(settings), contentRevision });
      } else {
        const profile = clone(input.localPayload as UserProfile);
        items[STORAGE_KEYS.userProfile] = profile;
        metadataItems[STORAGE_KEYS.userProfile] = profile;
        result = profile;
        changeFactory = contentRevision => ({ type: 'profile-updated', profile: clone(profile), contentRevision });
      }

      const outboxOperation: SyncOutboxOperation = {
        operationId,
        accountId: input.account.accountId,
        deviceId: input.account.deviceId,
        partitionKey: partitionKeyForRecordPayload(input.recordType, syncPayload as any),
        affectedPartitionKeys: [partitionKeyForRecordPayload(input.recordType, syncPayload as any)],
        recordType: input.recordType,
        recordId: input.recordId,
        operation: input.operation,
        payload: clone(syncPayload),
        baseRecordVersion,
        dependsOnOperationId,
        affectedRecords,
        state: 'prepared',
        localApplied: true,
        createdAt: nowMs,
        updatedAt: nowMs,
        retryCount: undefined,
        lastErrorAt: undefined,
        nextRetryAt: undefined,
        error: undefined,
      };
      outbox[operationId] = outboxOperation;
      items[STORAGE_KEYS.syncOutbox] = outbox;
      const outboxV2Operation = pendingOutboxV2FromLegacy(outboxOperation);
      outboxV2[operationId] = outboxV2Operation;
      items[STORAGE_KEYS.syncOutboxV2] = outboxV2;

      const contentRevision = await this.writeLocalMutationWithOutbox(
        recordMutations,
        metadataItems,
        outboxOperation,
        outboxV2Operation,
        items,
        changeFactory,
      );
      await this.emitSyncStatusChange(outbox, operationId, contentRevision);
      if (input.recordType === 'settings' && input.localPayload) {
        await syncReminderNotification(input.localPayload as AppSettings);
      }
      return clone(result);
    }));
  }

  acknowledgeLocalMutation(input: AcknowledgeLocalMutationInput): Promise<void> {
    return measureAsync('repository.sync.acknowledgeLocalMutation', () => this.enqueueWrite(async () => {
      const syncState = await this.readNullableJson<LocalSyncAccountState>(STORAGE_KEYS.syncAccount);
      if (!syncState || syncState.accountId !== input.event.accountId) {
        throw new Error('The sync acknowledgement does not belong to the local account.');
      }
      const versions = await this.readJson<Record<string, number>>(STORAGE_KEYS.syncRecordVersions, {});
      const recordKey = `${input.event.recordType}:${input.event.recordId}`;
      const currentVersion = versions[recordKey] || 0;
      if (currentVersion > input.event.recordVersion) return;
      if (currentVersion !== input.event.baseRecordVersion && currentVersion !== input.event.recordVersion) {
        throw new Error(`Sync record version mismatch while acknowledging ${recordKey}.`);
      }
      versions[recordKey] = Math.max(currentVersion, input.event.recordVersion);
      for (const affected of input.event.affectedRecords || []) {
        const key = `${affected.recordType}:${affected.recordId}`;
        versions[key] = Math.max(versions[key] || 0, affected.recordVersion);
      }
      await this.writeManyJson({
        [STORAGE_KEYS.syncRecordVersions]: versions,
        [STORAGE_KEYS.syncAccount]: {
          ...syncState,
          currentSyncSequence: Math.max(syncState.currentSyncSequence, input.sequence),
        },
      });
      const backup = await this.readJson<DriveBackupSettings>(STORAGE_KEYS.driveBackup, createDefaultDriveBackupSettings());
      const outbox = Object.values(await this.readJson<Record<string, SyncOutboxOperation>>(STORAGE_KEYS.syncOutbox, {}));
      this.emitChange(backup.contentRevision || 0, {
        type: 'sync-status-updated',
        operationId: input.event.eventId,
        status: this.createSyncStatusSummary(outbox),
        contentRevision: backup.contentRevision || 0,
      });
    }));
  }

  resetContent(): Promise<void> {
    return this.enqueueWrite(async () => {
      await this.writePortableItems({
        [STORAGE_KEYS.diaries]: clone(INITIAL_DIARIES),
        [STORAGE_KEYS.entries]: [],
        [STORAGE_KEYS.notes]: [],
        [STORAGE_KEYS.syncRecordVersions]: {},
        [STORAGE_KEYS.syncMediaPointers]: {},
        [STORAGE_KEYS.syncPartitionHydration]: {},
        [STORAGE_KEYS.syncOutbox]: {},
        [STORAGE_KEYS.syncOutboxV2]: {},
      });
    });
  }

  async exportSnapshot(): Promise<RepositorySnapshot> {
    const [diaries, entries, notes, settings, userProfile, security, driveBackupSettings, syncRecordVersions, syncMediaPointers] = await Promise.all([
      this.listDiaries(),
      this.listEntries(),
      this.listNotes(),
      this.getSettings(),
      this.getUserProfile(),
      this.getSecurityConfig(),
      this.getDriveBackupSettings(),
      this.readJson<Record<string, number>>(STORAGE_KEYS.syncRecordVersions, {}),
      this.readJson<Record<string, SyncMediaPointer>>(STORAGE_KEYS.syncMediaPointers, {}),
    ]);

    return {
      diaries,
      entries,
      notes,
      settings,
      userProfile,
      security,
      driveBackupSettings,
      syncRecordVersions,
      syncMediaPointers,
    };
  }

  async previewPortableMerge(snapshot: RepositorySnapshot, mediaCount = 0): Promise<BackupMergePreview> {
    const current = await this.exportSnapshot();
    return buildPortableMergePlan(current, snapshot, mediaCount, (_kind, sourceId) => `preview-${sourceId}`).preview;
  }

  async mergePortableSnapshot(snapshot: RepositorySnapshot, mediaCount = 0): Promise<BackupMergeResult> {
    const current = await this.exportSnapshot();
    const plan = buildPortableMergePlan(current, snapshot, mediaCount);
    await this.importSnapshot(plan.snapshot, 'replace-portable');
    return plan.result;
  }

  importSnapshot(snapshot: RepositorySnapshot, mode: RepositoryImportMode): Promise<void> {
    const sanitizedSnapshot = sanitizeRepositorySnapshot(snapshot);
    if (!Array.isArray(sanitizedSnapshot.diaries) || !Array.isArray(sanitizedSnapshot.entries) || !Array.isArray(sanitizedSnapshot.notes)) {
      throw new Error('The repository snapshot is incomplete.');
    }

    return this.enqueueWrite(async () => {
      const items: Record<string, unknown> = {
        [STORAGE_KEYS.entries]: clone(sanitizedSnapshot.entries),
        [STORAGE_KEYS.diaries]: this.withDiaryStats(clone(sanitizedSnapshot.diaries), sanitizedSnapshot.entries),
        [STORAGE_KEYS.notes]: clone(sanitizedSnapshot.notes),
      };
      if (sanitizedSnapshot.settings) {
        if (mode === 'replace-portable') {
          const currentSettings = await this.readJson(STORAGE_KEYS.settings, clone(DEFAULT_APP_SETTINGS));
          items[STORAGE_KEYS.settings] = {
            ...currentSettings,
            customTags: sanitizedSnapshot.settings.customTags,
            customMoods: sanitizedSnapshot.settings.customMoods,
            theme: currentSettings.theme,
          };
        } else {
          items[STORAGE_KEYS.settings] = sanitizedSnapshot.settings;
        }
      }
      if (sanitizedSnapshot.userProfile) items[STORAGE_KEYS.userProfile] = sanitizedSnapshot.userProfile;
      if (sanitizedSnapshot.syncRecordVersions) items[STORAGE_KEYS.syncRecordVersions] = sanitizedSnapshot.syncRecordVersions;
      if (sanitizedSnapshot.syncMediaPointers) items[STORAGE_KEYS.syncMediaPointers] = sanitizedSnapshot.syncMediaPointers;
      if (mode === 'replace' && sanitizedSnapshot.security) items[STORAGE_KEYS.security] = sanitizedSnapshot.security;
      if (mode === 'replace' && sanitizedSnapshot.driveBackupSettings) items[STORAGE_KEYS.driveBackup] = sanitizedSnapshot.driveBackupSettings;
      await this.writePortableItems(items);
      if (mode === 'replace' && sanitizedSnapshot.settings) await syncReminderNotification(sanitizedSnapshot.settings);
    });
  }

  private async writeEntriesAndDiaryStats(
    entries: Entry[],
    createChange?: (contentRevision: number) => RepositoryChange,
    entryMutations: LocalStructuredRecordMutation[] = [],
  ): Promise<void> {
    const diaries = await this.readCollection(STORAGE_KEYS.diaries, clone(INITIAL_DIARIES));
    if (entryMutations.length > 0 && this.store.commitStructuredRecords) {
      await this.writeStructuredRecordsWithRevision([
        ...entryMutations,
        ...this.withDiaryStats(diaries, entries).map(diary => ({
          key: STORAGE_KEYS.diaries,
          id: diary.id,
          value: diary,
        })),
      ], {}, createChange);
      return;
    }
    await this.writePortableItems({
      [STORAGE_KEYS.entries]: entries,
      [STORAGE_KEYS.diaries]: this.withDiaryStats(diaries, entries),
    }, createChange);
  }

  private withDiaryStats(diaries: Diary[], entries: Entry[]): Diary[] {
    return diaries.map(diary => {
      const diaryEntries = entries.filter(entry => entry.diaryId === diary.id);
      return {
        ...diary,
        entryCount: diaryEntries.length,
        lastUpdated: getLastUpdatedLabel(diaryEntries),
        lastEntryUpdatedAt: getLastEntryUpdatedAt(diaryEntries),
      };
    });
  }

  private upsertRecord<T extends { id: string }>(records: T[], record: T): T[] {
    const next = records.map(item => item.id === record.id ? clone(record) : item);
    if (!records.some(item => item.id === record.id)) next.push(clone(record));
    return next;
  }

  async resolvePreservedSyncConflict(operationId: string, resolution: 'keep-current' | 'keep-recovered' | 'keep-both'): Promise<void> {
    if (resolution === 'keep-current') {
      await this.deleteSyncConflictRecoveredCopy(operationId);
      await this.markSyncConflictResolved(operationId);
      return;
    }
    if (resolution === 'keep-recovered') {
      await this.retryPreservedSyncConflict(operationId);
      return;
    }
    await this.markSyncConflictResolved(operationId);
  }

  private async readAllEntryProjections(
    options: Pick<EntryListOptions | SearchFilters | StatisticsFilters,
      'allowedDiaryIds' | 'excludeDiaryIds'> & Partial<Pick<EntryListOptions, 'sort'>> &
      Partial<Pick<SearchFilters, 'diaryId' | 'fromDate' | 'toDate' | 'mood' | 'hasPhotos' | 'tags'>> = {},
  ): Promise<LocalEntryProjection[] | null> {
    if (!this.store.queryEntryProjections) return null;
    const items: LocalEntryProjection[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      const page = await this.store.queryEntryProjections({ ...options, cursor, limit: 1_000 });
      if (!page) return null;
      items.push(...page.items);
      cursor = page.nextCursor;
      if (cursor && seenCursors.has(cursor)) throw new Error('Entry projection pagination did not advance.');
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    return items;
  }

  private async readAllNoteProjections(): Promise<LocalNoteProjection[] | null> {
    if (!this.store.queryNoteProjections) return null;
    const items: LocalNoteProjection[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      const page = await this.store.queryNoteProjections({ cursor, limit: 1_000 });
      if (!page) return null;
      items.push(...page.items);
      cursor = page.nextCursor;
      if (cursor && seenCursors.has(cursor)) throw new Error('Note projection pagination did not advance.');
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    return items;
  }

  private entryPageForOptions(page: PageResult<Entry>, options: Pick<EntryListOptions, 'includeBody'>): PageResult<Entry | EntrySummary> {
    return {
      items: options.includeBody ? clone(page.items) : page.items.map(entrySummary),
      nextCursor: page.nextCursor,
      total: page.total,
    };
  }

  private notePageForOptions(page: PageResult<Note>, options: Pick<NoteListOptions, 'includeBody'>): PageResult<Note | NoteSummary> {
    return {
      items: options.includeBody ? clone(page.items) : page.items.map(noteSummary),
      nextCursor: page.nextCursor,
      total: page.total,
    };
  }

  private async readCollection<T>(key: string, fallback: T[]): Promise<T[]> {
    const structured = await this.store.getStructuredCollection?.<T>(key);
    if (structured !== undefined) return clone(structured);
    return this.readJson<T[]>(key, clone(fallback));
  }

  private async readRecord<T extends { id: string }>(key: string, id: string, fallback: T[]): Promise<T | null> {
    const structured = await this.store.getStructuredRecord?.<T>(key, id);
    if (structured !== undefined) return structured === null ? null : clone(structured);
    return (await this.readCollection<T>(key, fallback)).find(record => record.id === id) || null;
  }

  private async readJson<T>(key: string, fallback: T): Promise<T> {
    return parseJson(await this.store.getItem(key), clone(fallback));
  }

  private async readNullableJson<T>(key: string): Promise<T | null> {
    const value = await this.store.getItem(key);
    return value === null ? null : parseJson<T | null>(value, null);
  }

  private async writeJson<T>(key: string, value: T): Promise<void> {
    await this.writeManyJson({ [key]: value });
  }

  private async writeManyJson(items: Record<string, unknown>): Promise<void> {
    const serializedItems = Object.fromEntries(
      Object.entries(items).map(([key, value]) => [key, JSON.stringify(value)]),
    );
    await this.store.setItems(serializedItems);
  }

  private serializeItems(items: Record<string, unknown>): Record<string, string> {
    return Object.fromEntries(
      Object.entries(items).map(([key, value]) => [key, JSON.stringify(value)]),
    );
  }

  private async writeStructuredRecordsWithRevision(
    records: LocalStructuredRecordMutation[],
    metadataItems: Record<string, unknown>,
    createChange?: (contentRevision: number) => RepositoryChange,
  ): Promise<number> {
    if (!this.store.commitStructuredRecords) {
      throw new Error('Structured record commits are unavailable for this local data store.');
    }
    const backup = await this.readJson<DriveBackupSettings>(STORAGE_KEYS.driveBackup, createDefaultDriveBackupSettings());
    const contentRevision = (backup.contentRevision || 0) + 1;
    await this.store.commitStructuredRecords({
      records,
      items: this.serializeItems({
        ...metadataItems,
        [STORAGE_KEYS.driveBackup]: {
          ...backup,
          contentRevision,
        },
      }),
    });
    this.emitChange(contentRevision, createChange?.(contentRevision));
    return contentRevision;
  }

  private async writeLocalMutationWithOutbox(
    records: LocalStructuredRecordMutation[],
    metadataItems: Record<string, unknown>,
    outboxOperation: SyncOutboxOperation,
    outboxV2Operation: SyncOutboxOperationV2,
    fallbackItems: Record<string, unknown>,
    createChange?: (contentRevision: number) => RepositoryChange,
  ): Promise<number> {
    if (!this.store.commitLocalMutationAndOutbox) {
      return this.writePortableItems(fallbackItems, createChange);
    }
    const backup = await this.readJson<DriveBackupSettings>(STORAGE_KEYS.driveBackup, createDefaultDriveBackupSettings());
    const contentRevision = (backup.contentRevision || 0) + 1;
    await this.store.commitLocalMutationAndOutbox({
      records,
      items: this.serializeItems({
        ...metadataItems,
        [STORAGE_KEYS.driveBackup]: {
          ...backup,
          contentRevision,
        },
      }),
      outboxOperation,
      outboxV2Operation,
    });
    this.emitChange(contentRevision, createChange?.(contentRevision));
    return contentRevision;
  }

  private async writePortableItems(
    items: Record<string, unknown>,
    createChange?: (contentRevision: number) => RepositoryChange,
  ): Promise<number> {
    const backup = await this.readJson<DriveBackupSettings>(STORAGE_KEYS.driveBackup, createDefaultDriveBackupSettings());
    const contentRevision = (backup.contentRevision || 0) + 1;
    await this.writeManyJson({
      ...items,
      [STORAGE_KEYS.driveBackup]: {
        ...backup,
        contentRevision,
      },
    });
    this.emitChange(contentRevision, createChange?.(contentRevision));
    return contentRevision;
  }

  private emitChange(contentRevision: number, change?: RepositoryChange): void {
    this.changeListeners.forEach(listener => listener(contentRevision, change));
    if (change) this.typedChangeListeners.forEach(listener => listener(change));
  }

  private async emitSyncStatusChange(
    outbox: Record<string, SyncOutboxOperation>,
    operationId?: string,
    contentRevision?: number,
  ): Promise<void> {
    const operations = Object.values(outbox);
    const pending = operations.filter(operation => operation.state !== 'applied' && operation.state !== 'conflict_preserved');
    const currentHealth = await this.readJson<SyncHealth>(STORAGE_KEYS.syncHealth, createDefaultSyncHealth());
    const localState = await this.readJson<LocalSyncAccountState | null>(STORAGE_KEYS.syncAccount, null);
    await this.writeJson(STORAGE_KEYS.syncHealth, {
      ...currentHealth,
      accountId: localState?.accountId,
      lastLocalWriteAt: operationId ? Date.now() : currentHealth.lastLocalWriteAt,
      pendingOperationCount: pending.length,
      processingOperationCount: pending.filter(operation => !['prepared', 'failed'].includes(operation.state)).length,
      retryingOperationCount: pending.filter(operation => operation.state === 'failed' && Boolean(operation.nextRetryAt)).length,
      blockedOperationCount: pending.filter(operation => Boolean(operation.dependsOnOperationId)).length,
      conflictOperationCount: operations.filter(operation => operation.state === 'conflict_preserved').length,
      failedOperationCount: operations.filter(isRetryableFailedOutboxOperation).length,
      oldestPendingOperationAt: pending.length > 0 ? Math.min(...pending.map(operation => operation.createdAt)) : undefined,
      localSequence: localState?.currentSyncSequence || currentHealth.localSequence,
      connectivityState: typeof navigator !== 'undefined' && !navigator.onLine ? 'OFFLINE' : 'ONLINE',
      updatedAt: Date.now(),
    } satisfies SyncHealth);
    const backup = await this.readJson<DriveBackupSettings>(STORAGE_KEYS.driveBackup, createDefaultDriveBackupSettings());
    const revision = contentRevision ?? backup.contentRevision ?? 0;
    this.emitChange(revision, {
      type: 'sync-status-updated',
      operationId,
      status: this.createSyncStatusSummary(Object.values(outbox)),
      contentRevision: revision,
    });
  }

  private createSyncStatusSummary(outbox: SyncOutboxOperation[]): SyncStatusSummary {
    return {
      pendingOutboxCount: outbox.filter(operation => (
        operation.state !== 'applied' && operation.state !== 'conflict_preserved'
      )).length,
      failedOperationCount: outbox.filter(isRetryableFailedOutboxOperation).length,
      isOffline: typeof navigator !== 'undefined' ? !navigator.onLine : false,
      conflictCount: outbox.filter(operation => operation.state === 'conflict_preserved').length,
    };
  }

  private async waitForWrites(): Promise<void> {
    await this.writeTail;
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(operation, operation);
    this.writeTail = result.then(() => undefined, () => undefined);
    return result;
  }
}
