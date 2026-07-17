import type { Entry, Note } from '../../types';
import type {
  LocalDataStore,
  LocalEntryProjection,
  LocalEntryQueryOptions,
  LocalNoteProjection,
  LocalNoteQueryOptions,
  LocalQueryPageResult,
  LocalStructuredRecordMutation,
} from './LocalDataStore';
import { pageEntries, pageNotes } from './queryPagination';
import {
  commitEncryptedStoreBatch,
  getPlainIndexRecords,
  queryIndexToken,
  queryIndexTokens,
  REPOSITORY_STORE,
  WEB_QUERY_INDEX_STORES,
  WEB_RECORD_STORES,
  WebEncryptedKeyValueStore,
  type EncryptedStoreBatch,
} from './webEncryptedKeyValueStore';
import { richTextHtmlToPlainText } from '../../domain/richTextSanitizer';

interface EntryQueryIndexRecord {
  id: string;
  diaryId: string;
  date: string;
  updatedAt: number;
  createdAt: number;
  moodToken: string;
  hasPhotos: number;
  tagTokens: string[];
  searchTokens: string[];
}

interface NoteQueryIndexRecord {
  id: string;
  updatedAt: number;
  updatedDate: string;
  createdAt: number;
  isPinned: number;
  tagTokens: string[];
  searchTokens: string[];
}

type StructuredStorageSpec =
  | { kind: 'array'; storeName: string }
  | { kind: 'map'; storeName: string }
  | { kind: 'single'; storeName: string; recordKey: string };

interface StructuredCollectionMetadata {
  ready: true;
  kind: StructuredStorageSpec['kind'];
  order?: string[];
  updatedAt: number;
}

const STRUCTURED_COLLECTIONS: Record<string, StructuredStorageSpec> = {
  deardiary_diaries: { kind: 'array', storeName: WEB_RECORD_STORES.diaries },
  deardiary_entries: { kind: 'array', storeName: WEB_RECORD_STORES.entries },
  deardiary_notes: { kind: 'array', storeName: WEB_RECORD_STORES.notes },
  deardiary_settings: { kind: 'single', storeName: WEB_RECORD_STORES.metadata, recordKey: 'settings' },
  deardiary_userprofile: { kind: 'single', storeName: WEB_RECORD_STORES.metadata, recordKey: 'profile' },
  deardiary_security: { kind: 'single', storeName: WEB_RECORD_STORES.metadata, recordKey: 'security' },
  deardiary_drive_backup: { kind: 'single', storeName: WEB_RECORD_STORES.metadata, recordKey: 'drive_backup' },
  deardiary_sync_account: { kind: 'single', storeName: WEB_RECORD_STORES.metadata, recordKey: 'sync_account' },
  deardiary_sync_record_versions: { kind: 'map', storeName: WEB_RECORD_STORES.versions },
  deardiary_sync_media_pointers: { kind: 'map', storeName: WEB_RECORD_STORES.mediaPointers },
  deardiary_sync_partition_hydration: { kind: 'map', storeName: WEB_RECORD_STORES.partitions },
  deardiary_sync_outbox: { kind: 'map', storeName: WEB_RECORD_STORES.outbox },
  deardiary_sync_outbox_v2: { kind: 'map', storeName: WEB_RECORD_STORES.outboxV2 },
};

const metadataKeyForCollection = (key: string): string => `structured:${key}`;

const parseJson = <T>(value: string): T => JSON.parse(value) as T;

const requireRecordId = (key: string, value: unknown): string => {
  const id = (value as { id?: unknown })?.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`Structured browser storage record for ${key} is missing an id.`);
  }
  return id;
};

const getLegacyLocalStorageItem = (key: string): string | null => (
  typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null
);

const removeLegacyLocalStorageItem = (key: string): void => {
  if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
};

const queryTokenParts = (value?: string): string[] => (
  (value || '').toLowerCase().match(/[a-z0-9]+/g) || []
);

const indexedSearchTokens = (value: string): string[] => {
  const tokens = new Set<string>();
  queryTokenParts(value).forEach(token => {
    tokens.add(token);
    for (let length = 2; length <= Math.min(token.length, 20); length += 1) {
      tokens.add(token.slice(0, length));
    }
  });
  return [...tokens];
};

const entryQueryIndexRecord = async (entry: Entry): Promise<EntryQueryIndexRecord> => ({
  id: entry.id,
  diaryId: entry.diaryId,
  date: entry.date,
  updatedAt: entry.updatedAt || 0,
  createdAt: entry.createdAt || 0,
  moodToken: await queryIndexToken(entry.moodName || ''),
  hasPhotos: entry.photoCount > 0 ? 1 : 0,
  tagTokens: await queryIndexTokens(entry.tags || []),
  searchTokens: await queryIndexTokens(indexedSearchTokens([
    entry.title,
    richTextHtmlToPlainText(entry.body),
    entry.moodName,
    ...(entry.tags || []),
  ].join(' '))),
});

const noteQueryIndexRecord = async (note: Note): Promise<NoteQueryIndexRecord> => ({
  id: note.id,
  updatedAt: note.updatedAt || 0,
  updatedDate: new Date(note.updatedAt || 0).toISOString().slice(0, 10),
  createdAt: note.createdAt || 0,
  isPinned: note.isPinned ? 1 : 0,
  tagTokens: await queryIndexTokens(note.tags || []),
  searchTokens: await queryIndexTokens(indexedSearchTokens([
    note.title,
    richTextHtmlToPlainText(note.body),
    ...(note.tags || []),
  ].join(' '))),
});

const entryProjection = (entry: Entry): LocalEntryProjection => ({
  id: entry.id,
  diaryId: entry.diaryId,
  date: entry.date,
  time: entry.time,
  title: entry.title,
  moodName: entry.moodName,
  moodEmoji: entry.moodEmoji,
  tags: [...(entry.tags || [])],
  photoUris: [...(entry.photoUris || [])],
  photoCount: entry.photoCount || 0,
  wordCount: entry.wordCount || 0,
  createdAt: entry.createdAt,
  updatedAt: entry.updatedAt,
});

const noteProjection = (note: Note): LocalNoteProjection => ({
  id: note.id,
  title: note.title,
  isPinned: note.isPinned,
  tags: [...(note.tags || [])],
  createdAt: note.createdAt,
  updatedAt: note.updatedAt,
});

const entryIndexAsEntry = (record: EntryQueryIndexRecord): Entry => ({
  id: record.id,
  diaryId: record.diaryId,
  date: record.date,
  title: '',
  body: '',
  moodName: '',
  moodEmoji: '',
  tags: [],
  photoUris: [],
  photoCount: record.hasPhotos,
  wordCount: 0,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

const noteIndexAsNote = (record: NoteQueryIndexRecord): Note => ({
  id: record.id,
  title: '',
  body: '',
  isPinned: record.isPinned === 1,
  tags: [],
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

export class WebLocalDataStore implements LocalDataStore {
  private readonly encryptedStore = new WebEncryptedKeyValueStore(REPOSITORY_STORE);
  private readonly metadataStore = new WebEncryptedKeyValueStore(WEB_RECORD_STORES.metadata);

  private get useTestFallback(): boolean {
    return typeof indexedDB === 'undefined' && typeof window === 'undefined';
  }

  private requireEncryptedBrowserStorage(): void {
    if (typeof indexedDB === 'undefined' && !this.useTestFallback) {
      throw new Error('This browser cannot provide encrypted local diary storage.');
    }
  }

  async getItem(key: string): Promise<string | null> {
    this.requireEncryptedBrowserStorage();
    if (this.useTestFallback) return localStorage.getItem(key);
    const structured = await this.getStructuredItem(key);
    if (structured !== null) return structured;
    const encrypted = await this.encryptedStore.getItem(key);
    if (encrypted !== null) return encrypted;
    const legacy = getLegacyLocalStorageItem(key);
    if (legacy !== null) {
      await this.encryptedStore.setItem(key, legacy);
      removeLegacyLocalStorageItem(key);
    }
    return legacy;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.requireEncryptedBrowserStorage();
    if (this.useTestFallback) { localStorage.setItem(key, value); return; }
    await commitEncryptedStoreBatch(await this.createStructuredBatch({ [key]: value }));
    removeLegacyLocalStorageItem(key);
  }

  async setItems(items: Record<string, string>): Promise<void> {
    this.requireEncryptedBrowserStorage();
    if (this.useTestFallback) {
      Object.entries(items).forEach(([key, value]) => localStorage.setItem(key, value));
      return;
    }
    await commitEncryptedStoreBatch(await this.createStructuredBatch(items));
    Object.keys(items).forEach(removeLegacyLocalStorageItem);
  }

  async removeItem(key: string): Promise<void> {
    this.requireEncryptedBrowserStorage();
    if (this.useTestFallback) { localStorage.removeItem(key); return; }
    await commitEncryptedStoreBatch(this.createStructuredRemoveBatch(key));
    removeLegacyLocalStorageItem(key);
  }

  async clear(): Promise<void> {
    this.requireEncryptedBrowserStorage();
    if (this.useTestFallback) { localStorage.clear(); return; }
    await commitEncryptedStoreBatch({
      clears: [
        REPOSITORY_STORE,
        ...Object.values(WEB_RECORD_STORES),
        ...Object.values(WEB_QUERY_INDEX_STORES),
      ],
    });
  }

  async getStructuredCollection<T>(key: string): Promise<T[] | undefined> {
    this.requireEncryptedBrowserStorage();
    if (this.useTestFallback) return undefined;
    const records = await this.readStructuredCollection<T>(key);
    return records ?? undefined;
  }

  async getStructuredRecord<T>(key: string, id: string): Promise<T | null | undefined> {
    this.requireEncryptedBrowserStorage();
    if (this.useTestFallback) return undefined;
    const spec = STRUCTURED_COLLECTIONS[key];
    if (!spec || spec.kind !== 'array') return undefined;
    const metadata = await this.getStructuredMetadata(key, spec);
    if (!metadata) return undefined;
    const raw = await new WebEncryptedKeyValueStore(spec.storeName).getItem(id);
    return raw === null ? null : parseJson<T>(raw);
  }

  async putStructuredRecord<T>(key: string, id: string, value: T): Promise<void> {
    this.requireEncryptedBrowserStorage();
    if (this.useTestFallback) return;
    await commitEncryptedStoreBatch(await this.createStructuredRecordMutationBatch([
      { key, id, value },
    ]));
    removeLegacyLocalStorageItem(key);
  }

  async deleteStructuredRecord(key: string, id: string): Promise<void> {
    this.requireEncryptedBrowserStorage();
    if (this.useTestFallback) return;
    await commitEncryptedStoreBatch(await this.createStructuredRecordMutationBatch([
      { key, id, value: null },
    ]));
    removeLegacyLocalStorageItem(key);
  }

  async commitStructuredRecords(input: {
    records: LocalStructuredRecordMutation[];
    items?: Record<string, string>;
  }): Promise<void> {
    this.requireEncryptedBrowserStorage();
    if (this.useTestFallback) {
      if (input.items) Object.entries(input.items).forEach(([key, value]) => localStorage.setItem(key, value));
      return;
    }
    const batch = await this.createStructuredRecordMutationBatch(input.records);
    if (input.items) this.mergeEncryptedBatch(batch, await this.createStructuredBatch(input.items));
    await commitEncryptedStoreBatch(batch);
    input.records.forEach(record => removeLegacyLocalStorageItem(record.key));
    Object.keys(input.items || {}).forEach(removeLegacyLocalStorageItem);
  }

  async commitLocalMutationAndOutbox(input: {
    records: LocalStructuredRecordMutation[];
    items?: Record<string, string>;
    outboxOperation: import('../../types').SyncOutboxOperation;
    outboxV2Operation: import('../../sync/outbox/SyncOutboxOperationV2').SyncOutboxOperationV2;
  }): Promise<void> {
    this.requireEncryptedBrowserStorage();
    if (this.useTestFallback) {
      if (input.items) Object.entries(input.items).forEach(([key, value]) => localStorage.setItem(key, value));
      return;
    }
    const batch = await this.createStructuredRecordMutationBatch(input.records);
    if (input.items) this.mergeEncryptedBatch(batch, await this.createStructuredBatch(input.items));
    this.appendStructuredMapPut(
      batch,
      'deardiary_sync_outbox',
      input.outboxOperation.operationId,
      input.outboxOperation,
    );
    this.appendStructuredMapPut(
      batch,
      'deardiary_sync_outbox_v2',
      input.outboxV2Operation.operationId,
      input.outboxV2Operation,
    );
    await commitEncryptedStoreBatch(batch);
    input.records.forEach(record => removeLegacyLocalStorageItem(record.key));
    Object.keys(input.items || {}).forEach(removeLegacyLocalStorageItem);
    removeLegacyLocalStorageItem('deardiary_sync_outbox');
    removeLegacyLocalStorageItem('deardiary_sync_outbox_v2');
  }

  async queryEntries(options: LocalEntryQueryOptions): Promise<LocalQueryPageResult<Entry> | undefined> {
    this.requireEncryptedBrowserStorage();
    if (this.useTestFallback) return undefined;
    const indexedPage = await this.queryEntriesFromIndex(options);
    if (indexedPage) return indexedPage;

    const entries = await this.readStructuredCollection<Entry>('deardiary_entries');
    if (entries === null) return undefined;

    const allowed = options.allowedDiaryIds ? new Set(options.allowedDiaryIds) : null;
    const excluded = options.excludeDiaryIds ? new Set(options.excludeDiaryIds) : null;
    const query = options.query?.trim().toLowerCase();
    const tags = options.tags?.map(tag => tag.toLowerCase()) || [];
    const filtered = entries
      .filter(entry => !options.diaryId || entry.diaryId === options.diaryId)
      .filter(entry => !options.yearMonth || entry.date.startsWith(options.yearMonth))
      .filter(entry => !options.fromDate || entry.date >= options.fromDate)
      .filter(entry => !options.toDate || entry.date <= options.toDate)
      .filter(entry => !options.mood || entry.moodName === options.mood)
      .filter(entry => options.hasPhotos === undefined || (entry.photoCount > 0) === options.hasPhotos)
      .filter(entry => tags.length === 0 || tags.every(tag => entry.tags.some(entryTag => entryTag.toLowerCase() === tag)))
      .filter(entry => !query || (
        entry.title.toLowerCase().includes(query) ||
        richTextHtmlToPlainText(entry.body).toLowerCase().includes(query) ||
        entry.tags.some(tag => tag.toLowerCase().includes(query)) ||
        entry.moodName.toLowerCase().includes(query)
      ))
      .filter(entry => (!allowed || allowed.has(entry.diaryId)) && (!excluded || !excluded.has(entry.diaryId)));
    return pageEntries(filtered, options, options.sort || 'date-desc');
  }

  async queryNotes(options: LocalNoteQueryOptions): Promise<LocalQueryPageResult<Note> | undefined> {
    this.requireEncryptedBrowserStorage();
    if (this.useTestFallback) return undefined;
    const indexedPage = await this.queryNotesFromIndex(options);
    if (indexedPage) return indexedPage;

    const notes = await this.readStructuredCollection<Note>('deardiary_notes');
    if (notes === null) return undefined;

    const query = options.query?.trim().toLowerCase();
    const tags = options.tags?.map(tag => tag.toLowerCase()) || [];
    const filtered = notes
      .filter(note => {
        if (options.filter === 'pinned') return note.isPinned;
        if (options.filter === 'tagged') return note.tags.length > 0;
        if (options.filter === 'untagged') return note.tags.length === 0;
        return true;
      })
      .filter(note => {
        const date = new Date(note.updatedAt).toISOString().slice(0, 10);
        return (!options.fromDate || date >= options.fromDate) && (!options.toDate || date <= options.toDate);
      })
      .filter(note => tags.length === 0 || tags.every(tag => note.tags.some(noteTag => noteTag.toLowerCase() === tag)))
      .filter(note => !query || (
        note.title.toLowerCase().includes(query) ||
        richTextHtmlToPlainText(note.body).toLowerCase().includes(query) ||
        note.tags.some(tag => tag.toLowerCase().includes(query))
      ));
    return pageNotes(filtered, options, options.sort || 'pinned-updated-desc');
  }

  async queryEntryProjections(
    options: LocalEntryQueryOptions,
  ): Promise<LocalQueryPageResult<LocalEntryProjection> | undefined> {
    this.requireEncryptedBrowserStorage();
    if (this.useTestFallback || options.query) return undefined;
    if (!await this.ensureProjectionStore('deardiary_entries')) return undefined;
    const raw = await new WebEncryptedKeyValueStore(WEB_RECORD_STORES.entryProjections).getAllItems();
    const allowed = options.allowedDiaryIds ? new Set(options.allowedDiaryIds) : null;
    const excluded = options.excludeDiaryIds ? new Set(options.excludeDiaryIds) : null;
    const tags = (options.tags || []).map(tag => tag.toLowerCase());
    const entries = Object.values(raw)
      .map(value => parseJson<LocalEntryProjection>(value))
      .filter(entry => !options.diaryId || entry.diaryId === options.diaryId)
      .filter(entry => !options.yearMonth || entry.date.startsWith(options.yearMonth))
      .filter(entry => !options.fromDate || entry.date >= options.fromDate)
      .filter(entry => !options.toDate || entry.date <= options.toDate)
      .filter(entry => !options.mood || entry.moodName === options.mood)
      .filter(entry => options.hasPhotos === undefined || (entry.photoCount > 0) === options.hasPhotos)
      .filter(entry => (!allowed || allowed.has(entry.diaryId)) && (!excluded || !excluded.has(entry.diaryId)))
      .filter(entry => tags.length === 0 || tags.every(tag => entry.tags.some(entryTag => entryTag.toLowerCase() === tag)));
    return pageEntries(entries, options, options.sort || 'date-desc', 10_000);
  }

  async queryNoteProjections(
    options: LocalNoteQueryOptions,
  ): Promise<LocalQueryPageResult<LocalNoteProjection> | undefined> {
    this.requireEncryptedBrowserStorage();
    if (this.useTestFallback || options.query) return undefined;
    if (!await this.ensureProjectionStore('deardiary_notes')) return undefined;
    const raw = await new WebEncryptedKeyValueStore(WEB_RECORD_STORES.noteProjections).getAllItems();
    const tags = (options.tags || []).map(tag => tag.toLowerCase());
    const notes = Object.values(raw)
      .map(value => parseJson<LocalNoteProjection>(value))
      .filter(note => {
        if (options.filter === 'pinned') return note.isPinned;
        if (options.filter === 'tagged') return note.tags.length > 0;
        if (options.filter === 'untagged') return note.tags.length === 0;
        return true;
      })
      .filter(note => {
        const updatedDate = new Date(note.updatedAt).toISOString().slice(0, 10);
        return (!options.fromDate || updatedDate >= options.fromDate) && (!options.toDate || updatedDate <= options.toDate);
      })
      .filter(note => tags.length === 0 || tags.every(tag => note.tags.some(noteTag => noteTag.toLowerCase() === tag)));
    return pageNotes(notes, options, options.sort || 'pinned-updated-desc', 10_000);
  }

  private async queryEntriesFromIndex(options: LocalEntryQueryOptions): Promise<LocalQueryPageResult<Entry> | undefined> {
    if (!await this.ensureEntryQueryIndex()) return undefined;

    const indexRecords = await this.getEntryIndexCandidates(options);
    const queryTokens = await queryIndexTokens(queryTokenParts(options.query));
    const tagTokens = await queryIndexTokens(options.tags || []);
    const moodToken = options.mood ? await queryIndexToken(options.mood) : null;
    const allowed = options.allowedDiaryIds ? new Set(options.allowedDiaryIds) : null;
    const excluded = options.excludeDiaryIds ? new Set(options.excludeDiaryIds) : null;
    const filtered = indexRecords
      .filter(entry => !options.diaryId || entry.diaryId === options.diaryId)
      .filter(entry => !options.yearMonth || entry.date.startsWith(options.yearMonth))
      .filter(entry => !options.fromDate || entry.date >= options.fromDate)
      .filter(entry => !options.toDate || entry.date <= options.toDate)
      .filter(entry => !moodToken || entry.moodToken === moodToken)
      .filter(entry => options.hasPhotos === undefined || (entry.hasPhotos > 0) === options.hasPhotos)
      .filter(entry => (!allowed || allowed.has(entry.diaryId)) && (!excluded || !excluded.has(entry.diaryId)))
      .filter(entry => tagTokens.length === 0 || tagTokens.every(tag => entry.tagTokens.includes(tag)))
      .filter(entry => queryTokens.length === 0 || queryTokens.every(token => entry.searchTokens.includes(token)));

    if (queryTokens.length > 0) {
      const records = await this.readStructuredRecordsByIds<Entry>('deardiary_entries', filtered.map(entry => entry.id));
      const query = options.query?.trim().toLowerCase() || '';
      const exactMatches = records.filter(entry => (
        entry.title.toLowerCase().includes(query) ||
        richTextHtmlToPlainText(entry.body).toLowerCase().includes(query) ||
        entry.tags.some(tag => tag.toLowerCase().includes(query)) ||
        entry.moodName.toLowerCase().includes(query)
      ));
      return pageEntries(exactMatches, options, options.sort || 'updated-desc');
    }

    const page = pageEntries(filtered.map(entryIndexAsEntry), options, options.sort || 'date-desc');
    const pageRecords = await this.readStructuredRecordsByIds<Entry>('deardiary_entries', page.items.map(entry => entry.id));
    const recordsById = new Map(pageRecords.map(entry => [entry.id, entry]));
    return {
      items: page.items.map(entry => recordsById.get(entry.id)).filter((entry): entry is Entry => Boolean(entry)),
      nextCursor: page.nextCursor,
      total: filtered.length,
    };
  }

  private async queryNotesFromIndex(options: LocalNoteQueryOptions): Promise<LocalQueryPageResult<Note> | undefined> {
    if (!await this.ensureNoteQueryIndex()) return undefined;

    const indexRecords = await this.getNoteIndexCandidates(options);
    const queryTokens = await queryIndexTokens(queryTokenParts(options.query));
    const tagTokens = await queryIndexTokens(options.tags || []);
    const filtered = indexRecords
      .filter(note => {
        if (options.filter === 'pinned') return note.isPinned === 1;
        if (options.filter === 'tagged') return note.tagTokens.length > 0;
        if (options.filter === 'untagged') return note.tagTokens.length === 0;
        return true;
      })
      .filter(note => (!options.fromDate || note.updatedDate >= options.fromDate) && (!options.toDate || note.updatedDate <= options.toDate))
      .filter(note => tagTokens.length === 0 || tagTokens.every(tag => note.tagTokens.includes(tag)))
      .filter(note => queryTokens.length === 0 || queryTokens.every(token => note.searchTokens.includes(token)));

    if (queryTokens.length > 0) {
      const records = await this.readStructuredRecordsByIds<Note>('deardiary_notes', filtered.map(note => note.id));
      const query = options.query?.trim().toLowerCase() || '';
      const exactMatches = records.filter(note => (
        note.title.toLowerCase().includes(query) ||
        richTextHtmlToPlainText(note.body).toLowerCase().includes(query) ||
        note.tags.some(tag => tag.toLowerCase().includes(query))
      ));
      return pageNotes(exactMatches, options, options.sort || 'updated-desc');
    }

    const page = pageNotes(filtered.map(noteIndexAsNote), options, options.sort || 'pinned-updated-desc');
    const pageRecords = await this.readStructuredRecordsByIds<Note>('deardiary_notes', page.items.map(note => note.id));
    const recordsById = new Map(pageRecords.map(note => [note.id, note]));
    return {
      items: page.items.map(note => recordsById.get(note.id)).filter((note): note is Note => Boolean(note)),
      nextCursor: page.nextCursor,
      total: filtered.length,
    };
  }

  private async getEntryIndexCandidates(options: LocalEntryQueryOptions): Promise<EntryQueryIndexRecord[]> {
    const queryTokens = await queryIndexTokens(queryTokenParts(options.query));
    if (queryTokens[0]) {
      return getPlainIndexRecords<EntryQueryIndexRecord>(WEB_QUERY_INDEX_STORES.entries, 'searchTokens', queryTokens[0]);
    }
    if (options.diaryId) {
      return getPlainIndexRecords<EntryQueryIndexRecord>(WEB_QUERY_INDEX_STORES.entries, 'diaryId', options.diaryId);
    }
    if (options.yearMonth && typeof IDBKeyRange !== 'undefined') {
      return getPlainIndexRecords<EntryQueryIndexRecord>(
        WEB_QUERY_INDEX_STORES.entries,
        'date',
        IDBKeyRange.bound(options.yearMonth, `${options.yearMonth}\uffff`),
      );
    }
    if ((options.fromDate || options.toDate) && typeof IDBKeyRange !== 'undefined') {
      return getPlainIndexRecords<EntryQueryIndexRecord>(
        WEB_QUERY_INDEX_STORES.entries,
        'date',
        IDBKeyRange.bound(options.fromDate || '', options.toDate || '\uffff'),
      );
    }
    if (options.mood) {
      return getPlainIndexRecords<EntryQueryIndexRecord>(WEB_QUERY_INDEX_STORES.entries, 'moodToken', await queryIndexToken(options.mood));
    }
    if (options.hasPhotos !== undefined) {
      return getPlainIndexRecords<EntryQueryIndexRecord>(WEB_QUERY_INDEX_STORES.entries, 'hasPhotos', options.hasPhotos ? 1 : 0);
    }
    if (options.tags?.[0]) {
      return getPlainIndexRecords<EntryQueryIndexRecord>(
        WEB_QUERY_INDEX_STORES.entries,
        'tagTokens',
        await queryIndexToken(options.tags[0]),
      );
    }
    return getPlainIndexRecords<EntryQueryIndexRecord>(WEB_QUERY_INDEX_STORES.entries);
  }

  private async getNoteIndexCandidates(options: LocalNoteQueryOptions): Promise<NoteQueryIndexRecord[]> {
    const queryTokens = await queryIndexTokens(queryTokenParts(options.query));
    if (queryTokens[0]) {
      return getPlainIndexRecords<NoteQueryIndexRecord>(WEB_QUERY_INDEX_STORES.notes, 'searchTokens', queryTokens[0]);
    }
    if (options.filter === 'pinned') {
      return getPlainIndexRecords<NoteQueryIndexRecord>(WEB_QUERY_INDEX_STORES.notes, 'isPinned', 1);
    }
    if ((options.fromDate || options.toDate) && typeof IDBKeyRange !== 'undefined') {
      return getPlainIndexRecords<NoteQueryIndexRecord>(
        WEB_QUERY_INDEX_STORES.notes,
        'updatedDate',
        IDBKeyRange.bound(options.fromDate || '', options.toDate || '\uffff'),
      );
    }
    if (options.tags?.[0]) {
      return getPlainIndexRecords<NoteQueryIndexRecord>(
        WEB_QUERY_INDEX_STORES.notes,
        'tagTokens',
        await queryIndexToken(options.tags[0]),
      );
    }
    return getPlainIndexRecords<NoteQueryIndexRecord>(WEB_QUERY_INDEX_STORES.notes);
  }

  private async ensureEntryQueryIndex(): Promise<boolean> {
    const spec = STRUCTURED_COLLECTIONS.deardiary_entries;
    if (!await this.getStructuredMetadata('deardiary_entries', spec)) return false;
    const existing = await getPlainIndexRecords<EntryQueryIndexRecord>(WEB_QUERY_INDEX_STORES.entries);
    if (existing.length > 0) return true;
    const entries = await this.readStructuredCollection<Entry>('deardiary_entries');
    if (entries === null) return false;
    await commitEncryptedStoreBatch({
      plainClears: [WEB_QUERY_INDEX_STORES.entries],
      plainPuts: await Promise.all(entries.map(async entry => ({
        storeName: WEB_QUERY_INDEX_STORES.entries,
        value: await entryQueryIndexRecord(entry),
      }))),
    });
    return true;
  }

  private async ensureNoteQueryIndex(): Promise<boolean> {
    const spec = STRUCTURED_COLLECTIONS.deardiary_notes;
    if (!await this.getStructuredMetadata('deardiary_notes', spec)) return false;
    const existing = await getPlainIndexRecords<NoteQueryIndexRecord>(WEB_QUERY_INDEX_STORES.notes);
    if (existing.length > 0) return true;
    const notes = await this.readStructuredCollection<Note>('deardiary_notes');
    if (notes === null) return false;
    await commitEncryptedStoreBatch({
      plainClears: [WEB_QUERY_INDEX_STORES.notes],
      plainPuts: await Promise.all(notes.map(async note => ({
        storeName: WEB_QUERY_INDEX_STORES.notes,
        value: await noteQueryIndexRecord(note),
      }))),
    });
    return true;
  }

  private async readStructuredRecordsByIds<T extends { id: string }>(key: string, ids: string[]): Promise<T[]> {
    const records = await Promise.all(ids.map(id => this.getStructuredRecord<T>(key, id)));
    const found: T[] = [];
    records.forEach(record => {
      if (record) found.push(record as T);
    });
    return found;
  }

  private async getStructuredItem(key: string): Promise<string | null> {
    const spec = STRUCTURED_COLLECTIONS[key];
    if (!spec) return null;
    const metadata = await this.getStructuredMetadata(key, spec);
    if (!metadata) return null;

    const store = new WebEncryptedKeyValueStore(spec.storeName);
    if (spec.kind === 'single') {
      return store.getItem(spec.recordKey);
    }

    const rawRecords = await store.getAllItems();
    if (spec.kind === 'map') {
      return JSON.stringify(Object.fromEntries(
        Object.entries(rawRecords).map(([recordKey, value]) => [recordKey, parseJson<unknown>(value)]),
      ));
    }

    return JSON.stringify(this.orderStructuredRecords<unknown>(rawRecords, metadata));
  }

  private async readStructuredCollection<T>(key: string): Promise<T[] | null> {
    const spec = STRUCTURED_COLLECTIONS[key];
    if (!spec || spec.kind !== 'array') return null;
    const metadata = await this.getStructuredMetadata(key, spec);
    if (!metadata) return null;
    const rawRecords = await new WebEncryptedKeyValueStore(spec.storeName).getAllItems();
    return this.orderStructuredRecords<T>(rawRecords, metadata);
  }

  private async getStructuredMetadata(
    key: string,
    spec: StructuredStorageSpec,
  ): Promise<StructuredCollectionMetadata | null> {
    const metadataRaw = await this.metadataStore.getItem(metadataKeyForCollection(key));
    if (!metadataRaw) return null;
    const metadata = parseJson<StructuredCollectionMetadata>(metadataRaw);
    if (!metadata.ready || metadata.kind !== spec.kind) return null;
    return metadata;
  }

  private orderStructuredRecords<T>(
    rawRecords: Record<string, string>,
    metadata: StructuredCollectionMetadata,
  ): T[] {
    const orderedKeys = metadata.order || [];
    const seen = new Set<string>();
    const ordered = orderedKeys
      .map(recordKey => {
        seen.add(recordKey);
        return rawRecords[recordKey] ? parseJson<T>(rawRecords[recordKey]) : null;
      })
      .filter((record): record is T => record !== null);
    const extras = Object.entries(rawRecords)
      .filter(([recordKey]) => !seen.has(recordKey))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, value]) => parseJson<T>(value));
    return [...ordered, ...extras];
  }

  private async createStructuredBatch(items: Record<string, string>): Promise<EncryptedStoreBatch> {
    const batch: EncryptedStoreBatch = {
      puts: Object.entries(items).map(([key, value]) => ({ storeName: REPOSITORY_STORE, key, value })),
      clears: [],
    };

    for (const [key, value] of Object.entries(items)) {
      const spec = STRUCTURED_COLLECTIONS[key];
      if (!spec) continue;
      const metadataKey = metadataKeyForCollection(key);
      const metadataBase = { ready: true, kind: spec.kind, updatedAt: Date.now() };

      if (spec.kind === 'single') {
        batch.puts!.push({ storeName: spec.storeName, key: spec.recordKey, value });
        batch.puts!.push({
          storeName: WEB_RECORD_STORES.metadata,
          key: metadataKey,
          value: JSON.stringify(metadataBase),
        });
        continue;
      }

      batch.clears!.push(spec.storeName);
      if (spec.kind === 'array') {
        const records = parseJson<unknown[]>(value);
        const indexStoreName = this.indexStoreNameForCollection(key);
        const projectionStoreName = this.projectionStoreNameForCollection(key);
        if (indexStoreName) batch.plainClears = [...(batch.plainClears || []), indexStoreName];
        if (projectionStoreName) batch.clears!.push(projectionStoreName);
        const order: string[] = [];
        for (const record of records) {
          const recordKey = requireRecordId(key, record);
          batch.puts!.push({ storeName: spec.storeName, key: recordKey, value: JSON.stringify(record) });
          await this.appendQueryIndexPut(batch, key, record);
          this.appendProjectionPut(batch, key, record);
          order.push(recordKey);
        }
        batch.puts!.push({
          storeName: WEB_RECORD_STORES.metadata,
          key: metadataKey,
          value: JSON.stringify({ ...metadataBase, order }),
        });
        if (projectionStoreName) batch.puts!.push({
          storeName: WEB_RECORD_STORES.metadata,
          key: this.projectionMetadataKey(key),
          value: JSON.stringify({ ready: true, updatedAt: Date.now() }),
        });
        continue;
      }

      const records = parseJson<Record<string, unknown>>(value);
      Object.entries(records).forEach(([recordKey, record]) => {
        batch.puts!.push({ storeName: spec.storeName, key: recordKey, value: JSON.stringify(record) });
      });
      batch.puts!.push({
        storeName: WEB_RECORD_STORES.metadata,
        key: metadataKey,
        value: JSON.stringify(metadataBase),
      });
    }

    if (batch.clears?.length) batch.clears = [...new Set(batch.clears)];
    return batch;
  }

  private createStructuredRemoveBatch(key: string): EncryptedStoreBatch {
    const spec = STRUCTURED_COLLECTIONS[key];
    const batch: EncryptedStoreBatch = {
      deletes: [{ storeName: REPOSITORY_STORE, key }],
    };
    if (!spec) return batch;

    const metadataKey = metadataKeyForCollection(key);
    batch.deletes!.push({ storeName: WEB_RECORD_STORES.metadata, key: metadataKey });
    if (spec.kind === 'single') {
      batch.deletes!.push({ storeName: spec.storeName, key: spec.recordKey });
    } else {
      batch.clears = [spec.storeName];
      const indexStoreName = this.indexStoreNameForCollection(key);
      if (indexStoreName) batch.plainClears = [indexStoreName];
      const projectionStoreName = this.projectionStoreNameForCollection(key);
      if (projectionStoreName) {
        batch.clears.push(projectionStoreName);
        batch.deletes!.push({ storeName: WEB_RECORD_STORES.metadata, key: this.projectionMetadataKey(key) });
      }
    }
    return batch;
  }

  private async createStructuredRecordMutationBatch(
    records: LocalStructuredRecordMutation[],
  ): Promise<EncryptedStoreBatch> {
    const batch: EncryptedStoreBatch = { puts: [], deletes: [] };
    const ordersByKey = new Map<string, string[]>();
    for (const record of records) {
      const spec = STRUCTURED_COLLECTIONS[record.key];
      if (!spec || spec.kind !== 'array') continue;
      await this.ensureProjectionStore(record.key);
      if (!ordersByKey.has(record.key)) {
        const store = new WebEncryptedKeyValueStore(spec.storeName);
        const metadata = await this.getStructuredMetadata(record.key, spec);
        const existingRawRecords = metadata?.order ? null : await store.getAllItems();
        ordersByKey.set(
          record.key,
          metadata?.order || Object.keys(existingRawRecords || {}).sort((left, right) => left.localeCompare(right)),
        );
      }
      const currentOrder = ordersByKey.get(record.key)!;
      const order = record.value === null
        ? currentOrder.filter(recordKey => recordKey !== record.id)
        : currentOrder.includes(record.id)
          ? currentOrder
          : [...currentOrder, record.id];
      ordersByKey.set(record.key, order);

      batch.deletes!.push({ storeName: REPOSITORY_STORE, key: record.key });
      if (record.value === null) {
        batch.deletes!.push({ storeName: spec.storeName, key: record.id });
        this.appendQueryIndexDelete(batch, record.key, record.id);
        this.appendProjectionDelete(batch, record.key, record.id);
      } else {
        batch.puts!.push({ storeName: spec.storeName, key: record.id, value: JSON.stringify(record.value) });
        await this.appendQueryIndexPut(batch, record.key, record.value);
        this.appendProjectionPut(batch, record.key, record.value);
      }
      batch.puts!.push({
        storeName: WEB_RECORD_STORES.metadata,
        key: metadataKeyForCollection(record.key),
        value: JSON.stringify({ ready: true, kind: spec.kind, order, updatedAt: Date.now() }),
      });
    }
    return batch;
  }

  private indexStoreNameForCollection(key: string): string | null {
    if (key === 'deardiary_entries') return WEB_QUERY_INDEX_STORES.entries;
    if (key === 'deardiary_notes') return WEB_QUERY_INDEX_STORES.notes;
    return null;
  }

  private projectionStoreNameForCollection(key: string): string | null {
    if (key === 'deardiary_entries') return WEB_RECORD_STORES.entryProjections;
    if (key === 'deardiary_notes') return WEB_RECORD_STORES.noteProjections;
    return null;
  }

  private projectionMetadataKey(key: string): string {
    return `projection:${key}:v1`;
  }

  private appendProjectionPut(batch: EncryptedStoreBatch, key: string, value: unknown): void {
    const storeName = this.projectionStoreNameForCollection(key);
    if (!storeName) return;
    const projection = key === 'deardiary_entries'
      ? entryProjection(value as Entry)
      : noteProjection(value as Note);
    batch.puts ||= [];
    batch.puts.push({ storeName, key: projection.id, value: JSON.stringify(projection) });
    batch.puts.push({
      storeName: WEB_RECORD_STORES.metadata,
      key: this.projectionMetadataKey(key),
      value: JSON.stringify({ ready: true, updatedAt: Date.now() }),
    });
  }

  private appendProjectionDelete(batch: EncryptedStoreBatch, key: string, id: string): void {
    const storeName = this.projectionStoreNameForCollection(key);
    if (!storeName) return;
    batch.deletes ||= [];
    batch.deletes.push({ storeName, key: id });
  }

  private async ensureProjectionStore(key: string): Promise<boolean> {
    const storeName = this.projectionStoreNameForCollection(key);
    if (!storeName) return false;
    if (await this.metadataStore.getItem(this.projectionMetadataKey(key))) return true;
    const source = key === 'deardiary_entries'
      ? await this.readStructuredCollection<Entry>(key)
      : await this.readStructuredCollection<Note>(key);
    if (source === null) return false;
    const batch: EncryptedStoreBatch = { clears: [storeName], puts: [] };
    source.forEach(value => this.appendProjectionPut(batch, key, value));
    await commitEncryptedStoreBatch(batch);
    return true;
  }

  private async appendQueryIndexPut(batch: EncryptedStoreBatch, key: string, value: unknown): Promise<void> {
    const indexStoreName = this.indexStoreNameForCollection(key);
    if (!indexStoreName) return;
    batch.plainPuts ||= [];
    batch.plainPuts.push({
      storeName: indexStoreName,
      value: key === 'deardiary_entries'
        ? await entryQueryIndexRecord(value as Entry)
        : await noteQueryIndexRecord(value as Note),
    });
  }

  private appendQueryIndexDelete(batch: EncryptedStoreBatch, key: string, id: string): void {
    const indexStoreName = this.indexStoreNameForCollection(key);
    if (!indexStoreName) return;
    batch.plainDeletes ||= [];
    batch.plainDeletes.push({ storeName: indexStoreName, key: id });
  }

  private appendStructuredMapPut<T>(
    batch: EncryptedStoreBatch,
    key: string,
    recordKey: string,
    value: T,
  ): void {
    const spec = STRUCTURED_COLLECTIONS[key];
    if (!spec || spec.kind !== 'map') return;
    batch.puts ||= [];
    batch.deletes ||= [];
    batch.deletes.push({ storeName: REPOSITORY_STORE, key });
    batch.puts.push({ storeName: spec.storeName, key: recordKey, value: JSON.stringify(value) });
    batch.puts.push({
      storeName: WEB_RECORD_STORES.metadata,
      key: metadataKeyForCollection(key),
      value: JSON.stringify({ ready: true, kind: spec.kind, updatedAt: Date.now() }),
    });
  }

  private mergeEncryptedBatch(target: EncryptedStoreBatch, source: EncryptedStoreBatch): void {
    if (source.puts?.length) target.puts = [...(target.puts || []), ...source.puts];
    if (source.deletes?.length) target.deletes = [...(target.deletes || []), ...source.deletes];
    if (source.clears?.length) target.clears = [...new Set([...(target.clears || []), ...source.clears])];
    if (source.plainPuts?.length) target.plainPuts = [...(target.plainPuts || []), ...source.plainPuts];
    if (source.plainDeletes?.length) target.plainDeletes = [...(target.plainDeletes || []), ...source.plainDeletes];
    if (source.plainClears?.length) target.plainClears = [...new Set([...(target.plainClears || []), ...source.plainClears])];
  }
}
