const DATABASE_NAME = 'dear_diary_secure_v1';
const DATABASE_VERSION = 11;
const KEY_STORE = 'keys';
const WRAPPING_KEY_ID = 'root';
const QUERY_INDEX_KEY_ID = 'query_index_hmac';
export const SYNC_SECRET_STORE = 'values';
export const REPOSITORY_STORE = 'repository';
export const WEB_RECORD_STORES = {
  diaries: 'repository_diaries',
  entries: 'repository_entries',
  notes: 'repository_notes',
  entryProjections: 'repository_entry_projections',
  noteProjections: 'repository_note_projections',
  metadata: 'repository_metadata',
  operations: 'repository_sync_operations',
  versions: 'repository_versions',
  canonicalRecords: 'repository_sync_canonical_records',
  baseVersions: 'repository_sync_base_versions',
  mediaPointers: 'repository_media_pointers',
  baseMedia: 'repository_sync_base_media',
  partitions: 'repository_partitions',
  snapshotStage: 'repository_snapshot_restore_stage',
} as const;
export const WEB_QUERY_INDEX_STORES = {
  entries: 'repository_entry_index',
  notes: 'repository_note_index',
} as const;

interface EncryptedValue {
  nonce: number[];
  ciphertext: number[];
}

export interface EncryptedStoreBatch {
  puts?: Array<{ storeName: string; key: string; value: string }>;
  deletes?: Array<{ storeName: string; key: string }>;
  clears?: string[];
  plainPuts?: Array<{ storeName: string; value: unknown; key?: IDBValidKey }>;
  plainDeletes?: Array<{ storeName: string; key: IDBValidKey }>;
  plainClears?: string[];
}

const ensureIndex = (
  store: IDBObjectStore,
  name: string,
  keyPath: string | string[],
  options?: IDBIndexParameters,
): void => {
  if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, options);
};

const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error('Encrypted browser storage request failed.'));
  });

const transactionDone = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error || new Error('Encrypted browser storage transaction aborted.'));
    transaction.onerror = () =>
      reject(transaction.error || new Error('Encrypted browser storage transaction failed.'));
  });

let databasePromise: Promise<IDBDatabase> | null = null;
let wrappingKeyPromise: Promise<CryptoKey> | null = null;
let queryIndexKeyPromise: Promise<CryptoKey> | null = null;

const openDatabase = (): Promise<IDBDatabase> => {
  if (!databasePromise) {
    const pending = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      let settled = false;
      const timeout = setTimeout(() => {
        settled = true;
        reject(new Error('Encrypted browser storage took too long to open. Close older tabs and try again.'));
      }, 15_000);
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };
      request.onupgradeneeded = (event) => {
        const oldVersion = event.oldVersion;
        [KEY_STORE, SYNC_SECRET_STORE, REPOSITORY_STORE].forEach((store) => {
          if (!request.result.objectStoreNames.contains(store))
            request.result.createObjectStore(store);
        });
        Object.values(WEB_RECORD_STORES).forEach((store) => {
          if (!request.result.objectStoreNames.contains(store))
            request.result.createObjectStore(store);
        });
        const entryIndexStore = request.result.objectStoreNames.contains(
          WEB_QUERY_INDEX_STORES.entries,
        )
          ? request.transaction!.objectStore(WEB_QUERY_INDEX_STORES.entries)
          : request.result.createObjectStore(WEB_QUERY_INDEX_STORES.entries, { keyPath: 'id' });
        if (oldVersion < 5) entryIndexStore.clear();
        ensureIndex(entryIndexStore, 'diaryId', 'diaryId');
        ensureIndex(entryIndexStore, 'date', 'date');
        ensureIndex(entryIndexStore, 'updatedAt', 'updatedAt');
        ensureIndex(entryIndexStore, 'createdAt', 'createdAt');
        if (entryIndexStore.indexNames.contains('moodName'))
          entryIndexStore.deleteIndex('moodName');
        if (entryIndexStore.indexNames.contains('tags')) entryIndexStore.deleteIndex('tags');
        ensureIndex(entryIndexStore, 'moodToken', 'moodToken');
        ensureIndex(entryIndexStore, 'hasPhotos', 'hasPhotos');
        ensureIndex(entryIndexStore, 'tagTokens', 'tagTokens', { multiEntry: true });
        ensureIndex(entryIndexStore, 'searchTokens', 'searchTokens', { multiEntry: true });

        const noteIndexStore = request.result.objectStoreNames.contains(
          WEB_QUERY_INDEX_STORES.notes,
        )
          ? request.transaction!.objectStore(WEB_QUERY_INDEX_STORES.notes)
          : request.result.createObjectStore(WEB_QUERY_INDEX_STORES.notes, { keyPath: 'id' });
        if (oldVersion < 5) noteIndexStore.clear();
        ensureIndex(noteIndexStore, 'updatedAt', 'updatedAt');
        ensureIndex(noteIndexStore, 'updatedDate', 'updatedDate');
        ensureIndex(noteIndexStore, 'createdAt', 'createdAt');
        ensureIndex(noteIndexStore, 'isPinned', 'isPinned');
        if (noteIndexStore.indexNames.contains('tags')) noteIndexStore.deleteIndex('tags');
        ensureIndex(noteIndexStore, 'tagTokens', 'tagTokens', { multiEntry: true });
        ensureIndex(noteIndexStore, 'searchTokens', 'searchTokens', { multiEntry: true });
      };
      request.onsuccess = () => {
        if (settled) {
          request.result.close();
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve(request.result);
      };
      request.onblocked = () =>
        fail(
          new Error(
            'Encrypted browser storage is open in another tab. Close older Loredays tabs and try again.',
          ),
        );
      request.onerror = () =>
        fail(request.error || new Error('Encrypted browser storage could not be opened.'));
    });
    databasePromise = pending.catch((error) => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
};

const getWrappingKey = (): Promise<CryptoKey> => {
  if (!wrappingKeyPromise) {
    wrappingKeyPromise = (async () => {
      const database = await openDatabase();
      const existing = await requestResult(
        database.transaction(KEY_STORE).objectStore(KEY_STORE).get(WRAPPING_KEY_ID),
      );
      if (existing instanceof CryptoKey) return existing;
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
        'encrypt',
        'decrypt',
      ]);
      await requestResult(
        database
          .transaction(KEY_STORE, 'readwrite')
          .objectStore(KEY_STORE)
          .put(key, WRAPPING_KEY_ID),
      );
      return key;
    })();
  }
  return wrappingKeyPromise;
};

const getQueryIndexKey = (): Promise<CryptoKey> => {
  if (!queryIndexKeyPromise) {
    queryIndexKeyPromise = (async () => {
      const database = await openDatabase();
      const existing = await requestResult(
        database.transaction(KEY_STORE).objectStore(KEY_STORE).get(QUERY_INDEX_KEY_ID),
      );
      if (existing instanceof CryptoKey) return existing;
      const key = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, [
        'sign',
      ]);
      await requestResult(
        database
          .transaction(KEY_STORE, 'readwrite')
          .objectStore(KEY_STORE)
          .put(key, QUERY_INDEX_KEY_ID),
      );
      return key;
    })();
  }
  return queryIndexKeyPromise;
};

const bytesToHex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

export const queryIndexToken = async (value: string): Promise<string> => {
  const normalized = value.trim().toLowerCase();
  const signature = await crypto.subtle.sign(
    'HMAC',
    await getQueryIndexKey(),
    new TextEncoder().encode(normalized),
  );
  return bytesToHex(signature);
};

export const queryIndexTokens = async (values: string[]): Promise<string[]> => {
  const uniqueValues = [
    ...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean)),
  ];
  return Promise.all(uniqueValues.map(queryIndexToken));
};

const encryptValue = async (value: string): Promise<EncryptedValue> => {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    await getWrappingKey(),
    new TextEncoder().encode(value),
  );
  return {
    nonce: Array.from(nonce),
    ciphertext: Array.from(new Uint8Array(ciphertext)),
  };
};

const decryptValue = async (record: EncryptedValue): Promise<string> => {
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(record.nonce) },
      await getWrappingKey(),
      new Uint8Array(record.ciphertext),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error('Encrypted browser storage authentication failed.');
  }
};

export const commitEncryptedStoreBatch = async ({
  puts = [],
  deletes = [],
  clears = [],
  plainPuts = [],
  plainDeletes = [],
  plainClears = [],
}: EncryptedStoreBatch): Promise<void> => {
  const encryptedPuts = await Promise.all(
    puts.map(async (put) => ({
      ...put,
      encrypted: await encryptValue(put.value),
    })),
  );
  const storeNames = [
    ...new Set([
      ...encryptedPuts.map((put) => put.storeName),
      ...deletes.map((item) => item.storeName),
      ...clears,
      ...plainPuts.map((put) => put.storeName),
      ...plainDeletes.map((item) => item.storeName),
      ...plainClears,
    ]),
  ];
  if (storeNames.length === 0) return;

  const database = await openDatabase();
  const transaction = database.transaction(storeNames, 'readwrite');
  const done = transactionDone(transaction);
  // A storage primitive may throw synchronously after aborting the transaction.
  // Attach a rejection observer before issuing requests so the later abort event
  // can never surface as an unhandled rejection while the original error wins.
  void done.catch(() => undefined);
  try {
    [...clears, ...plainClears].forEach((storeName) => {
      transaction.objectStore(storeName).clear();
    });
    encryptedPuts.forEach(({ storeName, key, encrypted }) => {
      transaction.objectStore(storeName).put(encrypted, key);
    });
    plainPuts.forEach(({ storeName, key, value }) => {
      const store = transaction.objectStore(storeName);
      if (key === undefined) {
        store.put(value);
      } else {
        store.put(value, key);
      }
    });
    deletes.forEach(({ storeName, key }) => {
      transaction.objectStore(storeName).delete(key);
    });
    plainDeletes.forEach(({ storeName, key }) => {
      transaction.objectStore(storeName).delete(key);
    });
  } catch (error) {
    await done.catch(() => undefined);
    throw error;
  }
  await done;
};

export const getPlainIndexRecords = async <T>(
  storeName: string,
  indexName?: string,
  query?: IDBValidKey | IDBKeyRange,
): Promise<T[]> => {
  const database = await openDatabase();
  const source = indexName
    ? database.transaction(storeName).objectStore(storeName).index(indexName)
    : database.transaction(storeName).objectStore(storeName);
  return requestResult<T[]>(source.getAll(query));
};

export class WebEncryptedKeyValueStore {
  constructor(private readonly storeName: string) {}

  async hasItem(key: string): Promise<boolean> {
    const database = await openDatabase();
    const record = await requestResult<EncryptedValue | undefined>(
      database.transaction(this.storeName).objectStore(this.storeName).get(key),
    );
    return record !== undefined;
  }

  async getItem(key: string): Promise<string | null> {
    const database = await openDatabase();
    const record = await requestResult<EncryptedValue | undefined>(
      database.transaction(this.storeName).objectStore(this.storeName).get(key),
    );
    if (!record) return null;
    return decryptValue(record);
  }

  async getAllItems(): Promise<Record<string, string>> {
    const database = await openDatabase();
    const transaction = database.transaction(this.storeName);
    const store = transaction.objectStore(this.storeName);
    const [keys, records] = await Promise.all([
      requestResult<IDBValidKey[]>(store.getAllKeys()),
      requestResult<EncryptedValue[]>(store.getAll()),
    ]);
    const entries = await Promise.all(
      keys.map(
        async (key, index) => [String(key), await decryptValue(records[index])] as const,
      ),
    );
    return Object.fromEntries(entries);
  }

  async getPage(afterKey: string | undefined, limit: number): Promise<Array<[string, string]>> {
    const database = await openDatabase();
    const transaction = database.transaction(this.storeName);
    const store = transaction.objectStore(this.storeName);
    const range = afterKey === undefined ? undefined : IDBKeyRange.lowerBound(afterKey, true);
    const encrypted = await new Promise<Array<[string, EncryptedValue]>>((resolve, reject) => {
      const records: Array<[string, EncryptedValue]> = [];
      const request = store.openCursor(range);
      request.onerror = () =>
        reject(request.error || new Error('Encrypted browser cursor failed.'));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || records.length >= limit) {
          resolve(records);
          return;
        }
        records.push([String(cursor.key), cursor.value as EncryptedValue]);
        cursor.continue();
      };
    });
    return Promise.all(
      encrypted.map(async ([key, value]) => [key, await decryptValue(value)] as [string, string]),
    );
  }

  async setItem(key: string, value: string): Promise<void> {
    await this.setItems({ [key]: value });
  }

  async setItems(items: Record<string, string>): Promise<void> {
    await commitEncryptedStoreBatch({
      puts: Object.entries(items).map(([key, value]) => ({
        storeName: this.storeName,
        key,
        value,
      })),
    });
  }

  async removeItem(key: string): Promise<void> {
    await commitEncryptedStoreBatch({ deletes: [{ storeName: this.storeName, key }] });
  }

  async clear(): Promise<void> {
    await commitEncryptedStoreBatch({ clears: [this.storeName] });
  }
}

const SNAPSHOT_STAGE_SEPARATOR = '\u0000';

export const snapshotRestoreStageKey = (snapshotId: string, kind: string, key: string): string =>
  [snapshotId, kind, key].join(SNAPSHOT_STAGE_SEPARATOR);

const snapshotRestoreStageRange = (snapshotId: string, kind?: string): IDBKeyRange => {
  const prefix = `${snapshotId}${SNAPSHOT_STAGE_SEPARATOR}${kind ? `${kind}${SNAPSHOT_STAGE_SEPARATOR}` : ''}`;
  return IDBKeyRange.bound(prefix, `${prefix}\uffff`);
};

export const clearEncryptedSnapshotRestoreStage = async (snapshotId: string): Promise<void> => {
  const database = await openDatabase();
  const transaction = database.transaction(WEB_RECORD_STORES.snapshotStage, 'readwrite');
  const done = transactionDone(transaction);
  transaction
    .objectStore(WEB_RECORD_STORES.snapshotStage)
    .delete(snapshotRestoreStageRange(snapshotId));
  await done;
};

export const commitEncryptedSnapshotRestore = async (input: {
  snapshotId: string;
  runtimeKey: string;
  runtimeValue: string;
  appliedKey: string;
  appliedValue: string;
}): Promise<void> => {
  const ready = (kind: 'array' | 'map'): Promise<EncryptedValue> =>
    encryptValue(JSON.stringify({ ready: true, kind, updatedAt: Date.now() }));
  const [runtime, applied, arrayReady, mapReady, projectionReady] = await Promise.all([
    encryptValue(input.runtimeValue),
    encryptValue(input.appliedValue),
    ready('array'),
    ready('map'),
    encryptValue(JSON.stringify({ ready: true, updatedAt: Date.now() })),
  ]);
  const database = await openDatabase();
  const storeNames = [
    REPOSITORY_STORE,
    ...Object.values(WEB_RECORD_STORES),
    ...Object.values(WEB_QUERY_INDEX_STORES),
  ];
  const transaction = database.transaction(storeNames, 'readwrite');
  const done = transactionDone(transaction);
  void done.catch(() => undefined);
  const stage = transaction.objectStore(WEB_RECORD_STORES.snapshotStage);
  const repository = transaction.objectStore(REPOSITORY_STORE);
  const metadata = transaction.objectStore(WEB_RECORD_STORES.metadata);
  const encryptedTargets = [
    WEB_RECORD_STORES.diaries,
    WEB_RECORD_STORES.entries,
    WEB_RECORD_STORES.notes,
    WEB_RECORD_STORES.entryProjections,
    WEB_RECORD_STORES.noteProjections,
    WEB_RECORD_STORES.versions,
    WEB_RECORD_STORES.canonicalRecords,
    WEB_RECORD_STORES.baseVersions,
    WEB_RECORD_STORES.mediaPointers,
    WEB_RECORD_STORES.baseMedia,
  ];
  encryptedTargets.forEach((storeName) => transaction.objectStore(storeName).clear());
  Object.values(WEB_QUERY_INDEX_STORES).forEach((storeName) =>
    transaction.objectStore(storeName).clear(),
  );
  [
    ['deardiary_diaries', 'array', WEB_RECORD_STORES.diaries],
    ['deardiary_entries', 'array', WEB_RECORD_STORES.entries],
    ['deardiary_notes', 'array', WEB_RECORD_STORES.notes],
    ['deardiary_sync_record_versions', 'map', WEB_RECORD_STORES.versions],
    ['deardiary_sync_records', 'map', WEB_RECORD_STORES.canonicalRecords],
    ['deardiary_sync_base_versions', 'map', WEB_RECORD_STORES.baseVersions],
    ['deardiary_sync_media_pointers', 'map', WEB_RECORD_STORES.mediaPointers],
    ['deardiary_sync_base_media', 'map', WEB_RECORD_STORES.baseMedia],
  ].forEach(([key, kind]) => {
    repository.delete(key);
    metadata.put(kind === 'array' ? arrayReady : mapReady, `structured:${key}`);
  });
  metadata.put(projectionReady, 'projection:deardiary_entries:v1');
  metadata.put(projectionReady, 'projection:deardiary_notes:v1');

  const copy = (kind: string, write: (key: string, value: unknown) => void): Promise<void> => {
    const prefix = `${input.snapshotId}${SNAPSHOT_STAGE_SEPARATOR}${kind}${SNAPSHOT_STAGE_SEPARATOR}`;
    return new Promise((resolve, reject) => {
      const request = stage.openCursor(snapshotRestoreStageRange(input.snapshotId, kind));
      request.onerror = () => reject(request.error || new Error('Snapshot restore cursor failed.'));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        try {
          write(String(cursor.key).slice(prefix.length), cursor.value);
          cursor.continue();
        } catch (error) {
          reject(error);
        }
      };
    });
  };
  const copies = [
    copy('record', (key, value) => {
      transaction.objectStore(WEB_RECORD_STORES.canonicalRecords).put(value, key);
    }),
    copy('diaryApp', (key, value) =>
      transaction.objectStore(WEB_RECORD_STORES.diaries).put(value, key),
    ),
    copy('entryApp', (key, value) =>
      transaction.objectStore(WEB_RECORD_STORES.entries).put(value, key),
    ),
    copy('noteApp', (key, value) =>
      transaction.objectStore(WEB_RECORD_STORES.notes).put(value, key),
    ),
    copy('profileApp', (_key, value) => metadata.put(value, 'profile')),
    copy('baseVersion', (key, value) => {
      transaction.objectStore(WEB_RECORD_STORES.baseVersions).put(value, key);
      const separator = key.indexOf(':');
      const type = key.slice(0, separator).toLowerCase();
      if (['diary', 'entry', 'note', 'settings', 'profile'].includes(type)) {
        transaction
          .objectStore(WEB_RECORD_STORES.versions)
          .put(value, `${type}:${key.slice(separator + 1)}`);
      }
    }),
    copy('baseMedia', (key, value) =>
      transaction.objectStore(WEB_RECORD_STORES.baseMedia).put(value, key),
    ),
    copy('mediaDetail', (key, value) =>
      transaction.objectStore(WEB_RECORD_STORES.mediaPointers).put(value, `media:${key}`),
    ),
    copy('entryProjection', (key, value) =>
      transaction.objectStore(WEB_RECORD_STORES.entryProjections).put(value, key),
    ),
    copy('noteProjection', (key, value) =>
      transaction.objectStore(WEB_RECORD_STORES.noteProjections).put(value, key),
    ),
    copy('entryIndex', (_key, value) =>
      transaction.objectStore(WEB_QUERY_INDEX_STORES.entries).put(value),
    ),
    copy('noteIndex', (_key, value) =>
      transaction.objectStore(WEB_QUERY_INDEX_STORES.notes).put(value),
    ),
    copy('settingsApp', (_key, value) => metadata.put(value, 'settings')),
  ];
  metadata.put(runtime, 'sync_account');
  repository.delete(input.runtimeKey);
  repository.put(applied, input.appliedKey);
  try {
    await Promise.all(copies);
  } catch (error) {
    await done.catch(() => undefined);
    throw error;
  }
  await done;
  await clearEncryptedSnapshotRestoreStage(input.snapshotId);
};
