const DATABASE_NAME = 'dear_diary_secure_v1';
const DATABASE_VERSION = 5;
const KEY_STORE = 'keys';
const WRAPPING_KEY_ID = 'root';
const QUERY_INDEX_KEY_ID = 'query_index_hmac';
export const SYNC_SECRET_STORE = 'values';
export const REPOSITORY_STORE = 'repository';
export const WEB_RECORD_STORES = {
  diaries: 'repository_diaries',
  entries: 'repository_entries',
  notes: 'repository_notes',
  metadata: 'repository_metadata',
  outbox: 'repository_outbox',
  versions: 'repository_versions',
  mediaPointers: 'repository_media_pointers',
  partitions: 'repository_partitions',
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

const requestResult = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error('Encrypted browser storage request failed.'));
});

const transactionDone = (transaction: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onabort = () => reject(transaction.error || new Error('Encrypted browser storage transaction aborted.'));
  transaction.onerror = () => reject(transaction.error || new Error('Encrypted browser storage transaction failed.'));
});

let databasePromise: Promise<IDBDatabase> | null = null;
let wrappingKeyPromise: Promise<CryptoKey> | null = null;
let queryIndexKeyPromise: Promise<CryptoKey> | null = null;

const openDatabase = (): Promise<IDBDatabase> => {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = event => {
        const oldVersion = event.oldVersion;
        [KEY_STORE, SYNC_SECRET_STORE, REPOSITORY_STORE].forEach(store => {
          if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
        });
        Object.values(WEB_RECORD_STORES).forEach(store => {
          if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
        });
        const entryIndexStore = request.result.objectStoreNames.contains(WEB_QUERY_INDEX_STORES.entries)
          ? request.transaction!.objectStore(WEB_QUERY_INDEX_STORES.entries)
          : request.result.createObjectStore(WEB_QUERY_INDEX_STORES.entries, { keyPath: 'id' });
        if (oldVersion < 5) entryIndexStore.clear();
        ensureIndex(entryIndexStore, 'diaryId', 'diaryId');
        ensureIndex(entryIndexStore, 'date', 'date');
        ensureIndex(entryIndexStore, 'updatedAt', 'updatedAt');
        ensureIndex(entryIndexStore, 'createdAt', 'createdAt');
        if (entryIndexStore.indexNames.contains('moodName')) entryIndexStore.deleteIndex('moodName');
        if (entryIndexStore.indexNames.contains('tags')) entryIndexStore.deleteIndex('tags');
        ensureIndex(entryIndexStore, 'moodToken', 'moodToken');
        ensureIndex(entryIndexStore, 'hasPhotos', 'hasPhotos');
        ensureIndex(entryIndexStore, 'tagTokens', 'tagTokens', { multiEntry: true });
        ensureIndex(entryIndexStore, 'searchTokens', 'searchTokens', { multiEntry: true });

        const noteIndexStore = request.result.objectStoreNames.contains(WEB_QUERY_INDEX_STORES.notes)
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
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Encrypted browser storage could not be opened.'));
    });
  }
  return databasePromise;
};

const getWrappingKey = (): Promise<CryptoKey> => {
  if (!wrappingKeyPromise) {
    wrappingKeyPromise = (async () => {
      const database = await openDatabase();
      const existing = await requestResult(database.transaction(KEY_STORE).objectStore(KEY_STORE).get(WRAPPING_KEY_ID));
      if (existing instanceof CryptoKey) return existing;
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await requestResult(database.transaction(KEY_STORE, 'readwrite').objectStore(KEY_STORE).put(key, WRAPPING_KEY_ID));
      return key;
    })();
  }
  return wrappingKeyPromise;
};

const getQueryIndexKey = (): Promise<CryptoKey> => {
  if (!queryIndexKeyPromise) {
    queryIndexKeyPromise = (async () => {
      const database = await openDatabase();
      const existing = await requestResult(database.transaction(KEY_STORE).objectStore(KEY_STORE).get(QUERY_INDEX_KEY_ID));
      if (existing instanceof CryptoKey) return existing;
      const key = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      await requestResult(database.transaction(KEY_STORE, 'readwrite').objectStore(KEY_STORE).put(key, QUERY_INDEX_KEY_ID));
      return key;
    })();
  }
  return queryIndexKeyPromise;
};

const bytesToHex = (bytes: ArrayBuffer): string => (
  Array.from(new Uint8Array(bytes))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
);

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
  const uniqueValues = [...new Set(values.map(value => value.trim().toLowerCase()).filter(Boolean))];
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
  const encryptedPuts = await Promise.all(puts.map(async put => ({
    ...put,
    encrypted: await encryptValue(put.value),
  })));
  const storeNames = [...new Set([
    ...encryptedPuts.map(put => put.storeName),
    ...deletes.map(item => item.storeName),
    ...clears,
    ...plainPuts.map(put => put.storeName),
    ...plainDeletes.map(item => item.storeName),
    ...plainClears,
  ])];
  if (storeNames.length === 0) return;

  const database = await openDatabase();
  const transaction = database.transaction(storeNames, 'readwrite');
  [...clears, ...plainClears].forEach(storeName => {
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
  await transactionDone(transaction);
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
    const keys = await requestResult<IDBValidKey[]>(
      database.transaction(this.storeName).objectStore(this.storeName).getAllKeys(),
    );
    const entries = await Promise.all(keys.map(async key => [
      String(key),
      await this.getItem(String(key)),
    ] as const));
    return Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => entry[1] !== null));
  }

  async setItem(key: string, value: string): Promise<void> {
    await this.setItems({ [key]: value });
  }

  async setItems(items: Record<string, string>): Promise<void> {
    await commitEncryptedStoreBatch({
      puts: Object.entries(items).map(([key, value]) => ({ storeName: this.storeName, key, value })),
    });
  }

  async removeItem(key: string): Promise<void> {
    await commitEncryptedStoreBatch({ deletes: [{ storeName: this.storeName, key }] });
  }

  async clear(): Promise<void> {
    await commitEncryptedStoreBatch({ clears: [this.storeName] });
  }
}
