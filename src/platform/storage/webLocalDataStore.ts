import type { Entry, Note } from '../../types';
import type {
  LocalDataStore,
  LocalEntryQueryOptions,
  LocalNoteQueryOptions,
  LocalQueryPageOptions,
  LocalQueryPageResult,
} from './LocalDataStore';
import {
  commitEncryptedStoreBatch,
  REPOSITORY_STORE,
  WEB_RECORD_STORES,
  WebEncryptedKeyValueStore,
  type EncryptedStoreBatch,
} from './webEncryptedKeyValueStore';

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
};

const metadataKeyForCollection = (key: string): string => `structured:${key}`;

const parseJson = <T>(value: string): T => JSON.parse(value) as T;

const getPageBounds = (options: LocalQueryPageOptions): { limit: number; offset: number } => {
  const limit = Math.max(1, Math.min(options.limit || 50, 200));
  const offset = Math.max(0, options.cursor ? Number(options.cursor) || 0 : options.offset || 0);
  return { limit, offset };
};

const pageRecords = <T>(items: T[], options: LocalQueryPageOptions): LocalQueryPageResult<T> => {
  const { limit, offset } = getPageBounds(options);
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    items: page,
    nextCursor: nextOffset < items.length ? String(nextOffset) : undefined,
    total: items.length,
  };
};

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
    await commitEncryptedStoreBatch(this.createStructuredBatch({ [key]: value }));
    removeLegacyLocalStorageItem(key);
  }

  async setItems(items: Record<string, string>): Promise<void> {
    this.requireEncryptedBrowserStorage();
    if (this.useTestFallback) {
      Object.entries(items).forEach(([key, value]) => localStorage.setItem(key, value));
      return;
    }
    await commitEncryptedStoreBatch(this.createStructuredBatch(items));
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

  async queryEntries(options: LocalEntryQueryOptions): Promise<LocalQueryPageResult<Entry> | undefined> {
    this.requireEncryptedBrowserStorage();
    if (this.useTestFallback) return undefined;
    const entries = await this.readStructuredCollection<Entry>('deardiary_entries');
    if (entries === null) return undefined;

    const allowed = options.allowedDiaryIds ? new Set(options.allowedDiaryIds) : null;
    const excluded = options.excludeDiaryIds ? new Set(options.excludeDiaryIds) : null;
    const filtered = entries
      .filter(entry => !options.diaryId || entry.diaryId === options.diaryId)
      .filter(entry => !options.yearMonth || entry.date.startsWith(options.yearMonth))
      .filter(entry => !options.fromDate || entry.date >= options.fromDate)
      .filter(entry => !options.toDate || entry.date <= options.toDate)
      .filter(entry => !options.mood || entry.moodName === options.mood)
      .filter(entry => options.hasPhotos === undefined || (entry.photoCount > 0) === options.hasPhotos)
      .filter(entry => (!allowed || allowed.has(entry.diaryId)) && (!excluded || !excluded.has(entry.diaryId)));
    return pageRecords(this.sortEntries(filtered, options.sort), options);
  }

  async queryNotes(options: LocalNoteQueryOptions): Promise<LocalQueryPageResult<Note> | undefined> {
    this.requireEncryptedBrowserStorage();
    if (this.useTestFallback) return undefined;
    const notes = await this.readStructuredCollection<Note>('deardiary_notes');
    if (notes === null) return undefined;

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
      });
    return pageRecords(this.sortNotes(filtered, options.sort), options);
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

  private sortEntries(entries: Entry[], sort: LocalEntryQueryOptions['sort'] = 'date-desc'): Entry[] {
    const sorted = [...entries];
    if (sort === 'date-asc') return sorted.sort((left, right) => left.date.localeCompare(right.date) || left.createdAt - right.createdAt);
    if (sort === 'updated-desc') return sorted.sort((left, right) => right.updatedAt - left.updatedAt);
    if (sort === 'created-desc') return sorted.sort((left, right) => right.createdAt - left.createdAt);
    return sorted.sort((left, right) => right.date.localeCompare(left.date) || right.updatedAt - left.updatedAt);
  }

  private sortNotes(notes: Note[], sort: LocalNoteQueryOptions['sort'] = 'pinned-updated-desc'): Note[] {
    const sorted = [...notes];
    if (sort === 'updated-desc') return sorted.sort((left, right) => right.updatedAt - left.updatedAt);
    return sorted.sort((left, right) => {
      if (left.isPinned && !right.isPinned) return -1;
      if (!left.isPinned && right.isPinned) return 1;
      return right.updatedAt - left.updatedAt;
    });
  }

  private createStructuredBatch(items: Record<string, string>): EncryptedStoreBatch {
    const batch: EncryptedStoreBatch = {
      puts: Object.entries(items).map(([key, value]) => ({ storeName: REPOSITORY_STORE, key, value })),
      clears: [],
    };

    Object.entries(items).forEach(([key, value]) => {
      const spec = STRUCTURED_COLLECTIONS[key];
      if (!spec) return;
      const metadataKey = metadataKeyForCollection(key);
      const metadataBase = { ready: true, kind: spec.kind, updatedAt: Date.now() };

      if (spec.kind === 'single') {
        batch.puts!.push({ storeName: spec.storeName, key: spec.recordKey, value });
        batch.puts!.push({
          storeName: WEB_RECORD_STORES.metadata,
          key: metadataKey,
          value: JSON.stringify(metadataBase),
        });
        return;
      }

      batch.clears!.push(spec.storeName);
      if (spec.kind === 'array') {
        const records = parseJson<unknown[]>(value);
        const order = records.map(record => {
          const recordKey = requireRecordId(key, record);
          batch.puts!.push({ storeName: spec.storeName, key: recordKey, value: JSON.stringify(record) });
          return recordKey;
        });
        batch.puts!.push({
          storeName: WEB_RECORD_STORES.metadata,
          key: metadataKey,
          value: JSON.stringify({ ...metadataBase, order }),
        });
        return;
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
    });

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
    }
    return batch;
  }
}
