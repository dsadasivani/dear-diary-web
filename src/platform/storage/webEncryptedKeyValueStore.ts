const DATABASE_NAME = 'dear_diary_secure_v1';
const DATABASE_VERSION = 3;
const KEY_STORE = 'keys';
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

interface EncryptedValue {
  nonce: number[];
  ciphertext: number[];
}

export interface EncryptedStoreBatch {
  puts?: Array<{ storeName: string; key: string; value: string }>;
  deletes?: Array<{ storeName: string; key: string }>;
  clears?: string[];
}

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

const openDatabase = (): Promise<IDBDatabase> => {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        [KEY_STORE, SYNC_SECRET_STORE, REPOSITORY_STORE].forEach(store => {
          if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
        });
        Object.values(WEB_RECORD_STORES).forEach(store => {
          if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
        });
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
      const existing = await requestResult(database.transaction(KEY_STORE).objectStore(KEY_STORE).get('root'));
      if (existing instanceof CryptoKey) return existing;
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await requestResult(database.transaction(KEY_STORE, 'readwrite').objectStore(KEY_STORE).put(key, 'root'));
      return key;
    })();
  }
  return wrappingKeyPromise;
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
}: EncryptedStoreBatch): Promise<void> => {
  const encryptedPuts = await Promise.all(puts.map(async put => ({
    ...put,
    encrypted: await encryptValue(put.value),
  })));
  const storeNames = [...new Set([
    ...encryptedPuts.map(put => put.storeName),
    ...deletes.map(item => item.storeName),
    ...clears,
  ])];
  if (storeNames.length === 0) return;

  const database = await openDatabase();
  const transaction = database.transaction(storeNames, 'readwrite');
  clears.forEach(storeName => {
    transaction.objectStore(storeName).clear();
  });
  encryptedPuts.forEach(({ storeName, key, encrypted }) => {
    transaction.objectStore(storeName).put(encrypted, key);
  });
  deletes.forEach(({ storeName, key }) => {
    transaction.objectStore(storeName).delete(key);
  });
  await transactionDone(transaction);
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
